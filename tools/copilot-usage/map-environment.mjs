import { createHash } from "node:crypto";
import {
  AI_CREDITS_PRODUCT_ID,
  AI_CREDIT_USD,
  COST_CENTER_PRECEDENCE,
  UNALLOCATED_COST_CENTER_ID,
  assertDay,
  creditsToUsd,
} from "./contract.mjs";

const AI_CREDITS_PRODUCT = Object.freeze({
  id: AI_CREDITS_PRODUCT_ID,
  name: "Copilot AI credits",
  unit: "AI credit",
  unitPrice: AI_CREDIT_USD,
  billingMode: "aiCredits",
});

export function resolveCostCenter({ userId, organizationId, teamIds = [], membership }) {
  if (!membership || !Array.isArray(membership.cost_centers)) {
    throw new Error("membership.cost_centers must be an array.");
  }
  const costCenters = [...membership.cost_centers].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const teamIdSet = new Set(teamIds ?? []);
  const resolvers = {
    user: (costCenter) => (costCenter.user_ids ?? []).includes(userId),
    team: (costCenter) => (costCenter.team_ids ?? []).some((teamId) => teamIdSet.has(teamId)),
    organization: (costCenter) => organizationId && (costCenter.organization_ids ?? []).includes(organizationId),
  };

  for (const route of COST_CENTER_PRECEDENCE) {
    const costCenter = costCenters.find((candidate) => resolvers[route](candidate));
    if (costCenter) {
      return { costCenterId: costCenter.id, costCenterName: costCenter.name ?? costCenter.id, route };
    }
  }

  return { costCenterId: UNALLOCATED_COST_CENTER_ID, costCenterName: "Unallocated", route: "none" };
}

export function buildChargebackTable({ usageRowsByDay, userTeamRowsByDay, membership }) {
  const rowsByKey = new Map();
  const usageRows = flattenRowsByDay(usageRowsByDay);
  const teamIdsByDayUser = teamsByDayUser(userTeamRowsByDay);

  for (const usageRow of usageRows) {
    const day = assertDay(usageRow.day_partition, "usageRow.day_partition");
    const userId = requireText(usageRow.user_id, "usageRow.user_id");
    const credits = numberValue(usageRow.ai_credits_used, `usage row ${userId} ${day} ai_credits_used`);
    const organizationId = usageRow.organization_id ?? null;
    const resolution = resolveCostCenter({
      userId,
      organizationId,
      teamIds: teamIdsByDayUser.get(`${day}\u0000${userId}`) ?? [],
      membership,
    });
    const key = `${day}\u0000${userId}`;
    const row = rowsByKey.get(key) ?? {
      day,
      user_id: userId,
      user_login: usageRow.user_login ?? userId,
      cost_center_id: resolution.costCenterId,
      cost_center_name: resolution.costCenterName,
      organization_id: organizationId,
      attribution_route: resolution.route,
      ai_credits_used: 0,
      usage_usd: 0,
    };
    if (row.cost_center_id !== resolution.costCenterId) {
      throw new Error(`Conflicting cost-centre resolution for ${userId} on ${day}.`);
    }
    row.ai_credits_used += credits;
    row.usage_usd += creditsToUsd(credits);
    rowsByKey.set(key, row);
  }

  const rows = [...rowsByKey.values()].sort(compareChargebackRows);
  return {
    rows,
    invariants: verifyChargebackInvariants({ rows, usageRowsByDay }),
    unallocated: summarizeUnallocated(rows),
  };
}

