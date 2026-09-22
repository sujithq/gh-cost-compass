import { writeFile } from "node:fs/promises";
import { buildAttributionRow, attributeUser, dedupeSeats, normalizeUsageRows, normalizeCostCenterPayload, AMBIGUOUS_COST_CENTER_ID } from "./live-adapter.mjs";
import { AI_CREDIT_USD, creditsToUsd, roundUsd } from "./contract.mjs";
import { buildWorkbookBuffer } from "./xlsx.mjs";

const EMPTY = () => [];

function rowsOf(value) {
  return Array.isArray(value) ? value : [];
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows, columns) {
  return `${[columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))].join("\n")}\n`;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

function add(map, key, value) {
  map.set(key, (map.get(key) ?? 0) + Number(value ?? 0));
}

function exclusiveNextDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function orgsByUser(orgMembersByOrg) {
  const result = new Map();
  for (const [org, members] of Object.entries(orgMembersByOrg ?? {})) {
    for (const member of rowsOf(members)) {
      const login = typeof member === "string" ? member : member.login;
      if (!login) continue;
      const orgs = result.get(login) ?? [];
      if (!orgs.includes(org)) orgs.push(org);
      result.set(login, orgs.sort());
    }
  }
  return result;
}

function normalizeSeats(rawSeats) {
  const rows = rowsOf(rawSeats?.seats ?? rawSeats).map((seat) => ({
    user_id: seat.user_id ?? seat.assignee?.id,
    user_login: seat.user_login ?? seat.assignee?.login,
    tier: seat.tier ?? seat.plan_type,
    starts_at: seat.starts_at ?? String(seat.created_at ?? "").slice(0, 10),
    ends_at: seat.ends_at ?? seat.pending_cancellation_date ?? null,
  }));
  return dedupeSeats(rows);
}

function modelRows(rows) {
  const result = new Map();
  for (const row of rows) {
    for (const item of rowsOf(row.totals_by_model_feature)) {
      const key = `${item.model ?? "unknown"}\0${item.feature ?? "unknown"}`;
      const entry = result.get(key) ?? { model: item.model ?? "unknown", feature: item.feature ?? "unknown", interactions: 0, code_generation: 0, code_acceptance: 0 };
      entry.interactions += Number(item.user_initiated_interaction_count ?? item.interaction_count ?? 0);
      entry.code_generation += Number(item.code_generation_activity_count ?? 0);
      entry.code_acceptance += Number(item.code_acceptance_activity_count ?? 0);
      result.set(key, entry);
    }
  }
  return [...result.values()].sort((a, b) => a.model.localeCompare(b.model) || a.feature.localeCompare(b.feature));
}

function languageRows(rows) {
  const result = new Map();
  for (const row of rows) {
    for (const item of rowsOf(row.totals_by_language_feature)) {
      const key = `${item.language ?? "unknown"}\0${item.feature ?? "unknown"}`;
      const entry = result.get(key) ?? { language: item.language ?? "unknown", feature: item.feature ?? "unknown", interactions: 0, code_generation: 0, code_acceptance: 0 };
      entry.interactions += Number(item.user_initiated_interaction_count ?? 0);
      entry.code_generation += Number(item.code_generation_activity_count ?? 0);
      entry.code_acceptance += Number(item.code_acceptance_activity_count ?? 0);
      result.set(key, entry);
    }
  }
  return [...result.values()].sort((a, b) => a.language.localeCompare(b.language) || a.feature.localeCompare(b.feature));
}

function surfaceRows(rows) {
  const result = new Map();
  for (const row of rows) {
    for (const item of rowsOf(row.totals_by_feature)) {
      const key = item.feature ?? "unknown";
      const entry = result.get(key) ?? { surface: key, interactions: 0, code_generation: 0, code_acceptance: 0 };
      entry.interactions += Number(item.user_initiated_interaction_count ?? 0);
      entry.code_generation += Number(item.code_generation_activity_count ?? 0);
      entry.code_acceptance += Number(item.code_acceptance_activity_count ?? 0);
      result.set(key, entry);
    }
  }
  return [...result.values()].sort((a, b) => a.surface.localeCompare(b.surface));
}

function cliRows(rows) {
  const total = { sessions: 0, requests: 0, prompts: 0, prompt_tokens: 0, output_tokens: 0 };
  for (const row of rows) {
    const cli = row.totals_by_cli;
    if (!cli) continue;
    total.sessions += Number(cli.session_count ?? 0);
    total.requests += Number(cli.request_count ?? 0);
    total.prompts += Number(cli.prompt_count ?? 0);
    total.prompt_tokens += Number(cli.token_usage?.prompt_tokens_sum ?? 0);
    total.output_tokens += Number(cli.token_usage?.output_tokens_sum ?? 0);
  }
  return [total];
}

export function buildLiveReport({ spineRows, dailyRowsByDay, costCenters, orgMembersByOrg = {}, seats: rawSeats = {}, manifest }) {
  const spine = normalizeUsageRows(spineRows);
  const daily = Object.fromEntries(Object.entries(dailyRowsByDay ?? {}).map(([day, rows]) => [day, normalizeUsageRows(rows)]));
  const enriched = Object.values(daily).flat();
  const membership = costCenters?.captured_at ? costCenters : normalizeCostCenterPayload(costCenters);
  const usersToOrgs = orgsByUser(orgMembersByOrg);
  const dedupedSeats = normalizeSeats(rawSeats);
  const detailsByKey = new Map(enriched.map((row) => [`${row.day_partition}\0${row.user_id}`, row]));
  const facts = spine.map((row) => {
    const detail = detailsByKey.get(`${row.day_partition}\0${row.user_id}`) ?? {};
    const orgs = usersToOrgs.get(row.user_login) ?? [];
    const attributed = buildAttributionRow({
      usageRow: { ...row, ...detail },
      costCenters: membership.cost_centers,
      teamIds: [],
    });
    return {
      ...attributed,
      enriched: Boolean(detailsByKey.has(`${row.day_partition}\0${row.user_id}`)),
      interactions: Number(detail.user_initiated_interaction_count ?? 0),
      code_generation: Number(detail.code_generation_activity_count ?? 0),
      code_acceptance: Number(detail.code_acceptance_activity_count ?? 0),
      used_cli: Boolean(detail.used_cli),
      used_chat: Boolean(detail.used_chat),
      used_agent: Boolean(detail.used_agent),
      prompt_tokens_sum: Number(detail.totals_by_cli?.token_usage?.prompt_tokens_sum ?? 0),
      org_candidates: orgs.join(";"),
    };
  });
  // Re-run attribution with the full org membership list because usage rows do not contain an org id.
  for (const fact of facts) {
    const orgs = usersToOrgs.get(fact.user_login) ?? [];
    const resolution = attributeUser({ userId: fact.user_id, userLogin: fact.user_login, organizationIds: orgs, costCenters: membership.cost_centers });
    fact.cost_center_id = resolution.cost_center_id;
    fact.cost_center_name = resolution.cost_center_name;
    fact.attribution_route = resolution.route;
    if (resolution.ambiguous_candidates) fact.ambiguous_candidates = resolution.ambiguous_candidates;
  }

  const byUserMap = new Map();
  const byCostMap = new Map();
  for (const fact of facts) {
    const user = byUserMap.get(fact.user_login) ?? { user: fact.user_login, user_id: fact.user_id, cost_center: fact.cost_center_name, attribution_route: fact.attribution_route, credits: 0, active_days: 0 };
    user.credits += fact.ai_credits_used;
    user.active_days += fact.ai_credits_used > 0 ? 1 : 0;
    byUserMap.set(fact.user_login, user);
    const cc = byCostMap.get(fact.cost_center_id) ?? { cost_center: fact.cost_center_name, cost_center_id: fact.cost_center_id, credits: 0, users: new Set() };
    cc.credits += fact.ai_credits_used;
    cc.users.add(fact.user_login);
    byCostMap.set(fact.cost_center_id, cc);
  }
  const byUser = [...byUserMap.values()].map((row) => ({ ...row, usd: roundUsd(row.credits * AI_CREDIT_USD) })).sort((a, b) => a.user.localeCompare(b.user));
  const totalCredits = sum(facts, "ai_credits_used");
  const byCostCenter = [...byCostMap.values()].map((row) => ({ ...row, users: row.users.size, usd: roundUsd(row.credits * AI_CREDIT_USD), share: totalCredits ? row.credits / totalCredits : 0 })).sort((a, b) => a.cost_center.localeCompare(b.cost_center) || a.cost_center_id.localeCompare(b.cost_center_id));
  const detailRows = enriched;
  const ambiguity = facts.filter((row) => row.cost_center_id === AMBIGUOUS_COST_CENTER_ID);
  const caveats = [
    ["Credits", "ai_credits_used is exact and valued at $0.01 per credit; GitHub does not publish a model/feature credit split."],
    ["Model/language/surface", "These sheets contain observed interaction counts, never credit amounts."],
    ["Harness coverage", `${enriched.length} enriched daily rows from ${Object.keys(daily).length} days; the 28-day spine is used for exact credits.`],
    ["Ambiguous attribution", `${ambiguity.length} user-day rows are in the explicit ambiguous bucket; candidates are retained in the facts.`],
    ["Seats", `One seat per user; enterprise wins over business. Collisions: ${dedupedSeats.collisions.length}.`],
    ["Workbook USD display", "By user and By cost centre display USD rounded to cents for readability; Daily facts and focus.csv retain full precision."],
    ["Empty dimensions", "The live tenant returned no IDE, MCP, slash-command, or plugin rows and used neither chat nor agent."],
    ["Missing days", `${(manifest?.missing ?? []).length} report gaps are preserved in the manifest; empty download_links means no data, not an API error.`],
  ];
  const model = modelRows(detailRows);
  const language = languageRows(detailRows);
  const surfaces = surfaceRows(detailRows);
  const cli = cliRows(detailRows);
  const sheets = [
    { name: "Summary", rows: [["Metric", "Value"], ["Enterprise", manifest?.enterprise ?? ""], ["Window start", manifest?.startDay ?? ""], ["Window end", manifest?.endDay ?? ""], ["Rows", facts.length], ["Credits", totalCredits], ["USD", totalCredits * AI_CREDIT_USD], ["Enriched rows", enriched.length], ["Coverage", manifest?.complete ? "complete" : "gaps"] ] },
    { name: "By cost centre", rows: [["Cost centre", "Cost centre ID", "Credits", "USD", "Users", "Share"], ...byCostCenter.map((r) => [r.cost_center, r.cost_center_id, r.credits, r.usd, r.users, r.share])] },
    { name: "By user", rows: [["User", "User ID", "Cost centre", "Attribution route", "Credits", "USD", "Active days"], ...byUser.map((r) => [r.user, r.user_id, r.cost_center, r.attribution_route, r.credits, r.usd, r.active_days])] },
    { name: "Daily facts", rows: [["Day", "User", "User ID", "Cost centre", "Attribution route", "Credits", "USD", "Enriched", "Interactions", "Code generation", "Code acceptance", "Org candidates"], ...facts.map((r) => [r.day, r.user_login, r.user_id, r.cost_center_name, r.attribution_route, r.ai_credits_used, r.usage_usd, r.enriched, r.interactions, r.code_generation, r.code_acceptance, r.org_candidates])] },
    { name: "Model mix", rows: [["Model", "Feature", "Interactions", "Code generation", "Code acceptance"], ...model.map((r) => [r.model, r.feature, r.interactions, r.code_generation, r.code_acceptance])] },
    { name: "Language mix", rows: [["Language", "Feature", "Interactions", "Code generation", "Code acceptance"], ...language.map((r) => [r.language, r.feature, r.interactions, r.code_generation, r.code_acceptance])] },
    { name: "Surface harness", rows: [["Surface", "Interactions", "Code generation", "Code acceptance"], ...surfaces.map((r) => [r.surface, r.interactions, r.code_generation, r.code_acceptance])] },
    { name: "CLI tokens", rows: [["Sessions", "Requests", "Prompts", "Prompt tokens", "Output tokens"], ...cli.map((r) => [r.sessions, r.requests, r.prompts, r.prompt_tokens, r.output_tokens])] },
    { name: "Caveats", rows: [["Topic", "Disclosure"], ...caveats] },
  ];
  const focusRows = facts.map((row) => ({
    BillingAccountId: manifest?.enterprise ?? "",
    BillingPeriodStart: manifest?.startDay ?? "",
    BillingPeriodEnd: manifest?.endDay ? exclusiveNextDay(manifest.endDay) : "",
    ChargePeriodStart: row.day,
    ChargePeriodEnd: exclusiveNextDay(row.day),
    BilledCost: row.usage_usd,
    EffectiveCost: row.usage_usd,
    ListCost: row.usage_usd,
    ContractedCost: row.usage_usd,
    ChargeCategory: "Usage",
    ChargeClass: "",
    ResourceId: row.user_id,
    ResourceName: row.user_login,
    ServiceName: "GitHub Copilot",
    ServiceCategory: "AI and Machine Learning",
    ServiceProviderName: "GitHub",
    HostProviderName: "GitHub",
    InvoiceIssuerName: "GitHub",
    ChargeDescription: "GitHub Copilot AI credits",
    PricingQuantity: row.ai_credits_used,
    PricingUnit: "Credits",
    ConsumedQuantity: row.ai_credits_used,
    ConsumedUnit: "Credits",
    x_CostCenterName: row.cost_center_name,
    x_ModelName: "",
    x_HarnessName: row.used_cli ? "copilot_cli" : "",
    x_UserLogin: row.user_login,
    x_AttributionRoute: row.attribution_route,
    x_PromptTokensSum: Number(row.prompt_tokens_sum ?? 0),
    x_ChargeDay: row.day,
  }));
  return { facts, byUser, byCostCenter, model, language, surfaces, cli, caveats, focusRows, seats: dedupedSeats, workbookSheets: sheets, workbook: buildWorkbookBuffer(sheets), totals: { credits: totalCredits, usd: totalCredits * AI_CREDIT_USD, enrichedRows: enriched.length, ambiguousRows: ambiguity.length } };
}

export async function writeLiveOutputs(outDir, report) {
  await writeFile(`${outDir}/chargeback.xlsx`, report.workbook);
  await writeFile(`${outDir}/focus.csv`, toCsv(report.focusRows, Object.keys(report.focusRows[0] ?? { BillingAccountId: "" })));
  await writeFile(`${outDir}/daily-facts.csv`, toCsv(report.facts, ["day", "user_login", "user_id", "cost_center_name", "attribution_route", "ai_credits_used", "usage_usd", "enriched", "interactions", "code_generation", "code_acceptance", "org_candidates"]));
  await writeFile(`${outDir}/live-report.json`, `${JSON.stringify({ totals: report.totals, byUser: report.byUser, byCostCenter: report.byCostCenter, caveats: report.caveats }, null, 2)}\n`);
}
