import { DEFAULT_SCENARIO_SET_ID, createScenarioFromDefaultSet, defaultScenarioSetOptions } from "./default-scenario-sets.js";

export const scopeLabels = {
  enterprise: "Enterprise",
  organization: "Organization",
  repository: "Repository",
  costCenter: "Cost center",
  user: "Individual user",
};

const AI_CREDIT_PRICE = 0.01;
const INCLUDED_CREDITS = { business: 1900, enterprise: 3900 };
const SEAT_PRICE = { business: 19, enterprise: 39 };

export function monthKey(date) {
  return String(date).slice(0, 7);
}

export function money(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value || 0);
}

export function daysInMonth(date) {
  const [year, month] = String(date).slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function dayDifference(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.max(0, Math.round((end - start) / 86400000));
}

export function seatChargeForPeriod(user, atDate = new Date().toISOString().slice(0, 10)) {
  const monthStart = `${monthKey(atDate)}-01`;
  const periodEnd = new Date(`${monthStart}T00:00:00Z`);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  const nextMonth = periodEnd.toISOString().slice(0, 10);
  const seatStart = user.licenseStartsAt || monthStart;
  if (seatStart >= nextMonth || (user.licenseEndsAt && user.licenseEndsAt < monthStart)) return 0;
  if (seatStart <= monthStart) return Number(SEAT_PRICE[user.licensePlan] || 0);
  const totalDays = daysInMonth(monthStart);
  const remainingDays = totalDays - dayDifference(monthStart, seatStart);
  return Number(SEAT_PRICE[user.licensePlan] || 0) * (remainingDays / totalDays);
}

export { DEFAULT_SCENARIO_SET_ID, defaultScenarioSetOptions };

export function createDefaultScenario(defaultSetId = DEFAULT_SCENARIO_SET_ID) {
  // Default sets are authored as JSON and may predate newer fields (enterprise teams, cost center
  // AI-credit pools), so normalize before handing the scenario out.
  return normalizeScenario(createScenarioFromDefaultSet(defaultSetId));
}

export function normalizeScenario(scenario) {
  if (!scenario || typeof scenario !== "object") return scenario;
  scenario.enterpriseTeams ||= [];
  for (const team of scenario.enterpriseTeams) team.userIds ||= [];
  for (const costCenter of scenario.costCenters || []) {
    costCenter.organizationIds ||= [];
    costCenter.repositoryIds ||= [];
    costCenter.userIds ||= [];
    costCenter.enterpriseTeamIds ||= [];
    costCenter.aiCreditPoolEnabled = Boolean(costCenter.aiCreditPoolEnabled);
    costCenter.aiCreditPoolCapMode = costCenter.aiCreditPoolCapMode === "block" ? "block" : "allowOverage";
    costCenter.excludeFromEnterpriseBudget = Boolean(costCenter.excludeFromEnterpriseBudget);
  }
  return scenario;
}

function eventScenario(scenario, event) {
  return normalizeScenario(event.scenarioSnapshot ? structuredClone(event.scenarioSnapshot) : scenario);
}

function isActive(budget, date) {
  return date >= budget.effectiveFrom && (!budget.expiresAt || date <= budget.expiresAt);
}

export function costCenterForUser(scenario, user) {
  normalizeScenario(scenario);
  if (!user) return undefined;
  const direct = scenario.costCenters.find((item) => item.id === user.costCenterId)
    || scenario.costCenters.find((item) => item.userIds.includes(user.id));
  if (direct) return direct;
  const teamIds = new Set(scenario.enterpriseTeams.filter((team) => team.userIds.includes(user.id)).map((team) => team.id));
  const teamCostCenter = scenario.costCenters.find((item) => item.enterpriseTeamIds.some((teamId) => teamIds.has(teamId)));
  if (teamCostCenter) return teamCostCenter;
  return scenario.costCenters.find((item) => item.organizationIds.includes(user.licenseOrganizationId));
}

function costCenterForEvent(scenario, event, product) {
  const user = scenario.users.find((item) => item.id === event.userId);
  if (product?.billingMode === "metered") {
    const repositoryCostCenter = scenario.costCenters.find((item) => item.repositoryIds.includes(event.repositoryId));
    if (repositoryCostCenter) return repositoryCostCenter;
  }
  return costCenterForUser(scenario, user);
}

function matchesScope(budget, event, scenario, product) {
  const user = scenario.users.find((item) => item.id === event.userId);
  const repo = scenario.repositories.find((item) => item.id === event.repositoryId);
  const costCenter = costCenterForEvent(scenario, event, product);
  if (!user || !isActive(budget, event.date) || budget.productId !== product?.id) return false;
  switch (budget.scopeType) {
    case "enterprise": {
      return budget.scopeId === scenario.enterprise.id && !(product.billingMode === "aiCredits" && costCenter?.excludeFromEnterpriseBudget);
    }
    case "organization": return product.billingMode === "aiCredits" ? !costCenter && user.licenseOrganizationId === budget.scopeId : user.organizationIds.includes(budget.scopeId) || repo?.organizationId === budget.scopeId;
    case "repository": return event.repositoryId === budget.scopeId;
    case "costCenter": return costCenter?.id === budget.scopeId;
    case "user": return event.userId === budget.scopeId;
    default: return false;
  }
}

function selectUserBudget(scenario, user, date) {
  const active = scenario.budgets.filter((budget) => budget.budgetKind === "user" && budget.productId === "ai-credits" && isActive(budget, date));
  const costCenter = costCenterForUser(scenario, user);
  return active.find((budget) => budget.userBudgetType === "individual" && budget.scopeId === user.id)
    || active.find((budget) => budget.userBudgetType === "costCenter" && budget.scopeId === costCenter?.id)
    || active.find((budget) => budget.userBudgetType === "universal");
}

function stateFor(states, key) {
  return states.get(key) || { spent: 0, triggered: [] };
}

function budgetTypeLabel(budget, product) {
  if (budget.budgetKind === "user") return "Bundled AI credits budget";
  return product?.billingMode === "aiCredits" ? "SKU-level budget" : "Product-level budget";
}

function budgetScopeLabel(budget) {
  return budget.budgetKind === "user" ? "Users" : scopeLabels[budget.scopeType] || budget.scopeType;
}

function budgetConfiguration(scenario, budget, product) {
  return [
    { label: "Budget Type", value: budgetTypeLabel(budget, product) },
    { label: product?.billingMode === "aiCredits" ? "SKU" : "Product", value: product?.name || budget.productId },
    { label: "Budget scope", value: `${budgetScopeLabel(budget)} · ${describeScope(scenario, budget)}` },
    { label: "Budget amount", value: money(Number(budget.amount), "USD") },
    { label: "Stop usage when budget limit is reached", value: budget.enforcement === "hard" || budget.budgetKind === "user" ? "Enabled" : "Not enabled" },
    { label: "Receive budget threshold alerts", value: (budget.thresholds || []).length ? `Enabled · ${(budget.thresholds || []).join("%, ")}%` : "Not enabled" },
  ];
}

function budgetEvaluation(scenario, budget, product, before, increment, eventAlerts, blocked, applied) {
  const after = before + increment;
  const amount = Number(budget.amount);
  const overLimit = after > amount;
  const stopEnabled = budget.enforcement === "hard" || budget.budgetKind === "user" || (product?.billingMode === "aiCredits" && amount === 0);
  const alertText = eventAlerts.length ? ` Receive budget threshold alerts fired at ${eventAlerts.map((alert) => `${alert.threshold}%`).join(", ")}.` : "";
  const result = blocked
    ? `The event would move usage from ${money(before, "USD")} to ${money(after, "USD")}, above the ${money(amount, "USD")} budget amount. Stop usage when budget limit is reached is enabled, so usage is blocked.`
    : overLimit && !stopEnabled
      ? `The event ${applied ? "moves" : "would move"} usage from ${money(before, "USD")} to ${money(after, "USD")}, above the ${money(amount, "USD")} budget amount. Stop usage when budget limit is reached is not enabled, so this control allows usage to continue.${alertText}`
      : `The event ${applied ? "moves" : "would move"} usage from ${money(before, "USD")} to ${money(after, "USD")} and remains within the ${money(amount, "USD")} budget amount.${alertText}`;
  return {
    control: budget.budgetKind === "user" ? "User-level budget" : "Budgets and alerts",
    configuration: budgetConfiguration(scenario, budget, product),
    result,
    outcome: blocked ? "blocked" : eventAlerts.length ? "alerted" : overLimit ? "continued" : "passed",
  };
}

function updateBudget(states, alerts, result, budget, key, increment, event, userId) {
  const previous = stateFor(states, key);
  const nextSpent = previous.spent + increment;
  const amount = Number(budget.amount);
  const beforePercent = amount ? previous.spent / amount * 100 : 100;
  const nextPercent = amount ? nextSpent / amount * 100 : 100;
  const newlyTriggered = (budget.thresholds || []).filter((threshold) => beforePercent < threshold && nextPercent >= threshold && !previous.triggered.includes(threshold));
  states.set(key, { spent: nextSpent, triggered: [...previous.triggered, ...newlyTriggered] });
  result.affectedBudgets.push({ budgetId: budget.id, stateKey: key, userId, before: previous.spent, after: nextSpent, percent: nextPercent, basis: budget.budgetKind === "user" ? "Total AI-credit consumption" : "Billable metered overage" });
  for (const threshold of newlyTriggered) {
    alerts.push({ id: `${event.id}-${key}-${threshold}`, eventId: event.id, date: event.date, budgetId: budget.id, stateKey: key, threshold, message: `${budget.name}${userId ? ` (${result.userName})` : ""} reached ${threshold}%`, reliability: budget.budgetKind === "user" ? "User-level alert delivery is not guaranteed by GitHub" : "UI and email" });
  }
}

export function isSeatActiveForDate(user, date) {
  if (user.licenseStartsAt && date < user.licenseStartsAt) return false;
  if (!user.licenseEndsAt) return true;
  if (user.licenseEndMode === "unassign") return monthKey(date) <= monthKey(user.licenseEndsAt);
  return date < user.licenseEndsAt;
}

export function userPoolContribution(user, date, scenario = null) {
  const monthStart = `${date.slice(0, 7)}-01`;
  const startedAfterMonthStart = Boolean(user.licenseStartsAt && user.licenseStartsAt > monthStart && user.licenseStartsAt <= date);
  const hadSeatAtMonthStart = !user.licenseStartsAt || user.licenseStartsAt <= monthStart;
  const endedBeforeMonthStart = Boolean(user.licenseEndsAt && user.licenseEndsAt < monthStart);
  if (endedBeforeMonthStart) return 0;
  if (!(startedAfterMonthStart || hadSeatAtMonthStart)) return 0;
  const totalCredits = INCLUDED_CREDITS[user.licensePlan] || 0;
  if (!startedAfterMonthStart || !scenario || scenario.enterprise?.seatCreditPolicy === "full") return totalCredits;
  const totalDays = daysInMonth(monthStart);
  const remainingDays = Math.max(1, totalDays - dayDifference(monthStart, user.licenseStartsAt));
  return totalCredits * (remainingDays / totalDays);
}

function includedPoolFor(scenario, atDate = scenario.simulationDate, { excludeCostCenterPools = false } = {}) {
  normalizeScenario(scenario);
  return scenario.users.reduce((total, user) => {
    const costCenter = costCenterForUser(scenario, user);
    if (excludeCostCenterPools && costCenter?.aiCreditPoolEnabled) return total;
    return total + userPoolContribution(user, atDate, scenario);
  }, 0);
}

export function costCenterIncludedPoolFor(scenario, costCenterId, atDate = scenario.simulationDate) {
  normalizeScenario(scenario);
  return scenario.users.reduce((total, user) => {
    const costCenter = costCenterForUser(scenario, user);
    return costCenter?.id === costCenterId ? total + userPoolContribution(user, atDate, scenario) : total;
  }, 0);
}

function includedPoolUsers(scenario, costCenter = null) {
  return scenario.users.filter((user) => {
    const userCostCenter = costCenterForUser(scenario, user);
    return costCenter ? userCostCenter?.id === costCenter.id : !userCostCenter?.aiCreditPoolEnabled;
  });
}

function nextMonthStart(date) {
  const value = new Date(`${monthKey(date)}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString().slice(0, 10);
}

export function seatLifecycleEvents(scenario) {
  return scenario.users.flatMap((user) => {
    const events = [];
    if (user.licenseStartsAt) {
      events.push({
        id: `seat-start-${user.id}`,
        type: "seat-grant",
        date: user.licenseStartsAt,
        userId: user.id,
        userName: user.name,
        chargeDelta: seatChargeForPeriod(user, user.licenseStartsAt),
        creditDelta: userPoolContribution(user, user.licenseStartsAt, scenario),
        message: `${user.licensePlan === "enterprise" ? "Enterprise" : "Business"} seat granted`,
      });
    }
    if (user.licenseEndsAt) {
      const mode = user.licenseEndMode === "unassign" ? "unassign" : "revoke";
      events.push({
        id: `seat-end-${user.id}`,
        type: mode === "unassign" ? "seat-unassign" : "seat-revoke",
        date: user.licenseEndsAt,
        userId: user.id,
        userName: user.name,
        chargeDelta: 0,
        creditDelta: 0,
        message: mode === "unassign" ? "Seat unassigned; access continues through month end" : "Seat revoked; access stops immediately",
      });
      events.push({
        id: `seat-reset-${user.id}`,
        type: "seat-reset",
        date: nextMonthStart(user.licenseEndsAt),
        userId: user.id,
        userName: user.name,
        chargeDelta: 0,
        creditDelta: -userPoolContribution(user, user.licenseEndsAt, scenario),
        message: "Seat no longer contributes to the new monthly pool",
      });
    }
    return events;
  }).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function describeScope(scenario, budget) {
  if (budget.userBudgetType === "universal") return "All licensed users";
  const collections = { enterprise: [scenario.enterprise], organization: scenario.organizations, repository: scenario.repositories, costCenter: scenario.costCenters, user: scenario.users };
  return collections[budget.scopeType]?.find((item) => item.id === budget.scopeId)?.name || budget.scopeId;
}

export function replayScenario(scenario) {
  normalizeScenario(scenario);
  const states = new Map();
  const pools = new Map();
  const costCenterPools = new Map();
  const includedConsumedByUser = new Map();
  const results = [];
  const alerts = [];
  const orderedEvents = scenario.events.map((event, index) => ({ ...event, _order: index })).filter((event) => event.date <= scenario.simulationDate).sort((a, b) => a.date.localeCompare(b.date) || a._order - b._order);

  for (const event of orderedEvents) {
    const effectiveScenario = eventScenario(scenario, event);
    const product = effectiveScenario.products.find((item) => item.id === event.productId);
    const user = effectiveScenario.users.find((item) => item.id === event.userId);
    const quantity = Number(event.quantity);
    const period = monthKey(event.date);
    const isAi = product?.billingMode === "aiCredits";
    const eventCostCenter = costCenterForEvent(effectiveScenario, event, product);
    const costCenterPoolEnabled = Boolean(isAi && eventCostCenter?.aiCreditPoolEnabled);
    const poolStateKey = costCenterPoolEnabled ? `${eventCostCenter.id}:${period}` : `enterprise:${period}`;
    const poolBefore = costCenterPoolEnabled ? (costCenterPools.get(poolStateKey) || 0) : (pools.get(period) || 0);
    const poolTotal = costCenterPoolEnabled ? costCenterIncludedPoolFor(effectiveScenario, eventCostCenter.id, event.date) : includedPoolFor(effectiveScenario, event.date, { excludeCostCenterPools: true });
    const userAccessBlocked = user && !isSeatActiveForDate(user, event.date);
    let blockingReason = userAccessBlocked ? `${user.name} does not have an active Copilot seat on ${event.date}` : null;
    const eligiblePoolUsers = isAi ? includedPoolUsers(effectiveScenario, costCenterPoolEnabled ? eventCostCenter : null) : [];
    const includedCapacityRemaining = eligiblePoolUsers.reduce((sum, poolUser) => {
      const key = `${poolUser.id}:${period}`;
      return sum + Math.max(0, userPoolContribution(poolUser, event.date, effectiveScenario) - (includedConsumedByUser.get(key) || 0));
    }, 0);
    const includedQuantity = isAi ? Math.min(quantity, includedCapacityRemaining) : 0;
    const meteredQuantity = isAi ? quantity - includedQuantity : quantity;
    const billedCost = meteredQuantity * Number(product?.unitPrice || 0);
    const grossAiValue = isAi ? quantity * AI_CREDIT_PRICE : 0;
    const userBudget = isAi && user ? selectUserBudget(effectiveScenario, user, event.date) : null;
    const userBudgetKey = userBudget ? `${userBudget.id}:${user.id}:${period}` : null;
    const meteredBudgets = effectiveScenario.budgets.filter((budget) => budget.budgetKind === "metered" && matchesScope(budget, event, effectiveScenario, product));

    if (!blockingReason && userBudget && stateFor(states, userBudgetKey).spent + grossAiValue > Number(userBudget.amount)) blockingReason = `${userBudget.name}: Stop usage when budget limit is reached is enabled and this event would exceed the user-level budget amount`;
    if (!blockingReason && costCenterPoolEnabled && meteredQuantity > 0 && eventCostCenter.aiCreditPoolCapMode === "block") blockingReason = `Included usage controls for cost centers block members of ${eventCostCenter.name} when the included AI credit pool cap is reached`;
    if (!blockingReason && isAi && meteredQuantity > 0 && !effectiveScenario.enterprise.paidAiUsage) blockingReason = `AI credit paid usage is disabled and the eligible ${costCenterPoolEnabled ? `${eventCostCenter.name} cost-center pool` : "enterprise shared pool"} is exhausted`;
    if (!blockingReason) {
      const blocker = meteredBudgets.find((budget) => (budget.enforcement === "hard" || (isAi && Number(budget.amount) === 0)) && stateFor(states, `${budget.id}:${period}`).spent + billedCost > Number(budget.amount));
      if (blocker) blockingReason = `${blocker.name}: Stop usage when budget limit is reached is enabled and this event would exceed the budget amount`;
    }

    const fundingRoute = !isAi ? "metered" : blockingReason ? "blocked" : meteredQuantity > 0 ? (includedQuantity > 0 ? "split" : "overage") : "included";
    const result = {
      eventId: event.id, date: event.date, userId: event.userId || null, repositoryId: event.repositoryId || null, productId: event.productId || null,
      userName: user?.name || "Unknown user", productName: product?.name || "Unknown product",
      quantity, includedQuantity, meteredQuantity, cost: billedCost, grossAiValue, poolBefore, poolAfter: blockingReason ? poolBefore : poolBefore + includedQuantity, poolTotal,
      poolStateKey, poolName: costCenterPoolEnabled ? `${eventCostCenter.name} included AI-credit pool` : "Enterprise shared included AI-credit pool", poolType: costCenterPoolEnabled ? "costCenter" : "enterprise",
      poolRemainingBefore: Math.max(0, poolTotal - poolBefore), fundingRoute,
      status: blockingReason ? "blocked" : "accepted", reason: blockingReason || (isAi && billedCost === 0 ? "Usage accepted from included AI credits" : "Usage accepted with metered charges"), affectedBudgets: [], controlEvaluations: [],
    };
    if (userAccessBlocked) {
      result.controlEvaluations.push({
        control: "Copilot seat access",
        configuration: [{ label: "Active Copilot seat", value: "No" }],
        result: `${user.name} does not have an active Copilot seat on ${event.date}, so no budget or included usage controls are evaluated.`,
        outcome: "blocked",
      });
    }

    const userBudgetBefore = userBudget ? stateFor(states, userBudgetKey).spent : 0;
    const meteredBudgetBefore = new Map(meteredBudgets.map((budget) => [budget.id, stateFor(states, `${budget.id}:${period}`).spent]));
    if (!blockingReason) {
      if (isAi && costCenterPoolEnabled) costCenterPools.set(poolStateKey, poolBefore + includedQuantity);
      else if (isAi) pools.set(period, poolBefore + includedQuantity);
      if (isAi && includedQuantity > 0) {
        let remainingIncluded = includedQuantity;
        const allocationOrder = [...eligiblePoolUsers].sort((left, right) => (left.id === user?.id ? -1 : right.id === user?.id ? 1 : left.id.localeCompare(right.id)));
        for (const poolUser of allocationOrder) {
          if (remainingIncluded <= 0) break;
          const key = `${poolUser.id}:${period}`;
          const remainingContribution = Math.max(0, userPoolContribution(poolUser, event.date, effectiveScenario) - (includedConsumedByUser.get(key) || 0));
          const allocation = Math.min(remainingIncluded, remainingContribution);
          if (allocation > 0) includedConsumedByUser.set(key, (includedConsumedByUser.get(key) || 0) + allocation);
          remainingIncluded -= allocation;
        }
      }
      if (userBudget) updateBudget(states, alerts, result, userBudget, userBudgetKey, grossAiValue, event, user.id);
      for (const budget of meteredBudgets) updateBudget(states, alerts, result, budget, `${budget.id}:${period}`, billedCost, event);
    }
    if (userBudget && !result.controlEvaluations.some((item) => item.outcome === "blocked")) {
      const blocked = Boolean(blockingReason && userBudgetBefore + grossAiValue > Number(userBudget.amount));
      result.controlEvaluations.push(budgetEvaluation(effectiveScenario, userBudget, product, userBudgetBefore, grossAiValue, alerts.filter((alert) => alert.eventId === event.id && alert.budgetId === userBudget.id), blocked, !blockingReason));
    }
    if (isAi && !result.controlEvaluations.some((item) => item.outcome === "blocked")) {
      if (costCenterPoolEnabled) {
        const exceedsPool = meteredQuantity > 0;
        const blocked = exceedsPool && eventCostCenter.aiCreditPoolCapMode === "block";
        result.controlEvaluations.push({
          control: "Included usage controls for cost centers",
          configuration: [
            { label: "Cost center", value: eventCostCenter.name },
            { label: "AI credit pool enabled", value: "Enabled" },
            { label: "At the included usage cap", value: eventCostCenter.aiCreditPoolCapMode === "block" ? "Block members" : "Continue as paid overage" },
          ],
          result: exceedsPool
            ? `The cost center has consumed ${poolBefore.toLocaleString()} of ${poolTotal.toLocaleString()} included AI credits. This event needs ${meteredQuantity.toLocaleString()} credits beyond the cap, so ${blocked ? "usage is blocked before paid overage or metered budgets are evaluated" : "the additional usage continues as paid overage"}.`
            : `The event uses ${includedQuantity.toLocaleString()} included AI credits and remains within the ${poolTotal.toLocaleString()}-credit cost center pool.`,
          outcome: blocked ? "blocked" : exceedsPool ? "continued" : "passed",
        });
      } else {
        result.controlEvaluations.push({
          control: "Included AI credits",
          configuration: [{ label: "Eligible pool", value: result.poolName }],
          result: meteredQuantity > 0
            ? `The eligible pool has ${result.poolRemainingBefore.toLocaleString()} credits remaining, so ${meteredQuantity.toLocaleString()} credits require paid overage.`
            : `The event is fully covered by ${includedQuantity.toLocaleString()} included AI credits.`,
          outcome: "passed",
        });
      }
    }
    if (isAi && meteredQuantity > 0 && !result.controlEvaluations.some((item) => item.outcome === "blocked")) {
      const paidUsageBlocked = !effectiveScenario.enterprise.paidAiUsage;
      result.controlEvaluations.push({
        control: "AI credit paid usage",
        configuration: [{ label: "AI credit paid usage", value: effectiveScenario.enterprise.paidAiUsage ? "Enabled" : "Disabled" }],
        result: paidUsageBlocked ? "Paid overage is not allowed, so usage is blocked before metered budgets are evaluated." : `${meteredQuantity.toLocaleString()} credits can continue as paid overage, subject to applicable budgets.`,
        outcome: paidUsageBlocked ? "blocked" : "passed",
      });
    }
    if (!result.controlEvaluations.some((item) => item.outcome === "blocked")) {
      for (const budget of meteredBudgets) {
        const before = meteredBudgetBefore.get(budget.id) || 0;
        const blocked = Boolean(blockingReason && before + billedCost > Number(budget.amount) && (budget.enforcement === "hard" || (isAi && Number(budget.amount) === 0)));
        result.controlEvaluations.push(budgetEvaluation(effectiveScenario, budget, product, before, billedCost, alerts.filter((alert) => alert.eventId === event.id && alert.budgetId === budget.id), blocked, !blockingReason));
        if (blocked) break;
      }
    }
    results.push(result);
  }

  const selectedPeriod = monthKey(scenario.simulationDate);
  const configuredMeteredStates = scenario.budgets.filter((budget) => budget.budgetKind === "metered").map((budget) => ({ budget, key: `${budget.id}:${selectedPeriod}`, user: null }));
  const userStates = scenario.users.map((user) => {
    const budget = selectUserBudget(scenario, user, scenario.simulationDate);
    return budget ? { budget, key: `${budget.id}:${user.id}:${selectedPeriod}`, user } : null;
  }).filter(Boolean);
  const budgetStates = [...userStates, ...configuredMeteredStates].map(({ budget, key, user }) => {
    const state = stateFor(states, key);
    const amount = Number(budget.amount);
    return { ...budget, stateId: key, userId: user?.id, displayName: user ? `${budget.name} — ${user.name}` : budget.name, spent: state.spent, remaining: Math.max(0, amount - state.spent), percent: amount ? state.spent / amount * 100 : 100, triggered: state.triggered };
  });
  const poolTotal = includedPoolFor(scenario, scenario.simulationDate, { excludeCostCenterPools: true });
  const consumed = pools.get(selectedPeriod) || 0;
  const effectivePoolTotal = Math.max(poolTotal, consumed);
  const meteredCost = results.filter((item) => item.status === "accepted" && item.date.startsWith(selectedPeriod)).reduce((sum, item) => sum + item.cost, 0);
  const historicalCostCenterPools = new Map(results.filter((item) => item.status === "accepted" && item.date.startsWith(selectedPeriod) && item.poolType === "costCenter").map((item) => [item.poolStateKey, item]));
  const costCenterPoolKeys = new Map(scenario.costCenters.filter((item) => item.aiCreditPoolEnabled).map((costCenter) => [`${costCenter.id}:${selectedPeriod}`, { costCenter }]));
  for (const [stateId, result] of historicalCostCenterPools) {
    const costCenterId = stateId.split(":")[0];
    if (!costCenterPoolKeys.has(stateId)) costCenterPoolKeys.set(stateId, { costCenter: scenario.costCenters.find((item) => item.id === costCenterId), result });
  }
  const costCenterPoolStates = [...costCenterPoolKeys].map(([stateId, { costCenter, result }]) => {
    const costCenterId = costCenter?.id || stateId.split(":")[0];
    const enabled = Boolean(costCenter?.aiCreditPoolEnabled);
    const total = enabled && costCenter ? costCenterIncludedPoolFor(scenario, costCenter.id, scenario.simulationDate) : Number(result?.poolTotal || 0);
    const consumed = costCenterPools.get(stateId) || 0;
    return {
      id: costCenterId,
      stateId,
      costCenterId,
      displayName: result?.poolName || `${costCenter?.name || costCenterId} included AI-credit pool`,
      capMode: costCenter?.aiCreditPoolCapMode || "allowOverage",
      enabled,
      total,
      consumed,
      remaining: Math.max(0, total - consumed),
      percent: total ? consumed / total * 100 : 100,
      thresholds: [75, 90, 100],
    };
  });

  return { results, alerts, budgetStates, costCenterPoolStates, period: selectedPeriod, pool: { stateId: `enterprise:${selectedPeriod}`, total: effectivePoolTotal, consumed, remaining: Math.max(0, effectivePoolTotal - consumed), percent: effectivePoolTotal ? consumed / effectivePoolTotal * 100 : 100, meteredCost } };
}

// Re-runs replayScenario as if only events up to and including eventId had happened yet, using the
// same date-then-original-index ordering the engine uses internally. This lets the UI "scrub" through
// history and see included-pool / ULB / metered-budget totals grow event by event instead of only ever
// showing the final end-of-period totals.
export function replayScenarioThroughEvent(scenario, eventId) {
  if (!eventId) return replayScenario(scenario);
  const ordered = scenario.events.map((event, index) => ({ event, index })).sort((a, b) => a.event.date.localeCompare(b.event.date) || a.index - b.index);
  const cutoff = ordered.findIndex((item) => item.event.id === eventId);
  if (cutoff === -1) return replayScenario(scenario);
  const includedIds = new Set(ordered.slice(0, cutoff + 1).map((item) => item.event.id));
  return replayScenario({ ...scenario, events: scenario.events.filter((event) => includedIds.has(event.id)) });
}

// --- Consumption attribution & scope-aware inspection helpers ---
// A "scope" is { type: "enterprise" | "organization" | "costCenter" | "user", id }.

export function listScopeEntities(scenario, type) {
  switch (type) {
    case "organization": return scenario.organizations;
    case "costCenter": return scenario.costCenters;
    case "user": return scenario.users;
    default: return [scenario.enterprise];
  }
}

export function usersInScope(scenario, scope) {
  if (!scope || scope.type === "enterprise") return scenario.users;
  switch (scope.type) {
    case "organization": return scenario.users.filter((user) => user.organizationIds.includes(scope.id));
    case "costCenter": return scenario.users.filter((user) => costCenterForUser(scenario, user)?.id === scope.id);
    case "user": return scenario.users.filter((user) => user.id === scope.id);
    default: return [];
  }
}

// Determines whether a usage event (or a replay result carrying userId/repositoryId) belongs under a scope node.
export function eventInScope(scenario, event, scope) {
  if (!scope || scope.type === "enterprise") return true;
  const user = scenario.users.find((item) => item.id === event.userId);
  if (!user) return false;
  const repo = scenario.repositories.find((item) => item.id === event.repositoryId);
  switch (scope.type) {
    case "organization": return user.organizationIds.includes(scope.id) || repo?.organizationId === scope.id;
    case "costCenter": return costCenterForUser(scenario, user)?.id === scope.id;
    case "user": return user.id === scope.id;
    default: return false;
  }
}

// Determines whether a budget (or budgetState) is relevant to a scope, including broader ancestor budgets
// (e.g. the enterprise metered budget still applies while inspecting an organization or user).
export function budgetInScope(scenario, budget, scope) {
  if (!scope) return true;
  // replayScenario materializes user-level budgets into one state per user, each carrying its own
  // userId. Such a state governs only that user, regardless of where the definition is scoped, so it
  // must be matched on the user rather than on the definition's scopeType — otherwise a universal or
  // enterprise-scoped ULB definition appears to be "in play" for every user at once.
  if (budget.userId) return usersInScope(scenario, scope).some((user) => user.id === budget.userId);
  if (scope.type === "enterprise") return true;
  if (budget.scopeType === "enterprise") return true;
  if (budget.budgetKind === "user" && budget.userBudgetType === "universal") return true;
  const scoped = usersInScope(scenario, scope);
  switch (budget.scopeType) {
    case "user": return scoped.some((user) => user.id === budget.scopeId);
    case "costCenter":
      if (scope.type === "costCenter") return budget.scopeId === scope.id;
      return scoped.some((user) => costCenterForUser(scenario, user)?.id === budget.scopeId);
    case "organization":
      if (scope.type === "organization") return budget.scopeId === scope.id;
      return scoped.some((user) => user.organizationIds.includes(budget.scopeId));
    case "repository": {
      const repo = scenario.repositories.find((item) => item.id === budget.scopeId);
      if (!repo) return false;
      if (scope.type === "organization") return repo.organizationId === scope.id;
      return scoped.some((user) => user.organizationIds.includes(repo.organizationId));
    }
    default: return false;
  }
}

// Describes a cost center using the two sections GitHub shows on its detail page — "Resources"
// (what is attributed to the cost center) and "Settings" (the AI credit included usage cap) — so the
// simulator's wording maps onto the settings an administrator actually configures. Shared by the
// configuration page and the Optimized UI inspector so the two can never drift apart.
export function describeCostCenterConfiguration(scenario, costCenter, atDate = scenario.simulationDate) {
  normalizeScenario(scenario);
  const namesFor = (collection, ids) => collection.filter((item) => (ids || []).includes(item.id)).map((item) => item.name);
  const attributedUsers = scenario.users.filter((user) => costCenterForUser(scenario, user)?.id === costCenter.id);
  const licensedUsers = attributedUsers.filter((user) => isSeatActiveForDate(user, atDate));
  return {
    name: costCenter.name,
    resources: [
      { label: "Enterprise teams", names: namesFor(scenario.enterpriseTeams, costCenter.enterpriseTeamIds) },
      { label: "Organizations", names: namesFor(scenario.organizations, costCenter.organizationIds) },
      { label: "Repositories", names: namesFor(scenario.repositories, costCenter.repositoryIds) },
      // Users are reported by effective attribution rather than the explicit userIds list, because a
      // user can also land in a cost center via their enterprise team or organization. GitHub's
      // "N selected" count reflects who is actually attributed, which is what drives the cap below.
      { label: "Users", names: attributedUsers.map((user) => user.name) },
    ],
    settings: {
      includedUsageCapEnabled: Boolean(costCenter.aiCreditPoolEnabled),
      // GitHub derives this cap from the Copilot licenses attributed to the cost center rather than
      // letting an admin type an amount, which is why it is computed here instead of stored.
      capCredits: Math.round(costCenterIncludedPoolFor(scenario, costCenter.id, atDate)),
      licenseCount: licensedUsers.length,
      attributedUserCount: attributedUsers.length,
      atCapBehavior: costCenter.aiCreditPoolCapMode === "block" ? "block" : "allowOverage",
      excludeFromEnterpriseBudget: Boolean(costCenter.excludeFromEnterpriseBudget),
    },
  };
}

// Configuration facts for whichever node is selected in the Optimized UI hierarchy, so selecting a
// node explains how that entity is set up and not only what it has consumed.
export function describeScopeConfiguration(scenario, scope) {
  normalizeScenario(scenario);
  if (!scope) return null;
  switch (scope.type) {
    case "costCenter": {
      const costCenter = scenario.costCenters.find((item) => item.id === scope.id);
      return costCenter ? { type: "costCenter", ...describeCostCenterConfiguration(scenario, costCenter) } : null;
    }
    case "organization": {
      const organization = scenario.organizations.find((item) => item.id === scope.id);
      if (!organization) return null;
      const repositories = scenario.repositories.filter((repo) => repo.organizationId === organization.id);
      return {
        type: "organization",
        name: organization.name,
        facts: [
          { label: "Repositories", value: `${repositories.length}` },
          { label: "Licensed users", value: `${usersInScope(scenario, scope).filter((user) => isSeatActiveForDate(user, scenario.simulationDate)).length}` },
        ],
      };
    }
    case "user": {
      const user = scenario.users.find((item) => item.id === scope.id);
      if (!user) return null;
      const costCenter = costCenterForUser(scenario, user);
      const includedCredits = Math.round(userPoolContribution(user, scenario.simulationDate, scenario));
      return {
        type: "user",
        name: user.name,
        facts: [
          { label: "Copilot license", value: user.licensePlan === "enterprise" ? "Enterprise" : "Business" },
          { label: "Included credits", value: `${includedCredits} this cycle` },
          { label: "Cost center", value: costCenter?.name || "Not attributed" },
          { label: "Seat status", value: isSeatActiveForDate(user, scenario.simulationDate) ? "Active" : "Inactive" },
        ],
      };
    }
    default: {
      const licensed = scenario.users.filter((user) => isSeatActiveForDate(user, scenario.simulationDate)).length;
      return {
        type: "enterprise",
        name: scenario.enterprise.name,
        facts: [
          { label: "Licensed users", value: `${licensed}` },
          { label: "Mid-cycle seat credits", value: scenario.enterprise.seatCreditPolicy === "full" ? "Full" : "Prorated" },
          { label: "AI credit paid usage", value: scenario.enterprise.paidAiUsage ? "Allowed after included pool" : "Blocked after included pool" },
        ],
      };
    }
  }
}

// Describes every bucket (included-credit pool and/or budget controls) a single replayed usage event touched.
export function bucketsForEvent(scenario, event, result) {
  const buckets = [];
  const product = scenario.products.find((item) => item.id === event.productId);
  if (product?.billingMode === "aiCredits" && result.includedQuantity > 0) {
    buckets.push({ kind: "included", label: "Included AI-credit pool", scopeLabel: result.poolName || "Shared enterprise pool", amount: result.includedQuantity });
  }
  if (product?.billingMode === "aiCredits" && result.meteredQuantity > 0) {
    buckets.push({ kind: "overage", label: "Paid AI overage", scopeLabel: `${result.poolName || "Eligible included pool"} exhausted`, amount: result.meteredQuantity, cost: result.cost });
  }
  for (const impact of result.affectedBudgets) {
    const budget = scenario.budgets.find((item) => item.id === impact.budgetId);
    if (!budget) continue;
    buckets.push({
      kind: budget.budgetKind === "user" ? "ulb" : "metered",
      label: budget.name,
      scopeLabel: budget.budgetKind === "user" ? `${budget.userBudgetType} ULB` : `${scopeLabels[budget.scopeType]} · ${describeScope(scenario, budget)}`,
      amount: impact.after - impact.before,
      before: impact.before,
      after: impact.after,
      percent: impact.percent,
    });
  }
  if (result.status === "blocked") buckets.push({ kind: "blocked", label: "Blocked", scopeLabel: result.reason, amount: 0 });
  return buckets;
}

export function validateScenario(value) {
  if (!value || typeof value !== "object" || value.version !== 2 || !value.enterprise || !value.simulationDate) return "This file is not a version 2 AI-credit scenario.";
  normalizeScenario(value);
  const requiredArrays = ["organizations", "repositories", "costCenters", "users", "products", "budgets", "events", "enterpriseTeams"];
  const missing = requiredArrays.find((key) => !Array.isArray(value[key]));
  if (missing) return `Missing ${missing} array.`;
  const collections = {
    organizations: value.organizations,
    repositories: value.repositories,
    costCenters: value.costCenters,
    users: value.users,
    products: value.products,
    budgets: value.budgets,
    events: value.events,
  };
  for (const [name, items] of Object.entries(collections)) {
    const ids = items.map((item) => item?.id).filter(Boolean);
    if (ids.length !== items.length) return `Every ${name} item needs an id.`;
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) return `Duplicate ${name} id: ${duplicate}.`;
  }
  const organizationIds = new Set(value.organizations.map((item) => item.id));
  const repositoryIds = new Set(value.repositories.map((item) => item.id));
  const costCenterIds = new Set(value.costCenters.map((item) => item.id));
  const userIds = new Set(value.users.map((item) => item.id));
  const productIds = new Set(value.products.map((item) => item.id));
  for (const repository of value.repositories) {
    if (!organizationIds.has(repository.organizationId)) return `Repository ${repository.id} references unknown organization ${repository.organizationId}.`;
  }
  for (const costCenter of value.costCenters) {
    const unknownOrganization = (costCenter.organizationIds || []).find((id) => !organizationIds.has(id));
    if (unknownOrganization) return `Cost center ${costCenter.id} references unknown organization ${unknownOrganization}.`;
  }
  for (const user of value.users) {
    if (!organizationIds.has(user.licenseOrganizationId)) return `User ${user.id} references unknown license organization ${user.licenseOrganizationId}.`;
    const unknownOrganization = (user.organizationIds || []).find((id) => !organizationIds.has(id));
    if (unknownOrganization) return `User ${user.id} references unknown organization ${unknownOrganization}.`;
    if (user.costCenterId && !costCenterIds.has(user.costCenterId)) return `User ${user.id} references unknown cost center ${user.costCenterId}.`;
  }
  for (const budget of value.budgets) {
    if (!productIds.has(budget.productId)) return `Budget ${budget.id} references unknown product ${budget.productId}.`;
    const scopeSets = { enterprise: new Set([value.enterprise.id]), organization: organizationIds, repository: repositoryIds, costCenter: costCenterIds, user: userIds };
    if (!scopeSets[budget.scopeType]?.has(budget.scopeId)) return `Budget ${budget.id} references unknown ${scopeLabels[budget.scopeType] || budget.scopeType} ${budget.scopeId}.`;
  }
  for (const event of value.events) {
    if (!userIds.has(event.userId)) return `Event ${event.id} references unknown user ${event.userId}.`;
    if (!productIds.has(event.productId)) return `Event ${event.id} references unknown product ${event.productId}.`;
    if (event.repositoryId && !repositoryIds.has(event.repositoryId)) return `Event ${event.id} references unknown repository ${event.repositoryId}.`;
  }
  return null;
}

export function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