export function verifyChargebackInvariants({ rows, usageRowsByDay }) {
  const sourceByDay = new Map();
  for (const usageRow of flattenRowsByDay(usageRowsByDay)) {
    const day = assertDay(usageRow.day_partition, "usageRow.day_partition");
    const credits = numberValue(usageRow.ai_credits_used, `usage row ${usageRow.user_id ?? "unknown"} ${day} ai_credits_used`);
    const totals = sourceByDay.get(day) ?? { credits: 0, usd: 0 };
    totals.credits += credits;
    totals.usd += creditsToUsd(credits);
    sourceByDay.set(day, totals);
  }

  const rowsByDay = new Map();
  for (const row of rows) {
    const day = assertDay(row.day, "chargeback row day");
    const totals = rowsByDay.get(day) ?? { credits: 0, usd: 0 };
    totals.credits += numberValue(row.ai_credits_used, `chargeback row ${row.user_id} ${day} ai_credits_used`);
    totals.usd += numberValue(row.usage_usd, `chargeback row ${row.user_id} ${day} usage_usd`);
    rowsByDay.set(day, totals);
  }

  const days = [...new Set([...sourceByDay.keys(), ...rowsByDay.keys()])].sort();
  return days.flatMap((day) => {
    const source = sourceByDay.get(day) ?? { credits: 0, usd: 0 };
    const allocated = rowsByDay.get(day) ?? { credits: 0, usd: 0 };
    const creditOk = allocated.credits === source.credits;
    const usdOk = allocated.usd === source.usd;
    // Conservation is not completeness: a missing source day can still balance at zero. Extractor
    // manifests own expected-day coverage checks; this module only proves no ingested cost vanished.
    return [
      {
        name: `chargeback-credits-${day}`,
        ok: creditOk,
        detail: `allocated plus unallocated credits ${allocated.credits} equals source credits ${source.credits}`,
      },
      {
        name: `chargeback-usd-${day}`,
        ok: usdOk,
        detail: `allocated plus unallocated usage_usd ${allocated.usd} equals source usage_usd ${source.usd}`,
      },
    ];
  });
}

export function buildEnvironment({ chargeback, usageRowsByDay, seats = [], enterprise, membership, options = {} }) {
  const chargebackRows = chargebackRowsFrom(chargeback);
  const usageRows = flattenRowsByDay(usageRowsByDay);
  const enterpriseId = slugId(options.enterpriseId ?? (typeof enterprise === "string" ? enterprise : enterprise?.id) ?? firstValue(usageRows, "enterprise_id") ?? "enterprise");
  const createdAt = options.createdAt ?? membership?.captured_at ?? "1970-01-01T00:00:00Z";
  const organizationIds = collectOrganizationIds({ usageRows, seats, membership, options });
  const organizationById = new Map((options.organizations ?? []).map((organization) => [organization.id, organization]));
  const organizations = organizationIds.map((id) => ({ id, name: organizationById.get(id)?.name ?? options.organizationNames?.[id] ?? titleFromId(id) }));
  const costCenters = buildCostCenters({ chargebackRows, membership, includeUnallocated: chargebackRows.some((row) => row.cost_center_id === UNALLOCATED_COST_CENTER_ID) });
  const users = buildUsers({ chargebackRows, usageRows, seats, organizationIds });
  const products = withCanonicalProduct(options.products ?? []);

  return sortEnvironment({
    version: 1,
    id: slugId(options.id ?? `${enterpriseId}-github-api`),
    name: options.name ?? `${titleFromId(enterpriseId)} GitHub Copilot usage`,
    summary: options.summary ?? "Environment generated from GitHub Copilot usage-metrics exports for chargeback analysis.",
    source: {
      kind: "github-api",
      enterprise: typeof enterprise === "string" ? enterprise : enterprise?.slug ?? enterprise?.id ?? enterpriseId,
      createdAt,
      assumptions: buildAssumptions({ membership, options }),
      omittedCapabilities: buildOmittedCapabilities(options),
      ...(options.anonymized ? { anonymized: true } : {}),
    },
    enterprise: {
      name: typeof enterprise === "object" && enterprise?.name ? enterprise.name : titleFromId(enterpriseId),
      currency: "USD",
      paidAiUsage: true,
      seatCreditPolicy: "prorated",
      ...(typeof enterprise === "object" ? withoutKeys(enterprise, ["slug"]) : {}),
      id: enterpriseId,
    },
    organizations,
    repositories: (options.repositories ?? []).map((repository) => ({ ...repository })).sort(compareById),
    costCenters,
    enterpriseTeams: buildEnterpriseTeams(options.userTeamRowsByDay, membership),
    users,
    products,
    budgets: (options.budgets ?? []).map((budget) => ({ ...budget })).sort(compareById),
  });
}

