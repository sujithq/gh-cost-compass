import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import {
  attributeUser,
  buildAttributionRow,
  dedupeSeats,
  normalizeCostCenterPayload,
  normalizeId,
  normalizeUsageRow,
  normalizeUsageRows,
  AMBIGUOUS_COST_CENTER_ID,
} from "../tools/copilot-usage/live-adapter.mjs";
import { UNALLOCATED_COST_CENTER_ID } from "../tools/copilot-usage/contract.mjs";
import { buildWorkbookBuffer } from "../tools/copilot-usage/xlsx.mjs";

test("normalizeUsageRow coerces numeric user_id and renames day to day_partition", () => {
  const row = normalizeUsageRow({
    day: "2026-09-18",
    entity_id_partition: "ent-demo",
    enterprise_id: "ent-demo",
    organization_id: "",
    user_id: 424242,
    user_login: "alice",
    ai_credits_used: 160,
    ai_adoption_phase: { name: "Phase 3" },
    totals_by_model_feature: [{ model: "gpt-5", feature: "chat", interaction_count: 18 }],
    etl_id: "",
  });

  assert.equal(row.user_id, "424242");
  assert.equal(typeof row.user_id, "string");
  assert.equal(row.day_partition, "2026-09-18");
  assert.equal(row.ai_adoption_phase, "Phase 3");
  assert.equal(row.organization_id, null);
  assert.equal(row.etl_id, null);
  assert.deepEqual(row.totals_by_model_feature, [{ model: "gpt-5", feature: "chat", interaction_count: 18 }]);
});

test("normalizeUsageRow accepts a plain string ai_adoption_phase and omits it when absent", () => {
  const withPhase = normalizeUsageRow({ day_partition: "2026-09-18", user_id: "user-a", ai_credits_used: 1, ai_adoption_phase: "Phase 1" });
  const withoutPhase = normalizeUsageRow({ day_partition: "2026-09-18", user_id: "user-a", ai_credits_used: 1 });

  assert.equal(withPhase.ai_adoption_phase, "Phase 1");
  assert.equal("ai_adoption_phase" in withoutPhase, false);
});

test("normalizeUsageRow works for a users-28-day row shape and defaults missing breakdown to []", () => {
  const row = normalizeUsageRow({ day_partition: "2026-09-01", user_id: "user-b", user_login: "bob", ai_credits_used: 12 });
  assert.deepEqual(row.totals_by_model_feature, []);
  assert.equal(row.user_login, "bob");
});

test("normalizeUsageRows normalizes every row and rejects a missing user_id", () => {
  const rows = normalizeUsageRows([
    { day: "2026-09-18", user_id: 1, ai_credits_used: 5 },
    { day: "2026-09-18", user_id: "user-2", ai_credits_used: 7 },
  ]);
  assert.deepEqual(rows.map((row) => row.user_id), ["1", "user-2"]);
  assert.throws(() => normalizeUsageRows([{ day: "2026-09-18", ai_credits_used: 1 }]), /user_id/);
});

test("normalizeCostCenterPayload buckets resources by type and preserves duplicates/deleted/state", () => {
  const membership = normalizeCostCenterPayload({
    costCenters: [
      {
        id: "cc-ai",
        name: "AI Innovation",
        state: "active",
        resources: [
          { type: "User", name: "alice", id: 555 },
          { type: "User", name: "alice", id: 555 }, // duplicate entry, preserved verbatim
          { type: "User", name: "old-alice", id: 555, deleted: true },
          { type: "Org", name: "org-product" },
          { type: "Team", name: "team-core" },
        ],
      },
      { id: "cc-archived", name: "Retired", state: "archived", deleted: true, resources: [] },
    ],
  });

  const cc = membership.cost_centers.find((c) => c.id === "cc-ai");
  assert.deepEqual(cc.user_ids, ["555"]); // numeric id normalized to string, deduped
  assert.deepEqual(cc.organization_ids, ["org-product"]);
  assert.deepEqual(cc.team_ids, ["team-core"]);
  assert.equal(cc.resources.length, 5); // every raw resource preserved, including the deleted one
  assert.equal(cc.resources.filter((r) => r.deleted).length, 1);

  const archived = membership.cost_centers.find((c) => c.id === "cc-archived");
  assert.equal(archived.state, "archived");
  assert.equal(archived.deleted, true);
});

test("dedupeSeats keeps one seat per user and enterprise wins over business", () => {
  const { seats, collisions } = dedupeSeats([
    { user_id: "user-a", tier: "business", starts_at: "2026-09-01", ends_at: null },
    { user_id: "user-a", tier: "enterprise", starts_at: "2026-09-10", ends_at: null },
    { user_id: "user-b", tier: "business", starts_at: "2026-09-01", ends_at: null },
  ]);

  assert.equal(seats.length, 2);
  const userA = seats.find((s) => s.user_id === "user-a");
  assert.equal(userA.tier, "enterprise");
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].user_id, "user-a");
  assert.equal(collisions[0].winner.tier, "enterprise");
  assert.equal(collisions[0].dropped[0].tier, "business");
  assert.equal(collisions[0].reason, "higher-tier-precedence");
});

