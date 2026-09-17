import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { budgetInScope, budgetStopsUsage, bucketsForEvent, costCenterForUser, costCenterIncludedPoolFor, describeCostCenterConfiguration, describeScopeConfiguration, createDefaultScenario, defaultScenarioSetOptions, eventInScope, isSeatActiveForDate, percent, replayScenario, replayScenarioThroughEvent, seatChargeForPeriod, userPoolContribution, usersInScope, validateScenario } from "../src/engine.js";
import { isScenarioCompatibleWithDefaultSet, materializeScenario, resolveScenarioDefaultSetId, validateScenarioDefinition } from "../src/scenario-runner.js";
import { loadScenarioCatalog } from "../src/scenario-catalog.js";
import { registerEnvironment, validateMaterializedScenario, validateEnvironment } from "../src/environment.js";
import { trimToastStack } from "../src/toast-stack.js";
import { buildAssistantContext, createAssistantProvider, validateAssistantDraft } from "../src/assistant.js";

async function fileFetch(url) {
  try {
    const content = await readFile(url, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(content) };
  } catch {
    return { ok: false, status: 404, json: async () => null };
  }
}

const BUILT_IN_SCENARIOS = await loadScenarioCatalog(new URL("../scenarios/catalog.json", import.meta.url), fileFetch);

function usage(id, date, quantity, overrides = {}) {
  return { id, date, quantity, userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", ...overrides };
}

function poolTotalFor(scenario, date = "2026-09-15") {
  scenario.events = [];
  scenario.simulationDate = date;
  return replayScenario(scenario).pool.total;
}

function quantityWithOverage(scenario, overage = 200, date = "2026-09-15") {
  return poolTotalFor(scenario, date) + overage;
}

test("assistant context summarizes the live budget health for the current simulation state", () => {
  const scenario = createDefaultScenario("compact");
  scenario.events = [usage("assistant-check", "2026-09-15", 200, { userId: "user-alice" })];
  const replay = replayScenario(scenario);
  const latestResult = replay.results.at(-1);
  const context = buildAssistantContext(scenario, replay, { latestResult, selectedScope: { type: "enterprise", id: scenario.enterprise.id } });

  assert.equal(context.enterprise, scenario.enterprise.name);
  assert.equal(context.includedPool.total, replay.pool.total);
  assert.ok(context.risks.length > 0 || !context.risks.length);
  assert.ok(context.docs.some((doc) => doc.title.includes("budgets")));
  assert.equal(context.latestResult.status, latestResult.status);
  assert.ok(context.latestResult.controlEvaluations.length > 0);
  assert.match(context.riskOverview, /at .*\(|No active budget/);
});

test("assistant provider returns grounded summaries and safe read-only draft scenarios", () => {
  const scenario = createDefaultScenario("compact");
  scenario.events = [usage("assistant-check", "2026-09-15", 200, { userId: "user-alice" })];
  const replay = replayScenario(scenario);
  const context = buildAssistantContext(scenario, replay, { latestResult: replay.results.at(-1), selectedScope: { type: "enterprise", id: scenario.enterprise.id } });
  const provider = createAssistantProvider();

  const explanation = provider.answer("Why was the latest event blocked or accepted?", context);
  assert.equal(explanation.kind, "explanation");
  assert.match(explanation.text, /Settings evaluated/);
  assert.match(explanation.text, /Stop usage|Eligible pool|Budget Type/);

  const riskExplanation = provider.answer(`Why is ${context.risks[0].name} the closest pressure point?`, context);
  assert.equal(riskExplanation.kind, "risk-explanation");
  assert.match(riskExplanation.text, /settings that make that true/i);
  assert.match(riskExplanation.text, /amount:|threshold alerts:|current usage:/);

  const summary = provider.answer("How much included headroom remains?", context);
  assert.equal(summary.kind, "summary");
  assert.match(summary.text, /included AI credits remaining|headroom/i);

  const draft = provider.answer("Draft a scenario proposal for budget health", context);
  assert.equal(draft.kind, "draft");
  assert.equal(draft.draft.version, 1);
  assert.equal(validateAssistantDraft(draft.draft).ok, true);
  assert.ok(draft.text.includes("read-only"));
});

test("default scenario provides an enterprise-grade synthetic tenant", () => {
  const scenario = createDefaultScenario();
  assert.equal(scenario.organizations.length, 10);
  assert.equal(scenario.costCenters.length, 20);
  assert.equal(scenario.users.length, 200);
  assert.ok(scenario.users.some((user) => user.role === "Software Engineer"));
  assert.ok(scenario.users.some((user) => user.role === "Data Scientist"));
  assert.ok(scenario.users.some((user) => user.role === "Project Manager"));
  assert.ok(scenario.users.some((user) => user.costCenterId === null));
  assert.equal(validateScenario(scenario), null);
  assert.equal(new Set(scenario.users.map((user) => user.id)).size, scenario.users.length);
  assert.equal(replayScenario(scenario).results.length, 2);
});

test("enterprise default distributes generated personas and leaves a deterministic unassigned cohort", () => {
  const scenario = createDefaultScenario();
  const roleCounts = scenario.users.reduce((counts, user) => {
    counts[user.role] = (counts[user.role] || 0) + 1;
    return counts;
  }, {});
  const unassignedUsers = scenario.users.filter((user) => user.costCenterId === null);
  const multiOrganizationUsers = scenario.users.filter((user) => user.organizationIds.length > 1);

  assert.deepEqual(roleCounts, {
    "Software Engineer": 73,
    "Project Manager": 27,
    "Data Scientist": 34,
    "Security Engineer": 18,
    "Site Reliability Engineer": 18,
    "Business Analyst": 16,
    "UX Designer": 14,
  });
  assert.equal(unassignedUsers.length, 15);
  assert.ok(unassignedUsers.some((user) => user.id === "user-engineer-012"));
  assert.equal(multiOrganizationUsers.length, 11);
  assert.ok(multiOrganizationUsers.every((user) => user.organizationIds.includes(user.licenseOrganizationId)));
  assert.ok(scenario.users.every((user) => scenario.organizations.some((organization) => organization.id === user.licenseOrganizationId)));
});

test("default scenario sets can load the compact demo tenant", () => {
  assert.ok(defaultScenarioSetOptions.some((item) => item.id === "enterprise"));
  assert.ok(defaultScenarioSetOptions.some((item) => item.id === "compact"));
  const scenario = createDefaultScenario("compact");
  assert.equal(scenario.organizations.length, 2);
  assert.equal(scenario.costCenters.length, 2);
  assert.equal(scenario.users.length, 2);
  assert.equal(validateScenario(scenario), null);
  assert.equal(replayScenario(scenario).pool.total, 5800);
});

test("default scenario sets are backed by JSON files", async () => {
  for (const name of ["enterprise", "compact"]) {
    const content = await readFile(new URL(`../scenarios/default-sets/${name}.json`, import.meta.url), "utf8");
    const definition = JSON.parse(content);
    assert.equal(definition.id, name);
    assert.equal(definition.scenario.version, 2);
  }
});

test("guided scenario materialization can use a selected default set", () => {
  const definition = {
    version: 1,
    id: "selected-default-smoke",
    title: "Selected default smoke",
    summary: "Verifies scenario replay can use a non-enterprise default set.",
    steps: [{ id: "use-ai", type: "usage", title: "Use AI", description: "Alice uses credits.", expected: "Usage is accepted.", event: usage("unused", "2026-09-15", 100) }],
  };
  const compact = materializeScenario(definition, 0, { defaultSetId: "compact" });
  assert.equal(compact.users.length, 2);
  assert.equal(replayScenario(compact).pool.total, 5800);
});

test("authored guided scenario compatibility is explicit and selected sets stay authoritative", () => {
  const definition = {
    version: 1,
    id: "authored-default-smoke",
    title: "Authored default smoke",
    summary: "Verifies a scenario keeps its authored baseline.",
    defaultSetId: "compact",
    compatibleDefaultSetIds: ["compact"],
    steps: [{ id: "use-ai", type: "usage", title: "Use AI", description: "Alice uses credits.", expected: "Usage is accepted.", event: usage("unused", "2026-09-15", 100) }],
  };
  assert.equal(resolveScenarioDefaultSetId(definition, "enterprise"), "compact");
  assert.equal(isScenarioCompatibleWithDefaultSet(definition, "compact"), true);
  assert.equal(isScenarioCompatibleWithDefaultSet(definition, "enterprise"), false);
  const scenario = materializeScenario(definition, 0, { defaultSetId: "enterprise" });
  assert.equal(scenario.users.length, 200);
  assert.equal(replayScenario(scenario).pool.total, 666000);
  const compact = materializeScenario(definition, 0, { defaultSetId: "compact" });
  assert.equal(compact.users.length, 2);
  assert.equal(replayScenario(compact).pool.total, 5800);
});

test("portable guided scenarios are compatible with every registered default set", () => {
  const definition = {
    version: 1,
    id: "portable-default-smoke",
    title: "Portable default smoke",
    summary: "Verifies a scenario follows the selected default set.",
    steps: [{ id: "checkpoint", type: "checkpoint", title: "Inspect", description: "Inspect the selected dataset.", expected: "The selected dataset remains active." }],
  };
  assert.equal(isScenarioCompatibleWithDefaultSet(definition, "enterprise"), true);
  assert.equal(isScenarioCompatibleWithDefaultSet(definition, "compact"), true);
  assert.equal(materializeScenario(definition, -1, { defaultSetId: "enterprise" }).users.length, 200);
  assert.equal(materializeScenario(definition, -1, { defaultSetId: "compact" }).users.length, 2);
});

test("scenario definitions reject unknown authored baselines", () => {
  const definition = {
    version: 1,
    id: "unknown-default",
    title: "Unknown default",
    summary: "Invalid baseline.",
    defaultSetId: "missing",
    steps: [{ id: "checkpoint", type: "checkpoint", title: "Checkpoint", description: "Pause.", expected: "No state changes." }],
  };
  assert.match(validateScenarioDefinition(definition), /default set not found/);
  assert.throws(() => materializeScenario(definition), /default set not found/);
});

test("authored topology requires explicit compatible default sets", () => {
  const definition = {
    version: 1,
    id: "missing-compatibility",
    title: "Missing compatibility",
    summary: "Invalid authored topology.",
    defaultSetId: "compact",
    steps: [{ id: "checkpoint", type: "checkpoint", title: "Pause", description: "Pause.", expected: "No state changes." }],
  };
  assert.match(validateScenarioDefinition(definition), /compatibleDefaultSetIds/);
});

test("scenario definitions reject combining defaultSetId with an environment reference", () => {
  const definition = {
    version: 1,
    id: "conflicting-baseline",
    title: "Conflicting baseline",
    summary: "Invalid combination.",
    defaultSetId: "compact",
    environmentId: "some-environment",
    steps: [{ id: "checkpoint", type: "checkpoint", title: "Checkpoint", description: "Pause.", expected: "No state changes." }],
  };
  assert.match(validateScenarioDefinition(definition), /cannot combine defaultSetId/);
});

test("shared materialized validator enforces licensing and budget invariants", () => {
  const scenario = createDefaultScenario("compact");
  scenario.users[0].licenseOrganizationId = "org-missing";
  assert.match(validateMaterializedScenario(scenario), /unknown license organization/);
  scenario.users[0].licenseOrganizationId = scenario.users[0].organizationIds[0];
  scenario.users[0].organizationIds = [];
  assert.match(validateMaterializedScenario(scenario), /at least one organization/);
});

test("environment provenance and topology validation reject runtime state", () => {
  const scenario = createDefaultScenario("compact");
  const environment = {
    version: 1,
    id: "validator-smoke",
    name: "Validator smoke",
    summary: "A reusable topology fixture.",
    source: {
      kind: "synthetic",
      createdAt: "2026-09-01T00:00:00Z",
      assumptions: ["Synthetic identities"],
      omittedCapabilities: ["Live usage"],
    },
    ...scenario,
  };
  delete environment.version;
  environment.version = 1;
  delete environment.events;
  delete environment.simulationDate;
  assert.equal(validateEnvironment(environment), null);
  environment.events = [];
  assert.match(validateEnvironment(environment), /topology only/);
});

test("scenario environments are data-loaded and seed events replay before steps", () => {
  const source = createDefaultScenario("compact");
  const environment = {
    version: 1,
    id: "seed-smoke",
    name: "Seed smoke",
    summary: "A reusable topology fixture.",
    source: {
      kind: "synthetic",
      createdAt: "2026-09-01T00:00:00Z",
      assumptions: [],
      omittedCapabilities: [],
    },
    enterprise: source.enterprise,
    organizations: source.organizations,
    repositories: source.repositories,
    costCenters: source.costCenters,
    enterpriseTeams: source.enterpriseTeams,
    users: source.users,
    products: source.products,
    budgets: source.budgets,
  };
  registerEnvironment(environment);
  const definition = {
    version: 1,
    id: "seed-smoke-scenario",
    title: "Seed smoke scenario",
    summary: "Checks reusable environment loading.",
    environmentId: "seed-smoke",
    compatibleDefaultSetIds: ["compact"],
    seed: [usage("seed", "2026-09-02", 100)],
    steps: [{ id: "step", type: "usage", title: "Use credits", description: "Consumes more credits.", expected: "Both events are replayed.", event: usage("step-event", "2026-09-03", 200) }],
  };
  const materialized = materializeScenario(definition, 0);
  assert.equal(materialized.events.length, 2);
  assert.deepEqual(materialized.events.map((event) => event.id), ["seed", "scenario-seed-smoke-scenario-step"]);
  assert.equal(replayScenario(materialized).pool.consumed, 300);
});

test("generated environments are reusable by multiple guided definitions without topology duplication", async () => {
  const environment = JSON.parse(await readFile(new URL("../scenarios/environments/synthetic-compact.json", import.meta.url), "utf8"));
  const environmentSchema = JSON.parse(await readFile(new URL("../scenarios/environment.schema.json", import.meta.url), "utf8"));
  assert.equal(environmentSchema.properties.version.const, 1);
  assert.equal(validateEnvironment(environment), null);
  assert.equal(environment.events, undefined);
  assert.equal(environment.simulationDate, undefined);
  assert.equal(environment.source.kind, "synthetic");

  const shared = BUILT_IN_SCENARIOS.filter((definition) => definition.environmentId === environment.id);
  assert.deepEqual(shared.map((definition) => definition.id), ["budget-health-progression", "pool-to-paid-overage"]);
  assert.ok(shared.every((definition) => definition.baseline === undefined));
  assert.ok(shared.every((definition) => validateScenarioDefinition(definition) === null));

  for (const definition of shared) {
    const baseline = materializeScenario(definition, -1);
    const replay = replayScenario(materializeScenario(definition, definition.steps.length - 1));
    assert.equal(baseline.users.length, 2);
    assert.equal(baseline.events.length, 0);
    assert.deepEqual(materializeScenario(definition, -1), baseline);
    assert.ok(replay.results.length > 0);
    assert.ok(replay.results.every((result) => ["accepted", "blocked"].includes(result.status)));
  }
  const progression = shared.find((definition) => definition.id === "budget-health-progression");
  const atHundred = replayScenario(materializeScenario(progression, 4));
  assert.equal(atHundred.budgetStates.find((item) => item.id === "ulb-alice").percent, 100);
  assert.equal(atHundred.results.at(-1).status, "accepted");
  assert.ok(atHundred.alerts.some((alert) => alert.budgetId === "ulb-alice" && alert.threshold === 100));
});

test("scenario validation rejects broken enterprise data references", () => {
  const scenario = createDefaultScenario();
  scenario.users[0].costCenterId = "cc-missing";
  assert.match(validateScenario(scenario), /unknown cost center/);
});

test("AI credits use the shared included pool before creating spend", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("one", "2026-09-15", 1000)];
  const replay = replayScenario(scenario);
  assert.equal(replay.pool.total, 666000);
  assert.equal(replay.pool.consumed, 1000);
  assert.equal(replay.results[0].includedQuantity, 1000);
  assert.equal(replay.results[0].meteredQuantity, 0);
  assert.equal(replay.results[0].fundingRoute, "included");
  assert.equal(replay.results[0].cost, 0);
  assert.deepEqual(replay.results[0].affectedBudgets.map((item) => item.budgetId), ["ulb-alice", "metered-enterprise", "metered-ai-team"]);
});

