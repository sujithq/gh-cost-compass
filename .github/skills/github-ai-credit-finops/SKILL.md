# GitHub AI Credit FinOps

Use this skill for GitHub Copilot AI-credit configuration, usage, budget, cost-center,
alert, enforcement, and FinOps questions.

## Required outcome

1. Separate included consumption from billable metered overage.
2. Identify which control is active before and after included-pool exhaustion.
3. Map users, enterprise teams, cost centers, organizations, and the enterprise to the
   correct controls.
4. Distinguish alerts, hard stops, included-usage controls, and paid-usage policy.
5. Ground changeable claims in current official GitHub documentation.
6. State simulator assumptions and missing evidence explicitly.

## Workflow

1. Read `references/sources.md` and verify current official GitHub documentation when
   web access is available.
2. Establish only the customer state needed for the question: licensed seats and users,
   included-pool consumption, billing period, paid-usage policy, ULBs, cost centers,
   included-usage controls, overage budgets, alert thresholds, recipients, and stop
   settings.
3. Read `references/control-model.md` and evaluate controls in their documented order.
4. Explain both all-in utilization and native metered-budget utilization when relevant;
   never present one as the other.
5. Recommend a layered control design and explain its user and billing consequences.

## Vocabulary

- **Total AI usage:** included plus metered AI-credit consumption.
- **Included pool:** license-funded credits shared across the enterprise unless a
  cost-center included-usage control partitions them.
- **Metered overage:** billable usage after the applicable included allowance is depleted.
- **User-level budget (ULB):** a per-user total-consumption cap active during included
  and metered phases.
- **Cost-center included-usage control:** a license-funded aggregate boundary for a cost
  center's included credits.
- **Cost-center budget:** an aggregate metered-overage budget, not an included allocation.
- **Equivalent USD:** AI credits multiplied by $0.01 for comparison; not necessarily an
  invoice charge.

## Guardrails

- Do not describe included consumption as invoice spend.
- Do not promise a native 75% alert for an included pool.
- Do not describe the included-cap checkbox as a total-usage hard stop.
- Do not describe a cost-center ULB as an aggregate team budget.
- Do not rely on user-level alerts as the only FinOps signal.
- Do not claim that an aggregate budget blocks usage unless stop usage is enabled.
- Do not recommend cost-center exclusion without explaining that excluded overage escapes
  the enterprise ceiling.
- Keep scenario suggestions read-only until they pass validation and are explicitly
  imported.

