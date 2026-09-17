import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { acquireGitHubEnterprise, createGitHubClient, normalizeGitHubEnterprise, redactExtractionError } from "../src/github-environment-extractor.js";
import { registerEnvironment, getEnvironment, validateEnvironment } from "../src/environment.js";
import { materializeScenario } from "../src/scenario-runner.js";
import { replayScenario } from "../src/engine.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/github-enterprise.json", import.meta.url), "utf8"));

function response(body, { status = 200, link, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => ({ ...(link ? { link } : {}), ...headers }[name.toLowerCase()]) },
    json: async () => body,
  };
}

function fixtureFetch() {
  const calls = [];
  let rateLimited = true;
  return {
    calls,
    fetch: async (url) => {
      calls.push(new URL(url).pathname + new URL(url).search);
      const parsed = new URL(url);
      if (parsed.pathname === "/enterprises/fixture-enterprise") return response(fixture.enterprise);
      if (parsed.pathname === "/enterprises/fixture-enterprise/organizations") {
        return parsed.searchParams.get("page") === "2"
          ? response([{ ...fixture.organizations[1] }])
          : response([{ ...fixture.organizations[0] }], { link: '<https://api.github.test/enterprises/fixture-enterprise/organizations?page=2>; rel="next"' });
      }
      if (parsed.pathname === "/orgs/platform/repos") return response(fixture.repositories.filter((repo) => repo.organizationLogin === "platform"));
      if (parsed.pathname === "/orgs/product/repos") return response(fixture.repositories.filter((repo) => repo.organizationLogin === "product"));
      if (parsed.pathname === "/orgs/platform/members") return response(fixture.memberships.filter((member) => member.organizationLogin === "platform"));
      if (parsed.pathname === "/orgs/product/members") return response(fixture.memberships.filter((member) => member.organizationLogin === "product"));
      if (parsed.pathname === "/enterprises/fixture-enterprise/copilot/billing/seats") {
        if (rateLimited) {
          rateLimited = false;
          return response({ message: "rate limited" }, { status: 429, headers: { "retry-after": "0" } });
        }
        return response(fixture.seats);
      }
      if (parsed.pathname === "/enterprises/fixture-enterprise/teams") return response(fixture.teams);
      if (parsed.pathname === "/enterprises/fixture-enterprise/budgets") return response(fixture.budgets);
      return response({ message: "not found" }, { status: 404 });
    },
  };
}

test("GitHub acquisition paginates, retries rate limits, and records optional failures", async () => {
  const transport = fixtureFetch();
  const client = createGitHubClient({ token: "runtime-only-token", fetchImpl: transport.fetch, apiBaseUrl: "https://api.github.test", retryDelayMs: 0 });
  const acquired = await acquireGitHubEnterprise({
    client,
    enterprise: "fixture-enterprise",
    endpointTemplates: { seats: "/enterprises/{enterprise}/copilot/billing/seats", budgets: "/enterprises/{enterprise}/budgets" },
  });
  assert.equal(acquired.complete, true);
  assert.equal(acquired.data.organizations.length, 2);
  assert.equal(acquired.data.seats.length, 3);
  assert.ok(transport.calls.filter((call) => call.includes("/copilot/billing/seats")).length >= 2);
});

test("normalization is deterministic, privacy-safe, and preserves cross-org identity", () => {
  const first = normalizeGitHubEnterprise({ data: fixture, failures: [] }, { extractionId: "fixture", extractedAt: "2026-09-17T00:00:00Z", anonymize: true });
  const second = normalizeGitHubEnterprise({ data: structuredClone(fixture), failures: [] }, { extractionId: "fixture", extractedAt: "2026-09-17T00:00:00Z", anonymize: true });
  assert.deepEqual(first, second);
  assert.equal(validateEnvironment(first), null);
  assert.equal(first.users.length, 3);
  const alice = first.users.find((user) => user.organizationIds.length === 2);
  assert.ok(alice);
  assert.equal(alice.licensePlan, "enterprise");
  assert.equal(alice.costCenterId, first.costCenters.find((center) => center.userIds.includes(alice.id)).id);
  assert.equal(alice.externalLogin, undefined);
  assert.doesNotMatch(JSON.stringify(first), /Alice Example|fixture-enterprise|alice|platform\/tools/);
});

test("ambiguous multi-grant licenses require an explicit override", () => {
  const ambiguous = structuredClone(fixture);
  ambiguous.seats.push({ assignee: { id: 301, login: "alice" }, plan: "business", organization: { login: "platform" }, assigned_at: "2026-09-01T00:00:00Z" });
  assert.throws(() => normalizeGitHubEnterprise({ data: ambiguous, failures: [] }, { extractionId: "ambiguous", extractedAt: "2026-09-17T00:00:00Z" }), /Ambiguous Copilot license grants/);
  const environment = normalizeGitHubEnterprise({ data: ambiguous, failures: [] }, {
    extractionId: "override",
    extractedAt: "2026-09-17T00:00:00Z",
    licenseOverrides: { "301": { plan: "enterprise", organization: "product" } },
  });
  assert.equal(validateEnvironment(environment), null);
});

test("normalized environments load into guided scenarios and replay normally", () => {
  const environment = normalizeGitHubEnterprise({ data: fixture, failures: [] }, { extractionId: "replay-fixture", extractedAt: "2026-09-17T00:00:00Z" });
  registerEnvironment(environment);
  const definition = {
    version: 1,
    id: "replay-extracted",
    title: "Replay extracted environment",
    summary: "Uses an imported topology without application changes.",
    environmentId: "replay-fixture",
    steps: [{
      id: "usage",
      type: "usage",
      title: "Use credits",
      description: "Alice uses imported credits.",
      expected: "Usage is accepted.",
      event: { date: "2026-09-17", quantity: 10, userId: environment.users[0].id, repositoryId: environment.repositories[0].id, productId: "ai-credits" },
    }],
  };
  const scenario = materializeScenario(definition, 0);
  const replay = replayScenario(scenario);
  assert.equal(replay.results[0].status, "accepted");
  assert.equal(replay.results[0].cost, 0);
  assert.ok(replay.results[0].affectedBudgets.length >= 1);
  assert.deepEqual(getEnvironment("replay-fixture"), environment);
});

test("partial acquisition is surfaced and anonymized errors do not leak fixture identity", async () => {
  const client = createGitHubClient({
    token: "runtime-only-token",
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/enterprises/fixture-enterprise")) return response(fixture.enterprise);
      if (pathname.endsWith("/organizations")) return response(fixture.organizations);
      if (pathname.includes("/repos") || pathname.includes("/members")) return response({ message: "forbidden" }, { status: 403 });
      return response({ message: "not found" }, { status: 404 });
    },
    apiBaseUrl: "https://api.github.test",
    retryDelayMs: 0,
  });
  const acquired = await acquireGitHubEnterprise({ client, enterprise: "fixture-enterprise" });
  assert.equal(acquired.complete, false);
  assert.ok(acquired.failures.length >= 3);
  const environment = normalizeGitHubEnterprise(acquired, { extractionId: "partial", extractedAt: "2026-09-17T00:00:00Z" });
  assert.match(environment.source.omittedCapabilities.join(" "), /repositories/);
  assert.doesNotMatch(redactExtractionError(new Error("alice@example.test https://github.com/acme/private"), { anonymize: true }), /alice@example|github\.com/);
});
