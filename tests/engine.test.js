import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDefaultScenario, isSeatActiveForDate, replayScenario, seatChargeForPeriod, userPoolContribution, validateScenario } from "../src/engine.js";
import { materializeScenario, validateScenarioDefinition } from "../src/scenario-runner.js";
import { loadScenarioCatalog } from "../src/scenario-catalog.js";
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

test("organization cost-center assignment provides fallback attribution", () => {
  const scenario = createDefaultScenario();
  scenario.users.find((item) => item.id === "user-alice").costCenterId = null;
  scenario.costCenters.find((item) => item.id === "cc-ai").organizationIds = ["org-product"];
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.events = [usage("over", "2026-09-15", 6000)];
  const replay = replayScenario(scenario);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-ai-team").spent, 2);
  assert.equal(replay.budgetStates.find((item) => item.id === "metered-product-org").spent, 0);
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

test("zero-dollar AI-credit budget blocks metered usage even when configured alert-only", () => {
  const scenario = createDefaultScenario();
  scenario.users.find((item) => item.id === "user-alice").costCenterId = null;
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.budgets.find((item) => item.id === "metered-product-org").amount = 0;
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
  assert.match(html, /docs\.github\.com\/en\/copilot\/concepts\/billing-and-usage\/organizations-and-enterprises\/billing/);
  assert.match(html, /docs\.github\.com\/en\/billing\/reference\/cost-center-allocation/);
  assert.match(html, /docs\.github\.com\/en\/billing\/how-tos\/set-up-budgets/);
});

test("threshold alerts carry the state key needed to open budget history", () => {
  const scenario = createDefaultScenario();
  scenario.budgets.find((item) => item.id === "ulb-alice").amount = 200;
  scenario.budgets.find((item) => item.id === "metered-ai-team").thresholds = [75, 90, 100];
  scenario.events = [usage("pool", "2026-09-15", 5800), usage("over", "2026-09-15", 2400)];
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
});

test("optimized UI is isolated from legacy pages and exposes bucket attribution controls", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  for (const id of ["optimized", "optimized-hierarchy", "optimized-buckets", "optimized-scope-type", "optimized-scrubber", "optimized-event-detail"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-view="optimized"/);
  assert.match(app, /renderOptimizedExperience\(replay, currency\)/);
  assert.match(app, /Included credits/);
  assert.match(app, /User-level budgets/);
  assert.match(app, /Budget controls/);
  assert.match(app, /scenario\.events\.find\(\(item\) => item\.id === result\.eventId\)/);
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
    assert.equal(baseline.events.length, 0);
    assert.equal(complete.events.length, definition.steps.filter((step) => step.type === "usage").length);
    assert.deepEqual(materializeScenario(definition, -1), baseline);
  }

  const progression = BUILT_IN_SCENARIOS.find((item) => item.id === "budget-health-progression");
  const atNinety = replayScenario(materializeScenario(progression, 3));
  const atHundred = replayScenario(materializeScenario(progression, 4));
  const aliceAtNinety = atNinety.budgetStates.find((item) => item.id === "ulb-alice");
  const aliceAtHundred = atHundred.budgetStates.find((item) => item.id === "ulb-alice");
  assert.equal(aliceAtNinety.percent, 90);
  assert.equal(aliceAtHundred.percent, 100);
  assert.equal(atHundred.results.at(-1).status, "accepted");
  assert.ok(atHundred.alerts.some((alert) => alert.budgetId === "ulb-alice" && alert.threshold === 100));

  const hardStop = BUILT_IN_SCENARIOS.find((item) => item.id === "hard-stop-boundary");
  const blocked = replayScenario(materializeScenario(hardStop, 1));
  assert.equal(blocked.results.at(-1).status, "blocked");
  assert.match(blocked.results.at(-1).reason, /user-level hard stop/);
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
