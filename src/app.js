import { createDefaultScenario, createId, describeScope, money, replayScenario, scopeLabels, validateScenario } from "./engine.js";

const STORAGE_KEY = "copilot-budget-lab-scenario-v1";
let scenario = loadScenario();
let latestEventId = null;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

function loadScenario() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return validateScenario(saved) ? createDefaultScenario() : saved;
  } catch { return createDefaultScenario(); }
}

function saveAndRender(message) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(scenario));
  render();
  if (message) showToast(message);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function setOptions(selector, items, selected, emptyLabel) {
  const element = $(selector);
  if (!element) return;
  const empty = emptyLabel ? `<option value="">${escapeHtml(emptyLabel)}</option>` : "";
  element.innerHTML = empty + items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
}

function statusClass(percent) {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warning";
  return "";
}

function render() {
  const replay = replayScenario(scenario);
  const currency = scenario.enterprise.currency;
  $("#simulation-date").value = scenario.simulationDate;
  $("#usage-date").value = $("#usage-date").value || scenario.simulationDate;
  $("#period-label").textContent = replay.period;
  renderSummary(replay, currency);
  renderBudgets(replay, currency);
  renderHierarchy();
  renderActivity(replay, currency);
  renderSelectors();
  renderApplicableControls(replay, currency);
  renderConfiguration();
  renderTimeline(replay, currency);
  if (latestEventId) renderResult(replay, currency);
}

