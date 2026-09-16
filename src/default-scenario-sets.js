const AI_CREDIT_PRICE = 0.01;
const DEFAULT_THRESHOLDS = [75, 90, 100];

export const DEFAULT_SCENARIO_SET_ID = "enterprise";

export const defaultScenarioSetOptions = [
  { id: "enterprise", name: "Enterprise synthetic tenant", summary: "10 orgs, 20 cost centers, 200 licensed users" },
  { id: "compact", name: "Compact demo tenant", summary: "2 orgs, 2 cost centers, 2 licensed users" },
];

function createProducts() {
  return [
    { id: "ai-credits", name: "Copilot AI credits", unit: "AI credit", unitPrice: AI_CREDIT_PRICE, billingMode: "aiCredits" },
    { id: "actions", name: "Actions overage", unit: "minute", unitPrice: 0.008, billingMode: "metered" },
  ];
}

function baseEnterprise() {
  return { id: "ent-acme", name: "Acme Enterprise", currency: "USD", paidAiUsage: true, seatCreditPolicy: "prorated" };
}

function createCompactScenario() {
  const enterprise = baseEnterprise();
  return {
    version: 2,
    enterprise,
    organizations: [
      { id: "org-platform", name: "Platform Engineering" },
      { id: "org-product", name: "Product Delivery" },
    ],
    repositories: [
      { id: "repo-portal", name: "customer-portal", organizationId: "org-product" },
      { id: "repo-tools", name: "developer-tools", organizationId: "org-platform" },
    ],
    costCenters: [
      { id: "cc-ai", name: "AI Innovation", organizationIds: [], excludeFromEnterpriseBudget: false },
      { id: "cc-core", name: "Core Engineering", organizationIds: [], excludeFromEnterpriseBudget: false },
    ],
    users: [
      { id: "user-alice", name: "Alice", organizationIds: ["org-product"], licenseOrganizationId: "org-product", costCenterId: "cc-ai", licensePlan: "enterprise", licenseStartsAt: "2026-09-01", licenseEndsAt: null, licenseEndMode: null },
      { id: "user-bob", name: "Bob", organizationIds: ["org-platform"], licenseOrganizationId: "org-platform", costCenterId: "cc-core", licensePlan: "business", licenseStartsAt: "2026-09-01", licenseEndsAt: null, licenseEndMode: null },
    ],
    products: createProducts(),
    budgets: [
      { id: "ulb-universal", name: "Universal ULB", budgetKind: "user", userBudgetType: "universal", scopeType: "enterprise", scopeId: enterprise.id, productId: "ai-credits", amount: 50, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "ulb-ai-team", name: "AI team ULB", budgetKind: "user", userBudgetType: "costCenter", scopeType: "costCenter", scopeId: "cc-ai", productId: "ai-credits", amount: 35, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "ulb-alice", name: "Alice temporary ULB", budgetKind: "user", userBudgetType: "individual", scopeType: "user", scopeId: "user-alice", productId: "ai-credits", amount: 45, effectiveFrom: "2026-09-01", expiresAt: null, enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "metered-enterprise", name: "Enterprise AI overage", budgetKind: "metered", scopeType: "enterprise", scopeId: enterprise.id, productId: "ai-credits", amount: 100, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "metered-product-org", name: "Product org AI overage", budgetKind: "metered", scopeType: "organization", scopeId: "org-product", productId: "ai-credits", amount: 50, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds: DEFAULT_THRESHOLDS },
      { id: "metered-ai-team", name: "AI team overage", budgetKind: "metered", scopeType: "costCenter", scopeId: "cc-ai", productId: "ai-credits", amount: 30, effectiveFrom: "2026-09-10", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
    ],
    events: [],
    simulationDate: "2026-09-15",
  };
}

function createEnterpriseScenario() {
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
      const costCenter = userNumber % 14 === 0 || profile.prefix === "Engineer" && profile.index === 12 ? null : costCenters[index % costCenters.length].id;
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
  const enterprise = baseEnterprise();
  return {
    version: 2,
    enterprise,
    organizations,
    repositories,
    costCenters,
    users,
    products: createProducts(),
    budgets: [
      { id: "ulb-universal", name: "Universal ULB", budgetKind: "user", userBudgetType: "universal", scopeType: "enterprise", scopeId: enterprise.id, productId: "ai-credits", amount: 50, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "ulb-ai-team", name: "AI team ULB", budgetKind: "user", userBudgetType: "costCenter", scopeType: "costCenter", scopeId: "cc-ai", productId: "ai-credits", amount: 35, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "ulb-core-team", name: "Core engineering ULB", budgetKind: "user", userBudgetType: "costCenter", scopeType: "costCenter", scopeId: "cc-core", productId: "ai-credits", amount: 30, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "ulb-data-science", name: "Data science ULB", budgetKind: "user", userBudgetType: "costCenter", scopeType: "costCenter", scopeId: "cc-data-science", productId: "ai-credits", amount: 40, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "ulb-alice", name: "Alice temporary ULB", budgetKind: "user", userBudgetType: "individual", scopeType: "user", scopeId: "user-alice", productId: "ai-credits", amount: 45, effectiveFrom: "2026-09-01", expiresAt: null, enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "metered-enterprise", name: "Enterprise AI overage", budgetKind: "metered", scopeType: "enterprise", scopeId: enterprise.id, productId: "ai-credits", amount: 5000, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "metered-product-org", name: "Product org AI overage", budgetKind: "metered", scopeType: "organization", scopeId: "org-product", productId: "ai-credits", amount: 1250, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds: DEFAULT_THRESHOLDS },
      { id: "metered-data-org", name: "Data org AI overage", budgetKind: "metered", scopeType: "organization", scopeId: "org-data", productId: "ai-credits", amount: 1500, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds: DEFAULT_THRESHOLDS },
      { id: "metered-ai-team", name: "AI team overage", budgetKind: "metered", scopeType: "costCenter", scopeId: "cc-ai", productId: "ai-credits", amount: 1000, effectiveFrom: "2026-09-10", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "metered-core-team", name: "Core engineering overage", budgetKind: "metered", scopeType: "costCenter", scopeId: "cc-core", productId: "ai-credits", amount: 1000, effectiveFrom: "2026-09-01", enforcement: "hard", thresholds: DEFAULT_THRESHOLDS },
      { id: "metered-actions-enterprise", name: "Enterprise Actions overage", budgetKind: "metered", scopeType: "enterprise", scopeId: enterprise.id, productId: "actions", amount: 2500, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds: DEFAULT_THRESHOLDS },
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

const defaultScenarioFactories = {
  enterprise: createEnterpriseScenario,
  compact: createCompactScenario,
};

export function createScenarioFromDefaultSet(setId = DEFAULT_SCENARIO_SET_ID) {
  const factory = defaultScenarioFactories[setId] || defaultScenarioFactories[DEFAULT_SCENARIO_SET_ID];
  return structuredClone(factory());
}