# Investigation: GitHub Copilot usage-metrics REST API for cost-centre spend and model-choice analysis

Tracks #66. This is an investigation/design note, not an implementation — Cost Compass still only
*simulates* AI-credit and budget behavior (`src/engine.js`, `scenarios/`). It grounds a future
ingestion effort that pulls real [Copilot usage metrics](https://docs.github.com/en/enterprise-cloud@latest/rest/copilot/copilot-usage-metrics?apiVersion=2026-03-10)
data so cost-centre owners can see not just **how much** they spend but **how** they spend it (for
example, an expensive model used for a task a cheaper model would have handled equally well).

## 1. Report families and how to fetch them

Each endpoint returns a small JSON envelope of signed, time-limited `download_links` to NDJSON
files — the actual rows are never returned inline. All endpoints require the "Copilot usage
metrics" enterprise policy to be **Enabled everywhere**.

| Report family | Endpoint(s) | Scope | Granularity |
| --- | --- | --- | --- |
| Aggregated entity | `.../metrics/reports/{enterprise-\|organization-}1-day`, `.../{enterprise-\|organization-}28-day/latest` | One row per enterprise/org/day | Daily, or latest rolling 28-day |
| Per-user | `.../metrics/reports/users-1-day`, `.../users-28-day/latest` | One row per user/day | Daily, or latest rolling 28-day |
| Per-repository | `.../metrics/reports/repos-1-day` | One row per repo with PR activity that day (Copilot Coding Agent / Copilot Code Review breakdowns) | Daily only |
| User-teams | `.../metrics/reports/user-teams-1-day` | One row per (user, team) membership pair | Daily only; used to derive team-level metrics by joining with the per-user report on the same day |
| Usage records (public preview, EMU only) | `/enterprises/{enterprise}/copilot/usage-records` | Per-request/response session-level audit records, cursor-paginated | Real-time-ish, not day-bucketed |

Organization-scope reports add `organization_id` alongside `enterprise_id`. Daily reports are
available from **2025-10-10** onward with up to **1 year** of history; the 28-day endpoints only
ever return the **latest** window — there is no historical 28-day date parameter.

## 2. Data points relevant to "how" Copilot is used

Per-user (and aggregated) reports carry, in addition to `ai_credits_used`:

- **Feature/surface breakdowns**: `totals_by_feature`, `totals_by_ide`, `totals_by_language_feature`
  — code completion vs. chat vs. `copilot_app` vs. CLI, per language, with
  `code_generation_activity_count`, `code_acceptance_activity_count`, `loc_added_sum` /
  `loc_deleted_sum` / `loc_suggested_to_add_sum` / `loc_suggested_to_delete_sum`.
- **Model breakdowns (chat only)**: `totals_by_model_feature` (model × feature interaction counts)
  and `totals_by_language_model` (model × language). These are the key fields for "expensive model
  used for a simple task" analysis — they show *which* model was used for *which* kind of work.
- **Agent/tooling breakdowns**: `totals_by_custom_agent`, `totals_by_3rd_party_agent` (e.g. Claude,
  Codex), `totals_by_mcp`, `totals_by_skill`, `totals_by_slash_cmd`, plus CLI/token metrics in
  `totals_by_cli` and `totals_by_copilot_app` (`prompt_count`, `request_count`, `session_count`,
  `token_usage`).
- **Boolean surface flags**: `used_agent`, `used_chat`, `used_cli`, `used_copilot_app`,
  `used_copilot_cloud_agent`/`used_copilot_coding_agent`, `used_copilot_code_review_active` /
  `_passive` — cheap adoption/engagement signals without parsing breakdown arrays.
- **Adoption cohort**: `ai_adoption_phase` (Phase 1–3 / No Cohort) — useful to correlate spend
  against demonstrated engagement depth, not just presence.
- **Repository/PR outcomes**: aggregated `pull_requests` (created/reviewed/merged, Copilot-authored
  vs. reviewed, median minutes to merge) and the per-repo report — useful to correlate cost against
  delivered outcomes, echoing the "Impact dashboard" cohort methodology.

### Key limitation: no direct per-model dollar cost

`ai_credits_used` is a **per-user/day total only** — GitHub's docs state explicitly it is "not
broken down by feature, model, or surface" and is meant for consumption analysis, not invoicing.
There is no field that gives "credits spent on model X". To estimate per-model spend we must:

1. Take the per-user, per-model **interaction counts** from `totals_by_model_feature` /
   `totals_by_language_model`.
2. Weight them by GitHub's published [premium-request model multipliers](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/model-multipliers-for-annual-plans)
   (e.g. lightweight models ≈0.25–0.33×, mid-tier ≈3–9×, frontier/expensive models ≈14–57×).
3. Normalize the weighted mix against the user's actual `ai_credits_used` for that day/user so the
   estimate is proportional, not an independent invoice figure — model multipliers can change over
   time and must be version-tracked, not hard-coded once.

This estimation approach (not a literal per-model cost readout) should be called out explicitly
anywhere it surfaces in the UI, consistent with this repo's existing practice of labeling simulator
assumptions separately from documented GitHub behavior.

## 3. Cost-centre attribution

The usage-metrics reports carry `user_id`/`user_login` and `organization_id`/`enterprise_id`, but
**no cost-centre field**. Cost-centre membership must be fetched separately (GitHub's
[cost centers](https://docs.github.com/en/billing/concepts/cost-centers) APIs list which
users/teams/orgs are assigned to which cost centre) and joined in our own storage by `user_id` —
mirroring the same attribution precedence this repo's engine already models (direct user →
enterprise-team → organization fallback; see `docs/ai-credit-control-model.md`). Team-level
attribution additionally requires joining the daily `user-teams` report with the daily per-user
report on `(user_id, day, org/enterprise_id)` — GitHub's own docs warn against joining a single-day
team snapshot against a rolling 28-day activity window, since membership changes mid-window would
misattribute activity.

## 4. Granularity and storage implications

- **Daily (`*-1-day`) reports are the only source with real history** (up to 1 year); they are the
  correct basis for building our own rolling windows, monthly cost-centre roll-ups, and trend lines.
- **28-day (`*-28-day/latest`) reports only ever return the current rolling window.** They are
  convenient for a "current state" dashboard call but cannot reconstruct history — if we rely on
  them exclusively we permanently lose any window once it rolls off.
- Because of this, **we must ingest and durably store the daily reports ourselves** rather than
  re-fetching on demand: GitHub's download links are signed and expire quickly, and the 1-year
  daily lookback is a rolling limit, not a permanent archive.
- Each record carries housekeeping/partition fields (`day_partition`, `etl_id`,
  `entity_id_partition`) specifically for this purpose — store extracted rows keyed by
  `(day_partition, entity_id_partition, user_id/repo/team)` and **upsert idempotently per day**
  rather than blindly appending, since GitHub's own reconciliation guidance acknowledges gaps/late
  data can appear across dashboards, APIs, and exports. A safe extraction design is: land raw
  NDJSON immutably per calendar day (audit trail), then materialize an upserted, cost-centre-joined
  table from it for querying.
- The preview `usage-records` endpoint (EMU-only, session/request-level, cursor-paginated, "subject
  to change") is a higher-fidelity phase-2 source for deep drill-down, but is not day-bucketed and
  should not be the primary ingestion path yet given its preview status.

## 5. Linking to Azure cost-controlling functionality

When Copilot licensing is billed through an Azure subscription, GitHub sends metered usage to
Azure and it appears as a line item on the Azure invoice — but that line item is an **aggregate
dollar figure**, not broken down per user, cost centre, or model. Azure Cost Management has no
native visibility into GitHub's internal cost-centre/user/model attribution, so real attribution
must come from the GitHub APIs above, not from Azure billing data itself. To surface it alongside
Azure spend for FinOps teams:

- **Treat GitHub Copilot as an external/SaaS cost source** and shape our derived cost-centre/model
  spend data to the [FOCUS (FinOps Open Cost and Usage Specification)](https://microsoft.github.io/finops-toolkit/)
  schema used by the [Microsoft FinOps toolkit](https://github.com/microsoft/finops-toolkit), so it
  can sit next to native Azure Cost Management exports in the same reporting/chargeback pipeline
  rather than requiring a separate dashboard.
- Use **Azure Cost Management exports** (to storage) for the actual invoiced Azure-side Copilot
  line item, and reconcile it against our own summed `ai_credits_used`-derived estimate as a
  sanity check — the two will not match exactly (Azure sees the invoice total, we see modeled
  per-user/model consumption), but large deltas signal a mapping problem worth investigating.
- Mirror Azure's tagging convention: assign our derived per-cost-centre rows a `cost_center` tag
  matching Azure's tag-based cost allocation model, so a FinOps toolkit-style chargeback report can
  key off the same tag whether the cost came from Azure resources or from this GitHub Copilot feed.
- Because there is no first-party Azure connector for GitHub Copilot billing detail, this has to be
  a **custom ingestion + FOCUS-shaped export** (e.g. into the same storage account/Data Explorer or
  Power BI dataset the FinOps toolkit's Hubs already reads from), not a marketplace/native
  integration.

## 6. Suggested next steps (follow-up implementation issue)

1. Build a scheduled daily job that calls the `users-1-day` and `user-teams-1-day` endpoints per
   enterprise/org, downloads the NDJSON, and lands it immutably (raw) plus an idempotently-upserted,
   cost-centre-joined summary table.
2. Add a model-multiplier reference table (versioned, since GitHub updates multipliers) to turn
   `totals_by_model_feature` interaction counts into an estimated spend split, clearly labeled as an
   estimate.
3. Shape the cost-centre/model summary as FOCUS-compatible rows for optional export alongside Azure
   Cost Management data.
4. Extend Cost Compass's existing budget/cost-centre UI to optionally visualize *real* ingested data
   side-by-side with the simulator, reusing the existing cost-centre and budget domain model instead
   of introducing a parallel one.
