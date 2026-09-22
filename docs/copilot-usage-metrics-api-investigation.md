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

This is the exact **usage-valued consumption** figure per user, per cost centre, per period — no
modeling or estimation required, and no legacy premium-request multiplier involved. Note carefully
that it answers "what did this user consume," which is **not** the same as "what should this user
be charged": because each tier's included credits are prepaid inside the seat price, full chargeback
of the invoiced Copilot cost allocates the seat charge and the metered charge by different drivers.
See the "Allocation model" subsection in §5 for that formula and the conditions under which it
reduces back to this one.

### Remaining limitation: no *per-model* breakdown of that dollar total

What `ai_credits_used` does **not** give is a *model-level* split of that already-exact dollar
figure — GitHub's docs state it explicitly: the field is "not broken down by feature, model, or
surface" and is meant for consumption analysis, not a line-item invoice. Answering "how" a
cost centre spends (frontier model vs. lightweight model for comparable work) therefore requires
an explicit, stated heuristic, using the **current UBB per-token pricing** tables rather than the
legacy multiplier. Be clear about the gap being bridged: the per-model rows carry **interaction
counts**, while pricing is **per token**, split across input / cached-input / cache-write / output
rates. There is no "price per interaction" in the source data, so one must be assumed.

1. Take the per-user, per-model **interaction counts** from `totals_by_model_feature` /
   `totals_by_language_model` (these carry `model` and `feature`/`language` dimensions with
   `*_count` and `loc_*_sum` metrics — no token counts at the per-model level).
2. Derive a documented **cost weight per interaction** for each model: assume an average token
   count per interaction and an input/cached/output token mix (differentiated by `feature`, since a
   chat turn and a completion differ substantially), then price that assumed mix with GitHub's
   published [per-model, per-token pricing tables](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).
   These assumed values are the heuristic — version and date them alongside the pricing table, keep
   them in one reviewable place rather than scattered through code, and publish a sensitivity range
   (for example the split under ±50% assumed tokens per interaction) so readers can see how much of
   the result is assumption rather than data.
3. Normalize the weighted mix so it sums to the user's **actual, exact** `ai_credits_used` for that
   day — the weights drive only the *relative split*, while the *total* dollar amount always comes
   from the real `ai_credits_used` figure, never from the model-pricing estimate itself. Where a
   user's credits cannot be attributed to any model row, surface the remainder as an explicit
   `unattributed by model` bucket rather than spreading it.

If that heuristic cannot be agreed, the honest fallback is to report **model interaction mix only**
(no dollars below the user level) and leave all dollar consumption at the user total — still enough
to see a cost centre favouring frontier models, without implying a precision the data lacks.

Note also what this analysis can and cannot say: the reports show *which model was used for which
feature*, not how complex the task was. "Expensive model on a trivial task" is therefore a
hypothesis this data can *flag for review* (via model mix per feature), not a conclusion it can
prove; pair it with human review or a separate complexity signal before acting on it.

Any UI surfacing the model-level split must clearly distinguish the **exact** user-level
usage-valued figure from the **estimated** per-model breakdown of it, consistent with this repo's
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
  charges, and reconcile against the **fully-loaded cost using AI credits as the allocation key**
  (see the "Allocation model" subsection below). Reconciliation is against the **sum of both Copilot
  charge types** (seat subscription + metered AI credits), not against the metered line alone —
  charging back only the metered line would bill nobody at all while the included pool still has
  headroom, even though real, seat-funded consumption is happening.
- Mirror Azure's tagging convention: assign our derived per-cost-centre rows a `cost_center` tag
  matching Azure's tag-based cost allocation model, so a FinOps toolkit-style chargeback report can
  key off the same tag whether the cost came from Azure resources or from this GitHub Copilot feed.
