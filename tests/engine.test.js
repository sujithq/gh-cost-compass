import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultScenario, replayScenario, validateScenario } from "../src/engine.js";

function usage(id, date, quantity, overrides = {}) {
  return { id, date, quantity, userId: "user-alice", repositoryId: "repo-portal", productId: "aic", ...overrides };
}

test("attributes usage to all applicable budget scopes", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("one", "2026-09-15", 100)];
  const replay = replayScenario(scenario);
  const result = replay.results[0];
  assert.equal(result.status, "accepted");
  assert.equal(result.cost, 10);
  assert.deepEqual(new Set(result.affectedBudgets.map((item) => item.budgetId)), new Set(["budget-ent", "budget-product", "budget-ai", "budget-alice"]));
});

test("an effective date excludes earlier usage from a budget", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("before", "2026-09-05", 100), usage("after", "2026-09-12", 100)];
  const replay = replayScenario(scenario);
  const ai = replay.budgetStates.find((item) => item.id === "budget-ai");
  const enterprise = replay.budgetStates.find((item) => item.id === "budget-ent");
  assert.equal(ai.spent, 10);
  assert.equal(enterprise.spent, 20);
});

test("hard limit blocks the entire event without changing counters", () => {
  const scenario = createDefaultScenario();
  const hard = scenario.budgets.find((item) => item.id === "budget-ai");
  hard.amount = 10;
  scenario.events = [usage("fits", "2026-09-12", 100), usage("blocked", "2026-09-13", 1)];
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].status, "accepted");
  assert.equal(replay.results[1].status, "blocked");
  assert.equal(replay.budgetStates.find((item) => item.id === "budget-ent").spent, 10);
  assert.equal(replay.budgetStates.find((item) => item.id === "budget-ai").spent, 10);
});

test("alerts trigger once when a threshold is crossed", () => {
  const scenario = createDefaultScenario();
  scenario.budgets = [{ id: "small", name: "Small", scopeType: "enterprise", scopeId: scenario.enterprise.id, amount: 10, effectiveFrom: "2026-09-01", enforcement: "soft", thresholds: [50, 75, 100] }];
  scenario.events = [usage("first", "2026-09-02", 60), usage("second", "2026-09-03", 20), usage("third", "2026-09-04", 20)];
  const replay = replayScenario(scenario);
  assert.deepEqual(replay.alerts.map((item) => item.threshold), [50, 75, 100]);
});

test("monthly counters reset while history remains", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("sep", "2026-09-15", 100), usage("oct", "2026-10-02", 200)];
  scenario.simulationDate = "2026-10-02";
  const replay = replayScenario(scenario);
  assert.equal(replay.results.length, 2);
  assert.equal(replay.budgetStates.find((item) => item.id === "budget-ent").spent, 20);
});

test("future events remain scheduled until the clock advances", () => {
  const scenario = createDefaultScenario();
  scenario.events = [usage("future", "2026-10-02", 100)];
  assert.equal(replayScenario(scenario).results.length, 0);
  scenario.simulationDate = "2026-10-02";
  assert.equal(replayScenario(scenario).results.length, 1);
});

test("rejects incomplete imported scenarios", () => {
  assert.match(validateScenario({ enterprise: {}, simulationDate: "2026-09-01" }), /Missing/);
  assert.equal(validateScenario(createDefaultScenario()), null);
});
