# Copilot Budget Lab: six-minute narration

## 0:00–0:35 — Understand the rules before the bill arrives

Meet Maya, an engineering lead, and Daniel, a FinOps lead. They want the same outcome: productive
AI adoption. Maya worries that a guardrail will interrupt a developer in the middle of useful
work. Daniel worries that usage-based consumption will turn into unpredictable additional spend.
Budget Lab gives them one place to test both concerns before either reaches production.

## 0:35–1:20 — Licenses are only the starting point

With usage-based billing, buying licenses is only part of the decision. The team also needs to
understand how included consumption is pooled, when additional usage becomes paid spending, and
which controls merely alert versus actually stop usage. That is a FinOps problem: engineering and
finance need to agree on guardrails without learning through a surprise invoice or a blocked
developer.

## 1:20–2:05 — Generate the environment and the lesson

Instead of manually inventing every tenant, user, budget, and usage event, we describe the
situation we want to understand. The Default Set Generator creates a synthetic topology with
stable IDs, explicit assumptions, and no live billing history. The Scenario Generator then creates
the lesson: ordered usage events, expected outcomes, and the exact thresholds or blocking reasons
we want to observe. Both artifacts are deterministic and reviewable as JSON.

## 2:05–2:45 — Open the sandbox

Now we open Budget Lab. Nothing connects to GitHub, and all data stays in this browser. The
dashboard shows the selected synthetic tenant, its included AI-credit pool, seat charges, paid
overage, budget alerts, and blocked events. We can switch between a compact teaching dataset and a
larger enterprise dataset without touching a real organization.

## 2:45–4:10 — Decision one: what happens after included credits?

Our first lesson enables an included-usage control for the AI Innovation cost center. Alice uses
all 3,900 credits attributed to that cost center. At the cap, the policy is configured to continue
as paid overage rather than block the developer. Alice then consumes 2,400 additional credits.
Budget Lab predicts and applies the result: the event is accepted, $24 is attributed to paid
overage, and the $30 cost-center budget reaches 80 percent, crossing its 75-percent alert.

This is the shared decision in concrete terms. Maya sees that the developer continues. Daniel sees
the exact funding route, affected budgets, and alert before the policy is deployed.

## 4:10–5:20 — Decision two: where should usage stop?

The second lesson tests a user-level hard stop. Alice consumes 1,000 credits, worth $10 for this
budget, and reaches the limit exactly. That event is accepted. The next event is only one
additional credit, but it would move the budget from $10.00 to $10.01. The simulator rejects the
complete event, consumes no credits, and changes no counters.

Now the interruption is not an abstract fear. Engineering and FinOps can see the exact boundary,
the user affected, the reason shown to an operator, and the difference between an alert and a hard
stop.

## 5:20–6:00 — Agree before deployment

Budget Lab turns a policy conversation into a repeatable workflow: describe the tenant, generate
the lesson, simulate the boundary, inspect every affected control, and agree on the guardrail.
The result is productive AI adoption without using a surprise invoice as the monitoring system or
a blocked developer as the first test case. Understand the rules before the bill arrives.
