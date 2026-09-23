import test from "node:test";
import assert from "node:assert/strict";
import { allocate, deriveSyntheticInvoice } from "../tools/copilot-usage/allocate.mjs";
import { estimateModelSplit, sensitivity } from "../tools/copilot-usage/model-split.mjs";
import { MONEY_EPSILON_USD, UNATTRIBUTED_MODEL, creditsToUsd, moneyEquals } from "../tools/copilot-usage/contract.mjs";
import { ENTERPRISE_ID, PERIOD, SEATS } from "../tools/copilot-usage/fixtures/make-fixtures.mjs";

const FIXTURE_CHARGEBACK_ROWS = [
  chargebackRow("2026-09-16", "user-alice", "alice", "cc-ai", "AI Innovation", 120),
  chargebackRow("2026-09-17", "user-alice", "alice", "cc-ai", "AI Innovation", 140),
  chargebackRow("2026-09-18", "user-alice", "alice", "cc-ai", "AI Innovation", 160),
  chargebackRow("2026-09-16", "user-bob", "bob", "cc-core", "Core Platform", 20),
  chargebackRow("2026-09-17", "user-bob", "bob", "cc-core", "Core Platform", 25),
  chargebackRow("2026-09-18", "user-bob", "bob", "cc-core", "Core Platform", 15),
  chargebackRow("2026-09-17", "user-carol", "carol", "cc-core", "Core Platform", 30),
  chargebackRow("2026-09-18", "user-carol", "carol", "cc-core", "Core Platform", 40),
  chargebackRow("2026-09-16", "user-dave", "dave", "unallocated", "Unallocated", 10),
];

test("deriveSyntheticInvoice matches hand-computed fixture values", () => {
  const invoice = deriveSyntheticInvoice({
    seats: SEATS,
    totalCredits: 560,
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
  });

  assert.equal(invoice.kind, "synthetic");
  assert.equal(invoice.daysInMonth, 30);
  assert.equal(invoice.includedCreditsPool, 960);
  assert.equal(invoice.seatChargeUsdByTier.enterprise, 3.9);
  assert.equal(invoice.seatChargeUsdByTier.business, 5.7);
  assert.equal(invoice.meteredChargeUsd, 0);
  assert.equal(invoice.totalCredits, 560);
  assert.match(invoice.assumptions.join("\n"), /illustrative allocated chargeback \(synthetic invoice\)/);
});

test("deriveSyntheticInvoice rejects a multi-month period for the MVP", () => {
  assert.throws(
    () => deriveSyntheticInvoice({ seats: SEATS, totalCredits: 1, periodStart: "2026-09-30", periodEnd: "2026-10-01" }),
    /one calendar month.*multi-month windows need per-period partitioning in V1/i,
  );
});

test("allocate preserves idle-seat cost, proration, per-tier denominators, and conservation", () => {
  const invoice = deriveSyntheticInvoice({
    seats: SEATS,
    totalCredits: 560,
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
  });
  const result = allocate({
    chargebackRows: FIXTURE_CHARGEBACK_ROWS,
    seats: SEATS,
    invoice,
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
  });

  const alice = rowFor(result, "user-alice");
  const bob = rowFor(result, "user-bob");
  const carol = rowFor(result, "user-carol");
  const dave = rowFor(result, "user-dave");
  const erin = rowFor(result, "user-erin");

  assert.equal(alice.tier, "enterprise");
  assert.equal(alice.seat_days, 3);
  assert.equal(alice.seat_cost_usd, 3.9);
  assert.equal(bob.seat_days, 3);
  assert.ok(moneyEquals(bob.seat_cost_usd, 1.9));
  assert.equal(carol.seat_days, 2);
  assert.equal(carol.seat_cost_usd, 5.7 * 2 / 9);
  assert.equal(dave.seat_days, 1);
  assert.equal(dave.seat_cost_usd, 5.7 / 9);
  // Regression guard: a naive credit-share allocation would wrongly assign idle Erin $0.
  assert.equal(erin.ai_credits_used, 0);
  assert.ok(erin.seat_cost_usd > 0);
  assert.ok(moneyEquals(erin.seat_cost_usd, 1.9));

  assert.equal(result.totals.ai_credits_used, 560);
  assert.equal(result.totals.usage_usd, 5.6);
  assert.equal(result.totals.seat_days_by_tier.enterprise, 3);
  assert.equal(result.totals.seat_days_by_tier.business, 9);
  assert.equal(result.totals.seat_cost_usd_by_tier.enterprise, 3.9);
  assert.equal(result.totals.seat_cost_usd_by_tier.business, 5.7);
  assert.ok(result.checks.every((check) => check.ok), JSON.stringify(result.checks));
});

test("allocate guards zero total usage and returns seat-only chargeback", () => {
  const invoice = {
    billing_entity: ENTERPRISE_ID,
    period_start: PERIOD.start,
    period_end: PERIOD.end,
    seatChargeUsdByTier: { enterprise: 3.9, business: 5.7 },
    meteredChargeUsd: 0,
    kind: "actual",
    assumptions: [],
  };
  const result = allocate({
    chargebackRows: [],
    seats: SEATS,
    invoice,
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
  });

  assert.equal(result.totals.ai_credits_used, 0);
  assert.equal(result.totals.metered_cost_usd, 0);
  assert.equal(result.totals.chargeback_usd, 9.6);
  assert.ok(result.rows.every((row) => row.metered_cost_usd === 0));
  assert.ok(result.checks.every((check) => check.ok), JSON.stringify(result.checks));
});

