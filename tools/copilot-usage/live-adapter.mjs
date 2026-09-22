/**
 * Dependency-free normalization adapter for *live* GitHub Copilot usage-metrics data.
 *
 * The rest of `tools/copilot-usage/` (see `contract.mjs`, `map-environment.mjs`) is built against
 * the clean, already-normalized shapes documented there. This module is the seam between that
 * clean model and messier real-world payloads: numeric ids that need to become stable strings,
 * legacy field names (`day` instead of `day_partition`), object-shaped enum fields, and cost-centre
 * exports that list raw `{type, name}` resources instead of pre-bucketed id arrays.
 *
 * Nothing here mutates `contract.mjs`, `map-environment.mjs`, or any other existing module; it only
 * produces values in their expected shapes.
 */

import { UNALLOCATED_COST_CENTER_ID, creditsToUsd } from "./contract.mjs";

/** Bucket id used when a user's usage matches two or more attribution candidates at once. */
export const AMBIGUOUS_COST_CENTER_ID = "ambiguous-attribution";

/** Human-readable label paired with {@link AMBIGUOUS_COST_CENTER_ID}. */
export const AMBIGUOUS_COST_CENTER_NAME = "Ambiguous attribution";

/** Precedence used when more than one seat exists for the same user id. Higher rank wins. */
const SEAT_TIER_RANK = Object.freeze({ enterprise: 2, business: 1 });

/** Live resource `type` values (case-insensitive) mapped to the internal cost-centre id bucket. */
const RESOURCE_TYPE_BUCKET = new Map([
  ["user", "user_ids"],
  ["org", "organization_ids"],
  ["organization", "organization_ids"],
  ["team", "team_ids"],
]);

/**
 * Normalize any id-like value (numeric or string) to a stable, trimmed string, or `null` for an
 * empty/absent value. GitHub's live APIs sometimes emit numeric ids where the rest of this
 * toolchain expects strings (used as Map/object keys and join columns throughout `contract.mjs`).
 */