export function buildScenario({ environment, chargeback, simulationDate }) {
  const day = assertDay(simulationDate, "simulationDate");
  const topology = structuredClone(environment);
  delete topology.source;
  delete topology.name;
  delete topology.summary;
  return {
    ...topology,
    version: 2,
    simulationDate: day,
    events: chargebackRowsFrom(chargeback)
      .filter((row) => Number(row.ai_credits_used ?? 0) > 0)
      .sort(compareChargebackRows)
      .map((row) => ({
        id: `github-api-${slugId(row.day)}-${slugId(row.user_id)}`,
        date: row.day,
        userId: row.user_id,
        productId: AI_CREDITS_PRODUCT_ID,
        quantity: Number(row.ai_credits_used),
      })),
  };
}

export function anonymize(value, { salt = "" } = {}) {
  const copy = structuredClone(value);
  const userIds = new Set((copy.users ?? []).map((user) => user.id));
  const idMap = new Map([...userIds].sort().map((id) => [id, `user-${hashId(`${salt}:${id}`)}`]));
  const nameMap = new Map([...userIds].sort().map((id, index) => [id, `User ${String(index + 1).padStart(3, "0")}`]));

  for (const user of copy.users ?? []) {
    const originalId = user.id;
    user.id = idMap.get(originalId);
    user.name = nameMap.get(originalId);
    if (user.login !== undefined) user.login = user.id;
    if (user.user_login !== undefined) user.user_login = user.id;
  }
  for (const team of copy.enterpriseTeams ?? []) {
    team.userIds = (team.userIds ?? []).map((userId) => idMap.get(userId) ?? userId).sort();
  }
  for (const costCenter of copy.costCenters ?? []) {
    if (Array.isArray(costCenter.userIds)) costCenter.userIds = costCenter.userIds.map((userId) => idMap.get(userId) ?? userId).sort();
    if (Array.isArray(costCenter.user_ids)) costCenter.user_ids = costCenter.user_ids.map((userId) => idMap.get(userId) ?? userId).sort();
  }
  for (const budget of copy.budgets ?? []) {
    if (budget.scopeType === "user" && idMap.has(budget.scopeId)) budget.scopeId = idMap.get(budget.scopeId);
  }
  for (const event of copy.events ?? []) {
    if (idMap.has(event.userId)) event.userId = idMap.get(event.userId);
    if (event.id) event.id = `anon-${hashId(`${salt}:${event.id}`)}`;
  }
  if (copy.source) copy.source.anonymized = true;
  return sortEnvironmentOrScenario(copy);
}

function flattenRowsByDay(rowsByDay) {
  if (!rowsByDay) return [];
  if (Array.isArray(rowsByDay)) return rowsByDay;
  if (rowsByDay instanceof Map) return [...rowsByDay.keys()].sort().flatMap((day) => rowsByDay.get(day) ?? []);
  return Object.keys(rowsByDay).sort().flatMap((day) => rowsByDay[day] ?? []);
}

function teamsByDayUser(userTeamRowsByDay) {
  const teams = new Map();
  for (const row of flattenRowsByDay(userTeamRowsByDay)) {
    const day = assertDay(row.day_partition, "userTeamRow.day_partition");
    const userId = requireText(row.user_id, "userTeamRow.user_id");
    const key = `${day}\u0000${userId}`;
    const teamIds = teams.get(key) ?? [];
    if (row.team_id && !teamIds.includes(row.team_id)) teamIds.push(row.team_id);
    teams.set(key, teamIds.sort());
  }
  return teams;
}

