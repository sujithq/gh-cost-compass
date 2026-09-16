import { budgetInScope, bucketsForEvent, costCenterForUser, createDefaultScenario, createId, describeScope, eventInScope, isSeatActiveForDate, money, replayScenario, scopeLabels, seatChargeForPeriod, seatLifecycleEvents, userPoolContribution, usersInScope, validateScenario } from "./engine.js";
import { materializeScenario, validateScenarioDefinition } from "./scenario-runner.js";
import { loadScenarioCatalog } from "./scenario-catalog.js";
import { trimToastStack } from "./toast-stack.js";

const STORAGE_KEY = "copilot-budget-lab-scenario-v2";
const CUSTOM_SCENARIOS_KEY = "copilot-budget-lab-custom-scenarios-v1";
let scenario = loadScenario();
let builtInScenarioDefinitions = [];
let customScenarioDefinitions = loadCustomScenarioDefinitions();
let scenarioCatalogError = null;
let scenarioRun = { definitionId: "", stepIndex: -1, selectedStepIndex: 0, started: false, runAllArmed: false };
let latestEventId = null;
let budgetHistoryTrigger = null;
let seenAlertIds = null;
let lastBlockedToastId = null;
let optimizedScope = { type: "enterprise", id: "" };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

const ICON_PATHS = {
  hierarchy: '<rect x="4" y="3" width="6" height="5" rx="1.2"/><rect x="14" y="3" width="6" height="5" rx="1.2"/><rect x="9" y="16" width="6" height="5" rx="1.2"/><path d="M7 8v3a2 2 0 0 0 2 2h1"/><path d="M17 8v3a2 2 0 0 0-2 2h-1"/>',
  // Silhouettes are deliberately distinct from one another: a tall tower for the enterprise, a
  // pitched-roof office for an organization, a briefcase for a cost center, a person for a user.
  enterprise: '<path d="M4 21V3h10v18M14 9h6v12M2 21h20M7 7h4M7 11h4M7 15h4M17 13v1M17 17v1"/>',
  organization: '<path d="M3 21V7l9-4 9 4v14M7 21v-7h10v7M7 9h1M12 9h1M17 9h1"/>',
  costCenter: '<path d="M3 7h18v14H3zM8 7V3h8v4M3 12h18M10 12v3h4v-3"/>',
  user: '<path d="M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21v-3a8 6 0 0 1 16 0v3"/>',
  team: '<path d="M9 7a3 3 0 1 0 6 0a3 3 0 1 0-6 0M6 20v-2a6 5 0 0 1 12 0v2M4 5a3 3 0 0 0 0 6M20 5a3 3 0 0 1 0 6M2 19v-3M22 19v-3"/>',
  pool: '<path d="M3 6c0-5 18-5 18 0s-18 5-18 0M3 6v12c0 5 18 5 18 0V6M3 12c0 5 18 5 18 0"/>',
  hardStop: '<path d="M12 3 4.5 6v5.2c0 4.4 3.2 8.3 7.5 9.3 4.3-1 7.5-4.9 7.5-9.3V6L12 3Z"/><path d="M9.5 12l1.7 1.8L15 10"/>',
  alertOnly: '<path d="M12 3 4.5 6v5.2c0 4.4 3.2 8.3 7.5 9.3 4.3-1 7.5-4.9 7.5-9.3V6L12 3Z"/><path d="M12 8v4.2"/><circle cx="12" cy="15" r="0.9" fill="currentColor" stroke="none"/>',
  repo: '<path d="M6.5 3H19v14H6.5A2.5 2.5 0 0 0 4 19.5v-14A2.5 2.5 0 0 1 6.5 3Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H19v4H6.5A2.5 2.5 0 0 1 4 19.5Z"/><path d="M9 7h6"/>',
};
function icon(name, className = "") {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="icon${className ? ` ${className}` : ""}" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}

function loadScenario() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return validateScenario(saved) ? createDefaultScenario() : saved;
  } catch { return createDefaultScenario(); }
}

function loadCustomScenarioDefinitions() {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_SCENARIOS_KEY));
    return Array.isArray(saved) ? saved.filter((item) => !validateScenarioDefinition(item)) : [];
  } catch { return []; }
}

function scenarioDefinitions() {
  return [...builtInScenarioDefinitions, ...customScenarioDefinitions];
}

function selectedScenarioDefinition() {
  const definitions = scenarioDefinitions();
  return definitions.find((item) => item.id === scenarioRun.definitionId) || definitions[0] || null;
}

function saveAndRender(message, { toast = true } = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(scenario));
  if (message && toast) showToast(message);
  render();
}

const MAX_VISIBLE_TOASTS = 4;
const TOAST_ICONS = { info: "✓", warning: "!", danger: "×" };

function dismissToast(toast) {
  if (!toast || toast.dataset.dismissing === "true") return;
  toast.dataset.dismissing = "true";
  clearTimeout(Number(toast.dataset.timer));
  toast.classList.remove("show");
  setTimeout(() => toast.remove(), 200);
}

function scheduleToastDismissal(toast, duration) {
  clearTimeout(Number(toast.dataset.timer));
  toast.dataset.timer = String(setTimeout(() => dismissToast(toast), duration));
}

function showToast(message, options = {}) {
  const { tone = "info", detail = "", historyId = null, duration = tone === "info" ? 2400 : 7000 } = options;
  const stack = $("#toast-stack");
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;
  toast.innerHTML = `<span class="toast-icon">${TOAST_ICONS[tone]}</span><div class="toast-body"><strong>${escapeHtml(message)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}${historyId ? `<button type="button" class="toast-action" data-history-id="${escapeHtml(historyId)}">View history</button>` : ""}</div><button type="button" class="toast-close" data-dismiss-toast="true" aria-label="Dismiss notification">×</button>`;
  toast.addEventListener("mouseenter", () => clearTimeout(Number(toast.dataset.timer)));
  toast.addEventListener("mouseleave", () => scheduleToastDismissal(toast, 2000));
  toast.addEventListener("focusin", () => clearTimeout(Number(toast.dataset.timer)));
  toast.addEventListener("focusout", () => scheduleToastDismissal(toast, 2000));
  stack.append(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  scheduleToastDismissal(toast, duration);
  trimToastStack(stack, MAX_VISIBLE_TOASTS);
}

function announceSimulationFeedback(replay) {
  const currentIds = new Set(replay.alerts.map((alert) => alert.id));
  const freshAlerts = seenAlertIds === null ? [] : replay.alerts.filter((alert) => !seenAlertIds.has(alert.id));
  seenAlertIds = currentIds;
  for (const alert of freshAlerts) {
    const state = replay.budgetStates.find((item) => item.stateId === alert.stateKey);
    const detail = [state ? `${money(state.spent, "USD")} of ${money(state.amount, "USD")}` : null, alert.date, alert.reliability].filter(Boolean).join(" · ");
    showToast(alert.message, { tone: alert.threshold >= 90 ? "danger" : "warning", detail, historyId: alert.stateKey });
  }
  const blocked = latestEventId ? replay.results.find((item) => item.eventId === latestEventId && item.status === "blocked") : null;
  if (blocked && lastBlockedToastId !== blocked.eventId) {
    lastBlockedToastId = blocked.eventId;
    showToast("Usage blocked", { tone: "danger", detail: blocked.reason });
  }
  if (!blocked) lastBlockedToastId = null;
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

// Identifies a progress bar across re-renders so its previous width can be restored before the new
// one is applied. Cards carry a stable data-history-id; anything else falls back to its ordinal
// position within the panel, which is stable as long as the list order doesn't change.
function progressBarKey(bar, index) {
  const owner = bar.closest("[data-history-id]") || bar.closest("[data-bar-key]");
  return owner?.dataset.historyId || owner?.dataset.barKey || `index:${index}`;
}

// Panels that rebuild their markup wholesale destroy and recreate their bar elements, so the
// `transition: width` on `.progress > div` never has a previous value to animate from and the fill
// appears to jump. This replaces the markup, immediately paints each bar at the width its
// predecessor had, then flips it to the real target on the next frame so the transition runs.
function setPanelHtmlWithBarTransitions(selector, html) {
  const container = $(selector);
  if (!container) return;
  const previous = new Map();
  [...container.querySelectorAll(".progress > div")].forEach((bar, index) => {
    previous.set(progressBarKey(bar, index), bar.style.width);
  });

  container.innerHTML = html;

  const pending = [...container.querySelectorAll(".progress > div")].map((bar, index) => ({ bar, target: bar.style.width, before: previous.get(progressBarKey(bar, index)) }))
    .filter((item) => item.before !== undefined && item.before !== item.target);
  if (!pending.length) return;
  pending.forEach((item) => { item.bar.style.width = item.before; });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    pending.forEach((item) => { item.bar.style.width = item.target; });
  }));
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

