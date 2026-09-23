import {
  AI_CREDIT_USD,
  MONEY_EPSILON_USD,
  TIERS,
  assertDay,
  creditsToUsd,
  moneyEquals,
  seatDaysInPeriod,
} from "./contract.mjs";

export function deriveSyntheticInvoice({ seats, totalCredits, periodStart, periodEnd, tiers = TIERS }) {
  assertSingleMonthPeriod(periodStart, periodEnd);
  const daysInMonth = daysInCalendarMonth(periodStart);
  const seatChargeUsdByTier = {};
  let includedCreditsPool = 0;

  for (const [tierId, tier] of Object.entries(tiers)) {
    const tierSeatDays = seats
      .filter((seat) => seat.tier === tierId)
      .reduce((total, seat) => total + seatDaysInPeriod(seat, periodStart, periodEnd), 0);
    seatChargeUsdByTier[tierId] = tier.listPriceUsd * tierSeatDays / daysInMonth;
    includedCreditsPool += tier.includedCreditsPerSeatMonth * tierSeatDays / daysInMonth;
  }

  return {
    billing_entity: "synthetic",
    period_start: periodStart,
    period_end: periodEnd,
    seatChargeUsdByTier,
    meteredChargeUsd: Math.max(0, Number(totalCredits) - includedCreditsPool) * AI_CREDIT_USD,
    kind: "synthetic",
    assumptions: [
      `Synthetic invoice for illustrative allocated chargeback (synthetic invoice); not reconciled to an Azure invoice.`,
      `List prices used: ${Object.values(tiers).map((tier) => `${tier.id} $${tier.listPriceUsd}/seat/month`).join(", ")}.`,
      `Seat charges prorated by seat-days over ${daysInMonth} days in ${periodStart.slice(0, 7)}.`,
      `Included credits pool derived from tier allowances and seat-days: ${includedCreditsPool} credits.`,
      `Metered charge derived as max(0, total credits ${Number(totalCredits)} - included pool ${includedCreditsPool}) × $${AI_CREDIT_USD}.`,
    ],
    daysInMonth,
    includedCreditsPool,
    totalCredits: Number(totalCredits),
    reportLabel: "illustrative allocated chargeback (synthetic invoice)",
  };
}

export function allocate({ chargebackRows, seats, invoice, periodStart, periodEnd }) {
  assertDay(periodStart, "periodStart");
  assertDay(periodEnd, "periodEnd");
  if (periodStart > periodEnd) throw new Error(`periodStart ${periodStart} is after periodEnd ${periodEnd}.`);
  assertInvoicePeriodMatches(invoice, periodStart, periodEnd);

  const rowsByKey = new Map();
  const userDefaults = new Map();
  const usageByUser = new Map();
  let entityCredits = 0;

  for (const row of chargebackRows) {
    const credits = Number(row.ai_credits_used ?? 0);
    entityCredits += credits;
    const userKey = row.user_id;
    const defaults = userDefaults.get(userKey) ?? {
      user_id: row.user_id,
      user_login: row.user_login,
      cost_center_id: row.cost_center_id ?? "unallocated",
      cost_center_name: row.cost_center_name ?? row.cost_center_id ?? "Unallocated",
      organization_id: row.organization_id ?? null,
    };
    userDefaults.set(userKey, defaults);
    usageByUser.set(userKey, (usageByUser.get(userKey) ?? 0) + credits);
    const bucket = rowBucket(rowsByKey, {
      ...defaults,
      tier: null,
    });
    bucket.ai_credits_used += credits;
    bucket.usage_usd += row.usage_usd === undefined ? creditsToUsd(credits) : Number(row.usage_usd);
  }

  const seatDaysByTier = {};
  for (const tierId of Object.keys(invoice.seatChargeUsdByTier ?? {})) {
    seatDaysByTier[tierId] = 0;
  }
  for (const seat of seats) {
    const seatDays = seatDaysInPeriod(seat, periodStart, periodEnd);
    if (seatDays <= 0) continue;
    seatDaysByTier[seat.tier] = (seatDaysByTier[seat.tier] ?? 0) + seatDays;
    if (!userDefaults.has(seat.user_id)) {
      userDefaults.set(seat.user_id, {
        user_id: seat.user_id,
        user_login: seat.user_login,
        cost_center_id: "unallocated",
        cost_center_name: "Unallocated",
        organization_id: seat.organization_id ?? null,
      });
    }
  }

  const seatCostByTier = {};
  for (const seat of seats) {
    const seatDays = seatDaysInPeriod(seat, periodStart, periodEnd);
    if (seatDays <= 0) continue;
    const tierSeatCharge = Number(invoice.seatChargeUsdByTier?.[seat.tier] ?? 0);
    const tierSeatDays = seatDaysByTier[seat.tier] ?? 0;
    if (tierSeatCharge !== 0 && tierSeatDays === 0) {
      throw new Error(`Cannot allocate ${seat.tier} seat charge without ${seat.tier} seat-days in the period.`);
    }
    // Business and Enterprise seat-days are deliberately separate denominators.
    const seatCost = tierSeatDays === 0 ? 0 : tierSeatCharge * seatDays / tierSeatDays;
    seatCostByTier[seat.tier] = (seatCostByTier[seat.tier] ?? 0) + seatCost;
    const defaults = userDefaults.get(seat.user_id);
    const bucket = rowBucket(rowsByKey, { ...defaults, tier: seat.tier });
    bucket.seat_days += seatDays;
    bucket.seat_cost_usd += seatCost;
  }

  mergeUsageIntoSingleSeatRows(rowsByKey);

  const meteredCharge = Number(invoice.meteredChargeUsd ?? 0);
  if (entityCredits > 0 && meteredCharge !== 0) {
    for (const row of rowsByKey.values()) {
      if (row.ai_credits_used === 0) continue;
      row.metered_cost_usd += meteredCharge * row.ai_credits_used / entityCredits;
    }
  }

  for (const row of rowsByKey.values()) {
    row.chargeback_usd = row.seat_cost_usd + row.metered_cost_usd;
  }

  const rows = [...rowsByKey.values()].sort((a, b) =>
    a.cost_center_id.localeCompare(b.cost_center_id)
      || a.user_login.localeCompare(b.user_login)
      || String(a.tier ?? "").localeCompare(String(b.tier ?? "")),
  );
  const totals = buildTotals(rows, invoice, entityCredits, seatDaysByTier, seatCostByTier);
  const result = { invoice, rows, totals, checks: [] };
  result.checks = verifyConservation(result);
  return result;
}

