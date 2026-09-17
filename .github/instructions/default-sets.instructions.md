---
applyTo: "scenarios/default-sets/*.json"
---

# Default-set and environment JSON

New topology authoring uses the reusable environment contract in
`scenarios/environment.schema.json`. Prefer `scenarios/environments/*.json` for synthetic or
imported topology that can be shared by multiple guided scenarios. Environments use version 1,
include `source` provenance, and contain entities, products, and budgets only: never events or
`simulationDate`. Register them in `scenarios/environments/catalog.json`; do not hand-edit an
application-source registry. Record synthetic assumptions and omitted capabilities explicitly.

Guided definitions reference an environment with `environmentId` and keep usage in `seed` or
steps. A genuinely unattributed user has no direct, team, or organization-fallback attribution.

Files under `scenarios/default-sets/` define selectable version-2 runtime baselines. They are not guided Scenario Studio definitions and must not be added to `scenarios/catalog.json`.

- Keep the top-level `id`, `name`, `summary`, and `scenario` envelope consistent with nearby sets.
- The runtime scenario needs version 2, enterprise data, a simulation date, and arrays for organizations, repositories, cost centers, users, products, budgets, and events.
- Preserve unique stable IDs and referential integrity across every collection. Keep each user's `licenseOrganizationId` among their `organizationIds`.
- User-level budgets must target the canonical `ai-credits` product ID, use a coherent `userBudgetType`, and use hard enforcement.
- Use top-level `generatedUsers` only for deterministic repetition supported by `src/default-scenario-sets.js`. Materialized users equal explicit users plus profile counts minus `skipFirst`.
- Report materialized counts in the summary. Seed explicit users when budgets, events, scenarios, or tests require stable readable IDs.
- Import and register new sets in `src/default-scenario-sets.js`. Do not change the default set unless requested.
- Extend `tests/engine.test.js` to materialize the set, run `validateScenario`, check unique IDs and requested counts, and assert representative replay outcomes and affected budgets.
- Run `npm test` after any default-set or registration change.

Legacy version-2 default sets remain supported for compatibility. Use them when a request
explicitly asks for a selectable runtime baseline, generated users, or an existing default-set
workflow. Do not migrate or overwrite one implicitly. Legacy sets keep their events and
`simulationDate`, are registered in `src/default-scenario-sets.js`, and must not be added to the
environment or guided-scenario catalogs.
