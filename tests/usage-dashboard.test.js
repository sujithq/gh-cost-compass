import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { parseEnterpriseUsageNdjson, summarizeEnterpriseUsage } from "../src/tokenomics-insights.js";
import { createHash } from "node:crypto";
import { claimWorkdir, CSP, UPSTREAM } from "../tools/vendor-copilot-usage-viewer.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

test("usage dashboard is optional, local, and isolated from the Budget Lab origin", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("src/app.js", root), "utf8"),
  ]);
  assert.match(html, /id="open-usage-dashboard"/);
  assert.match(html, /id="close-usage-dashboard"[^>]*hidden/);
  assert.match(html, /id="usage-dashboard-status"[^>]*role="status"/);
  assert.match(html, /imports are not shared with Budget Lab/);
  const insights = html.match(/<section id="insights"[\s\S]*?<\/section>/)?.[0];
  assert.ok(insights);
  assert.doesNotMatch(insights, /<iframe\b/);
  assert.match(app, /frame\.setAttribute\("sandbox", "allow-scripts allow-downloads"\)/);
  assert.match(app, /frame\.referrerPolicy = "no-referrer"/);
  assert.match(app, /src\/vendor\/copilot-usage-viewer\/index\.html/);
  assert.doesNotMatch(app, /frame\.(?:src|srcdoc)\s*=\s*["`]https?:/);
  assert.match(app, /container\.replaceChildren\(\)/);
  assert.match(app, /closeUsageDashboard\(false\)/);
});

test("usage dashboard keeps billing and productivity limitations visible", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.match(html, /downloads may include user data/);
  assert.match(html, /not productivity measures/);
  assert.match(html, /cost estimates are not an invoice/);
});

async function dashboardHarness(fetch) {
  const app = await readFile(new URL("src/app.js", root), "utf8");
  const source = app.slice(app.indexOf("let usageDashboardRequest = null;"), app.indexOf('$("#import-enterprise-usage").addEventListener'));
  assert.ok(source.startsWith("let usageDashboardRequest"));
  const elements = new Map();
  const toasts = [];
  function element() {
    return {
      hidden: false,
      disabled: false,
      textContent: "",
      attributes: {},
      listeners: {},
      children: [],
      get childElementCount() { return this.children.length; },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      focus() {},
      append(child) { child.parentElement = this; this.children.push(child); },
      replaceChildren() {
        for (const child of this.children) child.parentElement = null;
        this.children = [];
      },
    };
  }
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  runInNewContext(source, {
    $, document: { createElement: element }, fetch, AbortController,
    setTimeout: () => 1, clearTimeout() {},
    showToast: (...args) => toasts.push(args),
  });
  return {
    $, toasts,
    open: () => $("#open-usage-dashboard").listeners.click(),
    close: () => $("#close-usage-dashboard").listeners.click(),
  };
}

test("dashboard opening is lazy, duplicate-safe, and resetting removes the imported frame", async () => {
  let requests = 0;
  const harness = await dashboardHarness(async (url, options) => {
    requests += 1;
    assert.equal(url, "src/vendor/copilot-usage-viewer/index.html");
    assert.equal(options.credentials, "omit");
    return { ok: true, headers: new Headers({ "content-type": "text/html; charset=utf-8" }) };
  });
  assert.equal(requests, 0);
  await harness.open();
  const container = harness.$("#usage-dashboard-frame");
  const frame = container.children[0];
  assert.equal(container.childElementCount, 1);
  assert.equal(frame.attributes.sandbox, "allow-scripts allow-downloads");
  assert.equal(frame.referrerPolicy, "no-referrer");
  await harness.open();
  assert.equal(requests, 1);
  frame.listeners.load();
  assert.equal(container.attributes["aria-busy"], "false");
  harness.close();
  assert.equal(container.childElementCount, 0);
  assert.equal(container.hidden, true);
  assert.equal(harness.$("#open-usage-dashboard").disabled, false);
  await harness.open();
  assert.notEqual(container.children[0], frame);
  assert.equal(requests, 2);
  harness.close();
});

test("missing dashboard assets report failure instead of opening a success-shaped frame", async () => {
  const harness = await dashboardHarness(async () => ({ ok: false, status: 404 }));
  await harness.open();
  assert.equal(harness.$("#usage-dashboard-frame").childElementCount, 0);
  assert.match(harness.$("#usage-dashboard-status").textContent, /Dashboard error:.*HTTP 404/);
  assert.equal(harness.$("#open-usage-dashboard").disabled, false);
  assert.equal(harness.toasts[0][1].tone, "danger");
});

test("dashboard rejects non-HTML responses and exposes network errors", async () => {
  const cases = [
    {
      fetch: async () => ({ ok: true, headers: new Headers({ "content-type": "application/json" }) }),
      message: /did not return an HTML document/,
    },
    {
      fetch: async () => { throw new Error("Connection unavailable"); },
      message: /Connection unavailable/,
    },
  ];
  for (const scenario of cases) {
    const harness = await dashboardHarness(scenario.fetch);
    await harness.open();
    assert.equal(harness.$("#usage-dashboard-frame").childElementCount, 0);
    assert.match(harness.$("#usage-dashboard-status").textContent, scenario.message);
    assert.equal(harness.toasts[0][1].tone, "danger");
  }
});

