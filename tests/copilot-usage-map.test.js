import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  anonymize,
  buildChargebackTable,
  buildEnvironment,
  buildScenario,
  resolveCostCenter,
  verifyChargebackInvariants,
} from "../tools/copilot-usage/map-environment.mjs";
import { AI_CREDITS_PRODUCT_ID, UNALLOCATED_COST_CENTER_ID, parseNdjson } from "../tools/copilot-usage/contract.mjs";
import { DAYS, ENTERPRISE_ID, MEMBERSHIP, SEATS } from "../tools/copilot-usage/fixtures/make-fixtures.mjs";
import { validateEnvironment, validateMaterializedScenario } from "../src/environment.js";

const FIXTURE_ROOT = new URL("../tools/copilot-usage/fixtures/", import.meta.url);

async function fixtureRows(report) {
  const rowsByDay = {};
  for (const day of DAYS) {
    const text = await readFile(new URL(`raw/day=${day}/${report}.ndjson`, FIXTURE_ROOT), "utf8");
    rowsByDay[day] = parseNdjson(text);
  }
  return rowsByDay;
}

async function buildFixtureChargeback() {
  const usageRowsByDay = await fixtureRows("users-1-day");
  const userTeamRowsByDay = await fixtureRows("user-teams-1-day");
  const chargeback = buildChargebackTable({ usageRowsByDay, userTeamRowsByDay, membership: MEMBERSHIP });
  return { usageRowsByDay, userTeamRowsByDay, chargeback };
}

test("resolveCostCenter applies direct user, team, organization, then unallocated precedence", () => {
  assert.deepEqual(resolveCostCenter({
    userId: "user-alice",
    organizationId: "org-product",
    teamIds: ["team-core"],
    membership: MEMBERSHIP,
  }), { costCenterId: "cc-ai", costCenterName: "AI Innovation", route: "user" });
  assert.deepEqual(resolveCostCenter({
    userId: "user-bob",
    organizationId: "org-product",
    teamIds: ["team-core"],
    membership: MEMBERSHIP,
  }), { costCenterId: "cc-core", costCenterName: "Core Platform", route: "team" });
  assert.deepEqual(resolveCostCenter({
    userId: "user-carol",
    organizationId: "org-platform",
    teamIds: [],
    membership: MEMBERSHIP,
  }), { costCenterId: "cc-core", costCenterName: "Core Platform", route: "organization" });
  assert.deepEqual(resolveCostCenter({
    userId: "user-dave",
    organizationId: "org-product",
    teamIds: [],
    membership: MEMBERSHIP,
  }), { costCenterId: UNALLOCATED_COST_CENTER_ID, costCenterName: "Unallocated", route: "none" });
});

test("buildChargebackTable maps fixture users and reports conservation failures", async () => {
  const { usageRowsByDay, chargeback } = await buildFixtureChargeback();
  assert.equal(chargeback.invariants.every((invariant) => invariant.ok), true);

  const alice = chargeback.rows.find((row) => row.user_id === "user-alice" && row.day === "2026-09-16");
  assert.equal(alice.cost_center_id, "cc-ai");
  assert.equal(alice.attribution_route, "user");
  assert.equal(alice.usage_usd, 1.2);

  const bob = chargeback.rows.find((row) => row.user_id === "user-bob" && row.day === "2026-09-16");
  assert.equal(bob.cost_center_id, "cc-core");
  assert.equal(bob.attribution_route, "team");

  const carol = chargeback.rows.find((row) => row.user_id === "user-carol" && row.day === "2026-09-17");
  assert.equal(carol.cost_center_id, "cc-core");
  assert.equal(carol.attribution_route, "organization");

  const dave = chargeback.rows.find((row) => row.user_id === "user-dave");
  assert.equal(dave.cost_center_id, UNALLOCATED_COST_CENTER_ID);
  assert.equal(dave.attribution_route, "none");
  assert.equal(chargeback.unallocated.userCount, 1);

  assert.equal(chargeback.rows.some((row) => row.user_id === "user-erin"), false);

  const missingRowChecks = verifyChargebackInvariants({ rows: chargeback.rows.slice(1), usageRowsByDay });
  assert.equal(missingRowChecks.some((invariant) => !invariant.ok), true);
});

