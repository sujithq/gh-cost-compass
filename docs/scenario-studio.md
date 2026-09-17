# Scenario Studio

The Simulation page contains a guided Scenario Studio. It runs a scenario one step at a time and keeps the result, budget changes, alerts, shared-pool usage, and complete budget-health snapshot beside the step list. The user does not need to switch to the Dashboard to understand an outcome.

## Controls

- **Start / reset** restores the selected scenario's deterministic baseline.
- Selecting a step previews its inputs, expected outcome, predicted budget/pool changes, alerts, and blocking without changing simulation state.
- **Previous** rebuilds the scenario through the preceding applied step.
- **Run next step** applies only the next pending step.
- **Run selected step** rebuilds through the selected step; any preceding pending steps are applied in order and are called out in the preview.
- **Run all** first shows a summary of every remaining step and requires a second confirmation click.
- The outcome area keeps predictions clearly separated from the actual result of the latest applied step.
- Step navigation does not create informational toasts; alerts and blocked usage still use the bounded toast stack, so repeated execution remains responsive while important signals remain visible inline.
- **Import definition** adds or replaces a custom scenario in browser storage.
- **Export** downloads the selected definition as JSON.

Previous and jump operations are deterministic: the runner recreates the default environment, applies `setup`, and then applies each step through the requested index. It does not attempt to undo mutable state.

## Default enterprise baseline

Default baselines are stored as JSON in `scenarios/default-sets/` and selected from the Configuration view. The enterprise baseline is a deterministic synthetic tenant with 10 organizations, 20 cost centers, 20 repositories, and 200 licensed users. The compact baseline keeps the original two-user demo shape for focused walkthroughs. The enterprise user set includes software engineers, data scientists, project managers, security engineers, SREs, analysts, and designers. Some users intentionally have `costCenterId: null`; those users can still consume the enterprise shared AI-credit pool and fall back to organization or enterprise budget attribution unless an organization-based cost-center assignment applies.

Built-in scenarios should prefer stable seed entities such as `user-alice`, `user-bob`, `org-product`, `org-platform`, `repo-portal`, `repo-tools`, `cc-ai`, and `cc-core` when the exact persona is not important. This keeps examples readable while the surrounding generated tenant gives the dashboard enterprise-scale context.

## Definition format

Scenario definitions use version 1:

```json
{
  "version": 1,
  "id": "example-scenario",
  "title": "Example scenario",
  "summary": "What this scenario demonstrates.",
  "defaultSetId": "compact",
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

`defaultSetId` is optional for backward compatibility with imported definitions. When present, it
is the authored baseline for every preview, reset, jump, and replay, regardless of the ad hoc
default set selected in Configuration. The runner rejects unknown default-set IDs. Definitions
without `defaultSetId` use the currently selected default set, which is the legacy behavior for
custom definitions; built-in scenarios should always declare the baseline their documented outcomes
were authored against.

## Supported step types

| Type | Required data | Behavior |
| --- | --- | --- |
| `usage` | `event` | Adds an immutable usage event and advances the simulation date when necessary. |
| `advance-date` | `date` | Moves the simulation clock without adding usage. |
| `configuration` | `mutation` | Applies an effective scenario configuration change. |
| `checkpoint` | None beyond common fields | Pauses for explanation and previews the next step when available. |

Every step requires a unique `id`, `title`, `description`, and `expected` outcome. Setup and configuration mutations target `enterprise`, `budget`, `user`, `organization`, `repository`, `costCenter`, `enterpriseTeam`, or `product`. Non-enterprise targets also require the existing entity `id` and a `changes` object.

Cost-center scenarios can toggle `aiCreditPoolEnabled` and `aiCreditPoolCapMode` to model the documented included-usage control. Use `aiCreditPoolCapMode: "block"` when the cost center should stop at its included-pool cap, or `"allowOverage"` when usage should continue into paid overage subject to the enterprise paid-usage policy and metered budgets.

## Adding scenarios

Built-in definitions are standalone files under `scenarios/`. Add a scenario by creating a JSON file that references `scenario.schema.json`, then add its `id` and filename to `scenarios/catalog.json`. Catalog order controls dropdown order. The application loads and validates every catalog entry at startup; a missing file, duplicate ID, mismatched ID, invalid filename, or invalid definition produces a visible load error.

`src/scenario-runner.js` now contains only validation and execution logic. `src/scenario-catalog.js` handles catalog loading. Custom definitions can still be imported through the Scenario Studio and remain in local browser storage. Tests discover and execute every catalog entry to verify that definitions remain valid, navigation can be reconstructed, and documented boundary outcomes still occur.
