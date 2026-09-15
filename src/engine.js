export const scopeLabels = {
  enterprise: "Enterprise",
  organization: "Organization",
  repository: "Repository",
  costCenter: "Cost center",
  user: "Individual user",
};

const AI_CREDIT_PRICE = 0.01;
const INCLUDED_CREDITS = { business: 1900, enterprise: 3900 };

export function monthKey(date) {
  return String(date).slice(0, 7);
}

export function money(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value || 0);
}

export function createDefaultScenario() {
  return {
    version: 2,
    enterprise: { id: "ent-acme", name: "Acme Enterprise", currency: "USD", paidAiUsage: true },
    organizations: [
      { id: "org-platform", name: "Platform Engineering" },
      { id: "org-product", name: "Product Delivery" },
    ],
    repositories: [
      { id: "repo-portal", name: "customer-portal", organizationId: "org-product" },
      { id: "repo-tools", name: "developer-tools", organizationId: "org-platform" },
    ],
    costCenters: [
      { id: "cc-ai", name: "AI Innovation", excludeFromEnterpriseBudget: false },
      { id: "cc-core", name: "Core Engineering", excludeFromEnterpriseBudget: false },
    ],
    users: [
      { id: "user-alice", name: "Alice", organizationIds: ["org-product"], licenseOrganizationId: "org-product", costCenterId: "cc-ai", licensePlan: "enterprise" },
      { id: "user-bob", name: "Bob", organizationIds: ["org-platform"], licenseOrganizationId: "org-platform", costCenterId: "cc-core", licensePlan: "business" },
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

function isActive(budget, date) {
  return date >= budget.effectiveFrom && (!budget.expiresAt || date <= budget.expiresAt);
}

function matchesScope(budget, event, scenario, product) {
  const user = scenario.users.find((item) => item.id === event.userId);
  const repo = scenario.repositories.find((item) => item.id === event.repositoryId);
  if (!user || !isActive(budget, event.date) || budget.productId !== product?.id) return false;
  switch (budget.scopeType) {
    case "enterprise": {
      const costCenter = scenario.costCenters.find((item) => item.id === user.costCenterId);
      return budget.scopeId === scenario.enterprise.id && !(product.billingMode === "aiCredits" && costCenter?.excludeFromEnterpriseBudget);
    }
    case "organization": return product.billingMode === "aiCredits" ? !user.costCenterId && user.licenseOrganizationId === budget.scopeId : user.organizationIds.includes(budget.scopeId) || repo?.organizationId === budget.scopeId;
    case "repository": return event.repositoryId === budget.scopeId;
    case "costCenter": return user.costCenterId === budget.scopeId;
    case "user": return event.userId === budget.scopeId;
    default: return false;
  }
}

function selectUserBudget(scenario, user, date) {
  const active = scenario.budgets.filter((budget) => budget.budgetKind === "user" && budget.productId === "ai-credits" && isActive(budget, date));
  return active.find((budget) => budget.userBudgetType === "individual" && budget.scopeId === user.id)
    || active.find((budget) => budget.userBudgetType === "costCenter" && budget.scopeId === user.costCenterId)
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
    alerts.push({ id: `${event.id}-${key}-${threshold}`, eventId: event.id, date: event.date, budgetId: budget.id, threshold, message: `${budget.name}${userId ? ` (${result.userName})` : ""} reached ${threshold}%`, reliability: budget.budgetKind === "user" ? "User-level alert delivery is not guaranteed by GitHub" : "UI and email" });
  }
}

function includedPoolFor(scenario) {
  return scenario.users.reduce((total, user) => total + (INCLUDED_CREDITS[user.licensePlan] || 0), 0);
}

export function describeScope(scenario, budget) {
  if (budget.userBudgetType === "universal") return "All licensed users";
  const collections = { enterprise: [scenario.enterprise], organization: scenario.organizations, repository: scenario.repositories, costCenter: scenario.costCenters, user: scenario.users };
  return collections[budget.scopeType]?.find((item) => item.id === budget.scopeId)?.name || budget.scopeId;
}

export function replayScenario(scenario) {
  const states = new Map();
  const pools = new Map();
  const results = [];
  const alerts = [];
  const poolTotal = includedPoolFor(scenario);
  const orderedEvents = scenario.events.map((event, index) => ({ ...event, _order: index })).filter((event) => event.date <= scenario.simulationDate).sort((a, b) => a.date.localeCompare(b.date) || a._order - b._order);

  for (const event of orderedEvents) {
    const product = scenario.products.find((item) => item.id === event.productId);
    const user = scenario.users.find((item) => item.id === event.userId);
    const quantity = Number(event.quantity);
    const period = monthKey(event.date);
    const poolBefore = pools.get(period) || 0;
    const isAi = product?.billingMode === "aiCredits";
    const includedQuantity = isAi ? Math.min(quantity, Math.max(0, poolTotal - poolBefore)) : 0;
    const meteredQuantity = isAi ? quantity - includedQuantity : quantity;
    const billedCost = meteredQuantity * Number(product?.unitPrice || 0);
    const grossAiValue = isAi ? quantity * AI_CREDIT_PRICE : 0;
    const userBudget = isAi && user ? selectUserBudget(scenario, user, event.date) : null;
    const userBudgetKey = userBudget ? `${userBudget.id}:${user.id}:${period}` : null;
    const meteredBudgets = scenario.budgets.filter((budget) => budget.budgetKind === "metered" && matchesScope(budget, event, scenario, product));

    let blockingReason = null;
    if (userBudget && stateFor(states, userBudgetKey).spent + grossAiValue > Number(userBudget.amount)) blockingReason = `${userBudget.name} user-level hard stop would be exceeded`;
    if (!blockingReason && isAi && meteredQuantity > 0 && !scenario.enterprise.paidAiUsage) blockingReason = "AI credits paid usage policy is disabled and the shared pool is exhausted";
    if (!blockingReason) {
      const blocker = meteredBudgets.find((budget) => budget.enforcement === "hard" && stateFor(states, `${budget.id}:${period}`).spent + billedCost > Number(budget.amount));
      if (blocker) blockingReason = `${blocker.name} metered-spend hard stop would be exceeded`;
    }

    const result = {
      eventId: event.id, date: event.date, userName: user?.name || "Unknown user", productName: product?.name || "Unknown product",
      quantity, includedQuantity, meteredQuantity, cost: billedCost, grossAiValue, poolBefore, poolAfter: blockingReason ? poolBefore : poolBefore + includedQuantity,
      status: blockingReason ? "blocked" : "accepted", reason: blockingReason || (isAi && billedCost === 0 ? "Usage accepted from the shared AI-credit pool" : "Usage accepted with metered charges"), affectedBudgets: [],
    };

    if (!blockingReason) {
      if (isAi) pools.set(period, poolBefore + includedQuantity);
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
  const consumed = pools.get(selectedPeriod) || 0;
  const meteredCost = results.filter((item) => item.status === "accepted" && item.date.startsWith(selectedPeriod)).reduce((sum, item) => sum + item.cost, 0);

  return { results, alerts, budgetStates, period: selectedPeriod, pool: { total: poolTotal, consumed, remaining: Math.max(0, poolTotal - consumed), percent: poolTotal ? consumed / poolTotal * 100 : 100, meteredCost } };
}

export function validateScenario(value) {
  const requiredArrays = ["organizations", "repositories", "costCenters", "users", "products", "budgets", "events"];
  if (!value || typeof value !== "object" || value.version !== 2 || !value.enterprise || !value.simulationDate) return "This file is not a version 2 AI-credit scenario.";
  const missing = requiredArrays.find((key) => !Array.isArray(value[key]));
  return missing ? `Missing ${missing} array.` : null;
}

export function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
