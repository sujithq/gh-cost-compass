/**
 * Shared contract for the Copilot usage-metrics V0 MVP pipeline.
 *
 * Every module in `tools/copilot-usage/` builds against the constants and shapes declared here so
 * the extract -> map -> allocate -> report stages can be developed and tested independently.
 *
 * Design rules for this whole toolchain (see docs/copilot-usage-metrics-api-investigation.md):
 * - Dependency-free Node ES modules, consistent with the rest of this repo.
 * - Raw downloaded reports are immutable; every derived value is recomputed from them.
 * - Anything estimated is labeled estimated, and never mixed into an exact total.
 */

/**
 * Documented conversion rate: 1 GitHub AI credit = $0.01 USD, for both included and metered
 * credits. This is GitHub's published rate, not a simulator assumption.
 * https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 */
export const AI_CREDIT_USD = 0.01;

/**
 * Per-seat monthly included AI-credit allowance and list price by Copilot tier.
 *
 * `listPriceUsd` is the published per-seat monthly price and is only used to derive the
 * *synthetic* invoice for demo environments that have no real Azure invoice. Real runs must pass
 * actual invoice figures instead.
 * https://azure.microsoft.com/en-us/pricing/details/githubenterprise/
 */
export const TIERS = Object.freeze({
  business: Object.freeze({ id: "business", includedCreditsPerSeatMonth: 1900, listPriceUsd: 19 }),
  enterprise: Object.freeze({ id: "enterprise", includedCreditsPerSeatMonth: 3900, listPriceUsd: 39 }),
});

/** Report families this MVP fetches. Daily only - the 28-day report cannot be sliced by day. */
export const REPORTS = Object.freeze({
  users: "users-1-day",
  userTeams: "user-teams-1-day",
});

/** Live extraction uses the 28-day report as the exact credit spine, then enriches daily rows. */
export const LIVE_REPORTS = Object.freeze({
  usersSpine: "users-28-day/latest",
  usersDaily: "users-1-day",
  userTeams: "user-teams-1-day",
});

/**
 * Canonical product id for AI credits in this repo's engine/environment model. Keep in sync with
 * `scenarios/environments/*.json`; the engine treats `ai-credits` specially (hard-stop budgets).
 */
export const AI_CREDITS_PRODUCT_ID = "ai-credits";

/** Bucket id used when a user cannot be resolved to a cost centre on a given day. */
export const UNALLOCATED_COST_CENTER_ID = "unallocated";

/** Bucket label used when consumed credits cannot be attributed to any model row. */
export const UNATTRIBUTED_MODEL = "unattributed by model";

/**
 * Precedence order for resolving a user's cost centre on a given day.
 * Earlier entries win. Mirrors section 3 of the investigation doc.
 */
export const COST_CENTER_PRECEDENCE = Object.freeze(["user", "team", "organization"]);

/**
 * @typedef {object} UsageRow                A single row from a `users-1-day` NDJSON report.
 * @property {string} day_partition          `YYYY-MM-DD` day this row covers.
 * @property {string} entity_id_partition    Billing entity partition key (enterprise id).
 * @property {string} enterprise_id
 * @property {string|null} [organization_id]
 * @property {string} user_id                Stable user id. Prefer this over login for joins.
 * @property {string} user_login
 * @property {number} ai_credits_used        Exact credits consumed. NOT broken down by model.
 * @property {ModelFeatureTotal[]} [totals_by_model_feature]
 * @property {string} [ai_adoption_phase]
 * @property {string} [etl_id]
 */

/**
 * @typedef {object} ModelFeatureTotal       Chat-only model x feature interaction counts.
 * @property {string} model                  e.g. "gpt-5", "claude-sonnet-4.5".
 * @property {string} feature                e.g. "chat", "code_review", "coding_agent".
 * @property {number} interaction_count      Interactions. NOT tokens, and NOT credits.
 */

/**
 * @typedef {object} UserTeamRow             A row from a `user-teams-1-day` NDJSON report.
 * @property {string} day_partition
 * @property {string} user_id
 * @property {string} team_id
 * @property {string} [team_name]
 */

/**
 * @typedef {object} SeatRecord              Effective-dated seat assignment, for seat-day proration.
 * @property {string} user_id
 * @property {string} user_login
 * @property {"business"|"enterprise"} tier
 * @property {string} starts_at              `YYYY-MM-DD` inclusive.
 * @property {string|null} ends_at           `YYYY-MM-DD` inclusive, or null if still held.
 * @property {string} [organization_id]
 */