function budgetChanges(before, after) {
  const previous = new Map(before.budgetStates.map((item) => [item.stateId, item]));
  return after.budgetStates.map((item) => ({ ...item, before: previous.get(item.stateId)?.spent || 0, delta: item.spent - (previous.get(item.stateId)?.spent || 0) })).filter((item) => Math.abs(item.delta) > 0.000001);
}

function scenarioResultHtml(result) {
  if (!result) return `<div class="scenario-result neutral"><strong>No usage event in this step</strong><span>The scenario state is unchanged; use the explanation and preview below.</span></div>`;
  return `<div class="scenario-result ${result.status}"><span class="result-icon ${result.status}">${result.status === "accepted" ? "✓" : "×"}</span><div><strong>${result.status === "accepted" ? "Usage accepted" : "Usage blocked"}</strong><span>${escapeHtml(result.reason)}</span><small>${Number(result.quantity).toLocaleString()} ${escapeHtml(result.productName)} · ${money(result.cost, "USD")}</small></div></div>`;
}

function stepInputHtml(step) {
  if (step.type === "usage") {
    return `<div class="scenario-input-grid"><div><span>User</span><strong>${escapeHtml(step.event.userId)}</strong></div><div><span>Product</span><strong>${escapeHtml(step.event.productId)}</strong></div><div><span>Quantity</span><strong>${Number(step.event.quantity).toLocaleString()}</strong></div><div><span>Date</span><strong>${escapeHtml(step.event.date)}</strong></div></div>`;
  }
  if (step.type === "advance-date") return `<div class="scenario-input-grid"><div><span>New simulation date</span><strong>${escapeHtml(step.date)}</strong></div></div>`;
  if (step.type === "configuration") return `<div class="scenario-input-grid"><div><span>Target</span><strong>${escapeHtml(step.mutation.target)}${step.mutation.id ? ` · ${escapeHtml(step.mutation.id)}` : ""}</strong></div><div><span>Changes</span><strong>${escapeHtml(JSON.stringify(step.mutation.changes))}</strong></div></div>`;
  return `<p class="muted">This checkpoint changes no state. It provides a deliberate inspection point.</p>`;
}

