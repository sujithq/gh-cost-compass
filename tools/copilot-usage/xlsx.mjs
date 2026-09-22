/**
 * Dependency-free, minimal `.xlsx` writer.
 *
 * An `.xlsx` file is a ZIP archive of OOXML SpreadsheetML parts. This module builds that ZIP by
 * hand using only `node:zlib` (for DEFLATE compression) and `node:fs`/`node:path` (for writing the
 * result); it never shells out to a `zip` binary and never depends on any third-party package,
 * consistent with the rest of this repo.
 *
 * Scope is intentionally minimal: multiple named sheets, string/number/boolean cells, no styles,
 * no formulas, no shared-string table (strings are written inline). This is enough to produce a
 * spreadsheet Excel/LibreOffice/Google Sheets can open, for reports that only need tidy tables.
 */

import { deflateRawSync } from "node:zlib";
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";

const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Convert a JS Date to the (time, date) uint16 pair the ZIP format stores timestamps as. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

/**
 * Build a `.zip` (here, `.xlsx`) archive from a list of `{ name, data }` file entries using
 * DEFLATE compression via `node:zlib`. Implements just enough of the ZIP local/central-directory
 * format for spreadsheet applications to read: no zip64, no encryption, no archive comment.
 */
function buildZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const data = file.data;
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(8, 8); // compression method: DEFLATE
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    localChunks.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory file header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
    centralHeader.writeUInt16LE(8, 10); // compression method
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    centralChunks.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralChunks);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  endRecord.writeUInt16LE(0, 4); // number of this disk
  endRecord.writeUInt16LE(0, 6); // disk where central directory starts
  endRecord.writeUInt16LE(files.length, 8); // number of central directory records on this disk
  endRecord.writeUInt16LE(files.length, 10); // total number of central directory records
  endRecord.writeUInt32LE(centralDirectory.length, 12); // size of central directory
  endRecord.writeUInt32LE(centralDirectoryOffset, 16); // offset of start of central directory
  endRecord.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralDirectory, endRecord]);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Convert a zero-based column index to its spreadsheet letter(s): 0 -> A, 25 -> Z, 26 -> AA. */
function columnLetters(index) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellXml(value, ref) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite numeric cell value at ${ref}: ${value}`);
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function buildSheetXml(rows) {
  const rowsXml = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cellsXml = row
        .map((value, colIndex) => cellXml(value, `${columnLetters(colIndex)}${rowNumber}`))
        .join("");
      return `<row r="${rowNumber}">${cellsXml}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetData>${rowsXml}</sheetData></worksheet>`;
}

function sanitizeSheetName(name, index) {
  const cleaned = String(name ?? "").replace(/[:\\/?*[\]]/g, "_").slice(0, 31).trim();
  return cleaned.length > 0 ? cleaned : `Sheet${index + 1}`;
}

function buildContentTypesXml(sheetCount) {
  const overrides = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `${overrides}</Types>`;
}

function buildRootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`;
}

function buildWorkbookXml(sheets) {
  const sheetEntries = sheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${sheetEntries}</sheets></workbook>`;
}

function buildWorkbookRelsXml(sheetCount) {
  const relationships = Array.from({ length: sheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

/**
 * Build an in-memory `.xlsx` workbook as a `Buffer`.
 *
 * `sheets` is an array of `{ name, rows }`, where `rows` is an array of arrays of cell values.
 * Supported cell value types: `number` (written as a real numeric cell, not a string), `boolean`,
 * `string`, and `null`/`undefined` (written as an empty cell). Sheet names are sanitized to the
 * 31-character, punctuation-restricted subset Excel requires.
 */
export function buildWorkbookBuffer(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error("buildWorkbookBuffer requires a non-empty array of { name, rows } sheets.");
  }

  const normalizedSheets = sheets.map((sheet, index) => ({
    name: sanitizeSheetName(sheet?.name, index),
    rows: Array.isArray(sheet?.rows) ? sheet.rows : [],
  }));

  const files = [
    { name: "[Content_Types].xml", data: Buffer.from(buildContentTypesXml(normalizedSheets.length), "utf8") },
    { name: "_rels/.rels", data: Buffer.from(buildRootRelsXml(), "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(buildWorkbookXml(normalizedSheets), "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(buildWorkbookRelsXml(normalizedSheets.length), "utf8") },
    ...normalizedSheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: Buffer.from(buildSheetXml(sheet.rows), "utf8"),
    })),
  ];

  return buildZip(files);
}

/** Build the workbook and write it to `path`, creating any missing parent directories. */
export async function writeWorkbook(path, sheets) {
  const buffer = buildWorkbookBuffer(sheets);
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, buffer);
  return buffer;
}