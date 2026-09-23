import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveClient, extractLive } from "../tools/copilot-usage/live-extract.mjs";
import { toNdjson } from "../tools/copilot-usage/contract.mjs";

function okJson(body, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function okText(body) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "copilot-usage-live-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("fetchAllPages follows the Link header across multiple pages", async () => {
  const calls = [];
  const client = createLiveClient({
    token: "token",
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("page=2")) return okJson([{ login: "member-page-2" }]);
      return okJson([{ login: "member-page-1" }], { link: '<https://api.github.com/orgs/acme/members?per_page=100&page=2>; rel="next", <https://api.github.com/orgs/acme/members?per_page=100&page=2>; rel="last"' });
    },
  });

  const members = await client.fetchAllPages("/orgs/acme/members?per_page=100");

  assert.deepEqual(members, [{ login: "member-page-1" }, { login: "member-page-2" }]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("page=2"));
});

test("report rejects a malformed envelope missing download_links instead of treating it as no-data", async () => {
  const client = createLiveClient({
    token: "token",
    fetchImpl: async () => okJson({ report_start_day: "2026-09-01", report_end_day: "2026-09-21" }),
  });
  client.enterprise = "demo";

  await assert.rejects(() => client.report("users-28-day/latest"), /missing download_links/);
});

test("report rejects a download_links value that is not an array", async () => {
  const client = createLiveClient({
    token: "token",
    fetchImpl: async () => okJson({ download_links: "not-an-array" }),
  });
  client.enterprise = "demo";

  await assert.rejects(() => client.report("users-28-day/latest"), /download_links was not an array/);
});

test("report still treats an explicit empty download_links array as no-data", async () => {
  const client = createLiveClient({
    token: "token",
    fetchImpl: async () => okJson({ report_day: "2026-09-19", download_links: [] }),
  });
  client.enterprise = "demo";

  const result = await client.report("users-1-day", "?day=2026-09-19");
  assert.deepEqual(result.rows, []);
  assert.equal(result.linkCount, 0);
});

test("extractLive treats a present link that parses to zero rows as an extraction error, not no-data", async () => {
  await withTempDir(async (outDir) => {
    const client = {
      enterprise: "demo",
      audit: [],
      async report(report) {
        if (report === "users-28-day/latest") {
          return { envelope: { report_start_day: "2026-09-16", report_end_day: "2026-09-16" }, rows: [{ day: "2026-09-16", user_id: 1, user_login: "alice", ai_credits_used: 5 }], linkCount: 1 };
        }
        // A download link was present, but it parsed to zero rows: a failure, not an absence of data.
        return { envelope: { report_day: "2026-09-16", download_links: ["https://downloads.example/empty"] }, rows: [], linkCount: 1 };
      },
      async fetchSnapshot() {
        return {};
      },
      async fetchAllPages() {
        return [];
      },
    };

    const result = await extractLive({ client, enterprise: "demo", outDir, orgs: [] });

    assert.equal(result.manifest.complete, false);
    assert.equal(result.manifest.dailyErrors.length, 1);
    assert.match(result.manifest.dailyErrors[0].error, /parsed 0 rows/);
    const dayEntry = result.manifest.daily.find((entry) => entry.day === "2026-09-16");
    assert.equal(dayEntry.noData, false);
    assert.equal(dayEntry.enriched, false);
    assert.ok(dayEntry.error);
    assert.deepEqual(result.manifest.noDataDays, []);
  });
});

test("extractLive persists the credit spine and cost-centre/seat snapshots and references them from the manifest", async () => {
  await withTempDir(async (outDir) => {
    const spineRows = [{ day: "2026-09-16", user_id: 1, user_login: "alice", ai_credits_used: 5 }];
    const client = {
      enterprise: "demo",
      audit: [],
      async report(report) {
        if (report === "users-28-day/latest") {
          return { envelope: { report_start_day: "2026-09-16", report_end_day: "2026-09-16" }, rows: spineRows, linkCount: 1 };
        }
        return { envelope: { report_day: "2026-09-16", download_links: [] }, rows: [], linkCount: 0 };
      },
      async fetchSnapshot(path) {
        if (path.includes("cost-centers")) return { cost_centers: [{ id: "cc-a", name: "A" }] };
        if (path.includes("seats")) return { seats: [] };
        return {};
      },
      async fetchAllPages() {
        return [];
      },
    };

    const result = await extractLive({ client, enterprise: "demo", outDir, orgs: [] });

    assert.equal(result.manifest.artifacts.spine, join(outDir, "users-28-day-spine.ndjson"));
    assert.equal(result.manifest.artifacts.costCenters, join(outDir, "cost-centers.json"));
    assert.equal(result.manifest.artifacts.seats, join(outDir, "seats.json"));

    const spineContent = await readFile(result.manifest.artifacts.spine, "utf8");
    assert.equal(spineContent, toNdjson(spineRows));
    const costCentersContent = JSON.parse(await readFile(result.manifest.artifacts.costCenters, "utf8"));
    assert.deepEqual(costCentersContent, { cost_centers: [{ id: "cc-a", name: "A" }] });
    const seatsContent = JSON.parse(await readFile(result.manifest.artifacts.seats, "utf8"));
    assert.deepEqual(seatsContent, { seats: [] });

    // No tokens or signed download URLs should ever land in a persisted artifact.
    for (const path of [result.manifest.artifacts.spine, result.manifest.artifacts.costCenters, result.manifest.artifacts.seats]) {
      const content = await readFile(path, "utf8");
      assert.doesNotMatch(content, /Bearer /);
    }
  });
});

test("extractLive uses fetchAllPages (not fetchSnapshot) to collect org members so pagination is not silently dropped", async () => {
  await withTempDir(async (outDir) => {
    const calls = [];
    const client = {
      enterprise: "demo",
      audit: [],
      async report() {
        return { envelope: { report_start_day: "2026-09-16", report_end_day: "2026-09-16", download_links: [] }, rows: [], linkCount: 0 };
      },
      async fetchSnapshot() {
        return {};
      },
      async fetchAllPages(path) {
        calls.push(path);
        return [{ login: "alice" }, { login: "bob" }];
      },
    };

    const result = await extractLive({ client, enterprise: "demo", outDir, orgs: ["org-one"] });

    assert.ok(calls.some((path) => path.includes("/orgs/org-one/members")));
    assert.deepEqual(result.orgMembersByOrg["org-one"], [{ login: "alice" }, { login: "bob" }]);
  });
});
