import { DEFAULT_SCENARIO_SET_ID, createDefaultScenario, defaultScenarioSetOptions } from "./engine.js";

const COLLECTIONS = {
  budget: "budgets",
  user: "users",
  organization: "organizations",
  repository: "repositories",
  costCenter: "costCenters",
  enterpriseTeam: "enterpriseTeams",
  product: "products",
};

function clone(value) {
  return structuredClone(value);
}

const DEFAULT_SCENARIO_SET_IDS = new Set(defaultScenarioSetOptions.map((item) => item.id));

export function resolveScenarioDefaultSetId(definition, selectedDefaultSetId = DEFAULT_SCENARIO_SET_ID) {
  const authoredDefaultSetId = definition.defaultSetId;
  if (authoredDefaultSetId) return authoredDefaultSetId;
  return selectedDefaultSetId || DEFAULT_SCENARIO_SET_ID;
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
  if (definition.defaultSetId && !DEFAULT_SCENARIO_SET_IDS.has(definition.defaultSetId)) return `Scenario default set not found: ${definition.defaultSetId}.`;
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

export function materializeScenario(definition, stepIndex = -1, { defaultSetId } = {}) {
  const error = validateScenarioDefinition(definition);
  if (error) throw new Error(error);
  const resolvedDefaultSetId = resolveScenarioDefaultSetId(definition, defaultSetId);
  const scenario = createDefaultScenario(resolvedDefaultSetId);
  scenario.events = [];
  scenario.simulationDate = definition.startDate || scenario.simulationDate;
  for (const mutation of definition.setup || []) applyMutation(scenario, mutation);
  for (let index = 0; index <= Math.min(stepIndex, definition.steps.length - 1); index += 1) {
    const step = definition.steps[index];
    if (step.type === "usage") {
      scenario.events.push({ ...clone(step.event), id: `scenario-${definition.id}-${step.id}`, scenarioSnapshot: clone({ ...scenario, events: [] }) });
      if (step.event.date > scenario.simulationDate) scenario.simulationDate = step.event.date;
    } else if (step.type === "advance-date") {
      scenario.simulationDate = step.date;
    } else if (step.type === "configuration") {
      applyMutation(scenario, step.mutation);
    }
  }
  return scenario;
}
