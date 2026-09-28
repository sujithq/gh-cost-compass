# Copilot usage analysis — sanitized demo

This synthetic/demo-enterprise presentation uses alias labels; the measurements are preserved from
the 2026-09-28 sample capture. The requested UTC window was **2026-09-02 through 2026-09-28**. The
latest available credit spine ended on **2026-09-27**.

## Exact credits and usage-valued USD

One AI credit is valued at $0.01 in this report. USD is usage value, **not invoice spend or a
statement of metered overage**.

| Measure | Value |
| --- | ---: |
| Exact AI credits | 80,396.839995 |
| Usage-valued USD | $803.968400 |
| Active user-day rows | 16 |
| Users with observed credits | 4 |

| User alias | Credits | Usage-valued USD | Active days |
| --- | ---: | ---: | ---: |
| user-01 | 78,293.694026 | $782.936940 | 9 |
| user-02 | 1,842.239734 | $18.422397 | 5 |
| user-03 | 162.099950 | $1.621000 | 1 |
| user-04 | 98.806285 | $0.988063 | 1 |

| Cost-centre alias | Credits | Usage-valued USD | Users | Share |
| --- | ---: | ---: | ---: | ---: |
| CC-Engineering | 80,135.933760 | $801.359338 | 2 | 99.675% |
| CC-Project-7 | 162.099950 | $1.621000 | 1 | 0.202% |
| Ambiguous attribution | 98.806285 | $0.988063 | 1 | 0.123% |

One user-day remains in an explicit ambiguous bucket because the usage record has no organization
identifier and the current membership snapshot matched several organizations. The report does not
guess an attribution.

## Daily trend

| Day | Credits | Usage-valued USD | Active users |
| --- | ---: | ---: | ---: |
| 2026-09-04 | 616.759252 | $6.167593 | 1 |
| 2026-09-05 | 542.783100 | $5.427831 | 1 |
| 2026-09-07 | 727.143296 | $7.271433 | 2 |
| 2026-09-08 | 8,072.856704 | $80.728567 | 2 |
| 2026-09-09 | 14,171.935720 | $141.719357 | 1 |
| 2026-09-10 | 27,455.669000 | $274.556690 | 1 |
| 2026-09-14 | 12,387.119300 | $123.871193 | 1 |
| 2026-09-15 | 3,948.467000 | $39.484670 | 1 |
| 2026-09-16 | 3,386.518756 | $33.865188 | 2 |
| 2026-09-17 | 649.096509 | $6.490965 | 1 |
| 2026-09-18 | 8,438.491357 | $84.384914 | 3 |

The three largest days—September 9, 10, and 14—represent 67.19% of observed credits. September 10
has substantial credits but no dimensional interactions, illustrating why interaction counts
cannot be used as a proxy for credit consumption.

## Model and surface interaction telemetry

The following are interaction counts, not credits or dollars.

| Model | Surface | Interactions |
| --- | --- | ---: |
| gpt-6-astra | copilot_cli | 37 |
| gpt-5.6-luna | chat_panel_agent_mode | 12 |
| claude-fable-5-1 | chat_panel_custom_mode | 10 |
| gpt-5.3-codex | chat_panel_agent_mode | 7 |
| claude-fable-5-1 | chat_panel_agent_mode | 6 |
| claude-opus-5 | copilot_cli | 4 |
| claude-sonnet-5 | chat_panel_agent_mode | 3 |
| claude-4.5-haiku | copilot_cli | 2 |
| mai-code-1.1-flash | copilot_cli | 1 |
| gpt-5.6-luna | copilot_cli | 1 |
| gpt-5.5 | chat_panel_agent_mode | 1 |

Activity totals were 84 user-initiated interactions, 127 code-generation activities, and 84
acceptance activities. No model receives an AI-credit or USD allocation. Model and surface counts
can support usage-pattern hypotheses, but not spend attribution.

## Seats and coverage

The captured seat response reported five seats across six records; the same user appeared in two
tiers and was deduplicated to one seat, with Enterprise taking precedence. One seat had no observed
credits in this window. The report does not include individual authentication timestamps,
cancellation status, session-token totals, or tool/skill/command details.

The 16 active credit rows all matched daily enrichment, across 11 enriched days. However, 15 of 26
daily enrichment calls returned incomplete response bodies. Those dates cannot safely be
classified as no-data, so interaction trends are provisional. The report also lacks the final
2026-09-28 day.

The membership snapshot is a current point-in-time view captured on 2026-09-28, with no effective
date. Historical transfers cannot be reconstructed. No invoice, paid-usage policy, budget, or
independently reconciled entity total was supplied.
