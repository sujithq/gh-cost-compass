import { createHash } from "node:crypto";
import { validateEnvironment } from "./environment.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_RETRIES = 3;
const DEFAULT_PAGE_SIZE = 100;
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class GitHubExtractionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "GitHubExtractionError";
    Object.assign(this, details);
  }
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

function hashId(kind, value) {
  return `${kind}-${createHash("sha256").update(`${kind}:${value}`).digest("hex").slice(0, 12)}`;
}

function sourceId(value) {
  return value?.id ?? value?.node_id ?? value?.login ?? value?.slug ?? value?.name;
}

function sorted(items, key = (item) => item.id) {
  return [...items].sort((a, b) => String(key(a)).localeCompare(String(key(b))));
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] || headers[name.toLowerCase()];
}

function parseNextLink(link) {
  const match = String(link || "").split(",").map((part) => part.trim()).find((part) => /;\s*rel="next"/.test(part));
  return match?.match(/<([^>]+)>/)?.[1];
}

function backoffDelay(attempt, retryAfter, baseDelayMs) {
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) ? seconds * 1000 : baseDelayMs * (2 ** attempt);
}

export function createGitHubClient({
  token,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  maxRetries = DEFAULT_RETRIES,
  retryDelayMs = 100,
  pageSize = DEFAULT_PAGE_SIZE,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof fetchImpl !== "function") throw new GitHubExtractionError("A fetch implementation is required.");
  if (!token || typeof token !== "string") throw new GitHubExtractionError("A runtime token is required; credentials are never read from exported files.");

  async function request(path, { required = true, query = {} } = {}) {
    let url = path instanceof URL ? new URL(path) : new URL(path, apiBaseUrl);
    for (const [key, value] of Object.entries({ ...query, per_page: query.per_page || pageSize })) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
      });
      if (response.ok) return response;
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) {
        const message = `GitHub API request failed (${response.status}) for ${url.pathname}.`;
        if (required) throw new GitHubExtractionError(message, { status: response.status, path: url.pathname });
        return { ok: false, status: response.status, error: message };
      }
      await sleep(backoffDelay(attempt, headerValue(response.headers, "retry-after"), retryDelayMs));
    }
    throw new GitHubExtractionError(`GitHub API request exhausted retries for ${url.pathname}.`);
  }

  async function collect(path, options = {}) {
    const items = [];
    let next = new URL(path, apiBaseUrl);
    while (next) {
      const response = await request(next, options);
      if (!response.ok) return { items, error: response.error, status: response.status };
      const page = await response.json();
      if (!Array.isArray(page)) throw new GitHubExtractionError(`Expected an array from ${next.pathname}.`);
      items.push(...page);
      const nextLink = parseNextLink(headerValue(response.headers, "link"));
      if (nextLink) {
        next = new URL(nextLink);
      } else if (page.length >= (options.pageSize || pageSize)) {
        next = new URL(next);
        next.searchParams.set("page", Number(next.searchParams.get("page") || 1) + 1);
      } else {
        next = null;
      }
    }
    return { items };
  }

  return { request, collect };
}

function pathFor(template, values) {
  return template.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(values[key]));
}

