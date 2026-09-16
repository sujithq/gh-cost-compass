import compactSet from "../scenarios/default-sets/compact.json" with { type: "json" };
import enterpriseSet from "../scenarios/default-sets/enterprise.json" with { type: "json" };

export const DEFAULT_SCENARIO_SET_ID = "enterprise";

const defaultScenarioSetDefinitions = [enterpriseSet, compactSet];

export const defaultScenarioSetOptions = defaultScenarioSetDefinitions.map(({ id, name, summary }) => ({ id, name, summary }));

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function expandGeneratedUsers(definition) {
  const generated = definition.generatedUsers;
  if (!generated) return [];
  const organizations = definition.scenario.organizations;
  const costCenters = definition.scenario.costCenters;
  const nullIds = new Set(generated.nullCostCenterUserIds || []);
  const profiles = generated.roleProfiles.flatMap((profile) => Array.from({ length: profile.count }, (_, index) => ({ ...profile, index: index + 1 })));
  return profiles.slice(generated.skipFirst || 0).map((profile, index) => {
    const userNumber = index + 1 + (generated.skipFirst || 0);
    const userId = `user-${slug(profile.prefix)}-${String(profile.index).padStart(3, "0")}`;
    const organization = organizations[index % organizations.length];
    const secondaryOrganization = organizations[(index + generated.secondaryOrganizationOffset) % organizations.length];
    const hasSecondaryOrg = generated.secondaryOrganizationEvery && userNumber % generated.secondaryOrganizationEvery === 0;
    const isUnassigned = nullIds.has(userId) || generated.nullCostCenterEvery && userNumber % generated.nullCostCenterEvery === 0;
    return {
      id: userId,
      name: `${profile.prefix} ${String(profile.index).padStart(3, "0")} - ${profile.role}`,
      role: profile.role,
      organizationIds: hasSecondaryOrg ? [organization.id, secondaryOrganization.id] : [organization.id],
      licenseOrganizationId: organization.id,
      costCenterId: isUnassigned ? null : costCenters[index % costCenters.length].id,
      licensePlan: profile.licensePlan,
      licenseStartsAt: generated.licenseStartsAt,
      licenseEndsAt: null,
      licenseEndMode: null,
    };
  });
}

function createScenarioFromDefinition(definition) {
  const scenario = structuredClone(definition.scenario);
  scenario.users = [...(scenario.users || []), ...expandGeneratedUsers(definition)];
  return scenario;
}

export function createScenarioFromDefaultSet(setId = DEFAULT_SCENARIO_SET_ID) {
  const definition = defaultScenarioSetDefinitions.find((item) => item.id === setId)
    || defaultScenarioSetDefinitions.find((item) => item.id === DEFAULT_SCENARIO_SET_ID);
  return createScenarioFromDefinition(definition);
}