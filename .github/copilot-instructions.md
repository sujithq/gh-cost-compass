# Copilot Budget Lab repository instructions

## Project shape

Copilot Budget Lab is a dependency-free Node.js 20+ ES module application. It serves a browser UI for deterministic GitHub Enterprise and Copilot billing simulations. Preserve the existing plain HTML, CSS, and JavaScript architecture unless a task explicitly requires a framework or dependency.

No install or build step is required. There is no lockfile and no lint script.

- Run all tests with `npm test`.
- Start the local server with `npm start`; it begins at port 4173 and retries the next port when occupied.
- Run `npm test` after every code, scenario, or default-set change.

## Ownership map

- `src/engine.js` owns domain calculations, replay, budget matching, shared-pool behavior, and version-2 scenario validation.
- `src/default-scenario-sets.js` loads default-set JSON and deterministically expands generated users.
- `src/scenario-runner.js` validates and materializes guided Scenario Studio definitions.
- `src/scenario-catalog.js` loads the external guided-scenario catalog.
- `src/app.js` owns browser state, rendering, and interactions.
- `tests/engine.test.js` is the executable contract for engine, catalog, scenario, UI-markup, and toast behavior.
- `.github/extensions/budget-lab/extension.mjs` is a project-scoped canvas extension (`canvasId: "budget-lab"`) that lets a Copilot chat/CLI session open this app as a live side panel instead of running `npm start` manually. It hosts the same static app over a loopback-only HTTP server and exposes `/api/assistant`, wired to the live Copilot session, for the experimental LLM-backed assistant.

## Opening the canvas app

When a user asks to open, preview, or "spin up" the Budget Lab canvas, open the `budget-lab` canvas (see `.github/extensions/budget-lab/extension.mjs`) rather than starting a terminal server. Its `inputSchema.assistantBackend` **must keep `scripted` as the default** — only pass `assistantBackend: "copilot"` when the user explicitly asks for the Copilot-backed assistant. Never change that default, and never make the extension auto-detect or probe for Copilot availability, so every unconfigured instance and `npm start` keep behaving identically to before this extension existed.

## Data contracts

Keep the two scenario formats distinct:

- Default sets live in `scenarios/default-sets/*.json`. Their envelope contains a version-2 runtime scenario and may contain deterministic `generatedUsers`. Register them in `src/default-scenario-sets.js`; never add them to `scenarios/catalog.json`.
- Guided scenarios live directly under `scenarios/*.json`, use version 1 and `scenarios/scenario.schema.json`, and are registered in `scenarios/catalog.json`. They materialize against a selected default set.

Preserve stable readable IDs when existing scenarios or tests depend on them, including `user-alice`, `user-bob`, `org-product`, `org-platform`, `repo-portal`, `repo-tools`, `cc-ai`, and `cc-core`. Keep all entity references valid and all replay behavior deterministic.

User-level AI budgets use the canonical `ai-credits` product ID and are hard stops. Tests for scenario claims must assert observable replay outcomes such as acceptance or blocking, reasons, pool movement, cost, affected budgets, percentages, and alerts rather than validating shape alone.

## Change discipline

- Make the smallest change that satisfies the requested behavior and follow nearby patterns.
- Do not add dependencies or generated package metadata without a concrete need.
- Update focused tests whenever behavior or a declarative scenario contract changes.
- Update documentation when user-visible behavior, supported scenario formats, or available defaults become stale.
- Ground GitHub billing claims in official GitHub documentation and label simulator assumptions explicitly.
- Do not overwrite unrelated work or reformat unrelated files.