function renderScenarioStudio() {
  const definition = selectedScenarioDefinition();
  const definitions = scenarioDefinitions();
  const selector = $("#scenario-definition");
  if (!definition) {
    selector.innerHTML = `<option>No scenarios available</option>`;
    selector.disabled = true;
    $("#scenario-title").textContent = "Scenario catalog unavailable";
    $("#scenario-summary").textContent = scenarioCatalogError || "Import a valid custom scenario to continue.";
    $("#scenario-tags").innerHTML = "";
    $("#scenario-sources").innerHTML = "";
    $("#scenario-step-list").innerHTML = "";
    $("#scenario-progress-label").textContent = "0 steps";
    $("#scenario-outcome").innerHTML = `<div class="scenario-result blocked"><strong>Unable to load guided scenarios</strong><span>${escapeHtml(scenarioCatalogError || "No valid scenario definitions were found.")}</span></div>`;
    ["#scenario-reset", "#scenario-previous", "#scenario-next", "#scenario-run-selected", "#scenario-run-all", "#export-scenario-definition"].forEach((id) => { $(id).disabled = true; });
    return;
  }
  selector.disabled = false;
  selector.innerHTML = definitions.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === definition.id ? "selected" : ""}>${escapeHtml(item.title)}${builtInScenarioDefinitions.includes(item) ? "" : " · custom"}</option>`).join("");
  ["#scenario-reset", "#export-scenario-definition"].forEach((id) => { $(id).disabled = false; });
  $("#scenario-title").textContent = definition.title;
  $("#scenario-summary").textContent = definition.summary;
  $("#scenario-tags").innerHTML = (definition.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const sources = (definition.sourceUrls || []).map(safeSourceUrl).filter(Boolean);
  $("#scenario-sources").innerHTML = sources.length ? sources.map((url, index) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Source ${index + 1}</a>`).join("") : `<span class="muted">No external sources supplied</span>`;

  const activeIndex = scenarioRun.started ? scenarioRun.stepIndex : -1;
  const selectedIndex = Math.max(0, Math.min(scenarioRun.selectedStepIndex ?? activeIndex + 1, definition.steps.length - 1));
  scenarioRun.selectedStepIndex = selectedIndex;
  $("#scenario-progress-label").textContent = activeIndex < 0 ? `${definition.steps.length} steps · not started` : `Completed ${activeIndex + 1} of ${definition.steps.length}`;
  $("#scenario-step-list").innerHTML = definition.steps.map((step, index) => {
    const classes = [index <= activeIndex ? "complete" : "pending", index === activeIndex ? "active" : "", index === selectedIndex ? "selected" : ""].filter(Boolean).join(" ");
    return `<li><button type="button" class="scenario-step ${classes}" data-scenario-step="${index}" aria-current="${index === activeIndex ? "step" : "false"}" aria-pressed="${index === selectedIndex}"><span class="scenario-step-number">${index + 1}</span><span><strong>${escapeHtml(step.title)}</strong><small>${escapeHtml(step.description)}</small></span><span class="scenario-step-type">${escapeHtml(step.type)}</span></button></li>`;
  }).join("");

  const hasRemaining = activeIndex < definition.steps.length - 1;
  $("#scenario-previous").disabled = !scenarioRun.started || activeIndex < 0;
  $("#scenario-next").disabled = !hasRemaining;
  $("#scenario-run-selected").disabled = selectedIndex === activeIndex;
  $("#scenario-run-all").disabled = !hasRemaining;
  $("#scenario-run-all").textContent = scenarioRun.runAllArmed ? `Confirm run all (${definition.steps.length - activeIndex - 1})` : "Run all";

  const currentScenario = scenarioRun.started ? materializeScenario(definition, activeIndex) : materializeScenario(definition, -1);
  const beforeScenario = materializeScenario(definition, Math.max(-1, activeIndex - 1));
  const currentReplay = replayScenario(currentScenario);
  const beforeReplay = replayScenario(beforeScenario);
  const currentStep = activeIndex >= 0 ? definition.steps[activeIndex] : null;
  const resultId = currentStep?.type === "usage" ? `scenario-${definition.id}-${currentStep.id}` : null;
  const result = resultId ? currentReplay.results.find((item) => item.eventId === resultId) : null;
  const changes = currentStep ? budgetChanges(beforeReplay, currentReplay) : [];
  const poolDelta = currentReplay.pool.consumed - beforeReplay.pool.consumed;
  const newAlerts = currentReplay.alerts.filter((alert) => !beforeReplay.alerts.some((previous) => previous.id === alert.id));

  const selectedStep = definition.steps[selectedIndex];
  const previewBeforeIndex = selectedIndex > activeIndex ? activeIndex : Math.max(-1, selectedIndex - 1);
  const previewBefore = replayScenario(materializeScenario(definition, previewBeforeIndex));
  const previewAfter = replayScenario(materializeScenario(definition, selectedIndex));
  const previewChanges = budgetChanges(previewBefore, previewAfter);
  const previewPoolDelta = previewAfter.pool.consumed - previewBefore.pool.consumed;
  const previewResultId = selectedStep.type === "usage" ? `scenario-${definition.id}-${selectedStep.id}` : null;
  const previewResult = previewResultId ? previewAfter.results.find((item) => item.eventId === previewResultId) : null;
  const previewAlerts = previewAfter.alerts.filter((alert) => !previewBefore.alerts.some((previous) => previous.id === alert.id));
  const intervening = Math.max(0, selectedIndex - activeIndex - 1);
  const remaining = definition.steps.slice(activeIndex + 1);
  const runAllPreview = scenarioRun.runAllArmed ? `<div class="run-all-preview"><strong>Run all remaining steps?</strong><span>${remaining.length} steps: ${remaining.filter((step) => step.type === "usage").length} usage events, ${remaining.filter((step) => step.type === "configuration").length} configuration changes, ${remaining.filter((step) => step.type === "advance-date").length} date changes, and ${remaining.filter((step) => step.type === "checkpoint").length} checkpoints.</span><small>Review this summary, then select “Confirm run all” to execute.</small></div>` : "";

  const changedIds = new Set(changes.map((item) => item.stateId));
  const health = [
    { stateId: "pool", displayName: "Shared AI-credit pool", spent: currentReplay.pool.consumed, amount: currentReplay.pool.total, percent: currentReplay.pool.percent, unit: "credits" },
    ...currentReplay.budgetStates,
  ];
  setPanelHtmlWithBarTransitions("#scenario-outcome", `
    <section class="selected-step-preview">
      <div class="scenario-outcome-heading"><div><p class="eyebrow">SELECTED STEP PREVIEW</p><h3>${escapeHtml(selectedStep.title)}</h3></div><span class="scenario-status preview">Preview · Step ${selectedIndex + 1}</span></div>
      <p class="scenario-step-description">${escapeHtml(selectedStep.description)}</p>
      ${stepInputHtml(selectedStep)}
      <div class="expected-outcome"><strong>Expected outcome</strong><span>${escapeHtml(selectedStep.expected)}</span></div>
      ${intervening ? `<p class="scenario-jump-note">Running this selected step also applies ${intervening} preceding pending step${intervening === 1 ? "" : "s"} in order.</p>` : ""}
      <div class="scenario-deltas preview-deltas"><h4>Predicted changes</h4>
        ${previewPoolDelta ? `<div class="scenario-delta"><span>Shared pool consumed</span><strong>${previewBefore.pool.consumed.toLocaleString()} → ${previewAfter.pool.consumed.toLocaleString()}</strong></div>` : ""}
        ${previewChanges.map((item) => `<div class="scenario-delta"><span>${escapeHtml(item.displayName)}</span><strong>${money(item.before, "USD")} → ${money(item.spent, "USD")} (${Math.round(item.percent)}%)</strong></div>`).join("")}
        ${!previewPoolDelta && !previewChanges.length ? `<p class="muted">This step is not expected to change counters.</p>` : ""}
        ${previewResult ? `<div class="scenario-predicted-result ${previewResult.status}"><strong>Predicted: ${previewResult.status}</strong><span>${escapeHtml(previewResult.reason)}</span></div>` : ""}
        ${previewAlerts.map((alert) => `<div class="scenario-inline-alert"><strong>Expected alert: ${escapeHtml(alert.message)}</strong><span>${escapeHtml(alert.reliability)}</span></div>`).join("")}
      </div>
      ${runAllPreview}
    </section>
    <section class="actual-outcome">
      <div class="scenario-outcome-heading"><div><p class="eyebrow">ACTUAL OUTCOME</p><h3>${escapeHtml(currentStep?.title || "Scenario baseline")}</h3></div><span class="scenario-status ${currentStep ? "active" : ""}">${currentStep ? `Applied · Step ${activeIndex + 1}` : "No steps applied"}</span></div>
      ${scenarioResultHtml(result)}
      <div class="scenario-deltas"><h4>Changes in the last applied step</h4>
        ${poolDelta ? `<div class="scenario-delta"><span>Shared pool consumed</span><strong>${beforeReplay.pool.consumed.toLocaleString()} → ${currentReplay.pool.consumed.toLocaleString()} (${poolDelta > 0 ? "+" : ""}${poolDelta.toLocaleString()})</strong></div>` : ""}
        ${changes.map((item) => `<div class="scenario-delta"><span>${escapeHtml(item.displayName)}</span><strong>${money(item.before, "USD")} → ${money(item.spent, "USD")} (${item.delta > 0 ? "+" : ""}${money(item.delta, "USD")})</strong></div>`).join("")}
        ${!poolDelta && !changes.length ? `<p class="muted">No counters changed in the last applied step.</p>` : ""}
        ${newAlerts.map((alert) => `<div class="scenario-inline-alert"><strong>Alert: ${escapeHtml(alert.message)}</strong><span>${escapeHtml(alert.reliability)}</span></div>`).join("")}
      </div>
      <div class="scenario-health"><div class="panel-title"><h4>Current budget health</h4><span>After applied steps</span></div>${health.map((item) => `<div class="scenario-health-row ${item.stateId === "pool" ? (poolDelta ? "changed" : "") : changedIds.has(item.stateId) ? "changed" : ""}" data-bar-key="${escapeHtml(item.stateId)}"><div><strong>${escapeHtml(item.displayName)}</strong><small>${Number(item.spent).toLocaleString()} of ${Number(item.amount).toLocaleString()} ${item.unit || "USD"}</small></div><div class="scenario-health-meter"><span>${Math.round(item.percent)}%</span><div class="progress ${statusClass(item.percent)}"><div style="width:${Math.min(100, item.percent)}%"></div></div></div></div>`).join("")}</div>
    </section>`);
}

