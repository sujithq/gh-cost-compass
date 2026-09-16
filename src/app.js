import { costCenterForUser, createDefaultScenario, createId, describeScope, isSeatActiveForDate, money, replayScenario, scopeLabels, seatChargeForPeriod, seatLifecycleEvents, validateScenario } from "./engine.js";

const STORAGE_KEY = "copilot-budget-lab-scenario-v2";
let scenario = loadScenario();
let latestEventId = null;
let budgetHistoryTrigger = null;
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
  renderImpactPreviews();
  renderTimeline(replay, currency);
  if (latestEventId) renderResult(replay, currency);
}

function renderSummary(replay, currency) {
  const current = replay.results.filter((item) => item.status === "accepted" && item.date.startsWith(replay.period));
  const blocked = replay.results.filter((item) => item.status === "blocked" && item.date.startsWith(replay.period)).length;
  const seatCharge = scenario.users.reduce((sum, user) => sum + seatChargeForPeriod(user, scenario.simulationDate), 0);
  const policyLabel = scenario.enterprise.seatCreditPolicy === "full" ? "Full seat credits (hypothetical)" : "Prorated seat credits";
  $("#summary-cards").innerHTML = [
    ["Shared AI-credit pool", `${replay.pool.consumed.toLocaleString()} / ${replay.pool.total.toLocaleString()}`, `${Math.round(replay.pool.percent)}% of included credits consumed`],
    ["Seat charge this cycle", money(seatCharge, currency), `${scenario.users.filter((user) => user.licenseStartsAt || user.licenseEndsAt).length} seats with dated lifecycle`],
    ["Paid AI overage", money(replay.pool.meteredCost, "USD"), scenario.enterprise.paidAiUsage ? "Paid usage policy enabled" : "Paid usage policy disabled"],
    ["Seat credit policy", policyLabel, "Add behavior for mid-cycle seats"],
    ["Alerts triggered", replay.alerts.filter((item) => item.date.startsWith(replay.period)).length, "Standard thresholds: 75%, 90%, 100%"],
    ["Blocked events", blocked, blocked ? "One or more controls stopped usage" : "No usage blocked"],
  ].map(([label, value, note]) => `<article class="summary-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
}

function renderBudgets(replay, currency) {
  const poolCard = `<article class="budget-card budget-history-trigger" data-history-id="pool" tabindex="0" role="button" aria-label="View shared included AI-credit pool history"><div class="budget-top"><div><h3>Shared included AI-credit pool</h3><p>All licensed users · resets monthly · not a dollar budget</p></div><span class="percent">${Math.round(replay.pool.percent)}%</span></div><div class="progress ${statusClass(replay.pool.percent)}"><div style="width:${Math.min(100, replay.pool.percent)}%"></div></div><div class="budget-foot"><span>${replay.pool.consumed.toLocaleString()} credits consumed</span><span>${replay.pool.remaining.toLocaleString()} of ${replay.pool.total.toLocaleString()} remaining</span></div></article>`;
  const cards = replay.budgetStates.map((budget) => {
    const isUlb = budget.budgetKind === "user";
    const scope = isUlb ? `Per user · ${budget.userBudgetType} ULB` : `${scopeLabels[budget.scopeType]} · ${describeScope(scenario, budget)}`;
    const basis = isUlb ? "total AI-credit value (pool + paid)" : "paid overage only";
    return `<article class="budget-card budget-history-trigger" data-history-id="${escapeHtml(budget.stateId)}" tabindex="0" role="button" aria-label="View ${escapeHtml(budget.displayName)} history"><div class="budget-top"><div><h3>${escapeHtml(budget.displayName)}</h3><p>${escapeHtml(scope)} · ${basis} · ${budget.enforcement === "hard" ? "Hard stop" : "Alert only"}</p></div><span class="percent">${Math.round(budget.percent)}%</span></div><div class="progress ${statusClass(budget.percent)}"><div style="width:${Math.min(100, budget.percent)}%"></div></div><div class="budget-foot"><span>${money(budget.spent, "USD")} used</span><span>${money(budget.remaining, "USD")} remaining of ${money(budget.amount, "USD")}</span></div></article>`;
  }).join("");
  $("#budget-grid").innerHTML = poolCard + cards;
}

function historyEntries(results, detailForResult, emptyMessage) {
  return results.length ? results.map((result) => {
    const detail = detailForResult(result);
    return `<div class="history-entry"><div class="history-head"><strong>${escapeHtml(result.userName)}</strong><span>${result.date}</span></div><p>${escapeHtml(result.productName)} · ${Number(result.quantity).toLocaleString()} units · ${money(result.cost, "USD")}</p><small>${escapeHtml(detail)} · ${escapeHtml(result.reason)}</small></div>`;
  }).join("") : `<div class="empty">${escapeHtml(emptyMessage)}</div>`;
}

function openBudgetHistory(historyId, trigger) {
  const replay = replayScenario(scenario);
  const currentPeriodResults = replay.results.filter((item) => item.date.startsWith(replay.period));
  let title;
  let summary;
  let entries;
  let alertHtml = "<li>The shared pool does not emit budget alerts.</li>";

  if (historyId === "pool") {
    const contributors = currentPeriodResults.filter((item) => item.status === "accepted" && item.includedQuantity > 0);
    title = "Shared included AI-credit pool history";
    summary = [
      ["Consumed", `${replay.pool.consumed.toLocaleString()} credits`],
      ["Capacity", `${replay.pool.total.toLocaleString()} credits`],
      ["Remaining", `${replay.pool.remaining.toLocaleString()} credits`],
      ["Percent", `${Math.round(replay.pool.percent)}%`],
    ];
    entries = historyEntries(contributors, (result) => `Drew ${result.includedQuantity.toLocaleString()} credits from the shared pool`, "No usage events have consumed this period's shared pool.");
  } else {
    const budgetState = replay.budgetStates.find((item) => item.stateId === historyId);
    if (!budgetState) return;
    const contributors = currentPeriodResults.filter((item) => item.affectedBudgets.some((impact) => impact.stateKey === historyId));
    const alerts = replay.alerts.filter((item) => item.budgetId === budgetState.id && item.date.startsWith(replay.period) && contributors.some((result) => result.eventId === item.eventId));
    title = `${budgetState.displayName} history`;
    summary = [
      ["Current usage", money(budgetState.spent, "USD")],
      ["Limit", money(budgetState.amount, "USD")],
      ["Remaining", money(budgetState.remaining, "USD")],
      ["Percent", `${Math.round(budgetState.percent)}%`],
    ];
    entries = historyEntries(contributors, (result) => {
      const impact = result.affectedBudgets.find((item) => item.stateKey === historyId);
      return `Added ${money((impact?.after || 0) - (impact?.before || 0), "USD")} to this budget`;
    }, "No usage events are currently contributing to this budget.");
    alertHtml = alerts.length ? alerts.map((alert) => `<li>${alert.date} · ${alert.threshold}% threshold reached</li>`).join("") : "<li>No budget alerts triggered for this control.</li>";
  }

  $("#budget-history-title").textContent = title;
  $("#budget-history-content").innerHTML = `
    <div class="budget-history-summary">${summary.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>
    <div class="history-panel"><h4>What drove the current state</h4>${entries}</div>
    <div class="history-panel"><h4>Triggered alerts</h4><ul class="history-alert-list">${alertHtml}</ul></div>`;
  budgetHistoryTrigger = trigger || document.activeElement;
  $("#budget-history-modal").classList.remove("hidden");
  $("#budget-history-modal").setAttribute("aria-hidden", "false");
  $("#budget-history-close").focus();
}

function closeBudgetHistory() {
  const modal = $("#budget-history-modal");
  if (modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  budgetHistoryTrigger?.focus();
  budgetHistoryTrigger = null;
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
  setOptions("#cost-center-org", scenario.organizations, $("#cost-center-org").value, "No organization assignment");
  setOptions("#user-cost-center", scenario.costCenters, $("#user-cost-center").value, "Use organization assignment");
  setOptions("#budget-product", scenario.products, $("#budget-product").value || "ai-credits");
  const usageProduct = scenario.products.find((item) => item.id === $("#usage-product").value);
  $("#usage-unit-label").textContent = usageProduct?.billingMode === "aiCredits" ? "AI credits" : `${usageProduct?.unit || "Units"}s`;
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
  $("#applicable-controls").innerHTML = budgets.length ? budgets.map((item) => `<div class="impact-row"><div><strong>${escapeHtml(item.displayName)}</strong><small>${item.budgetKind === "user" ? "Total credits · always hard stop" : "Paid overage only"} · effective ${item.effectiveFrom}</small></div><strong>${money(item.spent, "USD")} / ${money(item.amount, "USD")}</strong></div>`).join("") : `<div class="empty">No budget applies on this date.</div>`;
}

function renderConfiguration() {
  $("#enterprise-name").value = scenario.enterprise.name;
  $("#enterprise-currency").value = scenario.enterprise.currency;
  $("#paid-ai-usage").checked = scenario.enterprise.paidAiUsage;
  $("#seat-credit-policy").value = scenario.enterprise.seatCreditPolicy || "prorated";
  $("#product-list").innerHTML = scenario.products.map((item) => entityRow(item.name, item.billingMode === "aiCredits" ? "Fixed: 1 credit = $0.01" : `${money(item.unitPrice, scenario.enterprise.currency)} / ${item.unit}`, "product", item.id)).join("");
  $("#organization-list").innerHTML = scenario.organizations.map((item) => entityRow(item.name, `${scenario.repositories.filter((repo) => repo.organizationId === item.id).length} repositories`, "organization", item.id)).join("");
  $("#cost-center-list").innerHTML = scenario.costCenters.map((item) => {
    const assignedOrganizations = scenario.organizations.filter((org) => (item.organizationIds || []).includes(org.id)).map((org) => org.name);
    const members = scenario.users.filter((user) => costCenterForUser(scenario, user)?.id === item.id).length;
    const assignment = assignedOrganizations.length ? ` · organizations: ${assignedOrganizations.join(", ")}` : "";
    return `<div class="entity-row"><div><strong>${escapeHtml(item.name)}</strong><br><small>${members} users${escapeHtml(assignment)} · ${item.excludeFromEnterpriseBudget ? "excluded from enterprise AI budget" : "counts against enterprise AI budget"}</small></div><div><button class="text-button" data-toggle-costcenter="${item.id}">${item.excludeFromEnterpriseBudget ? "Include" : "Exclude"}</button><button class="delete" data-delete="costCenter" data-id="${item.id}" title="Delete">×</button></div></div>`;
  }).join("");
  $("#user-list").innerHTML = scenario.users.map((item) => {
    const seatActive = isSeatActiveForDate(item, scenario.simulationDate);
    const seatPending = item.licenseStartsAt && item.licenseStartsAt > scenario.simulationDate;
    const endLabel = item.licenseEndMode === "unassign" ? "unassigned" : "revoked";
    const seatText = seatPending ? `seat starts ${item.licenseStartsAt}` : seatActive ? `seat active${item.licenseEndsAt ? ` · ${item.licenseEndMode === "unassign" ? "unassigns" : "revokes"} ${item.licenseEndsAt}` : ""}` : `seat ${endLabel} ${item.licenseEndsAt}`;
    const charge = seatChargeForPeriod(item, scenario.simulationDate);
    const costCenter = costCenterForUser(scenario, item);
    const assignment = item.costCenterId ? costCenter?.name : costCenter ? `${costCenter.name} (via organization)` : "No cost center";
    return entityRow(item.name, `${item.licensePlan === "enterprise" ? "3,900" : "1,900"} included credits · ${assignment} · ${seatText} · ${money(charge, scenario.enterprise.currency)} this cycle`, "user", item.id);
  }).join("");
  $("#budget-table").innerHTML = `<div class="budget-table-row header"><span>Name</span><span>Control / scope</span><span>Amount</span><span>Effective</span><span>Enforcement</span><span></span></div>` + scenario.budgets.map((item) => `<div class="budget-table-row"><strong>${escapeHtml(item.name)}</strong><span>${item.budgetKind === "user" ? `${item.userBudgetType} ULB` : "Metered"} · ${escapeHtml(describeScope(scenario, item))}</span><span>${money(item.amount, "USD")}</span><span>${item.effectiveFrom}${item.expiresAt ? ` → ${item.expiresAt}` : ""}</span><span class="tag ${item.enforcement}">${item.enforcement === "hard" ? "Hard stop" : "Alert only"}</span><button class="delete" data-delete="budget" data-id="${item.id}" title="Delete">×</button></div>`).join("");
}

function setImpact(selector, tone, title, text) {
  const element = $(selector);
  if (!element) return;
  element.className = `impact-preview${tone ? ` ${tone}` : ""}`;
  element.innerHTML = `<strong>${escapeHtml(title)}</strong>${escapeHtml(text)}`;
}

function renderImpactPreviews() {
  const paidUsage = $("#paid-ai-usage").checked;
  const fullCredits = $("#seat-credit-policy").value === "full";
  if (!paidUsage) {
    setImpact("#enterprise-impact", "danger", "Usage-blocking impact", `AI-credit-consuming features stop when the shared pool is exhausted.${fullCredits ? " The full-credit option is also a hypothetical simulator policy." : ""}`);
  } else if (fullCredits) {
    setImpact("#enterprise-impact", "warning", "Higher simulated pool", "Paid overage remains available, and mid-cycle seats receive a hypothetical full monthly credit contribution.");
  } else {
    setImpact("#enterprise-impact", "", "Documented-aligned behavior", "Paid overage can continue after pool exhaustion, subject to applicable budgets; mid-cycle seat credits are prorated.");
  }

  const organizationId = $("#cost-center-org").value;
  const costCenterSubject = organizationId ? `Users attributed through ${$("#cost-center-org").selectedOptions[0]?.textContent}` : "Directly assigned users";
  if ($("#cost-center-excluded").checked) {
    setImpact("#cost-center-impact", "warning", "Independent spending authority", `${costCenterSubject} will not consume enterprise metered-budget headroom and must be governed by this cost center's own budget.`);
  } else {
    setImpact("#cost-center-impact", "", "Enterprise roll-up retained", `${costCenterSubject} will also count toward the enterprise metered budget.`);
  }

  const seatEnd = $("#user-license-end").value;
  const revoke = $("#user-license-end-mode").value === "revoke";
  if (!seatEnd) {
    setImpact("#user-impact", "", "No scheduled seat removal", "The seat continues contributing credits and license cost until an end date is configured.");
  } else if (revoke) {
    setImpact("#user-impact", "danger", "Immediate access loss", `Copilot access stops on ${seatEnd}; there is no current-cycle refund, and the pool contribution remains until reset.`);
  } else {
    setImpact("#user-impact", "warning", "End-of-cycle access", `The seat is unassigned on ${seatEnd}, but access and billing continue through the current cycle with no refund.`);
  }

  const budgetKind = $("#budget-kind").value;
  const amountInput = $("#budget-amount").value.trim();
  const amount = Number(amountInput || 0);
  const enforcement = budgetKind === "user" ? "hard" : $("#budget-enforcement").value;
  const product = scenario.products.find((item) => item.id === $("#budget-product").value);
  const zeroAiBudget = amount === 0 && product?.billingMode === "aiCredits";
  const effectiveDate = $("#budget-effective").value || scenario.simulationDate;
  if (!amountInput) {
    setImpact("#budget-impact", "", "Impact preview", "Enter a monthly amount to see whether this budget only alerts or can block usage.");
  } else if (amount === 0 && (budgetKind === "user" || enforcement === "hard" || zeroAiBudget)) {
    setImpact("#budget-impact", "danger", "Immediate blocking risk", `A $0 ${budgetKind === "user" ? "user-level" : product?.billingMode === "aiCredits" ? "AI-credit" : "hard"} budget blocks applicable usage from ${effectiveDate}.`);
  } else if (amount === 0) {
    setImpact("#budget-impact", "", "Zero-dollar alert threshold", `The budget alerts immediately from ${effectiveDate}, but alert-only enforcement does not stop additional spend.`);
  } else if (budgetKind === "user") {
    setImpact("#budget-impact", "danger", "Per-user hard stop", `The most specific applicable ULB blocks that user after $${amount.toFixed(2)} of total AI-credit consumption. Usage before ${effectiveDate} is not counted.`);
  } else if (enforcement === "hard") {
    setImpact("#budget-impact", "warning", "Paid usage can be blocked", `Applicable metered usage stops after $${amount.toFixed(2)} of paid overage from ${effectiveDate}. Overlapping hard budgets can block sooner.`);
  } else {
    setImpact("#budget-impact", "", "Alert-only spending", `Alerts track $${amount.toFixed(2)} of paid overage from ${effectiveDate}, but spend can continue beyond the amount.`);
  }
}

function entityRow(name, detail, type, id) {
  return `<div class="entity-row"><div><strong>${escapeHtml(name)}</strong><br><small>${escapeHtml(detail)}</small></div><button class="delete" data-delete="${type}" data-id="${id}" title="Delete">×</button></div>`;
}

function renderBudgetScopeOptions() {
  const kind = $("#budget-kind").value;
  const product = scenario.products.find((item) => item.id === $("#budget-product").value);
  const typeSelect = $("#budget-scope-type");
  const previousType = typeSelect.value;
  if (kind === "user") {
    typeSelect.innerHTML = `<option value="enterprise">Universal ULB</option><option value="costCenter">Cost-center ULB</option><option value="user">Individual ULB</option>`;
    $("#budget-product").value = "ai-credits";
    $("#budget-product").disabled = true;
    $("#budget-enforcement").value = "hard";
    $("#budget-enforcement").disabled = true;
  } else {
    const types = product?.billingMode === "aiCredits" ? [["enterprise", "Enterprise"], ["organization", "Organization"], ["costCenter", "Cost center"]] : [["enterprise", "Enterprise"], ["organization", "Organization"], ["costCenter", "Cost center"], ["repository", "Repository"]];
    typeSelect.innerHTML = types.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    $("#budget-product").disabled = false;
    $("#budget-enforcement").disabled = false;
  }
  if ([...typeSelect.options].some((option) => option.value === previousType)) typeSelect.value = previousType;
  const type = typeSelect.value;
  const collections = { enterprise: [scenario.enterprise], organization: scenario.organizations, repository: scenario.repositories, costCenter: scenario.costCenters, user: scenario.users };
  setOptions("#budget-scope", collections[type] || [], $("#budget-scope").value);
  $("#budget-expiry-label").hidden = !(kind === "user" && type === "user");
}

function renderTimeline(replay, currency) {
  const lifecycle = seatLifecycleEvents(scenario);
  const totalItems = scenario.events.length + lifecycle.length;
  $("#event-count").textContent = `${totalItems} item${totalItems === 1 ? "" : "s"}`;
  const resultsById = new Map(replay.results.map((item) => [item.eventId, item]));
  const usageItems = scenario.events.map((event) => {
    const item = resultsById.get(event.id);
    return { date: event.date, html: `<div class="timeline-item"><span class="status-dot ${item?.status || ""}"></span><div><p><strong>${escapeHtml(item?.userName || "Unknown")}</strong> consumed ${Number(event.quantity).toLocaleString()} units</p><small>${event.date} · ${escapeHtml(item?.productName || "Unknown product")} · ${money(item?.cost || 0, currency)} · ${item?.status || "scheduled"}</small>${item?.status === "blocked" ? `<p><small>${escapeHtml(item.reason)}</small></p>` : ""}</div></div>` };
  });
  const lifecycleItems = lifecycle.map((event) => ({
    date: event.date,
    html: `<div class="timeline-item"><span class="status-dot"></span><div><p><strong>${escapeHtml(event.userName)}</strong> · ${escapeHtml(event.message)}</p><small>${event.date} · ${event.date > scenario.simulationDate ? "scheduled · " : ""}${money(event.chargeDelta, currency)} license charge · ${event.creditDelta >= 0 ? "+" : ""}${event.creditDelta.toLocaleString()} included credits</small></div></div>`,
  }));
  const items = [...usageItems, ...lifecycleItems].sort((a, b) => b.date.localeCompare(a.date));
  $("#timeline-list").innerHTML = items.length ? items.map((item) => item.html).join("") : `<div class="empty">The timeline is empty.</div>`;
  $("#alert-list").innerHTML = replay.alerts.length ? [...replay.alerts].reverse().map((alert) => `<div class="alert-item"><span class="alert-badge">!</span><div><p><strong>${escapeHtml(alert.message)}</strong></p><small>${alert.date} · ${escapeHtml(alert.reliability)}</small></div></div>`).join("") : `<div class="empty">No thresholds have been crossed.</div>`;
}

function renderResult(replay, currency) {
  const result = replay.results.find((item) => item.eventId === latestEventId);
  if (!result) return;
  const impacts = result.affectedBudgets.map((impact) => {
    const budget = scenario.budgets.find((item) => item.id === impact.budgetId);
    return `<div class="impact-row"><div><strong>${escapeHtml(budget?.name)}${impact.userId ? ` · ${escapeHtml(result.userName)}` : ""}</strong><small>${escapeHtml(impact.basis)} · ${money(impact.before, "USD")} → ${money(impact.after, "USD")}</small></div><strong>${Math.round(impact.percent)}%</strong></div>`;
  }).join("");
  const split = result.productName === "Copilot AI credits" ? `<div class="impact-row"><div><strong>${result.status === "blocked" ? "Proposed pool draw" : "Shared pool"}</strong><small>${result.includedQuantity.toLocaleString()} ${result.status === "blocked" ? "credits would have come from the pool" : "included credits consumed"}</small></div><strong>${result.poolBefore.toLocaleString()} → ${result.poolAfter.toLocaleString()}</strong></div><div class="impact-row"><div><strong>${result.status === "blocked" ? "Proposed paid overage" : "Paid overage"}</strong><small>${result.meteredQuantity.toLocaleString()} metered credits</small></div><strong>${money(result.cost, "USD")}</strong></div>` : "";
  $("#last-result").className = "result-placeholder result-box";
  $("#last-result").innerHTML = `<div class="result-header"><span class="result-icon ${result.status}">${result.status === "accepted" ? "✓" : "×"}</span><div><h3>${result.status === "accepted" ? "Usage accepted" : "Usage blocked"}</h3><p>${escapeHtml(result.reason)}</p></div></div><div class="result-cost">${result.quantity.toLocaleString()} ${escapeHtml(result.productName)}</div><p class="muted">Billed cost: ${money(result.cost, "USD")} · ${result.date}</p>${split}${impacts || `<div class="impact-row"><small>No budget counters changed.</small></div>`}`;
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
  const budgetTrigger = event.target.closest("[data-history-id]"); if (budgetTrigger) { openBudgetHistory(budgetTrigger.dataset.historyId, budgetTrigger); return; }
  const closeModal = event.target.closest("[data-close-modal]"); if (closeModal) { closeBudgetHistory(); return; }
  const go = event.target.closest("[data-go]"); if (go) navigate(go.dataset.go);
  const quick = event.target.closest("[data-quantity]"); if (quick) $("#usage-quantity").value = quick.dataset.quantity;
  const toggle = event.target.closest("[data-toggle-costcenter]"); if (toggle) {
    const target = scenario.costCenters.find((item) => item.id === toggle.dataset.toggleCostcenter);
    if (target) {
      target.excludeFromEnterpriseBudget = !target.excludeFromEnterpriseBudget;
      saveAndRender(target.excludeFromEnterpriseBudget ? "Cost center excluded from enterprise AI budget" : "Cost center included in enterprise AI budget");
    }
  }
  const deletion = event.target.closest("[data-delete]"); if (deletion) deleteEntity(deletion.dataset.delete, deletion.dataset.id);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeBudgetHistory();
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-history-id]")) {
    event.preventDefault();
    openBudgetHistory(event.target.dataset.historyId, event.target);
  }
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
["#usage-user", "#usage-repository", "#usage-product", "#usage-date"].forEach((selector) => $(selector).addEventListener("change", () => { renderSelectors(); renderApplicableControls(replayScenario(scenario), scenario.enterprise.currency); }));

