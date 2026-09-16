# Scenario Studio

The Simulation page contains a guided Scenario Studio. It runs a scenario one step at a time and keeps the result, budget changes, alerts, shared-pool usage, and complete budget-health snapshot beside the step list. The user does not need to switch to the Dashboard to understand an outcome.

## Controls

- **Start / reset** restores the selected scenario's deterministic baseline.
- **Previous** rebuilds the scenario through the preceding step.
- **Next** applies one step.
- **Run all** applies every remaining step.
- Selecting a step rebuilds the scenario through that point.
- **Import definition** adds or replaces a custom scenario in browser storage.
- **Export** downloads the selected definition as JSON.

Previous and jump operations are deterministic: the runner recreates the default environment, applies `setup`, and then applies each step through the requested index. It does not attempt to undo mutable state.

## Definition format

Scenario definitions use version 1:

```json
{
  "version": 1,
  "id": "example-scenario",
  "title": "Example scenario",
  "summary": "What this scenario demonstrates.",
  "tags": ["budget health"],
  "sourceUrls": [
    "https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets"
  ],
  "startDate": "2026-09-15",
  "setup": [
    {
      "target": "budget",
      "id": "ulb-alice",
      "changes": { "amount": 50 }
    }
  ],
  "steps": [
    {
      "id": "consume-credits",
      "type": "usage",
      "title": "Consume credits",
      "description": "Alice consumes 500 AI credits.",
      "expected": "The user budget increases by $5.",
      "event": {
        "date": "2026-09-15",
        "userId": "user-alice",
        "repositoryId": "repo-portal",
        "productId": "ai-credits",
        "quantity": 500
      }
    }
  ]
}
```

## Supported step types

| Type | Required data | Behavior |
| --- | --- | --- |
| `usage` | `event` | Adds an immutable usage event and advances the simulation date when necessary. |
| `advance-date` | `date` | Moves the simulation clock without adding usage. |
| `configuration` | `mutation` | Applies an effective scenario configuration change. |
| `checkpoint` | None beyond common fields | Pauses for explanation and previews the next step when available. |

Every step requires a unique `id`, `title`, `description`, and `expected` outcome. Setup and configuration mutations target `enterprise`, `budget`, `user`, `organization`, `repository`, `costCenter`, or `product`. Non-enterprise targets also require the existing entity `id` and a `changes` object.

## Adding scenarios

Built-in definitions live in `src/scenario-runner.js`. Custom definitions can be imported through the Scenario Studio and remain in local browser storage. Tests execute the built-in catalog to verify that definitions remain valid, navigation can be reconstructed, and documented boundary outcomes still occur.
