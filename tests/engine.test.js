import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { budgetInScope, bucketsForEvent, costCenterForUser, costCenterIncludedPoolFor, describeCostCenterConfiguration, describeScopeConfiguration, createDefaultScenario, defaultScenarioSetOptions, eventInScope, isSeatActiveForDate, percent, replayScenario, replayScenarioThroughEvent, seatChargeForPeriod, userPoolContribution, usersInScope, validateScenario } from "../src/engine.js";
import { materializeScenario, validateScenarioDefinition } from "../src/scenario-runner.js";
import { loadScenarioCatalog } from "../src/scenario-catalog.js";
import { registerEnvironment, validateMaterializedScenario, validateEnvironment } from "../src/environment.js";
import { trimToastStack } from "../src/toast-stack.js";

async function fileFetch(url) {
  try {
    const content = await readFile(url, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(content) };
  } catch {
    return { ok: false, status: 404, json: async () => null };
  }
}

const BUILT_IN_SCENARIOS = await loadScenarioCatalog(new URL("../scenarios/catalog.json", import.meta.url), fileFetch);

function compactWalkthroughOutcome(definition, stepIndex) {
  const step = definition.steps[stepIndex];
  const replay = replayScenario(materializeScenario(definition, stepIndex));
  const eventId = step.type === "usage" ? `scenario-${definition.id}-${step.id}` : null;
  const result = eventId ? replay.results.find((item) => item.eventId === eventId) : null;
  const fixed = (value) => Number(Number(value).toFixed(2));
  return {
    stepId: step.id,
    eventId,
    status: result?.status || null,
    reasonIncludes: result?.status === "blocked"
      ? result.reason.includes("paid usage is disabled") ? "paid usage is disabled"
        : result.reason.includes("Stop usage when budget limit is reached") ? "Stop usage when budget limit is reached"
          : result.reason
      : null,
    includedQuantity: result ? fixed(result.includedQuantity) : null,
    meteredQuantity: result ? fixed(result.meteredQuantity) : null,
    cost: result ? fixed(result.cost) : null,
    affectedBudgets: result?.affectedBudgets.map((item) => ({
      budgetId: item.budgetId,
      stateKey: item.stateKey,
      before: fixed(item.before),
      after: fixed(item.after),
    })) || [],
    alerts: eventId
      ? replay.alerts.filter((alert) => alert.eventId === eventId).map((alert) => ({
        budgetId: alert.budgetId,
        stateKey: alert.stateKey,
        threshold: alert.threshold,
        reliability: alert.reliability,
      }))
      : [],
    pool: {
      stateId: replay.pool.stateId,
      total: fixed(replay.pool.total),
      consumed: fixed(replay.pool.consumed),
    },
  };
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function cpuMilliseconds(action) {
  const started = process.cpuUsage();
  action();
  const elapsed = process.cpuUsage(started);
  return (elapsed.user + elapsed.system) / 1000;
}

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
    seed: [usage("seed", "2026-09-02", 100)],
    steps: [{ id: "step", type: "usage", title: "Use credits", description: "Consumes more credits.", expected: "Both events are replayed.", event: usage("step-event", "2026-09-03", 200) }],
  };
  const materialized = materializeScenario(definition, 0);
  assert.equal(materialized.events.length, 2);
  assert.deepEqual(materialized.events.map((event) => event.id), ["seed", "scenario-seed-smoke-scenario-step"]);
  assert.equal(replayScenario(materialized).pool.consumed, 300);
});

