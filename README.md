# Copilot Budget Lab

A local visual sandbox for explaining and testing GitHub Enterprise and Copilot usage-based billing without touching a real GitHub environment.

## Features

- Enterprise → organization → repository hierarchy
- Copilot Business and Enterprise users, license organizations, and direct or organization-based cost-center assignment
- Shared monthly AI-credit pool: 1,900 credits per Business seat and 3,900 per Enterprise seat
- Universal, cost-center, and individual user-level budgets (ULBs)
- Separate enterprise, organization, and cost-center metered-overage budgets
- AI paid-usage policy, effective dates, monthly resets, alerts, and hard stops
- Clear split between included AI credits and paid overage
- Dated usage simulation, live progress, attribution details, alerts, and audit timeline
- Clickable budget and shared-pool cards with an accessible history dialog showing the current-period events that drove their state
- Documentation-backed configuration help, source links, and live cost/access impact previews
- Scenario import/export, reset, replay, and browser-local persistence

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
- A ULB measures one user's **total** AI-credit consumption across both included and metered phases. It is always a hard stop.
- ULB precedence is individual → cost-center ULB → universal ULB.
- Enterprise, organization, and cost-center spending budgets measure **only paid overage after the shared pool is exhausted**.
- Disabling the AI credits paid-usage policy blocks usage when the pool is exhausted regardless of metered-budget headroom.
- Budgets count usage only from their creation/effective date onward. Standard alerts use 75%, 90%, and 100% thresholds.
- Organization attribution for AI credits uses the organization granting the user's Copilot license. A cost-center budget takes precedence over the organization budget.
- Cost-center AI overage counts against the enterprise budget by default; cost-center exclusion can give the team independent spending authority.
- Seat additions can be dated in the simulator. GitHub documentation says additional seats are billed on a prorated basis for the remainder of the cycle, and included AI credits may also be prorated. The documented-aligned default prorates both from the assignment date through month end, so a seat added on the 15th of a 30-day month receives 16 days of charge and credits.
- Seat removals are not refunded. Unassignment preserves access through cycle end, while revocation stops access immediately; both retain the current cycle's included pool contribution until the next reset.
- The simulator also offers full mid-cycle credits as an explicitly hypothetical comparison policy. Pool capacity changes on the effective date without retroactively changing earlier events.

## Explicit simulator assumptions

Events are atomic: an event that would cross a hard stop is rejected in full. GitHub documentation describes stopping usage at limits but does not define event-level partial charging behavior. The simulator uses calendar-day proration for mid-cycle seat charges and credits; because GitHub says included credits “may” be prorated without publishing the exact calculation here, full credits remain available as a hypothetical override. Cost-center assignment through enterprise teams, random monthly selection when multiple organizations grant a Copilot license, automatic cost-center included-usage controls, and GitHub's unspecified additional-usage cap are not modeled. Direct user assignment takes precedence over organization-based cost-center assignment.

## Official references

- [Copilot seats and billing cycles](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/seats-and-billing-cycles)
- [Making changes to your Copilot license](https://docs.github.com/en/copilot/reference/copilot-billing/license-changes)
- [Budgets for Copilot usage-based billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets)
- [Usage-based billing for organizations and enterprises](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing)
- [Budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts)
- [Cost center allocation](https://docs.github.com/en/billing/reference/cost-center-allocation)
- [Cost-center exclusion](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets#cost-center-exclusion)
