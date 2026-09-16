import { createDefaultScenario } from "./engine.js";

export const BUILT_IN_SCENARIOS = [
  {
    version: 1,
    id: "budget-health-progression",
    title: "Budget health progression",
    summary: "Move Alice's individual budget through healthy, warning, high-risk, and 100% states.",
    tags: ["budget health", "alerts", "user-level budget"],
    sourceUrls: ["https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets"],
    startDate: "2026-09-15",
    setup: [
      { target: "budget", id: "ulb-alice", changes: { amount: 50 } },
    ],
    steps: [
      { id: "progress-40", type: "usage", title: "Reach 40%", description: "Alice consumes 2,000 AI credits from the shared pool.", expected: "The individual ULB reaches $20 of $50 (40%) without an alert.", event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 2000 } },
      { id: "progress-80", type: "usage", title: "Cross the warning threshold", description: "Another 2,000 credits raise total user consumption to $40.", expected: "The ULB reaches 80% and its 75% alert fires.", event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 2000 } },
      { id: "progress-90", type: "usage", title: "Reach the high-risk state", description: "A 500-credit event raises the budget to 90%.", expected: "The 90% alert fires and only $5 of headroom remains.", event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 500 } },
      { id: "before-100", type: "checkpoint", title: "Inspect before 100%", description: "Pause with the budget at 90% before applying the final usage event.", expected: "The inline outcome shows that the next 500-credit step will reach exactly 100%." },
      { id: "progress-100", type: "usage", title: "Reach 100%", description: "The final 500 credits consume the remaining $5 of user budget.", expected: "The event is accepted at the exact limit and the 100% alert fires.", event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 500 } },
    ],
  },
  {
    version: 1,
    id: "pool-to-paid-overage",
    title: "Shared pool to paid overage",
    summary: "Consume included AI credits first, then show how paid usage flows into metered budgets.",
    tags: ["shared pool", "metered usage", "cost center"],
    sourceUrls: ["https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing"],
    startDate: "2026-09-15",
    setup: [
      { target: "budget", id: "ulb-alice", changes: { amount: 200 } },
    ],
    steps: [
      { id: "pool-mostly-used", type: "usage", title: "Consume most included credits", description: "Alice consumes 5,000 of the 5,800 pooled credits.", expected: "No paid overage is created and 800 pooled credits remain.", event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 5000 } },
      { id: "pool-empty", type: "usage", title: "Exhaust the shared pool", description: "The remaining 800 included credits are consumed.", expected: "The pool reaches 100%, while metered cost remains $0.", event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 800 } },
      { id: "paid-overage", type: "usage", title: "Create paid overage", description: "A further 1,000 credits can no longer use the pool.", expected: "$10 of paid overage is attributed to the cost-center and enterprise budgets.", event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 1000 } },
    ],
  },
  {
    version: 1,
    id: "hard-stop-boundary",
    title: "User hard-stop boundary",
    summary: "Reach a user-level budget exactly, then demonstrate atomic rejection of the next event.",
    tags: ["hard stop", "blocked usage", "atomic events"],
    sourceUrls: ["https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets"],
    startDate: "2026-09-15",
    setup: [
      { target: "budget", id: "ulb-alice", changes: { amount: 10 } },
    ],
    steps: [
      { id: "reach-limit", type: "usage", title: "Reach the exact limit", description: "Alice consumes 1,000 AI credits, worth $10 for ULB accounting.", expected: "The event is accepted and the ULB reaches exactly 100%.", event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 1000 } },
      { id: "blocked-after-limit", type: "usage", title: "Attempt the next event", description: "Alice attempts to consume one additional AI credit.", expected: "The complete event is rejected by the user-level hard stop and no counter changes.", event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 1 } },
    ],
  },
];

const COLLECTIONS = {
  budget: "budgets",
  user: "users",
  organization: "organizations",
  repository: "repositories",
  costCenter: "costCenters",
  product: "products",
};

function clone(value) {
  return structuredClone(value);
}

function applyMutation(scenario, mutation) {
  if (mutation.target === "enterprise") {
    Object.assign(scenario.enterprise, mutation.changes);
    return;
  }
  const collection = scenario[COLLECTIONS[mutation.target]];
  const target = collection?.find((item) => item.id === mutation.id);
  if (!target) throw new Error(`Scenario mutation target not found: ${mutation.target} ${mutation.id || ""}`.trim());
  Object.assign(target, mutation.changes);
}

export function validateScenarioDefinition(definition) {
  if (!definition || definition.version !== 1) return "Scenario definition must use version 1.";
  if (!definition.id || !definition.title || !definition.summary) return "Scenario definition requires id, title, and summary.";
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) return "Scenario definition requires at least one step.";
  const ids = new Set();
  for (const step of definition.steps) {
    if (!step.id || ids.has(step.id)) return "Every scenario step requires a unique id.";
    ids.add(step.id);
    if (!step.title || !step.description || !step.expected) return `Step ${step.id} requires title, description, and expected outcome.`;
    if (!["usage", "advance-date", "configuration", "checkpoint"].includes(step.type)) return `Unsupported step type: ${step.type}.`;
    if (step.type === "usage" && (!step.event?.date || !step.event?.userId || !step.event?.productId || !(Number(step.event?.quantity) > 0))) return `Usage step ${step.id} is incomplete.`;
    if (step.type === "advance-date" && !step.date) return `Advance-date step ${step.id} requires a date.`;
    if (step.type === "configuration" && !step.mutation?.target) return `Configuration step ${step.id} requires a mutation.`;
  }
  return null;
}

export function materializeScenario(definition, stepIndex = -1) {
  const error = validateScenarioDefinition(definition);
  if (error) throw new Error(error);
  const scenario = createDefaultScenario();
  scenario.events = [];
  scenario.simulationDate = definition.startDate || scenario.simulationDate;
  for (const mutation of definition.setup || []) applyMutation(scenario, mutation);
  for (let index = 0; index <= Math.min(stepIndex, definition.steps.length - 1); index += 1) {
    const step = definition.steps[index];
    if (step.type === "usage") {
      scenario.events.push({ ...clone(step.event), id: `scenario-${definition.id}-${step.id}` });
      if (step.event.date > scenario.simulationDate) scenario.simulationDate = step.event.date;
    } else if (step.type === "advance-date") {
      scenario.simulationDate = step.date;
    } else if (step.type === "configuration") {
      applyMutation(scenario, step.mutation);
    }
  }
  return scenario;
}
