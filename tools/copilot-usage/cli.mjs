/**
 * One-command entry point for the Copilot usage-metrics V0 MVP.
 *
 *   node tools/copilot-usage/cli.mjs --from-fixtures
 *   node tools/copilot-usage/cli.mjs --enterprise acme --start 2026-09-16 --end 2026-09-18
 *
 * Pipeline: preflight -> extract -> map -> allocate -> estimate model split -> render report.
 *
 * `--from-fixtures` runs the whole pipeline offline against the bundled sample extraction, so the
 * report can be produced and reviewed before anyone has credentials for a real enterprise.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPORTS, eachDay, parseNdjson, roundUsd } from "./contract.mjs";
import { createGitHubClient, extractRange, runPreflight } from "./extract.mjs";
import { createLiveClient, extractLive } from "./live-extract.mjs";
import { normalizeCostCenterPayload } from "./live-adapter.mjs";
import { buildLiveReport, writeLiveOutputs } from "./live-report.mjs";
import { buildChargebackTable, buildEnvironment, buildScenario, verifyChargebackInvariants, anonymize } from "./map-environment.mjs";
import { allocate, deriveSyntheticInvoice, verifyConservation } from "./allocate.mjs";
import { estimateModelSplit, sensitivity } from "./model-split.mjs";
import { buildReportModel, renderReport } from "./report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

const USAGE = `Copilot usage-metrics chargeback report (V0 MVP)

Usage:
  node tools/copilot-usage/cli.mjs --from-fixtures [--out <dir>]
  node tools/copilot-usage/cli.mjs --enterprise <slug> --start <YYYY-MM-DD> --end <YYYY-MM-DD> [options]
  node tools/copilot-usage/cli.mjs --live --enterprise <slug> --since <YYYY-MM-DD> [options]

Options:
  --from-fixtures      Run offline against the bundled sample extraction (no credentials needed).
  --live               Use the 28-day credit spine and daily live enrichment reports.
  --enterprise <slug>  Enterprise slug to extract.
  --start <date>       First day of the window (inclusive).
  --end <date>         Last day of the window (inclusive).
  --membership <path>  Cost-centre membership snapshot JSON. Default: bundled fixture.
  --seats <path>       Seat roster JSON. Default: bundled fixture.
  --invoice <path>     Actual invoice JSON. Omit to derive an explicitly synthetic invoice.
  --out <dir>          Output directory. Default: .copilot-usage-out
  --raw <dir>          Where to land/read raw NDJSON. Default: <out>/raw
  --token-env <VAR>    Env var holding the token. Default: GITHUB_TOKEN
  --anonymize          Pseudonymize users in the emitted environment/scenario.
  --skip-preflight     Skip the blocking preflight gate (not recommended).
  --help               Show this message.

The token is read from the environment only; it is never accepted as an argument and never logged.
`;

export function parseArgs(argv) {
  const options = {
    fromFixtures: false,
    live: false,
    enterprise: null,
    start: null,
    end: null,
    since: null,
    membership: null,
    seats: null,
    invoice: null,
    out: ".copilot-usage-out",
    raw: null,
    tokenEnv: "GITHUB_TOKEN",
    anonymize: false,
    skipPreflight: false,
    help: false,
  };
  const flags = {
    "--from-fixtures": () => (options.fromFixtures = true),
    "--live": () => (options.live = true),
    "--anonymize": () => (options.anonymize = true),
    "--skip-preflight": () => (options.skipPreflight = true),
    "--help": () => (options.help = true),
    "-h": () => (options.help = true),
  };
  const values = {
    "--enterprise": "enterprise",
    "--start": "start",
    "--end": "end",
    "--since": "since",
    "--membership": "membership",
    "--seats": "seats",
    "--invoice": "invoice",
    "--out": "out",
    "--raw": "raw",
    "--token-env": "tokenEnv",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flags[arg]) {
      flags[arg]();
      continue;
    }
    if (values[arg]) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[values[arg]] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !options.fromFixtures && !options.live) {
    for (const required of ["enterprise", "start", "end"]) {
      if (!options[required]) throw new Error(`--${required} is required unless --from-fixtures is used.`);
    }
  }
  if (!options.help && options.live && !options.enterprise) throw new Error("--enterprise is required for --live.");
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeOut(outDir, name, contents) {
  const target = join(outDir, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
  return target;
}

/** Read a landed extraction back into day-keyed row maps. */
export function readLandedRows({ rawRoot, days }) {
  const usageRowsByDay = {};
  const userTeamRowsByDay = {};
  for (const day of days) {
    const usagePath = join(rawRoot, `day=${day}`, `${REPORTS.users}.ndjson`);
    const teamsPath = join(rawRoot, `day=${day}`, `${REPORTS.userTeams}.ndjson`);
    usageRowsByDay[day] = existsSync(usagePath) ? parseNdjson(readFileSync(usagePath, "utf8")) : [];
    userTeamRowsByDay[day] = existsSync(teamsPath) ? parseNdjson(readFileSync(teamsPath, "utf8")) : [];
  }
  return { usageRowsByDay, userTeamRowsByDay };
}

