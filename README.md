# Copilot Budget Lab

A local visual sandbox for explaining and testing GitHub Enterprise and Copilot usage-based billing without touching a real GitHub environment.

## Features

- Enterprise → organization → repository hierarchy
- Copilot Business and Enterprise users, enterprise teams, license organizations, and direct, team, repository, or organization-based cost-center assignment
- Shared monthly AI-credit pool: 1,900 credits per Business seat and 3,900 per Enterprise seat
- Cost-center included usage controls with **AI credit pool enabled** and either block-members or continue-as-paid-overage behavior
- Universal, cost-center, and individual user-level budgets (ULBs)
- Separate enterprise, organization, and cost-center metered-overage budgets
- AI paid-usage policy, effective dates, monthly resets, alerts, and hard stops
- Clear split between included AI credits and paid overage
- Dated usage simulation, live progress, attribution details, included-usage health, budget threshold alerts, and audit timeline
- Clickable budget and shared-pool cards with an accessible history dialog showing the current-period events that drove their state
- Toast notifications when a budget threshold alert fires or an event is blocked, with severity colouring, GitHub's alert-delivery caveat, and a shortcut into the budget history
- Documentation-backed configuration help, source links, and live cost/access impact previews
- Scenario import/export, reset, replay, and browser-local persistence
- A preview-first Scenario Studio with non-destructive step selection, explicit execution controls, predicted and actual budget/pool deltas, alerts, and health snapshots
- Extensible declarative scenario definitions loaded from `scenarios/catalog.json`, with JSON Schema support and browser-local import/export
- A documented scenario catalog for budget health progression and the next-step 100% saturation case

## Default enterprise dataset

Resetting the simulator loads the default set selected in Configuration. Default set data lives in `scenarios/default-sets/*.json`, while `src/default-scenario-sets.js` only loads and expands those JSON definitions. The enterprise set contains 10 organizations, 20 cost centers, 20 repositories, and 200 licensed users across software engineering, data science, project management, security, SRE, analyst, and design personas. A compact two-user set remains available for focused demos and tests.

The generated data keeps stable IDs such as `user-alice`, `user-bob`, `org-product`, `repo-portal`, `cc-ai`, and `cc-core` so guided scenarios and tests remain reviewable. A small group of enterprise users intentionally has no direct cost-center assignment, so budget attribution can demonstrate the enterprise and organization fallback behavior. Runtime imports are validated for duplicate IDs and broken references before replacing the active scenario.

## Read-only GitHub enterprise extraction

The optional extractor produces the same topology-only environment artifact used by guided scenarios. It makes read-only requests only; it never changes organizations, memberships, seats, cost centers, budgets, or billing settings, and it does not send customer data to an LLM. Credentials are supplied at runtime through `GITHUB_TOKEN` and are not written to the export, browser storage, fixtures, logs, or error messages.

```powershell
$env:GITHUB_TOKEN = "<runtime secret>"
npm run extract:github -- --enterprise acme --output .\exports\acme.json
```

Exports are anonymized by default with deterministic pseudonyms. Use `--preserve-identity` only when the destination is approved for source identities. Existing output files are never overwritten. Optional API failures make the acquisition partial and stop the command; review `source.omittedCapabilities` before explicitly opting in to `--allow-partial`. The offline normalizer is deterministic for fixed input, extraction timestamp, and anonymization settings, and its output can be registered and replayed by scenarios through `environmentId`.

The acquisition layer uses `GET` requests with `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2026-03-10`, bearer authentication, pagination, bounded retries for rate limiting and transient failures, and explicit required/optional capability handling. The default collection covers:

| Capability | Read surface | Simulator mapping |
| --- | --- | --- |
| Enterprise and organizations | `GET /enterprises/{enterprise}`, `/enterprises/{enterprise}/organizations` | Enterprise, organizations |
| Repositories and memberships | `GET /orgs/{org}/repos`, `/orgs/{org}/members` | Repositories and cross-organization users |
| Copilot seats | `GET /orgs/{org}/copilot/billing/seats` or a compatible configured seat endpoint | Business/Enterprise plan, assignment date, cancellation/revocation lifecycle |
| Teams | `GET /orgs/{org}/teams` or enterprise-team equivalent | Enterprise teams and cost-center relationships where supplied |
| Budgets and prices | No assumed universal endpoint | Imported only when supplied by a supported adapter; missing data is omitted, never treated as zero or unlimited |

GitHub's Copilot seat endpoints are public preview and permissions are endpoint-specific. A practical read-only token commonly needs organization Copilot read access (or `manage_billing:copilot`/`read:org` for the relevant organization endpoints), repository visibility, membership visibility, and `read:enterprise` for enterprise-team REST endpoints. Enterprise-team REST endpoints do not support fine-grained PATs or GitHub App tokens; use an approved classic PAT or a compatible GraphQL/organization-team source. Verify the exact permissions for the target enterprise and inspect `X-Accepted-GitHub-Permissions` responses before a live smoke test.

The normalizer deduplicates users by GitHub identifier, preserves organization membership separately from the license-granting organization, requires an explicit override for ambiguous multi-grant licensing, and maps direct user, repository, organization, and team cost-center relationships without inventing unassigned associations. Seat dates are converted into simulator dates and `unassign`/`revoked` modes; those are simulator semantics, not raw GitHub enum values. Usage aggregates are intentionally not fabricated into per-user events. For an offline smoke test, use `tests/fixtures/github-enterprise.json` and `tests/github-environment-extractor.test.js`; the suite never makes an authenticated network call.

