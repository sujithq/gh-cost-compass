import { UNATTRIBUTED_MODEL, creditsToUsd } from "./contract.mjs";

const PRICING_SOURCE = "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";

export const MODEL_COST_WEIGHTS = Object.freeze({
  version: "2026-09-22",
  source: PRICING_SOURCE,
  basis: "Estimated relative cost per interaction. Totals are normalized to exact ai_credits_used; these weights never create total spend.",
  fallback: Object.freeze(weightEntry({
    model: "unknown",
    feature: "unknown",
    averageTokensPerInteraction: 1800,
    tokenMix: { input: 900, cachedInput: 300, cacheWrite: 100, output: 500 },
    relativeTokenPrice: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 4 },
  })),
  weights: Object.freeze({
    "gpt-5": Object.freeze({
      chat: Object.freeze(weightEntry({
        model: "gpt-5",
        feature: "chat",
        averageTokensPerInteraction: 2400,
        tokenMix: { input: 1200, cachedInput: 400, cacheWrite: 100, output: 700 },
        relativeTokenPrice: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 4 },
      })),
      code_review: Object.freeze(weightEntry({
        model: "gpt-5",
        feature: "code_review",
        averageTokensPerInteraction: 7600,
        tokenMix: { input: 4200, cachedInput: 1800, cacheWrite: 400, output: 1200 },
        relativeTokenPrice: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 4 },
      })),
      coding_agent: Object.freeze(weightEntry({
        model: "gpt-5",
        feature: "coding_agent",
        averageTokensPerInteraction: 11800,
        tokenMix: { input: 5600, cachedInput: 2400, cacheWrite: 900, output: 2900 },
        relativeTokenPrice: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 4 },
      })),
    }),
    "gpt-5-mini": Object.freeze({
      chat: Object.freeze(weightEntry({
        model: "gpt-5-mini",
        feature: "chat",
        averageTokensPerInteraction: 1800,
        tokenMix: { input: 900, cachedInput: 300, cacheWrite: 100, output: 500 },
        relativeTokenPrice: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.8 },
      })),
      code_review: Object.freeze(weightEntry({
        model: "gpt-5-mini",
        feature: "code_review",
        averageTokensPerInteraction: 6200,
        tokenMix: { input: 3600, cachedInput: 1400, cacheWrite: 300, output: 900 },
        relativeTokenPrice: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.8 },
      })),
      coding_agent: Object.freeze(weightEntry({
        model: "gpt-5-mini",
        feature: "coding_agent",
        averageTokensPerInteraction: 9000,
        tokenMix: { input: 4600, cachedInput: 1900, cacheWrite: 700, output: 1800 },
        relativeTokenPrice: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.8 },
      })),
    }),
    "claude-sonnet-4.5": Object.freeze({
      chat: Object.freeze(weightEntry({
        model: "claude-sonnet-4.5",
        feature: "chat",
        averageTokensPerInteraction: 2600,
        tokenMix: { input: 1300, cachedInput: 450, cacheWrite: 120, output: 730 },
        relativeTokenPrice: { input: 1.2, cachedInput: 0.12, cacheWrite: 1.5, output: 4.8 },
      })),
      code_review: Object.freeze(weightEntry({
        model: "claude-sonnet-4.5",
        feature: "code_review",
        averageTokensPerInteraction: 8200,
        tokenMix: { input: 4600, cachedInput: 1900, cacheWrite: 450, output: 1250 },
        relativeTokenPrice: { input: 1.2, cachedInput: 0.12, cacheWrite: 1.5, output: 4.8 },
      })),
      coding_agent: Object.freeze(weightEntry({
        model: "claude-sonnet-4.5",
        feature: "coding_agent",
        averageTokensPerInteraction: 12600,
        tokenMix: { input: 6100, cachedInput: 2500, cacheWrite: 1000, output: 3000 },
        relativeTokenPrice: { input: 1.2, cachedInput: 0.12, cacheWrite: 1.5, output: 4.8 },
      })),
    }),
  }),
});