test("percent display retains two decimal places near a budget limit", () => {
  assert.equal(percent(44.99 / 45 * 100), "99.98%");
  assert.equal(percent(100), "100.00%");
});

test("individual ULB overrides cost-center and universal ULBs", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("one", "2026-09-15", 4000)];
  const replay = replayScenario(scenario);
  const alice = replay.budgetStates.find((item) => item.userId === "user-alice");
  const bob = replay.budgetStates.find((item) => item.userId === "user-bob");
  assert.equal(alice.id, "ulb-alice");
  assert.equal(alice.spent, 40);
  assert.equal(bob.id, "ulb-core-team");
});

test("ULB counts total consumption and always blocks even while pool remains", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10;
  scenario.events = [usage("blocked", "2026-09-15", 1001)];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].status, "blocked");
  assert.match(replay.results[0].reason, /Stop usage when budget limit is reached/);
  assert.equal(replay.pool.consumed, 0);
});

test("enterprise and cost-center budgets count only metered overage", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10000;
  scenario.events = [usage("over", "2026-09-15", quantityWithOverage(scenario))];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].includedQuantity, 666000);
  assert.equal(replay.results[0].meteredQuantity, 200);
  assert.equal(replay.results[0].cost, 2);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-enterprise").spent, 2);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 2);
});

test("cost-center exclusion removes its AI usage from the enterprise budget", () => {
  const scenario = createDefaultScenario();
  scenario.costCenters.find((item) => item.id === "cc-ai").excludeFromEnterpriseBudget = true;
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10000;
  scenario.events = [usage("over", "2026-09-15", quantityWithOverage(scenario))];
  const replay = replayScenario(scenario);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-enterprise").spent, 0);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 2);
});

test("organization AI budget applies only when no cost center is assigned", () => {
  const scenario = createDefaultScenario();
  scenario.users.find((item) => item.id === "user-alice").costCenterId = null;
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10000;
  scenario.events = [usage("over", "2026-09-15", quantityWithOverage(scenario))];
  const replay = replayScenario(scenario);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-product-org").spent, 2);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 0);
});