let scenarioTransitionBusy = false;

function runScenarioToStep(stepIndex, message) {
  if (scenarioTransitionBusy) return;
  scenarioTransitionBusy = true;
  try {
    const definition = selectedScenarioDefinition();
    const boundedIndex = Math.max(-1, Math.min(stepIndex, definition.steps.length - 1));
    const before = replayScenario(materializeScenario(definition, Math.max(-1, boundedIndex - 1)));
    seenAlertIds = new Set(before.alerts.map((alert) => alert.id));
    scenario = materializeScenario(definition, boundedIndex);
    scenarioRun = { definitionId: definition.id, stepIndex: boundedIndex, selectedStepIndex: Math.min(boundedIndex + 1, definition.steps.length - 1), started: true, runAllArmed: false };
    const step = boundedIndex >= 0 ? definition.steps[boundedIndex] : null;
    latestEventId = step?.type === "usage" ? `scenario-${definition.id}-${step.id}` : null;
    saveAndRender(message, { toast: false });
  } finally {
    scenarioTransitionBusy = false;
  }
}

function render() {
  const replay = replayScenario(scenario);
  const currency = scenario.enterprise.currency;
  $("#simulation-date").value = scenario.simulationDate;
  $("#usage-date").value = $("#usage-date").value || scenario.simulationDate;
  $("#period-label").textContent = replay.period;
  renderSummary(replay, currency);
  renderBudgets(replay, currency);
  renderScenarioStudio();
  renderGlobalScenarioBar();
  renderHierarchy();
  renderOptimizedExperience(replay, currency);
  renderActivity(replay, currency);
  renderSelectors();
  renderApplicableControls(replay, currency);
  renderConfiguration();
  renderImpactPreviews();
  renderTimeline(replay, currency);
  if (latestEventId) renderResult(replay, currency);
  announceSimulationFeedback(replay);
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
  setPanelHtmlWithBarTransitions("#budget-grid", poolCard + cards);
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
  budgetHistoryTrigger?.isConnected && budgetHistoryTrigger.focus();
  budgetHistoryTrigger = null;
}

// Every node states its own type, because an icon alone doesn't tell a first-time reader which
// row is the enterprise, the organization, the cost center, the repository, or the user.
const HIERARCHY_KINDS = {
  enterprise: { label: "Enterprise", className: "enterprise" },
  organization: { label: "Organization", className: "org" },
  costCenter: { label: "Cost center", className: "cost-center" },
  repo: { label: "Repository", className: "repo" },
  user: { label: "User", className: "user" },
};

// Enterprise-grade scenarios are the target: many organizations and cost centers, and hundreds of
// users. Everything below keeps the tree readable at that size — branches collapse, oversized leaf
// lists page in on demand, and a filter narrows the tree instead of forcing a manual hunt.
const HIERARCHY_LEAF_PAGE = 25;
const HIERARCHY_AUTO_COLLAPSE_USERS = 40;
const hierarchyExpansion = new Map();
const hierarchyFilters = new Map();

function hierarchyExpanded(key, fallback) {
  return hierarchyExpansion.has(key) ? hierarchyExpansion.get(key) : fallback;
}
function hierarchyNodeHtml(kind, name, detail, attributes = "", extraClass = "") {
  const meta = HIERARCHY_KINDS[kind];
  return `<div class="hierarchy-node ${meta.className}${extraClass ? ` ${extraClass}` : ""}"${attributes ? ` ${attributes}` : ""}><span>${icon(kind)}</span><div><span class="hierarchy-kind">${meta.label}</span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail)}</small></div></div>`;
}

function hierarchyLeafHtml(nodeHtml) {
  return `<div class="hierarchy-row leaf">${nodeHtml}</div>`;
}

// `childrenHtml` is a thunk so a collapsed branch never pays to build its subtree — the point of
// collapsing at enterprise scale is to avoid generating thousands of nodes per render.
function hierarchyBranchHtml(key, nodeHtml, open, summary, childrenHtml) {
  return `<div class="hierarchy-branch"><div class="hierarchy-row"><button type="button" class="hierarchy-toggle" data-tree-toggle="${escapeHtml(key)}" aria-expanded="${open}"><span aria-hidden="true">${open ? "▾" : "▸"}</span><span class="sr-only">${open ? "Collapse" : "Expand"} ${escapeHtml(summary)}</span></button>${nodeHtml}</div>${open ? `<div class="hierarchy-children">${childrenHtml()}</div>` : ""}</div>`;
}

// Renders a long list of sibling leaves in pages so a cost center with 300 users doesn't emit 300
// DOM nodes on every scrub tick.
function hierarchyLeafListHtml(key, leaves) {
  if (!leaves.length) return "";
  if (leaves.length <= HIERARCHY_LEAF_PAGE) return leaves.join("");
  const showAll = hierarchyExpanded(`${key}::all`, false);
  const shown = showAll ? leaves : leaves.slice(0, HIERARCHY_LEAF_PAGE);
  return shown.join("") + `<button type="button" class="hierarchy-more" data-tree-toggle="${escapeHtml(key)}::all">${showAll ? `Show fewer` : `Show all ${leaves.length}`}</button>`;
}

function hierarchyMatches(filter, ...values) {
  if (!filter) return true;
  return values.some((value) => String(value || "").toLowerCase().includes(filter));
}