export function estimateModelSplit({ chargebackRows, usageRowsByDay, weights = MODEL_COST_WEIGHTS }) {
  const exactCreditsByUser = totalCreditsByUser(chargebackRows);
  const users = userDefaults(chargebackRows);
  const buckets = new Map();
  const usageRows = flattenUsageRows(usageRowsByDay);
  const processedCreditsByUser = new Map();

  for (const row of usageRows) {
    const credits = Number(row.ai_credits_used ?? 0);
    if (credits <= 0) continue;
    const userId = row.user_id;
    if (!users.has(userId)) {
      users.set(userId, { user_id: userId, user_login: row.user_login ?? userId });
    }
    processedCreditsByUser.set(userId, (processedCreditsByUser.get(userId) ?? 0) + credits);
    const modelRows = (row.totals_by_model_feature ?? [])
      .filter((modelRow) => Number(modelRow.interaction_count ?? 0) > 0);
    const weightedRows = modelRows.map((modelRow) => {
      const weight = resolveWeight(weights, modelRow.model, modelRow.feature);
      return {
        ...modelRow,
        interaction_count: Number(modelRow.interaction_count),
        weight,
        weighted: Number(modelRow.interaction_count) * weight,
      };
    });
    const totalWeighted = weightedRows.reduce((total, modelRow) => total + modelRow.weighted, 0);
    if (totalWeighted <= 0) {
      addModelBucket(buckets, users.get(userId), UNATTRIBUTED_MODEL, "unattributed", 0, null, credits);
      continue;
    }
    for (const modelRow of weightedRows) {
      addModelBucket(
        buckets,
        users.get(userId),
        modelRow.model,
        modelRow.feature,
        modelRow.interaction_count,
        modelRow.weight,
        credits * modelRow.weighted / totalWeighted,
      );
    }
  }

  for (const [userId, exactCredits] of exactCreditsByUser) {
    if (!users.has(userId)) users.set(userId, { user_id: userId, user_login: userId });
    const processed = processedCreditsByUser.get(userId) ?? 0;
    if (processed < exactCredits) {
      addModelBucket(buckets, users.get(userId), UNATTRIBUTED_MODEL, "unattributed", 0, null, exactCredits - processed);
    }
  }

  const rows = normalizeToExactCredits([...buckets.values()], exactCreditsByUser)
    .sort((a, b) => a.user_id.localeCompare(b.user_id) || a.model.localeCompare(b.model) || a.feature.localeCompare(b.feature));
  const totals = modelSplitTotals(rows);
  return {
    estimated: true,
    basis: `${weights.version}: model/feature interaction counts weighted by explicit assumed token profiles, then normalized to exact ai_credits_used.`,
    weights_version: weights.version,
    weights_source: weights.source,
    rows,
    totals,
  };
}

export function sensitivity({ chargebackRows, usageRowsByDay, weights = MODEL_COST_WEIGHTS, factor }) {
  if (!Number.isFinite(Number(factor)) || Number(factor) <= 0) {
    throw new Error(`sensitivity factor must be a positive number, received: ${JSON.stringify(factor)}`);
  }
  const scaledWeights = scaleWeights(weights, Number(factor));
  const result = estimateModelSplit({ chargebackRows, usageRowsByDay, weights: scaledWeights });
  return {
    ...result,
    factor: Number(factor),
    basis: `${result.basis} Sensitivity factor ${Number(factor)} scales non-cached assumed tokens per interaction; exact user totals are unchanged.`,
  };
}

function weightEntry({ model, feature, averageTokensPerInteraction, tokenMix, relativeTokenPrice }) {
  return {
    model,
    feature,
    averageTokensPerInteraction,
    tokenMix,
    relativeTokenPrice,
    weight: weightedTokenCost(tokenMix, relativeTokenPrice),
  };
}

function weightedTokenCost(tokenMix, relativeTokenPrice) {
  return Object.entries(tokenMix).reduce((total, [kind, tokens]) => total + Number(tokens) * Number(relativeTokenPrice[kind] ?? 0), 0);
}

function flattenUsageRows(usageRowsByDay) {
  if (!usageRowsByDay) return [];
  if (Array.isArray(usageRowsByDay)) return usageRowsByDay;
  if (usageRowsByDay instanceof Map) return [...usageRowsByDay.values()].flat();
  return Object.values(usageRowsByDay).flat();
}

