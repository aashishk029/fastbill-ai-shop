"use strict";

/**
 * CSV generation for data export.
 *
 * Shopkeepers and their accountants open these files in Excel, Google Sheets or
 * LibreOffice, so two things matter beyond joining values with commas:
 *
 *  1. Correct quoting. A customer named  Sharma, Ramesh  or an address with a
 *     newline must not shift every later column into the wrong field.
 *  2. Formula injection. A spreadsheet treats a cell starting with = + - or @
 *     as a formula. A customer name of  =HYPERLINK("http://evil","click")
 *     stored innocently in the app becomes executable content in the
 *     accountant's spreadsheet. Such cells are prefixed with a single quote so
 *     they display as text — the standard defence, and cheap.
 */

const RISKY_PREFIX = /^[=+\-@\t\r]/;

/** Render one value as a CSV field. */
function escapeCell(value) {
  if (value === null || value === undefined) return "";

  let s;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);

  // Neutralise spreadsheet formulas before quoting.
  if (RISKY_PREFIX.test(s)) s = "'" + s;

  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Build a CSV document.
 *
 * @param rows    array of plain objects
 * @param columns optional ordered column list; defaults to the union of keys
 *                across all rows, so a field missing from the first row is not
 *                silently dropped from the export.
 */
function toCsv(rows, columns) {
  const list = Array.isArray(rows) ? rows : [];

  let cols = columns;
  if (!cols || cols.length === 0) {
    const seen = new Set();
    for (const row of list) {
      for (const key of Object.keys(row || {})) seen.add(key);
    }
    cols = [...seen];
  }

  if (cols.length === 0) return "";

  const header = cols.map(escapeCell).join(",");
  const body = list.map(row => cols.map(c => escapeCell((row || {})[c])).join(","));
  // CRLF: what Excel expects, and harmless everywhere else.
  return [header, ...body].join("\r\n") + "\r\n";
}

module.exports = { toCsv, escapeCell };
