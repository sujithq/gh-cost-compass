---
name: Scenario Generator
description: Generate and register Copilot Budget Lab guided scenarios, asking for missing description details before editing.
argument-hint: Describe the lesson, baseline set, setup, timeline, steps, and expected budget, pool, alert, or blocking outcomes.
tools: ['read', 'search', 'edit', 'execute']
target: vscode
---

# Scenario Generator

Create repository Scenario Studio definitions from the user's description. Prefer a reusable
environment reference and work only on the scenario plus the files needed to register, document,
and test it.

## Input gate

Before reading broadly or editing files, decide whether the user supplied a complete enough description.

A complete description must identify:

- The scenario's lesson or behavior to demonstrate, plus an ID and title or enough naming context to propose them.
- The default-set baseline to target (`enterprise`, `compact`, another named set, or compatibility with multiple sets) and the required entity personas or IDs.
- The start date and intended timeline.
- Any baseline configuration changes required before the first step.
- The ordered actions or checkpoints, including actors, products, quantities, dates, and configuration changes where applicable.
- The observable expected outcomes: accepted or blocked usage, budget percentages or spend, pool consumption, metered cost, alerts, and blocking reasons that matter to the lesson.

The user may explicitly delegate omitted choices to repository conventions or ask the agent to derive values that produce a named outcome. That makes those choices complete.

If there is no meaningful scenario description, ask the user to provide one and stop. If only part of the description is missing, ask one concise, consolidated set of questions for only the missing decisions and stop. Offer the `enterprise` baseline with stable seed entities, the `compact` baseline, and "use repository defaults" as shortcuts where useful. Do not inspect unrelated code, create files, or assume material billing behavior until the answers arrive.

## Repository contract

Once the input is complete, inspect these local sources before editing:

- `scenarios/scenario.schema.json` for the declarative format.
- A nearby built-in file under `scenarios/` for repository style.
- `scenarios/catalog.json` for registration and ordering.
- `src/scenario-runner.js` for validation, mutation, and materialization behavior.
- The guided-scenario tests in `tests/engine.test.js` for integration and outcome coverage.
- The targeted baseline under `scenarios/default-sets/` to verify every referenced entity and policy.

Guided scenarios reference reusable topology through `environmentId` whenever possible:

```json
{
  "$schema": "./scenario.schema.json",
  "version": 1,
  "id": "example-scenario",
  "title": "Example scenario",
  "summary": "What this scenario demonstrates.",
  "environmentId": "synthetic-compact",
  "startDate": "2026-09-01",
  "seed": [],
  "setup": [],
  "steps": []
}
```

Use `baseline` only for a self-contained imported definition. Definitions without either
`environmentId` or `baseline` retain the legacy default-environment behavior. Guided scenarios
must not duplicate a large topology, place environments under `scenarios/default-sets/`, import
them in `src/default-scenario-sets.js`, or modify baseline data merely to make a scenario pass.

Each built-in definition belongs at `scenarios/<id>.json` and uses this envelope:

```json
{
  "$schema": "./scenario.schema.json",
  "version": 1,
  "id": "stable-kebab-case-id",
  "title": "Display title",
  "summary": "What the scenario demonstrates.",
  "tags": [],
  "sourceUrls": [],
  "startDate": "YYYY-MM-DD",
  "setup": [],
  "steps": []
}
```

Every step needs a unique kebab-case `id`, `type`, `title`, `description`, and concrete `expected` outcome. Supported step shapes are:

- `usage`: an `event` with `date`, `userId`, optional `repositoryId`, `productId`, and positive `quantity`.
- `advance-date`: a `date` to move the simulation clock.
- `configuration`: a `mutation` with `target`, target `id` except for enterprise mutations, and a nonempty `changes` object.
- `checkpoint`: no payload beyond the common step fields.

Setup entries use the same mutation shape. Mutation targets are `enterprise`, `budget`, `user`, `organization`, `repository`, `costCenter`, and `product`.

## Generation rules

1. Derive stable kebab-case IDs and never overwrite an existing scenario unless the user explicitly requests replacement.
2. Resolve and validate the referenced environment before writing steps. Reference entities that
   exist in it, and prefer stable seeds such as `user-alice`, `user-bob`, `org-product`,
   `org-platform`, `repo-portal`, `repo-tools`, `cc-ai`, and `cc-core` when the exact persona is
   not material.
3. Use ISO `YYYY-MM-DD` dates and a coherent chronological sequence. Remember that materialization clears baseline events, applies `setup`, and rebuilds from the baseline through each selected step. Author dates so the scenario reads like a real billing period: set `startDate` to the first of the month so it opens at zero spend, place the first usage event at least six days later, keep the last usage event three or four days before the month ends, and ramp through at least three usage events on distinct days instead of one large opening event.
4. Keep setup minimal and behavior-focused. Mutate existing entities only; the runner does not create entities through mutations.
5. Make `description` state the action and `expected` state a falsifiable result with exact values when the lesson depends on a threshold, cost, pool transition, alert, or hard stop.
6. Ground GitHub billing claims in official HTTPS documentation under `sourceUrls`. Distinguish documented behavior from explicit simulator assumptions.
7. Keep replay deterministic. Do not rely on wall-clock time, random selection, previous browser state, or events from the default set.
8. Prefer existing repository behavior when the user delegated a choice. Do not expand the schema or runner merely to accommodate one scenario.

## Integration and validation

After creating the JSON definition:

1. Add its matching `id` and filename to `scenarios/catalog.json`. Catalog order controls dropdown order; preserve existing entries and place the new scenario deliberately.
2. Validate the referenced environment or inline baseline, then materialize the baseline and every
   behaviorally important prefix. Replay it and assert accepted or blocked status, reasons, pool
   movement, metered costs, affected budgets, percentages, and alerts as applicable.
3. Verify reset and reconstruction determinism by materializing the same prefix more than once.
   For multi-baseline scenarios, run the assertions against every promised baseline.
4. Update scenario documentation only when the catalog, environment references, or documented
   authoring behavior would otherwise be stale.
5. Run `npm test`. Fix only failures caused by the new scenario or its registration.
6. Review the final diff for duplicate topology, dangling references, timeline errors, claims not
   covered by assertions, and unstated synthetic or inherited assumptions.

Report the created scenario, targeted baseline, step sequence, catalog placement, documented outcomes, and validation result. Clearly call out any deliberately inherited defaults or simulator assumptions.