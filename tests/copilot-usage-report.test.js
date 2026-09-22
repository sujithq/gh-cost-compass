import test from "node:test";
import assert from "node:assert/strict";
import { UNATTRIBUTED_MODEL } from "../tools/copilot-usage/contract.mjs";
import { buildReportModel, escapeHtml, renderReport, renderSankeySvg } from "../tools/copilot-usage/report.mjs";

const hostileLogin = "</script><img src=x onerror=alert(1)>";

function fixture(overrides = {}) {
  const allocation = {
    invoice: {
      billing_entity: "ent-1",
      period_start: "2026-09-01",
      period_end: "2026-09-02",
      kind: "synthetic",
      assumptions: ["2 Enterprise seat-days at list price", "metered charge derived from observed overage"],
      seatChargeUsdByTier: { enterprise: 2.60 },
      meteredChargeUsd: 7.40,
    },
    rows: [
      {
        user_id: "u1",
        user_login: hostileLogin,
        cost_center_id: "cc-ai",
        ai_credits_used: 100,
        usage_usd: 1,
        seat_days: 2,
        tier: "enterprise",
        seat_cost_usd: 2.6,
        metered_cost_usd: 7.4,
        chargeback_usd: 10,
      },
      {
        user_id: "u2",
        user_login: "alex",
        cost_center_id: "cc-core",
        ai_credits_used: 40,
        usage_usd: 0.4,
        seat_days: 0,
        tier: null,
        seat_cost_usd: 0,
        metered_cost_usd: 0,
        chargeback_usd: 0,
      },
    ],
    totals: { usage_usd: 1.4, chargeback_usd: 10 },
    checks: [{ name: "invoice conservation", ok: true, detail: "allocated total equals invoice" }],
  };
  const chargeback = {
    rows: [
      {
        day: "2026-09-01",
        user_id: "u1",
        user_login: hostileLogin,
        cost_center_id: "cc-ai",
        cost_center_name: "AI Platform",
        organization_id: "org-1",
        attribution_route: "user",
        ai_credits_used: 60,
        usage_usd: 0.6,
      },
      {
        day: "2026-09-02",
        user_id: "u1",
        user_login: hostileLogin,
        cost_center_id: "cc-ai",
        cost_center_name: "AI Platform",
        organization_id: "org-1",
        attribution_route: "team",
        ai_credits_used: 40,
        usage_usd: 0.4,
      },
      {
        day: "2026-09-01",
        user_id: "u2",
        user_login: "alex",
        cost_center_id: "cc-core",
        cost_center_name: "Core Tools",
        organization_id: "org-2",
        attribution_route: "none",
        ai_credits_used: 40,
        usage_usd: 0.4,
      },
    ],
    invariants: [{ name: "daily source conservation", ok: true, detail: "allocated plus unallocated equals source" }],
  };
  const modelSplit = {
    rows: [
      { user_id: "u1", feature: "chat", model: "gpt-5", estimated_credits: 60, estimated: true, sensitivity: { low: 0.45, high: 0.75 } },
      { user_id: "u2", feature: "code review", model: "claude", estimated_credits: 40, estimated: true },
    ],
  };
  const manifest = {
    enterprise: "Contoso <Enterprise>",
    startDay: "2026-09-01",
    endDay: "2026-09-02",
    days: [
      { day: "2026-09-01", reports: { "users-1-day": { ok: true, rowCount: 2, path: "raw/day=2026-09-01/users.ndjson" } } },
      { day: "2026-09-02", reports: { "users-1-day": { ok: false, rowCount: 0, error: "download failed", path: "" } } },
    ],
    complete: false,
    missing: ["2026-09-02"],
  };
  const base = {
    allocation,
    chargeback,
    modelSplit,
    manifest,
    membership: { captured_at: "2026-09-03T10:00:00Z", effective_from: null, cost_centers: [] },
    period: { startDay: "2026-09-01", endDay: "2026-09-02" },
    meta: { generatedAt: "2026-09-22T15:00:00Z", sensitivityNote: "Assumes 2k input and 1k output tokens per interaction." },
  };
  return {
    ...base,
    ...overrides,
    allocation: { ...allocation, ...(overrides.allocation ?? {}), invoice: { ...allocation.invoice, ...(overrides.allocation?.invoice ?? {}) } },
    chargeback: { ...chargeback, ...(overrides.chargeback ?? {}) },
    manifest: { ...manifest, ...(overrides.manifest ?? {}) },
    membership: { ...base.membership, ...(overrides.membership ?? {}) },
    meta: { ...base.meta, ...(overrides.meta ?? {}) },
  };
}

