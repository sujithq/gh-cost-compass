import { createDefaultScenario } from "./engine.js";
import { getEnvironment, validateMaterializedScenario, validateEnvironment } from "./environment.js";

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

function validateDefinitionShape(definition) {
  if (!definition || definition.version !== 1) return "Scenario definition must use version 1.";
  if (!definition.id || !definition.title || !definition.summary) return "Scenario definition requires id, title, and summary.";
  if (definition.environmentId && !/^[a-z0-9][a-z0-9-]*$/.test(definition.environmentId)) return "Scenario environmentId must be a valid id.";
  if (definition.baseline !== undefined) {
    const baselineError = validateEnvironment({ ...definition.baseline, version: 1, id: definition.baseline.id || `${definition.id}-inline`, name: definition.baseline.name || definition.title, summary: definition.baseline.summary || definition.summary });
    if (baselineError) return `Inline baseline is invalid: ${baselineError}`;
  }
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

function baseScenarioForDefinition(definition, defaultSetId) {
  if (definition.environmentId) {
    const environment = getEnvironment(definition.environmentId);
    if (!environment) throw new Error(`Scenario environment not loaded: ${definition.environmentId}.`);
    const { source, name, summary, ...topology } = environment;
    return normalizeEnvironmentScenario({ ...topology, version: 2, events: [], simulationDate: definition.startDate || source.createdAt.slice(0, 10), enterpriseTeams: topology.enterpriseTeams || [] });
  }
  if (definition.baseline) {
    const { source, name, summary, ...topology } = structuredClone(definition.baseline);
    return normalizeEnvironmentScenario({ ...topology, version: 2, events: [], simulationDate: definition.startDate || source.createdAt.slice(0, 10), enterpriseTeams: topology.enterpriseTeams || [] });
  }
  const scenario = createDefaultScenario(defaultSetId);
  scenario.events = [];
  scenario.simulationDate = definition.startDate || scenario.simulationDate;
  return scenario;
}

function normalizeEnvironmentScenario(scenario) {
  scenario.enterpriseTeams ||= [];
  for (const team of scenario.enterpriseTeams) team.userIds ||= [];
  return scenario;
}

export function validateScenarioDefinition(definition) {
  const shapeError = validateDefinitionShape(definition);
  if (shapeError) return shapeError;
  if (definition.environmentId || definition.baseline) {
    try {
      const scenario = baseScenarioForDefinition(definition);
      for (const mutation of definition.setup || []) applyMutation(scenario, mutation);
      const error = validateMaterializedScenario(scenario);
      if (error) return error;
    } catch (error) {
      return error.message;
    }
  }
  return null;
}

export function materializeScenario(definition, stepIndex = -1, { defaultSetId } = {}) {
  const error = validateDefinitionShape(definition);
  if (error) throw new Error(error);
  const scenario = baseScenarioForDefinition(definition, defaultSetId);
  for (const seedEvent of definition.seed || []) {
    scenario.events.push({ ...clone(seedEvent), id: seedEvent.id || `scenario-${definition.id}-seed-${scenario.events.length}` });
    if (seedEvent.date > scenario.simulationDate) scenario.simulationDate = seedEvent.date;
  }
  for (const mutation of definition.setup || []) applyMutation(scenario, mutation);
  const setupError = validateMaterializedScenario(scenario);
  if (setupError) throw new Error(setupError);
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
  const materializedError = validateMaterializedScenario(scenario);
  if (materializedError) throw new Error(materializedError);
  return scenario;
}
