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

Previous and jump operations are deterministic: the runner starts from the Configuration-selected
default set, applies `seed` and `setup`, and then applies each step through the requested index. It
does not attempt to undo mutable state. Definitions with authored topology are shown only when
their explicit `compatibleDefaultSetIds` includes the selected set; incompatible definitions are
never previewed or executed.

## Default enterprise baseline

Default baselines are stored as JSON in `scenarios/default-sets/` and selected from the Configuration view. New reusable topology environments are stored under `scenarios/environments/` and contain provenance, entities, products, and budgets, but no events or simulation date. Guided definitions should reference an `environmentId`, can provide an inline `baseline` for a self-contained import, and add optional `seed` usage before `setup` and steps. Definitions without either field are portable and use the selected default set. Definitions with
`defaultSetId`, `environmentId`, or `baseline` must declare one or more compatible default-set IDs.

### Authoring-agent workflow

The repository Default Set Generator and Scenario Generator share this contract. Describe the
tenant scale, roles, license mix, topology, dates, policies, and intended lesson, or explicitly
name defaults to inherit. The default-set agent emits a version-1 environment with synthetic
provenance and records assumptions and omitted capabilities; it adds a data-only catalog entry.
The scenario agent references that environment and keeps events and narrative steps in the
version-1 scenario definition. Both agents preserve the legacy version-2 default-set and
version-1 default-environment modes when requested.

Before import, validate the environment schema and shared reference validator, then materialize
each scenario prefix and replay it. Check observable outcomes such as included and metered
quantities, costs, affected budgets, alerts, hard stops, and blocking reasons. Re-materializing
the same input must produce the same topology and event IDs. A synthetic environment must not
claim live GitHub facts; use `source.assumptions` and `source.omittedCapabilities` for inherited
or simulator-only decisions.

For a compact smoke run, use the checked-in `synthetic-compact` environment: two guided
definitions share its stable `user-alice`, `repo-portal`, `cc-ai`, and `ulb-alice` entities
without copying the topology. Add new environments to `scenarios/environments/catalog.json`,
not to application source.

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
  "compatibleDefaultSetIds": ["compact"],
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

`compatibleDefaultSetIds` declares which selectable default sets can support the definition. It is
required for definitions with `defaultSetId`, `environmentId`, or `baseline`, and each ID must
match a registered default set. `defaultSetId` remains supported as authored metadata for
deterministic direct materialization, but the application always uses the selected Configuration
dataset and filters the definition unless that dataset is listed as compatible. Definitions
without authored topology are portable and are materialized against every selected default set.

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

Built-in definitions are standalone files under `scenarios/`. Add a scenario by creating a JSON file that references `scenario.schema.json`, declare `compatibleDefaultSetIds` when it depends on authored topology, then add its `id` and filename to `scenarios/catalog.json`. Add reusable environments as data files under `scenarios/environments/` and list them in `scenarios/environments/catalog.json`; no application-source registry edit is required. Catalog order controls dropdown order. The application loads and validates every catalog entry at startup; a missing file, duplicate ID, mismatched ID, invalid filename, invalid environment, or invalid definition produces a visible load error.

`src/scenario-runner.js` now contains only validation and execution logic. `src/scenario-catalog.js` handles catalog loading. Custom definitions can still be imported through the Scenario Studio and remain in local browser storage. Tests discover and execute every catalog entry to verify that definitions remain valid, navigation can be reconstructed, and documented boundary outcomes still occur.
