# Copilot usage-metrics chargeback (V0 MVP)

A dependency-free pipeline that turns GitHub's Copilot usage-metrics reports into a cost-centre
chargeback view, plus an estimated model/feature mix showing *how* Copilot is being used.

This is **V0** of the roadmap in
[`docs/copilot-usage-metrics-api-investigation.md`](../../docs/copilot-usage-metrics-api-investigation.md),
which is the canonical methodology reference. Read §5 (allocation model) before interpreting any output.

## Try it now, without credentials

```bash
npm run usage-report -- --from-fixtures
```

This runs the entire pipeline offline against a bundled sample extraction and writes
`.copilot-usage-out/report.html` (self-contained, no remote assets) plus tidy CSV/JSON tables.

## Run it against a real enterprise

```bash
export GITHUB_TOKEN=<token with enterprise billing read access>
npm run usage-report -- --enterprise <slug> --start 2026-09-16 --end 2026-09-18
```

The token is read from the environment only. It is never accepted as a command-line argument and is
never written to any output file.

### Options

| Flag | Meaning |
| --- | --- |
| `--from-fixtures` | Run offline against the bundled sample extraction. |
| `--enterprise <slug>` | Enterprise slug to extract. |
| `--start` / `--end` | Inclusive day window (`YYYY-MM-DD`). |
| `--membership <path>` | Cost-centre membership snapshot JSON. |
| `--seats <path>` | Seat roster JSON. |
| `--invoice <path>` | Real invoice JSON. Omit to derive an explicitly-labelled **synthetic** invoice. Its `period_start`/`period_end` must match the extracted window — see below. |
| `--out <dir>` | Output directory (default `.copilot-usage-out`, git-ignored). |
| `--raw <dir>` | Where raw NDJSON is landed or read from. |
| `--token-env <VAR>` | Env var holding the token (default `GITHUB_TOKEN`). |
| `--anonymize` | Pseudonymize users in the emitted environment/scenario. |
| `--skip-preflight` | Skip the blocking preflight gate (not recommended). |

The process exits non-zero if any conservation or invariant check fails.

## Pipeline

| Stage | Module | Responsibility |
| --- | --- | --- |
| Preflight | `extract.mjs` | Gate the run: window validity, report availability, membership sanity. |
| Extract | `extract.mjs` | Follow the signed `download_links`, land NDJSON per day, emit a coverage **manifest**. |
| Map | `map-environment.mjs` | Resolve cost centres, build the chargeback table, emit a valid Budget Lab environment. |
| Allocate | `allocate.mjs` | Apply the two-driver allocation and verify conservation. |
| Model split | `model-split.mjs` | Estimate the model/feature mix and its sensitivity. |
| Report | `report.mjs` | Render the self-contained HTML, including the charge-flow diagram. |

## The two things this tool keeps separate

**`usage_usd` is exact.** It is `ai_credits_used × $0.01`, a documented, exact rate.

**`chargeback_usd` is allocated.** Copilot bills through Azure as two distinct charges, so the tool
uses two drivers, always within one `(billing_entity, invoice_period)` partition:

```
user_seat_cost = seat_charge_for_tier × (user_seat_days_in_tier / total_seat_days_in_tier)
user_metered   = metered_charge       × (user_ai_credits_used  / entity_ai_credits_used)
```

Business and Enterprise seat-days never share a denominator. Allocating *everything* by credit share
would be wrong: it assigns **zero cost to an idle seat**, which is usually the most actionable finding
in the whole report, and it is undefined when nobody used anything.

### One invoice period at a time

`allocate()` rejects an invoice whose period does not match the allocation window. This matters
because the mismatch is invisible to every other check: allocating a full month's seat charge across a
three-day usage window still conserves perfectly — the shares still sum to the invoice — while
overstating those three days roughly tenfold. Extract the window that matches the invoice period, or
split the invoice and allocate each `(billing_entity, invoice_period)` partition separately.

### Conservation is not completeness

Because the denominator is computed from the rows actually ingested, allocated shares *always* sum to
the invoice — even if a user or a whole day is missing. A missing user's cost is silently redistributed
across everyone else. The sum check therefore cannot detect a gap.

Completeness is a separate control: the extractor's manifest records per-day success, row counts and
errors, and the report's **Data coverage** panel surfaces missing days as explicit gaps rather than as
zero usage. Treat a report whose coverage is not `complete` as provisional.

## What the model split can and cannot tell you

`ai_credits_used` is **not** broken down by model or feature by GitHub. The model mix is therefore
*estimated*: exact per-user credit totals are distributed across the model/feature interaction counts
using explicit, documented token-cost assumptions, then renormalized so each user's total stays exact.

Every estimated row is labelled, and the charge-flow diagram draws an explicit **exactness boundary**:
cost centre → user is exact, everything downstream is estimated. Usage that cannot be attributed to a
model is shown as an explicit "unattributed by model" bucket rather than being dropped.

This supports the question "which model was used for which feature". It does **not** measure task
complexity, so "expensive model on a trivial task" remains a hypothesis to review, not a conclusion.
The reported sensitivity varies assumed token volume only; the assumed relative price between models
is the larger uncertainty and is not varied.

**Coverage is assumed, not measured.** Where a user has any model interactions on a day, all of that
day's credits are split across those models. GitHub does not publish how many credits fall outside
model-attributed activity, so that residual cannot be measured and is not invented here; the report
states this assumption. Only a user with no model interactions at all lands wholly in
"unattributed by model".

## Output

| File | Contents |
| --- | --- |
| `report.html` | Self-contained report: coverage, checks, charge flow, per-cost-centre and per-user tables, model mix. |
| `chargeback.csv` | Per day, per user: cost centre, attribution route, credits, exact `usage_usd`. |
| `allocation.csv` | Per user: seat days, tier, seat cost, metered cost, allocated `chargeback_usd`. |
| `allocation.json` | Full allocation result including the invoice used and every check. |
| `model-split.json` | The estimate plus its low/high sensitivity runs. |
| `environment.json` / `scenario.json` | A Budget Lab environment and scenario (`source.kind: "github-api"`). |
| `manifest.json` | Per-day extraction coverage. |

## Limitations

- Cost-centre membership is a **point-in-time snapshot**, so a mid-period move is attributed as if it
  had always applied. The report states this explicitly. Effective-dated attribution is V1.
- Without `--invoice`, the invoice is **synthetic** and derived from list prices; it is for validating
  the mechanics, not for reconciliation. The report labels it prominently.
- Daily `*-1-day` reports are the only sliceable source. Never join a 28-day per-user report to a
  single-day team snapshot.
- Teams with fewer than five seated users are excluded from user-teams reports, so some usage may fall
  back to the organization or `unallocated` route.
