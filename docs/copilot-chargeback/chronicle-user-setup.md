# Token Lens `/chronicle-report`: local operator guide

This is a **per-developer, manual** walkthrough for Alex (`alexb_mbqent01`) to create
a report from Alex's own Copilot CLI sessions. The login is a demo persona, not a
report identity field or proof of who owns a session. The private upstream sources
are linked in the [integration boundary](token-lens-integration.md).

**Do not use the chargeback PAT for this step.** The token used by
[`tools/copilot-usage`](../../tools/copilot-usage/README.md) calls GitHub's enterprise metrics and billing
APIs. It does not grant access to Alex's private local Chronicle/session data
or authenticate Alex's Copilot CLI. Classic PATs (`ghp_`) are not supported
by Copilot CLI; an eligible fine-grained PAT would need Alex as its personal
owner and **Copilot Requests** permission, but interactive OAuth is preferred.
Token Lens reads Alex's local Copilot CLI session store; it does not collect an
enterprise fleet, use that PAT, or upload reports. Native `/chronicle` is a
GitHub Copilot CLI command for personal history (standup, tips, search, etc.).
The **separately installed, upstream** `/chronicle-report` plugin creates the
structured, finalized JSON and Markdown report; running `/chronicle` does not
install or run this plugin, and native `/chronicle` does not produce its stable
JSON report. Native Chronicle queries can send relevant prompts, context, and responses to
an AI model; do not confuse that behavior with the local Token Lens collector.

> [!CAUTION]
> `COPILOT_HOME` isolates Copilot CLI configuration and sessions, but the pinned
> Chronicle plugin's collection scripts do **not** use it when choosing their
> default database. `preflight.ps1` defaults to `$HOME/.copilot/session-store.db`
> and `collect.mjs` defaults to `os.homedir()/.copilot/session-store.db`. The
> `/chronicle-report` slash workflow is therefore safe only in a dedicated Alex
> OS profile. In a shared Windows profile, do not invoke the slash command:
> use the manual pipeline in section 5 and pass Alex's isolated database path
> explicitly to both preflight and collection.

## 1. Prepare Alex's CLI and isolate the local store

1. Prefer a **separate Windows user profile for Alex**, with a Copilot
   subscription and CLI access allowed by enterprise policy. Install
   [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)
   with PowerShell 6+ on Windows: `winget install GitHub.Copilot`, or with
   Node.js 22+: `npm install -g @github/copilot`. The repository's Node.js 20+
   requirement is separate from the npm route for installing Copilot CLI.
