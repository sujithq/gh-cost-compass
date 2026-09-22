import { AI_CREDIT_USD, UNALLOCATED_COST_CENTER_ID, UNATTRIBUTED_MODEL } from "./contract.mjs";

const UNATTRIBUTED_FEATURE = "unattributed by feature";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function required(object, key, path) {
  if (!object || object[key] === undefined || object[key] === null) {
    throw new Error(`Missing required report field: ${path}.${key}`);
  }
  return object[key];
}

function asArray(value, path) {
  if (!Array.isArray(value)) throw new Error(`Expected ${path} to be an array.`);
  return value;
}

function numberValue(value, path) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Expected ${path} to be a finite number.`);
  return number;
}

function textValue(value, fallback = "N/A") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function money(value) {
  return `$${numberValue(value, "money").toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function credits(value) {
  return numberValue(value, "credits").toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function percent(value) {
  return `${numberValue(value, "percent").toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function splitRows(modelSplit) {
  if (!modelSplit) return [];
  if (Array.isArray(modelSplit)) return modelSplit;
  if (Array.isArray(modelSplit.rows)) return modelSplit.rows;
  if (Array.isArray(modelSplit.userRows)) return modelSplit.userRows;
  throw new Error("modelSplit must be an array or expose a rows array.");
}

function rowCredits(row, path) {
  const value = row.estimated_credits ?? row.ai_credits_used ?? row.credits ?? row.estimatedCredits;
  return numberValue(value, `${path}.estimated_credits`);
}

function rowFeature(row) {
  return textValue(row.feature ?? row.surface ?? row.feature_name, "unknown feature");
}

function rowModel(row) {
  return textValue(row.model ?? row.model_name, "unknown model");
}

function buildCoverage(manifest) {
  const days = asArray(required(manifest, "days", "manifest"), "manifest.days");
  const missing = new Set(asArray(required(manifest, "missing", "manifest"), "manifest.missing"));
  return days.map((dayRow, index) => {
    const day = required(dayRow, "day", `manifest.days[${index}]`);
    const report = dayRow.reports?.["users-1-day"];
    const ok = Boolean(report?.ok) && !missing.has(day);
    return {
      day,
      ok,
      rowCount: report?.rowCount ?? 0,
      error: ok ? "" : textValue(report?.error, missing.has(day) ? "missing day" : "report did not succeed"),
      path: textValue(report?.path, ""),
    };
  }).concat([...missing]
    .filter((day) => !days.some((dayRow) => dayRow.day === day))
    .map((day) => ({ day, ok: false, rowCount: 0, error: "missing day", path: "" })))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function costCenterName(chargebackRows, costCenterId) {
  return chargebackRows.find((row) => row.cost_center_id === costCenterId)?.cost_center_name
    ?? (costCenterId === UNALLOCATED_COST_CENTER_ID ? "Unallocated" : costCenterId);
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function addAmount(map, key, amount) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function buildUsers(allocationRows, chargebackRows) {
  const chargebackByUser = groupBy(chargebackRows, (row) => row.user_id);
  return allocationRows.map((row, index) => {
    const userId = required(row, "user_id", `allocation.rows[${index}]`);
    const dailyRows = chargebackByUser.get(userId) ?? [];
    const routes = [...new Set(dailyRows.map((dailyRow) => textValue(dailyRow.attribution_route, "none")))];
    return {
      userId,
      userLogin: required(row, "user_login", `allocation.rows[${index}]`),
      costCenterId: required(row, "cost_center_id", `allocation.rows[${index}]`),
      costCenterName: costCenterName(chargebackRows, row.cost_center_id),
      credits: numberValue(required(row, "ai_credits_used", `allocation.rows[${index}]`), `allocation.rows[${index}].ai_credits_used`),
      usageUsd: numberValue(required(row, "usage_usd", `allocation.rows[${index}]`), `allocation.rows[${index}].usage_usd`),
      seatDays: numberValue(required(row, "seat_days", `allocation.rows[${index}]`), `allocation.rows[${index}].seat_days`),
      tier: textValue(row.tier),
      seatCostUsd: numberValue(required(row, "seat_cost_usd", `allocation.rows[${index}]`), `allocation.rows[${index}].seat_cost_usd`),
      meteredCostUsd: numberValue(required(row, "metered_cost_usd", `allocation.rows[${index}]`), `allocation.rows[${index}].metered_cost_usd`),
      chargebackUsd: numberValue(required(row, "chargeback_usd", `allocation.rows[${index}]`), `allocation.rows[${index}].chargeback_usd`),
      attributionRoute: routes.length ? routes.join(", ") : "none",
    };
  });
}

function buildModelRows(users, modelSplit) {
  const sourceRows = splitRows(modelSplit);
  const byUser = groupBy(sourceRows, (row) => required(row, "user_id", "modelSplit.rows[]"));
  const output = [];

  for (const user of users) {
    let coveredCredits = 0;
    const rows = byUser.get(user.userId) ?? [];
    for (const row of rows) {
      if (row.estimated !== true) {
        throw new Error(`modelSplit row for ${user.userId} must be marked estimated: true.`);
      }
      const splitCredits = rowCredits(row, `modelSplit.rows[${output.length}]`);
      coveredCredits += splitCredits;
      output.push({
        userId: user.userId,
        userLogin: user.userLogin,
        feature: rowFeature(row),
        model: rowModel(row),
        credits: splitCredits,
        usageUsd: splitCredits * AI_CREDIT_USD,
        estimated: true,
        sensitivity: row.sensitivity ?? row.sensitivityRange ?? null,
      });
    }

    if (coveredCredits > user.credits + 1e-6) {
      throw new Error(`Estimated model split for ${user.userId} exceeds exact user credits (${coveredCredits} > ${user.credits}).`);
    }
    const remainder = Math.max(0, user.credits - coveredCredits);
    if (remainder > 1e-9) {
      output.push({
        userId: user.userId,
        userLogin: user.userLogin,
        feature: UNATTRIBUTED_FEATURE,
        model: UNATTRIBUTED_MODEL,
        credits: remainder,
        usageUsd: remainder * AI_CREDIT_USD,
        estimated: true,
        sensitivity: null,
      });
    }
  }

  return output;
}

function buildCostCenters(users) {
  return [...groupBy(users, (user) => user.costCenterId).entries()].map(([costCenterId, rows]) => ({
    costCenterId,
    costCenterName: rows[0].costCenterName,
    credits: rows.reduce((sum, row) => sum + row.credits, 0),
    usageUsd: rows.reduce((sum, row) => sum + row.usageUsd, 0),
    chargebackUsd: rows.reduce((sum, row) => sum + row.chargebackUsd, 0),
    userCount: rows.length,
  })).sort((a, b) => b.chargebackUsd - a.chargebackUsd || a.costCenterName.localeCompare(b.costCenterName));
}

function nodeId(kind, value) {
  return `${kind}:${value}`;
}

function buildFlowModel(costCenters, users, modelRows) {
  const nodes = [];
  const seen = new Set();
  const links = [];
  const addNode = (id, label, level, value, kind) => {
    if (seen.has(id)) return;
    seen.add(id);
    nodes.push({ id, label, level, value, kind });
  };

  for (const center of costCenters) {
    addNode(nodeId("cc", center.costCenterId), center.costCenterName, 0, center.usageUsd, "exact");
  }
  for (const user of users) {
    addNode(nodeId("user", user.userId), user.userLogin, 1, user.usageUsd, "exact");
    links.push({
      source: nodeId("cc", user.costCenterId),
      target: nodeId("user", user.userId),
      value: user.usageUsd,
      kind: "exact",
    });
  }

  const featureTotals = new Map();
  const modelTotals = new Map();
  for (const row of modelRows) {
    addAmount(featureTotals, row.feature, row.usageUsd);
    // One node per model, not per feature-model pair, so a model's total weight reads at a glance.
    addAmount(modelTotals, row.model, row.usageUsd);
  }
  for (const [feature, value] of featureTotals) {
    addNode(nodeId("feature", feature), feature, 2, value, "estimated");
  }
  for (const [model, value] of modelTotals) {
    addNode(nodeId("model", model), model, 3, value, "estimated");
  }
  for (const row of modelRows) {
    links.push({
      source: nodeId("user", row.userId),
      target: nodeId("feature", row.feature),
      value: row.usageUsd,
      kind: "estimated",
    }, {
      source: nodeId("feature", row.feature),
      target: nodeId("model", row.model),
      value: row.usageUsd,
      kind: "estimated",
    });
  }

  return { nodes, links, levels: ["Cost centre", "User", "Feature (estimated)", "Model (estimated)"] };
}

export function buildReportModel({ allocation, chargeback, modelSplit = [], manifest, membership = {}, period = {}, meta = {} }) {
  const invoice = required(allocation, "invoice", "allocation");
  const invoicePeriodStart = required(invoice, "period_start", "allocation.invoice");
  const invoicePeriodEnd = required(invoice, "period_end", "allocation.invoice");
  const allocationRows = asArray(required(allocation, "rows", "allocation"), "allocation.rows");
  const chargebackRows = asArray(required(chargeback, "rows", "chargeback"), "chargeback.rows");
  const checks = asArray(required(allocation, "checks", "allocation"), "allocation.checks")
    .concat(asArray(required(chargeback, "invariants", "chargeback"), "chargeback.invariants"))
    .map((check, index) => ({
      name: required(check, "name", `checks[${index}]`),
      ok: Boolean(required(check, "ok", `checks[${index}]`)),
      detail: required(check, "detail", `checks[${index}]`),
    }));
  const users = buildUsers(allocationRows, chargebackRows);
  const modelRows = buildModelRows(users, modelSplit);
  const costCenters = buildCostCenters(users);
  const coverage = buildCoverage(manifest);
  const failedChecks = checks.filter((check) => !check.ok);

  return {
    header: {
      enterprise: required(manifest, "enterprise", "manifest"),
      billingEntity: required(invoice, "billing_entity", "allocation.invoice"),
      periodStart: period.startDay ?? invoicePeriodStart,
      periodEnd: period.endDay ?? invoicePeriodEnd,
      generatedAt: meta.generatedAt ?? "not supplied",
    },
    invoice: {
      kind: required(invoice, "kind", "allocation.invoice"),
      assumptions: asArray(required(invoice, "assumptions", "allocation.invoice"), "allocation.invoice.assumptions"),
      seatChargeUsdByTier: required(invoice, "seatChargeUsdByTier", "allocation.invoice"),
      meteredChargeUsd: numberValue(required(invoice, "meteredChargeUsd", "allocation.invoice"), "allocation.invoice.meteredChargeUsd"),
    },
    pointInTimeAttribution: membership.effective_from === null || membership.effective_from === undefined,
    membership: {
      capturedAt: textValue(membership.captured_at),
      effectiveFrom: textValue(membership.effective_from, "unknown"),
    },
    coverage: {
      complete: Boolean(required(manifest, "complete", "manifest")),
      daysRequested: `${required(manifest, "startDay", "manifest")} to ${required(manifest, "endDay", "manifest")}`,
      days: coverage,
      gaps: coverage.filter((day) => !day.ok),
    },
    checks,
    failedChecks,
    hasFailedChecks: failedChecks.length > 0,
    costCenters,
    users,
    modelMix: {
      rows: modelRows,
      sensitivityNote: textValue(meta.sensitivityNote, ""),
    },
    flowModel: buildFlowModel(costCenters, users, modelRows),
    totals: allocation.totals ?? {},
  };
}

function linkKey(link, index) {
  return `${link.source}->${link.target}:${index}`;
}

export function renderSankeySvg(flowModel) {
  const nodes = asArray(required(flowModel, "nodes", "flowModel"), "flowModel.nodes");
  const links = asArray(required(flowModel, "links", "flowModel"), "flowModel.links");
  const levels = flowModel.levels ?? ["Cost centre", "User", "Feature", "Model"];
  const width = 1120;
  const margin = { top: 54, right: 36, bottom: 42, left: 36 };
  const nodeWidth = 18;
  const levelCount = Math.max(...nodes.map((node) => node.level)) + 1;
  const maxPerLevel = Math.max(...Array.from({ length: levelCount }, (_, level) => nodes.filter((node) => node.level === level).length), 1);
  const height = Math.max(420, margin.top + margin.bottom + maxPerLevel * 82);
  const innerHeight = height - margin.top - margin.bottom;
  const byId = new Map(nodes.map((node) => [node.id, { ...node, in: 0, out: 0 }]));
  for (const link of links) {
    if (!byId.has(link.source) || !byId.has(link.target)) throw new Error(`Sankey link references an unknown node: ${link.source} -> ${link.target}`);
    byId.get(link.source).out += numberValue(link.value, "flowModel.links[].value");
    byId.get(link.target).in += numberValue(link.value, "flowModel.links[].value");
  }
  for (const node of byId.values()) {
    node.computedValue = Math.max(Number(node.value ?? 0), node.in, node.out);
  }
  const levelTotals = Array.from({ length: levelCount }, (_, level) => [...byId.values()]
    .filter((node) => node.level === level)
    .reduce((sum, node) => sum + node.computedValue, 0));
  const maxTotal = Math.max(...levelTotals, 1);
  const scale = Math.min(42, innerHeight / maxTotal);
  const xStep = (width - margin.left - margin.right - nodeWidth) / Math.max(1, levelCount - 1);
  const positioned = new Map();

  for (let level = 0; level < levelCount; level += 1) {
    const levelNodes = [...byId.values()].filter((node) => node.level === level)
      .sort((a, b) => b.computedValue - a.computedValue || a.label.localeCompare(b.label));
    const totalHeight = levelNodes.reduce((sum, node) => sum + Math.max(8, node.computedValue * scale), 0);
    const gap = levelNodes.length > 1 ? Math.min(34, Math.max(14, (innerHeight - totalHeight) / (levelNodes.length - 1))) : 0;
    let y = margin.top + Math.max(0, (innerHeight - totalHeight - gap * (levelNodes.length - 1)) / 2);
    for (const node of levelNodes) {
      const nodeHeight = Math.max(8, node.computedValue * scale);
      positioned.set(node.id, { ...node, x: margin.left + level * xStep, y, height: nodeHeight });
      y += nodeHeight + gap;
    }
  }

  const sourceOffsets = new Map();
  const targetOffsets = new Map();
  const paths = links.map((link, index) => {
    const source = positioned.get(link.source);
    const target = positioned.get(link.target);
    const thickness = Math.max(1, numberValue(link.value, "flowModel.links[].value") * scale);
    const sourceOffset = sourceOffsets.get(source.id) ?? 0;
    const targetOffset = targetOffsets.get(target.id) ?? 0;
    sourceOffsets.set(source.id, sourceOffset + thickness);
    targetOffsets.set(target.id, targetOffset + thickness);
    const x1 = source.x + nodeWidth;
    const y1 = source.y + sourceOffset + thickness / 2;
    const x2 = target.x;
    const y2 = target.y + targetOffset + thickness / 2;
    const cx = (x2 - x1) * 0.52;
    const className = link.kind === "estimated" ? "estimated-link" : "exact-link";
    return `<path class="${className}" d="M ${x1.toFixed(2)} ${y1.toFixed(2)} C ${(x1 + cx).toFixed(2)} ${y1.toFixed(2)}, ${(x2 - cx).toFixed(2)} ${y2.toFixed(2)}, ${x2.toFixed(2)} ${y2.toFixed(2)}" stroke-width="${thickness.toFixed(2)}" data-link="${escapeHtml(linkKey(link, index))}" data-source="${escapeHtml(link.source)}" data-target="${escapeHtml(link.target)}" data-value="${link.value.toFixed(6)}" data-thickness="${thickness.toFixed(6)}"><title>${escapeHtml(source.label)} → ${escapeHtml(target.label)}: ${escapeHtml(money(link.value))} ${escapeHtml(link.kind)}</title></path>`;
  }).join("");
  const nodeMarkup = [...positioned.values()].map((node) => {
    const labelX = node.level === levelCount - 1 ? node.x - 8 : node.x + nodeWidth + 8;
    const anchor = node.level === levelCount - 1 ? "end" : "start";
    const labelY = node.y + Math.max(12, node.height / 2);
    const className = node.kind === "estimated" ? "estimated-node" : "exact-node";
    return `<g class="sankey-node ${className}" data-node="${escapeHtml(node.id)}" data-level="${escapeHtml(node.level)}" data-value="${node.computedValue.toFixed(6)}" data-height="${node.height.toFixed(6)}"><rect x="${node.x.toFixed(2)}" y="${node.y.toFixed(2)}" width="${nodeWidth}" height="${node.height.toFixed(2)}" rx="5"></rect><text x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="${anchor}">${escapeHtml(node.label)}</text><title>${escapeHtml(node.label)}: ${escapeHtml(money(node.computedValue))}</title></g>`;
  }).join("");
  const labels = levels.map((label, index) => {
    const isLast = index === levelCount - 1;
    const x = margin.left + index * xStep + (isLast ? nodeWidth : 0);
    const anchor = isLast ? "end" : "start";
    return `<text class="level-label" text-anchor="${anchor}" x="${x.toFixed(2)}" y="26">${escapeHtml(label)}</text>`;
  }).join("");
  const boundaryX = margin.left + 1.5 * xStep + nodeWidth / 2;

  return `<svg class="chargeback-sankey" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="sankey-title sankey-desc" data-scale="${scale.toFixed(6)}"><title id="sankey-title">Copilot chargeback flow with exact and estimated boundary</title><desc id="sankey-desc">Cost centre to user is exact usage-valued consumption. User to feature to model is estimated and includes unattributed by model buckets.</desc><defs><pattern id="estimated-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#8b949e" stroke-width="3"></line></pattern></defs><style>.chargeback-sankey{max-width:100%;height:auto;background:#0d1117;border:1px solid #30363d;border-radius:14px}.level-label{fill:#8b949e;font:700 12px system-ui,-apple-system,Segoe UI,sans-serif;text-transform:uppercase;letter-spacing:.08em}.exact-link{fill:none;stroke:#58a6ff;stroke-linecap:round;opacity:.58}.estimated-link{fill:none;stroke:#d2a8ff;stroke-linecap:round;stroke-dasharray:8 7;opacity:.36}.exact-node rect{fill:#1f6feb}.estimated-node rect{fill:url(#estimated-hatch);stroke:#d2a8ff;stroke-width:1}.sankey-node text{fill:#e6edf3;font:600 12px system-ui,-apple-system,Segoe UI,sans-serif}.boundary{stroke:#f2cc60;stroke-width:2;stroke-dasharray:6 6}.boundary-label{fill:#f2cc60;font:700 12px system-ui,-apple-system,Segoe UI,sans-serif}</style>${labels}<line class="boundary" x1="${boundaryX.toFixed(2)}" y1="38" x2="${boundaryX.toFixed(2)}" y2="${(height - 24).toFixed(2)}"></line><text class="boundary-label" x="${(boundaryX + 10).toFixed(2)}" y="${(height - 30).toFixed(2)}">Exactness boundary: downstream is estimated</text><g class="links">${paths}</g><g class="nodes">${nodeMarkup}</g></svg>`;
}

function renderRows(rows, renderRow) {
  return rows.map(renderRow).join("");
}

function renderSyntheticBanner(model) {
  if (model.invoice.kind !== "synthetic") return "";
  return `<section class="banner banner-warning"><h2>Illustrative allocated chargeback (synthetic invoice)</h2><p>This report validates the allocation mechanics, but these figures are not reconciled to a real Azure invoice.</p><ul>${renderRows(model.invoice.assumptions, (assumption) => `<li>${escapeHtml(assumption)}</li>`)}</ul></section>`;
}

function renderFailureBanner(model) {
  if (!model.hasFailedChecks) return "";
  return `<section class="banner banner-danger"><h2>Conservation check failed — do not use this report for chargeback</h2><p>At least one invariant failed, so the report is intentionally rendered in a loud failure state.</p><ul>${renderRows(model.failedChecks, (check) => `<li><strong>${escapeHtml(check.name)}</strong>: ${escapeHtml(check.detail)}</li>`)}</ul></section>`;
}

function renderPointInTimeBanner(model) {
  if (!model.pointInTimeAttribution) return "";
  return `<section class="banner banner-info"><h2>Point-in-time cost-centre attribution</h2><p>The membership snapshot has no known effective_from date. Cost-centre totals use the captured snapshot (${escapeHtml(model.membership.capturedAt)}) and are not historically proven.</p></section>`;
}

function renderCoverage(model) {
  return `<section class="panel"><div class="panel-head"><h2>Data coverage</h2><span class="${model.coverage.complete ? "pill good" : "pill bad"}">${escapeHtml(model.coverage.complete ? "complete" : "gaps present")}</span></div><p>Requested days: <strong>${escapeHtml(model.coverage.daysRequested)}</strong>. Missing days are explicit gaps, not zero usage.</p><div class="coverage-grid">${renderRows(model.coverage.days, (day) => `<div class="coverage-day ${day.ok ? "ok" : "gap"}"><strong>${escapeHtml(day.day)}</strong><span>${escapeHtml(day.ok ? `${day.rowCount} rows` : `GAP: ${day.error}`)}</span></div>`)}</div></section>`;
}

function renderChecks(model) {
  return `<section class="panel ${model.hasFailedChecks ? "panel-failure" : ""}"><div class="panel-head"><h2>Conservation and invariants</h2><span class="${model.hasFailedChecks ? "pill bad" : "pill good"}">${escapeHtml(model.hasFailedChecks ? "failed" : "passed")}</span></div><table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${renderRows(model.checks, (check) => `<tr><td>${escapeHtml(check.name)}</td><td><span class="${check.ok ? "status-pass" : "status-fail"}">${escapeHtml(check.ok ? "PASS" : "FAIL")}</span></td><td>${escapeHtml(check.detail)}</td></tr>`)}</tbody></table></section>`;
}

function renderCostCenterSummary(model) {
  return `<section class="panel"><h2>Cost-centre summary</h2><table><thead><tr><th>Cost centre</th><th>Credits</th><th>usage_usd exact</th><th>chargeback_usd allocated</th><th>Users</th></tr></thead><tbody>${renderRows(model.costCenters, (row) => `<tr><td>${escapeHtml(row.costCenterName)}</td><td>${escapeHtml(credits(row.credits))}</td><td>${escapeHtml(money(row.usageUsd))}</td><td>${escapeHtml(money(row.chargebackUsd))}</td><td>${escapeHtml(row.userCount)}</td></tr>`)}</tbody></table></section>`;
}

function userUnattributedCredits(model, userId) {
  return model.modelMix.rows
    .filter((row) => row.userId === userId && row.model === UNATTRIBUTED_MODEL)
    .reduce((sum, row) => sum + row.credits, 0);
}

function renderUsers(model) {
  return `<section class="panel"><h2>Per-user drill-down</h2><p>Both measures are shown side by side: usage_usd is exact consumption value; chargeback_usd is the allocated share of the fully-loaded invoice.</p><table><thead><tr><th>User</th><th>Cost centre</th><th>Credits</th><th>usage_usd</th><th>chargeback_usd</th><th>Gap</th><th>seat_days</th><th>tier</th><th>attribution_route</th><th>Unattributed by model</th></tr></thead><tbody>${renderRows(model.users, (row) => `<tr><td>${escapeHtml(row.userLogin)}</td><td>${escapeHtml(row.costCenterName)}</td><td>${escapeHtml(credits(row.credits))}</td><td>${escapeHtml(money(row.usageUsd))}</td><td>${escapeHtml(money(row.chargebackUsd))}</td><td>${escapeHtml(money(row.chargebackUsd - row.usageUsd))}</td><td>${escapeHtml(row.seatDays)}</td><td>${escapeHtml(row.tier)}</td><td>${escapeHtml(row.attributionRoute)}</td><td>${escapeHtml(credits(userUnattributedCredits(model, row.userId)))}</td></tr>`)}</tbody></table></section>`;
}

/** A grouped row's range is the sum of its members' ranges, not any single member's. */
function sumSensitivity(rows) {
  const present = rows.filter((row) => row.sensitivity);
  if (present.length === 0) return null;
  let low = 0;
  let high = 0;
  for (const row of rows) {
    const range = row.sensitivity;
    low += Number(range?.low ?? range?.min ?? row.usageUsd ?? 0);
    high += Number(range?.high ?? range?.max ?? row.usageUsd ?? 0);
  }
  return { low, high };
}

function renderModelMix(model) {
  const totals = [...groupBy(model.modelMix.rows, (row) => `${row.feature}\u0000${row.model}`).entries()]
    .map(([key, rows]) => {
      const [feature, modelName] = key.split("\u0000");
      return {
        feature,
        model: modelName,
        credits: rows.reduce((sum, row) => sum + row.credits, 0),
        usageUsd: rows.reduce((sum, row) => sum + row.usageUsd, 0),
        sensitivity: sumSensitivity(rows),
      };
    })
    .sort((a, b) => b.usageUsd - a.usageUsd || a.feature.localeCompare(b.feature) || a.model.localeCompare(b.model));
  return `<section class="panel estimate-panel"><div class="panel-head"><h2>Model mix estimate</h2><span class="pill estimate">estimated</span></div><p>This panel estimates the split of exact user credits by feature and model. It shows which model was used for which feature, but not how complex the task was; “expensive model on a trivial task” is a hypothesis to review, not a proven conclusion.</p>${model.modelMix.sensitivityNote ? `<p class="note">${escapeHtml(model.modelMix.sensitivityNote)}</p>` : ""}<table><thead><tr><th>Feature</th><th>Model</th><th>Estimated credits</th><th>Estimated usage_usd</th><th>Sensitivity range</th></tr></thead><tbody>${renderRows(totals, (row) => `<tr><td>${escapeHtml(row.feature)}</td><td>${escapeHtml(row.model)}</td><td>${escapeHtml(credits(row.credits))}</td><td>${escapeHtml(money(row.usageUsd))}</td><td>${escapeHtml(row.sensitivity ? `${money(row.sensitivity.low ?? row.sensitivity.min ?? 0)}–${money(row.sensitivity.high ?? row.sensitivity.max ?? 0)}` : "N/A")}</td></tr>`)}</tbody></table></section>`;
}

function renderSankey(model) {
  return `<section class="panel sankey-panel"><div class="panel-head"><h2>Charge breakdown flow</h2><span class="pill exact">exact → estimated</span></div><div class="legend"><span><i class="legend-solid"></i>Exact: cost centre → user, based on ai_credits_used × $0.01</span><span><i class="legend-hatched"></i>Estimated: user → feature → model; includes explicit “${escapeHtml(UNATTRIBUTED_MODEL)}” where model attribution is incomplete</span></div>${renderSankeySvg(model.flowModel)}</section>`;
}

function renderFooter() {
  return `<footer><h2>Methodology</h2><p>Formula: usage_usd = ai_credits_used × $0.01. chargeback_usd = seat charge allocated by tier seat-days + metered AI-credit charge allocated by each user's credit share. Cost-centre to user is exact usage-valued consumption; model and feature splits are estimated from model-feature interaction data and may include unattributed usage.</p><p>Methodology reference: docs/copilot-usage-metrics-api-investigation.md</p></footer>`;
}

function styles() {
  return `<style>
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--panel2:#0d1117;--text:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#58a6ff;--purple:#d2a8ff;--green:#3fb950;--yellow:#f2cc60;--red:#ff7b72;--shadow:0 20px 40px rgba(1,4,9,.35)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1240px;margin:0 auto;padding:32px 24px 48px}.hero{display:grid;gap:8px;margin-bottom:22px}.eyebrow{margin:0;color:var(--purple);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1{font-size:34px;line-height:1.1;margin:0}h2{font-size:18px;margin:0 0 12px}p{color:var(--muted)}.meta{display:flex;gap:10px;flex-wrap:wrap}.meta span,.pill{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:5px 10px;color:var(--muted);background:var(--panel2);font-size:12px;font-weight:700}.panel,.banner,footer{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:18px;margin:16px 0}.banner{border-width:2px}.banner-warning{border-color:var(--yellow);background:linear-gradient(135deg,rgba(242,204,96,.15),var(--panel))}.banner-danger,.panel-failure{border-color:var(--red);background:linear-gradient(135deg,rgba(255,123,114,.18),var(--panel))}.banner-info{border-color:var(--accent);background:linear-gradient(135deg,rgba(88,166,255,.14),var(--panel))}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.pill.good{color:var(--green);border-color:rgba(63,185,80,.6)}.pill.bad{color:var(--red);border-color:rgba(255,123,114,.6)}.pill.estimate{color:var(--purple);border-color:rgba(210,168,255,.6)}.pill.exact{color:var(--yellow);border-color:rgba(242,204,96,.6)}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{padding:10px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.status-pass{color:var(--green);font-weight:800}.status-fail{color:var(--red);font-weight:800}.coverage-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.coverage-day{border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--panel2)}.coverage-day strong,.coverage-day span{display:block}.coverage-day span{color:var(--muted);font-size:12px}.coverage-day.gap{border-color:var(--red)}.legend{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0 14px;color:var(--muted)}.legend span{display:flex;align-items:center;gap:8px}.legend i{width:28px;height:10px;border-radius:999px;display:inline-block}.legend-solid{background:#58a6ff}.legend-hatched{background:repeating-linear-gradient(45deg,#d2a8ff,#d2a8ff 3px,transparent 3px,transparent 7px);border:1px solid #d2a8ff}.note{padding:10px;border:1px solid rgba(210,168,255,.5);border-radius:10px;background:rgba(210,168,255,.08)}footer{color:var(--muted)}@media print{body{background:#fff;color:#111}main{max-width:none;padding:12px}.panel,.banner,footer{box-shadow:none;break-inside:avoid}.chargeback-sankey{background:#fff!important}}@media(max-width:800px){.grid{grid-template-columns:1fr}table{font-size:12px}}
</style>`;
}

export function renderReport(model) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.header.enterprise)} Copilot chargeback report</title>
${styles()}
</head>
<body class="${model.hasFailedChecks ? "failure-state" : ""}">
<main>
<header class="hero">
<p class="eyebrow">Copilot Budget Lab chargeback report</p>
<h1>${escapeHtml(model.header.enterprise)}</h1>
<div class="meta"><span>Billing entity: ${escapeHtml(model.header.billingEntity)}</span><span>Window: ${escapeHtml(model.header.periodStart)} to ${escapeHtml(model.header.periodEnd)}</span><span>Generated: ${escapeHtml(model.header.generatedAt)}</span></div>
</header>
${renderFailureBanner(model)}
${renderSyntheticBanner(model)}
${renderPointInTimeBanner(model)}
<div class="grid">${renderCoverage(model)}${renderChecks(model)}</div>
${renderSankey(model)}
${renderCostCenterSummary(model)}
${renderUsers(model)}
${renderModelMix(model)}
${renderFooter()}
</main>
</body>
</html>`;
}
