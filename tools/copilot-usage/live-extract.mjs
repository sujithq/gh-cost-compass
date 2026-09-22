import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eachDay, parseNdjson, toNdjson } from "./contract.mjs";

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

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
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
      if (!("download_links" in envelope)) {
        throw new Error(`${endpoint} response is missing download_links (top-level keys: ${Object.keys(envelope).join(", ") || "none"}). Treating as a malformed envelope, not no-data.`);
      }
      const links = envelope.download_links;
      if (!Array.isArray(links)) {
        throw new Error(`${endpoint} download_links was not an array (got ${typeof links}). Treating as a malformed envelope, not no-data.`);
      }
      const rows = [];
      for (const link of links) {
        const href = typeof link === "string" ? link : link?.url ?? link?.href;
        if (!href) throw new Error(`${endpoint} contains a download link with no resolvable URL: ${JSON.stringify(link)}`);
        const response = await request(fetchImpl, href, {}, audit, "<signed-download>");
        rows.push(...parseNdjson(await response.text()));
      }
      return { envelope, rows, linkCount: links.length };
    },
    async fetchSnapshot(path) {
      return json(fetchImpl, `${root}${path}`, options, audit, path);
    },
    async fetchAllPages(path) {
      const results = [];
      let url = `${root}${path}`;
      while (url) {
        const response = await request(fetchImpl, url, options, audit, path);
        const body = await response.json();
        results.push(...(Array.isArray(body) ? body : [body]));
        const linkHeader = typeof response.headers?.get === "function" ? response.headers.get("link") : null;
        url = parseNextLink(linkHeader);
      }
      return results;
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

  // The 28-day spine is the authoritative credit source for every dollar in the workbook.
  // Persist it (and the cost-centre/seat snapshots below) so the numbers can be re-derived
  // and audited from artifacts alone, never only from in-memory state.
  const spinePath = join(outDir, "users-28-day-spine.ndjson");
  await writeFile(spinePath, toNdjson(spineResult.rows));

  const dailyRowsByDay = {};
  const dailyCoverage = [];
  const dailyErrors = [];
  for (const day of days) {
    try {
      const result = await client.report("users-1-day", `?day=${encodeURIComponent(day)}`);
      if (result.linkCount > 0 && result.rows.length === 0) {
        throw new Error(`users-1-day for ${day} returned ${result.linkCount} download link(s) but parsed 0 rows; treating as an extraction failure, not no-data.`);
      }
      dailyRowsByDay[day] = result.rows;
      // Only an explicit zero download links means GitHub reports no usage for the day.
      // A present-but-empty parse (caught above) is a failure, not an absence of data.
      const noData = result.linkCount === 0;
      dailyCoverage.push({ day, rowCount: result.rows.length, linkCount: result.linkCount, noData, enriched: !noData });
      if (result.rows.length > 0) await writeFile(join(outDir, `users-1-day-${day}.ndjson`), toNdjson(result.rows));
    } catch (error) {
      dailyRowsByDay[day] = [];
      dailyCoverage.push({ day, rowCount: 0, linkCount: null, noData: false, enriched: false, error: error.message });
      dailyErrors.push({ day, error: error.message });
    }
  }
  const snapshots = {
    costCenters: await client.fetchSnapshot(`/enterprises/${encodeURIComponent(enterprise)}/settings/billing/cost-centers`),
    seats: await client.fetchSnapshot(`/enterprises/${encodeURIComponent(enterprise)}/copilot/billing/seats`),
  };
  const costCentersPath = join(outDir, "cost-centers.json");
  const seatsPath = join(outDir, "seats.json");
  await writeFile(costCentersPath, `${JSON.stringify(snapshots.costCenters, null, 2)}\n`);
  await writeFile(seatsPath, `${JSON.stringify(snapshots.seats, null, 2)}\n`);

  const orgMembersByOrg = {};
  for (const org of orgs) orgMembersByOrg[org] = await client.fetchAllPages(`/orgs/${encodeURIComponent(org)}/members?per_page=100`);

  const manifest = {
    enterprise,
    startDay,
    endDay,
    generatedAt: new Date().toISOString(),
    spine: { report: "users-28-day/latest", rowCount: spineResult.rows.length, linkCount: spineResult.linkCount, reportStartDay: spineResult.envelope.report_start_day, reportEndDay: spineResult.envelope.report_end_day },
    daily: dailyCoverage,
    endpoints: client.audit,
    // Days GitHub genuinely reports no usage for (200, zero download links) — not extraction failures.
    noDataDays: dailyCoverage.filter((entry) => entry.noData).map((entry) => entry.day),
    enrichedDays: dailyCoverage.filter((entry) => entry.enriched).map((entry) => entry.day),
    unenrichedDays: dailyCoverage.filter((entry) => !entry.enriched).map((entry) => entry.day),
    dailyErrors,
    // Extraction completeness is about every day being successfully attempted, not about whether
    // GitHub happened to report usage for it. A no-data day is not an incomplete extraction.
    complete: dailyErrors.length === 0,
    artifacts: { spine: spinePath, costCenters: costCentersPath, seats: seatsPath, dailyDir: outDir },
  };
  await writeFile(join(outDir, "live-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { spineRows: spineResult.rows, dailyRowsByDay, snapshots, orgMembersByOrg, manifest };
}
