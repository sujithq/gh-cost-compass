/**
 * Deterministic fixture generator for the Copilot usage-metrics V0 MVP.
 *
 * Run: node tools/copilot-usage/fixtures/make-fixtures.mjs
 *
 * These fixtures stand in for a real `users-1-day` / `user-teams-1-day` extraction so every stage
 * of the pipeline can be developed and tested without live credentials. They are deliberately
 * shaped to exercise the hard cases called out in docs/copilot-usage-metrics-api-investigation.md:
 *
 * - user-alice  direct cost-centre assignment that must WIN over her team assignment (precedence)
 * - user-bob    resolved via enterprise team
 * - user-carol  resolved via organization, and a mid-period JOINER (2 of 3 seat-days)
 * - user-dave   no resolvable cost centre -> `unallocated`, and a mid-period LEAVER (1 seat-day)
 * - user-erin   holds a seat for the whole period with ZERO usage -> idle seat must still carry
 *               seat cost, which a naive credit-share allocation would wrongly zero out
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toNdjson } from "../contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = join(HERE, "raw");

export const ENTERPRISE_ID = "ent-demo";
export const PERIOD = Object.freeze({ start: "2026-09-16", end: "2026-09-18" });
export const DAYS = Object.freeze(["2026-09-16", "2026-09-17", "2026-09-18"]);

/** Per-user daily credit consumption. A missing day means the user produced no row that day. */
const USAGE = {
  "user-alice": { "2026-09-16": 120, "2026-09-17": 140, "2026-09-18": 160 },
  "user-bob": { "2026-09-16": 20, "2026-09-17": 25, "2026-09-18": 15 },
  "user-carol": { "2026-09-17": 30, "2026-09-18": 40 },
  "user-dave": { "2026-09-16": 10 },
};

const PROFILE = {
  "user-alice": { login: "alice", org: "org-product", phase: "Phase 3" },
  "user-bob": { login: "bob", org: "org-platform", phase: "Phase 2" },
  "user-carol": { login: "carol", org: "org-platform", phase: "Phase 1" },
  "user-dave": { login: "dave", org: "org-product", phase: "Phase 1" },
  "user-erin": { login: "erin", org: "org-platform", phase: "No Cohort" },
};

/**
 * Chat-only model x feature interaction counts. Alice leans on a frontier model for code review -
 * exactly the pattern the "how are they using it" analysis is meant to surface for review.
 */
const MODEL_FEATURE = {
  "user-alice": [
    { model: "gpt-5", feature: "chat", interaction_count: 18 },
    { model: "claude-sonnet-4.5", feature: "code_review", interaction_count: 14 },
    { model: "claude-sonnet-4.5", feature: "coding_agent", interaction_count: 6 },
  ],
  "user-bob": [
    { model: "gpt-5-mini", feature: "chat", interaction_count: 9 },
    { model: "gpt-5", feature: "code_review", interaction_count: 2 },
  ],
  "user-carol": [{ model: "gpt-5-mini", feature: "chat", interaction_count: 12 }],
  "user-dave": [{ model: "gpt-5-mini", feature: "chat", interaction_count: 3 }],
};

/** Effective-dated seat roster. Drives seat-day proration in the allocation stage. */
export const SEATS = [
  { user_id: "user-alice", user_login: "alice", tier: "enterprise", starts_at: "2026-09-01", ends_at: null, organization_id: "org-product" },
  { user_id: "user-bob", user_login: "bob", tier: "business", starts_at: "2026-09-01", ends_at: null, organization_id: "org-platform" },
  { user_id: "user-carol", user_login: "carol", tier: "business", starts_at: "2026-09-17", ends_at: null, organization_id: "org-platform" },
  { user_id: "user-dave", user_login: "dave", tier: "business", starts_at: "2026-09-01", ends_at: "2026-09-16", organization_id: "org-product" },
  { user_id: "user-erin", user_login: "erin", tier: "business", starts_at: "2026-09-01", ends_at: null, organization_id: "org-platform" },
];

/** Enterprise team membership, as returned per day by `user-teams-1-day`. */
const TEAMS = {
  "user-alice": [{ team_id: "team-core", team_name: "Core Platform Team" }],
  "user-bob": [{ team_id: "team-core", team_name: "Core Platform Team" }],
};

/**
 * Cost-centre configuration snapshot. `effective_from` is known here, which lets the pipeline
 * assert that the chosen window lies entirely inside the current configuration.
 */
export const MEMBERSHIP = {
  captured_at: "2026-09-19T08:00:00Z",
  effective_from: "2026-09-15",
  cost_centers: [
    { id: "cc-ai", name: "AI Innovation", user_ids: ["user-alice"], team_ids: [], organization_ids: [] },
    { id: "cc-core", name: "Core Platform", user_ids: [], team_ids: ["team-core"], organization_ids: ["org-platform"] },
  ],
};

function usageRow(userId, day) {
  const credits = USAGE[userId]?.[day];
  if (credits === undefined) return null;
  const profile = PROFILE[userId];
  return {
    day_partition: day,
    entity_id_partition: ENTERPRISE_ID,
    enterprise_id: ENTERPRISE_ID,
    organization_id: profile.org,
    user_id: userId,
    user_login: profile.login,
    ai_credits_used: credits,
    ai_adoption_phase: profile.phase,
    totals_by_model_feature: MODEL_FEATURE[userId] ?? [],
    etl_id: `etl-${day}`,
  };
}

export function buildFixtures() {
  const files = [];
  for (const day of DAYS) {
    const users = Object.keys(PROFILE)
      .map((userId) => usageRow(userId, day))
      .filter(Boolean);
    const userTeams = Object.entries(TEAMS).flatMap(([userId, teams]) =>
      teams.map((team) => ({ day_partition: day, user_id: userId, ...team })),
    );
    files.push({ path: join("raw", `day=${day}`, "users-1-day.ndjson"), rows: users });
    files.push({ path: join("raw", `day=${day}`, "user-teams-1-day.ndjson"), rows: userTeams });
  }
  return files;
}

export function writeFixtures() {
  for (const file of buildFixtures()) {
    const target = join(HERE, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, toNdjson(file.rows), "utf8");
  }
  writeFileSync(join(HERE, "membership.json"), `${JSON.stringify(MEMBERSHIP, null, 2)}\n`, "utf8");
  writeFileSync(join(HERE, "seats.json"), `${JSON.stringify(SEATS, null, 2)}\n`, "utf8");
  return RAW_ROOT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFixtures();
  console.log(`Wrote fixtures under ${HERE}`);
}
