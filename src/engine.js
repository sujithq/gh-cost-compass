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

export function createDefaultScenario() {
  return {
    version: 2,
    enterprise: { id: "ent-acme", name: "Acme Enterprise", currency: "USD", paidAiUsage: true, seatCreditPolicy: "prorated" },
    organizations: [
      { id: "org-platform", name: "Platform Engineering" },
      { id: "org-product", name: "Product Delivery" },
    ],
    repositories: [
      { id: "repo-portal", name: "customer-portal", organizationId: "org-product" },
      { id: "repo-tools", name: "developer-tools", organizationId: "org-platform" },
    ],
    enterpriseTeams: [
      { id: "team-ai", name: "AI Platform Team", userIds: ["user-alice"] },
      { id: "team-core", name: "Core Engineering Team", userIds: ["user-bob"] },
    ],
    costCenters: [
      { id: "cc-ai", name: "AI Innovation", organizationIds: [], repositoryIds: [], userIds: [], enterpriseTeamIds: [], aiCreditPoolEnabled: false, aiCreditPoolCapMode: "allowOverage", excludeFromEnterpriseBudget: false },
      { id: "cc-core", name: "Core Engineering", organizationIds: [], repositoryIds: [], userIds: [], enterpriseTeamIds: [], aiCreditPoolEnabled: false, aiCreditPoolCapMode: "allowOverage", excludeFromEnterpriseBudget: false },
    ],
    users: [
      { id: "user-alice", name: "Alice", organizationIds: ["org-product"], licenseOrganizationId: "org-product", costCenterId: "cc-ai", licensePlan: "enterprise", licenseStartsAt: "2026-09-01", licenseEndsAt: null, licenseEndMode: null },
      { id: "user-bob", name: "Bob", organizationIds: ["org-platform"], licenseOrganizationId: "org-platform", costCenterId: "cc-core", licensePlan: "business", licenseStartsAt: "2026-09-01", licenseEndsAt: null, licenseEndMode: null },
    ],
    products: [
      { id: "ai-credits", name: "Copilot AI credits", unit: "AI credit", unitPrice: AI_CREDIT_PRICE, billingMode: "aiCredits" },
      { id: "actions", name: "Actions overage", unit: "minute", unitPrice: 0.008, billingMode: "metered" },
    ],
    budgets: [
      { id: "ulb-universal", name: "Universal ULB", budgetKind: "user", userBudgetType: "universal", scopeType: "enterprise", scopeId: "ent-acme", productId: "ai-credits", amount: 50, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: [75, 90, 100] },
      { id: "ulb-ai-team", name: "AI team ULB", budgetKind: "user", userBudgetType: "costCenter", scopeType: "costCenter", scopeId: "cc-ai", productId: "ai-credits", amount: 35, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: [75, 90, 100] },
      { id: "ulb-alice", name: "Alice temporary ULB", budgetKind: "user", userBudgetType: "individual", scopeType: "user", scopeId: "user-alice", productId: "ai-credits", amount: 45, effectiveFrom: "2026-09-01", expiresAt: null, enforcement: "hard", thresholds: [75, 90, 100] },
      { id: "metered-enterprise", name: "Enterprise AI overage", budgetKind: "metered", scopeType: "enterprise", scopeId: "ent-acme", productId: "ai-credits", amount: 100, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: [75, 90, 100] },
      { id: "metered-product-org", name: "Product org AI overage", budgetKind: "metered", scopeType: "organization", scopeId: "org-product", productId: "ai-credits", amount: 50, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds: [75, 90, 100] },
      { id: "metered-ai-team", name: "AI team overage", budgetKind: "metered", scopeType: "costCenter", scopeId: "cc-ai", productId: "ai-credits", amount: 30, effectiveFrom: "2026-09-10", enforcement: "hard", thresholds: [75, 90, 100] },
    ],
    events: [],
    simulationDate: "2026-09-15",
  };
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
    const includedQuantity = isAi ? Math.min(quantity, Math.max(0, poolTotal - poolBefore)) : 0;
    const meteredQuantity = isAi ? quantity - includedQuantity : quantity;
    const billedCost = meteredQuantity * Number(product?.unitPrice || 0);
    const grossAiValue = isAi ? quantity * AI_CREDIT_PRICE : 0;
    const userBudget = isAi && user ? selectUserBudget(effectiveScenario, user, event.date) : null;
    const userBudgetKey = userBudget ? `${userBudget.id}:${user.id}:${period}` : null;
    const meteredBudgets = effectiveScenario.budgets.filter((budget) => budget.budgetKind === "metered" && matchesScope(budget, event, effectiveScenario, product));

    if (!blockingReason && userBudget && stateFor(states, userBudgetKey).spent + grossAiValue > Number(userBudget.amount)) blockingReason = `${userBudget.name} user-level hard stop would be exceeded`;
    if (!blockingReason && costCenterPoolEnabled && meteredQuantity > 0 && eventCostCenter.aiCreditPoolCapMode === "block") blockingReason = `${eventCostCenter.name} AI credit pool cap would be exceeded`;
    if (!blockingReason && isAi && meteredQuantity > 0 && !effectiveScenario.enterprise.paidAiUsage) blockingReason = "AI credits paid usage policy is disabled and the shared pool is exhausted";
    if (!blockingReason) {
      const blocker = meteredBudgets.find((budget) => (budget.enforcement === "hard" || (isAi && Number(budget.amount) === 0)) && stateFor(states, `${budget.id}:${period}`).spent + billedCost > Number(budget.amount));
      if (blocker) blockingReason = `${blocker.name} metered-spend hard stop would be exceeded`;
    }

    const result = {
      eventId: event.id, date: event.date, userName: user?.name || "Unknown user", productName: product?.name || "Unknown product",
      quantity, includedQuantity, meteredQuantity, cost: billedCost, grossAiValue, poolBefore, poolAfter: blockingReason ? poolBefore : poolBefore + includedQuantity, poolTotal,
      poolStateKey, poolName: costCenterPoolEnabled ? `${eventCostCenter.name} included AI-credit pool` : "Enterprise shared included AI-credit pool", poolType: costCenterPoolEnabled ? "costCenter" : "enterprise",
      status: blockingReason ? "blocked" : "accepted", reason: blockingReason || (isAi && billedCost === 0 ? "Usage accepted from included AI credits" : "Usage accepted with metered charges"), affectedBudgets: [],
    };

    if (!blockingReason) {
      if (isAi && costCenterPoolEnabled) costCenterPools.set(poolStateKey, poolBefore + includedQuantity);
      else if (isAi) pools.set(period, poolBefore + includedQuantity);
      if (userBudget) updateBudget(states, alerts, result, userBudget, userBudgetKey, grossAiValue, event, user.id);
      for (const budget of meteredBudgets) updateBudget(states, alerts, result, budget, `${budget.id}:${period}`, billedCost, event);
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

  return { results, alerts, budgetStates, costCenterPoolStates, period: selectedPeriod, pool: { stateId: `enterprise:${selectedPeriod}`, total: poolTotal, consumed, remaining: Math.max(0, poolTotal - consumed), percent: poolTotal ? consumed / poolTotal * 100 : 100, meteredCost } };
}

export function validateScenario(value) {
  if (!value || typeof value !== "object" || value.version !== 2 || !value.enterprise || !value.simulationDate) return "This file is not a version 2 AI-credit scenario.";
  normalizeScenario(value);
  const requiredArrays = ["organizations", "repositories", "costCenters", "users", "products", "budgets", "events", "enterpriseTeams"];
  const missing = requiredArrays.find((key) => !Array.isArray(value[key]));
  return missing ? `Missing ${missing} array.` : null;
}

export function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