2. For a controlled demo in Alex's account, choose an **empty, dedicated**
   Copilot home and output directory before *every* `copilot` or plugin
   command, including login, installation, and report generation. In each
   PowerShell session used for the demo, set:

   ```powershell
   $env:COPILOT_HOME = Join-Path $HOME '.copilot-alex-demo'
   $env:COPILOT_PLUGIN_DATA = Join-Path $env:COPILOT_HOME 'chronicle-report'
   Remove-Item Env:\COPILOT_GITHUB_TOKEN,Env:\GH_TOKEN,Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue
   ```

   [Copilot CLI stores configuration and session history](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
   under `~/.copilot` by default; `COPILOT_HOME` isolates the CLI's configuration
   and sessions. It does **not** change the pinned plugin scripts' default
   database lookup. Never point this demo at Johan's existing `~/.copilot` or
   another person's store.
   Restrict filesystem access to Alex; do not place this directory in the
   checkout or a synced/shared folder.
3. Authenticate with `copilot login` (or `/login` inside the interactive CLI)
   as `alexb_mbqent01` via OAuth. Check the CLI's displayed active account
   and local session history. [CLI credential precedence](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
   is `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, OAuth, then the
   GitHub CLI fallback. Clear those three token environment variables
   **again in any new terminal** before login or collection, and stop if
   another account/credential is active. Logging in or possessing the
   enterprise billing PAT creates **no historical Alex sessions**. Do not
   copy another developer's session DB to populate the demo.

## 2. Obtain and verify the private plugin bundle

1. Obtain the approved internal
   [`internal-workbench/assets/tokenlens/Tokenlens.zip`](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/internal-workbench/assets/tokenlens/Tokenlens.zip)
   from the private `mcaps-microsoft/ghcp-tokenomics` source at commit
   `b3efd0ad35d9eaf3823372ab605d97edcf914225`, or its authorized
   distributor. The pinned Git blob ID is
   `e5da13ade57ccd11ea9d46b8092e4d720b1b1055` and the ZIP size is
   **32,530 bytes**. Its verified SHA-256 is
   `E89424DDFFBB07E0B1E64D3668CE0BA6AFE35D7F2D0E98F447EBD909A6766834`;
   the blob ID and SHA-256 are different digest formats. Access requires
   the relevant Microsoft EMU permissions. The upstream
   provenance/redistribution question is unresolved: keep the bundle,
   binaries, and collector code **outside this repository**. Do not use a
   public mirror or commit the bundle.
2. Compare the delivered ZIP's digest against a checksum obtained over a
   trusted, independent channel. For example, run
   `Get-FileHash -Algorithm SHA256 -Path <approved-Tokenlens.zip>` in
   PowerShell and compare the full value with the distributor's SHA-256.
   For the pinned Git object, also compare
   `git hash-object <approved-Tokenlens.zip>` against the blob ID above and
   verify the size. A checksum published only beside an untrusted download
   is not independent verification. Stop on any mismatch.
3. Extract the verified archive to a **permanent private directory** outside
   the repository, and inspect it for `plugin.json`, `skills`, `scripts`,
   and `templates`. Use the approved bundle's installation guide to confirm
   the plugin manifest and skill version before installation.

## 3. Install manually, with narrow access

1. With the isolated environment from step 1 in the same shell, install the
   verified plugin from its extracted directory:

   ```powershell
   Set-Location '<extracted-plugin-directory>'
   copilot plugin install (Resolve-Path .).Path
   copilot plugin list
   copilot
   ```

   The pinned bundle was installed into an isolated `COPILOT_HOME`, and
   `copilot plugin list` reported `chronicle-report` version **0.5.1**.
   Confirm that version and that `/chronicle-report` appears in the **new**
   interactive session. This is a manual install, not an auto-update or a
   dependency of Budget Lab. If installation changes `COPILOT_HOME`, stop
   and correct it before opening the session.
2. When the CLI requests `/sandbox` permissions, grant only what the verified
   skill needs: **read-only** access to the plugin files and Alex's compatible
   local CLI session store (including SQLite sidecars where needed), and
   **read/write** access only to `$env:COPILOT_PLUGIN_DATA` (the isolated
   `$env:COPILOT_HOME\chronicle-report` directory in this example). Do not
   grant the whole home directory, the entire repository, arbitrary external
   paths, network access, or another user's session files. Deny unexpected
   permission requests and recheck the bundle instructions. The plugin uses
   `COPILOT_PLUGIN_DATA`, then `PLUGIN_DATA`, otherwise
   `~/.copilot/chronicle-report`; check its actual destination rather than
   relying on the fallback.
3. Leave automatic collection and uploads off. The plugin is explicitly
   user-invoked; installing it does not schedule reports.

## 4. Generate representative local sessions

1. Have Alex run **3-5 actual Copilot CLI sessions** under the verified
   account and isolated home, in a dedicated approved demo repository with
   non-sensitive work. For example, make separate sessions for code review,
   test generation, documentation, and a small bug fix. Use different models
   or surfaces only if normal for the work; do not fabricate old history or
   fake telemetry. Avoid credentials, personal data, and confidential prompts.
2. Note the date window and repository for those sessions. Confirm that local
   CLI sessions actually appear in Alex's session history before reporting.
   IDE chat data and CLI data are different sources: the plugin skill reads the
   compatible **CLI store only**, not all editor activity. An empty or
   unrepresentative report is not evidence of zero enterprise use.

## 5. Preflight, invoke, and finalize

1. Resolve the isolated database explicitly. In the verified, extracted plugin
   directory, run preflight from the same isolated PowerShell environment:

   ```powershell
   $alexDb = Join-Path $env:COPILOT_HOME 'session-store.db'
   pwsh -NoProfile -File .\scripts\preflight.ps1 `
     -DbPath $alexDb `
     -From '2026-09-01' `
     -To '2026-09-30'
   ```

   Use the script's scoped `-Month`, `-From`/`-To`, or `-Repo` parameters
   when narrowing the check. Interpret **ready** as proceed, **degraded** as
   inspect missing/partial coverage before deciding, and **blocked** as stop
   and fix the cause. Do not treat a degraded/blocked result as a complete
   report or expand sandbox grants merely to bypass a warning.
2. Choose the workflow based on OS-profile isolation:

   - **Dedicated Alex OS profile:** start or return to Alex's interactive
     `copilot` session and invoke `/chronicle-report` with the intended
     date/repository scope.
   - **Shared Windows profile:** do **not** invoke `/chronicle-report`.
     Run the collector manually and pass the same explicit database path:

     ```powershell
     node .\scripts\collect.mjs `
       --db $alexDb `
       --from 2026-09-01 `
       --to 2026-09-30 `
       --redact
     ```

     Keep collection output and all subsequent validation, rendering, and
     finalization local. Follow the pinned bundle's approved commands for
     those stages; do not omit `--db` on collection or substitute the
     script's home-directory default.

   The pinned
   skill accepts `month:YYYY-MM`, `from:YYYY-MM-DD` with `to:YYYY-MM-DD`,
   `since:`, `repo:owner/name`, `repo:.`, and `search:`. For example:

   ```text
   /chronicle-report month:2026-09 repo:owner/demo-repo
   ```

   Replace the example month and repository with Alex's **actual** sessions;
   choose an explicit calendar month or date range rather than assuming
   history exists. Request redaction explicitly in the interactive invocation,
   then inspect whether it was actually applied. For the manual collector path,
   the pinned collector supports `node scripts/collect.mjs ... --redact`;
   follow the approved skill for the remaining arguments rather than guessing
   them. Confirm the displayed scope and output destination before proceeding.
3. The collector can copy the local SQLite DB and WAL state to scratch; that
   temporary copy can contain raw
   conversations. Do not share or retain it, and treat a failed scratch
   cleanup as a failed run rather than a completed report.
4. Let the approved finalizer remove the temporary `evidence` block. The
   plugin writes JSON and Markdown under the selected plugin-data directory.
   Confirm successful finalization and inspect the resulting local JSON and
   Markdown before any handoff. Do **not** treat an intermediate evidence file or a failed
   finalization as shareable. Redaction hashes repository/file names in
   supported paths; it does not guarantee that every identity-adjacent field
   (such as a checkpoint title or summary) is anonymous.

### Observed Alex preflight, 2026-09-01 through 2026-09-30

The preflight run against the **explicit isolated Alex database path** returned
`degraded`, with **0 failures and 2 warnings**. The database was readable and
queries succeeded, but it contained only **1 active metadata-only session**,
**0 usage events**, and no measured token fields. The store schema was version
8; Chronicle plugin 0.5.1 currently validates only schema 7, so it warned about
the newer schema even though its queries completed.

Alex's first Copilot request failed because the monthly quota was exhausted.
Consequently, this run produced no meaningful real usage report. Treat it as
an installation and safety-path validation only, not evidence of zero usage
or a usable baseline.

## 6. Review and hand off only an approved report

1. Review the JSON and Markdown locally for intended dates and repository scope, sensible
   aggregates, and the absence of `evidence`, prompts/replies, absolute paths,
   session IDs, and unredacted repository/file names. Check free-text fields
   for sensitive content and verify the report against the
   [upstream schema](https://github.com/mcaps-microsoft/ghcp-tokenomics/blob/b3efd0ad35d9eaf3823372ab605d97edcf914225/token-lens/schema/token-lens-report.schema.json).
   If any check fails, **do not share**; correct the source/scope or redact
   safely under the approved process and validate again. Do not upload raw
   databases, WAL files, scratch copies, editor chat files, or preliminary
   reports.
2. Obtain Alex's explicit consent for the particular finalized file and the
   approved recipient/destination before sharing. Transfer only that reviewed
   file through an approved private channel. The companion internal Workbench
   can load reports by explicit browser file selection/drop; it is not a
   central uploader. Its **Redact names** display control does not sanitize
   the file. Budget Lab has **no Token Lens import endpoint today**; the
   [proposed adapter](token-lens-integration.md#proposed-budget-lab-boundary)
   is not a working upload path. Do not combine multiple developers' files
   without separate consent and coverage/identity caveats.
3. Remove local report and scratch artifacts when no longer needed under the
   applicable internal retention policy; coordinate deletion of any approved
   copy with its recipient. There is **no built-in retention TTL** and
   uninstalling the plugin does not delete generated reports. Never put a
   real report or the plugin bundle in this repository or an issue/PR.

## Troubleshooting and interpretation

| Symptom | Safe response |
| --- | --- |
| `/chronicle` works, `/chronicle-report` is missing | These are different commands. Verify the approved plugin install, its version, and skill visibility; do not assume native Chronicle generated a Token Lens file. |
| Missing/empty sessions | Verify Alex's CLI account, local store ownership, compatible CLI history, date window and repo filter. Do not fill gaps with another user's DB or infer complete coverage. |
| Permission or preflight failure | Check only the specific denied path/operation against the trusted install guide; narrow or correct the sandbox grant rather than granting the whole home directory. |
| Finalizer or scratch cleanup fails | Treat the run as failed. Quarantine/delete sensitive intermediate files using approved local procedures; do not distribute the output. |
| Unexpected names or paths survive redaction | Stop the handoff. Inspect locally, correct scope/redaction and revalidate; UI masking in Workbench does not alter the source file. |

**What this can answer:** for Alex's selected, locally present CLI history,
the report can support hypotheses about session shape, tool-call rounds,
context growth, and observed model mix, subject to the installed plugin's
coverage and redaction behavior. It is useful for opt-in coaching or
before/after experiments, not as a personnel score. For orientation, an
**upstream synthetic schema-v3 sample** generated 64 sessions, 2,484 requests,
246,732,371 input tokens, 1,737,731 output tokens, and 230,573,337
cache-read tokens; it had **no cost** because the sample evidence did not
carry cost. These are not Alex's usage or an expected result for a 3-5
session demo.

**What it cannot answer:** whether every developer was captured; Alex's
enterprise-wide IDE activity; exact billable credits or dollars by model,
feature, repository, or cost centre; a reconciled invoice; or authenticated
identity/complete coverage when reports are combined. For exact
user/day AI credits and cost-centre chargeback, use the
[GitHub metrics pipeline](README.md). Its existing PAT cannot fetch private
Chronicle data. See [GitHub's native Chronicle guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle)
and the [Token Lens boundary](token-lens-integration.md) for the distinct
privacy and billing constraints.