export function normalizeId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot normalize a non-finite numeric id: ${value}`);
    return String(value);
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/** `undefined` and blank strings both normalize to `null`; every other value passes through. */
function normalizeEmpty(value) {
  if (value === undefined) return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  return value;
}

function normalizeAdoptionPhase(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    // Live payloads have been observed to emit ai_adoption_phase as an object, e.g.
    // { name: "Phase 3" }. Accept any of the plausible label keys.
    return normalizeEmpty(value.name ?? value.phase ?? value.label ?? value.value ?? null);
  }
  return normalizeEmpty(String(value));
}

function normalizeModelFeatureTotal(entry) {
  return {
    ...entry,
    model: normalizeEmpty(entry?.model) ?? "unknown",
    feature: normalizeEmpty(entry?.feature) ?? "unknown",
    interaction_count: Number(entry?.interaction_count ?? entry?.user_initiated_interaction_count ?? 0),
  };
}

/**
 * Normalize one row of a live `users-1-day` or `users-28-day` usage-metrics report into the
 * `UsageRow` shape documented in `contract.mjs`.
 *
 * - `user_id` is coerced to a stable string (numeric ids are common in some live exports).
 * - `day` (or `date`/`report_day`) is renamed to `day_partition`; `day_partition` itself is
 *   preserved as-is when already present, so this is safe to run twice.
 * - `ai_adoption_phase` accepts either a plain string or an object with a `name`/`phase`/`label`
 *   field and is normalized to a plain string, omitted entirely when empty.
 * - `totals_by_model_feature` (the per-model/feature interaction breakdown) is preserved verbatim
 *   as an array, defaulting to `[]` rather than being dropped.
 * - Empty/absent optional string fields (`organization_id`, `entity_id_partition`,
 *   `enterprise_id`, `etl_id`) normalize to `null` instead of `""`/`undefined`.
 */
export function normalizeUsageRow(raw) {
  if (!raw || typeof raw !== "object") throw new Error("normalizeUsageRow requires a row object.");

  const userId = normalizeId(raw.user_id);
  if (!userId) throw new Error("normalizeUsageRow requires a non-empty user_id.");

  const dayPartition = normalizeEmpty(raw.day_partition) ?? normalizeEmpty(raw.day) ?? normalizeEmpty(raw.date) ?? normalizeEmpty(raw.report_day);
  if (!dayPartition) throw new Error(`normalizeUsageRow requires day_partition/day for user ${userId}.`);

  const normalized = {
    ...raw,
    day_partition: dayPartition,
    entity_id_partition: normalizeEmpty(raw.entity_id_partition),
    enterprise_id: normalizeEmpty(raw.enterprise_id),
    organization_id: normalizeEmpty(raw.organization_id),
    user_id: userId,
    user_login: normalizeEmpty(raw.user_login) ?? userId,
    ai_credits_used: Number(raw.ai_credits_used ?? 0),
    totals_by_model_feature: Array.isArray(raw.totals_by_model_feature)
      ? raw.totals_by_model_feature.map(normalizeModelFeatureTotal)
      : [],
    etl_id: normalizeEmpty(raw.etl_id),
  };

  const phase = normalizeAdoptionPhase(raw.ai_adoption_phase);
  if (phase !== null) normalized.ai_adoption_phase = phase;

  return normalized;
}

/** Normalize every row of a live `users-1-day`/`users-28-day` NDJSON export. */
export function normalizeUsageRows(rawRows) {
  if (!Array.isArray(rawRows)) throw new Error("normalizeUsageRows requires an array of rows.");
  return rawRows.map((row) => normalizeUsageRow(row));
}

function normalizeCostCenterResource(resource) {
  const type = String(resource?.type ?? "").trim().toLowerCase();
  const id = normalizeId(resource?.id ?? resource?.name);
  const name = normalizeEmpty(resource?.name) ?? id;
  const deleted = Boolean(resource?.deleted);
  const state = normalizeEmpty(resource?.state) ?? "active";
  return { type: type || "unknown", id, name, deleted, state };
}

function normalizeCostCenter(raw, index) {
  const id = normalizeEmpty(raw?.id) ?? `cost-center-${index + 1}`;
  const name = normalizeEmpty(raw?.name) ?? id;
  const state = normalizeEmpty(raw?.state) ?? "active";
  const deleted = Boolean(raw?.deleted) || state === "deleted";
  const rawResources = Array.isArray(raw?.resources) ? raw.resources : [];

  const buckets = { user_ids: [], team_ids: [], organization_ids: [] };
  // Every raw resource is preserved verbatim, including duplicate names/ids and deleted entries,
  // so downstream auditing can see exactly what the live payload contained.
  const resources = rawResources.map(normalizeCostCenterResource);

  for (const resource of resources) {
    const bucketKey = RESOURCE_TYPE_BUCKET.get(resource.type);
    if (!bucketKey || !resource.id || resource.deleted) continue;
    if (!buckets[bucketKey].includes(resource.id)) buckets[bucketKey].push(resource.id);
  }
  for (const key of Object.keys(buckets)) buckets[key].sort();

  return {
    id,
    name,
    state,
    deleted,
    user_ids: buckets.user_ids,
    team_ids: buckets.team_ids,
    organization_ids: buckets.organization_ids,
    resources,
  };
}

/**
 * Normalize a live cost-centre export -- an array (or `{ costCenters: [...] }` /
 * `{ cost_centers: [...] }` envelope) of `{ id, name, state, resources: [{type, name}] }` records --
 * into the internal `MembershipSnapshot` shape from `contract.mjs` (`cost_centers` with direct
 * `user_ids`/`team_ids`/`organization_ids`).
 *
 * Live `resources` entries only carry a `type` and a `name` (no separate id) in the common case;
 * this uses `resource.id ?? resource.name` as the id. Duplicate resource names/ids, `deleted`
 * flags, and per-resource/per-cost-centre `state` are preserved in the returned `resources` array
 * for auditing, even though deleted resources are excluded from the active id buckets.
 */
export function normalizeCostCenterPayload(payload, { capturedAt = new Date().toISOString(), effectiveFrom = null } = {}) {
  const rawCostCenters = Array.isArray(payload) ? payload : payload?.costCenters ?? payload?.cost_centers ?? [];
  if (!Array.isArray(rawCostCenters)) {
    throw new Error("normalizeCostCenterPayload requires an array or a { costCenters } payload.");
  }
  return {
    captured_at: capturedAt,
    effective_from: effectiveFrom,
    cost_centers: rawCostCenters.map(normalizeCostCenter),
  };
}

function stripSeatIndex(seat) {
  const { __index, ...rest } = seat;
  return rest;
}

/**
 * Deduplicate a seat roster to exactly one seat per user id.
 *
 * Live seat exports have been observed to contain more than one row for the same user (e.g. a
 * stale business-tier row alongside a newly granted enterprise-tier row). Enterprise seats always
 * win over business seats for the same user; ties within the same tier are broken by the earliest
 * `starts_at`, then by original row order, so the result is fully deterministic.
 *
 * Returns `{ seats, collisions }`: `seats` has one entry per user id (in `user_id` order);
 * `collisions` lists every user id that had more than one seat, with the winning and dropped rows,
 * so callers can surface a warning instead of silently discarding data.
 */
export function dedupeSeats(seats) {
  if (!Array.isArray(seats)) throw new Error("dedupeSeats requires an array of seats.");

  const byUser = new Map();
  seats.forEach((seat, index) => {
    const userId = normalizeId(seat?.user_id);
    if (!userId) throw new Error(`dedupeSeats: seat at index ${index} is missing a user_id.`);
    const list = byUser.get(userId) ?? [];
    list.push({ ...seat, user_id: userId, __index: index });
    byUser.set(userId, list);
  });

  const resultSeats = [];
  const collisions = [];

  for (const userId of [...byUser.keys()].sort()) {
    const candidates = byUser.get(userId);
    if (candidates.length === 1) {
      resultSeats.push(stripSeatIndex(candidates[0]));
      continue;
    }

    const sorted = [...candidates].sort((a, b) => {
      const rankDiff = (SEAT_TIER_RANK[b.tier] ?? 0) - (SEAT_TIER_RANK[a.tier] ?? 0);
      if (rankDiff !== 0) return rankDiff;
      const startsDiff = String(a.starts_at ?? "").localeCompare(String(b.starts_at ?? ""));
      if (startsDiff !== 0) return startsDiff;
      return a.__index - b.__index;
    });
    const [winner, ...dropped] = sorted;
    resultSeats.push(stripSeatIndex(winner));
    collisions.push({
      user_id: userId,
      winner: { tier: winner.tier, starts_at: winner.starts_at ?? null, ends_at: winner.ends_at ?? null },
      dropped: dropped.map((seat) => ({ tier: seat.tier, starts_at: seat.starts_at ?? null, ends_at: seat.ends_at ?? null })),
      reason: winner.tier !== dropped[0]?.tier ? "higher-tier-precedence" : "duplicate-seat-earliest-start",
    });
  }

  return { seats: resultSeats, collisions };
}

function attributionResult(costCenter, route) {
  return {
    cost_center_id: costCenter.id,
    cost_center_name: costCenter.name ?? costCenter.id,
    route,
    ambiguous_candidates: null,
  };
}

function ambiguousResult(candidates, stage) {
  return {
    cost_center_id: AMBIGUOUS_COST_CENTER_ID,
    cost_center_name: AMBIGUOUS_COST_CENTER_NAME,
    route: "ambiguous",
    ambiguous_stage: stage,
    ambiguous_candidates: candidates.map((costCenter) => ({ id: costCenter.id, name: costCenter.name ?? costCenter.id })),
  };
}

function uniqueById(costCenters) {
  const seen = new Map();
  for (const costCenter of costCenters) {
    if (!seen.has(costCenter.id)) seen.set(costCenter.id, costCenter);
  }
  return [...seen.values()];
}

/**
 * Resolve a user's cost-centre attribution the same way `map-environment.mjs#resolveCostCenter`
 * does (direct user assignment beats team beats organization), but explicitly handles the case
 * that function does not: more than one cost centre matching at the same precedence level.
 *
 * This matters for live/dirty data, where `normalizeCostCenterPayload` can legitimately produce
 * two distinct cost centres that both directly list the same user, or both list the same
 * organization (e.g. duplicate cost-centre resource entries under different names). Silently
 * picking the alphabetically-first match would misattribute cost; this returns an explicit
 * `"ambiguous"` route and {@link AMBIGUOUS_COST_CENTER_ID} bucket instead.
 *
 * - Exactly one direct user match: that cost centre wins (`route: "user"`).
 * - Two or more direct user matches: ambiguous.
 * - Otherwise, exactly one team match: that cost centre wins (`route: "team"`).
 * - Two or more team matches: ambiguous.
 * - Otherwise, exactly one organization match: that cost centre wins (`route: "organization"`).
 * - Two or more organization matches: ambiguous.
 * - No matches at any level: `route: "none"`, {@link UNALLOCATED_COST_CENTER_ID}.
 */
