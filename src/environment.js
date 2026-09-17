const environments = new Map();

const COLLECTIONS = {
  organizations: "organization",
  repositories: "repository",
  costCenters: "cost center",
  users: "user",
  products: "product",
  budgets: "budget",
};

function isFiniteNonNegative(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function uniqueIds(items, label) {
  if (!Array.isArray(items)) return `Missing ${label} array.`;
  const ids = items.map((item) => item?.id);
  if (ids.some((id) => !id)) return `Every ${label} item needs an id.`;
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  return duplicate ? `Duplicate ${label} id: ${duplicate}.` : null;
}

export function validateMaterializedScenario(value, { strictReferences = true } = {}) {
  if (!value || typeof value !== "object" || !value.enterprise || !value.simulationDate) return "Scenario requires enterprise and simulationDate.";
  for (const [collection, label] of Object.entries(COLLECTIONS)) {
    const error = uniqueIds(value[collection], label);
    if (error) return error;
  }
  if (!Array.isArray(value.events)) return "Missing events array.";

  const organizationIds = new Set(value.organizations.map((item) => item.id));
  const repositoryIds = new Set(value.repositories.map((item) => item.id));
  const costCenterIds = new Set(value.costCenters.map((item) => item.id));
  const userIds = new Set(value.users.map((item) => item.id));
  const productIds = new Set(value.products.map((item) => item.id));
  const scopeSets = {
    enterprise: new Set([value.enterprise.id]),
    organization: organizationIds,
    repository: repositoryIds,
    costCenter: costCenterIds,
    user: userIds,
  };

  for (const repository of value.repositories) {
    if (strictReferences && !organizationIds.has(repository.organizationId)) return `Repository ${repository.id} references unknown organization ${repository.organizationId}.`;
  }
  for (const costCenter of value.costCenters) {
    const unknownOrganization = (costCenter.organizationIds || []).find((id) => !organizationIds.has(id));
    if (strictReferences && unknownOrganization) return `Cost center ${costCenter.id} references unknown organization ${unknownOrganization}.`;
  }
  for (const user of value.users) {
    if (!Array.isArray(user.organizationIds) || user.organizationIds.length === 0) return `User ${user.id} must belong to at least one organization.`;
    if (strictReferences && !organizationIds.has(user.licenseOrganizationId)) return `User ${user.id} references unknown license organization ${user.licenseOrganizationId}.`;
    if (!user.organizationIds.includes(user.licenseOrganizationId)) return `User ${user.id} license organization must be one of organizationIds.`;
    const unknownOrganization = user.organizationIds.find((id) => !organizationIds.has(id));
    if (strictReferences && unknownOrganization) return `User ${user.id} references unknown organization ${unknownOrganization}.`;
    if (user.costCenterId && strictReferences && !costCenterIds.has(user.costCenterId)) return `User ${user.id} references unknown cost center ${user.costCenterId}.`;
    if (!["business", "enterprise"].includes(user.licensePlan)) return `User ${user.id} has unsupported license plan ${user.licensePlan}.`;
    if (user.licenseStartsAt && user.licenseEndsAt && user.licenseStartsAt > user.licenseEndsAt) return `User ${user.id} has an invalid license date range.`;
    if (user.licenseEndMode && !user.licenseEndsAt) return `User ${user.id} has licenseEndMode without licenseEndsAt.`;
  }
  for (const budget of value.budgets) {
    if (strictReferences && !productIds.has(budget.productId)) return `Budget ${budget.id} references unknown product ${budget.productId}.`;
    if (strictReferences && !scopeSets[budget.scopeType]?.has(budget.scopeId)) return `Budget ${budget.id} references unknown ${budget.scopeType} ${budget.scopeId}.`;
    if (!isFiniteNonNegative(budget.amount)) return `Budget ${budget.id} amount must be finite and non-negative.`;
    if (budget.thresholds !== undefined) {
      if (!Array.isArray(budget.thresholds) || budget.thresholds.some((threshold) => !isFiniteNonNegative(threshold))) return `Budget ${budget.id} thresholds must be finite and non-negative.`;
      if (new Set(budget.thresholds).size !== budget.thresholds.length) return `Budget ${budget.id} thresholds must be unique.`;
      const sorted = [...budget.thresholds].sort((a, b) => a - b);
      if (sorted.some((threshold, index) => threshold !== budget.thresholds[index])) return `Budget ${budget.id} thresholds must be sorted.`;
    }
    if (budget.effectiveFrom && budget.expiresAt && budget.effectiveFrom > budget.expiresAt) return `Budget ${budget.id} has an invalid effective date range.`;
    if (budget.budgetKind === "user" && (budget.productId !== "ai-credits" || budget.enforcement !== "hard")) return `User budget ${budget.id} must target ai-credits with hard enforcement.`;
    if (budget.budgetKind === "user" && !["universal", "costCenter", "individual"].includes(budget.userBudgetType)) return `User budget ${budget.id} has an invalid userBudgetType.`;
  }
  for (const event of value.events) {
    if (strictReferences && !userIds.has(event.userId)) return `Event ${event.id} references unknown user ${event.userId}.`;
    if (strictReferences && !productIds.has(event.productId)) return `Event ${event.id} references unknown product ${event.productId}.`;
    if (event.repositoryId && strictReferences && !repositoryIds.has(event.repositoryId)) return `Event ${event.id} references unknown repository ${event.repositoryId}.`;
    if (!Number.isFinite(Number(event.quantity)) || Number(event.quantity) <= 0) return `Event ${event.id} quantity must be positive and finite.`;
  }
  return null;
}

export function validateEnvironment(environment) {
  if (!environment || typeof environment !== "object" || environment.version !== 1 || !environment.id) return "Environment must use version 1 and require an id.";
  if (!environment.source || typeof environment.source !== "object") return "Environment requires provenance in source.";
  if (!environment.source.kind || !environment.source.createdAt || !Array.isArray(environment.source.assumptions) || !Array.isArray(environment.source.omittedCapabilities)) {
    return "Environment provenance requires kind, createdAt, assumptions, and omittedCapabilities.";
  }
  if (environment.events !== undefined || environment.simulationDate !== undefined) return "Environment must contain topology only; events and simulationDate belong to scenarios.";
  const scenario = { ...structuredClone(environment), version: 2, simulationDate: environment.source.createdAt.slice(0, 10), events: [], enterpriseTeams: environment.enterpriseTeams || [] };
  delete scenario.source;
  delete scenario.name;
  delete scenario.summary;
  const error = validateMaterializedScenario(scenario);
  return error ? `Invalid environment: ${error}` : null;
}

export function registerEnvironment(environment) {
  const error = validateEnvironment(environment);
  if (error) throw new Error(error);
  environments.set(environment.id, structuredClone(environment));
  return environment.id;
}

export function getEnvironment(environmentId) {
  const environment = environments.get(environmentId);
  return environment ? structuredClone(environment) : undefined;
}

export function listEnvironments() {
  return [...environments.keys()];
}