Official API references: [REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions), [Copilot user management](https://docs.github.com/en/rest/copilot/copilot-user-management), [enterprise teams](https://docs.github.com/en/rest/enterprise-teams/enterprise-teams), [organizations](https://docs.github.com/en/rest/orgs/orgs), [repositories](https://docs.github.com/en/rest/repos/repos), [organization members](https://docs.github.com/en/rest/orgs/members), and [GraphQL calls](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql).

## Run and test

Requires Node.js 20 or newer.

```powershell
npm start
npm test
```

Open <http://localhost:4173>.

## Documented AI-credit rules represented

- One AI credit is valued at $0.01 USD.
- Included credits are pooled across the enterprise and reset at 00:00 UTC on the first calendar day of each month.
- A cost center can enable its own AI credit pool, calculated from the Copilot Business and Enterprise licenses attributed to that cost center. When enabled, the simulator partitions those included credits from the general enterprise pool.
- When a cost center reaches its included AI credit pool cap, the simulator follows the configured documented behavior: block further usage at the cap or continue into paid overage if paid usage is allowed.
- A ULB measures one user's **total** AI-credit consumption across both included and metered phases. It is always a hard stop.
- ULB precedence is individual → cost-center ULB → universal ULB.
- Enterprise, organization, and cost-center spending budgets measure **only paid overage after the shared pool is exhausted**.
- Disabling the AI credits paid-usage policy blocks usage when the pool is exhausted regardless of metered-budget headroom.
- Budgets count usage only from their creation/effective date onward. Standard alerts use 75%, 90%, and 100% thresholds.
- Alerts are raised once per threshold crossing per budget per month. GitHub delivers metered budget alerts in the UI and by email, and states that user-level budget alert delivery is not guaranteed; the simulator repeats that caveat in the alert toast and timeline.
- Organization attribution for AI credits uses the organization granting the user's Copilot license. A cost-center budget takes precedence over the organization budget.
- Cost-center AI overage counts against the enterprise budget by default; cost-center exclusion can give the team independent paid-overage spending authority.
- Enterprise teams can be assigned to cost centers. Team membership is used for cost-center attribution before organization fallback, so admins can model team-based cost-center onboarding.
- Seat additions can be dated in the simulator. GitHub documentation says additional seats are billed on a prorated basis for the remainder of the cycle, and included AI credits may also be prorated. The documented-aligned default prorates both from the assignment date through month end, so a seat added on the 15th of a 30-day month receives 16 days of charge and credits.
- Seat removals are not refunded. Unassignment preserves access through cycle end, while revocation stops access immediately; both retain the current cycle's included pool contribution until the next reset.
- The simulator also offers full mid-cycle credits as an explicitly hypothetical comparison policy. Pool capacity changes on the effective date without retroactively changing earlier events.

## Explicit simulator assumptions

Events are atomic: an event that would cross a hard stop is rejected in full. GitHub documentation describes stopping usage at limits but does not define event-level partial charging behavior. The simulator uses calendar-day proration for mid-cycle seat charges and credits; because GitHub says included credits “may” be prorated without publishing the exact calculation here, full credits remain available as a hypothetical override. Random monthly selection when multiple organizations grant a Copilot license and GitHub's unspecified additional-usage cap are not modeled. Direct user assignment takes precedence over enterprise-team and organization-based cost-center assignment.

## GitHub-aligned wording and state explanations

Cost Compass labels budget configuration with the GitHub admin center terms used under **Billing and licensing** → **Budgets and alerts**: **Budget Type**, **SKU**, **Budget scope**, **Budget amount**, **Stop usage when budget limit is reached**, **Receive budget threshold alerts**, and **Alert Recipients** where modeled. Event cards include a "Why this state?" explanation that walks through the relevant controls in order: user-level budget, included AI credits or cost-center included usage controls, **AI credit paid usage**, then cost-center, organization, or enterprise budgets.

Simulator-only pool-health guidance is labeled separately from GitHub budget alerts because **Receive budget threshold alerts** belongs to budget controls, while included usage controls show consumption against an AI credit pool cap.

## Scenario Studio and budget-health scenarios

The Simulation page includes a guided Scenario Studio. It keeps the current step, expected result, accepted or blocked outcome, budget deltas, alerts, and full health snapshot together so a scenario can be understood without switching to the Dashboard.

Scenario definitions are declarative and support usage, date advancement, configuration changes, and explanatory checkpoints. Built-ins are discovered through `scenarios/catalog.json`, with editor validation from `scenarios/scenario.schema.json`; definitions can also be imported and exported through the browser. See `docs/scenario-studio.md` for the authoring guide.

The budget progression catalog remains documented in `docs/budget-health-scenarios.md`, with machine-verified data in `docs/budget-health-scenarios.json`. The automated tests also execute the built-in guided scenarios, including the case where one further step moves a budget from 90% to exactly `100%`, cost-center included-pool blocking, and cost-center included-pool rollover into paid overage.

## Official references

- [Copilot seats and billing cycles](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/seats-and-billing-cycles)
- [Making changes to your Copilot license](https://docs.github.com/en/copilot/reference/copilot-billing/license-changes)
- [Budgets for Copilot usage-based billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets)
- [Usage-based billing for organizations and enterprises](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing)
- [Budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts)
- [Cost centers](https://docs.github.com/en/billing/concepts/cost-centers)
- [Cost center allocation](https://docs.github.com/en/billing/reference/cost-center-allocation)
- [Cost-center exclusion](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets#cost-center-exclusion)
