# Copilot Budget Lab

A local visual sandbox for explaining and testing GitHub Enterprise and Copilot usage-based billing without touching a real GitHub environment.

## Features

- Enterprise → organization → repository hierarchy
- Copilot Business and Enterprise users, enterprise teams, license organizations, and direct, team, repository, or organization-based cost-center assignment
- Shared monthly AI-credit pool: 1,900 credits per Business seat and 3,900 per Enterprise seat
- Cost-center AI credit pools with block-at-cap or continue-to-overage behavior
- Universal, cost-center, and individual user-level budgets (ULBs)
- Separate enterprise, organization, and cost-center metered-overage budgets
- AI paid-usage policy, effective dates, monthly resets, alerts, and hard stops
- Clear split between included AI credits and paid overage
- Dated usage simulation, live progress, attribution details, included-pool health, alerts, and audit timeline
- Clickable budget and shared-pool cards with an accessible history dialog showing the current-period events that drove their state
- Toast notifications when a budget threshold alert fires or an event is blocked, with severity colouring, GitHub's alert-delivery caveat, and a shortcut into the budget history
- Documentation-backed configuration help, source links, and live cost/access impact previews
- Scenario import/export, reset, replay, and browser-local persistence
- A preview-first Scenario Studio with non-destructive step selection, explicit execution controls, predicted and actual budget/pool deltas, alerts, and health snapshots
- Extensible declarative scenario definitions loaded from `scenarios/catalog.json`, with JSON Schema support and browser-local import/export
- A documented scenario catalog for budget health progression and the next-step 100% saturation case

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
