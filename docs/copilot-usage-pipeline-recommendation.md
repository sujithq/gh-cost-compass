# Repeatable Copilot AI-credit chargeback pipeline

## Recommendation for `madebyqent01`

Use a scheduled GitHub Actions workflow as the extraction boundary, authenticate to Azure with
GitHub OIDC, and land immutable raw/API-normalized files in ADLS Gen2 (or its OneLake-connected
storage). Use Fabric Data Factory or a Fabric notebook after landing to register the flat FOCUS
bridge CSV as a lakehouse table and publish a Power BI semantic model.

This keeps the GitHub credential close to the GitHub API call, makes the exact report window and
enrichment coverage auditable, and avoids asking Fabric to hold a GitHub token merely to retrieve
files. The current CLI already emits the exact credit spine, daily enrichment manifest, workbook,
and `focus.csv`; the scheduled workflow should preserve those artifacts before any transformation.

## Operating shape

1. **Extract (GitHub Actions).** Run `npm run usage-report -- --live --enterprise madebyqent01
   --since <window-start>` on a schedule. Store the raw spine/daily files, `live-manifest.json`,
   normalized membership snapshot, and a run metadata file under a date-stamped ADLS/OneLake
   prefix. Never store signed download URLs or the GitHub token.
2. **Normalize (Fabric).** Load the FOCUS-style CSV and the daily facts into a lakehouse. Keep
   `x_github_ai_credits`, `x_github_cost_center`, `x_github_model`, and `x_github_harness` as
   extension columns. Use `BilledCost`/`EffectiveCost` for the exact usage-valued USD
   (`credits * $0.01`) and do not treat model, language, surface, or token counts as monetary
   allocations.
3. **Serve (Power BI).** Build measures for credits, USD, active users, active days, interaction
   counts, CLI prompt/output tokens, coverage, and ambiguous/unattributed rows. Add a required
   coverage banner from `live-manifest.json`; a report with missing enrichment days is useful for
   exact totals but provisional for harness analysis.
4. **Govern (FinOps).** Retain the raw and normalized partitions, manifest, code revision, and
   capture timestamp. Reconcile the sum of daily facts to the 28-day credit spine before
   publishing. Keep the workbook as an analyst handoff, not the system of record.

## Why not Fabric-only extraction?

Fabric Data Factory can call REST sources and is a reasonable future option when the customer
requires a centrally managed ingestion service. It would need a secure secret/connection for the
GitHub token, paging/retry logic for signed report links, and an explicit way to preserve the
download-link and no-data audit trail. The GitHub Actions route is the smaller, better-proven MVP
because the repository already owns the adapter, tests, and exact endpoint semantics. Revisit a
Fabric-only connector after the enterprise has operationalized secret rotation and wants all
extractors governed in one workspace.

The manual MVP (`gh auth token` plus a local CLI run) remains useful for validation and incident
replay, but it is not a reliable monthly control: it has no scheduler, no durable identity, and
no guaranteed landing location.

## Identity, scheduling, and reliability

GitHub recommends the `schedule` event for cron-based workflows, but scheduled workflows can be
delayed during high-load periods and run from the default branch. Add a narrow retry/backoff for
transient HTTP failures, write a manifest for every attempted endpoint, and alert when the spine
or a daily enrichment day is missing. Use a workflow concurrency group so overlapping runs cannot
publish the same window twice.

For Azure, configure a federated credential on an Entra application or user-assigned managed
identity and grant the workflow only write access to the landing container. Do not put a client
secret in repository or environment secrets when OIDC is available. The GitHub token remains a
read-only repository/enterprise secret or an approved runtime credential and is never written to
logs or artifacts.

## FOCUS mapping boundary

The emitted CSV uses standard FOCUS columns only where the meaning is defensible:
`BillingAccountId`, `BillingPeriodStart`, `BillingPeriodEnd`, `BilledCost`, `EffectiveCost`,
`ChargeCategory`, `ResourceId`, `ResourceName`, `ServiceName`, `PublisherName`, and
`ChargeDescription`. GitHub-specific dimensions use the `x_github_*` prefix. FOCUS does not
provide a defensible native column for GitHub AI-credit quantities, cost-centre assignment route,
model interaction counts, harness, or CLI token telemetry, so those remain extensions rather than
invented mappings.

## Proven versus assumed

**Proven in this repository and live demo capture:** the 28-day report is a per-user-per-day
credit spine; daily rows can enrich only the days for which `download_links` is non-empty; live
rows contain real CLI token metrics; credits are conserved into direct, unique-org, ambiguous, or
unallocated buckets; duplicate seats require deterministic deduplication; the tenant currently
has no populated IDE/MCP/slash-command/plugin dimensions and reports no chat/agent activity.

The enterprise org-scoped report family is a real route but returned HTTP 403 for the available
token, so it is available but unverified here. The user-teams family is 1-day only (there is no
28-day endpoint), and this tenant returned empty links for the 1-day team report; team attribution
is therefore coded defensively but unexercised against live data. HTTP 200 with empty links also
does not distinguish an out-of-range date from an ordinary no-data day.

**Still an assumption or operational decision:** the final ADLS versus OneLake landing account,
the exact GitHub Actions cron, the Azure federated-credential subject condition, retention period,
Power BI workspace/security model, and whether Fabric should later own extraction. Membership is
point-in-time, not effective-dated. Model/language/surface rows are interaction telemetry and
cannot be converted into exact credit or USD splits from this API.

## References

- GitHub Actions scheduled workflows: <https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule>
- GitHub Actions OIDC with Azure: <https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-azure>
- FinOps FOCUS specification: <https://focus.finops.org/focus-specification/>
- Microsoft Fabric REST connector: <https://learn.microsoft.com/en-us/fabric/data-factory/connector-rest>
- Microsoft Fabric lakehouse overview: <https://learn.microsoft.com/en-us/fabric/data-engineering/lakehouse-overview>
