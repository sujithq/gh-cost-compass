# Copilot Budget Lab

A local visual sandbox for explaining and testing GitHub Enterprise and Copilot usage budgets without touching a real GitHub environment.

## Features

- Enterprise → organization → repository hierarchy
- Users and cost-center assignments
- Enterprise, organization, repository, cost-center, and user budgets
- Effective dates, monthly resets, alert thresholds, and hard limits
- Dated AIC/premium-request and other SKU usage simulation
- Live counters, progress bars, attribution details, alerts, and audit timeline
- Scenario import/export, reset, replay, and browser-local persistence
- No GitHub credentials or external services

## Run

Requires Node.js 20 or newer.

```powershell
npm start
```

Open <http://localhost:4173>.

## Test

```powershell
npm test
```

## Simulation rules

Usage is replayed deterministically in date order. A budget applies only on or after its effective date. Accepted usage is attributed to every matching scope. If any applicable hard budget would be exceeded, the complete event is blocked. Counters reset by calendar month while event history remains. Future-dated events remain scheduled until the simulation clock reaches their date.

The included behavior is a configurable teaching model, not a guarantee of GitHub's current billing behavior. Validate customer decisions against current official GitHub documentation.
