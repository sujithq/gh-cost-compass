# Repeatable Copilot AI-credit chargeback pipeline

## Recommendation for `madebyqent01`

Use the manual MVP to validate the report, then graduate to a scheduled GitHub Actions workflow
as the extraction boundary. Authenticate Actions to Azure with GitHub OIDC and land immutable
raw/API-normalized files in the FinOps hub ingestion path in ADLS Gen2 or OneLake. Keep a
separate enterprise-authorized GitHub PAT or GitHub App credential for the metrics API: OIDC
federates Actions to Azure, not Azure to GitHub, and `GITHUB_TOKEN` cannot read enterprise
Copilot metrics. Use a Fabric notebook or lakehouse pipeline after landing to register the FOCUS
dataset and publish a Power BI semantic model.

This keeps the GitHub credential close to the GitHub API call, makes the exact report window and
enrichment coverage auditable, and avoids asking Fabric to hold a GitHub token merely to retrieve
files. The current CLI already emits the exact credit spine, daily enrichment manifest, workbook,
and `focus.csv`; the scheduled workflow should preserve those artifacts before any transformation.

## Operating shape

1. **Extract (GitHub Actions).** Run `npm run usage-report -- --live --enterprise madebyqent01
   --since <window-start>` on a schedule. Store the raw spine/daily files, `live-manifest.json`,
   normalized membership snapshot, and a run metadata file under a date-stamped ADLS/OneLake
   prefix. Never store signed download URLs or the GitHub token.
2. **Normalize (FinOps/Fabric).** Write FOCUS-shaped Parquet to
   `ingestion/Costs/yyyy/mm/{scope-path}/` and create the empty `manifest.json` trigger after
   all files are ready. OneLake is ADLS-compatible for this landing pattern. Use FOCUS 1.4's
   virtual-currency model: `ConsumedUnit = Credits`, `ConsumedQuantity = ai_credits_used`,
   `PricingUnit = Credit`, `PricingQuantity = ai_credits_used`, and the conditional
   `PricingCurrency*` columns for the $0.01 conversion alongside USD `BilledCost` and
   `EffectiveCost`. Keep GitHub dimensions in conformant `x_` extensions such as
   `x_CostCenterName`, `x_ModelName`, `x_UserLogin`, `x_AttributionRoute`, and
   `x_PromptTokensSum`. Model, language, surface, and token counts remain telemetry, not
   monetary allocations.
3. **Serve (Power BI).** Build measures for credits, USD, active users, active days, interaction
   counts, CLI prompt/output tokens, coverage, and ambiguous/unattributed rows. Add a required
   coverage banner from `live-manifest.json`; a report with missing enrichment days is useful for
   exact totals but provisional for harness analysis.
4. **Govern (FinOps).** Retain the raw and normalized partitions, manifest, code revision, and
   capture timestamp. Reconcile the sum of daily facts to the 28-day credit spine before
   publishing. Keep the workbook as an analyst handoff, not the system of record.

## Why not Fabric-only extraction?

Fabric Data Factory can call REST sources, but it is the weaker primary path here: the API returns
signed NDJSON download links and Fabric's redirect-following/pre-signed-URL behavior is
undocumented; its REST source is documented for JSON rather than this NDJSON shape; and the GitHub
PAT would still live in a Fabric connection. The GitHub Actions route has no undocumented behavior
in the critical path because the repository owns the signed-link handling and audit manifest.
Revisit Fabric-only extraction only after those behaviors and secret rotation are proven in the
customer workspace.

The manual MVP (`gh auth token` plus a local CLI run) remains useful for validation and incident
replay, but it is not a reliable monthly control: it has no scheduler, no durable identity, and
no guaranteed landing location.

## Identity, scheduling, and reliability

GitHub recommends the `schedule` event for cron-based workflows, but scheduled workflows can be
delayed or dropped under load and run from the default branch. Schedule off the top of the hour,
add retry/backoff for transient HTTP failures, write a manifest for every attempted endpoint, and
alert when the spine or a daily enrichment day is missing. Use a workflow concurrency group so
overlapping runs cannot publish the same window twice. In a public repository, scheduled workflows
also auto-disable after 60 days without repository activity; use a private repository or an
explicit keep-alive control.

For Azure, configure a federated credential on an Entra application or user-assigned managed
identity and grant the workflow only write access to the landing container. Do not put an Azure client secret in repository or environment secrets when OIDC is available.
The GitHub metrics credential is the exception: use a least-privileged enterprise-authorized
classic PAT (`manage_billing:copilot` or `read:enterprise`) or a GitHub App with View Enterprise
Copilot Metrics permission, store it as a protected secret, and never write it to logs or
artifacts. Do not route raw data through Actions artifacts; push directly to Azure.

## FOCUS mapping boundary

The target schema is FOCUS 1.4, not the unreleased 1.5 working draft. Use
`BillingAccountId`, billing/charge periods, `BilledCost`, `EffectiveCost`, `ListCost`,
`ContractedCost`, `ChargeCategory`, `ChargeClass`, `ServiceName`, `ServiceCategory`,
`ServiceProviderName`, `HostProviderName`, `InvoiceIssuerName`, `PricingQuantity`,
`PricingUnit`, `ConsumedQuantity`, and `ConsumedUnit` where applicable. Do not emit the removed
`ProviderName` or the non-existent `PublisherName`. GitHub-specific dimensions use conformant
`x_` extensions. FOCUS 1.4 has no dedicated AI-model/token identity columns; the forthcoming 1.5
working draft must not be a dependency.

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

**Still an assumption or operational decision:** the final OneLake workspace/scope path, the
exact off-:00 Actions cron, federated-credential subject condition, retention period, and Power BI
workspace/security model. FinOps documents this custom-data ingestion mechanism incidentally rather
than as a dedicated bring-your-own-cost-data tutorial; FOCUS alignment and Parquet conversion are
our responsibility. There is no official Fabric-vs-hubs migration/comparison guide, no documented
guarantee that prebuilt FinOps Power BI reports can be repointed at custom third-party data, and
Actions artifact retention/size limits were not used as a design dependency. Membership is
point-in-time, not effective-dated. Model/language/surface rows are interaction telemetry and
cannot be converted into exact credit or USD splits from this API.

## References

- GitHub Actions scheduled workflows: <https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule>
- GitHub Actions OIDC with Azure: <https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-azure>
- FinOps FOCUS specification: <https://focus.finops.org/focus-specification/>
- FOCUS 1.4 virtual currency pricing: <https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec/blob/v1.4/specification/appendix/saas_examples/virtual_currency_pricing_model.md>
- FinOps hubs custom-data ingestion: <https://learn.microsoft.com/en-us/cloud-computing/finops/toolkit/hubs/data-processing>
- OneLake API parity: <https://learn.microsoft.com/fabric/onelake/onelake-api-parity>
- OneLake AzCopy: <https://learn.microsoft.com/fabric/onelake/onelake-azcopy>
- Microsoft Fabric REST connector: <https://learn.microsoft.com/en-us/fabric/data-factory/connector-rest>
- Fabric Direct Lake: <https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview>
