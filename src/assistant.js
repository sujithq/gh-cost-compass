import { money, percent, replayScenario } from "./engine.js";
import { materializeScenario, validateScenarioDefinition } from "./scenario-runner.js";

const GITHUB_DOCS = [
  { title: "Copilot budgets and alerts", url: "https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets" },
  { title: "Copilot seats and billing cycles", url: "https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/seats-and-billing-cycles" },
  { title: "Usage-based billing", url: "https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing" },
  { title: "Budgets and alerts", url: "https://docs.github.com/en/billing/concepts/budgets-and-alerts" },
];

function asSafeList(items, max = 5) {
  return items.slice(0, max).map((item) => ({
    id: item.stateId,
    name: item.displayName,
    scopeType: item.scopeType,
    budgetKind: item.budgetKind,
    spent: Number(item.spent || 0),
    amount: Number(item.amount || 0),
    percent: Number(item.percent || 0),
    remaining: Number((item.amount || 0) - (item.spent || 0)),
    enforcement: item.enforcement,
    thresholds: item.thresholds || [],
    productId: item.productId,
    scopeId: item.scopeId,
    userBudgetType: item.userBudgetType,
    effectiveDate: item.effectiveDate,
    expiresAt: item.expiresAt || null,
  }));
}

function describeBudgetKind(risk) {
  if (risk.budgetKind === "user") return "user-level bundled AI credits budget";
  return risk.productId === "ai-credits" ? "SKU-level budget for AI credits" : "metered spending budget";
}

function describeStopUsage(risk) {
  if (risk.budgetKind === "user") return "Stop usage is always enabled for user-level budgets";
  return risk.enforcement === "hard" ? "Stop usage when budget limit is reached is enabled" : "Stop usage is not enabled, so this budget alerts but does not block by itself";
}

function describeRiskSettings(risk) {
  if (!risk) return "No active budget controls are currently creating pressure.";
  const settings = [
    `type: ${describeBudgetKind(risk)}`,
    `scope: ${risk.scopeType}${risk.userBudgetType ? ` (${risk.userBudgetType})` : ""}`,
    `amount: ${money(risk.amount, "USD")}`,
    `basis: ${risk.budgetKind === "user" ? "total AI-credit consumption, including included credits and paid usage" : "paid metered overage after included credits"}`,
    describeStopUsage(risk),
    `threshold alerts: ${risk.thresholds.length ? `${risk.thresholds.join("%, ")}%` : "not configured"}`,
    `effective from: ${risk.effectiveDate || "start of scenario"}`,
    `current usage: ${money(risk.spent, "USD")} of ${money(risk.amount, "USD")} (${percent(risk.percent)})`,
  ];
  if (risk.expiresAt) settings.push(`expires: ${risk.expiresAt}`);
  return settings.join("; ");
}

function describeControlEvaluation(evaluation) {
  const settings = (evaluation.settings || evaluation.configuration || []).map((item) => `${item.label}: ${item.value}`).join("; ");
  return `${evaluation.control} (${evaluation.outcome}) — ${settings}. ${evaluation.result}`;
}

export function buildAssistantContext(scenario, replay = replayScenario(scenario), options = {}) {
  const latestResult = options.latestResult || replay.results.at(-1) || null;
  const primaryRisk = [...replay.budgetStates].sort((left, right) => right.percent - left.percent).slice(0, 5);
  const poolRemaining = Number(replay.pool.remaining || 0);
  const enterpriseName = scenario?.enterprise?.name || "Enterprise";
  const summary = {
    enterprise: enterpriseName,
    date: scenario?.simulationDate || "",
    includedPool: {
      spent: Number(replay.pool.consumed || 0),
      total: Number(replay.pool.total || 0),
      remaining: poolRemaining,
      percent: Number(replay.pool.percent || 0),
    },
    paidUsageEnabled: Boolean(scenario?.enterprise?.paidAiUsage),
    alerts: replay.alerts.slice(0, 5).map((alert) => ({
      id: alert.id,
      message: alert.message,
      date: alert.date,
      threshold: alert.threshold,
      reliability: alert.reliability,
    })),
    risks: asSafeList(primaryRisk),
    latestResult: latestResult ? {
      status: latestResult.status,
      reason: latestResult.reason,
      userName: latestResult.userName,
      productName: latestResult.productName,
      quantity: Number(latestResult.quantity || 0),
      cost: Number(latestResult.cost || 0),
      fundingRoute: latestResult.fundingRoute,
      affectedBudgets: latestResult.affectedBudgets?.slice(0, 5).map((impact) => ({
        budgetId: impact.budgetId,
        budgetName: impact.budgetName || impact.budgetId,
        percent: Number(impact.percent || 0),
        before: Number(impact.before || 0),
        after: Number(impact.after || 0),
      })) || [],
      controlEvaluations: latestResult.controlEvaluations?.slice(0, 6).map((evaluation) => ({
        control: evaluation.control,
        outcome: evaluation.outcome,
        settings: evaluation.configuration || [],
        result: evaluation.result,
      })) || [],
    } : null,
    selectedScope: options.selectedScope || { type: "enterprise", id: "" },
    docs: GITHUB_DOCS,
  };

  summary.riskOverview = summary.risks.length
    ? summary.risks.map((risk) => `${risk.name} at ${percent(risk.percent)} (${money(risk.spent, "USD")} of ${money(risk.amount, "USD")})`).join("; ")
    : "No active budget states are near the current threshold.";

  return summary;
}