function renderSummary(replay, currency) {
  const accepted = replay.results.filter((item) => item.status === "accepted");
  const current = accepted.filter((item) => item.date.startsWith(replay.period));
  const spent = current.reduce((sum, item) => sum + item.cost, 0);
  const units = current.reduce((sum, item) => sum + item.quantity, 0);
  const blocked = replay.results.filter((item) => item.status === "blocked" && item.date.startsWith(replay.period)).length;
  $("#summary-cards").innerHTML = [
    ["Period usage", money(spent, currency), `${current.length} accepted events`],
    ["Units consumed", units.toLocaleString(), "Across all configured SKUs"],
    ["Alerts triggered", replay.alerts.filter((item) => item.date.startsWith(replay.period)).length, "Threshold notifications"],
    ["Blocked events", blocked, blocked ? "Hard controls protected spend" : "No usage blocked"],
  ].map(([label, value, note]) => `<article class="summary-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
}

function renderBudgets(replay, currency) {
  $("#budget-grid").innerHTML = replay.budgetStates.length ? replay.budgetStates.map((budget) => `
    <article class="budget-card">
      <div class="budget-top"><div><h3>${escapeHtml(budget.name)}</h3><p>${scopeLabels[budget.scopeType]} · ${escapeHtml(describeScope(scenario, budget))} · ${budget.enforcement === "hard" ? "Hard limit" : "Alert only"}</p></div><span class="percent">${Math.round(budget.percent)}%</span></div>
      <div class="progress ${statusClass(budget.percent)}"><div style="width:${Math.min(100, budget.percent)}%"></div></div>
      <div class="budget-foot"><span>${money(budget.spent, currency)} used</span><span>${money(budget.remaining, currency)} remaining of ${money(budget.amount, currency)}</span></div>
    </article>`).join("") : `<div class="empty">No budgets configured.</div>`;
}

function renderHierarchy() {
  $("#hierarchy").innerHTML = `<strong>◆ ${escapeHtml(scenario.enterprise.name)}</strong>` + scenario.organizations.map((org) => {
    const repos = scenario.repositories.filter((repo) => repo.organizationId === org.id);
    const users = scenario.users.filter((user) => user.organizationIds.includes(org.id));
    return `<div class="tree-org"><strong>◉ ${escapeHtml(org.name)}</strong><small>${users.length} user${users.length === 1 ? "" : "s"}</small>${repos.map((repo) => `<div class="tree-repo">⌘ ${escapeHtml(repo.name)}</div>`).join("") || `<div class="tree-repo">No repositories</div>`}</div>`;
  }).join("");
}

function renderActivity(replay, currency) {
  const items = replay.results.slice(-5).reverse();
  $("#recent-activity").innerHTML = items.length ? items.map((item) => `<div class="activity"><span class="status-dot ${item.status}"></span><div><p><strong>${escapeHtml(item.userName)}</strong> · ${item.quantity.toLocaleString()} ${escapeHtml(item.productName)}</p><small>${item.date} · ${money(item.cost, currency)} · ${item.status}</small></div></div>`).join("") : `<div class="empty">No usage yet. Run your first simulation.</div>`;
}

function renderSelectors() {
  setOptions("#usage-user", scenario.users, $("#usage-user").value);
  setOptions("#usage-repository", scenario.repositories, $("#usage-repository").value, "No repository");
  setOptions("#usage-product", scenario.products, $("#usage-product").value);
  setOptions("#repository-org", scenario.organizations, $("#repository-org").value);
  setOptions("#user-org", scenario.organizations, $("#user-org").value);
  setOptions("#user-cost-center", scenario.costCenters, $("#user-cost-center").value);
  renderBudgetScopeOptions();
}

function renderApplicableControls(replay, currency) {
  const userId = $("#usage-user").value;
  const repoId = $("#usage-repository").value;
  const probe = { id: "probe", date: $("#usage-date").value || scenario.simulationDate, userId, repositoryId: repoId, productId: $("#usage-product").value, quantity: 0 };
  const copy = { ...scenario, events: [...scenario.events, probe] };
  const probeResult = replayScenario(copy).results.find((item) => item.eventId === "probe");
  const ids = new Set(probeResult?.affectedBudgets.map((item) => item.budgetId) || []);
  const budgets = replay.budgetStates.filter((item) => ids.has(item.id));
  $("#applicable-controls").innerHTML = budgets.length ? budgets.map((item) => `<div class="impact-row"><div><strong>${escapeHtml(item.name)}</strong><small>${scopeLabels[item.scopeType]} · effective ${item.effectiveFrom}</small></div><strong>${money(item.spent, currency)} / ${money(item.amount, currency)}</strong></div>`).join("") : `<div class="empty">No budget applies on this date.</div>`;
}

function renderConfiguration() {
  $("#enterprise-name").value = scenario.enterprise.name;
  $("#enterprise-currency").value = scenario.enterprise.currency;
  $("#product-list").innerHTML = scenario.products.map((item) => entityRow(item.name, `${money(item.unitPrice, scenario.enterprise.currency)} / ${item.unit}`, "product", item.id)).join("");
  $("#organization-list").innerHTML = scenario.organizations.map((item) => entityRow(item.name, `${scenario.repositories.filter((repo) => repo.organizationId === item.id).length} repositories`, "organization", item.id)).join("");
  $("#cost-center-list").innerHTML = scenario.costCenters.map((item) => entityRow(item.name, `${scenario.users.filter((user) => user.costCenterId === item.id).length} users`, "costCenter", item.id)).join("");
  $("#user-list").innerHTML = scenario.users.map((item) => entityRow(item.name, scenario.costCenters.find((cc) => cc.id === item.costCenterId)?.name || "No cost center", "user", item.id)).join("");
  $("#budget-table").innerHTML = `<div class="budget-table-row header"><span>Name</span><span>Scope</span><span>Amount</span><span>Effective</span><span>Control</span><span></span></div>` + scenario.budgets.map((item) => `<div class="budget-table-row"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(describeScope(scenario, item))}</span><span>${money(item.amount, scenario.enterprise.currency)}</span><span>${item.effectiveFrom}</span><span class="tag ${item.enforcement}">${item.enforcement === "hard" ? "Hard limit" : "Alert only"}</span><button class="delete" data-delete="budget" data-id="${item.id}" title="Delete">×</button></div>`).join("");
}

function entityRow(name, detail, type, id) {
  return `<div class="entity-row"><div><strong>${escapeHtml(name)}</strong><br><small>${escapeHtml(detail)}</small></div><button class="delete" data-delete="${type}" data-id="${id}" title="Delete">×</button></div>`;
}

function renderBudgetScopeOptions() {
  const type = $("#budget-scope-type").value;
  const collections = { enterprise: [scenario.enterprise], organization: scenario.organizations, repository: scenario.repositories, costCenter: scenario.costCenters, user: scenario.users };
  setOptions("#budget-scope", collections[type] || [], $("#budget-scope").value);
}

function renderTimeline(replay, currency) {
  $("#event-count").textContent = `${scenario.events.length} event${scenario.events.length === 1 ? "" : "s"}`;
  const resultsById = new Map(replay.results.map((item) => [item.eventId, item]));
  $("#timeline-list").innerHTML = scenario.events.length ? [...scenario.events].reverse().map((event) => {
    const item = resultsById.get(event.id);
    return `<div class="timeline-item"><span class="status-dot ${item?.status || ""}"></span><div><p><strong>${escapeHtml(item?.userName || "Unknown")}</strong> consumed ${Number(event.quantity).toLocaleString()} units</p><small>${event.date} · ${escapeHtml(item?.productName || "Unknown product")} · ${money(item?.cost || 0, currency)} · ${item?.status || "scheduled"}</small>${item?.status === "blocked" ? `<p><small>${escapeHtml(item.reason)}</small></p>` : ""}</div></div>`;
  }).join("") : `<div class="empty">The timeline is empty.</div>`;
  $("#alert-list").innerHTML = replay.alerts.length ? [...replay.alerts].reverse().map((alert) => `<div class="alert-item"><span class="alert-badge">!</span><div><p><strong>${escapeHtml(alert.message)}</strong></p><small>${alert.date} · Dashboard notification · Budget email preview</small></div></div>`).join("") : `<div class="empty">No thresholds have been crossed.</div>`;
}

function renderResult(replay, currency) {
  const result = replay.results.find((item) => item.eventId === latestEventId);
  if (!result) return;
  const impacts = result.affectedBudgets.map((impact) => {
    const budget = scenario.budgets.find((item) => item.id === impact.budgetId);
    return `<div class="impact-row"><div><strong>${escapeHtml(budget?.name)}</strong><small>${money(impact.before, currency)} → ${money(impact.after, currency)}</small></div><strong>${Math.round(impact.percent)}%</strong></div>`;
  }).join("");
  $("#last-result").className = "result-placeholder result-box";
  $("#last-result").innerHTML = `<div class="result-header"><span class="result-icon ${result.status}">${result.status === "accepted" ? "✓" : "×"}</span><div><h3>${result.status === "accepted" ? "Usage accepted" : "Usage blocked"}</h3><p>${escapeHtml(result.reason)}</p></div></div><div class="result-cost">${money(result.cost, currency)}</div><p class="muted">${result.quantity.toLocaleString()} units · ${escapeHtml(result.productName)} · ${result.date}</p>${impacts || `<div class="impact-row"><small>No counters changed.</small></div>`}`;
}

function navigate(view) {
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === view));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $("#page-title").textContent = ({ dashboard: "Dashboard", simulate: "Simulate usage", configuration: "Configuration", timeline: "Timeline & alerts" })[view];
}

function addDays(value, days) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonth(value) {
  const date = new Date(`${value}T12:00:00`);
  date.setMonth(date.getMonth() + 1, 1);
  return date.toISOString().slice(0, 10);
}

$("#navigation").addEventListener("click", (event) => { const button = event.target.closest("[data-view]"); if (button) navigate(button.dataset.view); });
document.addEventListener("click", (event) => {
  const go = event.target.closest("[data-go]"); if (go) navigate(go.dataset.go);
  const quick = event.target.closest("[data-quantity]"); if (quick) $("#usage-quantity").value = quick.dataset.quantity;
  const deletion = event.target.closest("[data-delete]"); if (deletion) deleteEntity(deletion.dataset.delete, deletion.dataset.id);
});

$("#simulation-date").addEventListener("change", (event) => { scenario.simulationDate = event.target.value; $("#usage-date").value = event.target.value; saveAndRender("Simulation date changed"); });
$("#previous-day").addEventListener("click", () => { scenario.simulationDate = addDays(scenario.simulationDate, -1); $("#usage-date").value = scenario.simulationDate; saveAndRender(); });
$("#next-day").addEventListener("click", () => { scenario.simulationDate = addDays(scenario.simulationDate, 1); $("#usage-date").value = scenario.simulationDate; saveAndRender(); });
$("#next-month").addEventListener("click", () => { scenario.simulationDate = addMonth(scenario.simulationDate); $("#usage-date").value = scenario.simulationDate; saveAndRender("Advanced to next billing period"); });

$("#usage-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const usage = { id: createId("event"), userId: $("#usage-user").value, repositoryId: $("#usage-repository").value || null, productId: $("#usage-product").value, quantity: Number($("#usage-quantity").value), date: $("#usage-date").value };
  scenario.events.push(usage); latestEventId = usage.id;
  if (usage.date > scenario.simulationDate) scenario.simulationDate = usage.date;
  saveAndRender("Usage event simulated");
});
["#usage-user", "#usage-repository", "#usage-product", "#usage-date"].forEach((selector) => $(selector).addEventListener("change", () => renderApplicableControls(replayScenario(scenario), scenario.enterprise.currency)));

$("#enterprise-form").addEventListener("submit", (event) => { event.preventDefault(); scenario.enterprise.name = $("#enterprise-name").value.trim(); scenario.enterprise.currency = $("#enterprise-currency").value; saveAndRender("Enterprise saved"); });
$("#product-form").addEventListener("submit", (event) => { event.preventDefault(); scenario.products.push({ id: createId("product"), name: $("#product-name").value.trim(), unit: "unit", unitPrice: Number($("#product-price").value) }); event.target.reset(); saveAndRender("Product added"); });
$("#organization-form").addEventListener("submit", (event) => { event.preventDefault(); scenario.organizations.push({ id: createId("org"), name: $("#organization-name").value.trim() }); event.target.reset(); saveAndRender("Organization added"); });
$("#repository-form").addEventListener("submit", (event) => { event.preventDefault(); scenario.repositories.push({ id: createId("repo"), name: $("#repository-name").value.trim(), organizationId: $("#repository-org").value }); event.target.reset(); saveAndRender("Repository added"); });
$("#cost-center-form").addEventListener("submit", (event) => { event.preventDefault(); scenario.costCenters.push({ id: createId("cc"), name: $("#cost-center-name").value.trim() }); event.target.reset(); saveAndRender("Cost center added"); });
$("#user-form").addEventListener("submit", (event) => { event.preventDefault(); scenario.users.push({ id: createId("user"), name: $("#user-name").value.trim(), organizationIds: [$("#user-org").value], costCenterId: $("#user-cost-center").value }); event.target.reset(); saveAndRender("User added"); });
$("#budget-scope-type").addEventListener("change", renderBudgetScopeOptions);
$("#budget-form").addEventListener("submit", (event) => { event.preventDefault(); const thresholds = $("#budget-thresholds").value.split(",").map(Number).filter((value) => value > 0).sort((a, b) => a - b); scenario.budgets.push({ id: createId("budget"), name: $("#budget-name").value.trim(), scopeType: $("#budget-scope-type").value, scopeId: $("#budget-scope").value, amount: Number($("#budget-amount").value), effectiveFrom: $("#budget-effective").value, enforcement: $("#budget-enforcement").value, thresholds }); event.target.reset(); $("#budget-effective").value = scenario.simulationDate; saveAndRender("Budget added"); });

function deleteEntity(type, id) {
  const key = ({ product: "products", organization: "organizations", costCenter: "costCenters", user: "users", budget: "budgets" })[type];
  if (!key) return;
  const referenced = type === "organization" && (scenario.repositories.some((item) => item.organizationId === id) || scenario.users.some((item) => item.organizationIds.includes(id))) || type === "costCenter" && scenario.users.some((item) => item.costCenterId === id) || type === "user" && scenario.events.some((item) => item.userId === id) || type === "product" && scenario.events.some((item) => item.productId === id);
  if (referenced) return showToast("Cannot delete an item that is still referenced");
  scenario[key] = scenario[key].filter((item) => item.id !== id);
  if (type !== "budget") scenario.budgets = scenario.budgets.filter((item) => !(item.scopeType === type && item.scopeId === id));
  saveAndRender("Item deleted");
}

$("#export-config").addEventListener("click", () => { const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `copilot-budget-scenario-${scenario.simulationDate}.json`; link.click(); URL.revokeObjectURL(link.href); showToast("Scenario exported"); });
$("#import-config").addEventListener("change", async (event) => { try { const imported = JSON.parse(await event.target.files[0].text()); const error = validateScenario(imported); if (error) throw new Error(error); scenario = imported; latestEventId = null; saveAndRender("Scenario imported"); } catch (error) { showToast(`Import failed: ${error.message}`); } finally { event.target.value = ""; } });
$("#reset-scenario").addEventListener("click", () => { scenario = createDefaultScenario(); latestEventId = null; $("#last-result").className = "result-placeholder"; $("#last-result").innerHTML = `<span>◎</span><h3>Ready to simulate</h3><p>Submit usage to see attribution, cost, alerts, and enforcement.</p>`; saveAndRender("Demo scenario reset"); });
$("#clear-events").addEventListener("click", () => { scenario.events = []; latestEventId = null; saveAndRender("Usage history cleared"); });

$("#budget-effective").value = scenario.simulationDate;
render();