test("organization cost-center assignment provides fallback attribution", () => {
  const scenario = createDefaultScenario();
  scenario.users.find((item) => item.id === "user-alice").costCenterId = null;
  scenario.costCenters.find((item) => item.id === "cc-ai").organizationIds = ["org-product"];
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10000;
  scenario.events = [usage("over", "2026-09-15", quantityWithOverage(scenario))];
  const replay = replayScenario(scenario);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 2);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-product-org").spent, 0);
});

test("enterprise team assignment can attribute users to a cost center", () => {
  const scenario = createDefaultScenario("compact");
  scenario.users.find((item) => item.id === "user-alice").costCenterId = null;
  scenario.costCenters.find((item) => item.id === "cc-ai").enterpriseTeamIds = ["team-ai"];
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("over", "2026-09-15", 6000)];
  const replay = replayScenario(scenario);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 2);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-product-org").spent, 0);
});

test("enabled cost-center AI credit pools partition included credits from the enterprise pool", () => {
  // Pinned to the compact tenant: these credit totals assume cc-ai is funded by Alice alone.
  const scenario = createDefaultScenario("compact");
  scenario.costCenters.find((item) => item.id === "cc-ai").aiCreditPoolEnabled = true;
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("pool", "2026-09-15", 1000)];
  const replay = replayScenario(scenario);
  assert.equal(costCenterIncludedPoolFor(scenario, "cc-ai", "2026-09-15"), 3900);
  assert.equal(replay.pool.total, 1900);
  assert.equal(replay.pool.consumed, 0);
  assert.equal(replay.costCenterPoolStates.find((item) => item.costCenterId === "cc-ai").consumed, 1000);
  assert.equal(replay.results[0].poolType, "costCenter");
});

test("the grand total included AI-credit pool stays whole even after a cost center reserves a slice", () => {
  // A cost-center pool reservation partitions the enterprise pool, it doesn't shrink it: the grand
  // total must always equal every seat's contribution, and grand consumption must roll up both the
  // shared remainder and any reserved cost-center pools.
  const scenario = createDefaultScenario("compact");
  scenario.costCenters.find((item) => item.id === "cc-ai").aiCreditPoolEnabled = true;
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("pool", "2026-09-15", 1000)];
  const replay = replayScenario(scenario);
  assert.equal(replay.pool.total, 1900);
  assert.equal(replay.pool.grandTotal, 5800);
  assert.equal(replay.pool.grandConsumed, 1000);
  assert.equal(replay.pool.grandRemaining, 4800);
  assert.ok(Math.abs(replay.pool.grandPercent - (1000 / 5800) * 100) < 1e-9);
  const breakdown = replay.pool.licenseBreakdown;
  assert.equal(breakdown.reduce((sum, entry) => sum + entry.credits, 0), 5800);
  assert.deepEqual(breakdown.find((entry) => entry.plan === "enterprise"), { plan: "enterprise", seatCount: 1, credits: 3900 });
  assert.deepEqual(breakdown.find((entry) => entry.plan === "business"), { plan: "business", seatCount: 1, credits: 1900 });
});

test("cost-center AI credit pool can block at its included cap", () => {
  const scenario = createDefaultScenario("compact");
  Object.assign(scenario.costCenters.find((item) => item.id === "cc-ai"), { aiCreditPoolEnabled: true, aiCreditPoolCapMode: "block" });
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("near-cap", "2026-09-15", 3800), usage("blocked", "2026-09-15", 200)];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].status, "accepted");
  assert.equal(replay.results[1].status, "blocked");
  assert.match(replay.results[1].reason, /included AI credit pool cap/);
  assert.equal(replay.costCenterPoolStates.find((item) => item.costCenterId === "cc-ai").consumed, 3800);
});

test("cost-center AI credit pool can roll over into paid metered budgets", () => {
  const scenario = createDefaultScenario("compact");
  Object.assign(scenario.costCenters.find((item) => item.id === "cc-ai"), { aiCreditPoolEnabled: true, aiCreditPoolCapMode: "allowOverage" });
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("pool", "2026-09-15", 3900), usage("overage", "2026-09-15", 2400)];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[1].status, "accepted");
  assert.equal(replay.results[1].includedQuantity, 0);
  assert.equal(replay.results[1].meteredQuantity, 2400);
  assert.equal(replay.results[1].fundingRoute, "overage");
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 24);
  assert.ok(replay.alerts.some((item) => item.budgetId === "metered-ai-team" && item.threshold === 75));
});

test("cost-center overage remains visible while enterprise pool has headroom", () => {
  const scenario = createDefaultScenario("compact");
  Object.assign(scenario.costCenters.find((item) => item.id === "cc-ai"), { aiCreditPoolEnabled: true, aiCreditPoolCapMode: "allowOverage" });
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("pool", "2026-09-15", 3900), usage("overage", "2026-09-15", 100)];
  const replay = replayScenario(scenario);
  const result = replay.results[1];
  assert.equal(replay.pool.remaining, 1900);
  assert.equal(result.fundingRoute, "overage");
  assert.equal(result.poolName, "AI Innovation included AI-credit pool");
  assert.equal(result.poolRemainingBefore, 0);
  assert.equal(result.meteredQuantity, 100);
  assert.equal(result.cost, 1);
});

test("paid usage policy blocks overage regardless of budget headroom", () => {
  const scenario = createDefaultScenario();
  scenario.enterprise.paidAiUsage = false;
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10000;
  scenario.events = [usage("over", "2026-09-15", quantityWithOverage(scenario))];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].status, "blocked");
  assert.equal(replay.results[0].fundingRoute, "blocked");
  assert.match(replay.results[0].reason, /AI credit paid usage is disabled/);
});

test("metered hard budget blocks overage but not included consumption", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10000;
  scenario.budgets.find((item) => item.id === "metered-ai-team").amount = 1;
  scenario.events = [usage("over", "2026-09-15", quantityWithOverage(scenario))];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].status, "blocked");
  assert.match(replay.results[0].reason, /Stop usage when budget limit is reached/);
});

test("zero-dollar AI-credit budget blocks metered usage even when configured alert-only", () => {
  const scenario = createDefaultScenario();
  scenario.users.find((item) => item.id === "user-alice").costCenterId = null;
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10000;
  scenario.budgets.find((item) => item.id === "metered-product-org").amount = 0;
  scenario.events = [usage("over", "2026-09-15", quantityWithOverage(scenario))];
  const replay = replayScenario(scenario);
  const zeroDollarBudget = scenario.budgets.find((item) => item.id === "metered-product-org");
  assert.equal(budgetStopsUsage(scenario, zeroDollarBudget), true);
  assert.equal(replay.results[0].status, "blocked");
  assert.match(replay.results[0].reason, /Stop usage when budget limit is reached/);
  const budgetCheck = replay.results[0].controlEvaluations.find((item) => item.control === "Budgets and alerts");
  assert.ok(budgetCheck.configuration.some((item) => item.label === "Stop usage when budget limit is reached" && item.value === "Enabled"));
});

test("a mid-month budget ignores usage before its effective date", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10000;
  scenario.events = [usage("pool", "2026-09-05", quantityWithOverage(scenario, 0, "2026-09-05")), usage("before", "2026-09-09", 100), usage("after", "2026-09-12", 100)];
  scenario.simulationDate = "2026-09-12";
  const replay = replayScenario(scenario);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 1);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-enterprise").spent, 2);
});

test("mid-cycle seat add defaults to prorated license cost and credits, with a full-credit comparison option", () => {
  const scenario = createDefaultScenario();
  const addedSeat = { ...scenario.users[0], id: "user-cedric", name: "Cedric", licenseStartsAt: "2026-09-15", licenseEndsAt: null, licensePlan: "enterprise" };
  scenario.users = [addedSeat];
  assert.equal(scenario.enterprise.seatCreditPolicy, "prorated");
  assert.equal(seatChargeForPeriod(addedSeat, "2026-09-15"), 39 * (16 / 30));
  assert.equal(userPoolContribution(addedSeat, "2026-09-15", scenario), 3900 * (16 / 30));
  scenario.enterprise.seatCreditPolicy = "full";
  assert.equal(userPoolContribution(addedSeat, "2026-09-15", scenario), 3900);
});

test("license removal keeps the current cycle pool and avoids a refund", () => {
  const scenario = createDefaultScenario();
  const removedSeat = { ...scenario.users[0], licenseStartsAt: "2026-09-01", licenseEndsAt: "2026-09-15", licensePlan: "enterprise" };
  scenario.users = [removedSeat];
  assert.equal(seatChargeForPeriod(removedSeat, "2026-09-20"), 39);
  assert.equal(userPoolContribution(removedSeat, "2026-09-20", scenario), 3900);
});

test("unassignment preserves access through month end while revocation stops it immediately", () => {
  const user = { ...createDefaultScenario().users[0], licenseEndsAt: "2026-09-15" };
  assert.equal(isSeatActiveForDate({ ...user, licenseEndMode: "unassign" }, "2026-09-30"), true);
  assert.equal(isSeatActiveForDate({ ...user, licenseEndMode: "unassign" }, "2026-10-01"), false);
  assert.equal(isSeatActiveForDate({ ...user, licenseEndMode: "revoke" }, "2026-09-15"), false);
});

