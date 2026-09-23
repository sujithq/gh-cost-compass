# FOCUS 1.4 and FinOps hub landing

The export targets released [FOCUS 1.4](https://focus.finops.org/docs/specification/v1-4/), ratified
2026-06-04. Credits are covered by its Virtual Currency Pricing Model appendix:
`ConsumedUnit = Credits` and `ConsumedQuantity = ai_credits_used`, with the advertised conversion
rate of $0.01 per credit. This is not an implementation of the unreleased 1.5 working draft.

## `focus.csv` columns

The live writer emits these columns, in this exact order:

| Column | Meaning in this export |
| --- | --- |
| `BillingAccountId` | Enterprise slug |
| `BillingPeriodStart` / `BillingPeriodEnd` | Extracted window; end is exclusive |
| `ChargePeriodStart` / `ChargePeriodEnd` | One usage day; end is exclusive |
| `BilledCost`, `EffectiveCost`, `ListCost`, `ContractedCost` | Usage-valued USD (`credits × 0.01`) |
| `ChargeCategory` / `ChargeClass` | `Usage` / blank |
| `ResourceId` / `ResourceName` | User ID / login |
| `ServiceName` / `ServiceCategory` | `GitHub Copilot` / `AI and Machine Learning` |
| `ServiceProviderName` | `GitHub` |
| `HostProviderName` | `GitHub` |
| `InvoiceIssuerName` | `GitHub` |
| `ChargeDescription` | `GitHub Copilot AI credits` |
| `PricingQuantity` / `PricingUnit` | AI credits / `Credits` |
| `ConsumedQuantity` / `ConsumedUnit` | AI credits / `Credits` |
| `x_CostCenterName` | Resolved, ambiguous, or unallocated label |
| `x_ModelName` | Blank: model identity is not a credit dimension |
| `x_HarnessName` | `copilot_cli` when daily enrichment measured CLI |
| `x_UserLogin` | User login |
| `x_AttributionRoute` | `user`, `team`, `organization`, `ambiguous`, or `none` |
| `x_PromptTokensSum` | Measured CLI prompt tokens when enriched |
| `x_ChargeDay` | Source usage day |

FOCUS 1.4 removed `ProviderName`; use `ServiceProviderName`. `PublisherName` is not a 1.4
column. `HostProviderName` is new in 1.4. Custom columns must start with `x_`, should be PascalCase
alphanumeric, should be at most 50 characters, and should use an `Id` or `Name` suffix where
appropriate. The forthcoming 1.5 model identity fields in `SkuPriceDetails` are not a dependency.

The code emits inclusive start and exclusive end dates. For a daily grain it writes the next day as
the end. Preserve this rule when extending the export; using the same date for both endpoints is an
off-by-one bug.

## FinOps hub landing

For a dataset not natively supported by the hub, the documented extension point is:

```text
ingestion/<dataset>/<year>/<month>/<scope-path>/
```

Write FOCUS-shaped Parquet there, then write an empty `manifest.json` after all files are complete.
The hub ADF pipeline lands the data in `{dataset}_raw` and normalizes it to
`{dataset}_final_v1_0`. The documented source is the FinOps Toolkit
[data-processing guide](https://learn.microsoft.com/en-us/cloud-computing/finops/toolkit/hubs/data-processing);
it describes custom landing incidentally under a non-Azure-clouds heading, not as a dedicated
bring-your-own-cost-data tutorial. FOCUS alignment and Parquet conversion remain this pipeline's
responsibility.

OneLake and ADLS Gen2 are landing alternatives. The
[Fabric workspace guide](https://learn.microsoft.com/en-us/cloud-computing/finops/fabric/create-fabric-workspace-finops)
is Lakehouse-centric; hubs and Fabric are complementary alternatives, and there is no official
migration/comparison guide. Direct Lake is appropriate for IT-governed lakehouse consumption;
Import is the documented default for self-service. FinOps Toolkit reports are built to FOCUS
standards, but repointing them at custom third-party FOCUS data is not documented and is only a
schema-alignment inference, not a guarantee.
