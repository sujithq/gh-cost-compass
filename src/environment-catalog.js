import { registerEnvironment } from "./environment.js";

export const DEFAULT_ENVIRONMENT_CATALOG_URL = new URL("../scenarios/environments/catalog.json", import.meta.url);

export async function loadEnvironmentCatalog(catalogUrl = DEFAULT_ENVIRONMENT_CATALOG_URL, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required to load environments.");
  const response = await fetchImpl(catalogUrl);
  if (!response.ok) throw new Error(`Unable to load environment catalog (${response.status}).`);
  const catalog = await response.json();
  if (catalog?.version !== 1 || !Array.isArray(catalog.environments)) throw new Error("Environment catalog must use version 1 and contain an environments array.");
  const ids = new Set();
  for (const entry of catalog.environments) {
    if (!entry?.id || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) throw new Error("Every environment catalog entry requires a valid id.");
    if (ids.has(entry.id)) throw new Error(`Duplicate environment id in catalog: ${entry.id}.`);
    if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(entry.file || "")) throw new Error(`Invalid environment filename for ${entry.id}.`);
    ids.add(entry.id);
    const environmentResponse = await fetchImpl(new URL(entry.file, catalogUrl));
    if (!environmentResponse.ok) throw new Error(`Unable to load environment ${entry.id} (${environmentResponse.status}).`);
    const environment = await environmentResponse.json();
    if (environment.id !== entry.id) throw new Error(`Catalog id ${entry.id} does not match environment id ${environment.id}.`);
    registerEnvironment(environment);
  }
  return [...ids];
}