/**
 * Allocation is only meaningful inside one (billing_entity, invoice_period) partition. Allocating a
 * whole month's charge across a three-day usage window would still conserve -- every conservation
 * check would pass -- while overstating each of those three days by roughly tenfold. The period must
 * therefore be checked explicitly, because no downstream check can detect this.
 */
function assertInvoicePeriodMatches(invoice, periodStart, periodEnd) {
  if (!invoice) throw new Error("allocate requires an invoice.");
  const invoiceStart = invoice.period_start;
  const invoiceEnd = invoice.period_end;
  if (!invoiceStart || !invoiceEnd) return;
  if (invoiceStart !== periodStart || invoiceEnd !== periodEnd) {
    throw new Error(
      `Invoice period ${invoiceStart}..${invoiceEnd} does not match the allocation period ${periodStart}..${periodEnd}. `
      + "Allocate one (billing entity, invoice period) partition at a time: extract the usage window that matches the "
      + "invoice period, or split the invoice, and allocate each partition separately.",
    );
  }
}

export function verifyConservation(result) {
  const checks = [];
  const invoice = result.invoice;
  const rows = result.rows;
  const seatChargeUsdByTier = invoice.seatChargeUsdByTier ?? {};

  // Conservation is NOT completeness: if source rows omit users or days, these checks still pass
  // because missing cost is redistributed over the ingested denominator. Extractor manifests own
  // source-completeness checks; this module only proves allocation conservation.
  for (const [tier, expected] of Object.entries(seatChargeUsdByTier)) {
    const actual = rows
      .filter((row) => row.tier === tier)
      .reduce((total, row) => total + row.seat_cost_usd, 0);
    checks.push(checkMoney(`seat-cost-${tier}`, actual, Number(expected), `${tier} allocated seat cost equals tier seat charge`));
  }

  const actualMetered = rows.reduce((total, row) => total + row.metered_cost_usd, 0);
  checks.push(checkMoney("metered-cost", actualMetered, Number(invoice.meteredChargeUsd ?? 0), "allocated metered cost equals metered charge"));

  const actualChargeback = rows.reduce((total, row) => total + row.chargeback_usd, 0);
  const expectedChargeback = Object.values(seatChargeUsdByTier).reduce((total, value) => total + Number(value), 0)
    + Number(invoice.meteredChargeUsd ?? 0);
  checks.push(checkMoney("total-chargeback", actualChargeback, expectedChargeback, "allocated chargeback equals full invoice"));

  const actualUsageUsd = rows.reduce((total, row) => total + row.usage_usd, 0);
  const expectedUsageUsd = creditsToUsd(result.totals.ai_credits_used);
  checks.push(checkMoney("usage-valued-consumption", actualUsageUsd, expectedUsageUsd, "usage_usd equals totalCredits × $0.01"));

  return checks;
}

