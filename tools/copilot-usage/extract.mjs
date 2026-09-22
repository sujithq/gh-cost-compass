import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertDay, eachDay, parseNdjson, REPORTS, toNdjson } from "./contract.mjs";

const GITHUB_API_VERSION = "2022-11-28";

async function writeFileCreatingParents(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, content, "utf8");
}

function normalizeReports(reports = Object.values(REPORTS)) {
  if (Array.isArray(reports)) return reports;
  if (reports && typeof reports === "object") return Object.values(reports);
  throw new Error("reports must be an array or object of report family names.");
}

function responseStatus(response) {
  return `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    return text ? `: ${text.slice(0, 300)}` : "";
  } catch {
    return "";
  }
}

function resolveDownloadLinks(envelope, { report, day }) {
  const value = envelope?.download_links;
  const candidates = Array.isArray(value) ? value : [value];
  const links = candidates
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry.url === "string") return entry.url;
      if (entry && typeof entry.href === "string") return entry.href;
      return null;
    })
    .filter(Boolean);
  if (links.length > 0) return links;

  const keys = envelope && typeof envelope === "object" ? Object.keys(envelope) : [];
  throw new Error(
    `Report envelope for ${report} on ${day} did not include resolvable download_links. Top-level keys: ${keys.length ? keys.join(", ") : "(none)"}.`,
  );
}

async function fetchJson(fetchImpl, url, options, context) {
  const response = await fetchImpl(url, options);
  if (!response?.ok) {
    throw new Error(`${context} failed with HTTP ${responseStatus(response ?? { status: "unknown" })}${response ? await readErrorBody(response) : ""}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error.message}`);
  }
}

async function fetchText(fetchImpl, url, context) {
  const response = await fetchImpl(url);
  if (!response?.ok) {
    throw new Error(`${context} failed with HTTP ${responseStatus(response ?? { status: "unknown" })}${response ? await readErrorBody(response) : ""}`);
  }
  try {
    return await response.text();
  } catch (error) {
    throw new Error(`${context} returned unreadable text: ${error.message}`);
  }
}

export function createGitHubClient({ token, baseUrl = "https://api.github.com", fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("createGitHubClient requires a fetchImpl function.");
  }

  const root = String(baseUrl).replace(/\/+$/, "");
  const hasToken = typeof token === "string" && token.length > 0;

  return {
    hasToken,

    async fetchReportEnvelope({ enterprise, report, day }) {
      if (!hasToken) throw new Error("GitHub token is required to fetch Copilot usage metrics.");
      if (!enterprise) throw new Error("enterprise is required.");
      if (!report) throw new Error("report is required.");
      assertDay(day, "day");

      const url = new URL(`${root}/enterprises/${encodeURIComponent(enterprise)}/copilot/metrics/reports/${encodeURIComponent(report)}`);
      url.searchParams.set("day", day);
      return fetchJson(
        fetchImpl,
        url,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
          },
        },
        `Fetching ${report} envelope for ${day}`,
      );
    },

    async downloadReportRows({ enterprise, report, day }) {
      const envelope = await this.fetchReportEnvelope({ enterprise, report, day });
      const links = resolveDownloadLinks(envelope, { report, day });
      const files = await Promise.all(
        links.map((link, index) => fetchText(fetchImpl, link, `Downloading ${report} link ${index + 1} for ${day}`)),
      );
      return files.flatMap((text) => parseNdjson(text));
    },
  };
}

export function buildManifest({ enterprise, startDay, endDay, reports = Object.values(REPORTS), results = [], generatedAt = new Date().toISOString() }) {
  assertDay(startDay, "startDay");
  assertDay(endDay, "endDay");
  const reportNames = normalizeReports(reports);
  const resultByKey = new Map(results.map((result) => [`${result.day}\0${result.report}`, result]));
  const missing = [];

  const days = eachDay(startDay, endDay).map((day) => {
    const dayReports = {};
    for (const report of reportNames) {
      const result = resultByKey.get(`${day}\0${report}`);
      const entry = {
        ok: Boolean(result?.ok),
        rowCount: Number(result?.rowCount ?? 0),
        error: result?.error ?? null,
        path: result?.path ?? null,
      };
      dayReports[report] = entry;
      if (!entry.ok) missing.push({ day, report, error: entry.error ?? "Extraction was not attempted." });
    }
    return { day, reports: dayReports };
  });

  // Completeness is tracked separately from downstream allocation conservation: missing source days
  // can still normalize to 100% and would otherwise silently redistribute cost.
  return {
    enterprise,
    startDay,
    endDay,
    generatedAt,
    days,
    complete: missing.length === 0,
    missing,
  };
}

export async function extractRange({ client, enterprise, reports = Object.values(REPORTS), startDay, endDay, outputRoot, writeFile = writeFileCreatingParents }) {
  if (!client?.downloadReportRows) throw new Error("extractRange requires a client with downloadReportRows().");
  if (!enterprise) throw new Error("enterprise is required.");
  if (!outputRoot) throw new Error("outputRoot is required.");
  if (typeof writeFile !== "function") throw new Error("writeFile must be a function.");

  const reportNames = normalizeReports(reports);
  const results = [];

  for (const day of eachDay(startDay, endDay)) {
    for (const report of reportNames) {
      const path = join(outputRoot, `day=${day}`, `${report}.ndjson`);
      try {
        const rows = await client.downloadReportRows({ enterprise, report, day });
        await writeFile(path, toNdjson(rows));
        results.push({ day, report, ok: true, rowCount: rows.length, error: null, path });
      } catch (error) {
        results.push({ day, report, ok: false, rowCount: 0, error: error.message, path });
      }
    }
  }

  const manifest = buildManifest({ enterprise, startDay, endDay, reports: reportNames, results });
  await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function populatedRoutes(membership) {
  const routes = { user_ids: false, team_ids: false, organization_ids: false };
  for (const costCenter of membership?.cost_centers ?? []) {
    for (const key of Object.keys(routes)) {
      if (Array.isArray(costCenter[key]) && costCenter[key].length > 0) routes[key] = true;
    }
  }
  return routes;
}

function usersPerCostCenter(membership, usageRows, teamRows) {
  const usersByTeam = new Map();
  for (const row of teamRows) {
    if (!row?.team_id || !row?.user_id) continue;
    if (!usersByTeam.has(row.team_id)) usersByTeam.set(row.team_id, new Set());
    usersByTeam.get(row.team_id).add(row.user_id);
  }

  const usersByOrganization = new Map();
  for (const row of usageRows) {
    if (!row?.organization_id || !row?.user_id) continue;
    if (!usersByOrganization.has(row.organization_id)) usersByOrganization.set(row.organization_id, new Set());
    usersByOrganization.get(row.organization_id).add(row.user_id);
  }

  return (membership?.cost_centers ?? []).map((costCenter) => {
    const users = new Set(costCenter.user_ids ?? []);
    for (const teamId of costCenter.team_ids ?? []) {
      for (const userId of usersByTeam.get(teamId) ?? []) users.add(userId);
    }
    for (const organizationId of costCenter.organization_ids ?? []) {
      for (const userId of usersByOrganization.get(organizationId) ?? []) users.add(userId);
    }
    return { costCenter, users };
  });
}

function checkAttributionWindow(membership, startDay) {
  const effectiveFrom = membership?.effective_from;
  if (!effectiveFrom) {
    return {
      name: "attribution-window-validity",
      ok: false,
      detail: 'membership.effective_from is unknown; label output as "point-in-time attribution, not historically exact".',
      blocking: false,
    };
  }

  try {
    assertDay(effectiveFrom, "membership.effective_from");
  } catch (error) {
    return { name: "attribution-window-validity", ok: false, detail: error.message, blocking: true };
  }

  if (effectiveFrom > startDay) {
    return {
      name: "attribution-window-validity",
      ok: false,
      detail: `membership.effective_from ${effectiveFrom} is after startDay ${startDay}; part of the window predates the current cost-centre configuration.`,
      blocking: true,
    };
  }

  return {
    name: "attribution-window-validity",
    ok: true,
    detail: `membership.effective_from ${effectiveFrom} covers the requested startDay ${startDay}.`,
    blocking: true,
  };
}

export async function runPreflight({ client, enterprise, startDay, endDay, membership }) {
  if (!client?.downloadReportRows) throw new Error("runPreflight requires a client with downloadReportRows().");
  assertDay(startDay, "startDay");
  assertDay(endDay, "endDay");
  const checks = [];
  const usageRows = [];
  let teamRows = [];
  const probeDay = endDay;

  const hasToken = client.hasToken !== false;
  checks.push({
    name: "credentials",
    ok: hasToken,
    detail: hasToken ? "A GitHub token is configured." : "No GitHub token was supplied.",
    blocking: true,
  });

  if (hasToken) {
    try {
      usageRows.push(...await client.downloadReportRows({ enterprise, report: REPORTS.users, day: probeDay }));
      checks.push({
        name: "report-access-users",
        ok: true,
        detail: `${REPORTS.users} returned resolvable download links for ${probeDay}.`,
        blocking: true,
      });
    } catch (error) {
      checks.push({ name: "report-access-users", ok: false, detail: error.message, blocking: true });
    }

    try {
      teamRows = await client.downloadReportRows({ enterprise, report: REPORTS.userTeams, day: probeDay });
      checks.push({
        name: "report-access-user-teams",
        ok: true,
        detail: `${REPORTS.userTeams} returned resolvable download links for ${probeDay}.`,
        blocking: true,
      });
    } catch (error) {
      checks.push({ name: "report-access-user-teams", ok: false, detail: error.message, blocking: true });
    }

    for (const day of eachDay(startDay, endDay).filter((day) => day !== probeDay)) {
      try {
        usageRows.push(...await client.downloadReportRows({ enterprise, report: REPORTS.users, day }));
      } catch {
        // Access failures are reported by the explicit probe checks; non-zero usage is best-effort.
      }
    }
  } else {
    checks.push({
      name: "report-access-users",
      ok: false,
      detail: "Skipped because no GitHub token was supplied.",
      blocking: true,
    });
    checks.push({
      name: "report-access-user-teams",
      ok: false,
      detail: "Skipped because no GitHub token was supplied.",
      blocking: true,
    });
  }

  const nonZeroRows = usageRows.filter((row) => Number(row?.ai_credits_used ?? 0) > 0);
  checks.push({
    name: "non-zero-usage",
    ok: nonZeroRows.length > 0,
    detail: nonZeroRows.length > 0
      ? `${nonZeroRows.length} usage row(s) in the probed window have ai_credits_used > 0.`
      : "No probed usage rows have ai_credits_used > 0; generate usage or choose a different window before producing a report.",
    blocking: true,
  });

  const costCenters = membership?.cost_centers ?? [];
  const routes = populatedRoutes(membership);
  const populated = Object.entries(routes).filter(([, value]) => value).map(([key]) => key);
  checks.push({
    name: "cost-centre-routes",
    ok: costCenters.length > 0 && populated.length === 3,
    detail: costCenters.length > 0
      ? `Cost centres: ${costCenters.length}; populated assignment routes: ${populated.length ? populated.join(", ") : "none"}.`
      : "Membership snapshot defines no cost centres.",
    blocking: costCenters.length === 0,
  });

  const multiUserCenters = usersPerCostCenter(membership, usageRows, teamRows)
    .filter(({ users }) => users.size > 1)
    .map(({ costCenter, users }) => `${costCenter.id} (${users.size} users)`);
  checks.push({
    name: "multi-user-cost-centre",
    ok: multiUserCenters.length > 0,
    detail: multiUserCenters.length > 0
      ? `Multi-user cost centre(s): ${multiUserCenters.join(", ")}.`
      : "No cost centre resolves to more than one user in the probed rows; the demo may not show a meaningful breakdown.",
    blocking: false,
  });

  checks.push(checkAttributionWindow(membership, startDay));

  const failedBlocking = checks.filter((check) => check.blocking && !check.ok);
  return {
    ok: failedBlocking.length === 0,
    checks,
    summary: failedBlocking.length === 0
      ? `Preflight passed with ${checks.filter((check) => !check.ok).length} non-blocking warning(s).`
      : `Preflight failed ${failedBlocking.length} blocking check(s): ${failedBlocking.map((check) => check.name).join(", ")}.`,
  };
}