// Builds the enterprise → organization → cost center → user/repository tree used by both the
// dashboard and the optimized page, so the two can never present different structures.
function hierarchyTreeHtml(hostId, { scopeNodes = false } = {}) {
  const filter = (hierarchyFilters.get(hostId) || "").trim().toLowerCase();
  const autoCollapse = scenario.users.length > HIERARCHY_AUTO_COLLAPSE_USERS;
  // While filtering, matches are always revealed: a stored collapse from before the search would
  // otherwise hide the very rows the user just searched for.
  const branchOpen = (key, fallback) => (filter ? true : hierarchyExpanded(key, fallback));
  const scopeAttributes = (type, id, name) => (scopeNodes ? `data-scope-type="${escapeHtml(type)}" data-scope-id="${escapeHtml(id)}"${optimizedScope.type === type && optimizedScope.id === id ? " active" : ""} tabindex="0" role="button" aria-label="Inspect ${escapeHtml(name)} scope"` : "");
  const scopeClass = scopeNodes ? "scope-node" : "";
  let matchCount = 0;

  const branches = scenario.organizations.map((org) => {
    const orgKey = `${hostId}:org:${org.id}`;
    const repos = scenario.repositories.filter((repo) => repo.organizationId === org.id);
    const users = scenario.users.filter((user) => user.organizationIds.includes(org.id));
    const costCenters = scenario.costCenters.filter((cc) => (cc.organizationIds || []).includes(org.id) || users.some((user) => user.costCenterId === cc.id));
    const orgMatches = hierarchyMatches(filter, org.name);

    const userLeafHtml = (user) => hierarchyLeafHtml(hierarchyNodeHtml("user", user.name, `${costCenterForUser(scenario, user)?.name || "No cost center"} · ${user.licensePlan} seat`, scopeAttributes("user", user.id, user.name), scopeClass));
    const visibleUsers = (list) => list.filter((user) => orgMatches || hierarchyMatches(filter, user.name, costCenterForUser(scenario, user)?.name));

    const costCenterHtml = costCenters.map((cc) => {
      const ccKey = `${hostId}:cc:${cc.id}`;
      const ccUsers = users.filter((user) => costCenterForUser(scenario, user)?.id === cc.id);
      const ccMatches = orgMatches || hierarchyMatches(filter, cc.name);
      const shownUsers = ccMatches ? ccUsers : visibleUsers(ccUsers);
      if (filter && !ccMatches && !shownUsers.length) return "";
      matchCount += 1 + shownUsers.length;
      const node = hierarchyNodeHtml("costCenter", cc.name, `${ccUsers.length} user${ccUsers.length === 1 ? "" : "s"} · ${cc.excludeFromEnterpriseBudget ? "Excluded from enterprise overage" : "Rolls up to enterprise overage"}`, scopeAttributes("costCenter", cc.id, cc.name), scopeClass);
      const open = branchOpen(ccKey, !autoCollapse);
      return hierarchyBranchHtml(ccKey, node, open, `${cc.name} members`, () => hierarchyLeafListHtml(ccKey, shownUsers.map(userLeafHtml)) || `<div class="empty">No users assigned.</div>`);
    }).join("");

    const unassigned = visibleUsers(users.filter((user) => !costCenterForUser(scenario, user)));
    const unassignedKey = `${hostId}:unassigned:${org.id}`;
    const unassignedOpen = branchOpen(unassignedKey, !autoCollapse);
    let unassignedHtml = "";
    if (unassigned.length) {
      matchCount += unassigned.length;
      const node = `<div class="hierarchy-node cost-center muted-node"><span>${icon("costCenter")}</span><div><span class="hierarchy-kind">Cost center</span><strong>No cost center</strong><small>${unassigned.length} user${unassigned.length === 1 ? "" : "s"} not assigned</small></div></div>`;
      unassignedHtml = hierarchyBranchHtml(unassignedKey, node, unassignedOpen, "unassigned users", () => hierarchyLeafListHtml(unassignedKey, unassigned.map(userLeafHtml)));
    }

    const visibleRepos = repos.filter((repo) => orgMatches || hierarchyMatches(filter, repo.name));
    const repoKey = `${hostId}:repos:${org.id}`;
    const repoOpen = branchOpen(repoKey, !autoCollapse);
    let repoHtml = "";
    if (visibleRepos.length) {
      matchCount += visibleRepos.length;
      const node = `<div class="hierarchy-node repo"><span>${icon("repo")}</span><div><span class="hierarchy-kind">Repositories</span><strong>${visibleRepos.length} repositor${visibleRepos.length === 1 ? "y" : "ies"}</strong><small>Usage here bills to ${escapeHtml(org.name)}</small></div></div>`;
      repoHtml = hierarchyBranchHtml(repoKey, node, repoOpen, `${org.name} repositories`, () => hierarchyLeafListHtml(repoKey, visibleRepos.map((repo) => hierarchyLeafHtml(hierarchyNodeHtml("repo", repo.name, `Bills to ${org.name}`)))));
    }

    const children = costCenterHtml + unassignedHtml + repoHtml;
    if (filter && !orgMatches && !children) return "";
    if (orgMatches) matchCount += 1;
    const orgOpen = branchOpen(orgKey, true);
    const orgNode = hierarchyNodeHtml("organization", org.name, `${users.length} user${users.length === 1 ? "" : "s"} · ${repos.length} repositor${repos.length === 1 ? "y" : "ies"} · ${costCenters.length} cost center${costCenters.length === 1 ? "" : "s"}`, scopeAttributes("organization", org.id, org.name), scopeClass);
    return hierarchyBranchHtml(orgKey, orgNode, orgOpen, org.name, () => children || `<div class="empty">No cost centers, repositories, or users yet.</div>`);
  }).join("");

  const enterpriseKey = `${hostId}:enterprise`;
  const enterpriseOpen = branchOpen(enterpriseKey, true);
  const enterpriseNode = hierarchyNodeHtml("enterprise", scenario.enterprise.name, `${scenario.organizations.length} organization${scenario.organizations.length === 1 ? "" : "s"} · ${scenario.costCenters.length} cost center${scenario.costCenters.length === 1 ? "" : "s"} · ${scenario.users.length} user${scenario.users.length === 1 ? "" : "s"}`, scopeAttributes("enterprise", scenario.enterprise.id, scenario.enterprise.name), scopeClass);
  const body = branches || `<div class="empty">${filter ? "No organizations, cost centers, repositories, or users match this filter." : "No organizations configured yet."}</div>`;

  const legend = `<div class="hierarchy-legend">${Object.entries(HIERARCHY_KINDS).map(([kind, meta]) => `<span class="${meta.className}">${icon(kind)}${meta.label}</span>`).join("")}</div>`;
  const controls = `<div class="hierarchy-controls"><input type="search" class="hierarchy-filter" data-tree-filter="${escapeHtml(hostId)}" value="${escapeHtml(hierarchyFilters.get(hostId) || "")}" placeholder="Filter organizations, cost centers, repositories, users" aria-label="Filter the enterprise hierarchy"><button type="button" class="text-button" data-tree-expand="${escapeHtml(hostId)}">Expand all</button><button type="button" class="text-button" data-tree-collapse="${escapeHtml(hostId)}">Collapse all</button></div>${filter ? `<p class="hierarchy-hint">${matchCount} match${matchCount === 1 ? "" : "es"} for “${escapeHtml(filter)}”.</p>` : ""}`;

  return legend + controls + hierarchyBranchHtml(enterpriseKey, enterpriseNode, enterpriseOpen, scenario.enterprise.name, () => body);
}

function renderHierarchy() {
  $("#hierarchy").innerHTML = hierarchyTreeHtml("dashboard");
}

// Repaints both trees without a full app render, then restores keyboard focus to the control the
// user just activated — otherwise collapsing a branch would drop focus back to the document body.
function renderHierarchyTrees(focusKey = null) {
  renderHierarchy();
  if ($("#optimized-hierarchy")) $("#optimized-hierarchy").innerHTML = hierarchyTreeHtml("optimized", { scopeNodes: true });
  if (focusKey) document.querySelector(`[data-tree-toggle="${CSS.escape(focusKey)}"]`)?.focus();
}

