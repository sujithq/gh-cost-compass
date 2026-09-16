---
applyTo: "scenarios/default-sets/*.json"
---

# Default-set JSON

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