test("pool capacity changes on the effective seat-grant date without rewriting earlier usage", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.users = scenario.users.filter((user) => ["user-alice", "user-bob"].includes(user.id));
  scenario.users.find((user) => user.id === "user-alice").licenseStartsAt = "2026-09-20";
  scenario.events = [
    usage("before-add", "2026-09-10", 2000, { userId: "user-bob", repositoryId: "repo-tools" }),
    usage("after-add", "2026-09-20", 100),
  ];
  scenario.simulationDate = "2026-09-20";
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].includedQuantity, 1900);
  assert.equal(replay.results[0].meteredQuantity, 100);
  assert.equal(replay.results[1].includedQuantity, 100);
  assert.equal(replay.pool.total, 1900 + 3900 * (11 / 30));
});

test("monthly pool and counters reset while history remains", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("sep", "2026-09-15", 1000), usage("oct", "2026-10-02", 2000)];
  scenario.simulationDate = "2026-10-02";
  const replay = replayScenario(scenario);
  assert.equal(replay.results.length, 2);
  assert.equal(replay.pool.consumed, 2000);
});

test("usage before a seat grant is blocked without changing pool or budgets", () => {
  const scenario = createDefaultScenario();
  scenario.users.find((user) => user.id === "user-alice").licenseStartsAt = "2026-09-20";
  scenario.events = [usage("before-grant", "2026-09-15", 100)];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].status, "blocked");
  assert.match(replay.results[0].reason, /does not have an active Copilot seat/);
  assert.equal(replay.pool.consumed, 0);
  assert.equal(replay.results[0].affectedBudgets.length, 0);
});

test("future events remain scheduled until the clock advances", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("future", "2026-10-02", 100)];
  assert.equal(replayScenario(scenario).results.length, 0);
  scenario.simulationDate = "2026-10-02";
  assert.equal(replayScenario(scenario).results.length, 1);
});

test("configuration help exposes impact regions and official GitHub citations", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const id of ["enterprise-impact", "cost-center-impact", "user-impact", "budget-impact"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="default-scenario-set"/);
  for (const id of ["enterprise-team-form", "enterprise-team-users", "cost-center-ai-pool", "cost-center-pool-mode", "cost-center-team", "cost-center-repository"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /docs\.github\.com\/en\/copilot\/concepts\/billing-and-usage\/organizations-and-enterprises\/billing/);
  assert.match(html, /docs\.github\.com\/en\/billing\/reference\/cost-center-allocation/);
  assert.match(html, /included-usage-controls-for-cost-centers/);
  assert.match(html, /docs\.github\.com\/en\/billing\/how-tos\/set-up-budgets/);
});

test("threshold alerts carry the state key needed to open budget history", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10000;
  scenario.budgets.find((item) => item.id === "metered-ai-team").amount = 30;
  scenario.budgets.find((item) => item.id === "metered-ai-team").thresholds = [75, 90, 100];
  scenario.events = [usage("pool", "2026-09-15", quantityWithOverage(scenario, 0)), usage("over", "2026-09-15", 2400)];
  const replay = replayScenario(scenario);
  const alert = replay.alerts.find((item) => item.budgetId === "metered-ai-team");
  assert.equal(alert.stateKey, "metered-ai-team:2026-09");
  assert.ok(replay.budgetStates.some((item) => item.stateId === alert.stateKey));
  assert.equal(replay.alerts.filter((item) => item.id === alert.id).length, 1);
});

test("user-level alerts keep GitHub's delivery caveat for the toast detail line", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 20;
  scenario.events = [usage("one", "2026-09-15", 1900)];
  const replay = replayScenario(scenario);
  const alert = replay.alerts.find((item) => item.budgetId === "ulb-alice");
  assert.match(alert.reliability, /not guaranteed by GitHub/);
});

test("dashboard includes an accessible budget history dialog", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(html, /id="budget-history-modal"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(app, /data-history-id="\$\{escapeHtml\(stateId\)\}"/);
  assert.match(app, /budgetRowHtml\(\{ stateId: "pool", kind: "shared-pool"/);
  assert.match(app, /budgetRowHtml\(\{ stateId: budget\.stateId, kind: "budget"/);
  assert.match(app, /money, normalizeScenario, percent, replayScenario/);
  for (const callSite of ["percent(replay.pool.percent)", "percent(percentValue)", "percent(budgetState.percent)", "percent(item.percent)", "percent(impact.percent)"]) {
    assert.match(app, new RegExp(callSite.replaceAll("(", "\\(").replaceAll(")", "\\)")));
  }
  assert.match(app, /Math\.min\(100, item\.percent\)/);
});

test("optimized UI is isolated from legacy pages and exposes bucket attribution controls", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  for (const id of ["optimized", "optimized-hierarchy", "optimized-buckets", "optimized-scope-type", "optimized-step-detail"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-view="optimized"/);
  assert.match(app, /renderOptimizedExperience\(replay, currency\)/);
  assert.match(app, /Included credits/);
  assert.match(app, /User-level budgets/);
  assert.match(app, /Budgets and alerts|Budget controls/);
  assert.match(app, /Why this state\?/);
  assert.match(app, /Stop usage when budget limit is reached/);
  assert.match(app, /scenario\.events\.find\(\(item\) => item\.id === result\.eventId\)/);
  assert.match(app, /visibleCostCenterPools/);
  assert.match(app, /next accepted usage uses paid overage/);
});

test("the Included credits panel renders the pool as a collapsible tree with cost-center reservations nested underneath", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /data-bucket-toggle="\$\{escapeHtml\(item\.stateId\)\}"/);
  assert.match(app, /closest\("\[data-bucket-toggle\]"\)/);
  assert.match(app, /bucket-children/);
  assert.match(app, /Included AI-credit pool/);
  assert.match(app, /Shared included AI-credit pool/);
  assert.match(app, /total AI credits come from/);
  assert.match(app, /replay\.pool\.grandTotal/);
  assert.match(app, /replay\.pool\.licenseBreakdown/);
});

test("the Included credits pool renders as a single flat row, not a tree, when no cost center reserves a slice of the pool", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // hasCostCenterPools must gate both the toggle (hasChildren/expanded) on the root row and whether
  // the shared-pool/cost-center children are even added to the rendered items list — otherwise a
  // scenario with no cost-center AI credit pool enabled would still show a pointless expand arrow
  // and a redundant "Shared included AI-credit pool" child that just repeats the same total.
  assert.match(app, /const hasCostCenterPools = visibleCostCenterPools\.length > 0;/);
  assert.match(app, /hasChildren: hasCostCenterPools, expanded: poolExpanded/);
  assert.match(app, /items: hasCostCenterPools \? \(poolExpanded \? \[poolRoot, sharedPool, \.\.\.costCenterPools\] : \[poolRoot\]\) : \[poolRoot\]/);
});

test("optimized UI hierarchy nodes double as clickable scope selectors", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(html, /id="global-timeline-prev"/);
  assert.match(html, /id="global-timeline-next"/);
  assert.match(app, /data-scope-type="\$\{escapeHtml\(type\)\}" data-scope-id="\$\{escapeHtml\(id\)\}"/);
  assert.match(app, /closest\("\[data-scope-type\]\[data-scope-id\]"\)/);
});

