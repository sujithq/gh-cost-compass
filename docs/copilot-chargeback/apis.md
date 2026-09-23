# APIs and verified behaviour

The live client sends `Accept: application/vnd.github+json` and
`X-GitHub-Api-Version: 2026-03-10` to `https://api.github.com`. Report endpoints return an
envelope containing signed NDJSON `download_links`; the extractor follows each link and records
the endpoint/status in `live-manifest.json`. A 200 response with an empty link array means no
data, not failure.

| Endpoint | Use and verified behaviour |
| --- | --- |
| `GET /enterprises/{ent}/copilot/metrics/reports/users-28-day/latest` | Per-user-per-day rows, not a pre-aggregated 28-day total. Byte-identical to the 1-day report for a matching day in the verified tenant. Authoritative credit spine; lacks CLI/harness fields. |
| `GET /enterprises/{ent}/copilot/metrics/reports/users-1-day?day=YYYY-MM-DD` | Daily enrichment with harness and CLI fields. Only days with rows are written as `users-1-day-<day>.ndjson`. |
| `GET /enterprises/{ent}/copilot/metrics/reports/enterprise-1-day` and `enterprise-28-day/latest` | Respond 200, but the enterprise rollup has no `ai_credits_used`; not the credit source. |
| `GET /enterprises/{ent}/copilot/metrics/reports/user-teams-1-day` | Responded 200 with zero links in the verified tenant. Teams with fewer than five seated users are excluded; team attribution is defensive code, not live-proven here. |
| `GET /enterprises/{ent}/copilot/metrics/reports/user-teams-28-day` | Does not exist; generic 404. There is no 28-day team fallback. |
| `GET /enterprises/{ent}/settings/billing/cost-centers` and `/{id}` | Membership is in `resources: [{type: "User"|"Org"|"Team", name}]`. The `users`, `teams`, and `organizations` fields are null. Team resources are prefixed `ent:`. Also exposes `ai_credit_pool_enabled` and `ai_credit_pool_state`. |
| `GET /enterprises/{ent}/copilot/billing/seats` | May contain duplicate users across tiers. The verified response reported five total seats but six records; deduplication is required and Enterprise wins over Business. |
| `GET /orgs/{org}/members` | Paginated; the client follows `Link: rel="next"` and requests `per_page=100`. |
| `GET /enterprises/{ent}/organizations` | Returned 404 for the verified token; the extractor instead discovers organisations from cost-centre resources. |
| `GET /orgs/{org}/copilot/metrics/reports/users-1-day` | Route exists but returned 403 requiring org-admin or relevant org role. A bogus route returned 404, so this is available but unverified, not missing. |

Out-of-range dates are indistinguishable from ordinary no-data days: probes returned 200 plus empty
links. The extractor therefore treats only malformed envelopes, failed requests, or a non-empty link
that parses to zero rows as extraction failures. The verified tenant's latest populated day was
2026-09-18; 2026-09-19 through 2026-09-21 were empty.

## Live row shape

Rows use `day`, numeric `user_id`, an object-shaped `ai_adoption_phase`, and fractional
`ai_credits_used`. There is no `organization_id` on the live usage row, so org attribution requires
the paginated org membership snapshots. `totals_by_model_feature`,
`totals_by_language_model`, `totals_by_language_feature`, and `totals_by_feature` contain
interaction counts, not credits or tokens. `totals_by_cli` contains measured sessions, requests,
prompts, prompt/output token sums, average tokens per request, and CLI version.

In the verified tenant, IDE/MCP/slash-command/plugin arrays were empty, `used_chat` and `used_agent`
were false on every row, and `totals_by_feature` contained only `copilot_cli`. An IDE or
chat-vs-completion-vs-agent breakdown cannot therefore be produced from that capture.

Official references: [Copilot metrics API](https://docs.github.com/en/rest/copilot/copilot-metrics),
[cost centers](https://docs.github.com/en/billing/concepts/cost-centers), and
[enterprise authentication](https://docs.github.com/en/enterprise-cloud@latest/rest/using-the-rest-api/getting-started-with-the-rest-api).