function summarizeUnallocated(rows) {
  const unallocatedRows = rows.filter((row) => row.cost_center_id === UNALLOCATED_COST_CENTER_ID);
  return {
    rowCount: unallocatedRows.length,
    userCount: new Set(unallocatedRows.map((row) => row.user_id)).size,
    ai_credits_used: unallocatedRows.reduce((total, row) => total + Number(row.ai_credits_used), 0),
    usage_usd: unallocatedRows.reduce((total, row) => total + Number(row.usage_usd), 0),
  };
}

function chargebackRowsFrom(chargeback) {
  if (Array.isArray(chargeback)) return chargeback;
  if (Array.isArray(chargeback?.rows)) return chargeback.rows;
  throw new Error("chargeback must be an array or an object with a rows array.");
}

function collectOrganizationIds({ usageRows, seats, membership, options }) {
  const ids = new Set(options.organizations?.map((organization) => organization.id) ?? []);
  for (const row of usageRows) if (row.organization_id) ids.add(row.organization_id);
  for (const seat of seats) if (seat.organization_id) ids.add(seat.organization_id);
  for (const costCenter of membership?.cost_centers ?? []) {
    for (const organizationId of costCenter.organization_ids ?? []) ids.add(organizationId);
  }
  if (ids.size === 0) ids.add(options.defaultOrganizationId ?? "org-unknown");
  return [...ids].sort();
}

function buildCostCenters({ chargebackRows, membership, includeUnallocated }) {
  const costCenters = (membership?.cost_centers ?? [])
    .map((costCenter) => ({
      id: costCenter.id,
      name: costCenter.name ?? costCenter.id,
      organizationIds: [...(costCenter.organization_ids ?? [])].sort(),
      excludeFromEnterpriseBudget: false,
    }));
  if (includeUnallocated && !costCenters.some((costCenter) => costCenter.id === UNALLOCATED_COST_CENTER_ID)) {
    costCenters.push({ id: UNALLOCATED_COST_CENTER_ID, name: "Unallocated", organizationIds: [], excludeFromEnterpriseBudget: false });
  }
  return costCenters.sort(compareById);
}

function buildUsers({ chargebackRows, usageRows, seats, organizationIds }) {
  const usageByUser = new Map();
  for (const row of usageRows) {
    const user = usageByUser.get(row.user_id) ?? { organizations: new Set(), login: row.user_login ?? row.user_id };
    if (row.organization_id) user.organizations.add(row.organization_id);
    usageByUser.set(row.user_id, user);
  }
  const chargebackByUser = new Map();
  for (const row of chargebackRows) {
    if (!chargebackByUser.has(row.user_id) || row.cost_center_id !== UNALLOCATED_COST_CENTER_ID) {
      chargebackByUser.set(row.user_id, row);
    }
  }
  const seatsByUser = new Map(seats.map((seat) => [seat.user_id, seat]));
  const userIds = [...new Set([...usageByUser.keys(), ...seatsByUser.keys()])].sort();
  const fallbackOrganizationId = organizationIds[0];

  return userIds.map((userId) => {
    const seat = seatsByUser.get(userId);
    if (seat?.tier && !["business", "enterprise"].includes(seat.tier)) {
      throw new Error(`Seat for ${userId} has unsupported tier ${seat.tier}.`);
    }
    const usage = usageByUser.get(userId);
    const orgs = new Set([...(usage?.organizations ?? [])]);
    if (seat?.organization_id) orgs.add(seat.organization_id);
    if (orgs.size === 0) orgs.add(fallbackOrganizationId);
    const organizationList = [...orgs].sort();
    const licenseOrganizationId = seat?.organization_id && orgs.has(seat.organization_id) ? seat.organization_id : organizationList[0];
    const chargebackRow = chargebackByUser.get(userId);
    return {
      id: userId,
      name: seat?.user_login ?? usage?.login ?? userId,
      organizationIds: organizationList,
      licenseOrganizationId,
      ...(chargebackRow ? { costCenterId: chargebackRow.cost_center_id } : {}),
      licensePlan: seat?.tier === "enterprise" ? "enterprise" : "business",
      licenseStartsAt: seat?.starts_at ?? null,
      licenseEndsAt: seat?.ends_at ?? null,
      licenseEndMode: seat?.ends_at ? "scheduled" : null,
    };
  });
}

