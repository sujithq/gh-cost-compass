# Copilot Budget Lab

A local visual sandbox for explaining and testing GitHub Enterprise and Copilot usage-based billing without touching a real GitHub environment.

## Features

- Enterprise → organization → repository hierarchy
- Copilot Business and Enterprise users, license organizations, and cost centers
- Shared monthly AI-credit pool: 1,900 credits per Business seat and 3,900 per Enterprise seat
- Universal, cost-center, and individual user-level budgets (ULBs)
- Separate enterprise, organization, and cost-center metered-overage budgets
- AI paid-usage policy, effective dates, monthly resets, alerts, and hard stops
- Clear split between included AI credits and paid overage
- Dated usage simulation, live progress, attribution details, alerts, and audit timeline
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

## Explicit simulator assumptions

Events are atomic: an event that would cross a hard stop is rejected in full. GitHub documentation describes stopping usage at limits but does not define event-level partial charging behavior. Cost-center assignment through enterprise teams and organization fallback, random monthly selection when multiple organizations grant a Copilot license, automatic cost-center included-usage controls, license changes during a cycle, and GitHub's unspecified additional-usage cap are not yet modeled.

## Official references

- [Budgets for Copilot usage-based billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets)
- [Usage-based billing for organizations and enterprises](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing)
- [Budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts)
- [Cost center allocation](https://docs.github.com/en/billing/reference/cost-center-allocation)
- [Cost-center exclusion](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets#cost-center-exclusion)