function assertSingleMonthPeriod(periodStart, periodEnd) {
  assertDay(periodStart, "periodStart");
  assertDay(periodEnd, "periodEnd");
  if (periodStart > periodEnd) throw new Error(`periodStart ${periodStart} is after periodEnd ${periodEnd}.`);
  if (periodStart.slice(0, 7) !== periodEnd.slice(0, 7)) {
    throw new Error(`Synthetic invoice periods must be contained in one calendar month for this MVP; multi-month windows need per-period partitioning in V1.`);
  }
}

function daysInCalendarMonth(day) {
  const [year, month] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function rowBucket(rowsByKey, row) {
  const key = `${row.user_id}\u0000${row.cost_center_id}\u0000${row.tier ?? ""}`;
  if (!rowsByKey.has(key)) {
    rowsByKey.set(key, {
      user_id: row.user_id,
      user_login: row.user_login,
      cost_center_id: row.cost_center_id,
      cost_center_name: row.cost_center_name,
      organization_id: row.organization_id ?? null,
      ai_credits_used: 0,
      usage_usd: 0,
      seat_days: 0,
      tier: row.tier,
      seat_cost_usd: 0,
      metered_cost_usd: 0,
      chargeback_usd: 0,
    });
  }
  return rowsByKey.get(key);
}

function mergeUsageIntoSingleSeatRows(rowsByKey) {
  for (const [key, row] of [...rowsByKey]) {
    if (row.tier !== null || row.ai_credits_used === 0) continue;
    const seatRows = [...rowsByKey.values()].filter((candidate) =>
      candidate.user_id === row.user_id
        && candidate.cost_center_id === row.cost_center_id
        && candidate.tier !== null,
    );
    if (seatRows.length !== 1) continue;
    seatRows[0].ai_credits_used += row.ai_credits_used;
    seatRows[0].usage_usd += row.usage_usd;
    rowsByKey.delete(key);
  }
}

function buildTotals(rows, invoice, entityCredits, seatDaysByTier, seatCostByTier) {
  const totals = {
    ai_credits_used: entityCredits,
    usage_usd: 0,
    seat_cost_usd: 0,
    metered_cost_usd: 0,
    chargeback_usd: 0,
    invoice_usd: Object.values(invoice.seatChargeUsdByTier ?? {}).reduce((total, value) => total + Number(value), 0)
      + Number(invoice.meteredChargeUsd ?? 0),
    seat_days_by_tier: { ...seatDaysByTier },
    seat_cost_usd_by_tier: { ...seatCostByTier },
    cost_centers: [],
  };
  const costCenters = new Map();
  for (const row of rows) {
    totals.usage_usd += row.usage_usd;
    totals.seat_cost_usd += row.seat_cost_usd;
    totals.metered_cost_usd += row.metered_cost_usd;
    totals.chargeback_usd += row.chargeback_usd;
    const costCenter = costCenters.get(row.cost_center_id) ?? {
      cost_center_id: row.cost_center_id,
      cost_center_name: row.cost_center_name,
      ai_credits_used: 0,
      usage_usd: 0,
      seat_cost_usd: 0,
      metered_cost_usd: 0,
      chargeback_usd: 0,
    };
    costCenter.ai_credits_used += row.ai_credits_used;
    costCenter.usage_usd += row.usage_usd;
    costCenter.seat_cost_usd += row.seat_cost_usd;
    costCenter.metered_cost_usd += row.metered_cost_usd;
    costCenter.chargeback_usd += row.chargeback_usd;
    costCenters.set(row.cost_center_id, costCenter);
  }
  totals.cost_centers = [...costCenters.values()].sort((a, b) => a.cost_center_id.localeCompare(b.cost_center_id));
  return totals;
}

function checkMoney(name, actual, expected, detail) {
  const ok = moneyEquals(actual, expected);
  return {
    name,
    ok,
    detail: `${detail}: actual ${actual}, expected ${expected}, tolerance ${MONEY_EPSILON_USD}`,
  };
}
