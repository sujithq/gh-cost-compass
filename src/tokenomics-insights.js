const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function sum(items, valueFor) {
  return items.reduce((total, item) => total + number(valueFor(item)), 0);
}

function sortedEntries(map, valueKey) {
  return [...map.values()].sort((left, right) => right[valueKey] - left[valueKey]);
}

export function parseEnterpriseUsageNdjson(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("The enterprise usage export is empty.");
  const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Line ${index + 1} is not valid JSON.`);
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Line ${index + 1} is not an object.`);
    if (!row.user_login || !row.day) throw new Error(`Line ${index + 1} is missing user_login or day.`);
    if (!Number.isFinite(Number(row.ai_credits_used))) throw new Error(`Line ${index + 1} has an invalid ai_credits_used value.`);
    return row;
  });
  if (!rows.length) throw new Error("The enterprise usage export has no data rows.");
  return rows;
}

export function summarizeEnterpriseUsage(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("At least one enterprise usage row is required.");
  const users = new Map();
  const modelFeatures = new Map();
  const days = new Set();
  let reportStart = null;
  let reportEnd = null;

  for (const row of rows) {
    days.add(row.day);
    if (row.report_start_day && (!reportStart || row.report_start_day < reportStart)) reportStart = row.report_start_day;
    if (row.report_end_day && (!reportEnd || row.report_end_day > reportEnd)) reportEnd = row.report_end_day;
    const current = users.get(row.user_login) || {
      login: row.user_login,
      credits: 0,
      interactions: 0,
      generations: 0,
      acceptances: 0,
      locSuggested: 0,
      locAdded: 0,
      cliSessions: 0,
      cliRequests: 0,
      cliPrompts: 0,
      cliPromptTokens: 0,
      cliOutputTokens: 0,
      surfaces: new Set(),
    };
    current.credits += number(row.ai_credits_used);
    current.interactions += number(row.user_initiated_interaction_count);
    current.generations += number(row.code_generation_activity_count);
    current.acceptances += number(row.code_acceptance_activity_count);
    current.locSuggested += number(row.loc_suggested_to_add_sum);
    current.locAdded += number(row.loc_added_sum);
    if (row.used_chat || row.used_agent) current.surfaces.add("IDE chat");
    if (row.used_cli) current.surfaces.add("Copilot CLI");
    if (row.used_copilot_coding_agent) current.surfaces.add("Coding agent");
    if (row.used_copilot_cloud_agent) current.surfaces.add("Cloud agent");
    if (row.used_copilot_code_review_active || row.used_copilot_code_review_passive) current.surfaces.add("Code review");
    if (row.used_copilot_app) current.surfaces.add("Copilot app");
    if (row.totals_by_cli) {
      current.cliSessions += number(row.totals_by_cli.session_count);
      current.cliRequests += number(row.totals_by_cli.request_count);
      current.cliPrompts += number(row.totals_by_cli.prompt_count);
      current.cliPromptTokens += number(row.totals_by_cli.token_usage?.prompt_tokens_sum);
      current.cliOutputTokens += number(row.totals_by_cli.token_usage?.output_tokens_sum);
    }
    users.set(row.user_login, current);

    for (const item of row.totals_by_model_feature || []) {
      const key = `${item.model || "unknown"}\u0000${item.feature || "unknown"}`;
      const aggregate = modelFeatures.get(key) || {
        model: item.model || "unknown",
        feature: item.feature || "unknown",
        interactions: 0,
        generations: 0,
        acceptances: 0,
      };
      aggregate.interactions += number(item.user_initiated_interaction_count ?? item.interaction_count);
      aggregate.generations += number(item.code_generation_activity_count);
      aggregate.acceptances += number(item.code_acceptance_activity_count);
      modelFeatures.set(key, aggregate);
    }
  }

  const userList = sortedEntries(users, "credits").map((user) => ({
    ...user,
    usageValueUsd: user.credits * 0.01,
    acceptanceRate: user.generations ? user.acceptances / user.generations : null,
    surfaces: [...user.surfaces].sort(),
  }));
  const credits = sum(userList, (user) => user.credits);
  const generations = sum(userList, (user) => user.generations);
  const acceptances = sum(userList, (user) => user.acceptances);

  return {
    source: "GitHub enterprise usage metrics",
    reportStart: reportStart || [...days].sort()[0],
    reportEnd: reportEnd || [...days].sort().at(-1),
    rowCount: rows.length,
    dayCount: days.size,
    userCount: userList.length,
    credits,
    usageValueUsd: credits * 0.01,
    interactions: sum(userList, (user) => user.interactions),
    generations,
    acceptances,
    acceptanceRate: generations ? acceptances / generations : null,
    users: userList,
    modelFeatures: sortedEntries(modelFeatures, "interactions"),
  };
}

