# Copilot Budget Lab agent guide

These instructions apply to the entire repository. Read `.github/copilot-instructions.md` before editing; it is the canonical project, architecture, data-contract, and validation guide.

## Required workflow

1. Start from the owning source module, nearby declarative definition, or failing test.
2. Preserve the dependency-free Node.js ES module architecture unless the request requires otherwise.
3. Keep version-1 guided scenarios separate from version-2 default sets and preserve deterministic replay and valid references.
4. Add or update focused coverage for behavior changes.
5. Run `npm test` before declaring work complete. No install or build step is required.

Path-specific requirements live under `.github/instructions/`. Specialized authoring agents live under `.github/agents/`.