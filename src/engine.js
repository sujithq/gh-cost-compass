export const scopeLabels = {
  enterprise: "Enterprise",
  organization: "Organization",
  repository: "Repository",
  costCenter: "Cost center",
  user: "User",
};

export function monthKey(date) {
  return String(date).slice(0, 7);
}

export function money(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value || 0);
}

export function createDefaultScenario() {
  return {
    version: 1,
    enterprise: { id: "ent-acme", name: "Acme Enterprise", currency: "USD" },
    organizations: [
      { id: "org-platform", name: "Platform Engineering" },
      { id: "org-product", name: "Product Delivery" },
    ],
    repositories: [
      { id: "repo-portal", name: "customer-portal", organizationId: "org-product" },
      { id: "repo-tools", name: "developer-tools", organizationId: "org-platform" },
    ],
    costCenters: [
      { id: "cc-ai", name: "AI Innovation" },
      { id: "cc-core", name: "Core Engineering" },
    ],
    users: [
      { id: "user-alice", name: "Alice", organizationIds: ["org-product"], costCenterId: "cc-ai" },
      { id: "user-bob", name: "Bob", organizationIds: ["org-platform"], costCenterId: "cc-core" },
    ],
    products: [
      { id: "aic", name: "AIC / premium request", unit: "request", unitPrice: 0.10 },
      { id: "actions", name: "Actions overage", unit: "minute", unitPrice: 0.008 },
    ],
    budgets: [
      { id: "budget-ent", name: "Enterprise monthly", scopeType: "enterprise", scopeId: "ent-acme", amount: 1000, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds: [50, 75, 90, 100] },
      { id: "budget-product", name: "Product Delivery", scopeType: "organization", scopeId: "org-product", amount: 500, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds: [50, 75, 90, 100] },
      { id: "budget-ai", name: "AI Innovation", scopeType: "costCenter", scopeId: "cc-ai", amount: 250, effectiveFrom: "2026-09-10", enforcement: "hard", thresholds: [50, 75, 90, 100] },
      { id: "budget-alice", name: "Alice allowance", scopeType: "user", scopeId: "user-alice", amount: 100, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds: [75, 90, 100] },
    ],
    events: [],
    simulationDate: "2026-09-15",
  };
}

function appliesToEvent(budget, event, scenario) {
  const user = scenario.users.find((item) => item.id === event.userId);
  const repo = scenario.repositories.find((item) => item.id === event.repositoryId);
  if (!user || event.date < budget.effectiveFrom) return false;
  switch (budget.scopeType) {
    case "enterprise": return budget.scopeId === scenario.enterprise.id;
    case "organization": return user.organizationIds.includes(budget.scopeId) || repo?.organizationId === budget.scopeId;
    case "repository": return event.repositoryId === budget.scopeId;
    case "costCenter": return user.costCenterId === budget.scopeId;
    case "user": return event.userId === budget.scopeId;
    default: return false;
  }
}

export function describeScope(scenario, budget) {
  const collections = {
    enterprise: [scenario.enterprise], organization: scenario.organizations,
    repository: scenario.repositories, costCenter: scenario.costCenters, user: scenario.users,
  };
  return collections[budget.scopeType]?.find((item) => item.id === budget.scopeId)?.name || budget.scopeId;
}

export function replayScenario(scenario) {
  const states = new Map();
  const results = [];
  const alerts = [];
  const orderedEvents = scenario.events
    .map((event, index) => ({ ...event, _order: index }))
    .filter((event) => event.date <= scenario.simulationDate)
    .sort((a, b) => a.date.localeCompare(b.date) || a._order - b._order);

  for (const event of orderedEvents) {
    const product = scenario.products.find((item) => item.id === event.productId);
    const user = scenario.users.find((item) => item.id === event.userId);
    const cost = product ? Number(event.quantity) * Number(product.unitPrice) : 0;
    const applicable = scenario.budgets.filter((budget) => appliesToEvent(budget, event, scenario));
    const period = monthKey(event.date);
    const blocking = applicable.find((budget) => {
      const key = `${budget.id}:${period}`;
      const spent = states.get(key)?.spent || 0;
      return budget.enforcement === "hard" && spent + cost > Number(budget.amount);
    });

    const result = {
      eventId: event.id, date: event.date, userName: user?.name || "Unknown user",
      productName: product?.name || "Unknown product", quantity: Number(event.quantity), cost,
      status: blocking ? "blocked" : "accepted", reason: blocking ? `${blocking.name} hard limit would be exceeded` : "Usage accepted",
      affectedBudgets: [],
    };

    if (!blocking) {
      for (const budget of applicable) {
        const key = `${budget.id}:${period}`;
        const previous = states.get(key) || { spent: 0, triggered: [] };
        const nextSpent = previous.spent + cost;
        const previousPercent = Number(budget.amount) ? previous.spent / Number(budget.amount) * 100 : 100;
        const nextPercent = Number(budget.amount) ? nextSpent / Number(budget.amount) * 100 : 100;
        const newlyTriggered = (budget.thresholds || []).filter((threshold) => previousPercent < threshold && nextPercent >= threshold && !previous.triggered.includes(threshold));
        const next = { spent: nextSpent, triggered: [...previous.triggered, ...newlyTriggered] };
        states.set(key, next);
        result.affectedBudgets.push({ budgetId: budget.id, before: previous.spent, after: nextSpent, percent: nextPercent });
        for (const threshold of newlyTriggered) {
          alerts.push({ id: `${event.id}-${budget.id}-${threshold}`, eventId: event.id, date: event.date, budgetId: budget.id, threshold, message: `${budget.name} reached ${threshold}%` });
        }
      }
    }
    results.push(result);
  }

  const selectedPeriod = monthKey(scenario.simulationDate);
  const budgetStates = scenario.budgets.map((budget) => {
    const state = states.get(`${budget.id}:${selectedPeriod}`) || { spent: 0, triggered: [] };
    const amount = Number(budget.amount);
    return { ...budget, spent: state.spent, remaining: Math.max(0, amount - state.spent), percent: amount ? state.spent / amount * 100 : 100, triggered: state.triggered };
  });

  return { results, alerts, budgetStates, period: selectedPeriod };
}

export function validateScenario(value) {
  const requiredArrays = ["organizations", "repositories", "costCenters", "users", "products", "budgets", "events"];
  if (!value || typeof value !== "object" || !value.enterprise || !value.simulationDate) return "Missing enterprise or simulation date.";
  const missing = requiredArrays.find((key) => !Array.isArray(value[key]));
  return missing ? `Missing ${missing} array.` : null;
}

export function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
