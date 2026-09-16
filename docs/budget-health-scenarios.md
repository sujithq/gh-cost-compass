# Budget health progression scenarios

This document captures the expected progression states for the simulator's budget health and the special case where the next simulation step would move a budget from a warning state to `100%`.

The simulator uses a simple ratio:

- `progressPercent = (currentUsage / limit) * 100`
- `nextStepTo100 = limit - currentUsage`

A budget is considered to be approaching the threshold when the current usage is high enough to trigger the configured alert policy. The final case below shows the point where a single additional event would reach 100% exactly.

## Scenario catalog

| Scenario | Scope | Current usage | Limit | Progress | Next step to 100% | Health story |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Shared AI credit pool | Organization | 4,100 | 5,800 | 71% | 1,700 | Healthy but visibly trending upward. |
| User-level budget | User | 34 | 45 | 76% | 11 | Warning state before hard-stop risk. |
| Cost-center budget | Cost center | 190 | 250 | 76% | 60 | Warning state with limited headroom. |
| Organization budget near cap | Organization | 270 | 300 | 90% | 30 | High-risk state; the next step would hit the cap. |
| User budget at threshold | User | 49 | 50 | 98% | 1 | The next simulation event would push usage to 100%. |

## Simple progress scenarios

These examples show a budget that is still below the hard-stop condition but is clearly moving toward the cap.

### 1. Shared pool, 71% consumed

The organization has consumed 4,100 of 5,800 AI credits. The budget health card should show moderate usage, and the alerting policy should still be in a pre-warning state.

- Progress: `4100 / 5800 = 0.7069` -> `71%`
- Remaining: `5800 - 4100 = 1700`
- Result: the budget is healthy, but not fully available for future usage.

### 2. User budget, 76% consumed

A user has used 34 of 45 available units. This demonstrates the warning pattern for a user-level budget: the current state is meaningful, but not yet at the configured enforcement ceiling.

- Progress: `34 / 45 = 0.7556` -> `76%`
- Remaining: `45 - 34 = 11`
- Result: the next event is still allowed unless policy is configured to stop earlier.

## Next-step 100% scenarios

These examples intentionally show the point where the next simulation step would cause the budget to reach exactly 100%.

### 3. Organization budget at 90%

An organization has used 270 of 300 units. The next event would add 30 more and move the budget from 90% to 100%.

- Progress: `270 / 300 = 0.9` -> `90%`
- Remaining: `300 - 270 = 30`
- Result: the next simulation step would hit the cap.

### 4. User-level budget at 98%

A user is at 49 of 50 units. This is the clearest demonstration of the next-step saturation condition.

- Progress: `49 / 50 = 0.98` -> `98%`
- Remaining: `50 - 49 = 1`
- Result: one additional unit would reach `100%` and trigger the configured enforcement or alert behavior.

## What to watch in the UI

When these scenarios are simulated in the dashboard:

1. A simple-progress state should show a steady health bar without an immediate hard stop.
2. A near-cap state should show a warning or elevated alert state.
3. A next-step saturation example should make the next event clearly visible as the trigger for the 100% state.

This is useful for validating that the visualization, event ordering, and hard-stop logic all agree with the same underlying arithmetic.
