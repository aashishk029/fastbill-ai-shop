"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { toCsv, escapeCell } = require("./csv");

test("plain values pass through unquoted", () => {
  assert.equal(escapeCell("Ramesh"), "Ramesh");
  assert.equal(escapeCell(1200), "1200");
  assert.equal(escapeCell(12.5), "12.5");
});

test("empty-ish values become empty fields, not the strings null or undefined", () => {
  assert.equal(escapeCell(null), "");
  assert.equal(escapeCell(undefined), "");
  assert.equal(escapeCell(""), "");
  assert.equal(escapeCell(0), "0", "zero is a real value, not empty");
  assert.equal(escapeCell(false), "false");
});

test("commas, quotes and newlines are quoted so columns cannot shift", () => {
  assert.equal(escapeCell("Sharma, Ramesh"), '"Sharma, Ramesh"');
  assert.equal(escapeCell('He said "hello"'), '"He said ""hello"""');
  assert.equal(escapeCell("Line1\nLine2"), '"Line1\nLine2"');
});

test("spreadsheet formulas are neutralised", () => {
  // A customer name stored innocently must not execute in the accountant's sheet.
  assert.equal(escapeCell("=1+1"), "'=1+1");
  assert.equal(escapeCell("+1"), "'+1");
  assert.equal(escapeCell("-1"), "'-1");
  assert.equal(escapeCell("@SUM(A1)"), "'@SUM(A1)");
  // This one also contains quotes and commas, so it ends up quoted as well —
  // the neutralising apostrophe sits inside the quoted field.
  assert.equal(
    escapeCell('=HYPERLINK("http://evil","x")'),
    `"'=HYPERLINK(""http://evil"",""x"")"`,
    "hyperlink attack defused and still correctly quoted",
  );
  assert.equal(escapeCell("Ram-Kumar"), "Ram-Kumar", "a hyphen inside a value is untouched");
});

test("dates and objects serialise instead of becoming [object Object]", () => {
  assert.equal(escapeCell(new Date("2026-08-01T00:00:00Z")), "2026-08-01T00:00:00.000Z");
  assert.equal(escapeCell({ a: 1 }), '"{""a"":1}"');
});

test("a document has a header row and one row per record", () => {
  const csv = toCsv([
    { name: "Ramesh", amount: 500 },
    { name: "Suresh", amount: 250 },
  ]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "name,amount");
  assert.equal(lines[1], "Ramesh,500");
  assert.equal(lines.length, 3);
});

test("columns present only in later rows are still exported", () => {
  // Dropping them would silently lose data an accountant needs.
  const csv = toCsv([{ a: 1 }, { a: 2, b: 3 }]);
  assert.equal(csv.trim().split("\r\n")[0], "a,b");
});

test("an explicit column list controls order and selection", () => {
  const csv = toCsv([{ b: 2, a: 1, secret: "x" }], ["a", "b"]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "a,b");
  assert.equal(lines[1], "1,2");
  assert.ok(!csv.includes("secret"), "unlisted columns are excluded");
});

test("no rows yields an empty document rather than a crash", () => {
  assert.equal(toCsv([]), "");
  assert.equal(toCsv(null), "");
});

test("headers are escaped too", () => {
  const csv = toCsv([{ "total, gross": 10 }]);
  assert.equal(csv.trim().split("\r\n")[0], '"total, gross"');
});