function renderFixture(overrides) {
  return renderReport(buildReportModel(fixture(overrides)));
}

test("rendered report is self-contained and has no external asset hooks", () => {
  const html = renderFixture();
  assert.doesNotMatch(html, /<(script|link)\b[^>]*(src|href)=/i);
  assert.doesNotMatch(html, /<link\b[^>]*rel=["']?stylesheet/i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /\b(?:src|href)=["'][^"']*https?:\/\//i);
  assert.doesNotMatch(html, /url\(\s*["']?https?:\/\//i);
});

test("escapeHtml neutralizes hostile external values end to end", () => {
  assert.equal(escapeHtml(hostileLogin), "&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
  const html = renderFixture();
  assert.doesNotMatch(html, /<\/script><img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("synthetic invoice renders illustrative banner and actual invoice suppresses it", () => {
  const synthetic = renderFixture();
  assert.match(synthetic, /Illustrative allocated chargeback \(synthetic invoice\)/);
  assert.match(synthetic, /2 Enterprise seat-days at list price/);

  const actual = renderFixture({ allocation: { invoice: { kind: "actual", assumptions: [] } } });
  assert.doesNotMatch(actual, /Illustrative allocated chargeback \(synthetic invoice\)/);
});

test("point-in-time attribution warning is rendered", () => {
  const html = renderFixture({ membership: { effective_from: null } });
  assert.match(html, /Point-in-time cost-centre attribution/);
  assert.match(html, /not historically proven/);
});

test("failed conservation check renders loud failure state", () => {
  const input = fixture();
  input.allocation.checks = [{ name: "invoice conservation", ok: false, detail: "off by $1.00" }];
  const html = renderReport(buildReportModel(input));
  assert.match(html, /Conservation check failed/);
  assert.match(html, /do not use this report for chargeback/);
  assert.match(html, /status-fail/);
});

test("manifest missing day is rendered as an explicit gap", () => {
  const html = renderFixture();
  assert.match(html, /2026-09-02/);
  assert.match(html, /GAP: download failed|GAP: missing day/);
  assert.match(html, /gaps present/);
});

test("model builder and Sankey include unattributed by model remainder", () => {
  const model = buildReportModel(fixture());
  const row = model.modelMix.rows.find((entry) => entry.userId === "u1" && entry.model === UNATTRIBUTED_MODEL);
  assert.ok(row);
  assert.equal(row.credits, 40);
  const svg = renderSankeySvg(model.flowModel);
  assert.match(svg, /unattributed by model/);
});

test("Sankey geometry exposes correct node values and proportional link thickness", () => {
  const svg = renderSankeySvg({
    levels: ["A", "B", "C", "D"],
    nodes: [
      { id: "cc:a", label: "A", level: 0, value: 12, kind: "exact" },
      { id: "user:a", label: "User", level: 1, value: 12, kind: "exact" },
      { id: "feature:chat", label: "Chat", level: 2, value: 12, kind: "estimated" },
      { id: "model:gpt", label: "GPT", level: 3, value: 9, kind: "estimated" },
      { id: "model:mini", label: "Mini", level: 3, value: 3, kind: "estimated" },
    ],
    links: [
      { source: "cc:a", target: "user:a", value: 12, kind: "exact" },
      { source: "user:a", target: "feature:chat", value: 12, kind: "estimated" },
      { source: "feature:chat", target: "model:gpt", value: 9, kind: "estimated" },
      { source: "feature:chat", target: "model:mini", value: 3, kind: "estimated" },
    ],
  });
  const featureValue = Number(svg.match(/data-node="feature:chat"[^>]*data-value="([^"]+)"/)[1]);
  const gptThickness = Number(svg.match(/data-target="model:gpt"[^>]*data-value="9\.000000"[^>]*data-thickness="([^"]+)"/)[1]);
  const miniThickness = Number(svg.match(/data-target="model:mini"[^>]*data-value="3\.000000"[^>]*data-thickness="([^"]+)"/)[1]);
  assert.equal(featureValue, 12);
  assert.equal(gptThickness / miniThickness, 3);
});

test("report shows usage_usd and chargeback_usd where they differ", () => {
  const html = renderFixture();
  assert.match(html, /usage_usd/);
  assert.match(html, /chargeback_usd/);
  assert.match(html, /\$1\.00/);
  assert.match(html, /\$10\.00/);
  assert.match(html, /\$9\.00/);
});

test("rendering is deterministic for fixed input", () => {
  const input = buildReportModel(fixture());
  assert.equal(renderReport(input), renderReport(input));
});
