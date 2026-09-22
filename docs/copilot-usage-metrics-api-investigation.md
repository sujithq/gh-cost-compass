# Investigation: GitHub Copilot usage-metrics REST API for cost-centre spend and model-choice analysis

Tracks #66. This is an investigation/design note, not an implementation — Cost Compass still only
*simulates* AI-credit and budget behavior (`src/engine.js`, `scenarios/`). It grounds a future
ingestion effort that pulls real [Copilot usage metrics](https://docs.github.com/en/enterprise-cloud@latest/rest/copilot/copilot-usage-metrics?apiVersion=2026-03-10)
data so cost-centre owners can see not just **how much** they spend but **how** they spend it (for
example, an expensive model used for a task a cheaper model would have handled equally well).

**Billing model scope.** GitHub Copilot for organizations and enterprises is on **usage-based
billing (UBB)**: each Copilot Business/Enterprise seat carries a monthly allotment of **included
AI credits** pooled at the billing-entity level (1,900/seat for Business, 3,900/seat for
Enterprise), and once that shared pool is exhausted, further usage becomes **metered AI credits**
billed at published per-token rates (subject to budgets/spending limits). This matches the model
this repo's engine already simulates. The legacy **premium-request model-multiplier** table
(`.../request-based-billing-legacy/model-multipliers-for-annual-plans`) applies only to pre-UBB
**annual individual plans** retained for backward compatibility — it is **not** the pricing
mechanism for UBB organizations/enterprises and must not be used for cost-centre chargeback.

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

### Chargeback fact: `ai_credits_used` converts to dollars directly, exactly

**Fact-checked against official GitHub docs** ([Usage-based billing for organizations and
enterprises](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing),
[GitHub Copilot billing](https://docs.github.com/en/billing/concepts/product-billing/github-copilot-billing),
[Models and pricing for GitHub Copilot](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)):
**1 AI credit = $0.01 USD**, and "additional usage budgets are set in US dollars … AI credits draw
down the budget at a fixed rate." This is not an approximation layer we invent — it is GitHub's own
conversion rate for both included and metered/paid AI-credit consumption. That means the per-user,
per-day `ai_credits_used` field is **already a direct, exact dollar-chargeable figure**:

```
user_daily_cost_usd = ai_credits_used * 0.01
```

This is the number cost-centre owners should see for chargeback: sum `ai_credits_used * $0.01`
per user, per cost centre, per period — no modeling or estimation required, and no legacy
premium-request multiplier involved. This is the primary chargeback metric this data source should
produce.

### Remaining limitation: no *per-model* breakdown of that dollar total

What `ai_credits_used` does **not** give is a *model-level* split of that already-exact dollar
figure — GitHub's docs state it explicitly: the field is "not broken down by feature, model, or
surface" and is meant for consumption analysis, not a line-item invoice. Answering "how" a
cost centre spends (expensive frontier model on trivial tasks vs. lightweight model on the same
work) therefore still requires estimation, but must use the **current UBB per-token pricing**
tables, not the legacy multiplier:

1. Take the per-user, per-model **interaction counts** from `totals_by_model_feature` /
   `totals_by_language_model` (these carry `model` and `feature`/`language` dimensions with
   `*_count` and `loc_*_sum` metrics — no token counts at the per-model level).
2. Weight each model's share using GitHub's published [per-model, per-token pricing tables](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
   (USD per 1M input/cached-input/cache-write/output tokens, converted to AI credits at the same
   1 credit = $0.01 rate), since heavier/frontier models are priced markedly higher per token than
   lightweight models.
3. Normalize the weighted mix so it sums to the user's **actual, exact** `ai_credits_used` for that
   day — the per-token pricing table drives the *relative split*, while the *total* dollar amount
   always comes from the real `ai_credits_used` figure, never from the model-pricing estimate
   itself. GitHub updates per-model pricing over time, so this reference table must be versioned
   and dated, not hard-coded once.

Any UI surfacing the model-level split must clearly distinguish the **exact, direct** total
chargeback figure from the **estimated** per-model breakdown of it, consistent with this repo's
existing practice of labeling simulator assumptions separately from documented GitHub behavior.

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
  line item, and reconcile it against our own summed `ai_credits_used * $0.01` chargeback total —
  the two should reconcile closely since both derive from the same GitHub-reported AI-credit
  consumption at the documented $0.01/credit rate; a persistent mismatch signals a mapping problem
  (for example, missing cost-centre coverage or an out-of-date included-credit reset) worth
  investigating, not an inherent estimation gap.
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
   cost-centre-joined summary table that computes `ai_credits_used * $0.01` as the exact per-user
   chargeback figure.
2. Add a versioned, dated per-model per-token pricing reference table (from GitHub's
   [Models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
   page) to turn `totals_by_model_feature` interaction counts into an *estimated* model-level split
   of each user's exact `ai_credits_used` total, clearly labeled as an estimate distinct from the
   exact chargeback total.
3. Shape the cost-centre chargeback summary as FOCUS-compatible rows for optional export alongside
   Azure Cost Management data.
4. Extend Cost Compass's existing budget/cost-centre UI to optionally visualize *real* ingested data
   side-by-side with the simulator, reusing the existing cost-centre and budget domain model instead
   of introducing a parallel one.
