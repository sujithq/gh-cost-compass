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
  const organizations = [
    { id: "org-platform", name: "Platform Engineering" },
    { id: "org-product", name: "Product Delivery" },
    { id: "org-data", name: "Data & AI" },
    { id: "org-security", name: "Security Engineering" },
    { id: "org-cloud", name: "Cloud Infrastructure" },
    { id: "org-mobile", name: "Mobile Experiences" },
    { id: "org-finance", name: "Finance Systems" },
    { id: "org-sales", name: "Sales Technology" },
    { id: "org-support", name: "Customer Support Platforms" },
    { id: "org-research", name: "Research Labs" },
  ];
  const repositories = organizations.flatMap((organization, index) => {
    const defaults = {
      "org-product": ["customer-portal", "commerce-api"],
      "org-platform": ["developer-tools", "internal-platform"],
    }[organization.id] || [`${organization.id.replace("org-", "")}-services`, `${organization.id.replace("org-", "")}-ops`];
    return defaults.map((name, repoIndex) => ({ id: index === 0 && repoIndex === 0 ? "repo-tools" : index === 1 && repoIndex === 0 ? "repo-portal" : `repo-${name}`, name, organizationId: organization.id }));
  });
  const costCenterNames = [
    "AI Innovation", "Core Engineering", "Developer Experience", "Data Science", "Product Management", "Security Operations", "Cloud Platform", "Mobile Engineering", "Finance Automation", "Revenue Systems",
    "Support Engineering", "Research Prototypes", "Enterprise Architecture", "Quality Engineering", "SRE Operations", "Partner Integrations", "Analytics Enablement", "Compliance Technology", "Customer Success", "Internal Tools",
  ];
  const costCenters = costCenterNames.map((name, index) => ({
    id: index === 0 ? "cc-ai" : index === 1 ? "cc-core" : `cc-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    name,
    organizationIds: [],
    excludeFromEnterpriseBudget: false,
  }));
  const roleProfiles = [
    { role: "Software Engineer", prefix: "Engineer", weight: 74, plan: "enterprise" },
    { role: "Data Scientist", prefix: "Scientist", weight: 34, plan: "enterprise" },
    { role: "Project Manager", prefix: "Manager", weight: 26, plan: "business" },
    { role: "Security Engineer", prefix: "Security", weight: 18, plan: "enterprise" },
    { role: "Site Reliability Engineer", prefix: "SRE", weight: 18, plan: "enterprise" },
    { role: "Business Analyst", prefix: "Analyst", weight: 16, plan: "business" },
    { role: "UX Designer", prefix: "Designer", weight: 14, plan: "business" },
  ];
  const generatedUsers = roleProfiles.flatMap((profile) => Array.from({ length: profile.weight }, (_, index) => ({ ...profile, index: index + 1 })));
  const users = [
    { id: "user-alice", name: "Alice Chen - Software Engineer", role: "Software Engineer", organizationIds: ["org-product"], licenseOrganizationId: "org-product", costCenterId: "cc-ai", licensePlan: "enterprise", licenseStartsAt: "2026-09-01", licenseEndsAt: null, licenseEndMode: null },
    { id: "user-bob", name: "Bob Singh - Project Manager", role: "Project Manager", organizationIds: ["org-platform"], licenseOrganizationId: "org-platform", costCenterId: "cc-core", licensePlan: "business", licenseStartsAt: "2026-09-01", licenseEndsAt: null, licenseEndMode: null },
    ...generatedUsers.slice(2).map((profile, index) => {
      const userNumber = index + 3;
      const organization = organizations[index % organizations.length];
      const secondaryOrganization = organizations[(index + 3) % organizations.length];
      const hasSecondaryOrg = userNumber % 17 === 0;
      const costCenter = userNumber % 14 === 0 ? null : costCenters[index % costCenters.length].id;
      const slug = `${profile.prefix}-${String(profile.index).padStart(3, "0")}`.toLowerCase();
      return {
        id: `user-${slug}`,
        name: `${profile.prefix} ${String(profile.index).padStart(3, "0")} - ${profile.role}`,
        role: profile.role,
        organizationIds: hasSecondaryOrg ? [organization.id, secondaryOrganization.id] : [organization.id],
        licenseOrganizationId: organization.id,
        costCenterId: costCenter,
        licensePlan: profile.plan,
        licenseStartsAt: "2026-09-01",
        licenseEndsAt: null,
        licenseEndMode: null,
      };
    }),
  ];
  const enterpriseId = "ent-acme";
  const thresholds = [75, 90, 100];
  return {
    version: 2,
    enterprise: { id: enterpriseId, name: "Acme Enterprise", currency: "USD", paidAiUsage: true, seatCreditPolicy: "prorated" },
    organizations,
    repositories,
    costCenters,
    users,
    products: [
      { id: "ai-credits", name: "Copilot AI credits", unit: "AI credit", unitPrice: AI_CREDIT_PRICE, billingMode: "aiCredits" },
      { id: "actions", name: "Actions overage", unit: "minute", unitPrice: 0.008, billingMode: "metered" },
    ],
    budgets: [
      { id: "ulb-universal", name: "Universal ULB", budgetKind: "user", userBudgetType: "universal", scopeType: "enterprise", scopeId: enterpriseId, productId: "ai-credits", amount: 50, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds },
      { id: "ulb-ai-team", name: "AI team ULB", budgetKind: "user", userBudgetType: "costCenter", scopeType: "costCenter", scopeId: "cc-ai", productId: "ai-credits", amount: 35, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds },
      { id: "ulb-core-team", name: "Core engineering ULB", budgetKind: "user", userBudgetType: "costCenter", scopeType: "costCenter", scopeId: "cc-core", productId: "ai-credits", amount: 30, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds },
      { id: "ulb-data-science", name: "Data science ULB", budgetKind: "user", userBudgetType: "costCenter", scopeType: "costCenter", scopeId: "cc-data-science", productId: "ai-credits", amount: 40, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds },
      { id: "ulb-alice", name: "Alice temporary ULB", budgetKind: "user", userBudgetType: "individual", scopeType: "user", scopeId: "user-alice", productId: "ai-credits", amount: 45, effectiveFrom: "2026-09-01", expiresAt: null, enforcement: "hard", thresholds },
      { id: "metered-enterprise", name: "Enterprise AI overage", budgetKind: "metered", scopeType: "enterprise", scopeId: enterpriseId, productId: "ai-credits", amount: 5000, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds },
      { id: "metered-product-org", name: "Product org AI overage", budgetKind: "metered", scopeType: "organization", scopeId: "org-product", productId: "ai-credits", amount: 1250, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds },
      { id: "metered-data-org", name: "Data org AI overage", budgetKind: "metered", scopeType: "organization", scopeId: "org-data", productId: "ai-credits", amount: 1500, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds },
      { id: "metered-ai-team", name: "AI team overage", budgetKind: "metered", scopeType: "costCenter", scopeId: "cc-ai", productId: "ai-credits", amount: 1000, effectiveFrom: "2026-09-10", enforcement: "hard", thresholds },
      { id: "metered-core-team", name: "Core engineering overage", budgetKind: "metered", scopeType: "costCenter", scopeId: "cc-core", productId: "ai-credits", amount: 1000, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds },
      { id: "metered-actions-enterprise", name: "Enterprise Actions overage", budgetKind: "metered", scopeType: "enterprise", scopeId: enterpriseId, productId: "actions", amount: 2500, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds },
    ],
    events: [
      { id: "evt-ai-alice", date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 1200 },
      { id: "evt-ai-bob", date: "2026-09-15", userId: "user-bob", repositoryId: "repo-tools", productId: "ai-credits", quantity: 850 },
      { id: "evt-ai-data", date: "2026-09-16", userId: "user-scientist-003", repositoryId: "repo-data-services", productId: "ai-credits", quantity: 1800 },
      { id: "evt-ai-unassigned", date: "2026-09-16", userId: "user-engineer-012", repositoryId: "repo-cloud-services", productId: "ai-credits", quantity: 650 },
      { id: "evt-actions-platform", date: "2026-09-16", userId: "user-engineer-004", repositoryId: "repo-tools", productId: "actions", quantity: 2400 },
    ],
    simulationDate: "2026-09-15",
  };
}

function isActive(budget, date) {
  return date >= budget.effectiveFrom && (!budget.expiresAt || date <= budget.expiresAt);
}

export function costCenterForUser(scenario, user) {
  return scenario.costCenters.find((item) => item.id === user?.costCenterId)
    || scenario.costCenters.find((item) => (item.organizationIds || []).includes(user?.licenseOrganizationId));
}

function matchesScope(budget, event, scenario, product) {
  const user = scenario.users.find((item) => item.id === event.userId);
  const repo = scenario.repositories.find((item) => item.id === event.repositoryId);
  const costCenter = costCenterForUser(scenario, user);
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

function includedPoolFor(scenario, atDate = scenario.simulationDate) {
  return scenario.users.reduce((total, user) => total + userPoolContribution(user, atDate, scenario), 0);
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
  const states = new Map();
  const pools = new Map();
  const results = [];
  const alerts = [];
  const orderedEvents = scenario.events.map((event, index) => ({ ...event, _order: index })).filter((event) => event.date <= scenario.simulationDate).sort((a, b) => a.date.localeCompare(b.date) || a._order - b._order);

  for (const event of orderedEvents) {
    const product = scenario.products.find((item) => item.id === event.productId);
    const user = scenario.users.find((item) => item.id === event.userId);
    const quantity = Number(event.quantity);
    const period = monthKey(event.date);
    const poolBefore = pools.get(period) || 0;
    const poolTotal = includedPoolFor(scenario, event.date);
    const isAi = product?.billingMode === "aiCredits";
    const userAccessBlocked = user && !isSeatActiveForDate(user, event.date);
    let blockingReason = userAccessBlocked ? `${user.name} does not have an active Copilot seat on ${event.date}` : null;
    const includedQuantity = isAi ? Math.min(quantity, Math.max(0, poolTotal - poolBefore)) : 0;
    const meteredQuantity = isAi ? quantity - includedQuantity : quantity;
    const billedCost = meteredQuantity * Number(product?.unitPrice || 0);
    const grossAiValue = isAi ? quantity * AI_CREDIT_PRICE : 0;
    const userBudget = isAi && user ? selectUserBudget(scenario, user, event.date) : null;
    const userBudgetKey = userBudget ? `${userBudget.id}:${user.id}:${period}` : null;
    const meteredBudgets = scenario.budgets.filter((budget) => budget.budgetKind === "metered" && matchesScope(budget, event, scenario, product));

    if (!blockingReason && userBudget && stateFor(states, userBudgetKey).spent + grossAiValue > Number(userBudget.amount)) blockingReason = `${userBudget.name} user-level hard stop would be exceeded`;
    if (!blockingReason && isAi && meteredQuantity > 0 && !scenario.enterprise.paidAiUsage) blockingReason = "AI credits paid usage policy is disabled and the shared pool is exhausted";
    if (!blockingReason) {
      const blocker = meteredBudgets.find((budget) => (budget.enforcement === "hard" || (isAi && Number(budget.amount) === 0)) && stateFor(states, `${budget.id}:${period}`).spent + billedCost > Number(budget.amount));
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
  const poolTotal = includedPoolFor(scenario, scenario.simulationDate);
  const consumed = pools.get(selectedPeriod) || 0;
  const meteredCost = results.filter((item) => item.status === "accepted" && item.date.startsWith(selectedPeriod)).reduce((sum, item) => sum + item.cost, 0);

  return { results, alerts, budgetStates, period: selectedPeriod, pool: { total: poolTotal, consumed, remaining: Math.max(0, poolTotal - consumed), percent: poolTotal ? consumed / poolTotal * 100 : 100, meteredCost } };
}

export function validateScenario(value) {
  const requiredArrays = ["organizations", "repositories", "costCenters", "users", "products", "budgets", "events"];
  if (!value || typeof value !== "object" || value.version !== 2 || !value.enterprise || !value.simulationDate) return "This file is not a version 2 AI-credit scenario.";
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
