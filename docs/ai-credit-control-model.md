# AI-credit control model

This document is the canonical contributor specification for how Copilot Budget Lab models
GitHub AI-credit controls. The visual companion is
[AI-credit control flow](presentation/ai-credit-control-flow.html).

GitHub's product UI and documentation use similar language for controls that measure different
things. Keep the following four concepts separate:

1. The enterprise-wide **AI credit paid usage** setting decides whether a request may enter paid usage.
2. **Included usage** is funded by Copilot licenses and produces no additional charge.
3. **User-level budgets (ULBs)** limit one user's total included plus metered consumption.
4. **Aggregate budgets** measure and optionally stop metered charges only.

## Request evaluation

For each AI-credit-consuming request:

1. Select the most-specific active ULB: individual, then cost-center ULB, then universal ULB.
2. Block the whole request if it would exceed that ULB. ULBs are always hard stops.
3. Select the applicable included allowance:
   - A user in a cost center with **AI credit included usage cap** enabled uses that cost
     center's license-funded included allowance.
   - Otherwise, the user draws from the shared enterprise included pool.
4. Serve the request from the applicable included allowance while capacity remains.
5. If any part requires overage, evaluate the enterprise **Copilot settings → AI Controls → Copilot → Billing & usage →
   AI credit paid usage**:
   - **Enabled:** paid usage is permitted for all products.
   - **Enabled for selected products:** paid usage is permitted only for selected products.
   - **Disabled:** block the request before metered budgets are evaluated.
6. For permitted paid usage, evaluate every applicable aggregate budget:
   - Use the cost-center branch when the user is attributed to a cost center.
   - Otherwise, use the license-organization branch when an organization budget applies.
   - Also evaluate the enterprise budget unless the cost center is excluded.
7. Block the whole request if it would exceed any applicable aggregate budget with **Stop usage
   when budget limit is reached** enabled.
8. Otherwise accept the request. Increment the selected ULB by total AI-credit value and each
   applicable aggregate budget by the metered charge.

Events are atomic in the simulator. A request that crosses a hard boundary is rejected in full;
GitHub does not document partial event charging.

## Controls and meter bases

| Control | Scope | Included usage counts? | Metered usage counts? | Enforcement |
| --- | --- | ---: | ---: | --- |
| AI credit paid usage | Enterprise-wide setting | N/A | Authorizes entry | Enabled, enabled for selected products, or disabled |
| Cost-center included usage cap | Cost-center aggregate | Yes | No | Selects included boundary |
| Universal ULB | Each licensed user | Yes | Yes | Always hard stop |
| Cost-center ULB | Each member of one cost center | Yes | Yes | Always hard stop |
| Individual ULB | One user | Yes | Yes | Always hard stop |
| Cost-center budget | Cost-center aggregate | No | Yes | Optional hard stop |
| Organization budget | Organization aggregate | No | Yes | Optional hard stop |
| Enterprise budget | Enterprise aggregate | No | Yes | Optional hard stop |

The same paid request can increment a user's ULB, a cost-center or organization budget, and the
enterprise budget. These are overlapping meters, not sequential wallets.

## Cost-center included usage cap

The cost-center definition exposes one relevant setting:
`ai_credit_pool_enabled` in the public REST API.

- **Disabled:** cost-center members draw from the shared enterprise included pool.
- **Enabled:** members share only the credits funded by licenses attributed to that cost center.

The enabled cap partitions the enterprise pool; it does not create additional credits. Reaching
the cap does not itself define a block-versus-overage choice. The enterprise paid-usage setting and downstream
hard budgets determine whether additional usage continues.

The public cost-center REST schema has no separate `block` versus `allowOverage` transition field.
The simulator must not expose or evaluate a control such as `aiCreditPoolCapMode` unless a real
GitHub control can be demonstrated.

## Budget applicability

### User-level budgets

Only one ULB applies to a user:

```text
individual ULB > cost-center ULB > universal ULB
```

A cost-center ULB is not a shared team budget. Its configured amount is applied independently to
every member. Raising one user's individual ULB does not add headroom to the cost-center budget.