// Expansion must be set from the scenario data rather than from rendered DOM: a collapsed branch
// doesn't render its descendants, so "Expand all" would otherwise miss everything below the fold.
function setHierarchyExpansionForHost(hostId, open) {
  hierarchyExpansion.set(`${hostId}:enterprise`, open);
  scenario.organizations.forEach((org) => {
    hierarchyExpansion.set(`${hostId}:org:${org.id}`, open);
    hierarchyExpansion.set(`${hostId}:repos:${org.id}`, open);
    hierarchyExpansion.set(`${hostId}:unassigned:${org.id}`, open);
  });
  scenario.costCenters.forEach((cc) => hierarchyExpansion.set(`${hostId}:cc:${cc.id}`, open));
  renderHierarchyTrees();
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

function budgetIcon(budget) {
  if (budget.stateId === "pool" || budget.budgetKind === "pool") return icon("pool");
  if (budget.budgetKind === "user") return icon("hardStop");
  if (budget.enforcement === "hard") return icon("hardStop");
  return icon("alertOnly");
}

function scopeOptionsFor(type) {
  if (type === "enterprise") return [scenario.enterprise];
  if (type === "organization") return scenario.organizations;
  if (type === "costCenter") return scenario.costCenters;
  if (type === "user") return scenario.users;
  return [];
}

// Delegates to the engine's userId/repository-aware scope match instead of a fragile name lookup,
// so org membership picked up via a repository (not just a user's home org) is also honored.
function eventMatchesOptimizedScope(result) {
  if (!result) return true;
  return eventInScope(scenario, result, optimizedScope);
}

function bucketIconFor(kind) {
  return icon({ included: "pool", ulb: "hardStop", metered: "alertOnly", blocked: "alertOnly" }[kind] || "pool");
}

// Reuses the engine's bucketsForEvent so the event-level attribution shown here always matches
// the same logic that drives the budget/pool state cards (single source of truth).
function bucketImpactHtml(result) {
  if (!result) return "";
  const event = scenario.events.find((item) => item.id === result.eventId) || result;
  const buckets = bucketsForEvent(scenario, event, result);
  return buckets.map((bucket) => {
    const value = bucket.kind === "included"
      ? `${result.poolBefore.toLocaleString()} → ${result.poolAfter.toLocaleString()}`
      : bucket.kind === "blocked" ? "—" : `${money(bucket.before, "USD")} → ${money(bucket.after, "USD")}`;
    return `<div class="bucket-impact bucket-impact-${bucket.kind}"><span>${bucketIconFor(bucket.kind)}</span><div><strong>${escapeHtml(bucket.label)}</strong><small>${escapeHtml(bucket.scopeLabel)}</small></div><b>${value}</b></div>`;
  }).join("");
}

function daysInMonth(yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

// Real scenario step dates in the built-in catalog are frequently identical (e.g. every usage
// step landing on the same "2026-09-15" test date), which collapses the timeline onto a single
// point. To actually show progress across the month, spread steps evenly across the days of the
// scenario's starting month by step order, regardless of the step's real recorded date.
function stepDisplayDate(definition, step, index, totalSteps) {
  const anchor = (definition.startDate || scenario.simulationDate || "2026-09-01").slice(0, 7);
  const total = daysInMonth(anchor);
  const slot = totalSteps > 1 ? Math.round((index * (total - 1)) / (totalSteps - 1)) : 0;
  const day = Math.min(total, Math.max(1, slot + 1));
  return `${anchor}-${String(day).padStart(2, "0")}`;
}

function changeScenarioDefinition(id) {
  scenarioRun = { definitionId: id, stepIndex: -1, selectedStepIndex: 0, started: false, runAllArmed: false };
  latestEventId = null;
  render();
}

function renderGlobalScenarioHeader(definition, definitions) {
  const selector = $("#global-scenario-definition");
  if (!selector) return;
  if (!definition) {
    selector.innerHTML = `<option>No scenarios available</option>`;
    selector.disabled = true;
    $("#global-scenario-title").textContent = "Scenario catalog unavailable";
    $("#global-scenario-summary").textContent = scenarioCatalogError || "Import a valid custom scenario to continue.";
    $("#global-scenario-tags").innerHTML = "";
    return;
  }
  selector.disabled = false;
  selector.innerHTML = definitions.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === definition.id ? "selected" : ""}>${escapeHtml(item.title)}${builtInScenarioDefinitions.includes(item) ? "" : " · custom"}</option>`).join("");
  $("#global-scenario-title").textContent = definition.title;
  $("#global-scenario-summary").textContent = definition.summary;
  $("#global-scenario-tags").innerHTML = (definition.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
}

function bucketRowHtml(item) {
  return `<button type="button" class="bucket-row budget-history-trigger" data-history-id="${escapeHtml(item.stateId)}"><span class="bucket-icon">${budgetIcon(item)}</span><div><strong>${escapeHtml(item.displayName)}</strong><small>${item.budgetKind === "pool" ? `${item.spent.toLocaleString()} of ${item.amount.toLocaleString()} credits` : `${money(item.spent, "USD")} of ${money(item.amount, "USD")} · ${item.enforcement === "hard" ? "hard stop" : "alert only"}`}</small><div class="progress ${statusClass(item.percent)}"><div style="width:${Math.min(100, item.percent)}%"></div></div></div><b>${Math.round(item.percent)}%</b></button>`;
}

function bucketGroupHtml(group) {
  return `<section class="bucket-group" data-bucket-group="${escapeHtml(group.title)}"><h4>${escapeHtml(group.title)}</h4><p>${escapeHtml(group.note)}</p>${group.items.map(bucketRowHtml).join("") || `<div class="empty compact-empty">No matching buckets in this scope.</div>`}</section>`;
}

// Diffing keeps existing DOM nodes (and their in-flight CSS width transition) in place whenever the
// same set of bucket rows is still shown and only their numbers changed — e.g. stepping the scenario
// timeline forward. A full innerHTML replace on every update would tear down and recreate the bars,
// which is why the fill used to visually "jump" instead of animating.
function updateBucketPanel(groups) {
  const container = $("#optimized-buckets");
  if (!container) return;
  const signature = groups.map((group) => `${group.title}:${group.items.map((item) => item.stateId).join(",")}`).join("|");
  if (container.dataset.signature !== signature) {
    container.dataset.signature = signature;
    container.innerHTML = groups.map(bucketGroupHtml).join("");
    return;
  }
  groups.forEach((group) => {
    const section = [...container.children].find((child) => child.dataset.bucketGroup === group.title);
    if (!section) return;
    const note = section.querySelector("p");
    if (note) note.textContent = group.note;
    group.items.forEach((item) => {
      const row = section.querySelector(`[data-history-id="${item.stateId}"]`);
      if (!row) return;
      const bar = row.querySelector(".progress > div");
      const track = row.querySelector(".progress");
      const percentEl = row.querySelector("b");
      const smallEl = row.querySelector("small");
      if (bar) bar.style.width = `${Math.min(100, item.percent)}%`;
      if (track) track.className = `progress ${statusClass(item.percent)}`;
      if (percentEl) percentEl.textContent = `${Math.round(item.percent)}%`;
      if (smallEl) smallEl.textContent = item.budgetKind === "pool" ? `${item.spent.toLocaleString()} of ${item.amount.toLocaleString()} credits` : `${money(item.spent, "USD")} of ${money(item.amount, "USD")} · ${item.enforcement === "hard" ? "hard stop" : "alert only"}`;
    });
  });
}

function renderOptimizedBuckets(replay) {
  const scopeItems = scopeOptionsFor(optimizedScope.type);
  const inScope = (item) => budgetInScope(scenario, item, optimizedScope);
  const pool = { stateId: "pool", displayName: "Included AI-credit pool", spent: replay.pool.consumed, amount: replay.pool.total, remaining: replay.pool.remaining, percent: replay.pool.percent, budgetKind: "pool" };
  const userBudgets = replay.budgetStates.filter((item) => item.budgetKind === "user" && inScope(item));
  const meteredBudgets = replay.budgetStates.filter((item) => item.budgetKind === "metered" && inScope(item));
  const scopeNote = optimizedScope.type === "enterprise" ? "" : ` for ${scopeLabels[optimizedScope.type]} · ${escapeHtml(scopeItems.find((item) => item.id === optimizedScope.id)?.name || "")}`;
  let poolNote = "Consumed before paid overage starts.";
  if (optimizedScope.type !== "enterprise") {
    const scopedUsers = new Set(usersInScope(scenario, optimizedScope).map((user) => user.id));
    const scopedContribution = usersInScope(scenario, optimizedScope).reduce((sum, user) => sum + userPoolContribution(user, scenario.simulationDate, scenario), 0);
    const scopedConsumed = replay.results.filter((item) => item.status === "accepted" && item.date.startsWith(replay.period) && scopedUsers.has(item.userId)).reduce((sum, item) => sum + item.includedQuantity, 0);
    poolNote = `This scope contributed ${Math.round(scopedContribution).toLocaleString()} credits and has drawn ${scopedConsumed.toLocaleString()} from the shared pool.`;
  }
  updateBucketPanel([
    { title: "Included credits", items: [pool], note: poolNote },
    { title: "User-level budgets", items: userBudgets, note: `Hard stops based on total AI-credit value${scopeNote}.` },
    { title: "Budget controls", items: meteredBudgets, note: `Track paid metered overage after the pool${scopeNote}.` },
  ]);
}

// Plots the guided scenario's steps along a horizontal date axis in the app header, so the same
// scrubber drives every page (dashboard, simulate usage, optimized UI, timeline & alerts) instead
// of living on a single subpage. Stepping it re-materializes the scenario via runScenarioToStep,
// which is what lets every page reflect consumption growth at that point in the month.
function renderGlobalTimeline(definition) {
  const activeIndex = scenarioRun.started ? scenarioRun.stepIndex : -1;
  const dates = definition.steps.map((step, index) => stepDisplayDate(definition, step, index, definition.steps.length));
  const times = dates.map((date) => new Date(`${date}T00:00:00`).getTime());
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = Math.max(1, max - min);
  $("#global-timeline").innerHTML = definition.steps.map((step, index) => {
    // Inset the plotted range so the first/last markers (centered via translateX(-50%)) keep their
    // date labels inside the track instead of overflowing the panel edges.
    const position = 6 + ((times[index] - min) / span) * 88;
    const status = index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending";
    return `<button type="button" class="scenario-timeline-step ${status} type-${escapeHtml(step.type)}" style="left:${position}%" data-scenario-timeline-step="${index}" title="${escapeHtml(step.title)} · ${escapeHtml(dates[index])} · ${escapeHtml(step.type)}" role="listitem" aria-current="${index === activeIndex ? "step" : "false"}"><span class="scenario-timeline-dot">${index + 1}</span><small>${escapeHtml(dates[index].slice(5))}</small></button>`;
  }).join("");
  $("#global-timeline-label").textContent = activeIndex < 0 ? `${definition.steps.length} steps · not started` : `Step ${activeIndex + 1} of ${definition.steps.length} · ${dates[activeIndex]}`;
  $("#global-timeline-prev").disabled = !scenarioRun.started || activeIndex < 0;
  $("#global-timeline-next").disabled = activeIndex >= definition.steps.length - 1;
}

function renderGlobalScenarioBar() {
  const definition = selectedScenarioDefinition();
  renderGlobalScenarioHeader(definition, scenarioDefinitions());
  if (definition) {
    renderGlobalTimeline(definition);
    return;
  }
  $("#global-timeline").innerHTML = "";
  $("#global-timeline-label").textContent = "";
  $("#global-timeline-prev").disabled = true;
  $("#global-timeline-next").disabled = true;
}

function renderOptimizedStepDetail(definition, replay) {
  const activeIndex = scenarioRun.started ? scenarioRun.stepIndex : -1;
  const step = activeIndex >= 0 ? definition.steps[activeIndex] : null;
  if (!step) {
    $("#optimized-step-detail").innerHTML = `<div class="empty">Run the first scenario step to see consumption and threshold impact here.</div>`;
    return;
  }
  const resultId = step.type === "usage" ? `scenario-${definition.id}-${step.id}` : null;
  const result = resultId ? replay.results.find((item) => item.eventId === resultId) : null;
  const inScope = !result || eventMatchesOptimizedScope(result);
  const body = result
    ? (inScope ? `<div class="bucket-impact-list">${bucketImpactHtml(result) || `<div class="empty compact-empty">No bucket counters changed.</div>`}</div>` : `<p class="muted">This step's usage event is outside the selected scope — pick a broader scope to see its bucket impact.</p>`)
    : `<p class="muted">This step does not add a usage event; check the credit buckets above for any resulting change.</p>`;
  $("#optimized-step-detail").innerHTML = `<div class="optimized-event-card ${result?.status || ""}"><div><span class="status-dot ${result?.status || ""}"></span><strong>${escapeHtml(step.title)}</strong><small>${escapeHtml(stepDisplayDate(definition, step, activeIndex, definition.steps.length))} · ${escapeHtml(step.type)}</small></div><p>${escapeHtml(step.description)}</p>${body}</div>`;
}

function renderOptimizedExperience(replay, currency) {
  const typeSelect = $("#optimized-scope-type");
  if (!typeSelect) return;
  typeSelect.value = optimizedScope.type;
  const scopeItems = scopeOptionsFor(optimizedScope.type);
  if (!scopeItems.some((item) => item.id === optimizedScope.id)) optimizedScope.id = scopeItems[0]?.id || "";
  setOptions("#optimized-scope", scopeItems, optimizedScope.id);

  const definition = selectedScenarioDefinition();
  renderOptimizedBuckets(replay);

  $("#optimized-hierarchy").innerHTML = hierarchyTreeHtml("optimized", { scopeNodes: true });

  if (definition) {
    renderOptimizedStepDetail(definition, replay);
  } else {
    $("#optimized-step-detail").innerHTML = `<div class="empty">No scenario selected.</div>`;
  }
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
  $("#global-timeline-bar").classList.toggle("hidden", view === "configuration");
  $("#page-title").textContent = ({ dashboard: "Dashboard", optimized: "Optimized UI", simulate: "Simulate usage", configuration: "Configuration", timeline: "Timeline & alerts" })[view];
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
$("#global-scenario-definition").addEventListener("change", (event) => changeScenarioDefinition(event.target.value));
$("#optimized-scope-type").addEventListener("change", (event) => {
  optimizedScope = { type: event.target.value, id: "" };
  renderOptimizedExperience(replayScenario(scenario), scenario.enterprise.currency);
});
$("#optimized-scope").addEventListener("change", (event) => {
  optimizedScope.id = event.target.value;
  renderOptimizedExperience(replayScenario(scenario), scenario.enterprise.currency);
});
$("#global-timeline-prev").addEventListener("click", () => runScenarioToStep(scenarioRun.stepIndex - 1, "Returned to the previous scenario step"));
$("#global-timeline-next").addEventListener("click", () => runScenarioToStep(scenarioRun.started ? scenarioRun.stepIndex + 1 : 0, "Scenario advanced one step"));
document.addEventListener("click", (event) => {
  // Tree chrome is checked before scope selection so that clicking a disclosure arrow inside a
  // clickable scope node only collapses the branch instead of also changing the inspected scope.
  const treeToggle = event.target.closest("[data-tree-toggle]");
  if (treeToggle) {
    const key = treeToggle.dataset.treeToggle;
    const open = treeToggle.hasAttribute("aria-expanded") ? treeToggle.getAttribute("aria-expanded") === "true" : hierarchyExpanded(key, false);
    hierarchyExpansion.set(key, !open);
    renderHierarchyTrees(key);
    return;
  }
  const expandAll = event.target.closest("[data-tree-expand]");
  const collapseAll = event.target.closest("[data-tree-collapse]");
  if (expandAll || collapseAll) {
    setHierarchyExpansionForHost((expandAll || collapseAll).dataset.treeExpand || (expandAll || collapseAll).dataset.treeCollapse, Boolean(expandAll));
    return;
  }
  const scopeNode = event.target.closest("[data-scope-type][data-scope-id]");
  if (scopeNode) {
    optimizedScope = { type: scopeNode.dataset.scopeType, id: scopeNode.dataset.scopeId };
    renderOptimizedExperience(replayScenario(scenario), scenario.enterprise.currency);
    return;
  }
  const timelineStep = event.target.closest("[data-scenario-timeline-step]"); if (timelineStep) { runScenarioToStep(Number(timelineStep.dataset.scenarioTimelineStep), "Scenario advanced to the selected step"); return; }
  const scenarioStep = event.target.closest("[data-scenario-step]"); if (scenarioStep) { scenarioRun.selectedStepIndex = Number(scenarioStep.dataset.scenarioStep); scenarioRun.runAllArmed = false; renderScenarioStudio(); return; }
  const dismiss = event.target.closest("[data-dismiss-toast]"); if (dismiss) { dismissToast(dismiss.closest(".toast")); return; }
  const budgetTrigger = event.target.closest("[data-history-id]"); if (budgetTrigger) { if (budgetTrigger.closest(".toast")) navigate("dashboard"); openBudgetHistory(budgetTrigger.dataset.historyId, budgetTrigger); return; }
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

document.addEventListener("input", (event) => {
  const filterInput = event.target.closest("[data-tree-filter]");
  if (!filterInput) return;
  const hostId = filterInput.dataset.treeFilter;
  hierarchyFilters.set(hostId, filterInput.value);
  const caret = filterInput.selectionStart;
  renderHierarchyTrees();
  // The tree host is rebuilt wholesale, so the live input is a new element; put the cursor back.
  const restored = document.querySelector(`[data-tree-filter="${CSS.escape(hostId)}"]`);
  if (restored) { restored.focus(); restored.setSelectionRange(caret, caret); }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeBudgetHistory();
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-history-id]")) {
    event.preventDefault();
    openBudgetHistory(event.target.dataset.historyId, event.target);
  }
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-scope-type][data-scope-id]")) {
    event.preventDefault();
    event.target.click();
  }
});