export function attributeUser({ userId, userLogin = null, organizationId = null, organizationIds = [], teamIds = [], costCenters = [] }) {
  if (!Array.isArray(costCenters)) throw new Error("attributeUser requires costCenters to be an array.");
  const teamIdSet = new Set(teamIds ?? []);

  const directIds = new Set([normalizeId(userId), normalizeId(userLogin)].filter(Boolean));
  const activeCostCenters = costCenters.filter((costCenter) => !costCenter.deleted && costCenter.state !== "deleted");
  const directMatches = uniqueById(activeCostCenters.filter((costCenter) =>
    (costCenter.user_ids ?? []).some((candidate) => directIds.has(normalizeId(candidate))),
  ));
  if (directMatches.length === 1) return attributionResult(directMatches[0], "user");
  if (directMatches.length > 1) return ambiguousResult(directMatches, "user");

  const teamMatches = uniqueById(
    activeCostCenters.filter((costCenter) => (costCenter.team_ids ?? []).some((teamId) => teamIdSet.has(teamId))),
  );
  if (teamMatches.length === 1) return attributionResult(teamMatches[0], "team");
  if (teamMatches.length > 1) return ambiguousResult(teamMatches, "team");

  const orgIds = new Set([organizationId, ...organizationIds].filter(Boolean));
  if (orgIds.size > 0) {
    const orgMatches = uniqueById(activeCostCenters.filter((costCenter) =>
      (costCenter.organization_ids ?? []).some((candidate) => orgIds.has(candidate)),
    ));
    if (orgMatches.length === 1) return attributionResult(orgMatches[0], "organization");
    if (orgMatches.length > 1) return ambiguousResult(orgMatches, "organization");
  }

  return {
    cost_center_id: UNALLOCATED_COST_CENTER_ID,
    cost_center_name: "Unallocated",
    route: "none",
    ambiguous_candidates: null,
  };
}

