---
name: budget-lab-validation
description: Validate Copilot Budget Lab code, UI, guided scenarios, and default sets. Use after repository changes or when checking deterministic replay, schema integration, references, tests, or release readiness.
argument-hint: "[changed paths or validation focus]"
---

# Budget Lab validation

Use the narrowest applicable checks first, then finish with the complete repository suite.

## Procedure

1. Inspect the changed paths and identify the owning contract in `.github/copilot-instructions.md` and any matching `.github/instructions/*.instructions.md` file.
2. Run `git diff HEAD --check` to catch whitespace errors in staged and unstaged changes without modifying files.
3. Apply the focused checks below for every affected area.
4. Run `npm test`. No dependency installation or build step is required.
5. Review the final diff for accidental files, unsupported assumptions, stale documentation, and untested claims.
6. Report the commands run, pass/fail counts, focused outcomes verified, and anything that could not be checked.

## Focused checks

### Engine or runtime behavior

- Add or run the narrowest relevant cases in `tests/engine.test.js`.
- Assert observable values, not only object shape: accepted or blocked status, reason, shared-pool movement, metered cost, affected budgets, threshold alerts, and date-sensitive state.
- Cover the boundary immediately before and at a hard stop or threshold when the change affects limits.

### Guided scenarios

- Validate the definition against `scenarios/scenario.schema.json` with a standards-compliant Draft 2020-12 JSON Schema validator or editor schema diagnostics. If neither is available, report that gap and do not claim full schema validation.
- Confirm the definition is version 1 and accepted by `validateScenarioDefinition`; this runtime check supplements but does not replace schema validation.
- Confirm its catalog ID and filename match.
- Materialize and replay every behaviorally important step prefix.
- Re-materialize at least one prefix to prove deterministic reconstruction.
- Verify all entity references against every promised default-set baseline.

### Default sets

- Materialize through `createDefaultScenario` and require `validateScenario` to return `null`.
- Check requested materialized counts and uniqueness of IDs.
- Replay representative events and assert status, cost or pool effects, and affected budget IDs.
- Verify generated-user counts account for explicit users, profile counts, and `skipFirst`.

### Browser UI

- Run `npm start` and use the URL printed by the server because it advances past port 4173 when that port is occupied.
- Exercise the changed workflow at desktop and narrow viewport sizes.
- Check the browser console for errors and verify dynamic text does not overlap or shift fixed controls.
- Stop the server after validation.

Do not fix unrelated failures. Record them separately with the exact failing test or check.
