---
applyTo: "scenarios/*.json"
---

# Guided scenario JSON

Files directly under `scenarios/` are guided Scenario Studio definitions, except for the supporting `catalog.json` and `scenario.schema.json` files. Do not use the version-2 default-set format here.

- New guided scenarios must reference `./scenario.schema.json`, use version 1, have a stable kebab-case ID, and contain at least one step.
- Register each definition in `scenarios/catalog.json`; the catalog ID must equal the definition ID and the filename must be a safe local JSON filename. Preserve deliberate catalog ordering.
- Every step needs a unique ID, type, title, description, and falsifiable expected outcome. Supported types are `usage`, `advance-date`, `configuration`, and `checkpoint`.
- Prefer `environmentId` to reuse a registered topology. Use an inline `baseline` only for a
  self-contained import; definitions with neither field retain the legacy default-environment
  behavior. Do not duplicate a large environment in each guided file.
- Setup and configuration steps may mutate existing enterprise, budget, user, organization, repository, cost-center, or product data. They cannot create entities.
- Verify every referenced entity exists in each promised default-set baseline. Prefer stable seed IDs when the exact persona is not material.
- Keep dates chronological and replay deterministic. Materialization clears baseline events and rebuilds from the baseline through the selected step.
- Use official HTTPS GitHub documentation in `sourceUrls` for billing claims and identify simulator assumptions explicitly.
- Add focused assertions in `tests/engine.test.js` for all documented outcomes, including status, blocking reason, pool movement, cost, affected budgets, percentages, or alerts as applicable.
- Run `npm test` after any definition, catalog, or schema change.

Environment references are data-only imports from `scenarios/environments/catalog.json`; adding
one must not require an application-source registry edit. Validate the environment's provenance,
cross-references, licensing-org membership, intentional attribution, and replay outcomes before
registering or documenting a scenario.
