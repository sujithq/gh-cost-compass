# GitHub AI-credit control model

## Control matrix

| Control | Included usage | Metered usage | Notification | Enforcement |
|---|---:|---:|---|---|
| Included-usage alerts | Yes | No | 90%, 100% | Notification only |
| Universal ULB | Yes | Yes | Not consistently available | Always hard stop |
| Cost-center ULB | Yes | Yes | Not consistently available | Always hard stop per user |
| Individual ULB | Yes | Yes | Not consistently available | Always hard stop |
| Cost-center included-usage control | Yes | Routes excess to metered checks | Cap visibility | Included boundary |
| Cost-center budget | No | Yes | 75%, 90%, 100% | Optional hard stop |
| Organization budget | No | Yes | 75%, 90%, 100% | Optional hard stop |
| Enterprise budget | No | Yes | 75%, 90%, 100% | Optional hard stop |

## Request evaluation order

1. Check the most specific applicable ULB: individual, cost-center, then universal.
2. Check the shared pool or cost-center included-usage cap.
3. When included allowance is exhausted, check the enterprise AI-credit paid-usage setting.
4. Check the applicable cost-center or organization metered budget.
5. Check the enterprise metered budget when applicable.
6. The applicable hard control with the least remaining headroom blocks first.

## Interpretation

- Paid usage disabled: block when the applicable included allowance is exhausted.
- Paid usage enabled: proceed to metered-budget checks after included exhaustion.
- A checked cost-center included cap selects a license-funded included boundary; it is not
  a separate block-versus-overage selector.
- Aggregate budget stop enabled: alert at thresholds and block at the limit.
- Aggregate budget stop disabled: alert but continue metered usage.
- ULBs count total consumption and always stop at their limit.
- Cost-center usage counts against the enterprise budget unless exclusion is enabled.
- Enterprise-team membership can feed cost-center assignment but is not itself a budget
  scope.

Keep separate measures for included-pool consumption, total AI consumption, metered
overage, ULB utilization, unassigned usage, and forecast exposure.