/**
 * Attribute one normalized usage row to a cost centre using {@link attributeUser}, preserving the
 * row's `ai_credits_used`/`usage_usd` unchanged regardless of whether the outcome is a clean match
 * or an explicit `"ambiguous"`/`"none"` bucket -- ambiguity never causes credits to be dropped.
 */
export function buildAttributionRow({ usageRow, teamIds = [], costCenters = [] }) {
  const credits = Number(usageRow.ai_credits_used ?? 0);
  const attribution = attributeUser({
    userId: usageRow.user_id,
    userLogin: usageRow.user_login ?? null,
    organizationId: usageRow.organization_id ?? null,
    teamIds,
    costCenters,
  });

  const row = {
    day: usageRow.day_partition,
    user_id: usageRow.user_id,
    user_login: usageRow.user_login ?? usageRow.user_id,
    cost_center_id: attribution.cost_center_id,
    cost_center_name: attribution.cost_center_name,
    organization_id: usageRow.organization_id ?? null,
    attribution_route: attribution.route,
    ai_credits_used: credits,
    usage_usd: creditsToUsd(credits),
  };
  if (attribution.ambiguous_candidates) {
    row.ambiguous_candidates = attribution.ambiguous_candidates;
    row.ambiguous_stage = attribution.ambiguous_stage;
  }
  return row;
}