$("#enterprise-form").addEventListener("submit", (event) => { event.preventDefault(); scenario.enterprise.name = $("#enterprise-name").value.trim(); scenario.enterprise.currency = $("#enterprise-currency").value; scenario.enterprise.paidAiUsage = $("#paid-ai-usage").checked; scenario.enterprise.seatCreditPolicy = $("#seat-credit-policy").value || "prorated"; saveAndRender("Enterprise saved"); });
$("#product-form").addEventListener("submit", (event) => { event.preventDefault(); scenario.products.push({ id: createId("product"), name: $("#product-name").value.trim(), unit: "unit", unitPrice: Number($("#product-price").value), billingMode: "metered" }); event.target.reset(); saveAndRender("Product added"); });
$("#organization-form").addEventListener("submit", (event) => { event.preventDefault(); scenario.organizations.push({ id: createId("org"), name: $("#organization-name").value.trim() }); event.target.reset(); saveAndRender("Organization added"); });
$("#repository-form").addEventListener("submit", (event) => { event.preventDefault(); scenario.repositories.push({ id: createId("repo"), name: $("#repository-name").value.trim(), organizationId: $("#repository-org").value }); event.target.reset(); saveAndRender("Repository added"); });
$("#cost-center-form").addEventListener("submit", (event) => { event.preventDefault(); const organizationId = $("#cost-center-org").value; scenario.costCenters.push({ id: createId("cc"), name: $("#cost-center-name").value.trim(), organizationIds: organizationId ? [organizationId] : [], excludeFromEnterpriseBudget: $("#cost-center-excluded").checked }); event.target.reset(); saveAndRender("Cost center added"); });
$("#user-form").addEventListener("submit", (event) => { event.preventDefault(); const organizationId = $("#user-org").value; scenario.users.push({ id: createId("user"), name: $("#user-name").value.trim(), organizationIds: [organizationId], licenseOrganizationId: organizationId, costCenterId: $("#user-cost-center").value || null, licensePlan: $("#user-license-plan").value, licenseStartsAt: $("#user-license-start").value || null, licenseEndsAt: $("#user-license-end").value || null, licenseEndMode: $("#user-license-end").value ? $("#user-license-end-mode").value : null }); event.target.reset(); saveAndRender("User added"); });
$("#budget-kind").addEventListener("change", renderBudgetScopeOptions);
$("#budget-product").addEventListener("change", renderBudgetScopeOptions);
$("#budget-scope-type").addEventListener("change", renderBudgetScopeOptions);
["#enterprise-form", "#cost-center-form", "#user-form", "#budget-form"].forEach((selector) => {
  $(selector).addEventListener("input", renderImpactPreviews);
  $(selector).addEventListener("change", renderImpactPreviews);
});
$("#budget-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const thresholds = $("#budget-thresholds").value.split(",").map(Number).filter((value) => value > 0).sort((a, b) => a - b);
  const kind = $("#budget-kind").value;
  const scopeType = $("#budget-scope-type").value;
  scenario.budgets.push({
    id: createId("budget"), name: $("#budget-name").value.trim(), budgetKind: kind,
    userBudgetType: kind === "user" ? ({ enterprise: "universal", costCenter: "costCenter", user: "individual" })[scopeType] : undefined,
    productId: kind === "user" ? "ai-credits" : $("#budget-product").value, scopeType, scopeId: $("#budget-scope").value,
    amount: Number($("#budget-amount").value), effectiveFrom: $("#budget-effective").value,
    expiresAt: kind === "user" && scopeType === "user" ? $("#budget-expiry").value || null : null,
    enforcement: kind === "user" ? "hard" : $("#budget-enforcement").value, thresholds,
  });
  event.target.reset(); $("#budget-effective").value = scenario.simulationDate; saveAndRender("Budget added");
});

function deleteEntity(type, id) {
  const key = ({ product: "products", organization: "organizations", costCenter: "costCenters", user: "users", budget: "budgets" })[type];
  if (!key) return;
  const referenced = type === "organization" && (scenario.repositories.some((item) => item.organizationId === id) || scenario.users.some((item) => item.organizationIds.includes(id)) || scenario.costCenters.some((item) => (item.organizationIds || []).includes(id))) || type === "costCenter" && scenario.users.some((item) => item.costCenterId === id) || type === "user" && scenario.events.some((item) => item.userId === id) || type === "product" && (scenario.events.some((item) => item.productId === id) || scenario.budgets.some((item) => item.productId === id));
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
