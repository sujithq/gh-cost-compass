# Outputs

## Live extraction directory

`tools/copilot-usage/live-extract.mjs` writes these raw and audit artifacts:

| File | Meaning |
| --- | --- |
| `users-28-day-spine.ndjson` | Authoritative per-user-per-day credit rows |
| `users-1-day-<day>.ndjson` | Daily enrichment rows, only for days with data |
| `cost-centers.json` | Raw cost-centre snapshot |
| `seats.json` | Raw seat snapshot |
| `live-manifest.json` | Window, endpoint audit, row/link counts, no-data/enriched/error days, and artifact paths |

`cli.mjs` additionally writes `membership-live.json`, the normalized cost-centre membership snapshot.

## Report directory

`writeLiveOutputs` writes:

| File | Meaning |
| --- | --- |
| `chargeback.xlsx` | Nine-sheet analyst workbook |
| `focus.csv` | FOCUS 1.4-shaped daily user rows; exact column order is in [focus-mapping.md](focus-mapping.md) |
| `daily-facts.csv` | Full-precision daily user facts, attribution, enrichment flag, interaction counts, and org candidates |
| `live-report.json` | Totals, by-user, by-cost-centre, and caveat JSON |

Workbook sheets are **Summary** (window, rows, credits, USD, enrichment, coverage), **By cost
centre** (credits, display-rounded USD, users, share), **By user** (route, credits, display-rounded
USD, active days), **Daily facts** (source-day detail and coverage), **Model mix**,
**Language mix**, **Surface harness**, **CLI tokens** (measured sessions, requests, prompts, and
prompt/output tokens), and **Caveats**. Numeric cells are actual numerics so administrators can
pivot them.

Model/language/surface sheets are interaction telemetry, not credit allocations. `focus.csv` and
`daily-facts.csv` retain full precision; workbook rounding is display-only.

The workbook is produced by `xlsx.mjs`, a hand-rolled dependency-free writer using
`node:zlib`'s `deflateRaw` and a manual ZIP central directory. This preserves the repository's
no-dependency Node 20+ architecture. The output was validated with an independent ZIP reader.