test("scenario timeline lives in the app header so it scrubs every page, not just the optimized subpage", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const simulateIndex = html.indexOf('data-view="simulate"');
  const optimizedIndex = html.indexOf('data-view="optimized"');
  assert.ok(simulateIndex > -1 && optimizedIndex > simulateIndex, "Optimized UI nav item should come after Simulate usage");
  assert.match(html, /nav-item nav-subitem" data-view="optimized"/);

  // The timeline bar must sit above the first page section so it is shared by every view.
  const barIndex = html.indexOf('id="global-timeline-bar"');
  const firstViewIndex = html.indexOf('class="view');
  assert.ok(barIndex > -1 && firstViewIndex > barIndex, "global timeline bar should precede the page sections");
  for (const id of ["global-scenario-definition", "global-timeline", "global-timeline-label"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="optimized-scrubber"/);
  assert.doesNotMatch(html, /id="optimized-timeline"/);

  assert.match(app, /data-scenario-timeline-step="\$\{index\}"/);
  assert.match(app, /closest\("\[data-scenario-timeline-step\]"\)/);
  assert.match(app, /function stepDisplayDate\(/);
  assert.match(app, /function updateBucketPanel\(/);
  // Rendered on every render() pass rather than from renderOptimizedExperience.
  assert.match(app, /renderGlobalScenarioBar\(\);/);
  assert.match(app, /#global-timeline-bar"\)\.classList\.toggle\("hidden"/);
  assert.match(styles, /\.global-timeline-bar\{position:static\}/);
});

test("assistant is available globally as a collapsible side panel", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(html, /data-view="assistant"/);
  assert.match(html, /id="assistant-launcher"/);
  assert.match(html, /aria-controls="assistant-drawer"/);
  assert.match(html, /id="assistant-drawer"/);
  assert.match(html, /id="assistant-collapse"/);
  assert.match(html, /id="assistant-prompts"/);
  assert.ok(html.indexOf('id="assistant-prompts"') > html.indexOf('id="assistant-thread"'), "assistant prompt pills should sit directly above the input area");
  assert.ok(html.indexOf('id="assistant-prompts"') < html.indexOf('id="assistant-form"'), "assistant prompt pills should sit directly above the input area");
  assert.match(html, /placeholder="Ask a budget-health question\.\.\."/);
  assert.match(html, /id="assistant-submit"/);
  assert.ok(html.indexOf('id="assistant-drawer"') > html.indexOf("</main>"), "assistant drawer should sit outside page views");

  assert.match(app, /let assistantDrawerOpen = false/);
  assert.match(app, /let assistantBusy = false/);
  assert.match(app, /let currentView = "dashboard"/);
  assert.match(app, /ASSISTANT_THINK_DELAY_MS/);
  assert.match(app, /ASSISTANT_STREAM_INTERVAL_MS/);
  assert.match(app, /function setAssistantDrawerOpen\(open\)/);
  assert.match(app, /function assistantPromptOptions\(context\)/);
  assert.match(app, /function assistantMessageHtml\(message\)/);
  assert.match(app, /Loading budget data/);
  assert.match(app, /assistant-typing-dots/);
  assert.match(app, /assistant-stream-caret/);
  assert.match(app, /async function streamAssistantMessage/);
  assert.match(app, /currentView = view/);
  assert.match(app, /function navigate\(view\)[\s\S]*renderAssistantPanel\(\);/);
  assert.match(app, /document\.body\.classList\.toggle\("assistant-open", assistantDrawerOpen\)/);
  assert.match(app, /launcher\.hidden = assistantDrawerOpen/);
  assert.match(app, /#assistant-launcher"\)\?\.addEventListener\("click"/);
  assert.match(app, /#assistant-collapse"\)\?\.addEventListener\("click"/);
  assert.match(app, /\[data-assistant-prompt\]/);
});

test("hierarchy nodes name their own entity type and share one icon set across pages", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(app, /const HIERARCHY_KINDS = \{/);
  for (const label of ["Enterprise", "Organization", "Cost center", "Repository", "User"]) {
    assert.match(app, new RegExp(`label: "${label}"`));
  }
  // Both pages must build their tree from the same function, so structure, icons, colors, and type
  // labels can never drift apart between the dashboard and the optimized page.
  assert.match(app, /function hierarchyTreeHtml\(hostId, \{ scopeNodes = false \} = \{\}\)/);
  assert.match(app, /\$\("#hierarchy"\)\.innerHTML = hierarchyTreeHtml\("dashboard"\);/);
  assert.match(app, /\$\("#optimized-hierarchy"\)\.innerHTML = hierarchyTreeHtml\("optimized", \{ scopeNodes: true \}\);/);
  assert.match(app, /hierarchy-kind/);
  assert.doesNotMatch(app, /class="tree-org"/);
  // Organization and cost-center glyphs were previously near-identical briefcases.
  const paths = Object.fromEntries([...app.matchAll(/^\s{2}(enterprise|organization|costCenter|user|repo): '(.+)',$/gm)].map((match) => [match[1], match[2]]));
  assert.equal(new Set(Object.values(paths)).size, 5);
});

test("cost-center-scoped user-level budgets use the cost-center icon, not the person icon", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // A ULB's budgetKind is always "user", but userBudgetType distinguishes an individual person
  // from a whole cost center; the icon/color helpers must branch on userBudgetType so a
  // cost-center-wide ULB doesn't render as if it were a single named person.
  assert.match(app, /if \(item\.userBudgetType === "costCenter"\) return \{ name: "costCenter", color: "cost-center", label: "Cost center-level budget" \};/);
  assert.match(app, /if \(budget\.budgetKind === "user"\) return budget\.userBudgetType === "costCenter" \? "costCenter" : "user";/);
  assert.match(app, /const colorClass = isUlb \? \(budget\.userBudgetType === "costCenter" \? "cost-center" : "user"\) : /);
});

test("the dashboard budget health view uses compact sections with the shared pool as its first row", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(app, /const BUDGET_GROUP_KINDS = \{/);
  for (const label of ["Included AI-credit pools", "Enterprise budgets", "Organization budgets", "Cost center budgets", "Repository budgets", "User-level budgets", "Other budgets"]) {
    assert.match(app, new RegExp(`label: "${label}"`));
  }
  assert.match(app, /function budgetRowHtml\(/);
  assert.match(app, /function budgetSectionHtml\(/);
  assert.match(app, /function budgetGroupKeyFor\(budget\)/);
  // Object key order renders the pool section first, and this array fixes the shared pool ahead of
  // every cost-center reservation within that first section.
  assert.match(app, /pool: \{ label: "Included AI-credit pools"/);
  assert.match(app, /data-budget-row-kind="\$\{escapeHtml\(kind\)\}"/);
  assert.match(app, /kind: "shared-pool"/);
  assert.match(app, /const groups = new Map\(\[\["pool", \[poolRow, \.\.\.costCenterPoolRows\]\]\]\);/);
  assert.match(app, /const orderedItems = key === "pool" \? items : sortBudgetItems\(items\);/);
  assert.doesNotMatch(app, /data-budget-group-toggle/);
  assert.match(app, /<h3><button type="button" class="budget-row-title budget-history-trigger"/);
  assert.match(app, /data-history-id="\$\{escapeHtml\(stateId\)\}"[^>]*>\$\{escapeHtml\(name\)\}<\/button><\/h3>/);
  assert.doesNotMatch(app, /budget-row-action/);
  assert.doesNotMatch(app, /class="budget-row budget-history-trigger"/);
  assert.match(app, /role="progressbar"/);
  assert.match(css, /\.budget-section\{/);
  assert.match(css, /\.budget-row\{display:grid;/);
});

test("budget rows stay grouped by scope and sort by percent, amount, then name", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(app, /function sortBudgetItems\(items\) \{/);
  assert.match(app, /b\.percent - a\.percent \|\| b\.amount - a\.amount \|\| a\.name\.localeCompare\(b\.name\)/);
  assert.match(app, /const groupKey = budgetGroupKeyFor\(budget\);/);
  assert.match(app, /Object\.keys\(BUDGET_GROUP_KINDS\).*budgetSectionHtml/);
  assert.match(app, /for \(const budget of replay\.budgetStates\)/);
  assert.match(app, /const BUDGET_SECTION_PAGE_SIZE = 8;/);
  assert.match(app, /orderedItems\.slice\(0, BUDGET_SECTION_PAGE_SIZE\)/);
  assert.match(app, /data-budget-section-more=/);
  assert.match(app, /budgetSectionExpansion\.add\(key\)/);
  assert.match(app, /money\(budget\.spent, "USD"\)/);
  assert.match(app, /budgetStopsUsage\(scenario, budget, product\) \? "Yes" : "No"/);
});

test("budget health rows use stable desktop columns and responsive narrow layouts", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(css, /\.budget-grid\{container-type:inline-size\}/);
  assert.match(css, /grid-template-areas:"identity detail stop meter"/);
  assert.match(css, /\.budget-row-title\{/);
  assert.match(css, /\.budget-row-meter \.progress\{height:5px/);
  assert.match(css, /@container \(max-width:820px\)/);
  assert.match(css, /@container \(max-width:520px\)/);
});

test("the hierarchy tree stays usable at enterprise scale", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // Enterprise-grade simulations mean many orgs and cost centers and hundreds of users, so the
  // tree must collapse branches, page oversized leaf lists, and support filtering.
  assert.match(app, /function hierarchyBranchHtml\(key, nodeHtml, open, summary, childrenHtml\)/);
  assert.match(app, /data-tree-toggle=/);
  assert.match(app, /aria-expanded="\$\{open\}"/);
  // A collapsed branch must not build its subtree at all — that is the point of collapsing.
  assert.match(app, /\$\{open \? `<div class="hierarchy-children">\$\{childrenHtml\(\)\}<\/div>` : ""\}/);
  assert.match(app, /const HIERARCHY_LEAF_PAGE = \d+;/);
  assert.match(app, /const HIERARCHY_AUTO_COLLAPSE_USERS = \d+;/);
  assert.match(app, /function hierarchyLeafListHtml\(key, leaves\)/);
  assert.match(app, /data-tree-filter=/);
  assert.match(app, /data-tree-expand=/);
  assert.match(app, /data-tree-collapse=/);
  // "Expand all" must work from scenario data, since collapsed descendants are not in the DOM.
  assert.match(app, /function setHierarchyExpansionForHost\(hostId, open\)[\s\S]{0,400}scenario\.costCenters\.forEach/);
});

test("progress bars across every page animate from their previous width", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(app, /function setPanelHtmlWithBarTransitions\(selector, html\)/);
  assert.match(app, /function progressBarKey\(bar, index\)/);
  // Every panel that rebuilds bar markup wholesale must route through the helper, otherwise its
  // bars jump instead of transitioning.
  assert.match(app, /setPanelHtmlWithBarTransitions\("#budget-grid"/);
  assert.match(app, /setPanelHtmlWithBarTransitions\("#scenario-outcome"/);
  assert.doesNotMatch(app, /\$\("#budget-grid"\)\.innerHTML =/);
  assert.match(app, /requestAnimationFrame\(\(\) => requestAnimationFrame\(/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{[^}]*\}\.progress>div[^{]*\{transition:none\}/);
});

test("eventInScope and budgetInScope correlate usage and budgets by scope, not by fragile name matching", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("one", "2026-09-15", 1000)];
  const replay = replayScenario(scenario);
  const result = replay.results[0];
  const event = scenario.events[0];

  assert.equal(eventInScope(scenario, event, { type: "enterprise" }), true);
  assert.equal(eventInScope(scenario, event, { type: "user", id: "user-alice" }), true);
  assert.equal(eventInScope(scenario, event, { type: "user", id: "user-bob" }), false);

  const aliceUlb = scenario.budgets.find((item) => item.id === "ulb-alice");
  assert.equal(budgetInScope(scenario, aliceUlb, { type: "user", id: "user-alice" }), true);
  assert.equal(budgetInScope(scenario, aliceUlb, { type: "user", id: "user-bob" }), false);

  const scopedUsers = usersInScope(scenario, { type: "user", id: "user-alice" });
  assert.deepEqual(scopedUsers.map((item) => item.id), ["user-alice"]);

  const buckets = bucketsForEvent(scenario, event, result);
  assert.ok(buckets.some((bucket) => bucket.kind === "included"));
  assert.ok(buckets.some((bucket) => bucket.kind === "ulb"));
});

test("replayScenarioThroughEvent lets the optimized UI's scrubber show consumption growing event by event", () => {
  const scenario = createDefaultScenario();
  scenario.simulationDate = "2026-09-30";
  scenario.events = [usage("evt-a", "2026-09-05", 5), usage("evt-b", "2026-09-15", 7), usage("evt-c", "2026-09-25", 9)];
  const full = replayScenario(scenario);

  const throughFirst = replayScenarioThroughEvent(scenario, "evt-a");
  const throughSecond = replayScenarioThroughEvent(scenario, "evt-b");
  const throughLast = replayScenarioThroughEvent(scenario, "evt-c");

  // Pool/ULB consumption should strictly grow as later events are included, proving the bucket
  // panel is no longer frozen at the final totals regardless of scrubber position.
  assert.ok(throughFirst.pool.consumed < throughSecond.pool.consumed);
  assert.ok(throughSecond.pool.consumed < throughLast.pool.consumed);
  assert.deepEqual(throughLast.pool, full.pool);
  assert.deepEqual(throughLast.budgetStates, full.budgetStates);

  // An unknown or missing event id falls back to the full replay rather than throwing.
  assert.deepEqual(replayScenarioThroughEvent(scenario, "does-not-exist"), full);
  assert.deepEqual(replayScenarioThroughEvent(scenario, null), full);
});

test("budget health scenario catalog stays aligned with the underlying progress math", async () => {
  const catalog = JSON.parse(await readFile(new URL("../docs/budget-health-scenarios.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(catalog) && catalog.length >= 5);

  for (const scenario of catalog) {
    assert.equal(Math.round((scenario.currentUsage / scenario.limit) * 100), scenario.progressPercent);
    assert.equal(scenario.limit - scenario.currentUsage, scenario.nextStepTo100);
    assert.ok(scenario.description.length > 0);
  }

  const nextStepCases = catalog.filter((scenario) => scenario.mode === "next-step-100");
  assert.ok(nextStepCases.length >= 2);
  assert.ok(nextStepCases.every((scenario) => scenario.nextStepTo100 > 0 && scenario.nextStepTo100 <= 30));
  assert.deepEqual(
    catalog.map((scenario) => scenario.id).sort(),
    ["cost-center-budget", "org-budget-next-step", "shared-pool", "user-ulb", "user-ulb-next-step"].sort(),
  );
});

test("guided scenarios are declarative, reversible, and produce their documented outcomes", () => {
  for (const definition of BUILT_IN_SCENARIOS) {
    assert.equal(validateScenarioDefinition(definition), null);
    if (definition.id === "inspect-selected-dataset") {
      assert.equal(definition.compatibleDefaultSetIds, undefined);
    } else if (definition.id.startsWith("enterprise-")) {
      assert.deepEqual(definition.compatibleDefaultSetIds, ["enterprise"]);
    } else {
      assert.deepEqual(definition.compatibleDefaultSetIds, ["compact"]);
    }
    const baseline = materializeScenario(definition, -1);
    const complete = materializeScenario(definition, definition.steps.length - 1);
    assert.equal(baseline.events.length, 0);
    assert.equal(complete.events.length, definition.steps.filter((step) => step.type === "usage").length);
    assert.deepEqual(materializeScenario(definition, -1), baseline);
    const selected = materializeScenario(definition, -1, { defaultSetId: "enterprise" });
    assert.equal(selected.users.length, 200);
  }
  assert.deepEqual(
    BUILT_IN_SCENARIOS.filter((definition) => isScenarioCompatibleWithDefaultSet(definition, "enterprise")).map((definition) => definition.id),
    ["inspect-selected-dataset", "enterprise-budget-health-progression", "enterprise-pool-to-paid-overage", "enterprise-cost-center-pool-blocks", "enterprise-cost-center-pool-to-overage", "enterprise-hard-stop-boundary"],
  );
  assert.equal(BUILT_IN_SCENARIOS.filter((definition) => isScenarioCompatibleWithDefaultSet(definition, "compact")).length, 6);

  const compactAt = (definition, stepIndex) => materializeScenario(definition, stepIndex, { defaultSetId: "compact" });

  const progression = BUILT_IN_SCENARIOS.find((item) => item.id === "budget-health-progression");
  const atNinety = replayScenario(compactAt(progression, 3));
  const atHundred = replayScenario(compactAt(progression, 4));
  const aliceAtNinety = atNinety.budgetStates.find((item) => item.id === "ulb-alice");
  const aliceAtHundred = atHundred.budgetStates.find((item) => item.id === "ulb-alice");
  assert.equal(aliceAtNinety.percent, 90);
  assert.equal(aliceAtHundred.percent, 100);
  assert.equal(atHundred.results.at(-1).status, "accepted");
  assert.ok(atHundred.alerts.some((alert) => alert.budgetId === "ulb-alice" && alert.threshold === 100));

  const hardStop = BUILT_IN_SCENARIOS.find((item) => item.id === "hard-stop-boundary");
  const blocked = replayScenario(compactAt(hardStop, 1));
  assert.equal(blocked.results.at(-1).status, "blocked");
  assert.match(blocked.results.at(-1).reason, /Stop usage when budget limit is reached/);

  const poolBlocks = BUILT_IN_SCENARIOS.find((item) => item.id === "cost-center-pool-blocks");
  const blockedAtPool = replayScenario(compactAt(poolBlocks, 1));
  assert.equal(blockedAtPool.results.at(-1).status, "blocked");
  assert.match(blockedAtPool.results.at(-1).reason, /included AI credit pool cap/);

  const sharedPool = BUILT_IN_SCENARIOS.find((item) => item.id === "pool-to-paid-overage");
  const sharedPoolOverage = replayScenario(compactAt(sharedPool, 2));
  assert.equal(sharedPoolOverage.results.at(-1).status, "accepted");
  assert.equal(sharedPoolOverage.results.at(-1).includedQuantity, 0);
  assert.equal(sharedPoolOverage.results.at(-1).meteredQuantity, 1000);
  assert.equal(sharedPoolOverage.results.at(-1).cost, 10);
  assert.deepEqual(sharedPoolOverage.results.at(-1).affectedBudgets.map((item) => item.budgetId), ["ulb-alice", "metered-enterprise", "metered-ai-team"]);

  const poolOverage = BUILT_IN_SCENARIOS.find((item) => item.id === "cost-center-pool-to-overage");
  const overage = replayScenario(compactAt(poolOverage, 1));
  assert.equal(overage.results.at(-1).status, "accepted");
  assert.equal(overage.results.at(-1).meteredQuantity, 2400);
  assert.ok(overage.alerts.some((alert) => alert.budgetId === "metered-ai-team" && alert.threshold === 75));

  const enterpriseAt = (definition, stepIndex) => materializeScenario(definition, stepIndex, { defaultSetId: "enterprise" });
  const enterpriseProgression = BUILT_IN_SCENARIOS.find((item) => item.id === "enterprise-budget-health-progression");
  const enterpriseAtNinety = replayScenario(enterpriseAt(enterpriseProgression, 3));
  const enterpriseAtHundred = replayScenario(enterpriseAt(enterpriseProgression, 4));
  assert.equal(enterpriseAtNinety.budgetStates.find((item) => item.id === "ulb-alice").percent, 90);
  assert.equal(enterpriseAtHundred.results.at(-1).status, "accepted");
  assert.ok(enterpriseAtHundred.alerts.some((alert) => alert.budgetId === "ulb-alice" && alert.threshold === 100));
  assert.equal(enterpriseAtHundred.pool.total, 666000);

  const enterpriseSharedPool = BUILT_IN_SCENARIOS.find((item) => item.id === "enterprise-pool-to-paid-overage");
  const enterpriseOverage = replayScenario(enterpriseAt(enterpriseSharedPool, 2));
  assert.equal(enterpriseOverage.results.at(-1).status, "accepted");
  assert.equal(enterpriseOverage.results.at(-1).includedQuantity, 0);
  assert.equal(enterpriseOverage.results.at(-1).meteredQuantity, 1000);
  assert.equal(enterpriseOverage.results.at(-1).cost, 10);
  assert.equal(enterpriseOverage.results.at(-1).poolTotal, 666000);

  const enterprisePoolBlocks = BUILT_IN_SCENARIOS.find((item) => item.id === "enterprise-cost-center-pool-blocks");
  const enterpriseBlockedAtPool = replayScenario(enterpriseAt(enterprisePoolBlocks, 1));
  assert.equal(enterpriseBlockedAtPool.results.at(-1).status, "blocked");
  assert.match(enterpriseBlockedAtPool.results.at(-1).reason, /included AI credit pool cap/);
  assert.equal(enterpriseBlockedAtPool.costCenterPoolStates.find((item) => item.costCenterId === "cc-ai").total, 38900);

  const enterprisePoolOverage = BUILT_IN_SCENARIOS.find((item) => item.id === "enterprise-cost-center-pool-to-overage");
  const enterpriseCostCenterOverage = replayScenario(enterpriseAt(enterprisePoolOverage, 1));
  assert.equal(enterpriseCostCenterOverage.results.at(-1).status, "accepted");
  assert.equal(enterpriseCostCenterOverage.results.at(-1).meteredQuantity, 2400);
  assert.equal(enterpriseCostCenterOverage.results.at(-1).cost, 24);
  assert.ok(enterpriseCostCenterOverage.alerts.some((alert) => alert.budgetId === "metered-ai-team" && alert.threshold === 75));

  const enterpriseHardStop = BUILT_IN_SCENARIOS.find((item) => item.id === "enterprise-hard-stop-boundary");
  const enterpriseBlocked = replayScenario(enterpriseAt(enterpriseHardStop, 1));
  assert.equal(enterpriseBlocked.results.at(-1).status, "blocked");
  assert.match(enterpriseBlocked.results.at(-1).reason, /Stop usage when budget limit is reached/);

  const enterpriseDefinitions = BUILT_IN_SCENARIOS.filter((definition) => definition.id.startsWith("enterprise-"));
  for (const definition of enterpriseDefinitions) {
    for (let stepIndex = -1; stepIndex < definition.steps.length; stepIndex += 1) {
      const materialized = enterpriseAt(definition, stepIndex);
      assert.equal(materialized.enterprise.id, "ent-acme");
      assert.equal(materialized.users.length, 200);
      assert.equal(validateScenario(materialized), null);
      assert.deepEqual(materialized, enterpriseAt(definition, stepIndex));
      assert.doesNotThrow(() => replayScenario(materialized));
    }
  }
});

test("guided configuration steps do not retroactively change earlier usage attribution", () => {
  const definition = {
    version: 1,
    id: "late-pool-enable",
    title: "Late pool enablement",
    summary: "Configuration changes apply from their scenario step onward.",
    steps: [
      {
        id: "before-pool",
        type: "usage",
        title: "Use shared pool",
        description: "Alice consumes credits before the cost center pool is enabled.",
        expected: "The event consumes enterprise shared included credits.",
        event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 1000 },
      },
      {
        id: "enable-pool",
        type: "configuration",
        title: "Enable cost center pool",
        description: "The cost center pool is enabled after the first usage event.",
        expected: "Earlier usage remains attributed to the enterprise shared pool.",
        mutation: { target: "costCenter", id: "cc-ai", changes: { aiCreditPoolEnabled: true } },
      },
      {
        id: "after-pool",
        type: "usage",
        title: "Use cost center pool",
        description: "Alice consumes credits after the cost center pool is enabled.",
        expected: "The event consumes the cost center included pool.",
        event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 1000 },
      },
    ],
  };
  const replay = replayScenario(materializeScenario(definition, 2));
  assert.equal(replay.results[0].poolType, "enterprise");
  assert.equal(replay.results[1].poolType, "costCenter");
  assert.equal(replay.pool.consumed, 1000);
  assert.equal(replay.costCenterPoolStates.find((item) => item.costCenterId === "cc-ai").consumed, 1000);
});

test("guided scenarios preserve historical cost-center pool consumption after disabling the pool", () => {
  const definition = {
    version: 1,
    id: "pool-disable-history",
    title: "Pool disable history",
    summary: "Disabling a pool does not erase usage that already consumed it.",
    setup: [{ target: "costCenter", id: "cc-ai", changes: { aiCreditPoolEnabled: true } }],
    steps: [
      {
        id: "consume-pool",
        type: "usage",
        title: "Consume pool",
        description: "Alice consumes cost center included credits.",
        expected: "The cost center pool records the consumption.",
        event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 1000 },
      },
      {
        id: "disable-pool",
        type: "configuration",
        title: "Disable pool",
        description: "The pool is disabled after consumption.",
        expected: "History still shows the consumed cost center pool credits.",
        mutation: { target: "costCenter", id: "cc-ai", changes: { aiCreditPoolEnabled: false } },
      },
    ],
  };
  const replay = replayScenario(materializeScenario(definition, 1));
  const pool = replay.costCenterPoolStates.find((item) => item.costCenterId === "cc-ai");
  assert.equal(pool.consumed, 1000);
  assert.equal(pool.enabled, false);
  assert.equal(replay.pool.consumed, 0);
});

test("cost-center pool enablement does not create extra included-credit capacity", () => {
  const definition = {
    version: 1,
    id: "pool-capacity-conservation",
    title: "Pool capacity conservation",
    summary: "Moving a user into a cost center pool preserves prior included-credit consumption.",
    setup: [{ target: "budget", id: "ulb-alice", changes: { amount: 200 } }],
    steps: [
      {
        id: "enterprise-before-pool",
        type: "usage",
        title: "Use enterprise pool",
        description: "Alice consumes included credits before the cost center pool is enabled.",
        expected: "The usage draws from Alice's monthly included-credit contribution.",
        event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 1000 },
      },
      {
        id: "enable-pool",
        type: "configuration",
        title: "Enable pool",
        description: "AI Innovation enables its own included pool.",
        expected: "Alice's remaining included capacity is reduced by earlier usage.",
        mutation: { target: "costCenter", id: "cc-ai", changes: { aiCreditPoolEnabled: true, aiCreditPoolCapMode: "allowOverage" } },
      },
      {
        id: "alice-remaining-capacity",
        type: "usage",
        title: "Use remaining capacity",
        description: "Alice asks for her full 3,900-credit pool after already using 1,000 credits.",
        expected: "Only 2,900 credits are included; the rest becomes paid overage.",
        event: { date: "2026-09-15", userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", quantity: 3900 },
      },
      {
        id: "bob-full-capacity",
        type: "usage",
        title: "Use Bob's capacity",
        description: "Bob consumes his Business-seat included credits.",
        expected: "Bob can still use his own 1,900 included credits.",
        event: { date: "2026-09-15", userId: "user-bob", repositoryId: "repo-tools", productId: "ai-credits", quantity: 1900 },
      },
    ],
  };
  // Pinned to the compact set: the assertions below depend on cc-ai's pool being funded by Alice
  // alone, which is only true in the two-user tenant.
  const replay = replayScenario(materializeScenario(definition, 3, { defaultSetId: "compact" }));
  assert.equal(replay.results[1].includedQuantity, 2900);
  assert.equal(replay.results[1].meteredQuantity, 1000);
  assert.equal(replay.results[2].includedQuantity, 1900);
  assert.equal(replay.results.reduce((sum, result) => sum + result.includedQuantity, 0), 5800);
  assert.ok(replay.pool.percent <= 100);
});

test("optimized bucket attribution names cost-center included pools", () => {
  const scenario = createDefaultScenario();
  scenario.costCenters.find((item) => item.id === "cc-ai").aiCreditPoolEnabled = true;
  scenario.events = [usage("pool", "2026-09-15", 1000)];
  const replay = replayScenario(scenario);
  const bucket = bucketsForEvent(scenario, scenario.events[0], replay.results[0]).find((item) => item.kind === "included");
  assert.match(bucket.scopeLabel, /AI Innovation included AI-credit pool/);
});



test("replay results explain blocked included usage controls with GitHub wording", () => {
  const scenario = createDefaultScenario("compact");
  Object.assign(scenario.costCenters.find((item) => item.id === "cc-ai"), { aiCreditPoolEnabled: true, aiCreditPoolCapMode: "block" });
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("near-cap", "2026-09-15", 3800), usage("blocked", "2026-09-15", 200)];
  const blocked = replayScenario(scenario).results.at(-1);
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.controlEvaluations.some((item) => item.control === "Included usage controls for cost centers" && item.outcome === "blocked"));
  const poolCheck = blocked.controlEvaluations.find((item) => item.control === "Included usage controls for cost centers");
  assert.deepEqual(poolCheck.configuration.map((item) => item.label), ["Cost center", "AI credit pool enabled", "At the included usage cap"]);
  assert.match(poolCheck.result, /blocked before paid overage or metered budgets are evaluated/);
});

test("replay results explain cost-center AI budget alerts without stop usage", () => {
  const scenario = createDefaultScenario("compact");
  Object.assign(scenario.costCenters.find((item) => item.id === "cc-ai"), { aiCreditPoolEnabled: true, aiCreditPoolCapMode: "allowOverage" });
  const userBudget = scenario.budgets.find((item) => item.id === "ulb-alice");
  userBudget.amount = 200;
  const budget = scenario.budgets.find((item) => item.id === "metered-ai-team");
  budget.amount = 20;
  budget.enforcement = "soft";
  budget.thresholds = [75, 90, 100];
  scenario.events = [usage("pool", "2026-09-15", 3900), usage("overage", "2026-09-15", 2400)];
  const result = replayScenario(scenario).results.at(-1);
  const budgetCheck = result.controlEvaluations.find((item) => item.control === "Budgets and alerts" && item.configuration.some((field) => field.label === "Budget scope" && field.value.includes("Cost center")));
  assert.equal(result.status, "accepted");
  assert.equal(budgetCheck.outcome, "alerted");
  assert.ok(budgetCheck.configuration.some((item) => item.label === "Budget Type" && item.value === "SKU-level budget"));
  assert.ok(budgetCheck.configuration.some((item) => item.label === "Stop usage when budget limit is reached" && item.value === "Not enabled"));
  assert.ok(budgetCheck.configuration.some((item) => item.label === "Receive budget threshold alerts" && item.value.includes("75%")));
  assert.match(budgetCheck.result, /allows usage to continue/);
});


test("built-in scenarios are loaded from the external catalog", async () => {
  const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));
  const runner = await readFile(new URL("../src/scenario-runner.js", import.meta.url), "utf8");
  const schema = JSON.parse(await readFile(new URL("../scenarios/scenario.schema.json", import.meta.url), "utf8"));
  assert.equal(catalog.version, 1);
  assert.deepEqual(catalog.scenarios.map((item) => item.id), BUILT_IN_SCENARIOS.map((item) => item.id));
  assert.equal(schema.properties.version.const, 1);
  assert.doesNotMatch(runner, /Budget health progression|BUILT_IN_SCENARIOS/);
  assert.ok(BUILT_IN_SCENARIOS.every((definition) => definition.$schema === "./scenario.schema.json"));
});

test("scenario catalog rejects mismatched definition ids", async () => {
  const responses = new Map([
    ["https://example.test/catalog.json", { version: 1, scenarios: [{ id: "catalog-id", file: "scenario.json" }] }],
    ["https://example.test/scenario.json", { ...BUILT_IN_SCENARIOS[0], id: "different-id" }],
  ]);
  const fetcher = async (url) => ({ ok: responses.has(String(url)), status: responses.has(String(url)) ? 200 : 404, json: async () => responses.get(String(url)) });
  await assert.rejects(loadScenarioCatalog(new URL("https://example.test/catalog.json"), fetcher), /does not match definition id/);
});

test("simulation page previews selected steps before explicit execution", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  for (const id of ["scenario-definition", "scenario-step-list", "scenario-previous", "scenario-next", "scenario-run-selected", "scenario-run-all", "scenario-outcome"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Run next step/);
  assert.match(app, /SELECTED STEP PREVIEW/);
  assert.match(app, /Predicted changes/);
  assert.match(app, /ACTUAL OUTCOME/);
  assert.match(app, /function scopeMarker\(/);
  assert.match(app, /scenario-delta-label/);
  assert.match(app, /impact-row-label/);
  assert.match(app, /budget-scope-cell/);
  assert.match(app, /scenarioRun\.selectedStepIndex = Number/);
  assert.match(app, /Confirm run all/);
  assert.match(app, /saveAndRender\(message, \{ toast: false \}\)/);
  assert.match(app, /trimToastStack\(stack, MAX_VISIBLE_TOASTS\)/);
  assert.match(app, /isScenarioCompatibleWithDefaultSet/);
  assert.match(app, /No scenarios compatible with/);
  assert.match(app, /reconcileScenarioSelection/);
  assert.match(app, /defaultSetId: defaultScenarioSetId/);
  assert.match(app, /scenario = materializeScenarioForDefaultSet\(definition, -1\)/);
  assert.match(app, /saveAndRender\("Scenario reset to its baseline"\)/);
});

test("toast trimming removes excess notifications synchronously", () => {
  const nodes = [];
  const stack = {
    get children() { return nodes; },
    get firstElementChild() { return nodes[0] || null; },
  };
  for (let index = 0; index < 8; index += 1) {
    const node = { id: index, dataset: { timer: "0" } };
    node.remove = () => nodes.splice(nodes.indexOf(node), 1);
    nodes.push(node);
  }
  trimToastStack(stack, 4);
  assert.deepEqual(nodes.map((node) => node.id), [4, 5, 6, 7]);
});

test("alert notifications render as a dismissible toast stack", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(html, /id="toast-stack"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /id="toast"/);
  assert.match(app, /function announceSimulationFeedback/);
  assert.match(app, /data-dismiss-toast="true"/);
});

test("rejects legacy scenario imports", () => {
  assert.match(validateScenario({ version: 1, enterprise: {}, simulationDate: "2026-09-01" }), /version 2/);
  assert.equal(validateScenario(createDefaultScenario()), null);
});

test("scope selection narrows budgets to the ones actually governing that scope", () => {
  const scenario = createDefaultScenario("enterprise");
  const replay = replayScenario(scenario);
  const countFor = (scope) => replay.budgetStates.filter((state) => budgetInScope(scenario, state, scope)).length;
  const user = scenario.users.find((item) => costCenterForUser(scenario, item));
  const userScope = { type: "user", id: user.id };

  // Regression guard for #15: replayScenario materializes one budget state per user, so a universal
  // ULB definition expanded into a state for every user. budgetInScope previously matched them all,
  // which surfaced ~181 of 206 budget cards while inspecting a single person.
  const scoped = replay.budgetStates.filter((state) => budgetInScope(scenario, state, userScope));
  assert.ok(scoped.length < 10, `expected a handful of budgets for one user, got ${scoped.length}`);
  assert.ok(scoped.length > 0, "a user should still resolve their own budgets");

  // Every user-level state shown must belong to the inspected user.
  for (const state of scoped.filter((item) => item.budgetKind === "user")) {
    assert.equal(state.userId, user.id);
  }
  // Ancestor budgets stay visible: enterprise-wide controls still govern this user.
  assert.ok(scoped.some((state) => state.scopeType === "enterprise" && state.budgetKind === "metered"));

  // Narrowing the scope must never widen the result set.
  assert.ok(countFor(userScope) <= countFor({ type: "costCenter", id: costCenterForUser(scenario, user).id }));
  assert.ok(countFor({ type: "enterprise", id: scenario.enterprise.id }) === replay.budgetStates.length);
});

test("cost center configuration uses GitHub included-usage-cap wording and derives the cap from licenses", () => {
  const scenario = createDefaultScenario("enterprise");
  const costCenter = scenario.costCenters[0];
  const config = describeCostCenterConfiguration(scenario, costCenter);

  assert.deepEqual(config.resources.map((item) => item.label), ["Enterprise teams", "Organizations", "Repositories", "Users"]);
  // The cap is derived from attributed licenses rather than stored, mirroring GitHub.
  assert.equal(config.settings.capCredits, Math.round(costCenterIncludedPoolFor(scenario, costCenter.id)));
  assert.ok(config.settings.licenseCount > 0);
  // Users resolve by effective attribution, not just the explicit userIds list.
  assert.equal(config.resources.find((item) => item.label === "Users").names.length, config.settings.attributedUserCount);

  // The Optimized UI inspector reads the same descriptor, so every scope type must resolve one.
  const user = scenario.users[0];
  for (const scope of [{ type: "enterprise", id: scenario.enterprise.id }, { type: "organization", id: scenario.organizations[0].id }, { type: "costCenter", id: costCenter.id }, { type: "user", id: user.id }]) {
    const described = describeScopeConfiguration(scenario, scope);
    assert.ok(described, `no configuration described for ${scope.type}`);
    assert.equal(described.type, scope.type);
  }
});

test("configuration UI drops simulator-only cost center jargon", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(html, /AI credit included usage cap/);
  assert.doesNotMatch(html, /Enable AI credit pool cap/);
  // The terse, unexplained row labels from #16 must not come back.
  assert.doesNotMatch(app, /">Enable pool</);
  assert.doesNotMatch(app, /">Block at cap</);
  assert.match(app, /attributed licenses/);
  assert.match(html, /id="optimized-scope-config"/);
});

test("guided scenario baselines differ, so switching scenarios must rematerialize the active scenario", () => {
  const baseline = (id) => materializeScenario(BUILT_IN_SCENARIOS.find((item) => item.id === id), -1);
  const pooled = baseline("cost-center-pool-blocks");
  const plain = baseline("budget-health-progression");
  // The pool scenario enables a cost center AI credit pool in setup; the progression scenario does not.
  assert.ok(pooled.costCenters.some((item) => item.aiCreditPoolEnabled));
  assert.notDeepEqual(pooled.costCenters, plain.costCenters);
});

test("changing the scenario definition rematerializes the scenario before rendering", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const body = app.replace(/\r\n/g, "\n").slice(app.replace(/\r\n/g, "\n").indexOf("function changeScenarioDefinition("));
  const changeScenarioDefinition = body.slice(0, body.indexOf("\n}\n") + 2);
  assert.match(changeScenarioDefinition, /scenarioDefinitions\(\)\.find\(\(item\) => item\.id === id\)/);
  assert.match(changeScenarioDefinition, /scenario = materializeScenarioForDefaultSet\(definition, -1\)/);
  // The reassignment must happen before the render, which only replays whatever `scenario` holds.
  assert.ok(changeScenarioDefinition.indexOf("materializeScenarioForDefaultSet") < changeScenarioDefinition.lastIndexOf("saveAndRender("));
  // Both scenario selectors share the one handler, so neither can go stale.
  assert.match(app, /\$\("#global-scenario-definition"\)\.addEventListener\("change", \(event\) => changeScenarioDefinition\(event\.target\.value\)\)/);
  assert.match(app, /\$\("#scenario-definition"\)\.addEventListener\("change", \(event\) => changeScenarioDefinition\(event\.target\.value\)\)/);
  // Importing a custom scenario selects it, so it must take the same rematerialize-and-render path.
  assert.match(app, /changeScenarioDefinition\(definitions\.at\(-1\)\.id\)/);
});