### Aggregate metered budgets

For cost-center-attributed usage:

```text
cost-center metered budget
AND enterprise metered budget, unless the cost center is excluded
```

For a user without cost-center attribution:

```text
license-organization metered budget, when configured
AND enterprise metered budget
```

An organization budget does not replace a cost-center budget when cost-center attribution applies.
A soft aggregate budget alerts and continues beyond 100%. A hard aggregate budget blocks a request
that would exceed its remaining headroom.

## Lowest applicable headroom wins

Configured amounts cannot be compared directly because ULBs and aggregate budgets use different
meter bases. Compare the proposed request with each applicable control's remaining headroom:

```text
user_headroom =
  selected_ulb_amount - user's total AI-credit consumption

cost_center_headroom =
  cost_center_budget_amount - cost-center metered charges

organization_headroom =
  organization_budget_amount - organization metered charges

enterprise_headroom =
  enterprise_budget_amount - enterprise metered charges
```

The request is blocked by any applicable hard control that lacks enough headroom. A broader budget
cannot override a more restrictive control.

## Customer intent map

| Customer goal | Primary control | Important limitation |
| --- | --- | --- |
| Limit each cost-center member's total consumption | Cost-center ULB | Per-user, not team aggregate |
| Restrict one heavy user | Individual ULB | Overrides cost-center and universal ULBs |
| Keep a team within its license-funded included share | Cost-center included usage cap | Not a total hard stop |
| Cap a team's aggregate paid overage | Hard cost-center budget | Does not count included usage |
| Cap enterprise-wide paid overage | Hard enterprise budget | Excluded cost centers bypass it |
| Cap a team's aggregate included plus paid usage | Native controls plus custom reporting | No single native aggregate all-in budget |

For the common question, "What is the best way to guardrail the total budget of people in a cost
center?", first clarify whether **total** means:

- **Each person's total consumption:** use a cost-center ULB and justified individual overrides.
- **The team's aggregate paid spend:** use a cost-center metered budget with Stop Usage enabled.
- **The team's aggregate all-in consumption:** use the included cap, per-user ULBs, and custom
  aggregate reporting because the native cost-center budget measures paid overage only.

## Scenario matrix

Use table-driven or pairwise coverage for the dimensions below, plus explicit exact-boundary tests.
Do not create a fragile exhaustive Cartesian suite.

| Dimension | Values |
| --- | --- |
| Paid-usage policy | Enabled, selected products, disabled |
| Cost-center included cap | Enabled, disabled |
| Applicable ULB | None, universal, cost-center, individual |
| Cost-center budget | Missing, soft, hard, zero, enough/insufficient headroom |
| Organization budget | Missing, soft, hard |
| Enterprise budget | Missing, soft, hard, zero, enough/insufficient headroom |
| Cost-center exclusion | Included, excluded |
| Included allowance | Has room, exact boundary, split request, exhausted |

At minimum, executable scenarios must prove:

1. Included cost-center usage moves the included meter but not aggregate metered budgets.
2. Exhausted included usage blocks when the enterprise paid-usage setting disallows the product.
3. Permitted overage increments the selected ULB, cost-center budget, and enterprise budget
   together.
4. The cost-center hard budget blocks first when it has the least headroom.
5. The enterprise hard budget blocks first when it has the least headroom.
6. Soft budgets alert and continue past 100%.
7. A missing cost-center budget leaves the enterprise budget as the aggregate paid guardrail.
8. Cost-center exclusion removes enterprise-budget impact.
9. ULBs can block while included capacity remains.
10. Users without cost-center attribution follow the organization branch.
11. Exact-limit requests pass, while requests crossing hard limits are rejected atomically.

Assertions must cover acceptance or blocking, reason, included-pool movement, metered quantity and
cost, affected budgets, percentages, and alerts.

## Official sources

- [Usage-based billing for organizations and enterprises](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing)
- [Budgets for usage-based billing](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets)
- [Budget REST API](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/budgets)
- [Cost-center REST API](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/cost-centers)
- [Billing usage REST API](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage)