function buildDraftScenario(definitionName, context) {
  const slug = String(definitionName || "budget-health-draft")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "budget-health-draft";

  return {
    version: 1,
    id: slug,
    title: "Draft budget-health scenario",
    summary: `Draft proposal generated from the current ${context.enterprise} state and the current ${context.date} budget snapshot.`,
    sourceUrls: [
      "https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets",
      "https://docs.github.com/en/billing/concepts/budgets-and-alerts",
    ],
    tags: ["assistant", "draft", "budget-health"],
    steps: [{
      id: "budget-health-checkpoint",
      type: "checkpoint",
      title: "Budget health checkpoint",
      description: "Capture the active AI-credit pool and top budget risks without mutating the scenario.",
      expected: "The checkpoint explains the current state and helps plan the next simulation step.",
    }],
  };
}

export function validateAssistantDraft(definition) {
  const error = validateScenarioDefinition(definition);
  return error ? { ok: false, error } : { ok: true, error: null };
}

export function createAssistantProvider(options = {}) {
  const docs = options.docs || GITHUB_DOCS;

  return {
    answer(question, context = {}) {
      const normalized = String(question || "").toLowerCase();
      const latest = context.latestResult;

      if (/draft|proposal|scenario/i.test(normalized)) {
        const draft = buildDraftScenario(question || "budget-health", context);
        const validation = validateAssistantDraft(draft);
        if (!validation.ok) {
          return {
            kind: "draft",
            text: `I can draft a proposal, but the generated scenario failed validation: ${validation.error}.`,
            sources: docs,
            draft: null,
          };
        }

        return {
          kind: "draft",
          text: `Here is a safe draft scenario proposal based on the current state: ${draft.summary}. It stays read-only until you validate or import it explicitly.`,
          sources: docs,
          draft,
        };
      }

      if (latest && /blocked|why.*(block|reject|accept)|why.*this|why.*event/i.test(normalized)) {
        const outcome = latest.status === "blocked" ? "blocked" : "accepted";
        const controlDetails = latest.controlEvaluations?.length
          ? ` Settings evaluated: ${latest.controlEvaluations.map(describeControlEvaluation).join(" ")}`
          : "";
        const guidance = latest.status === "blocked"
          ? `This event was ${outcome} because the current governing control stopped it before consumption. The assistant saw: ${latest.reason}.`
          : `This event was accepted because the active controls allowed it. The assistant saw: ${latest.reason}.`;
        return {
          kind: "explanation",
          text: `${guidance}${controlDetails} Included pool state: ${Number(context.includedPool?.remaining ?? 0).toLocaleString()} included credits remain out of ${Number(context.includedPool?.total ?? 0).toLocaleString()}.`,
          sources: docs,
        };
      }

      if (/headroom|included.*(left|remaining|pool)|remaining.*credits|included.*credits/i.test(normalized)) {
        return {
          kind: "summary",
          text: `There are ${Number(context.includedPool?.remaining ?? 0).toLocaleString()} included AI credits remaining out of ${Number(context.includedPool?.total ?? 0).toLocaleString()} total. The pool is currently ${percent(context.includedPool?.percent ?? 0)} consumed, so the shared included pool is ${context.includedPool?.percent >= 90 ? "near exhaustion" : "still healthy"}.`,
          sources: docs,
        };
      }

      if (/risk|alert|which.*budget|budget.*at.*risk|top.*risk|govern|pressure|closest/i.test(normalized)) {
        const topRisk = context.risks[0];
        const list = context.risks.length
          ? context.risks.map((risk) => `${risk.name} (${percent(risk.percent)})`).join(", ")
          : "No active budget is at or above the current alert threshold.";
        if (/why|explain|setting|made.*so|pressure point|closest pressure/i.test(normalized)) {
          return {
            kind: "risk-explanation",
            text: topRisk
              ? `${topRisk.name} is the closest pressure point because it has the highest current usage percentage among active budget controls: ${percent(topRisk.percent)}. The settings that make that true are: ${describeRiskSettings(topRisk)}.`
              : "No active budget control is currently the closest pressure point because no budget state has accumulated usage in this replay snapshot.",
            sources: docs,
          };
        }
        return {
          kind: "risk-summary",
          text: `The main budget risks in this scenario are ${list}. The highest-current pressure is ${topRisk ? `${topRisk.name} at ${percent(topRisk.percent)}` : "not currently tracked"}.`,
          sources: docs,
        };
      }

      const pool = context.includedPool || { remaining: 0, total: 0, percent: 0 };
      return {
        kind: "summary",
        text: `This tenant is ${context.enterprise || "the active enterprise"} on ${context.date || "the current simulation date"}. The shared included AI-credit pool has ${Number(pool.remaining).toLocaleString()} credits left out of ${Number(pool.total).toLocaleString()} (${percent(pool.percent)} consumed). Top budget pressure is ${context.risks[0] ? `${context.risks[0].name} at ${percent(context.risks[0].percent)}` : "currently stable"}.`,
        sources: docs,
      };
    },
  };
}

export { GITHUB_DOCS };
