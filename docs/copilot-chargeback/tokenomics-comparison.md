# `mcaps-microsoft/ghcp-tokenomics` vs. `gh-cost-compass`

Primary-source comparison of the private
[`mcaps-microsoft/ghcp-tokenomics`](https://github.com/mcaps-microsoft/ghcp-tokenomics) repository
against this repository's live chargeback pipeline, Budget Lab simulator/canvas, and Token Lens
integration boundary. All citations below are to
`mcaps-microsoft/ghcp-tokenomics` at commit
[`b3efd0ad35d9eaf3823372ab605d97edcf914225`](https://github.com/mcaps-microsoft/ghcp-tokenomics/tree/b3efd0ad35d9eaf3823372ab605d97edcf914225)
(current `main` at investigation time, 2026-09-28) unless another repository is named. That commit
is the same one already cited in [`token-lens-integration.md`](token-lens-integration.md); this
page is broader and covers the whole Tokenomics workspace, not only Token Lens. Readers need
Microsoft EMU access to the private repository to verify these citations directly.

## What Tokenomics is

Tokenomics is an npm-workspaces monorepo with four modules
([`README.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/README.md),
[`package.json`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/package.json)):

| Module | Visibility | Purpose | License |
| --- | --- | --- | --- |
| `spend-lens` | Public-ready, unpublished | Billing CSV → structured entities + cited recommendations, JSON | MIT, © Hari Srinivasan ([LICENSE](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/spend-lens/LICENSE)) |
| `token-lens` | Public-ready, unpublished | Per-developer session/evidence JSON adapters → one unified report | MIT, © Hari Srinivasan, **with an unresolved licensing blocker** ([LICENSE](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/LICENSE), [PROVENANCE.md](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/PROVENANCE.md)) |
| `octodash-view` | Internal only | Filters a multi-tenant Microsoft OctoDash export down to one customer's adoption/health facts, allow-list only, no money | None; `"private": true` ([package.json](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/octodash-view/package.json)) |
| `internal-workbench` | Internal only ("Microsoft field material") | Four-layer CSA/SE delivery app: dashboard + Word/PowerPoint/Text export + engagement prep | None; `"private": true` ([package.json](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/package.json)) |

The whole repository itself is **private** (`visibility: internal`, confirmed via the GitHub REST
API repository object) and owned by the `mcaps-microsoft` GitHub Enterprise Managed User (EMU)
organization; it is not discoverable through normal repository search, consistent with EMU
visibility rules.

Architecturally it is the mirror image of this repository's design: three independence-checked,
dependency-declared TypeScript/npm modules with build tooling (Vite, TypeScript, ESLint, Prettier,
`node:sqlite`), versus this repository's single dependency-free Node ES-module tree with no
bundler, no TypeScript, and no package manager beyond the Node standard library
([`package.json`](../../package.json),
[`tools/copilot-usage/README.md`](../../tools/copilot-usage/README.md)).

## Feature-by-feature comparison

### 1. Live Copilot usage/billing extraction

| | `gh-cost-compass` | Tokenomics |
| --- | --- | --- |
| Source | GitHub Copilot **metrics API** (`/enterprises/{ent}/copilot/metrics/reports/users-28-day/latest` + daily `users-1-day`), live, scheduled | GitHub Copilot **usage-based-billing CSV export**, manually supplied |
| Automation | Daily scheduled GitHub Actions workflow (`.github/workflows/copilot-usage-export.yml`, `02:17` UTC) — see [`automation.md`](automation.md) | None. `spend-lens` is a CLI/browser tool a human runs against a CSV they already downloaded; there is no extractor, no token, and no scheduled job anywhere in the repository |
| Cost dimension | Exact `ai_credits_used` per user/day from the metrics API (see [`apis.md`](apis.md)) | Exact `gross_amount`/`net_amount`/`aic_quantity` from the **billing** CSV — a different, invoice-shaped source, per [`spend-lens/README.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/spend-lens/README.md) |

Tokenomics' `spend-lens` module does not call the GitHub API at all — "No network. No filesystem
in the core. No dependencies"
([`spend-lens/README.md:1-9`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/spend-lens/README.md)) —
and its CLI actively guides a human through *finding* an already-downloaded CSV rather than
retrieving one
([`spend-lens/README.md`, "The command line" section](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/spend-lens/README.md)).
Only `internal-workbench` makes any live GitHub API call, and only two narrow, user-initiated ones
— a repository configuration scan (`api.github.com`, `raw.githubusercontent.com`) and an
organization-only seat/metrics read — never a scheduled or background one
([`internal-workbench/docs/TRUST-AND-COMPLIANCE.md`, §2](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/TRUST-AND-COMPLIANCE.md)).

**Conclusion: `gh-cost-compass` is the only one of the two with live, scheduled, credential-driven
metrics-API extraction.** Tokenomics is strictly manual-CSV-in; this is a real capability gap in
Tokenomics relative to this repository, not a difference in emphasis.

### 2. AI-credit / cost-centre attribution

Both repositories model a cost-centre-shaped billing entity, but from different source columns and
with different attribution logic:

- `gh-cost-compass` attributes credits from the metrics API's cost-centre membership endpoint using
  a precedence rule (direct user → single team → single org → explicit ambiguous/unallocated), and
  reconciles seat and metered charges to an actual invoice split by tier — see
  [`data-model.md`](data-model.md).
- Tokenomics' `spend-lens` derives `costCentre` directly from the CSV's `cost_center_name` column
  and lists `businessUnit`, `team`, `session`, `prompt`, `context`, `agent`, `outcome`, and `policy`
  as entities a billing CSV categorically cannot describe, publishing that gap as
  `coverage.unsupported` on every report rather than emitting a false zero
  ([`docs/ENTITY-MODEL.md`, "Spend Lens — 11 entities"](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/docs/ENTITY-MODEL.md)).

Tokenomics' allocation is per-CSV-row, with no explicit seats/metered split formula published in
the primary sources reviewed comparable to this repository's
`user_seat_cost + user_metered` reconciliation ([`data-model.md`](data-model.md)); its
`spend-lens/README.md` documents pool utilization, overage, and a next-month forecast with a
prediction interval instead
([`spend-lens/README.md`, "The output"](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/spend-lens/README.md)).
Tokenomics is explicit that seats are usually *inferred* (a lower bound from distinct usernames)
unless confirmed, and flags every downstream figure as inheriting that uncertainty via
`confidence.seatsAreInferred`
([same README, "Two things worth reading before you trust a number"](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/spend-lens/README.md)) —
a weaker seat-provenance guarantee than this repository's cross-checked live seats endpoint
(`GET /enterprises/{ent}/copilot/billing/seats`, deduplicated with tier precedence, per
[`apis.md`](apis.md)).

**Conclusion: complementary, not overlapping.** `gh-cost-compass` attributes an authoritative daily
credit spine to users/teams/orgs from live API data; Tokenomics attributes an already-issued
invoice's rows to the cost centres the customer configured, useful when only a CSV export is
available and no metrics-API token exists.

### 3. Excel / FOCUS outputs

- `gh-cost-compass` emits FOCUS 1.4 (`focus.csv`, exact column order documented in
  [`focus-mapping.md`](focus-mapping.md)) and a nine-sheet analyst workbook via a hand-rolled,
  dependency-free `xlsx.mjs` ZIP/`deflateRaw` writer, matching the repository's zero-dependency
  constraint (see [`outputs.md`](outputs.md)).
- Tokenomics' JSON Schema-versioned reports
  ([`spend-lens/schema/spend-lens-report.schema.json`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/spend-lens/schema/spend-lens-report.schema.json),
  [`token-lens/schema/token-lens-report.schema.json`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/schema/token-lens-report.schema.json))
  **do not target FOCUS at all**; no occurrence of "FOCUS" as a cost-data standard was found
  anywhere in the workspace outside an unrelated word inside a Chronicle report template. Instead,
  `internal-workbench` renders the joined analysis into a **Word document, PowerPoint deck, and
  plain-text summary** using vendored `docx`, `pptxgenjs`, and `echarts`
  ([`docs/ARCHITECTURE.md`, "What makes a module publishable"](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/docs/ARCHITECTURE.md);
  [`internal-workbench/docs/EXPORT-ENGINES.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/PRODUCT-OVERVIEW.md)).

**Conclusion: Tokenomics is stronger on customer-facing narrative deliverables (Word/PowerPoint
briefings built for a live CSA conversation) and has no FOCUS/FinOps-standard output at all.**
`gh-cost-compass` is stronger on standards-based, pipeline-ready output (FOCUS 1.4 CSV, FinOps hub
landing convention) and has no Office-document generation. Neither subsumes the other.

### 4. Scheduled workflow

Tokenomics' only workflows are `.github/workflows/ci.yml` (push/PR/dispatch-triggered
lint/build/test) and `.github/workflows/pages.yml` (private GitHub Pages deploy of
`internal-workbench`)
([`.github/workflows/`](https://github.com/mcaps-microsoft/ghcp-tokenomics/tree/b3efd0ad35d9eaf3823372ab605d97edcf914225/.github/workflows)).
**There is no `schedule:`-triggered workflow anywhere in the repository** — no daily/periodic
extraction job exists or is planned in the primary sources reviewed. This is consistent with the
manual-CSV-in design described in §1.

One primary-source discrepancy worth flagging for anyone relying on Tokenomics' CI claims: the root
`README.md` states "**GitHub Actions hosted runners are administratively disabled for this
enterprise**" and that CI "will show as failed"
([`README.md`, "A note on CI"](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/README.md)),
while `internal-workbench/docs/DEPLOYMENT.md`, whose CI section is self-dated "checked 25 September
2026," states runners are now `ubuntu-latest` GitHub-hosted and "Hosted runners are executing these
checks; the earlier administrative-disablement note no longer applies"
([`internal-workbench/docs/DEPLOYMENT.md`, §5](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/DEPLOYMENT.md)),
and `ci.yml` itself pins `runs-on: ubuntu-latest`
([`.github/workflows/ci.yml`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/.github/workflows/ci.yml)).
The two documents disagree at the same commit; the more recently self-dated one and the workflow
file itself indicate hosted CI is active, but the root README has not been updated to match.

**Conclusion: `gh-cost-compass` has a real scheduled extraction workflow; Tokenomics has none.**
This is the single largest structural gap in Tokenomics relative to this repository's stated scope.

### 5. Sanitized examples

Tokenomics' example material is deeper and more deliberately engineered than this repository's:

- The approved, single **synthetic Cedarbridge Engineering** scenario (500 seats, Enterprise, five
  cost centres, six repositories, August 2026 only, September as forecast) drives every module —
  Spend Lens, Token Lens, CATES, Outcome Economics, and Account Health — from one deterministic
  generator (`npm run scenario:august`), with a byte-hash-checked, no-drift `--check` mode
  ([`samples/scenarios/cedarbridge-2026-08/README.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/samples/scenarios/cedarbridge-2026-08/README.md)).
- Real, downloadable rendered artefacts — an actual `.docx` report, `.pptx` deck, `.txt` summary,
  and a resumable Workbench session JSON — are checked in and linked from the top-level README
  ([`README.md`, "See the result: no installation needed"](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/README.md)).
- `octodash-view/samples/sample-customer/` deliberately includes columns the allow-list must
  reject, to prove the redaction gate fires rather than only asserting it in code
  ([`octodash-view/README.md`, "Sample"](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/octodash-view/README.md)).
- `token-lens/PROVENANCE.md` states every file under `samples/` is synthetic or anonymised with
  real repository/organisation identifiers replaced by `example-org/...`
  ([`token-lens/PROVENANCE.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/PROVENANCE.md)).

`gh-cost-compass`'s comparable artefact is the single
[2026-09-28 demo chargeback bundle](../../examples/copilot-chargeback/madebyqent01-2026-09-28/README.md)
covering only the metrics-API side. **Conclusion: Tokenomics' example program is broader (one
scenario feeding five independent tools with cryptographic reproducibility, plus real rendered
Office documents) than this repository's single sanitized bundle**, though both follow the same
principle of one approved synthetic scenario rather than ad hoc fixtures.

### 6. Token Lens privacy/integration docs

This repository already has a dedicated page,
[`token-lens-integration.md`](token-lens-integration.md), built from the same commit cited here; it
is accurate and remains the authoritative page for that specific boundary — this report does not
duplicate it. Two points from that page are load-bearing for the comparison below:

- Token Lens (the plain `session-export.mjs` exporter) carries **no developer identifier of any
  kind**; the richer plugin/Chronicle report **is** identity-adjacent through repository names,
  file paths, checkpoint titles, and session summaries, and is not fully anonymized by `--redact`
  ([`token-lens/README.md`, "Privacy"](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/README.md)).
- There is no shared central location, uploader, or background service anywhere in the current
  source; every report reaches any consuming tool because a person put it there
  ([`internal-workbench/docs/CHRONICLE-INTEGRATION.md`, "Still not implemented"](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/CHRONICLE-INTEGRATION.md)).

### 7. Chronicle setup

Tokenomics' Chronicle integration is materially more developed than anything in this repository,
which references it only for its privacy boundary, not as an operating capability:

- `token-lens/collectors/` includes `session-export.mjs` (original to the project, no developer
  identifier), plus `session-collect.mjs`, `preflight.ps1`, `finalize.ps1`, and
  `legacy-markdown-to-json.ps1`, described as deriving from an internal Copilot agent plugin
  ([`token-lens/README.md`, "Collectors"](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/README.md)).
- The upstream plugin is `customer-success-microsoft/automate-chronicle-report`, version 0.5.0,
  locally patched to 0.5.1 in Tokenomics
  ([`token-lens/PROVENANCE.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/PROVENANCE.md);
  corroborated independently by
  [`internal-workbench/docs/CHRONICLE-INTEGRATION.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/CHRONICLE-INTEGRATION.md),
  which independently names the same upstream repo, version, and patch level).
- `internal-workbench` documents three accepted report schemas (`evidence-v1` prose-recovered,
  `evidence-v2` typed, `evidence-v3` pure JSON), a `preflight.ps1` readiness check with
  `ready`/`degraded`/`blocked` verdicts, and an explicit refusal to import native Chronicle
  slash-command *prose* output — only the file `/chronicle-report` writes is ever read
  ([`internal-workbench/docs/CHRONICLE-INTEGRATION.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/CHRONICLE-INTEGRATION.md)).
- The Workbench bundles a patched `Tokenlens.zip` distribution artefact at `dist/assets/` because
  the plugin's real upstream is Microsoft-internal
  ([`internal-workbench/docs/DEPLOYMENT.md`, §2](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/DEPLOYMENT.md)),
  though the standalone `token-lens` module's own `PROVENANCE.md` says that same zip "was removed
  from this module" so its internal installation instructions do not ship in the public-ready
  package
  ([`token-lens/PROVENANCE.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/PROVENANCE.md)) —
  i.e., the zip lives with the internal app, not the module planned for release.

**Conclusion: Tokenomics has a real, working Chronicle setup (collectors, plugin, three schema
generations, preflight, redaction); this repository correctly treats Chronicle/Token Lens as
out-of-scope for automated ingestion and documents only the privacy boundary. Tokenomics is more
complete here, but its own primary source records an open, unresolved licensing blocker on exactly
the code that would need to be reused (see §9).**

### 8. Repo/agent configuration, developer evidence, and outcomes

This is a full layer in Tokenomics with no equivalent anywhere in `gh-cost-compass`:

- **CATES** ("Coding Agent Token Economics Standard") is a zero-LLM static analyser that scores a
  repository's Copilot/agent configuration quality across six dimensions using deterministic
  heuristics — no API keys, no data exfiltration
  ([`internal-workbench/docs/FIELD-DELIVERY-STRATEGY.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/FIELD-DELIVERY-STRATEGY.md)),
  consumed as "Repo Economics" (Layer 2) and parsed from a CATES report JSON's `score` +
  `discovery` fields
  ([`internal-workbench/docs/DATA-AND-SCHEMA.md:272`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/DATA-AND-SCHEMA.md)).
- **Outcome Economics** (Layer 4) joins compatible GitHub usage-metrics reports (PR throughput,
  reviews, acceptance) against billing, gated on population/window compatibility (≥90% coverage of
  both periods) before any cost-per-outcome figure is shown
  ([`internal-workbench/docs/PRODUCT-OVERVIEW.md`, tab table](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/PRODUCT-OVERVIEW.md)).
- **Account Health** ingests `octodash-view`-converted OctoDash exports (installed/authenticated/
  active/engaged funnel, idle-seat risk) — Microsoft-internal telemetry this repository has no
  access to or need for
  ([`octodash-view/README.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/octodash-view/README.md)).
- An 11-domain, 36-check "Org Economics" governance questionnaire with deterministic,
  billing-evidence-backed recommendations and owner assignment
  ([`internal-workbench/docs/PRODUCT-OVERVIEW.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/PRODUCT-OVERVIEW.md)).

`gh-cost-compass` has no repository-configuration scanner, no outcome/PR-throughput join, and no
adoption-funnel ingestion; its scope is deliberately narrower (credit spine + chargeback + a
what-if simulator/canvas). **Conclusion: Tokenomics is substantially more complete on this axis; it
is not a gap this repository should try to close wholesale (see the phased plan below), because
most of it depends on Microsoft-internal inputs (OctoDash, VBD engagement data) this repository has
no legitimate access to.**

### 9. Value/outcomes, privacy/security, persistence/deployment, and licensing

| Axis | `gh-cost-compass` | Tokenomics |
| --- | --- | --- |
| Value/outcome framing | Not modeled; chargeback only | Explicit "cost per merged PR," adoption funnel, and Org Economics action plan, all with population/causality caveats (`internal-workbench/docs/PRODUCT-OVERVIEW.md`, `TRUST-AND-COMPLIANCE.md`) |
| Privacy/security | No PAT storage in-app (server-side workflow secret only); no browser client | Strict CSP, `connect-src` limited to two GitHub origins, no analytics telemetry, PAT held in page memory only, ESLint security rules + SBOM (`internal-workbench/docs/TRUST-AND-COMPLIANCE.md` §2, §5) |
| Persistence | Files written to workflow artifacts / FinOps hub landing path; no app-side session state | Manual, unencrypted whole-session JSON export/import, 300 MiB limit, no auto-recovery/local storage, PAT never serialized (`internal-workbench/docs/TRUST-AND-COMPLIANCE.md` §2b) |
| Deployment | GitHub Actions (Node 20+, dependency-free) | Azure App Service, Node 22 LTS Linux, zero-runtime-dependency static server with hardened headers and a `/healthz` probe (`internal-workbench/docs/DEPLOYMENT.md`) |
| Licensing | Repository license governs this whole tree uniformly | Mixed: `spend-lens`/`token-lens` MIT (© Hari Srinivasan, an individual, not a Microsoft copyright line); `octodash-view`/`internal-workbench` unlicensed and `private: true` (internal-only, no redistribution grant) |

**The licensing point is the one integration blocker that matters most for this repository.**
`token-lens/PROVENANCE.md` states in its own words that publication is blocked because
`collectors/session-collect.mjs`, the PowerShell collectors, and `plugin/` derive from
`customer-success-microsoft/automate-chronicle-report`, an **Internal**-visibility Microsoft EMU
repository, and that "a byte-comparable public mirror is understood to exist, but 'understood to
exist' is not a licence"
([`token-lens/PROVENANCE.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/PROVENANCE.md)).
Until "someone with authority" confirms the redistribution licence, canonical source, and
attribution requirement, the file recommends publishing only `src/` and
`collectors/session-export.mjs`, holding back everything else. This matches and reinforces the
existing guidance in [`token-lens-integration.md`](token-lens-integration.md#proposed-budget-lab-boundary),
item 6: do not copy the upstream collector or plugin code into this repository while redistribution
rights remain unresolved.

## Is Tokenomics "more complete"?

Not uniformly — the two projects answer different questions:

- **Where Tokenomics is more complete:** billing-CSV-driven customer narrative delivery (Word/
  PowerPoint/Text), Chronicle/Token Lens tooling depth, repository-configuration scoring (CATES),
  outcome/adoption joins, Account Health, and a mixed-input "Org Economics" governance
  questionnaire. It is a mature, tested (1,059 total tests across the three measured modules per
  its own README status table — though note `token-lens/README.md`'s own "Development" section
  says "122 tests, collectors included" while the root README's status table says `102` for the
  same module, a minor unreconciled internal inconsistency at this commit), independently
  buildable, Azure-deployable field application.
- **Where `gh-cost-compass` is more complete or exclusive:** live, scheduled, credential-driven
  metrics-API extraction with a documented daily workflow; FOCUS 1.4-shaped, FinOps-hub-ready
  output; a dependency-free architecture that needs no bundler, framework, or TypeScript toolchain;
  and an interactive What-If canvas backed by a live Copilot-assisted Q&A session (see next
  section), none of which Tokenomics has.
- **Where they are complementary rather than either being "better":** Spend Lens's CSV-based
  attribution and this repository's metrics-API attribution measure genuinely different things
  (an issued invoice's rows vs. a live per-user-day credit spine) and could, in principle, be
  cross-checked against each other, not merged.

## `internal-workbench`'s four-layer dashboard vs. this repository's Budget Lab canvas

This repository's [`Copilot Budget Lab` canvas](../../.github/extensions/budget-lab/extension.mjs)
is a loopback-only Node HTTP server (`node:http`, no framework) that serves this repository's static
`index.html`/`src/`/`scenarios/`/`docs/` tree and proxies a scoped, prompt-constrained
Copilot-assistant Q&A endpoint (`/api/assistant`) into an isolated session, with a hard scope
restriction to GitHub/Copilot/billing topics and an explicit refusal to mutate state or claim to
import a scenario
([`extension.mjs:1-198`](../../.github/extensions/budget-lab/extension.mjs)). It is a deterministic,
scenario-driven **simulator**: no billing CSV or metrics import, no CSA delivery workflow, no
Office-document export.

`internal-workbench` is a Vite/TypeScript SPA with 13 dashboard tabs, four data "layers" (Org
Economics, Repo Economics, Dev & Agent Economics, Outcome Economics), a repository-scan and
metrics-retrieval client restricted to two GitHub origins under a strict CSP, and Word/PowerPoint/
Text export engines, deployed to Azure App Service behind a zero-dependency hardened static server
([`internal-workbench/docs/PRODUCT-OVERVIEW.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/PRODUCT-OVERVIEW.md),
[`internal-workbench/docs/DEPLOYMENT.md`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/docs/DEPLOYMENT.md)).
These are not competing implementations of the same tool: the Budget Lab canvas is a live-in-CLI
exploratory sandbox with an embedded assistant; the Workbench is a hosted, multi-source ingest-and-
report application for a customer-facing engagement. Neither's code is redistributable into the
other without the licensing resolution described in §9, and the Workbench is explicitly internal
field material that "must not be published publicly"
([`.github/workflows/pages.yml:3-5`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/.github/workflows/pages.yml)).

## Proposed phased, surgical integration architecture

Given the dependency-free, Node-ES-module architecture of this repository and the licensing state
above, integration should be **adapter-based and read-only against published contracts**, never a
code merge:

### Phase 0 — Contract tracking only (no code)

Track Tokenomics' two versioned JSON Schemas
(`spend-lens/schema/spend-lens-report.schema.json`,
`token-lens/schema/token-lens-report.schema.json`) as external references in this repository's docs,
the way [`token-lens-integration.md`](token-lens-integration.md) already does. No import, no
adapter code. This phase is already complete for Token Lens; extend the same treatment to Spend
Lens's schema so a future adapter has a stable target.

### Phase 1 — Optional, manual Spend Lens JSON cross-check (independent adapter, MIT-clear)

Because `spend-lens` is MIT-licensed with no cited redistribution blocker (unlike `token-lens`'s
collectors), a **from-scratch, independent** dependency-free adapter in this repository could read
a `spend-lens-report.schema.json`-shaped JSON file (produced by a human running the separate
`copilot-spend-lens` tool against their own billing CSV, exactly as this repository already
recommends for Token Lens in [`token-lens-integration.md`](token-lens-integration.md)) and surface it
next to this repository's own live metrics-API report as a labelled, non-authoritative
cross-check — never a merge or an overwrite of the credit spine. This does not require copying any
Tokenomics source; it requires only writing a validator against the *published schema shape*, which
is the same "independent adapter against an agreed report contract" approach the existing Token
Lens guidance already commits to.

### Phase 2 — Extend the existing Token Lens import boundary (no new design)

The V0–V2 staged roadmap in [`token-lens-integration.md`](token-lens-integration.md#staged-roadmap)
already covers this correctly and needs no new architecture: manual local import with preview and
consent (V0), a validated schema adapter with cohort aggregation and suppression under five
participants (V1), and an optional signed pseudonymous upload endpoint only after that (V2). This
report does not propose changing that roadmap; it confirms, from the broader Tokenomics investigation,
that nothing on the Chronicle/Token Lens side has changed since it was written (same commit) that
would loosen the licensing or privacy constraints it documents.

### Phase 3 — Do not import CATES, Outcome Economics, Account Health, or Office-document export

These four capabilities are real and mature in Tokenomics but each depends on inputs this repository
either cannot access (OctoDash exports, Microsoft VBD engagement data, a repository-configuration
scanner design that is `internal-workbench`-owned code) or would duplicate a customer-facing
delivery workflow that is explicitly scoped as internal Microsoft field material, not a general
FinOps pipeline. Re-implementing CATES-equivalent scoring or Office-document export inside this
repository would be a large, separately-scoped project, not a "surgical" slice, and is out of scope
for this comparison's recommended first step.

### First implementation slice (recommended)

**Phase 1's Spend Lens JSON cross-check reader**, scoped narrowly:

1. A single dependency-free Node module (e.g. `tools/copilot-usage/spend-lens-adapter.mjs`) that
   validates an input file's shape against the *published* `spend-lens-report.schema.json` fields
   actually used (`entities.cost`, `entities.license`, `entities.entitlement`, `confidence.seatSource`)
   without vendoring any Tokenomics code.
2. A CLI flag on the existing `tools/copilot-usage/cli.mjs` (e.g. `--cross-check <path>`) that, when
   given such a file, prints a side-by-side of the CSV-derived invoice total against this
   repository's own live-extracted total for the overlapping period, labelled "cross-check, not
   reconciliation" per the existing "conservation is not completeness" caveat in
   [`data-model.md`](data-model.md).
3. No automatic file discovery, no network call, no write path into `chargeback.xlsx`/`focus.csv` —
   purely an additive, opt-in diagnostic surfaced in the workbook's existing **Caveats** sheet.

This slice is small enough to implement and test in isolation, requires no new dependency, respects
the licensing boundary (only the MIT-licensed, non-blocked `spend-lens` schema is touched), and
gives an operator a second, independently-sourced number to sanity-check the live metrics-API
credit spine against — the single highest-value, lowest-risk integration available given the state
of both repositories at this commit.

## Gaps and uncertainties

- Access required switching to the `joweerdt_microsoft` GitHub account inside this session; the
  default active account (`JohanDeWeerdtMSFT`) has no visibility into `mcaps-microsoft` at all. Any
  reader without EMU access to that organization cannot independently verify these citations by
  clicking through them.
- `internal-workbench/docs/BILLING-AND-MATH.md`, `TESTING-AND-SECURITY.md`, `DATA-AND-SCHEMA.md` in
  full, and the CATES analyzer's own source (only its docs, not its `internal-workbench/src/`
  implementation) were not read in full depth; the summaries above rely on the sections most
  relevant to this comparison's required axes, not an exhaustive line-by-line audit of all ~90
  Workbench modules.
- The `octodash-view` and `internal-workbench` license position is inferred from the absence of a
  `LICENSE` file plus `"private": true` in each `package.json`; no explicit "all rights reserved" or
  internal-use-only license text was found to quote directly, beyond the README's own "Private
  repository; internal delivery material" and the Pages workflow's "must not be published publicly"
  comment already cited above.
- Whether GitHub Actions hosted runners are in fact enabled for this enterprise at the time of
  reading (§4's discrepancy) was not independently re-verified against a live Actions run; both
  primary-source documents were read as committed, and the disagreement between them is reported
  as-is rather than resolved.
