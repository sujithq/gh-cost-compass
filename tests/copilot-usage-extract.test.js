import test from "node:test";
import assert from "node:assert/strict";
import { sep } from "node:path";
import { buildManifest, createGitHubClient, extractRange, runPreflight } from "../tools/copilot-usage/extract.mjs";
import { REPORTS, toNdjson } from "../tools/copilot-usage/contract.mjs";
import { ENTERPRISE_ID, MEMBERSHIP } from "../tools/copilot-usage/fixtures/make-fixtures.mjs";

function okJson(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function okText(body) {
  return { ok: true, status: 200, text: async () => body };
}

function pathKey(path) {
  return path.split(sep).join("/");
}

function preflightClient({ users = [], teams = [], failingReport = null } = {}) {
  return {
    hasToken: true,
    async downloadReportRows({ report }) {
      if (report === failingReport) throw new Error(`${report} unavailable`);
      if (report === REPORTS.users) return users;
      if (report === REPORTS.userTeams) return teams;
      throw new Error(`Unexpected report ${report}`);
    },
  };
}

for (const [name, downloadLinks] of [
  ["array of strings", ["https://downloads.example/users"]],
  ["array of objects", [{ url: "https://downloads.example/users-url" }, { href: "https://downloads.example/users-href" }]],
  ["single string", "https://downloads.example/users"],
]) {
  test(`downloadReportRows resolves download_links from ${name}`, async () => {
    const rows = [{ day_partition: "2026-09-16", user_id: "user-alice", ai_credits_used: 12 }];
    const calls = [];
    const client = createGitHubClient({
      token: "token",
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url).startsWith("https://api.github.com/")) return okJson({ download_links: downloadLinks });
        return okText(toNdjson(rows));
      },
    });

    assert.deepEqual(
      await client.downloadReportRows({ enterprise: ENTERPRISE_ID, report: REPORTS.users, day: "2026-09-16" }),
      Array.isArray(downloadLinks) && downloadLinks.length === 2 ? [...rows, ...rows] : rows,
    );
    assert.ok(calls[0].includes(`/enterprises/${ENTERPRISE_ID}/copilot/metrics/reports/${REPORTS.users}`));
    assert.ok(calls[0].includes("day=2026-09-16"));
  });
}

test("downloadReportRows names top-level keys when no download link is resolvable", async () => {
  const client = createGitHubClient({
    token: "token",
    fetchImpl: async () => okJson({ status: "ready", links: [] }),
  });

  await assert.rejects(
    () => client.downloadReportRows({ enterprise: ENTERPRISE_ID, report: REPORTS.users, day: "2026-09-16" }),
    /Top-level keys: status, links/,
  );
});

test("downloadReportRows treats an explicit empty download_links array as no data", async () => {
  const client = createGitHubClient({
    token: "token",
    fetchImpl: async () => okJson({ report_day: "2026-09-21", download_links: [] }),
  });

  assert.deepEqual(
    await client.downloadReportRows({ enterprise: ENTERPRISE_ID, report: REPORTS.users, day: "2026-09-21" }),
    [],
  );
});

test("extractRange writes one NDJSON file per day per report and a complete manifest", async () => {
  const writes = new Map();
  const reports = [REPORTS.users, REPORTS.userTeams];
  const client = {
    async downloadReportRows({ report, day }) {
      return [{ day_partition: day, report, row: `${day}-${report}` }];
    },
  };

  const manifest = await extractRange({
    client,
    enterprise: ENTERPRISE_ID,
    reports,
    startDay: "2026-09-16",
    endDay: "2026-09-17",
    outputRoot: "out",
    writeFile: async (path, content) => writes.set(pathKey(path), content),
  });

  for (const day of ["2026-09-16", "2026-09-17"]) {
    for (const report of reports) {
      const path = `out/day=${day}/${report}.ndjson`;
      assert.equal(writes.get(path), toNdjson([{ day_partition: day, report, row: `${day}-${report}` }]));
      assert.equal(manifest.days.find((entry) => entry.day === day).reports[report].path, path.split("/").join(sep));
    }
  }
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.missing, []);
  assert.ok(writes.has("out/manifest.json"));
});

