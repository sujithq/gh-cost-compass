# Authoring-agent smoke run

This repository keeps two authoring agents:

- **Default Set Generator**: emits a reusable version-1 environment by default, with `source`
  provenance, synthetic assumptions, omitted capabilities, and topology-only data. It retains
  the version-2 default-set path for explicit legacy requests.
- **Scenario Generator**: references an environment with `environmentId`, places usage in `seed`
  or steps, and retains inline `baseline` and legacy default-environment modes.

## Natural-language smoke run

Input: “Create a compact synthetic enterprise for deterministic budget lessons. Use two
organizations, two cost centers, Alice and Bob with Enterprise and Business licenses, the
standard AI-credit and metered products, stable fixture IDs, and no live usage history. Reuse
repository defaults for dates and budget thresholds.”

The generated artifact is `scenarios/environments/synthetic-compact.json`. The run records that
the tenant is synthetic, that budget amounts and license dates are simulator fixtures, and that
live usage history and real tenant identity/billing records are omitted. Its topology is loaded
through `scenarios/environments/catalog.json`; no application-source registry edit is needed.

Two guided definitions reuse the artifact without copying its topology:
`budget-health-progression` and `pool-to-paid-overage`. Their events remain in the scenario files,
and both use the stable `user-alice`, `repo-portal`, `cc-ai`, and `ulb-alice` references.

## Validation evidence

The smoke artifact is checked by the shared `validateEnvironment` reference validator and loaded
through the same environment catalog path used by the application. Focused tests assert the
topology-only boundary, synthetic provenance, shared environment ID, stable entity references,
accepted replay outcomes, the exact 100% ULB boundary, and deterministic re-materialization.
The complete repository suite passed with **62 tests passed, 0 failed, 0 skipped**.

The runtime validator is intentionally supplemented by the checked-in Draft 2020-12
`scenarios/environment.schema.json`. When an external JSON Schema validator is available in an
authoring environment, run it against the environment file before import; do not treat shape-only
inspection as sufficient validation.