test("allocate gives metered cost to usage without a seat", () => {
  const rows = [
    chargebackRow("2026-09-16", "user-alice", "alice", "cc-ai", "AI Innovation", 560),
    chargebackRow("2026-09-16", "user-frank", "frank", "cc-lab", "Lab", 560),
  ];
  const invoice = {
    billing_entity: ENTERPRISE_ID,
    period_start: PERIOD.start,
    period_end: PERIOD.end,
    seatChargeUsdByTier: { enterprise: 3.9, business: 5.7 },
    meteredChargeUsd: 56,
    kind: "actual",
    assumptions: [],
  };
  const result = allocate({
    chargebackRows: rows,
    seats: SEATS,
    invoice,
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
  });

  const frank = rowFor(result, "user-frank");
  assert.equal(frank.tier, null);
  assert.equal(frank.seat_days, 0);
  assert.equal(frank.seat_cost_usd, 0);
  assert.equal(frank.metered_cost_usd, 28);
  assert.equal(frank.chargeback_usd, 28);
  assert.ok(result.checks.every((check) => check.ok), JSON.stringify(result.checks));
});

test("model split preserves exact user totals and surfaces unattributed usage", () => {
  const chargebackRows = [
    chargebackRow("2026-09-16", "user-a", "a", "cc-a", "A", 100),
    chargebackRow("2026-09-16", "user-b", "b", "cc-b", "B", 30),
  ];
  const usageRowsByDay = {
    "2026-09-16": [
      usageRow("2026-09-16", "user-a", "a", 100, [
        { model: "gpt-5", feature: "chat", interaction_count: 10 },
        { model: "gpt-5-mini", feature: "chat", interaction_count: 10 },
      ]),
    ],
  };

  const split = estimateModelSplit({ chargebackRows, usageRowsByDay });
  const userATotal = split.rows
    .filter((row) => row.user_id === "user-a")
    .reduce((total, row) => total + row.ai_credits_used, 0);
  const userB = split.rows.find((row) => row.user_id === "user-b");

  assert.ok(split.estimated);
  assert.ok(moneyEquals(userATotal, 100));
  assert.equal(userB.model, UNATTRIBUTED_MODEL);
  assert.equal(userB.ai_credits_used, 30);
  assert.equal(userB.usage_usd, creditsToUsd(30));
  assert.ok(split.rows.every((row) => row.estimated));
});

test("model split weights and sensitivity change relative split but not exact totals", () => {
  const chargebackRows = [
    chargebackRow("2026-09-16", "user-a", "a", "cc-a", "A", 100),
  ];
  const usageRowsByDay = {
    "2026-09-16": [
      usageRow("2026-09-16", "user-a", "a", 100, [
        { model: "gpt-5", feature: "chat", interaction_count: 10 },
        { model: "gpt-5-mini", feature: "chat", interaction_count: 10 },
      ]),
    ],
  };

  const base = estimateModelSplit({ chargebackRows, usageRowsByDay });
  const custom = estimateModelSplit({
    chargebackRows,
    usageRowsByDay,
    weights: {
      version: "test",
      source: "test",
      fallback: { weight: 1 },
      weights: {
        "gpt-5": { chat: { weight: 1 } },
        "gpt-5-mini": { chat: { weight: 100 } },
      },
    },
  });
  const low = sensitivity({ chargebackRows, usageRowsByDay, factor: 0.5 });
  const high = sensitivity({ chargebackRows, usageRowsByDay, factor: 1.5 });

  assert.ok(Math.abs(totalCredits(base) - 100) <= MONEY_EPSILON_USD);
  assert.ok(Math.abs(totalCredits(custom) - 100) <= MONEY_EPSILON_USD);
  assert.ok(Math.abs(totalCredits(low) - 100) <= MONEY_EPSILON_USD);
  assert.ok(Math.abs(totalCredits(high) - 100) <= MONEY_EPSILON_USD);
  assert.notEqual(modelCredits(base, "gpt-5"), modelCredits(custom, "gpt-5"));
  assert.notEqual(modelCredits(low, "gpt-5"), modelCredits(high, "gpt-5"));
  assert.match(high.basis, /Sensitivity factor 1.5/);
});

function chargebackRow(day, userId, userLogin, costCenterId, costCenterName, credits) {
  return {
    day,
    user_id: userId,
    user_login: userLogin,
    cost_center_id: costCenterId,
    cost_center_name: costCenterName,
    organization_id: null,
    attribution_route: costCenterId === "unallocated" ? "none" : "user",
    ai_credits_used: credits,
    usage_usd: creditsToUsd(credits),
  };
}

function usageRow(day, userId, userLogin, credits, totalsByModelFeature) {
  return {
    day_partition: day,
    entity_id_partition: ENTERPRISE_ID,
    enterprise_id: ENTERPRISE_ID,
    user_id: userId,
    user_login: userLogin,
    ai_credits_used: credits,
    totals_by_model_feature: totalsByModelFeature,
  };
}

function rowFor(result, userId) {
  const row = result.rows.find((candidate) => candidate.user_id === userId);
  assert.ok(row, `Expected row for ${userId}`);
  return row;
}

function totalCredits(result) {
  return result.rows.reduce((total, row) => total + row.ai_credits_used, 0);
}

function modelCredits(result, model) {
  return result.rows
    .filter((row) => row.model === model)
    .reduce((total, row) => total + row.ai_credits_used, 0);
}