test("dedupeSeats breaks same-tier ties deterministically by earliest starts_at", () => {
  const { seats, collisions } = dedupeSeats([
    { user_id: "user-a", tier: "business", starts_at: "2026-09-10", ends_at: null },
    { user_id: "user-a", tier: "business", starts_at: "2026-09-01", ends_at: null },
  ]);
  assert.equal(seats.find((s) => s.user_id === "user-a").starts_at, "2026-09-01");
  assert.equal(collisions[0].reason, "duplicate-seat-earliest-start");
});

test("attributeUser: direct user match wins over org/team candidates", () => {
  const costCenters = [
    { id: "cc-ai", name: "AI Innovation", user_ids: ["user-alice"], team_ids: [], organization_ids: ["org-product"] },
    { id: "cc-core", name: "Core Platform", user_ids: [], team_ids: [], organization_ids: ["org-product"] },
  ];
  const result = attributeUser({ userId: "user-alice", organizationId: "org-product", costCenters });
  assert.equal(result.cost_center_id, "cc-ai");
  assert.equal(result.route, "user");
});

test("attributeUser: exactly one org candidate wins when there is no direct/team match", () => {
  const costCenters = [
    { id: "cc-core", name: "Core Platform", user_ids: [], team_ids: [], organization_ids: ["org-platform"] },
    { id: "cc-other", name: "Other", user_ids: [], team_ids: [], organization_ids: ["org-unrelated"] },
  ];
  const result = attributeUser({ userId: "user-bob", organizationId: "org-platform", costCenters });
  assert.equal(result.cost_center_id, "cc-core");
  assert.equal(result.route, "organization");
});

test("attributeUser: two or more org candidates route to the explicit ambiguous bucket", () => {
  const costCenters = [
    { id: "cc-a", name: "A", user_ids: [], team_ids: [], organization_ids: ["org-shared"] },
    { id: "cc-b", name: "B", user_ids: [], team_ids: [], organization_ids: ["org-shared"] },
  ];
  const result = attributeUser({ userId: "user-x", organizationId: "org-shared", costCenters });
  assert.equal(result.cost_center_id, AMBIGUOUS_COST_CENTER_ID);
  assert.equal(result.route, "ambiguous");
  assert.equal(result.ambiguous_stage, "organization");
  assert.deepEqual(result.ambiguous_candidates.map((c) => c.id).sort(), ["cc-a", "cc-b"]);
});

test("attributeUser: no candidates falls back to the unallocated bucket", () => {
  const result = attributeUser({ userId: "user-nobody", organizationId: "org-none", costCenters: [] });
  assert.equal(result.cost_center_id, UNALLOCATED_COST_CENTER_ID);
  assert.equal(result.route, "none");
});

test("buildAttributionRow preserves credits even when attribution is ambiguous", () => {
  const costCenters = [
    { id: "cc-a", name: "A", user_ids: [], team_ids: [], organization_ids: ["org-shared"] },
    { id: "cc-b", name: "B", user_ids: [], team_ids: [], organization_ids: ["org-shared"] },
  ];
  const row = buildAttributionRow({
    usageRow: { day_partition: "2026-09-18", user_id: "user-x", user_login: "x", organization_id: "org-shared", ai_credits_used: 42 },
    costCenters,
  });
  assert.equal(row.ai_credits_used, 42);
  assert.equal(row.cost_center_id, AMBIGUOUS_COST_CENTER_ID);
  assert.ok(Array.isArray(row.ambiguous_candidates));
});

test("normalizeId coerces numbers and blanks strings to null", () => {
  assert.equal(normalizeId(123), "123");
  assert.equal(normalizeId("  abc  "), "abc");
  assert.equal(normalizeId(""), null);
  assert.equal(normalizeId(null), null);
});

function readZipEntries(buffer) {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, "End of central directory record not found");
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);

  const entries = [];
  let cursor = centralDirOffset;
  for (let i = 0; i < entryCount; i += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, "Central directory signature mismatch");
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = inflateRawSync(compressed);
    assert.equal(data.length, uncompressedSize);
    entries.push({ name, data });
  }
  return entries;
}

test("buildWorkbookBuffer produces a valid multi-sheet zip with numeric and string cells", () => {
  const buffer = buildWorkbookBuffer([
    { name: "Summary", rows: [["User", "Credits"], ["user-alice", 160], ["user-bob", 15.5]] },
    { name: "Detail/Weird*Name", rows: [[1, 2, 3]] },
  ]);

  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 2).toString("ascii"), "PK");

  const entries = readZipEntries(buffer);
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/_rels/workbook.xml.rels",
    "xl/workbook.xml",
    "xl/worksheets/sheet1.xml",
    "xl/worksheets/sheet2.xml",
  ]);

  const workbookXml = entries.find((e) => e.name === "xl/workbook.xml").data.toString("utf8");
  assert.match(workbookXml, /name="Summary"/);
  assert.match(workbookXml, /name="Detail_Weird_Name"/); // sanitized: / and * are stripped

  const sheet1Xml = entries.find((e) => e.name === "xl/worksheets/sheet1.xml").data.toString("utf8");
  assert.match(sheet1Xml, /<c r="B2"><v>160<\/v><\/c>/); // numeric cell, no t= attribute
  assert.match(sheet1Xml, /<c r="A1" t="inlineStr"><is><t[^>]*>User<\/t><\/is><\/c>/);
  assert.match(sheet1Xml, /<v>15\.5<\/v>/);
});

test("buildWorkbookBuffer rejects an empty sheet list", () => {
  assert.throws(() => buildWorkbookBuffer([]), /non-empty array/);
});