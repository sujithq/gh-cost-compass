import { materializeScenario, validateScenarioDefinition } from "./scenario-runner.js";
import { loadEnvironmentCatalog } from "./environment-catalog.js";

export const DEFAULT_SCENARIO_CATALOG_URL = new URL("../scenarios/catalog.json", import.meta.url);

export async function loadScenarioCatalog(catalogUrl = DEFAULT_SCENARIO_CATALOG_URL, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required to load scenarios.");
  const catalogResponse = await fetchImpl(catalogUrl);
  if (!catalogResponse.ok) throw new Error(`Unable to load scenario catalog (${catalogResponse.status}).`);
  const catalog = await catalogResponse.json();
  if (catalog?.version !== 1 || !Array.isArray(catalog.scenarios) || catalog.scenarios.length === 0) {
    throw new Error("Scenario catalog must use version 1 and contain at least one entry.");
  }
  if (String(catalogUrl) === String(DEFAULT_SCENARIO_CATALOG_URL)) {
    await loadEnvironmentCatalog(undefined, fetchImpl);
  }

  const ids = new Set();
  const definitions = [];
  for (const entry of catalog.scenarios) {
    if (!entry?.id || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) throw new Error("Every catalog entry requires a valid id.");
    if (ids.has(entry.id)) throw new Error(`Duplicate scenario id in catalog: ${entry.id}.`);
    if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(entry.file || "")) throw new Error(`Invalid scenario filename for ${entry.id}.`);
    ids.add(entry.id);

    const definitionUrl = new URL(entry.file, catalogUrl);
    const definitionResponse = await fetchImpl(definitionUrl);
    if (!definitionResponse.ok) throw new Error(`Unable to load scenario ${entry.id} (${definitionResponse.status}).`);
    const definition = await definitionResponse.json();
    const validationError = validateScenarioDefinition(definition);
    if (validationError) throw new Error(`${entry.id}: ${validationError}`);
    if (definition.id !== entry.id) throw new Error(`Catalog id ${entry.id} does not match definition id ${definition.id}.`);
    materializeScenario(definition, -1);
    definitions.push(definition);
  }
  return definitions;
}