$("#scenario-definition").addEventListener("change", (event) => changeScenarioDefinition(event.target.value));
$("#scenario-reset").addEventListener("click", () => runScenarioToStep(-1, "Scenario reset to its baseline"));
$("#scenario-previous").addEventListener("click", () => runScenarioToStep(scenarioRun.stepIndex - 1, "Returned to the previous scenario step"));
$("#scenario-next").addEventListener("click", () => runScenarioToStep(scenarioRun.started ? scenarioRun.stepIndex + 1 : 0, "Scenario advanced one step"));
$("#scenario-run-selected").addEventListener("click", () => runScenarioToStep(scenarioRun.selectedStepIndex, "Scenario advanced to the selected step"));
$("#scenario-run-all").addEventListener("click", () => {
  if (!scenarioRun.runAllArmed) {
    scenarioRun.runAllArmed = true;
    renderScenarioStudio();
    return;
  }
  runScenarioToStep(selectedScenarioDefinition().steps.length - 1, "Scenario completed");
});
$("#export-scenario-definition").addEventListener("click", () => {
  const definition = selectedScenarioDefinition();
  const blob = new Blob([JSON.stringify(definition, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${definition.id}.scenario.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Scenario definition exported");
});
$("#import-scenario-definition").addEventListener("change", async (event) => {
  try {
    const imported = JSON.parse(await event.target.files[0].text());
    const definitions = Array.isArray(imported) ? imported : [imported];
    for (const definition of definitions) {
      const error = validateScenarioDefinition(definition);
      if (error) throw new Error(error);
      if (builtInScenarioDefinitions.some((item) => item.id === definition.id)) throw new Error(`The id ${definition.id} is reserved by a built-in scenario.`);
      materializeScenario(definition, -1);
      customScenarioDefinitions = customScenarioDefinitions.filter((item) => item.id !== definition.id);
      customScenarioDefinitions.push(definition);
    }
    localStorage.setItem(CUSTOM_SCENARIOS_KEY, JSON.stringify(customScenarioDefinitions));
    scenarioRun = { definitionId: definitions.at(-1).id, stepIndex: -1, selectedStepIndex: 0, started: false, runAllArmed: false };
    renderScenarioStudio();
    showToast(`${definitions.length} scenario definition${definitions.length === 1 ? "" : "s"} imported`);
  } catch (error) {
    showToast(`Scenario import failed: ${error.message}`, { tone: "danger" });
  } finally { event.target.value = ""; }
});

$("#simulation-date").addEventListener("change", (event) => { scenarioRun.started = false; scenario.simulationDate = event.target.value; $("#usage-date").value = event.target.value; saveAndRender("Simulation date changed"); });
$("#previous-day").addEventListener("click", () => { scenarioRun.started = false; scenario.simulationDate = addDays(scenario.simulationDate, -1); $("#usage-date").value = scenario.simulationDate; saveAndRender(); });
$("#next-day").addEventListener("click", () => { scenarioRun.started = false; scenario.simulationDate = addDays(scenario.simulationDate, 1); $("#usage-date").value = scenario.simulationDate; saveAndRender(); });
$("#next-month").addEventListener("click", () => { scenarioRun.started = false; scenario.simulationDate = addMonth(scenario.simulationDate); $("#usage-date").value = scenario.simulationDate; saveAndRender("Advanced to next billing period"); });

$("#usage-form").addEventListener("submit", (event) => {
  event.preventDefault();
  scenarioRun.started = false;
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

async function initializeScenarioCatalog() {
  try {
    builtInScenarioDefinitions = await loadScenarioCatalog();
    const definitions = scenarioDefinitions();
    if (!definitions.some((item) => item.id === scenarioRun.definitionId)) scenarioRun.definitionId = definitions[0]?.id || "";
  } catch (error) {
    scenarioCatalogError = error.message;
    scenarioRun.definitionId = customScenarioDefinitions[0]?.id || "";
  }
  render();
  if (scenarioCatalogError) showToast("Built-in scenarios could not be loaded", { tone: "danger", detail: scenarioCatalogError });
}

$("#budget-effective").value = scenario.simulationDate;
initializeScenarioCatalog();