test("closing during loading prevents a stale fetch from remounting the dashboard", async () => {
  let resolveFetch;
  let signal;
  const harness = await dashboardHarness((_url, options) => {
    signal = options.signal;
    return new Promise((resolve) => { resolveFetch = resolve; });
  });
  const opening = harness.open();
  harness.close();
  assert.equal(signal.aborted, true);
  resolveFetch({ ok: true, headers: new Headers({ "content-type": "text/html" }) });
  await opening;
  assert.equal(harness.$("#usage-dashboard-frame").childElementCount, 0);
  assert.equal(harness.$("#usage-dashboard-frame").hidden, true);
});

test("dashboard smoke fixture preserves the original Budget Lab import contract", async () => {
  const text = await readFile(new URL("tests/fixtures/usage-dashboard.ndjson", root), "utf8");
  const rows = parseEnterpriseUsageNdjson(text);
  const summary = summarizeEnterpriseUsage(rows);
  assert.equal(summary.userCount, 4);
  assert.equal(summary.rowCount, 4);
  assert.equal(summary.credits, 1000);
  assert.equal(summary.interactions, 10);
  assert.equal(summary.generations, 20);
  assert.equal(summary.acceptances, 10);
  assert.equal(summary.acceptanceRate, 0.5);
  assert.deepEqual(rows.map((row) => row.ai_adoption_phase.phase_number), [0, 1, 2, 3]);
});

test("vendored dashboard provenance pins MIT source and verifies shipped files", async () => {
  const directory = new URL("src/vendor/copilot-usage-viewer/", root);
  const provenance = JSON.parse(await readFile(new URL("PROVENANCE.json", directory), "utf8"));
  assert.equal(provenance.sourceUrl, UPSTREAM.repository);
  assert.equal(provenance.sourceCommit, UPSTREAM.commit);
  assert.equal(provenance.license, "MIT");
  for (const [file, hash] of Object.entries(provenance.files)) {
    const content = await readFile(new URL(file, directory));
    assert.equal(createHash("sha256").update(content).digest("hex"), hash, file);
  }
  const generator = await readFile(new URL("tools/vendor-copilot-usage-viewer.mjs", root), "utf8");
  assert.equal(createHash("sha256").update(generator.replace(/\r\n/g, "\n")).digest("hex"), provenance.generatorSha256);
  const license = await readFile(new URL("LICENSE", directory), "utf8");
  assert.match(license, /Copyright \(c\) 2025 asizikov-demos/);
  assert.match(license, /Permission is hereby granted/);
});

test("vendored dashboard blocks network and persistence without disabling the parsing worker", async () => {
  const html = await readFile(new URL("src/vendor/copilot-usage-viewer/index.html", root), "utf8");
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`));
  assert.ok(CSP.includes("connect-src 'none'"));
  assert.ok(CSP.includes("worker-src blob:"));
  assert.ok(!CSP.includes("'unsafe-eval'"));
  assert.doesNotMatch(html, /<script[^>]+\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link[^>]+\brel=["']stylesheet/i);
  assert.doesNotMatch(html, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\b(?:localStorage|sessionStorage|indexedDB)\b/);
  assert.doesNotMatch(html, /\beval\s*\(|new Function\s*\(/);
  assert.match(html, /new Worker\(/);
  assert.match(html, /createObjectURL/);
  assert.match(html, /vendored-sample-report/);
});

test("vendor maintenance refuses repository paths and unowned working directories", async () => {
  assert.throws(() => claimWorkdir(fileURLToPath(root)), /outside/);
  const workdir = await mkdtemp(join(tmpdir(), "budget-lab-vendor-guard-"));
  const sentinel = join(workdir, "unrelated.txt");
  const marker = join(workdir, ".vendor-copilot-usage-viewer-owner.json");
  try {
    await writeFile(sentinel, "Unrelated work must survive");
    assert.throws(() => claimWorkdir(workdir), /non-empty workdir/);
    assert.equal(await readFile(sentinel, "utf8"), "Unrelated work must survive");
    await unlink(sentinel);
    assert.equal(claimWorkdir(workdir), workdir);
    assert.equal(claimWorkdir(workdir), workdir);
    const owner = JSON.parse(await readFile(marker, "utf8"));
    owner.commit = "different";
    await writeFile(marker, JSON.stringify(owner));
    assert.throws(() => claimWorkdir(workdir), /different source/);
  } finally {
    for (const file of await readdir(workdir)) {
      assert.ok(["unrelated.txt", ".vendor-copilot-usage-viewer-owner.json"].includes(file));
      await unlink(join(workdir, file));
    }
    await rmdir(workdir);
  }
});
