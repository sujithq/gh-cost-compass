# Token Lens integration boundary

Token Lens is a local, per-developer usage analysis tool—not an enterprise fleet view, invoice, or
bill. Combining reports does not authenticate the developer identity or establish complete
organization coverage. Keep GitHub's Copilot usage-metrics API as the authoritative source for
exact user/day AI credits and cost-centre chargeback.

## Current collection and sharing model

The upstream implementation is in the private
[`mcaps-microsoft/ghcp-tokenomics` Token Lens source tree](https://github.com/mcaps-microsoft/ghcp-tokenomics/tree/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens)
at commit `b3efd0ad35d9eaf3823372ab605d97edcf914225`. Readers need Microsoft EMU access to the
private repository. The relevant immutable sources are the
[README](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/README.md),
[plugin skill](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/plugin/skills/chronicle-report/SKILL.md),
[plugin manifest](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/plugin/plugin.json),
[session collector](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/session-collect.mjs),
[session exporter](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/session-export.mjs),
[chat collector](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/chat-collect.mjs),
[preflight script](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/preflight.ps1),
[finalizer](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/finalize.ps1),
and [report schema](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/schema/token-lens-report.schema.json).

- It is not a background collector. The [README](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/README.md)
  documents manual npm-tarball distribution (`npm pack`), developer installation, and the
  `copilot-token-lens collect` command. The optional
  [plugin manifest](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/plugin/plugin.json)
  exposes `/chronicle-report`; its
  [skill frontmatter](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/plugin/skills/chronicle-report/SKILL.md)
  is user-invocable and disables model invocation, so it cannot trigger itself.
- Collection is local and makes no network call. The CLI reads the local Copilot CLI SQLite
  session store and WAL sidecars plus editor chat session files
  ([session collector](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/session-collect.mjs),
  [chat collector](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/chat-collect.mjs)).
  The plugin skill reads the compatible CLI store only; native IDE telemetry is separate.
- The CLI writes to the current directory or an explicit `--out` path. The plugin writes under
  `COPILOT_PLUGIN_DATA`, `PLUGIN_DATA`, or `~/.copilot/chronicle-report` (see the
  [skill](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/plugin/skills/chronicle-report/SKILL.md)).
  There is no shared central location, uploader, or background service in the current source; the
  [README](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/README.md)
  instructs the developer to send the generated report file.
- The finalized session-export contains aggregate token counts, resolved model, and tool-call round
  count without a developer identifier or conversation prose
  ([session exporter](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/session-export.mjs)).
  The evidence collector is more sensitive: it reads repository names, file paths, checkpoint
  titles, and summaries. `--redact` hashes repository and file names
  ([session collector](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/session-collect.mjs)).

## Privacy boundary

Do not treat local extraction as safe merely because a collector's SQL does not select prompt and
reply columns. The [plugin skill](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/plugin/skills/chronicle-report/SKILL.md)
warns that the temporary database snapshot includes raw conversations. The
[session collector](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/session-collect.mjs)
states that prompts/replies are not read, copies the local WAL database into scratch, and treats
failure to remove that copy as fatal. Before finalization, evidence can contain checkpoint titles,
summaries, and next steps; the
[finalizer](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/collectors/finalize.ps1)
strips the temporary `evidence` block from the shared report. Validate imports against the
[published report schema](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/schema/token-lens-report.schema.json).

Only a finalized report may be considered for import. Reject any payload containing an `evidence`
block, prompts or replies, absolute paths, session identifiers, or unredacted repository/file names.
Never upload the raw database, scratch copy, chat-session files, or a pre-finalized report. Token
Lens does not make monetary claims in its Chronicle evidence reports.

GitHub's [session-data documentation](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/session-data)
describes local session storage, Chronicle-compatible session data, and the privacy of local and
synced sessions. Enabling enterprise cloud sync does not grant administrators access to a
developer's private session data. The [Chronicle documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle)
also notes that Chronicle queries may send relevant prompts, context, and responses to an AI model.

## Proposed Budget Lab boundary

1. Keep the GitHub metrics API as the source of exact credits and cost-centre chargeback.
2. If central analysis is added, make it an explicit opt-in import of finalized Token Lens JSON,
   with a preview and user consent before upload. Do not add a background collector.
3. Validate schema and provenance. Reject `evidence`, raw prompts/replies, absolute paths, session
   IDs, and unredacted repository/file names. Retain only aggregates and apply short retention.
4. Token Lens intentionally has no developer identifier. Do not silently join its report to GitHub
   usage. Any join requires a separate consent envelope with an explicit pseudonymous subject key.
   Prefer cost-centre/cohort insights and suppress groups below five participants. Never use
   private session detail for individual chargeback or performance evaluation.
5. Use Token Lens only for coaching and efficiency hypotheses or before/after experiments. Do not
   allocate credits or dollars to models or features from Token Lens or interaction telemetry.

## Staged roadmap

| Stage | Scope |
| --- | --- |
| V0 | Manual local report import with preview and consent; no automatic sharing |
| V1 | Validated schema adapter and cohort aggregation |
| V2 | Optional signed, pseudonymous upload endpoint with deletion and retention controls |

Background collection must remain off by default. Existing issue
[#70](https://github.com/sujithq/gh-cost-compass/issues/70) is the design tracker; update it rather
than opening a duplicate. Its current description incorrectly calls Token Lens public and implies
fleet identity/coverage; correct those claims to reflect the private/internal source and the
per-developer, non-fleet scope.

For a sanitized sample of the GitHub metrics side, see the
[2026-09-28 demo chargeback bundle](../../examples/copilot-chargeback/madebyqent01-2026-09-28/README.md).