function withCanonicalProduct(products) {
  const byId = new Map(products.map((product) => [product.id, { ...product }]));
  byId.set(AI_CREDITS_PRODUCT_ID, { ...AI_CREDITS_PRODUCT });
  return [...byId.values()].sort(compareById);
}

function buildEnterpriseTeams(userTeamRowsByDay, membership) {
  const teams = new Map();
  for (const row of flattenRowsByDay(userTeamRowsByDay)) {
    const team = teams.get(row.team_id) ?? { id: row.team_id, name: row.team_name ?? row.team_id, userIds: new Set() };
    team.userIds.add(row.user_id);
    teams.set(row.team_id, team);
  }
  for (const costCenter of membership?.cost_centers ?? []) {
    for (const teamId of costCenter.team_ids ?? []) {
      if (!teams.has(teamId)) teams.set(teamId, { id: teamId, name: titleFromId(teamId), userIds: new Set() });
    }
  }
  return [...teams.values()]
    .map((team) => ({ id: team.id, name: team.name, userIds: [...team.userIds].sort() }))
    .sort(compareById);
}

function buildAssumptions({ membership, options }) {
  return [
    ...(options.assumptions ?? []),
    "Budgets are not extracted from GitHub usage-metrics data; budgets are empty unless explicitly supplied.",
    "Repository topology may be incomplete because this MVP maps only the users and user-teams daily reports.",
    membership?.effective_from
      ? `Cost-centre membership is treated as effective from ${membership.effective_from}.`
      : "Cost-centre attribution is point-in-time because the membership effective-from date is unknown.",
    "ai_credits_used is not broken down by model; any model-level split must be estimated separately and normalized to exact user totals.",
  ];
}

function buildOmittedCapabilities(options) {
  return [
    ...(options.omittedCapabilities ?? []),
    "Per-repository usage exports are not imported by this mapper.",
    "Budgets, Azure invoice lines, and policy settings are not available in GitHub usage-metrics reports.",
    "Model-level credit attribution is omitted from the environment topology.",
  ];
}

function sortEnvironment(environment) {
  return {
    ...environment,
    organizations: [...environment.organizations].sort(compareById),
    repositories: [...environment.repositories].sort(compareById),
    costCenters: [...environment.costCenters].sort(compareById),
    enterpriseTeams: [...environment.enterpriseTeams].sort(compareById),
    users: [...environment.users].sort(compareById),
    products: [...environment.products].sort(compareById),
    budgets: [...environment.budgets].sort(compareById),
  };
}

function sortEnvironmentOrScenario(value) {
  const sorted = sortEnvironment({ ...value, source: value.source ?? {}, name: value.name ?? "", summary: value.summary ?? "" });
  if (Array.isArray(value.events)) sorted.events = [...value.events].sort(compareById);
  if (!value.source) delete sorted.source;
  if (!value.name) delete sorted.name;
  if (!value.summary) delete sorted.summary;
  return sorted;
}

function compareChargebackRows(a, b) {
  return a.day.localeCompare(b.day) || a.user_id.localeCompare(b.user_id);
}

function compareById(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function numberValue(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number.`);
  if (number < 0) throw new Error(`${label} must be non-negative.`);
  return number;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function slugId(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(slug) ? slug : `id-${slug || "unknown"}`;
}

function titleFromId(id) {
  return String(id).replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function firstValue(rows, key) {
  return rows.find((row) => row[key])?.[key];
}

function withoutKeys(object, keys) {
  const copy = { ...object };
  for (const key of keys) delete copy[key];
  return copy;
}

function hashId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