test("enterprise-251 environment pins the reviewed scale and topology shape", async () => {
  const environment = JSON.parse(await readFile(new URL("../scenarios/environments/enterprise-251.json", import.meta.url), "utf8"));
  assert.equal(validateEnvironment(environment), null);
  assert.equal(environment.users.length, 251);
  assert.equal(environment.users.filter((user) => user.licensePlan === "business").length, 160);
  assert.equal(environment.users.filter((user) => user.licensePlan === "enterprise").length, 91);
  assert.equal(environment.organizations.length, 10);
  assert.equal(environment.costCenters.length, 20);
  assert.ok(environment.budgets.length >= 13);
  assert.equal(new Set(environment.users.map((user) => user.id)).size, 251);

  const organizationCounts = environment.organizations.map((organization) =>
    environment.users.filter((user) => user.licenseOrganizationId === organization.id).length);
  assert.equal(Math.min(...organizationCounts), 10);
  assert.equal(Math.max(...organizationCounts), 48);
  assert.ok(organizationCounts.some((count) => count >= 40));

  const mappedCostCenters = environment.costCenters.filter((costCenter) => costCenter.organizationIds.length > 1);
  assert.ok(mappedCostCenters.length >= 3);
  const mappedOrganizations = mappedCostCenters.flatMap((costCenter) => costCenter.organizationIds);
  assert.equal(new Set(mappedOrganizations).size, mappedOrganizations.length);
  assert.ok(environment.costCenters.some((costCenter) => costCenter.excludeFromEnterpriseBudget));
  assert.ok(environment.costCenters.some((costCenter) => !costCenter.excludeFromEnterpriseBudget));

  const allMappedOrganizations = new Set(environment.costCenters.flatMap((costCenter) => costCenter.organizationIds));
  const unattributedUsers = environment.users.filter((user) =>
    !user.costCenterId && !allMappedOrganizations.has(user.licenseOrganizationId));
  assert.ok(unattributedUsers.length >= 5);
  assert.ok(environment.organizations.some((item) => item.name.length >= 60));
  assert.ok(environment.costCenters.some((item) => item.name.length >= 60));
  assert.ok(environment.repositories.some((item) => item.name.length >= 60));
  assert.ok(environment.users.some((item) => item.name.length >= 60));
  assert.ok(environment.organizations.some((item) => item.name === "Platform Engineering"));
  assert.ok(environment.organizations.some((item) => item.name.startsWith("Platform Engineering - EU")));
  assert.ok(environment.costCenters.some((item) => item.name.startsWith("Transformation programme")));
  assert.ok(environment.costCenters.some((item) =>
    environment.users.filter((user) => user.costCenterId === item.id).length <= 2));

  const budgetScopes = new Set(environment.budgets.map((budget) => budget.scopeType));
  assert.ok(["enterprise", "organization", "costCenter", "user"].every((scope) => budgetScopes.has(scope)));
  assert.ok(environment.budgets.filter((budget) => budget.effectiveFrom > "2026-09-01").length >= 2);
  assert.ok(environment.budgets.filter((budget) => budget.budgetKind === "metered" && budget.enforcement === "hard").length >= 2);
  assert.ok(environment.budgets.filter((budget) => budget.budgetKind === "user").every((budget) => budget.enforcement === "hard"));

  const joiner = environment.users.find((user) => user.id === "user-joiner");
  const leaver = environment.users.find((user) => user.id === "user-leaver");
  const revoked = environment.users.find((user) => user.id === "user-contract-001");
  assert.equal(Number(seatChargeForPeriod(joiner, "2026-09-15").toFixed(2)), 10.13);
  assert.equal(Number(userPoolContribution(joiner, "2026-09-15", { enterprise: { seatCreditPolicy: "prorated" } }).toFixed(2)), 1013.33);
  assert.equal(isSeatActiveForDate(leaver, "2026-09-30"), true);
  assert.equal(isSeatActiveForDate(leaver, "2026-10-01"), false);
  assert.equal(isSeatActiveForDate(revoked, "2026-09-26"), false);
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
  assert.equal(replay.results[0].status, "blocked");
  assert.match(replay.results[0].reason, /Stop usage when budget limit is reached/);
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
  assert.match(app, /data-history-id="pool"/);
  assert.match(app, /data-history-id="\$\{escapeHtml\(budget\.stateId\)\}"/);
  assert.match(app, /money, normalizeScenario, percent, replayScenario/);
  for (const callSite of ["percent(replay.pool.percent)", "percent(pool.percent)", "percent(budget.percent)", "percent(budgetState.percent)", "percent(item.percent)", "percent(impact.percent)"]) {
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
    const baseline = materializeScenario(definition, -1);
    const complete = materializeScenario(definition, definition.steps.length - 1);
    assert.equal(baseline.events.length, (definition.seed || []).length);
    assert.equal(complete.events.length, (definition.seed || []).length + definition.steps.filter((step) => step.type === "usage").length);
    assert.deepEqual(materializeScenario(definition, -1), baseline);
  }

  // Outcome assertions below reference the user-alice / cc-ai fixtures and the credit arithmetic of
  // the two-user tenant, so they pin the compact set rather than the enterprise default.
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

  const poolOverage = BUILT_IN_SCENARIOS.find((item) => item.id === "cost-center-pool-to-overage");
  const overage = replayScenario(compactAt(poolOverage, 1));
  assert.equal(overage.results.at(-1).status, "accepted");
  assert.equal(overage.results.at(-1).meteredQuantity, 2400);
  assert.ok(overage.alerts.some((alert) => alert.budgetId === "metered-ai-team" && alert.threshold === 75));
});

