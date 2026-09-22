import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eachDay, parseNdjson } from "./contract.mjs";

const API_VERSION = "2026-03-10";

async function request(fetchImpl, url, options, audit, endpoint) {
  const response = await fetchImpl(url, options);
  audit.push({ endpoint, status: response.status });
  if (!response.ok) throw new Error(`${endpoint} failed with HTTP ${response.status}`);
  return response;
}

async function json(fetchImpl, url, options, audit, endpoint) {
  return request(fetchImpl, url, options, audit, endpoint).then((response) => response.json());
}

function headers(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION };
}

export function createLiveClient({ token, fetchImpl = globalThis.fetch, baseUrl = "https://api.github.com" } = {}) {
  if (!token) throw new Error("A GitHub token is required for live extraction.");
  const root = String(baseUrl).replace(/\/+$/, "");
  const audit = [];
  const options = { headers: headers(token) };
  const client = {
    audit,
    async report(report, query = "") {
      const endpoint = `/enterprises/{enterprise}/copilot/metrics/reports/${report}${query}`;
      const url = `${root}${endpoint.replace("{enterprise}", encodeURIComponent(this.enterprise))}`;
      const envelope = await json(fetchImpl, url, options, audit, endpoint);
      const links = Array.isArray(envelope.download_links) ? envelope.download_links : [];
      const rows = [];
      for (const link of links) {
        const href = typeof link === "string" ? link : link?.url ?? link?.href;
        if (!href) continue;
        const response = await request(fetchImpl, href, {}, audit, "<signed-download>");
        rows.push(...parseNdjson(await response.text()));
      }
      return { envelope, rows, linkCount: links.length };
    },
    async fetchSnapshot(path) {
      return json(fetchImpl, `${root}${path}`, options, audit, path);
    },
  };
  return client;
}

export async function extractLive({ client, enterprise, since, outDir, orgs = [] }) {
  if (!client?.report) throw new Error("extractLive requires a live client.");
  client.enterprise = enterprise;
  await mkdir(outDir, { recursive: true });
  const spineResult = await client.report("users-28-day/latest");
  const startDay = since ?? spineResult.envelope.report_start_day;
  const endDay = spineResult.envelope.report_end_day;
  const days = eachDay(startDay, endDay);
  const dailyRowsByDay = {};
  const dailyCoverage = [];
  for (const day of days) {
    const result = await client.report("users-1-day", `?day=${encodeURIComponent(day)}`);
    dailyRowsByDay[day] = result.rows;
    dailyCoverage.push({ day, rowCount: result.rows.length, linkCount: result.linkCount, noData: result.rows.length === 0, enriched: result.rows.length > 0 });
    if (result.rows.length > 0) await writeFile(join(outDir, `users-1-day-${day}.ndjson`), result.rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  const snapshots = {
    costCenters: await client.fetchSnapshot(`/enterprises/${encodeURIComponent(enterprise)}/settings/billing/cost-centers`),
    seats: await client.fetchSnapshot(`/enterprises/${encodeURIComponent(enterprise)}/copilot/billing/seats`),
  };
  const orgMembersByOrg = {};
  for (const org of orgs) orgMembersByOrg[org] = await client.fetchSnapshot(`/orgs/${encodeURIComponent(org)}/members?per_page=100`);
  const manifest = {
    enterprise,
    startDay,
    endDay,
    generatedAt: new Date().toISOString(),
    spine: { report: "users-28-day/latest", rowCount: spineResult.rows.length, linkCount: spineResult.linkCount, reportStartDay: spineResult.envelope.report_start_day, reportEndDay: spineResult.envelope.report_end_day },
    daily: dailyCoverage,
    endpoints: client.audit,
    missing: dailyCoverage.filter((entry) => entry.noData).map((entry) => entry.day),
    enrichedDays: dailyCoverage.filter((entry) => entry.enriched).map((entry) => entry.day),
    unenrichedDays: dailyCoverage.filter((entry) => !entry.enriched).map((entry) => entry.day),
    complete: dailyCoverage.every((entry) => entry.enriched),
  };
  await writeFile(join(outDir, "live-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { spineRows: spineResult.rows, dailyRowsByDay, snapshots, orgMembersByOrg, manifest };
}