const PRIVATE_KEYS = new Set([
  "prompt",
  "prompts",
  "reply",
  "replies",
  "user_message",
  "assistant_response",
  "session_id",
  "sessionId",
]);

function findUnsafeChronicleContent(value, path = "$") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = findUnsafeChronicleContent(value[index], `${path}[${index}]`);
      if (issue) return issue;
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && (/^[A-Za-z]:\\/.test(value) || /^\/(?:Users|home)\//.test(value))) {
      return `${path} contains an absolute user path`;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (path === "$" && key === "evidence") return "$.evidence is private working data";
    if (PRIVATE_KEYS.has(key)) return `${path}.${key} is private working data`;
    const issue = findUnsafeChronicleContent(child, `${path}.${key}`);
    if (issue) return issue;
  }
  return null;
}

export function parseFinalizedChronicleReport(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error("The Chronicle report is not valid JSON.");
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("The Chronicle report must be a JSON object.");
  if (report.schemaVersion !== 3) throw new Error("Only finalized Chronicle schema version 3 reports are supported.");
  if (!report.metadata || !report.metrics?.totals || !Array.isArray(report.metrics.slices) || !report.findings) {
    throw new Error("The Chronicle report is missing required metadata, metrics, slices, or findings.");
  }
  if (report.metadata.redacted !== true) throw new Error("Import a finalized Chronicle report created with redaction enabled.");
  const unsafe = findUnsafeChronicleContent(report);
  if (unsafe) throw new Error(`Chronicle import rejected: ${unsafe}.`);
  return report;
}

export function summarizeChronicleReport(report) {
  const totals = report.metrics.totals;
  return {
    source: "Opt-in local Chronicle report",
    reportStart: String(report.metadata.analysisWindow || "").split(" to ")[0] || null,
    reportEnd: String(report.metadata.analysisWindow || "").split(" to ")[1] || null,
    sessions: number(totals.sessions),
    repositories: number(totals.repositories),
    surfaces: number(totals.surfaces),
    surfaceNames: Array.isArray(totals.surfaceNames) ? totals.surfaceNames : [],
    calls: number(totals.calls),
    models: number(totals.models),
    inputTokens: totals.inputTokens == null ? null : number(totals.inputTokens),
    outputTokens: totals.outputTokens == null ? null : number(totals.outputTokens),
    cacheReadTokens: totals.cacheReadTokens == null ? null : number(totals.cacheReadTokens),
    cacheWriteTokens: totals.cacheWriteTokens == null ? null : number(totals.cacheWriteTokens),
    reasoningTokens: totals.reasoningTokens == null ? null : number(totals.reasoningTokens),
    topCostDriver: totals.topCostDriver || "",
    topRecommendedAction: totals.topRecommendedAction || "",
    slices: report.metrics.slices,
    findings: report.findings,
    reconciliationOk: report.metrics.reconciliation?.ok === true,
    dataQuality: report.findings.dataQuality || "",
    limitations: report.findings.limitations || "",
  };
}

export function compareInsightCoverage(enterprise, chronicle) {
  return [
    {
      dimension: "AI credits and usage-valued USD",
      enterprise: enterprise ? "Exact user/day totals" : "Not imported",
      chronicle: "Not authoritative",
    },
    {
      dimension: "IDE, CLI, agents, models, languages",
      enterprise: enterprise ? "Interaction/activity counters" : "Not imported",
      chronicle: chronicle ? "Local CLI surfaces and token telemetry" : "Not imported",
    },
    {
      dimension: "Repositories, files, tasks, outcomes",
      enterprise: "Not available",
      chronicle: chronicle ? "Opt-in local evidence and findings" : "Not imported",
    },
    {
      dimension: "Invoice or model-level dollar allocation",
      enterprise: "Requires the separate billing usage report",
      chronicle: "Not available",
    },
  ];
}