export async function acquireGitHubEnterprise({
  client,
  enterprise,
  endpointTemplates = {},
} = {}) {
  if (!client?.request || !client?.collect) throw new GitHubExtractionError("A GitHub client is required.");
  if (!enterprise) throw new GitHubExtractionError("An enterprise slug is required.");

  const templates = {
    enterprise: "/enterprises/{enterprise}",
    organizations: "/enterprises/{enterprise}/organizations",
    repositories: "/orgs/{organization}/repos",
    memberships: "/orgs/{organization}/members",
    seats: null,
    organizationSeats: "/orgs/{organization}/copilot/billing/seats",
    teams: "/enterprises/{enterprise}/teams",
    budgets: null,
    ...endpointTemplates,
  };
  const failures = [];
  const data = { enterprise: null, organizations: [], repositories: [], memberships: [], seats: [], teams: [], budgets: [] };

  const enterpriseResponse = await client.request(pathFor(templates.enterprise, { enterprise }));
  data.enterprise = await enterpriseResponse.json();

  const organizations = await client.collect(pathFor(templates.organizations, { enterprise }));
  if (organizations.error) throw new GitHubExtractionError("Required organization acquisition failed.", { cause: organizations });
  data.organizations = organizations.items;

  for (const organization of sorted(data.organizations, (item) => item.login || item.id)) {
    const key = organization.login || organization.slug || organization.id;
    const repos = await client.collect(pathFor(templates.repositories, { organization: key }), { required: false });
    if (repos.error) failures.push({ capability: "repositories", organization: key, status: repos.status });
    else data.repositories.push(...repos.items.map((repo) => ({ ...repo, organizationLogin: key })));
    const memberships = await client.collect(pathFor(templates.memberships, { organization: key }), { required: false, query: { role: "all" } });
    if (memberships.error) failures.push({ capability: "memberships", organization: key, status: memberships.status });
    else data.memberships.push(...memberships.items.map((member) => ({ ...member, organizationLogin: key })));
    if (!templates.seats && templates.organizationSeats) {
      const seats = await client.collect(pathFor(templates.organizationSeats, { organization: key }), { required: false });
      if (seats.error) failures.push({ capability: "seats", organization: key, status: seats.status });
      else data.seats.push(...seats.items.map((seat) => ({ ...seat, organizationLogin: key })));
    }
  }

  for (const [capability, template, required] of [
    ["seats", templates.seats, false],
    ["teams", templates.teams, false],
    ["budgets", templates.budgets, false],
  ]) {
    if (!template) {
      failures.push({ capability, reason: "No supported read endpoint configured." });
      continue;
    }
    const result = await client.collect(pathFor(template, { enterprise }), { required });
    if (result.error) failures.push({ capability, status: result.status });
    else data[capability] = result.items;
  }

  return { data, failures, complete: failures.length === 0 };
}

function normalizeUser(raw, options) {
  const id = sourceId(raw);
  const anonymized = options.anonymize;
  const simulatorId = anonymized ? hashId("user", id) : `gh-user-${id}`;
  return {
    id: simulatorId,
    ...(anonymized ? { name: `User ${simulatorId.slice(-6)}` } : { name: raw.name || raw.login || simulatorId, externalLogin: raw.login, externalId: id }),
    organizationIds: [],
    licenseOrganizationId: null,
    costCenterId: null,
    licensePlan: null,
    licenseStartsAt: null,
    licenseEndsAt: null,
    licenseEndMode: null,
  };
}

function normalizeBudget(raw, maps) {
  const scopeId = maps[raw.scopeType]?.get(String(raw.scopeId));
  if (!scopeId) return null;
  return {
    id: raw.id || hashId("budget", `${raw.scopeType}:${raw.scopeId}:${raw.productId}`),
    name: raw.name || "Imported budget",
    budgetKind: raw.budgetKind || "metered",
    ...(raw.budgetKind === "user" ? { userBudgetType: raw.userBudgetType || "individual" } : {}),
    scopeType: raw.scopeType,
    scopeId,
    productId: raw.productId || "ai-credits",
    amount: Number(raw.amount),
    effectiveFrom: dateOnly(raw.effectiveFrom) || "1970-01-01",
    ...(raw.expiresAt ? { expiresAt: dateOnly(raw.expiresAt) } : {}),
    enforcement: raw.budgetKind === "user" ? "hard" : raw.enforcement || "soft",
    thresholds: [...new Set((raw.thresholds || []).map(Number))].sort((a, b) => a - b),
  };
}