/** Manifest for an offline fixture run, so coverage reporting behaves identically to a live run. */
function fixtureManifest({ enterprise, days, usageRowsByDay, userTeamRowsByDay, generatedAt }) {
  return {
    enterprise,
    startDay: days[0],
    endDay: days[days.length - 1],
    generatedAt,
    days: days.map((day) => ({
      day,
      reports: {
        [REPORTS.users]: { ok: true, rowCount: usageRowsByDay[day].length, error: null, path: `fixtures/raw/day=${day}/${REPORTS.users}.ndjson` },
        [REPORTS.userTeams]: { ok: true, rowCount: userTeamRowsByDay[day].length, error: null, path: `fixtures/raw/day=${day}/${REPORTS.userTeams}.ndjson` },
      },
    })),
    complete: true,
    missing: [],
  };
}

/** Trim binary-float noise without rounding to cents, so column sums stay accurate. */
function csvValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return String(Number(value.toFixed(6)));
  }
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, columns) {
  return [columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))].join("\n") + "\n";
}

export async function run(options, { env = process.env, log = console.log } = {}) {
  const generatedAt = new Date().toISOString();
  const outDir = resolve(options.out);
  const rawRoot = options.raw ? resolve(options.raw) : join(outDir, "raw");

  const membership = readJson(options.membership ?? join(FIXTURES, "membership.json"));
  const seats = readJson(options.seats ?? join(FIXTURES, "seats.json"));

  let enterprise = options.enterprise;
  let days;
  let manifest;
  let rows;

  if (options.live) {
    const token = env[options.tokenEnv] ?? env.GH_TOKEN;
    if (!token) throw new Error(`No token found in ${options.tokenEnv}. Export it before running; it is never passed as an argument.`);
    const client = createLiveClient({ token });
    const ccPayload = await client.fetchSnapshot(`/enterprises/${encodeURIComponent(enterprise)}/settings/billing/cost-centers`);
    const orgs = (ccPayload.costCenters ?? ccPayload.cost_centers ?? [])
      .flatMap((center) => (center.resources ?? []).filter((resource) => String(resource.type).toLowerCase() === "org").map((resource) => resource.name));
    const extracted = await extractLive({ client, enterprise, since: options.since ?? options.start, outDir: rawRoot, orgs: [...new Set(orgs)].sort() });
    const liveMembership = normalizeCostCenterPayload(extracted.snapshots.costCenters, { capturedAt: generatedAt });
    writeOut(outDir, "membership-live.json", `${JSON.stringify(liveMembership, null, 2)}\n`);
    const report = buildLiveReport({
      spineRows: extracted.spineRows,
      dailyRowsByDay: extracted.dailyRowsByDay,
      costCenters: liveMembership,
      orgMembersByOrg: extracted.orgMembersByOrg,
      seats: extracted.snapshots.seats,
      manifest: extracted.manifest,
    });
    await writeLiveOutputs(outDir, report);
    log(`Live window        ${extracted.manifest.startDay} to ${extracted.manifest.endDay}`);
    log(`Credits consumed   ${report.totals.credits} (= $${roundUsd(report.totals.usd).toFixed(2)} usage-valued)`);
    log(`Enriched rows      ${report.totals.enrichedRows}`);
    log(`Ambiguous rows     ${report.totals.ambiguousRows}`);
    log(`Wrote              ${join(outDir, "chargeback.xlsx")}`);
    return { outDir, manifest: extracted.manifest, report, failed: [] };
  }

  if (options.fromFixtures) {
    const fixtureModule = await import("./fixtures/make-fixtures.mjs");
    enterprise = enterprise ?? fixtureModule.ENTERPRISE_ID;
    days = [...fixtureModule.DAYS];
    rows = readLandedRows({ rawRoot: join(FIXTURES, "raw"), days });
    manifest = fixtureManifest({ enterprise, days, ...rows, generatedAt });
    log(`Running offline against bundled fixtures (${days.length} days, enterprise ${enterprise}).`);
  } else {
    const token = env[options.tokenEnv];
    if (!token) throw new Error(`No token found in ${options.tokenEnv}. Export it before running; it is never passed as an argument.`);
    days = eachDay(options.start, options.end);
    const client = createGitHubClient({ token });

    if (!options.skipPreflight) {
      const preflight = await runPreflight({ client, enterprise, startDay: options.start, endDay: options.end, membership });
      for (const check of preflight.checks) {
        log(`  [${check.ok ? "ok" : check.blocking ? "BLOCK" : "warn"}] ${check.name}: ${check.detail}`);
      }
      writeOut(outDir, "preflight.json", `${JSON.stringify(preflight, null, 2)}\n`);
      if (!preflight.ok) throw new Error("Preflight gate failed. Resolve the blocking checks above before extracting.");
    }

    manifest = await extractRange({
      client,
      enterprise,
      reports: Object.values(REPORTS),
      startDay: options.start,
      endDay: options.end,
      outputRoot: rawRoot,
    });
    rows = readLandedRows({ rawRoot, days });
  }

  const { usageRowsByDay, userTeamRowsByDay } = rows;
  const periodStart = days[0];
  const periodEnd = days[days.length - 1];

  const chargeback = buildChargebackTable({ usageRowsByDay, userTeamRowsByDay, membership });
  const invariants = verifyChargebackInvariants({ rows: chargeback.rows, usageRowsByDay });
  chargeback.invariants = invariants;

  const totalCredits = chargeback.rows.reduce((total, row) => total + Number(row.ai_credits_used ?? 0), 0);
  const invoice = options.invoice
    ? readJson(options.invoice)
    : deriveSyntheticInvoice({ seats, totalCredits, periodStart, periodEnd });

  const allocation = allocate({ chargebackRows: chargeback.rows, seats, invoice, periodStart, periodEnd });
  allocation.checks = verifyConservation(allocation);

  const modelSplit = estimateModelSplit({ chargebackRows: chargeback.rows, usageRowsByDay });
  const low = sensitivity({ chargebackRows: chargeback.rows, usageRowsByDay, factor: 0.5 });
  const high = sensitivity({ chargebackRows: chargeback.rows, usageRowsByDay, factor: 1.5 });
  attachSensitivity(modelSplit, low, high);

  let environment = buildEnvironment({ chargeback, usageRowsByDay, seats, enterprise, membership, options: { periodStart, periodEnd } });
  let scenario = buildScenario({ environment, chargeback, simulationDate: periodEnd });
  if (options.anonymize) {
    environment = anonymize(environment, { salt: enterprise });
    scenario = anonymize(scenario, { salt: enterprise });
  }

  const reportModel = buildReportModel({
    allocation,
    chargeback,
    modelSplit,
    manifest,
    membership,
    period: { startDay: periodStart, endDay: periodEnd },
    meta: {
      generatedAt,
      sensitivityNote: buildSensitivityNote(modelSplit, low, high),
    },
  });

  const html = renderReport(reportModel);

  const written = [
    writeOut(outDir, "report.html", html),
    writeOut(outDir, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`),
    writeOut(outDir, "environment.json", `${JSON.stringify(environment, null, 2)}\n`),
    writeOut(outDir, "scenario.json", `${JSON.stringify(scenario, null, 2)}\n`),
    writeOut(outDir, "allocation.json", `${JSON.stringify(allocation, null, 2)}\n`),
    writeOut(outDir, "model-split.json", `${JSON.stringify({ estimate: modelSplit, sensitivity: { low, high } }, null, 2)}\n`),
    writeOut(outDir, "chargeback.csv", toCsv(chargeback.rows, ["day", "user_id", "user_login", "cost_center_id", "cost_center_name", "organization_id", "attribution_route", "ai_credits_used", "usage_usd"])),
    writeOut(outDir, "allocation.csv", toCsv(allocation.rows, ["user_id", "user_login", "cost_center_id", "tier", "seat_days", "ai_credits_used", "usage_usd", "seat_cost_usd", "metered_cost_usd", "chargeback_usd"])),
  ];

  const failed = [...allocation.checks, ...invariants].filter((check) => !check.ok);
  log("");
  log(`Window            ${periodStart} to ${periodEnd}`);
  log(`Users             ${allocation.rows.length}`);
  log(`Credits consumed  ${totalCredits} (= $${roundUsd(totalCredits * 0.01).toFixed(2)} usage-valued)`);
  log(`Invoice (${invoice.kind})${invoice.kind === "synthetic" ? "" : "   "}  $${roundUsd(allocation.totals?.invoice_usd ?? 0).toFixed(2)}`);
  log(`Checks            ${failed.length === 0 ? "all passed" : `${failed.length} FAILED`}`);
  for (const check of failed) log(`  FAILED ${check.name}: ${check.detail}`);
  log("");
  for (const path of written) log(`  wrote ${path}`);

  return { outDir, manifest, chargeback, allocation, modelSplit, environment, scenario, reportModel, html, failed };
}

/**
 * State what the sensitivity run actually demonstrates. It varies assumed token volume only, so a
 * narrow range means the ranking is robust to that assumption -- not that the split is precise.
 * The assumed relative price between models is the larger uncertainty and is not varied here.
 */
function buildSensitivityNote(base, low, high) {
  const baseTop = topModel(base);
  if (!baseTop) return "No model-attributed usage in this window, so there is nothing to vary.";
  const shares = [topModel(low)?.share, topModel(high)?.share].filter((share) => Number.isFinite(share));
  const min = Math.min(baseTop.share, ...shares);
  const max = Math.max(baseTop.share, ...shares);
  const spread = max - min;
  const verdict = spread < 1
    ? `moves the leading model's share by less than a percentage point (${min.toFixed(1)}%-${max.toFixed(1)}%), so the ranking is robust to that assumption`
    : `moves the leading model's share across ${min.toFixed(1)}%-${max.toFixed(1)}%, so treat the ranking as indicative only`;
  return `Model split shown at the documented assumption (${base.weights_version}). `
    + `Varying assumed tokens per interaction from 0.5x to 1.5x ${verdict}. `
    + `Per-user credit totals are exact and unchanged in every case. `
    + `This varies token volume only; it does not test the assumed relative price between models, which is the larger uncertainty in this panel.`;
}

function topModel(split) {
  const byModel = split.totals?.by_model ?? [];
  const total = byModel.reduce((sum, entry) => sum + Number(entry.ai_credits_used ?? 0), 0);
  if (total <= 0) return null;
  const top = [...byModel].sort((a, b) => Number(b.ai_credits_used ?? 0) - Number(a.ai_credits_used ?? 0))[0];
  return { id: top.id, share: (Number(top.ai_credits_used ?? 0) / total) * 100 };
}

const splitKey = (row) => `${row.user_id}\u0000${row.model}\u0000${row.feature}`;

/**
 * Attach a low/high usage_usd range to every estimated split row so the report can show how much
 * of the model mix is an artefact of the token assumption rather than of observed data.
 */
function attachSensitivity(split, low, high) {
  const lowRows = new Map(low.rows.map((row) => [splitKey(row), row]));
  const highRows = new Map(high.rows.map((row) => [splitKey(row), row]));
  for (const row of split.rows) {
    const key = splitKey(row);
    const a = Number(lowRows.get(key)?.usage_usd ?? row.usage_usd);
    const b = Number(highRows.get(key)?.usage_usd ?? row.usage_usd);
    row.sensitivity = { low: Math.min(a, b), high: Math.max(a, b) };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      process.exit(0);
    }
    const result = await run(options);
    process.exit(result.failed.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(`\nError: ${error.message}\n`);
    process.exit(1);
  }
}
