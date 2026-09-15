import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultScenario, replayScenario, validateScenario } from "../src/engine.js";

function usage(id, date, quantity, overrides = {}) {
  return { id, date, quantity, userId: "user-alice", repositoryId: "repo-portal", productId: "ai-credits", ...overrides };
}

test("AI credits use the shared included pool before creating spend", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("one", "2026-09-15", 1000)];
  const replay = replayScenario(scenario);
  assert.equal(replay.pool.total, 5800);
  assert.equal(replay.pool.consumed, 1000);
  assert.equal(replay.results[0].includedQuantity, 1000);
  assert.equal(replay.results[0].meteredQuantity, 0);
  assert.equal(replay.results[0].cost, 0);
  assert.deepEqual(replay.results[0].affectedBudgets.map((item) => item.budgetId), ["ulb-alice", "metered-enterprise", "metered-ai-team"]);
});

test("individual ULB overrides cost-center and universal ULBs", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("one", "2026-09-15", 4000)];
  const replay = replayScenario(scenario);
  const alice = replay.budgetStates.find((item) => item.userId === "user-alice");
  const bob = replay.budgetStates.find((item) => item.userId === "user-bob");
  assert.equal(alice.id, "ulb-alice");
  assert.equal(alice.spent, 40);
  assert.equal(bob.id, "ulb-universal");
});

test("ULB counts total consumption and always blocks even while pool remains", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 10;
  scenario.events = [usage("blocked", "2026-09-15", 1001)];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].status, "blocked");
  assert.match(replay.results[0].reason, /user-level hard stop/);
  assert.equal(replay.pool.consumed, 0);
});

test("enterprise and cost-center budgets count only metered overage", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("over", "2026-09-15", 6000)];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].includedQuantity, 5800);
  assert.equal(replay.results[0].meteredQuantity, 200);
  assert.equal(replay.results[0].cost, 2);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-enterprise").spent, 2);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 2);
});

test("cost-center exclusion removes its AI usage from the enterprise budget", () => {
  const scenario = createDefaultScenario();
  scenario.costCenters.find((item) => item.id === "cc-ai").excludeFromEnterpriseBudget = true;
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("over", "2026-09-15", 6000)];
  const replay = replayScenario(scenario);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-enterprise").spent, 0);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 2);
});

test("organization AI budget applies only when no cost center is assigned", () => {
  const scenario = createDefaultScenario();
  scenario.users.find((item) => item.id === "user-alice").costCenterId = null;
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("over", "2026-09-15", 6000)];
  const replay = replayScenario(scenario);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-product-org").spent, 2);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 0);
});

test("paid usage policy blocks overage regardless of budget headroom", () => {
  const scenario = createDefaultScenario();
  scenario.enterprise.paidAiUsage = false;
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("over", "2026-09-15", 6000)];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].status, "blocked");
  assert.match(replay.results[0].reason, /paid usage policy is disabled/);
});

test("metered hard budget blocks overage but not included consumption", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.budgets.find((item) => item.id === "metered-ai-team").amount = 1;
  scenario.events = [usage("over", "2026-09-15", 6000)];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].status, "blocked");
  assert.match(replay.results[0].reason, /metered-spend hard stop/);
});

test("a mid-month budget ignores usage before its effective date", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("pool", "2026-09-05", 5800), usage("before", "2026-09-09", 100), usage("after", "2026-09-12", 100)];
  const replay = replayScenario(scenario);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 1);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-enterprise").spent, 2);
});

test("monthly pool and counters reset while history remains", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("sep", "2026-09-15", 1000), usage("oct", "2026-10-02", 2000)];
  scenario.simulationDate = "2026-10-02";
  const replay = replayScenario(scenario);
  assert.equal(replay.results.length, 2);
  assert.equal(replay.pool.consumed, 2000);
});

test("future events remain scheduled until the clock advances", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("future", "2026-10-02", 100)];
  assert.equal(replayScenario(scenario).results.length, 0);
  scenario.simulationDate = "2026-10-02";
  assert.equal(replayScenario(scenario).results.length, 1);
});

test("rejects legacy scenario imports", () => {
  assert.match(validateScenario({ version: 1, enterprise: {}, simulationDate: "2026-09-01" }), /version 2/);
  assert.equal(validateScenario(createDefaultScenario()), null);
});