test("enterprise-251 walkthrough matches its compact golden outcomes", async () => {
  const definition = BUILT_IN_SCENARIOS.find((item) => item.id === "enterprise-251-walkthrough");
  const golden = JSON.parse(await readFile(new URL("../docs/enterprise-251-walkthrough.golden.json", import.meta.url), "utf8"));
  assert.equal(definition.version, 1);
  assert.equal(definition.environmentId, "enterprise-251");
  assert.equal(definition.steps.length, 13);
  assert.equal(golden.scenarioId, definition.id);
  assert.deepEqual(
    definition.steps.map((step, index) => compactWalkthroughOutcome(definition, index)),
    golden.steps,
  );

  const baseline = replayScenario(materializeScenario(definition, -1));
  assert.equal(baseline.pool.total, 658900);
  assert.equal(baseline.pool.consumed, 646500);
  assert.equal(baseline.pool.remaining, 12400);
  assert.equal(baseline.results.every((result) => result.status === "accepted" && result.meteredQuantity === 0), true);
  assert.equal(baseline.budgetStates.filter((state) => state.budgetKind === "metered").every((state) => state.spent === 0), true);

  const thresholdReplay = replayScenario(materializeScenario(definition, 2));
  const thresholdAlerts = thresholdReplay.alerts.filter((alert) => alert.eventId === "scenario-enterprise-251-walkthrough-threshold-alerts");
  assert.deepEqual(thresholdAlerts.map((alert) => [alert.stateKey, alert.threshold, alert.reliability]), [
    ["ulb-normal:user-normal:2026-09", 75, "User-level alert delivery is not guaranteed by GitHub"],
    ["metered-cc-normal:2026-09", 100, "UI and email"],
    ["metered-enterprise:2026-09", 90, "UI and email"],
  ]);

  const beforeHardStop = replayScenario(materializeScenario(definition, 4));
  const atHardStop = replayScenario(materializeScenario(definition, 5));
  assert.equal(atHardStop.results.at(-1).status, "blocked");
  assert.deepEqual(atHardStop.pool, beforeHardStop.pool);
  assert.deepEqual(atHardStop.budgetStates, beforeHardStop.budgetStates);

  const afterBoundary = replayScenario(materializeScenario(definition, 1));
  const boundaryResult = afterBoundary.results.find((result) => result.eventId === "scenario-enterprise-251-walkthrough-pool-exhaustion");
  assert.equal(boundaryResult.affectedBudgets.find((item) => item.budgetId === "ulb-individual").after
    - boundaryResult.affectedBudgets.find((item) => item.budgetId === "ulb-individual").before, 200);
  assert.equal(boundaryResult.affectedBudgets.find((item) => item.budgetId === "metered-enterprise").after
    - boundaryResult.affectedBudgets.find((item) => item.budgetId === "metered-enterprise").before, 76);

  const precedence = replayScenario(materializeScenario(definition, 7));
  const individual = precedence.results.find((result) => result.eventId === "scenario-enterprise-251-walkthrough-pool-exhaustion");
  const costCenter = precedence.results.find((result) => result.eventId === "scenario-enterprise-251-walkthrough-threshold-alerts");
  const universal = precedence.results.find((result) => result.eventId === "scenario-enterprise-251-walkthrough-ulb-precedence");
  assert.deepEqual(individual.affectedBudgets.filter((item) => item.budgetId.startsWith("ulb-")).map((item) => item.budgetId), ["ulb-individual"]);
  assert.deepEqual(costCenter.affectedBudgets.filter((item) => item.budgetId.startsWith("ulb-")).map((item) => item.budgetId), ["ulb-normal"]);
  assert.deepEqual(universal.affectedBudgets.filter((item) => item.budgetId.startsWith("ulb-")).map((item) => item.budgetId), ["ulb-universal"]);

  const direct = replayScenario(materializeScenario(definition, 8)).results.at(-1);
  assert.ok(direct.affectedBudgets.some((item) => item.budgetId === "metered-cc-product"));
  assert.ok(!direct.affectedBudgets.some((item) => item.budgetId === "metered-cc-central"));

  const unattributed = replayScenario(materializeScenario(definition, 4)).results.at(-1);
  assert.ok(unattributed.affectedBudgets.some((item) => item.budgetId === "metered-org-vendors"));
  assert.ok(!unattributed.affectedBudgets.some((item) => item.budgetId.startsWith("metered-cc-")));

  const normal = replayScenario(materializeScenario(definition, 3)).results.find((result) => result.eventId === "scenario-enterprise-251-walkthrough-threshold-alerts");
  const excluded = replayScenario(materializeScenario(definition, 9)).results.at(-1);
  assert.ok(normal.affectedBudgets.some((item) => item.budgetId === "metered-enterprise"));
  assert.ok(!excluded.affectedBudgets.some((item) => item.budgetId === "metered-enterprise"));

  const beforePolicyBlock = replayScenario(materializeScenario(definition, 10));
  const atPolicyBlock = replayScenario(materializeScenario(definition, 11));
  assert.equal(atPolicyBlock.results.at(-1).status, "blocked");
  assert.match(atPolicyBlock.results.at(-1).reason, /paid usage is disabled/);
  assert.deepEqual(atPolicyBlock.pool, beforePolicyBlock.pool);
  assert.deepEqual(atPolicyBlock.budgetStates, beforePolicyBlock.budgetStates);

  const october = replayScenario(materializeScenario(definition, 12));
  assert.equal(october.period, "2026-10");
  assert.equal(october.pool.stateId, "enterprise:2026-10");
  assert.equal(october.pool.consumed, 4581);
  assert.ok(october.results.some((result) => result.date.startsWith("2026-09")));
  assert.ok(october.alerts.some((alert) =>
    alert.stateKey === "ulb-normal:user-normal:2026-10" && alert.threshold === 75));
  assert.deepEqual(materializeScenario(definition, 12), materializeScenario(definition, 12));
});

test("enterprise-251 walkthrough remains within the replay performance budget", () => {
  const definition = BUILT_IN_SCENARIOS.find((item) => item.id === "enterprise-251-walkthrough");
  const finalIndex = definition.steps.length - 1;
  const singlePass = [];
  const fourPass = [];
  for (let iteration = 0; iteration < 40; iteration += 1) {
    singlePass.push(cpuMilliseconds(() => replayScenario(materializeScenario(definition, finalIndex))));
    fourPass.push(cpuMilliseconds(() => {
      replayScenario(materializeScenario(definition, finalIndex));
      replayScenario(materializeScenario(definition, finalIndex - 1));
      replayScenario(materializeScenario(definition, finalIndex - 2));
      replayScenario(materializeScenario(definition, finalIndex));
    }));
  }
  assert.ok(percentile95(singlePass) < 50, `single-pass p95 was ${percentile95(singlePass).toFixed(2)} ms`);
  assert.ok(percentile95(fourPass) < 100, `four-pass p95 was ${percentile95(fourPass).toFixed(2)} ms`);
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
