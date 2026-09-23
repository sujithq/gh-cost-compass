# Automation

The real workflow is
[`.github/workflows/copilot-usage-export.yml`](../../.github/workflows/copilot-usage-export.yml).
It runs daily at `02:17` UTC and
also exposes `workflow_dispatch` inputs for `enterprise` and `since`. The non-`:00` minute avoids
the worst schedule contention. Scheduled workflows run from the default branch and are delayed or
dropped under load; in public repositories GitHub also auto-disables schedules after 60 days without
repository activity.

Scheduled runs resolve `since` to a rolling 27-day trailing window in UTC when no dispatch input is
present. Manual runs may supply `since` to choose a deliberate replay window, or leave it empty to
get the same rolling window as the schedule.

## Credential and permissions

`secrets.COPILOT_METRICS_TOKEN` is passed only through `GITHUB_TOKEN` in the process environment.
This name is a repository secret, not the automatically provided Actions token: `GITHUB_TOKEN`
cannot call these endpoints. Use a least-privileged PAT or GitHub App token with
`manage_billing:copilot` or `read:enterprise`. There is no OIDC federation into GitHub, so this
GitHub credential cannot be removed from the design. The CLI rejects command-line token arguments
and never writes the token to output.

The workflow has `contents: read`. Its Azure OIDC login and AzCopy landing step are commented-out
and explicitly opt-in because this repository has no Azure target, tenant, subscription, storage
account, or dataset configured. If enabled, add `id-token: write`, configure `azure/login`, and
replace every placeholder; do not invent IDs or add an Azure client secret.

Actions artifacts are not the delivery mechanism. Retention and size guarantees are not part of
this data contract; the workflow includes a commented failure-only upload for transient debugging.
The durable destination is the FinOps hub landing path described in [focus-mapping.md](focus-mapping.md).

## Manual run

From the Actions tab, choose **Copilot usage export**, select **Run workflow**, and provide the
enterprise slug and first enrichment day:

```bash
node tools/copilot-usage/cli.mjs --live --enterprise <slug> --since YYYY-MM-DD --out <dir>
```

The extractor writes raw artifacts, snapshots, and `live-manifest.json` before the report. A
non-empty signed link that yields no rows, malformed envelopes, HTTP failures, or a failed invariant
causes a non-successful run. A 200 response with zero links is recorded as a no-data day and does
not fail the run. Concurrency prevents overlapping exports for the same enterprise.

For the broader design tradeoffs, including why Fabric should not pull GitHub directly, see the
[pipeline recommendation](../copilot-usage-pipeline-recommendation.md).