/**
 * @typedef {object} CostCenterDefinition
 * @property {string} id
 * @property {string} name
 * @property {string[]} [user_ids]           Directly assigned users (highest precedence).
 * @property {string[]} [team_ids]           Assigned enterprise teams (middle precedence).
 * @property {string[]} [organization_ids]   Assigned organizations (lowest precedence).
 */

/**
 * @typedef {object} MembershipSnapshot      Cost-centre configuration used for attribution.
 * @property {string} captured_at            ISO timestamp this snapshot was taken.
 * @property {string|null} effective_from    `YYYY-MM-DD` the current config became effective, or
 *                                           null if unknown - which forces point-in-time labeling.
 * @property {CostCenterDefinition[]} cost_centers
 */

/**
 * @typedef {object} ChargebackRow           One user/day row of the derived chargeback table.
 * @property {string} day
 * @property {string} user_id
 * @property {string} user_login
 * @property {string} cost_center_id
 * @property {string} cost_center_name
 * @property {string|null} organization_id
 * @property {"user"|"team"|"organization"|"none"} attribution_route
 * @property {number} ai_credits_used
 * @property {number} usage_usd              Exact: ai_credits_used * AI_CREDIT_USD.
 */

/**
 * @typedef {object} InvoiceInputs           Invoice figures the allocation is performed against.
 * @property {string} billing_entity
 * @property {string} period_start           `YYYY-MM-DD` inclusive.
 * @property {string} period_end             `YYYY-MM-DD` inclusive.
 * @property {Record<string, number>} seatChargeUsdByTier
 * @property {number} meteredChargeUsd
 * @property {"synthetic"|"actual"} kind     `synthetic` MUST be surfaced as illustrative.
 * @property {string[]} assumptions          Human-readable list of every assumed input.
 */

/**
 * @typedef {object} AllocationRow           One user's allocated share of the invoice.
 * @property {string} user_id
 * @property {string} user_login
 * @property {string} cost_center_id
 * @property {number} ai_credits_used
 * @property {number} usage_usd              Exact usage-valued consumption.
 * @property {number} seat_days
 * @property {string|null} tier
 * @property {number} seat_cost_usd          Allocated share of the seat charge.
 * @property {number} metered_cost_usd       Allocated share of the metered charge.
 * @property {number} chargeback_usd         seat_cost_usd + metered_cost_usd.
 */

/**
 * @typedef {object} AllocationResult
 * @property {InvoiceInputs} invoice
 * @property {AllocationRow[]} rows
 * @property {object} totals
 * @property {ConservationCheck[]} checks    Must all pass before a report is emitted.
 */

/**
 * @typedef {object} ConservationCheck
 * @property {string} name
 * @property {boolean} ok
 * @property {string} detail
 */

/** Tolerance for floating-point money comparisons, in USD. */
export const MONEY_EPSILON_USD = 1e-6;

/** Round a USD amount to cents for presentation. Never round before summing. */
export function roundUsd(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** Exact usage-valued consumption for a credit quantity. */
export function creditsToUsd(credits) {
  return Number(credits) * AI_CREDIT_USD;
}

/** True when two USD amounts agree within MONEY_EPSILON_USD. */
export function moneyEquals(a, b) {
  return Math.abs(Number(a) - Number(b)) <= MONEY_EPSILON_USD;
}

/** Assert a `YYYY-MM-DD` date string, throwing a helpful error otherwise. */
export function assertDay(value, label = "date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be a YYYY-MM-DD string, received: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Inclusive list of `YYYY-MM-DD` days between two dates. */
export function eachDay(startDay, endDay) {
  assertDay(startDay, "startDay");
  assertDay(endDay, "endDay");
  if (startDay > endDay) throw new Error(`startDay ${startDay} is after endDay ${endDay}.`);
  const days = [];
  const cursor = new Date(`${startDay}T00:00:00Z`);
  for (;;) {
    const day = cursor.toISOString().slice(0, 10);
    days.push(day);
    if (day >= endDay) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Number of days in `[periodStart, periodEnd]` for which a seat was held.
 * Both the seat record and the period are inclusive on both ends.
 */
export function seatDaysInPeriod(seat, periodStart, periodEnd) {
  assertDay(periodStart, "periodStart");
  assertDay(periodEnd, "periodEnd");
  const from = seat.starts_at > periodStart ? seat.starts_at : periodStart;
  const to = seat.ends_at && seat.ends_at < periodEnd ? seat.ends_at : periodEnd;
  if (from > to) return 0;
  return eachDay(from, to).length;
}

/** Parse NDJSON text into rows, ignoring blank lines. */
export function parseNdjson(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid NDJSON on line ${index + 1}: ${error.message}`);
      }
    });
}

/** Serialize rows to NDJSON text. */
export function toNdjson(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}
