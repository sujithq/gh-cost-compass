import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs, run, readLandedRows } from "../tools/copilot-usage/cli.mjs";
import { DAYS, ENTERPRISE_ID } from "../tools/copilot-usage/fixtures/make-fixtures.mjs";

function withTempOut(fn) {
  const dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runFixtures(outDir) {
  return run({ ...parseArgs(["--from-fixtures", "--out", outDir]) }, { log: () => {} });
}

test("parseArgs requires a window unless running from fixtures", () => {
  assert.throws(() => parseArgs([]), /--enterprise is required/);
  assert.throws(() => parseArgs(["--enterprise", "acme"]), /--start is required/);
  assert.throws(() => parseArgs(["--enterprise"]), /requires a value/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  const options = parseArgs(["--from-fixtures"]);
  assert.equal(options.fromFixtures, true);
  assert.equal(options.tokenEnv, "GITHUB_TOKEN");
});

test("a live run refuses to start without a token in the environment", async () => {
  const options = parseArgs(["--enterprise", "acme", "--start", "2026-09-16", "--end", "2026-09-18"]);
  await assert.rejects(run(options, { env: {}, log: () => {} }), /No token found in GITHUB_TOKEN/);
});

test("readLandedRows tolerates a missing day rather than throwing", () => {
  const rows = readLandedRows({ rawRoot: join(tmpdir(), "does-not-exist-copilot-usage"), days: ["2026-09-16"] });
  assert.deepEqual(rows.usageRowsByDay["2026-09-16"], []);
  assert.deepEqual(rows.userTeamRowsByDay["2026-09-16"], []);
});

test("the fixture pipeline runs end to end and every check passes", async () => {
  await withTempOut(async (dir) => {
    const result = await runFixtures(dir);
    assert.deepEqual(result.failed, [], "no allocation or invariant check may fail");
    assert.equal(result.manifest.enterprise, ENTERPRISE_ID);
    assert.equal(result.manifest.complete, true);
    assert.equal(result.manifest.days.length, DAYS.length);
    for (const name of ["report.html", "manifest.json", "environment.json", "scenario.json", "allocation.json", "model-split.json", "chargeback.csv", "allocation.csv"]) {
      assert.ok(existsSync(join(dir, name)), `${name} should be written`);
    }
  });
});

test("chargeback totals stay exact and cost-centre precedence is applied per user", async () => {
  await withTempOut(async (dir) => {
    const { chargeback } = await runFixtures(dir);
    const credits = chargeback.rows.reduce((total, row) => total + row.ai_credits_used, 0);
    assert.equal(credits, 560);

    const byUser = new Map(chargeback.rows.map((row) => [row.user_id, row]));
    // A direct user assignment outranks the team route even though alice is in team-core.
    assert.equal(byUser.get("user-alice").cost_center_id, "cc-ai");
    assert.equal(byUser.get("user-alice").attribution_route, "user");
    assert.equal(byUser.get("user-bob").attribution_route, "team");
    assert.equal(byUser.get("user-carol").attribution_route, "organization");
    // Usage that matches no cost centre is surfaced, never silently dropped.
    assert.equal(byUser.get("user-dave").cost_center_id, "unallocated");
    assert.equal(byUser.get("user-dave").attribution_route, "none");
  });
});

test("the two-driver allocation charges idle seats and conserves the invoice", async () => {
  await withTempOut(async (dir) => {
    const { allocation } = await runFixtures(dir);
    const byUser = new Map(allocation.rows.map((row) => [row.user_id, row]));

    // Enterprise and business seat-days never share a denominator.
    assert.equal(byUser.get("user-alice").tier, "enterprise");
    assert.equal(byUser.get("user-alice").seat_cost_usd.toFixed(2), "3.90");

    // The finding that credit-share-only allocation would destroy: a seat with zero usage still costs money.
    const erin = byUser.get("user-erin");
    assert.equal(erin.ai_credits_used, 0);
    assert.equal(erin.seat_cost_usd.toFixed(2), "1.90");
    assert.equal(erin.chargeback_usd.toFixed(2), "1.90");

    // A mid-period leaver is charged one seat-day, not a whole period.
    assert.equal(byUser.get("user-dave").seat_days, 1);
    assert.equal(byUser.get("user-dave").seat_cost_usd.toFixed(2), "0.63");

    // Usage sits below the included pool, so there is no metered charge to spread.
    assert.equal(allocation.invoice.meteredChargeUsd, 0);
    for (const row of allocation.rows) assert.equal(row.metered_cost_usd, 0);

    const allocated = allocation.rows.reduce((total, row) => total + row.chargeback_usd, 0);
    assert.ok(Math.abs(allocated - 9.6) < 1e-6, `allocated ${allocated} should conserve the $9.60 invoice`);
  });
});

test("the estimated model split normalizes to the exact per-user credit totals", async () => {
  await withTempOut(async (dir) => {
    const { modelSplit, chargeback } = await runFixtures(dir);
    assert.equal(modelSplit.estimated, true);

    const exact = new Map();
    for (const row of chargeback.rows) {
      exact.set(row.user_id, (exact.get(row.user_id) ?? 0) + row.ai_credits_used);
    }
    const split = new Map();
    for (const row of modelSplit.rows) {
      assert.equal(row.estimated, true, "every emitted split row must be labelled an estimate");
      split.set(row.user_id, (split.get(row.user_id) ?? 0) + row.ai_credits_used);
    }
    for (const [userId, credits] of exact) {
      assert.ok(Math.abs(split.get(userId) - credits) < 1e-6, `${userId} split must re-sum to ${credits}`);
    }
  });
});

test("the emitted environment is a valid Budget Lab environment", async () => {
  await withTempOut(async (dir) => {
    const { environment } = await runFixtures(dir);
    const { validateEnvironment } = await import("../src/environment.js");
    assert.equal(validateEnvironment(environment), null);
    assert.equal(environment.source.kind, "github-api");
  });
});

test("the report is a self-contained HTML file that labels its estimates and synthetic invoice", async () => {
  await withTempOut(async (dir) => {
    const { html } = await runFixtures(dir);
    const written = readFileSync(join(dir, "report.html"), "utf8");
    assert.equal(written, html);
    assert.match(html, /^<!doctype html>/i);
    assert.doesNotMatch(html, /<script\s+src=|<link\s+[^>]*href="http/i, "the report must not load remote assets");
    assert.match(html, /synthetic/i, "a derived invoice must be labelled synthetic");
    assert.match(html, /estimate/i, "the model split must be labelled an estimate");
    assert.match(html, /<svg/i, "the charge-flow diagram should render inline");
    assert.match(html, /erin/, "idle seats must be visible in the report");
  });
});

test("the final Sankey column label is anchored so it cannot overflow the viewBox", async () => {
  await withTempOut(async (dir) => {
    const { html } = await runFixtures(dir);
    const viewBox = html.match(/viewBox="0 0 (\d+(?:\.\d+)?) /);
    assert.ok(viewBox, "the Sankey must declare a viewBox");
    const width = Number(viewBox[1]);
    const labels = [...html.matchAll(/<text class="level-label"(?: text-anchor="(\w+)")? x="([\d.]+)"/g)];
    assert.ok(labels.length >= 2, "expected one label per Sankey level");
    const last = labels[labels.length - 1];
    assert.equal(last[1], "end", "the rightmost level label must be end-anchored");
    assert.ok(Number(last[2]) <= width, "the rightmost label anchor must sit inside the viewBox");
  });
});

test("each model appears once in the flow so its total weight reads at a glance", async () => {
  await withTempOut(async (dir) => {
    const { reportModel } = await runFixtures(dir);
    const modelNodes = reportModel.flowModel.nodes.filter((node) => node.level === 3);
    const labels = modelNodes.map((node) => node.label);
    assert.deepEqual([...new Set(labels)].sort(), [...labels].sort(), "model nodes must not be duplicated per feature");
    // The same model reached through two features must accumulate rather than split.
    const total = modelNodes.reduce((sum, node) => sum + node.value, 0);
    const featureTotal = reportModel.flowModel.nodes.filter((node) => node.level === 2).reduce((sum, node) => sum + node.value, 0);
    assert.ok(Math.abs(total - featureTotal) < 1e-6, "model level must carry the same total as the feature level");
  });
});

test("the model mix sensitivity range is populated and sums across users", async () => {
  await withTempOut(async (dir) => {
    const { html, modelSplit } = await runFixtures(dir);
    for (const row of modelSplit.rows) {
      assert.ok(row.sensitivity, "every split row should carry a sensitivity range");
      assert.ok(row.sensitivity.low <= row.sensitivity.high);
    }
    assert.doesNotMatch(html, /<td>N\/A<\/td>/, "the sensitivity column should not fall back to N/A");
    // gpt-5 chat credits come from more than one user, so the grouped range must exceed any single user's.
    const grouped = [...html.matchAll(/<td>([\d.]+)<\/td><td>\$([\d.]+)<\/td><td>\$([\d.]+)–\$([\d.]+)<\/td>/g)];
    assert.ok(grouped.length > 0, "expected grouped estimate rows with ranges");
    for (const [, , usd, lowUsd, highUsd] of grouped) {
      assert.ok(Number(lowUsd) <= Number(usd) + 0.01 && Number(highUsd) >= Number(usd) - 0.01, "the range should bracket the central estimate");
    }
    assert.match(html, /does not test the assumed relative price between models/, "the note must disclose what the sensitivity does not cover");
  });
});