test("extractRange records a failing day without aborting remaining extraction", async () => {
  const writes = new Map();
  const client = {
    async downloadReportRows({ day }) {
      if (day === "2026-09-17") throw new Error("signed link expired");
      return [{ day_partition: day, user_id: "user-alice" }];
    },
  };

  const manifest = await extractRange({
    client,
    enterprise: ENTERPRISE_ID,
    reports: [REPORTS.users],
    startDay: "2026-09-16",
    endDay: "2026-09-18",
    outputRoot: "out",
    writeFile: async (path, content) => writes.set(pathKey(path), content),
  });

  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.missing, [{ day: "2026-09-17", report: REPORTS.users, error: "signed link expired" }]);
  const successfulDay = manifest.days.find((entry) => entry.day === "2026-09-16");
  assert.ok(successfulDay);
  assert.equal(successfulDay.reports[REPORTS.users].noData, false);
  assert.equal(writes.has(`out/day=2026-09-18/${REPORTS.users}.ndjson`), true);
  assert.equal(writes.has(`out/day=2026-09-17/${REPORTS.users}.ndjson`), false);
});

test("buildManifest marks unattempted report entries as missing", () => {
  const manifest = buildManifest({
    enterprise: ENTERPRISE_ID,
    startDay: "2026-09-16",
    endDay: "2026-09-16",
    reports: [REPORTS.users],
  });

  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.missing, [{ day: "2026-09-16", report: REPORTS.users, error: "Extraction was not attempted." }]);
});

test("runPreflight blocks when the user-teams report is inaccessible", async () => {
  const result = await runPreflight({
    client: preflightClient({
      users: [{ day_partition: "2026-09-16", user_id: "user-alice", organization_id: "org-product", ai_credits_used: 10 }],
      failingReport: REPORTS.userTeams,
    }),
    enterprise: ENTERPRISE_ID,
    startDay: "2026-09-16",
    endDay: "2026-09-16",
    membership: MEMBERSHIP,
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === "report-access-user-teams").blocking, true);
  assert.match(result.checks.find((check) => check.name === "report-access-user-teams").detail, /unavailable/);
});

test("runPreflight blocks when all usage is zero", async () => {
  const result = await runPreflight({
    client: preflightClient({
      users: [{ day_partition: "2026-09-16", user_id: "user-alice", ai_credits_used: 0 }],
      teams: [{ day_partition: "2026-09-16", user_id: "user-alice", team_id: "team-core" }],
    }),
    enterprise: ENTERPRISE_ID,
    startDay: "2026-09-16",
    endDay: "2026-09-16",
    membership: MEMBERSHIP,
  });

  const check = result.checks.find((entry) => entry.name === "non-zero-usage");
  assert.equal(result.ok, false);
  assert.equal(check.ok, false);
  assert.equal(check.blocking, true);
});

test("runPreflight warns but does not block when effective_from is unknown", async () => {
  const result = await runPreflight({
    client: preflightClient({
      users: [
        { day_partition: "2026-09-16", user_id: "user-alice", organization_id: "org-product", ai_credits_used: 10 },
        { day_partition: "2026-09-16", user_id: "user-bob", organization_id: "org-platform", ai_credits_used: 5 },
      ],
      teams: [{ day_partition: "2026-09-16", user_id: "user-bob", team_id: "team-core" }],
    }),
    enterprise: ENTERPRISE_ID,
    startDay: "2026-09-16",
    endDay: "2026-09-16",
    membership: { ...MEMBERSHIP, effective_from: null },
  });

  const check = result.checks.find((entry) => entry.name === "attribution-window-validity");
  assert.equal(result.ok, true);
  assert.equal(check.ok, false);
  assert.equal(check.blocking, false);
  assert.match(check.detail, /point-in-time attribution, not historically exact/);
});

test("runPreflight blocks when effective_from is later than startDay", async () => {
  const result = await runPreflight({
    client: preflightClient({
      users: [{ day_partition: "2026-09-16", user_id: "user-alice", organization_id: "org-product", ai_credits_used: 10 }],
      teams: [{ day_partition: "2026-09-16", user_id: "user-alice", team_id: "team-core" }],
    }),
    enterprise: ENTERPRISE_ID,
    startDay: "2026-09-16",
    endDay: "2026-09-16",
    membership: { ...MEMBERSHIP, effective_from: "2026-09-17" },
  });

  const check = result.checks.find((entry) => entry.name === "attribution-window-validity");
  assert.equal(result.ok, false);
  assert.equal(check.ok, false);
  assert.equal(check.blocking, true);
  assert.match(check.detail, /after startDay/);
});