test("buildEnvironment emits a valid topology including idle seats", async () => {
  const { usageRowsByDay, userTeamRowsByDay, chargeback } = await buildFixtureChargeback();
  const environment = buildEnvironment({
    chargeback,
    usageRowsByDay,
    seats: SEATS,
    enterprise: { id: ENTERPRISE_ID, name: "Demo Enterprise" },
    membership: MEMBERSHIP,
    options: { createdAt: MEMBERSHIP.captured_at, userTeamRowsByDay },
  });

  assert.equal(validateEnvironment(environment), null);
  assert.equal(environment.source.kind, "github-api");
  assert.equal(environment.costCenters.some((costCenter) => costCenter.id === UNALLOCATED_COST_CENTER_ID), true);
  assert.equal(environment.users.some((user) => user.id === "user-erin"), true);
  assert.equal(environment.users.find((user) => user.id === "user-carol").licenseStartsAt, "2026-09-17");
});

test("buildScenario emits positive AI-credit events with resolvable references only", async () => {
  const { usageRowsByDay, userTeamRowsByDay, chargeback } = await buildFixtureChargeback();
  const environment = buildEnvironment({
    chargeback,
    usageRowsByDay,
    seats: SEATS,
    enterprise: ENTERPRISE_ID,
    membership: MEMBERSHIP,
    options: { createdAt: MEMBERSHIP.captured_at, userTeamRowsByDay },
  });
  const scenario = buildScenario({ environment, chargeback, simulationDate: "2026-09-18" });

  assert.equal(validateMaterializedScenario(scenario), null);
  assert.equal(scenario.events.some((event) => event.userId === "user-erin"), false);
  assert.equal(scenario.events.every((event) => event.quantity > 0), true);
  assert.equal(scenario.events.every((event) => event.productId === AI_CREDITS_PRODUCT_ID), true);
  const userIds = new Set(scenario.users.map((user) => user.id));
  const productIds = new Set(scenario.products.map((product) => product.id));
  assert.equal(scenario.events.every((event) => userIds.has(event.userId) && productIds.has(event.productId)), true);
});

test("build output is deterministic", async () => {
  const { usageRowsByDay, userTeamRowsByDay, chargeback } = await buildFixtureChargeback();
  const input = {
    chargeback,
    usageRowsByDay,
    seats: SEATS,
    enterprise: ENTERPRISE_ID,
    membership: MEMBERSHIP,
    options: { createdAt: MEMBERSHIP.captured_at, userTeamRowsByDay },
  };
  const first = buildScenario({ environment: buildEnvironment(input), chargeback, simulationDate: "2026-09-18" });
  const second = buildScenario({ environment: buildEnvironment(input), chargeback, simulationDate: "2026-09-18" });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("anonymize removes original logins and preserves references", async () => {
  const { usageRowsByDay, userTeamRowsByDay, chargeback } = await buildFixtureChargeback();
  const environment = buildEnvironment({
    chargeback,
    usageRowsByDay,
    seats: SEATS,
    enterprise: ENTERPRISE_ID,
    membership: MEMBERSHIP,
    options: { createdAt: MEMBERSHIP.captured_at, userTeamRowsByDay },
  });
  const scenario = buildScenario({ environment, chargeback, simulationDate: "2026-09-18" });
  const anonymized = anonymize(scenario, { salt: "demo" });
  const serialized = JSON.stringify(anonymized);

  for (const login of ["alice", "bob", "carol", "dave", "erin"]) {
    assert.equal(serialized.includes(login), false);
  }
  assert.equal(validateMaterializedScenario(anonymized), null);
  const userIds = new Set(anonymized.users.map((user) => user.id));
  assert.equal(anonymized.events.every((event) => userIds.has(event.userId)), true);
});
