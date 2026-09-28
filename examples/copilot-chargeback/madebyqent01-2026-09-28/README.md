# Copilot chargeback demo bundle

This is a synthetic/demo-enterprise example of a Copilot usage-metrics chargeback report, prepared
from the 2026-09-28 sample capture. Account, user, organization, team, cost-centre, and numeric
GitHub user identifiers have been replaced with synthetic aliases. The measured sample values are
preserved for illustration; they are not an invoice, a bill, or a claim about metered overage.

## Interpret the data carefully

- `ai_credits_used` is the exact credit measure in this sample. The USD figure is a usage value at
  **$0.01 per credit**, not invoice spend.
- GitHub does not publish exact credits split by model, feature, language, or surface. The model
  tables show interaction counts only; they must not be used to allocate credits or dollars.
- The requested window was 2026-09-02 through 2026-09-28. The latest available 28-day spine ended
  on 2026-09-27, so 2026-09-28 is missing. It contains 16 active user-day rows for four aliased
  users, all matched to daily enrichment.
- Daily enrichment succeeded for 11 days. Fifteen of 26 daily calls returned incomplete response
  bodies and could not safely be classified as no-data. Interaction trends are therefore
  provisional even though every active credit row matched.
- The membership snapshot was captured on 2026-09-28. It is point-in-time and has no effective
  date, so historical membership changes cannot be reconstructed. Ambiguous attribution remains
  explicit rather than being guessed.
- No invoice or independently reconciled billing total was supplied. Do not interpret
  usage-equivalent USD as invoice spend.

## Files

| File | Contents |
| --- | --- |
| [`analysis.md`](analysis.md) / [`analysis.json`](analysis.json) | Sanitized findings and aggregate interaction analysis |
| [`chargeback.xlsx`](chargeback.xlsx) | Sanitized workbook rendition with synthetic entity and user aliases |
| [`daily-facts.csv`](daily-facts.csv) | Daily user-level credit facts and enrichment indicators |
| [`focus.csv`](focus.csv) | FOCUS-shaped usage-valued daily rows |
| [`live-report.json`](live-report.json) | Totals and user/cost-centre summaries |
| [`membership-live.json`](membership-live.json) | Sanitized point-in-time membership snapshot for attribution examples |

Raw API extracts, signed download URLs, local-path-bearing manifests, source scripts, login names,
and original GitHub IDs are intentionally excluded. The source workbook contained live identifiers,
so it was not safe to preserve byte-for-byte; the included workbook keeps its useful report sheets
and measurements with aliases substituted. Prompt/output token totals are omitted as unnecessary
session-derived detail; the workbook's CLI-token sheet contains an omission notice, and the optional
`x_PromptTokensSum` column in `focus.csv` is blank.

For the proposed optional integration with local Token Lens reports, see the
[Token Lens integration design](../../../docs/copilot-chargeback/token-lens-integration.md).