- Because there is no first-party Azure connector for GitHub Copilot billing detail, this has to be
  a **custom ingestion + FOCUS-shaped export** (e.g. into the same storage account/Data Explorer or
  Power BI dataset the FinOps toolkit's Hubs already reads from), not a marketplace/native
  integration.

### Allocation model: credits are the allocation key, not the invoice total

**Confirmed against official docs** ([GitHub Copilot billing through Azure](https://docs.github.com/en/copilot/reference/copilot-billing/azure-billing),
[Azure GitHub Enterprise pricing](https://azure.microsoft.com/en-us/pricing/details/githubenterprise/)):
Copilot reaches the Azure invoice as **two distinct charge types**, not one:

1. a **seat subscription** charge — "Copilot license usage is measured as the number of active
   seats" — which already includes each tier's monthly AI-credit allowance (Business 1,900 /
   Enterprise 3,900 credits per seat, pooled at the enterprise level); and
2. a **metered GitHub AI Credits** charge — Azure lists "GitHub AI Credits" as its own priced
   component — covering consumption *after* the pooled included allowance is exhausted.

This matters because included credits are **not free** — they are **prepaid inside the seat
price**. So `all ai_credits_used * $0.01` maps cleanly onto *neither* invoice line: part of that
consumption was already bought via the seat charge, the remainder lands on the metered charge.
Reconciling it against the metered line alone is wrong, and so is treating it as the whole invoice.

The correct treatment is the standard FinOps one — allocate the **fully-loaded** cost, but allocate
each charge type by the driver that actually generates it. Allocating *everything* by credit share
is tempting and wrong: it would assign **zero** seat cost to a seated user with no usage, which
inverts the single most valuable finding a chargeback report produces (seats paid for and not
used), and it is undefined when nobody used any credits.

```
# Computed per (billing_entity, invoice_period) partition — never across partitions.

# 1. Seat charge follows seat ownership, prorated by time held.
user_seat_cost  = seat_charge_for_tier * (user_seat_days_in_tier / total_seat_days_in_tier)

# 2. Metered charge follows consumption, because that is what caused it.
user_metered    = metered_ai_credit_charge * (user_ai_credits_used / entity_ai_credits_used)

user_chargeback = user_seat_cost + user_metered
```

Required definitions for this to be well-posed:

- **Partition first.** `seat_charge`, `metered_ai_credit_charge`, and both denominators must come
  from the *same* billing entity and invoice period. Never mix billing profiles, tiers, currencies,
  or invoice months into one ratio. For a report spanning multiple invoice periods, allocate within
  each period and only then sum the results.
- **Seat-days, not seat counts**, so mid-period joiners/leavers and tier changes prorate correctly;
  allocate per tier, since Business and Enterprise seats differ in both price and included credits.
- **Zero-usage guard.** If `entity_ai_credits_used == 0`, the metered charge is necessarily zero
  too, so `user_metered = 0`; never evaluate the ratio. Chargeback that period is purely seat cost.
- **Usage without a current seat** (a user who consumed credits and then lost their seat, or whose
  login changed) must still be attributed — keep a stable user identity key and effective-dated
  seat records rather than joining to today's seat roster.

Two properties worth stating explicitly:

- **Allocation conserves the invoice by construction**: per partition, allocated seat cost sums to
  the seat charge and allocated metered cost sums to the metered charge. Note carefully what this
  check does **not** prove — see the completeness caveat below.
- **It degrades gracefully as included credits go away.** If GitHub moves toward pure metered
  consumption, the seat component shrinks and the metered component becomes the whole invoice. In
  the limiting case where the seat charge reaches zero *and* the metered charge equals
  `entity_ai_credits_used * $0.01`, the formula reduces to exactly `user_ai_credits_used * $0.01`.
  Both conditions are required — "included credits go away" does not by itself imply the seat
  subscription disappears — but the pipeline shape does not change either way, so building the
  allocation model now makes that transition a parameter change rather than a migration.

**Conservation is not completeness.** Because the denominator is computed from the rows actually
ingested, allocated shares always sum to the invoice *even if users or whole days are missing* —
the missing users' cost is silently redistributed onto everyone else. The sums-to-invoice assertion
is an **allocation-conservation** check, not a source-completeness check. Completeness needs
independent controls, checked *before* allocation:

- compare the summed per-user daily credits against an independently fetched entity-level daily
  total, and fail on divergence beyond a stated tolerance;
- keep an expected-day extraction manifest so a missing ingestion day is an explicit gap, not an
  implicit zero;
- assert unique source keys and expected row counts per downloaded report;
- report the `unallocated` (no resolvable cost centre) bucket as a visible measure with an agreed
  acceptable threshold, rather than letting it vanish into the normalization.

Report both measures side by side so the difference stays visible and explainable:
`usage-valued consumption` (`ai_credits_used * $0.01`, what the user actually consumed) and
`allocated chargeback` (seat + metered share of the fully-loaded invoice). For a seat-holder with
little usage the second exceeds the first — that gap **is** the story a cost-centre owner needs,
and the seat-days component above is what keeps it visible.

## 6. Related prior art

Three existing efforts are relevant but solve different, largely independent problems — they
should be *referenced*, not folded into a single deliverable:

- **[amgdy/copilot-finops-automation](https://github.com/amgdy/copilot-finops-automation)** —
  config-as-code GitHub Action that **writes** AI-credit budgets (all-users, user, cost-centre,
  team, organization, enterprise scopes) into GitHub from a version-controlled YAML file, validated
  and applied idempotently on a schedule. This is a **governance/control-plane** tool: it sets
  budgets. Our work here is the **reporting/observability** side: reading back what actually
  happened against those budgets. The two are complementary and could close a loop later (§7,
  V3) but are separate concerns — this repo should not attempt to reimplement budget-writing.
- **[Implementing FinOps guide / FinOps Framework overview](https://learn.microsoft.com/en-us/cloud-computing/finops/framework/finops-framework)
  and [Adopt FinOps on Azure](https://learn.microsoft.com/en-us/training/modules/adopt-finops-on-azure/)
  (Microsoft Learn)** — the general FinOps operating-model framing (inform/optimize/operate phases,
  allocation, unit economics, anomaly management). Useful as the maturity vocabulary for describing
  which phase each version below reaches; not something to build, just a lens to apply.
- **["Who Ordered All These Tokens? Giving AI Spend a Name in FOCUS"](https://techcommunity.microsoft.com/blog/finopsblog/who-ordered-all-these-tokens-giving-ai-spend-a-name-in-focus/4547978)
  (Microsoft FinOps blog)** — its core contribution is that FOCUS/Azure meter metadata alone
  doesn't carry who-used-it/why attribution for AI and token spend, and proposes a customer-owned
  pattern for augmenting cost data with those attribution dimensions rather than waiting for a
  vendor-provided one. That supports (but does not itself establish) why cost-centre and per-user
  attribution (§3) is the point of this work, not an afterthought — every version below should
  preserve a `user_login` → `cost_center` → business-owner chain alongside the dollar figures,
  using our own attribution dimensions the way the post recommends, rather than a dollar total
  alone.

These inform the roadmap below without dictating its shape: the automation tool is out of scope for
this repo, the FinOps guide supplies maturity language, and the FOCUS blog post is a design
principle (always attribute spend to a name) applied throughout every version.

## 7. Roadmap toward a chargeback breakdown report

Goal shape: a "charge breakdown"-style flow report (see the reference Azure Cost Management
screenshot in the originating conversation) that lets a FinOps/cost-centre owner drill from total
GitHub Copilot spend down through cost centre → user → feature/surface → model, in **AI credits and
US dollars**, alongside (ideally in the same pane as) native Azure Cost Management data. Each
version below is independently shippable and builds only on what the previous version already
proved; do not skip straight to a later version without the data-quality checks from earlier ones.

### V0 — Manual 28-day export and wrangle (spreadsheet/Power BI Desktop, no infra)

Goal: prove the report shape and the cost-centre join with the least possible infrastructure, using
data already in hand. **This version is explicitly a current-membership, point-in-time attribution
prototype, not a historically correct chargeback** — see the caveat below.

- Call `GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest` once, by hand
  or with a small script, and download the NDJSON.
- Fetch **current** cost-centre membership from GitHub's cost-centre APIs and join it onto
  `user_id` in a spreadsheet or a short Python/Node script (no scheduling, no storage — this run is
  disposable and re-fetched each time it's needed).
- Compute the exact usage-valued consumption figure per user (summed over the 28-day window):
  `ai_credits_used * $0.01`, roll up to cost-centre and enterprise totals using **today's**
  membership snapshot.
- Compute the *estimated* per-model split (§2) from `totals_by_model_feature`, using the stated
  per-interaction cost-weight heuristic, purely to flag the "frontier model on simple work" question —
  clearly labeled as an estimate in any output.
- Visualize/share as a single Power BI Desktop `.pbix` (or Excel workbook) with a Sankey/decomposition
  visual mirroring the reference screenshot's flow (cost centre → user → feature → model), published
  manually (for example a shared workspace link or exported PDF) — no automated refresh yet.
- **Exit criteria**: a real, once-off report a cost-centre owner can read and trust the dollar
  total on **for users whose cost-centre membership did not change during the window**. This
  validates the join and the visual shape before investing in a pipeline.
- **Known gap accepted at this version**: no history (28-day window only, lost once superseded),
  manual re-run, no reconciliation against actual Azure invoice line items, and — importantly —
  **no historically correct attribution**: joining today's membership snapshot against a rolling
  28-day activity total silently misattributes any user whose cost-centre or team assignment
  changed within that window (the same problem GitHub's own docs flag for the daily user-teams
  join, §3). State this limitation directly in the V0 report rather than presenting the cost-centre
  totals as exact for every user. V1 addresses it by moving to daily, per-day-dated joins.

### V1 — Scheduled ingestion into Fabric/ADLS, Power BI report with refresh

Goal: turn the V0 proof into a maintained, historical, refreshable report using the documented
[Fabric workspace for FinOps](https://learn.microsoft.com/en-us/cloud-computing/finops/fabric/create-fabric-workspace-finops)
pattern, so Copilot data lives beside native Azure cost data instead of a one-off file, and to fix
V0's point-in-time attribution problem by joining daily.

- **Backfill first**: before turning on steady-state daily ingestion, fetch and land every daily
  `users-1-day` and `user-teams-1-day` report available under GitHub's 1-year retention (§4), so
  the report has real history from day one instead of only accumulating from deployment onward.
  Record, per day, whether extraction succeeded, so report UIs can show explicit coverage gaps
  rather than silently rendering a zero.
- Stand up (or reuse, if [FinOps hubs](https://learn.microsoft.com/en-us/cloud-computing/finops/toolkit/hubs/finops-hubs-overview)
  are already deployed) an Azure Data Lake Storage Gen2 account and a Fabric workspace, per the
  guide's prerequisites and steps.
- Build a small scheduled job (Azure Automation, a Function, or a GitHub Actions workflow — pick
  whichever this org already operates for similar jobs) that daily calls `users-1-day` and
  `user-teams-1-day`, downloads the signed NDJSON links immediately (they expire), and lands the
  raw files in ADLS under a dated, immutable path (`.../copilot-usage/day=YYYY-MM-DD/...`).
- Define an explicit, **versioned, effective-dated attribution bridge** before the Lakehouse upsert
  step — this is what actually fixes V0's misattribution gap, not just switching to daily data:
  join each day's per-user activity against **that same day's** cost-centre/team membership (never
  a later snapshot), apply the engine's existing precedence rule (direct user → enterprise-team →
  organization fallback, §3) when a user has more than one route to a cost centre, route any user
  with no resolvable cost centre that day into an explicit "unallocated" bucket rather than dropping
  or double-counting them, and enforce the invariant that
  `sum(allocated cost-centre rows) + sum(unallocated rows) == sum(source per-user total)` for every
  day as a pipeline data-quality check.
- Add a Fabric pipeline/notebook step that applies that bridge, computes `ai_credits_used * $0.01`
  per user/day, upserts into a Lakehouse table keyed by `(day_partition, entity_id_partition,
  user_id)` (idempotent — §4), and computes the per-model estimated split as a separate,
  clearly-labeled table.
- Build the Power BI report against the Lakehouse tables reproducing the V0 visual, now with a real
  date-range filter and automatic refresh instead of a single static snapshot. State the actual
  data-coverage start date in the report (from the backfill step) so "arbitrary past date range"
  means "any date within the recorded coverage window," not literally unbounded history.
- In parallel, set up an Azure Cost Management **FOCUS-format export** to the same ADLS account
  (per the same Fabric guide) so native Azure spend is queryable from the same workspace.
- **Exit criteria**: the report refreshes on a schedule, retains history beyond any single 28-day
  window, and a cost-centre owner can pick an arbitrary past date range.
- **Known gap accepted at this version**: Copilot data and native Azure FOCUS export data sit in
  the same workspace but are not yet a single joined/reconciled model.

### V2 — FOCUS-shaped Copilot data joined with native Azure cost export

Goal: make GitHub Copilot spend a first-class row type in the same FOCUS-shaped dataset as native
Azure costs, so the reference screenshot's charge-breakdown flow can include a Copilot branch
alongside `Compute`/`Storage`/etc., and so a per-cost-centre chargeback total is a single query
across both sources.

- Shape the upserted Copilot table from V1 into FOCUS-compatible columns (`ServiceCategory`,
  `ServiceName`, `ChargeCategory`, `BilledCost`/`EffectiveCost`, `x_...` extension columns for
  GitHub-specific dimensions such as `user_login`, `cost_center`, `model`, `feature`), consistent
  with how the Azure FOCUS export already shapes native costs, per FOCUS Foundation guidance
  referenced by the Fabric guide.
- Reconcile against the Azure invoice using the **allocation model from §5**: sum the invoiced
  Copilot seat-subscription charge and the metered AI-credit charge from the FOCUS export, allocate
  that fully-loaded total across users by their `ai_credits_used` share, and assert that allocated
  shares sum back to the invoiced total (a by-construction check that catches missing users,
  unmapped cost centres, or a dropped ingestion day). Carry `usage-valued consumption` alongside
  `allocated chargeback` as separate measures so the included-pool gap stays visible rather than
  being averaged away.
- Extend the Power BI report so the existing charge-breakdown Sankey (cost centre → service →
  ...) includes GitHub Copilot as a service branch that further decomposes into user → feature →
  model, matching the reference screenshot's drill pattern end to end — but keep the exactness
  boundary visible in the visual itself: the cost-centre → user levels carry the **exact**
  `ai_credits_used`-derived dollar figure, while the user → feature → model levels are an
  **estimated allocation** of that same total (§2) that may not fully cover it (for example, CLI or
  Copilot-app usage without a per-model breakdown). Add an explicit "unattributed by
  model/feature" node so the estimated branches never silently imply more precision than the
  source data supports, and never let a downstream estimated node be read as an independent
  invoice-equivalent figure.
- Attribute every row to a `user_login`/`cost_center`/business-owner name, not just a dollar figure
  (the FOCUS-blog naming principle, §6) so finance can answer "who" as easily as "how much."
- **Exit criteria**: one Power BI model, one charge-breakdown report, native Azure and GitHub
  Copilot costs both present, the fully-loaded Copilot cost allocated by credit share and
  reconciling by construction to the invoiced total, and cost-centre attribution end to end down to
  the exact user-level credit figure.
- **Known gap accepted at this version**: reporting only — budgets are still configured manually
  in GitHub, with no closed-loop connection back to what the report reveals.

### V3 (stretch) — Closed-loop governance using the report's findings

Goal: use what V2 reveals (for example, a cost centre consistently choosing expensive models for
low-complexity tasks) to actually adjust budget policy, closing the loop between observability and
control.

- Feed V2's per-cost-centre/model findings into a review process that proposes changes to
  `config/copilot-finops.yml` (the config format used by
  [amgdy/copilot-finops-automation](https://github.com/amgdy/copilot-finops-automation)) — for
  example, tightening a cost centre's budget or flagging it for a model-choice conversation —
  reviewed and merged as a normal pull request, consistent with that tool's config-as-code model.
  Cost Compass does not need to run or fork that Action; it only needs to produce evidence that
  makes a good budget-change PR easy to write.
- Consider whether Cost Compass's own simulator (`src/engine.js`) should ingest V2's real
  cost-centre/model data as an alternative "seed" so a cost-centre owner can simulate the effect of
  a proposed budget change *before* it's applied for real, using this repo's existing scenario
  machinery instead of a new one.
- **Exit criteria**: a documented, human-reviewed path from "the report shows a problem" to "the
  budget config PR that addresses it," not full automatic enforcement.

## 8. Suggested next steps (follow-up implementation issues)

File the roadmap above as separate, sequential implementation issues (one per version) rather than
one large issue, so each can be scoped, reviewed, and shipped independently:

1. **V0 issue**: one-off script/notebook + a shareable Power BI/Excel report reproducing the
   reference charge-breakdown visual from a manual 28-day export, cost-centre joined against
   current membership, exact `ai_credits_used * $0.01` totals plus a clearly-labeled estimated
   model split, with the point-in-time attribution limitation stated in the report.
2. **V1 issue**: backfill of available daily history, scheduled daily ingestion into ADLS/Fabric,
   an effective-dated cost-centre attribution bridge with an unallocated bucket and a reconciling
   invariant check, idempotent upsert pipeline, refreshable Power BI report, Azure FOCUS export
   configured alongside it.
3. **V2 issue**: FOCUS-shaped Copilot rows joined with the native Azure FOCUS export in one model,
   fully-loaded cost (seat + metered AI credits) allocated by credit share with a
   sums-to-invoice reconciliation assertion, single cross-source
   charge-breakdown report with the exact/estimated boundary visible in the Sankey. This issue also
   extends Cost Compass's existing budget/cost-centre UI to optionally visualize the ingested,
   reconciled data side-by-side with the simulator, reusing the existing cost-centre and budget
   domain model instead of introducing a parallel one — natural here because it is the first
   version with a trustworthy, reconciled dataset to visualize.
4. **V3 issue (stretch)**: a documented review workflow linking V2 findings to
   `copilot-finops-automation` config changes, and an exploration of feeding real data into
   Cost Compass's existing simulator as an optional seed.

## 9. MVP execution plan (V0 against the demo enterprise)

This is the fastest concrete path to something real and demonstrable: extract live data from a
**demo GitHub Enterprise environment** (Alex's demo account) and produce a cost-centre chargeback
breakdown from it. Everything here is V0 scope — no Azure, no Fabric, no pipeline.

### Why a "last few days" snapshot, deliberately

The demo enterprise has been used for hands-on experimentation with cost centres, groupings, and
budgets, so its historical shape does **not** cleanly resemble
`enterprise -> org -> cost centre -> user`. Two consequences drive the MVP design:

- **Use a short, recent window (roughly the last 3–7 days), not the 28-day report.** The recent days
  are the most likely to reflect the current, intentional cost-centre setup; older days in the same
  28-day rolling total were produced under different groupings and would misattribute. Note the
  limit of this reasoning honestly: a shorter window *reduces* the chance that configuration
  changed mid-window, it does not *establish* that it didn't. Step 1 below turns that into an
  explicit check rather than an assumption.
- **Pull daily reports, not the 28-day report.** `users-1-day` gives per-day rows we can filter to
  exactly the days we trust; the 28-day report returns a single pre-aggregated window we cannot
  slice. This also means the MVP already uses the same endpoint V1 will schedule — no throwaway.

Record the chosen window explicitly in the output so no one reads the MVP as a full-period bill.

### Step 1 — Access and preflight (blocking; do this first)

Verify before writing any transformation code, because everything downstream depends on it:

- Confirm which **enterprise slug** to use and that the demo account has the enterprise-level
  permission required by the usage-metrics endpoints (§1).
- Confirm a token/credential with the required scope, held outside the repo (environment variable
  or local file ignored by git) — never committed, consistent with this repo's practices.
- Make one throwaway call to `GET /enterprises/{enterprise}/copilot/metrics/reports/users-1-day`
  for a recent date and confirm a report is returned, then immediately follow the signed download
  link (§1 — these expire quickly). Do the same for `user-teams-1-day`, which Step 3's precedence
  join needs and which is easy to discover missing only after the transformation is written.
- Confirm at least one day in the window actually contains non-zero `ai_credits_used`. Demo
  environments often have sparse usage; discovering an empty window after building the pipeline is
  the single most likely way this MVP stalls.
- Confirm cost-centre membership is retrievable for the same enterprise **for all three assignment
  routes** used by the §3 precedence rule (direct user, enterprise team, organization), and that
  the organization/user identifiers needed to join them are present in the usage rows.
- Confirm at least one cost centre currently contains Alex and at least one other user — a
  one-user cost centre cannot demonstrate a breakdown.
- **Establish the window's attribution validity**: determine when the current cost-centre
  configuration became effective, and pick the window to start after that point. If that date
  cannot be established from the demo environment's history, say so and label the output's
  cost-centre totals as *point-in-time attribution*, not exact — do not let a short window
  silently imply historical correctness.

**Exit gate**: raw NDJSON for at least one recent day, with non-zero credits, plus current
cost-centre membership across all three assignment routes, plus either a confirmed
configuration-effective date or an explicit decision to label attribution as point-in-time. Do not
proceed without these; if usage or cost-centre assignments are missing, fix the demo environment
(generate usage / assign cost centres) before writing code.

### Step 2 — Extract and land raw files

- A small, dependency-free Node script (consistent with this repo's architecture) that takes a date
  range, calls `users-1-day` and `user-teams-1-day` per day, downloads the signed links, and writes
  raw NDJSON to a local, git-ignored folder as `day=YYYY-MM-DD/<report>.ndjson`.
- Keep raw files untouched and re-runnable: transformation reads from disk, never re-fetches. This
  makes iteration fast and avoids burning signed links during development.
- Same dated-path convention V1 will use in ADLS, so the V1 move is a destination change, not a
  rewrite.

### Step 3 — Transform to the chargeback table

- Join each day's per-user rows to cost-centre membership (current snapshot is acceptable **only**
  because the window is deliberately short — state this in the output).
- Apply the precedence rule from §3 (direct user -> enterprise team -> organization) and route
  unresolvable users to an explicit `unallocated` bucket.
- Emit one tidy table: `day, user_login, cost_center, org, ai_credits_used, usage_usd`, where
  `usage_usd = ai_credits_used * 0.01`.
- Assert the invariant from §7 V1: allocated + unallocated must equal the source total per day.
  Fail loudly rather than emitting a quietly-wrong number. Remember this is an allocation-conservation
  check, not a completeness check (§5) — also assert that every expected day in the window produced
  a file, so a failed download surfaces as a gap rather than a silent zero.
- Emit a second, separately-labeled table for the estimated per-model split from
  `totals_by_model_feature` (§2) — this is what answers "expensive model on a trivial task."

### Step 4 — Chargeback figures for the demo

The demo enterprise has **no real Azure invoice**, so the allocation model (§5) runs on an
explicitly **synthetic** invoice. Do run it — the point is to prove the mechanics end to end so
swapping in a real invoice later is a parameter change, not a redesign — but keep the assumed
inputs internally consistent rather than three independently invented numbers:

- Compute `usage_usd` directly (exact, needs nothing external).
- Derive the synthetic invoice from the demo's own data so it cannot describe an impossible
  scenario: take the actual seated users per tier, multiply by that tier's list price to get the
  assumed seat charge, compute the implied included pool (seats × tier allowance), and set the
  assumed metered charge to the observed consumption *above* that pool (zero if the pool covers
  it). State every input on the report.
- Compute `allocated chargeback` = seat component (by seat-days per tier) + metered component (by
  credit share), per §5.
- Label the result **"illustrative allocated chargeback (synthetic invoice)"** everywhere it
  appears. It validates the formula and the visual; it is not a reconciled figure, and the MVP
  should not claim otherwise.
- Show both measures side by side so the seat-cost-versus-usage gap is visible — for a demo
  audience this contrast is usually the most persuasive part.

### Step 5 — Visualize and share

Pick **one** deliverable and match the definition of done to it. Recommended for speed and
reviewability:

- **Primary**: the command writes tidy CSV/JSON tables plus a **self-contained static HTML report**
  (no dependencies, consistent with this repo's architecture) rendering the cost centre → user →
  feature → model flow. One command, one artifact, trivially shareable — no Power BI licence or
  manual refresh needed for a demo.
- **Optional follow-on**: point a Power BI Desktop file at the same emitted tables if a
  Power BI-native artifact is wanted for the customer conversation. Treat this as a second,
  manual step, not part of the one-command flow.
- Keep the exactness boundary visible per §7 V2: the cost centre → user levels are exact
  usage-valued figures; the user → feature → model levels are the labeled estimate, with an
  "unattributed by model" node.
- Annotate the window dates, the configuration-validity finding from Step 1, the demo-environment
  caveat, and the synthetic invoice inputs directly on the report surface, not only in a separate
  doc.

### Definition of done for the MVP

A reviewer can run one command against the demo enterprise and get a dated, self-contained report
showing per-cost-centre usage-valued dollars, per-user drill-down, an illustrative allocated
chargeback from the synthetic invoice, and a labeled model-mix estimate — with the window,
allocation formula, and all assumptions visible on the report surface.

What this validates: the extraction, the cost-centre join, the allocation mechanics, and the
report shape. What it explicitly does **not** validate: reconciliation against a real invoice
(there isn't one) or historically exact attribution (bounded by the Step 1 finding). Both are V1/V2
work. Stating this boundary is part of being done, not a caveat to bury.

### Sequencing note

Steps 1 and 5 carry the risk; steps 2–4 are mechanical. Do Step 1 immediately and, once data is
confirmed, sketch the Step 5 visual against a tiny hand-made sample **in parallel** with building
Steps 2–4, so the report shape is agreed before the real data lands in it.