export function normalizeGitHubEnterprise(acquired, {
  extractionId = "github-enterprise",
  extractedAt = new Date().toISOString(),
  anonymize = true,
  licenseOverrides = {},
  includeBudgets = true,
  aiCreditPrice = 0.01,
} = {}) {
  const data = acquired?.data || acquired;
  if (!data?.enterprise || !Array.isArray(data.organizations)) throw new GitHubExtractionError("Enterprise and organizations are required for normalization.");
  const source = {
    kind: "github-api",
    enterprise: anonymize ? hashId("enterprise", sourceId(data.enterprise)) : data.enterprise.slug || data.enterprise.login || String(data.enterprise.id || ""),
    createdAt: extractedAt,
    assumptions: [
      "Topology was acquired with read-only GitHub API requests.",
      "AI-credit price is an operator-supplied simulator input; GitHub billing exports do not provide a universal per-credit price.",
      "Usage aggregates are not converted into per-user events.",
      ...(acquired?.failures?.length ? ["Optional capabilities were unavailable; this export is partial and must be explicitly allowed by the caller."] : []),
    ],
    omittedCapabilities: [
      ...(acquired?.failures || []).map((failure) => `${failure.capability}${failure.organization ? ` for ${anonymize ? hashId("org", failure.organization) : failure.organization}` : ""}`),
      "Per-user usage events",
    ],
    anonymized: Boolean(anonymize),
  };
  const orgMap = new Map(data.organizations.flatMap((org) => {
    const normalized = anonymize ? hashId("org", sourceId(org)) : `gh-org-${sourceId(org)}`;
    return [[String(sourceId(org)), normalized], [String(org.id), normalized], [String(org.login), normalized], [String(org.slug), normalized]];
  }));
  const repoMap = new Map((data.repositories || []).flatMap((repo) => {
    const normalized = anonymize ? hashId("repo", sourceId(repo)) : `gh-repo-${sourceId(repo)}`;
    return [[String(sourceId(repo)), normalized], [String(repo.id), normalized], [String(repo.full_name), normalized]];
  }));
  const userMap = new Map();
  const teamMap = new Map((data.teams || []).flatMap((team) => {
    const normalized = anonymize ? hashId("team", sourceId(team)) : `gh-team-${sourceId(team)}`;
    return [[String(sourceId(team)), normalized], [String(team.id), normalized], [String(team.slug), normalized]];
  }));
  const costCenterMap = new Map();
  const organizations = sorted(data.organizations.map((org) => ({
    id: orgMap.get(String(sourceId(org))),
    name: anonymize ? `Organization ${orgMap.get(String(sourceId(org))).slice(-6)}` : org.name || org.login,
    ...(!anonymize ? { externalLogin: org.login, externalId: sourceId(org) } : {}),
  })));
  const repositories = sorted((data.repositories || []).map((repo) => ({
    id: repoMap.get(String(sourceId(repo))),
    name: anonymize ? `Repository ${repoMap.get(String(sourceId(repo))).slice(-6)}` : repo.name,
    organizationId: orgMap.get(String(repo.organizationLogin || repo.organizationId)),
    ...(!anonymize ? { externalId: sourceId(repo) } : {}),
  })));

  const seatsByUser = new Map();
  for (const seat of data.seats || []) {
    const assignee = seat.assignee || seat.user || seat;
    const id = sourceId(assignee);
    if (!id) continue;
    const grant = {
      plan: String(seat.plan || seat.plan_type || "business").toLowerCase().includes("enterprise") ? "enterprise" : "business",
      organization: seat.organization?.login || seat.organizationLogin || seat.billingOrganization || seat.organization_id,
      startsAt: dateOnly(seat.assigned_at || seat.created_at),
      endsAt: dateOnly(seat.revoked_at || seat.canceled_at || seat.cancelled_at),
      endMode: seat.revoked_at ? "revoked" : seat.canceled_at || seat.cancelled_at ? "unassign" : null,
    };
    const grants = seatsByUser.get(String(id)) || [];
    grants.push({ ...grant, assignee });
    seatsByUser.set(String(id), grants);
  }
  const membershipByUser = new Map();
  for (const membership of data.memberships || []) {
    const id = sourceId(membership);
    if (!id) continue;
    const user = userMap.get(String(id)) || normalizeUser(membership, { anonymize });
    user.organizationIds.push(orgMap.get(String(membership.organizationLogin || membership.organizationId)));
    membershipByUser.set(String(id), user);
    userMap.set(String(id), user);
  }
  for (const [id, grants] of seatsByUser) {
    const user = userMap.get(id) || normalizeUser(grants[0].assignee, { anonymize });
    const override = licenseOverrides[id] || licenseOverrides[grants[0].assignee.login];
    const normalizedGrants = grants.map((grant) => ({ ...grant, organization: orgMap.get(String(grant.organization)) }));
    const distinct = new Set(normalizedGrants.map((grant) => `${grant.plan}:${grant.organization}`));
    if (distinct.size > 1 && !override) throw new GitHubExtractionError(`Ambiguous Copilot license grants for ${anonymize ? user.id : id}; provide an explicit license override.`);
    const selected = override ? { ...normalizedGrants[0], ...override, organization: orgMap.get(String(override.organization || override.organizationId)) || override.organization } : normalizedGrants.sort((a, b) => `${a.plan}:${a.organization}`.localeCompare(`${b.plan}:${b.organization}`))[0];
    user.licensePlan = selected.plan;
    user.licenseOrganizationId = selected.organization;
    if (!user.organizationIds.includes(selected.organization)) user.organizationIds.push(selected.organization);
    user.licenseStartsAt = selected.startsAt;
    user.licenseEndsAt = selected.endsAt;
    user.licenseEndMode = selected.endMode;
    userMap.set(id, user);
  }

  for (const team of data.teams || []) {
    for (const member of team.members || team.memberships || []) {
      const user = userMap.get(String(sourceId(member)));
      if (user) {
        const teamId = teamMap.get(String(sourceId(team)));
        user.enterpriseTeamIds ||= [];
        user.enterpriseTeamIds.push(teamId);
      }
    }
  }
  const rawCostCenters = data.costCenters || [];
  for (const center of rawCostCenters) costCenterMap.set(String(sourceId(center)), anonymize ? hashId("cc", sourceId(center)) : `gh-cc-${sourceId(center)}`);
  const costCenters = sorted(rawCostCenters.map((center) => ({
    id: costCenterMap.get(String(sourceId(center))),
    name: anonymize ? `Cost center ${costCenterMap.get(String(sourceId(center))).slice(-6)}` : center.name,
    organizationIds: (center.organizationIds || []).map((id) => orgMap.get(String(id))).filter(Boolean),
    repositoryIds: (center.repositoryIds || []).map((id) => repoMap.get(String(id))).filter(Boolean),
    userIds: (center.userIds || []).map((id) => userMap.get(String(id))?.id).filter(Boolean),
    enterpriseTeamIds: (center.enterpriseTeamIds || []).map((id) => teamMap.get(String(id))).filter(Boolean),
    excludeFromEnterpriseBudget: Boolean(center.excludeFromEnterpriseBudget),
  })));
  const userCostCenters = new Map(costCenters.flatMap((center) => center.userIds.map((id) => [id, center.id])));
  const enterpriseTeams = sorted((data.teams || []).map((team) => ({
    id: teamMap.get(String(sourceId(team))),
    name: anonymize ? `Team ${teamMap.get(String(sourceId(team))).slice(-6)}` : team.name,
    userIds: (team.members || team.memberships || []).map((member) => userMap.get(String(sourceId(member)))?.id).filter(Boolean),
  })));
  for (const user of userMap.values()) {
    user.costCenterId = userCostCenters.get(user.id) || null;
    delete user.enterpriseTeamIds;
  }
  const maps = {
    enterprise: new Map([[String(data.enterprise.id || data.enterprise.slug), anonymize ? hashId("enterprise", sourceId(data.enterprise)) : data.enterprise.id ? `gh-enterprise-${data.enterprise.id}` : `gh-enterprise-${data.enterprise.slug}`]]),
    organization: orgMap,
    repository: repoMap,
    costCenter: costCenterMap,
    user: new Map([...userMap.entries()].map(([key, value]) => [key, value.id])),
  };
  const enterpriseId = maps.enterprise.values().next().value;
  const budgets = includeBudgets ? (data.budgets || []).map((budget) => normalizeBudget(budget, maps)).filter(Boolean) : [];
  const environment = {
    version: 1,
    id: extractionId,
    name: anonymize ? "Imported GitHub enterprise" : data.enterprise.name || data.enterprise.slug || extractionId,
    summary: `${organizations.length} organizations, ${repositories.length} repositories, ${userMap.size} licensed users`,
    source,
    enterprise: { id: enterpriseId, name: source.anonymized ? "Imported enterprise" : data.enterprise.name || source.enterprise, currency: data.enterprise.currency || "USD", paidAiUsage: true, seatCreditPolicy: "prorated" },
    organizations,
    repositories,
    costCenters,
    enterpriseTeams,
    users: sorted([...userMap.values()].filter((user) => user.licensePlan), (user) => user.id),
    products: [{ id: "ai-credits", name: "Copilot AI credits", unit: "AI credit", unitPrice: Number(aiCreditPrice), billingMode: "aiCredits" }],
    budgets,
  };
  const error = validateEnvironment(environment);
  if (error) throw new GitHubExtractionError(`Normalized environment is invalid: ${error}`);
  return environment;
}

export function redactExtractionError(error, { anonymize = true } = {}) {
  if (!anonymize) return error?.message || String(error);
  return String(error?.message || error).replace(/https?:\/\/\S+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]");
}
