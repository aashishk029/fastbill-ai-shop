"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { invoiceNumber } = require("./invoiceNumber");

test("an invoice number carries its financial year and sequence", () => {
  assert.equal(invoiceNumber({ sequence: 1, date: "2026-05-01T06:00:00Z" }), "INV/26-27/00001");
  assert.equal(invoiceNumber({ sequence: 42, date: "2026-05-01T06:00:00Z" }), "INV/26-27/00042");
});

test("the financial year rolls over on 1 April IST, same as credit notes", () => {
  assert.equal(invoiceNumber({ sequence: 1, date: "2026-02-01T06:00:00Z" }), "INV/25-26/00001");
});

test("stays within the 16-character limit CGST Rule 46(b) sets", () => {
  const n = invoiceNumber({ sequence: 99999, date: "2026-05-01T06:00:00Z" });
  assert.ok(n.length <= 16, `"${n}" is ${n.length} characters`);
});
