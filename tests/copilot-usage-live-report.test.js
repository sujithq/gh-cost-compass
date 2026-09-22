import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveReport, toCsv } from "../tools/copilot-usage/live-report.mjs";

test("live report conserves credits into cost-centre buckets and emits numeric workbook rows", () => {
  const report = buildLiveReport({
    spineRows: [
      { day: "2026-09-18", user_id: 1, user_login: "alice", ai_credits_used: 12 },
      { day: "2026-09-18", user_id: 2, user_login: "bob", ai_credits_used: 8 },
    ],
    dailyRowsByDay: {
      "2026-09-18": [
        { day: "2026-09-18", user_id: 1, user_login: "alice", ai_credits_used: 12, used_cli: true, totals_by_feature: [{ feature: "copilot_cli", user_initiated_interaction_count: 2 }] },
        { day: "2026-09-18", user_id: 2, user_login: "bob", ai_credits_used: 8, used_chat: true, totals_by_model_feature: [{ model: "gpt-6", feature: "chat", user_initiated_interaction_count: 3 }] },
      ],
    },
    costCenters: {
      cost_centers: [
        { id: "cc-a", name: "A", resources: [{ type: "User", name: "alice" }] },
        { id: "cc-b", name: "B", resources: [{ type: "Org", name: "org-one" }] },
        { id: "cc-c", name: "C", resources: [{ type: "Org", name: "org-one" }] },
      ],
    },
    orgMembersByOrg: { "org-one": [{ login: "bob" }] },
    seats: { seats: [] },
    manifest: { enterprise: "demo", startDay: "2026-09-18", endDay: "2026-09-18", complete: true, missing: [] },
  });

  assert.equal(report.totals.credits, 20);
  assert.equal(report.totals.ambiguousRows, 1);
  assert.equal(report.byCostCenter.reduce((sum, row) => sum + row.credits, 0), 20);
  assert.match(toCsv(report.focusRows, ["ConsumedQuantity", "ConsumedUnit", "x_CostCenterName", "BilledCost"]), /ConsumedQuantity,ConsumedUnit,x_CostCenterName,BilledCost/);
  assert.equal(report.focusRows[0].ChargePeriodEnd, "2026-09-19");
  assert.equal(report.focusRows[0].BillingPeriodEnd, "2026-09-19");
  assert.equal(report.focusRows[0].PricingUnit, "Credits");
  assert.equal(report.focusRows[0].ConsumedUnit, "Credits");
  assert.match(report.workbookSheets.find((sheet) => sheet.name === "Summary").rows[5][0], /Credits/);
  assert.match(report.workbookSheets.find((sheet) => sheet.name === "Summary").rows[5][1].toString(), /^20$/);
});