function totalCreditsByUser(chargebackRows) {
  const totals = new Map();
  for (const row of chargebackRows) {
    totals.set(row.user_id, (totals.get(row.user_id) ?? 0) + Number(row.ai_credits_used ?? 0));
  }
  return totals;
}

function userDefaults(chargebackRows) {
  const users = new Map();
  for (const row of chargebackRows) {
    if (!users.has(row.user_id)) users.set(row.user_id, { user_id: row.user_id, user_login: row.user_login });
  }
  return users;
}

function resolveWeight(weights, model, feature) {
  return Number(weights.weights?.[model]?.[feature]?.weight ?? weights.weights?.[model]?.default?.weight ?? weights.fallback.weight);
}

function addModelBucket(buckets, user, model, feature, interactionCount, weight, credits) {
  const key = `${user.user_id}\u0000${model}\u0000${feature}`;
  if (!buckets.has(key)) {
    buckets.set(key, {
      estimated: true,
      basis: "Estimated model split; ai_credits_used total is exact, model/feature allocation is weighted from interaction counts.",
      user_id: user.user_id,
      user_login: user.user_login,
      model,
      feature,
      interaction_count: 0,
      weight,
      ai_credits_used: 0,
      usage_usd: 0,
    });
  }
  const bucket = buckets.get(key);
  bucket.interaction_count += interactionCount;
  bucket.ai_credits_used += credits;
  bucket.usage_usd = creditsToUsd(bucket.ai_credits_used);
}

function normalizeToExactCredits(rows, exactCreditsByUser) {
  const allocatedByUser = new Map();
  for (const row of rows) {
    allocatedByUser.set(row.user_id, (allocatedByUser.get(row.user_id) ?? 0) + row.ai_credits_used);
  }
  for (const row of rows) {
    const exact = exactCreditsByUser.get(row.user_id) ?? row.ai_credits_used;
    const allocated = allocatedByUser.get(row.user_id) ?? 0;
    if (allocated > 0 && exact !== allocated) {
      row.ai_credits_used *= exact / allocated;
      row.usage_usd = creditsToUsd(row.ai_credits_used);
    }
  }
  return rows;
}

function modelSplitTotals(rows) {
  const totals = { ai_credits_used: 0, usage_usd: 0, by_user: [], by_model: [] };
  const byUser = new Map();
  const byModel = new Map();
  for (const row of rows) {
    totals.ai_credits_used += row.ai_credits_used;
    totals.usage_usd += row.usage_usd;
    addTotal(byUser, row.user_id, row.user_login, row.ai_credits_used, row.usage_usd);
    addTotal(byModel, row.model, row.model, row.ai_credits_used, row.usage_usd);
  }
  totals.by_user = [...byUser.values()].sort((a, b) => a.id.localeCompare(b.id));
  totals.by_model = [...byModel.values()].sort((a, b) => a.id.localeCompare(b.id));
  return totals;
}

function addTotal(map, id, name, credits, usd) {
  const total = map.get(id) ?? { id, name, ai_credits_used: 0, usage_usd: 0 };
  total.ai_credits_used += credits;
  total.usage_usd += usd;
  map.set(id, total);
}

function scaleWeights(weights, factor) {
  const scaled = {};
  for (const [model, features] of Object.entries(weights.weights)) {
    scaled[model] = {};
    for (const [feature, entry] of Object.entries(features)) {
      scaled[model][feature] = scaleEntry(entry, factor);
    }
  }
  return {
    ...weights,
    version: `${weights.version}+sensitivity-${factor}`,
    fallback: scaleEntry(weights.fallback, factor),
    weights: scaled,
  };
}

function scaleEntry(entry, factor) {
  const tokenMix = {
    input: entry.tokenMix.input * factor,
    cachedInput: entry.tokenMix.cachedInput,
    cacheWrite: entry.tokenMix.cacheWrite * factor,
    output: entry.tokenMix.output * factor,
  };
  return {
    ...entry,
    averageTokensPerInteraction: Object.values(tokenMix).reduce((total, value) => total + value, 0),
    tokenMix,
    weight: weightedTokenCost(tokenMix, entry.relativeTokenPrice),
  };
}
