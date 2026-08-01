"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { financialYear, creditNoteNumber, computeCreditNote, gstAdjustmentAllowed } = require("./creditNote");

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.02, `${msg}: got ${a}, want ${b}`);

test("the financial year runs April to March", () => {
  assert.equal(financialYear("2026-04-01T06:00:00Z"), "26-27");
  assert.equal(financialYear("2026-03-31T06:00:00Z"), "25-26");
  assert.equal(financialYear("2026-12-15T06:00:00Z"), "26-27");
});

test("a late-night sale on 31 March belongs to the year that is ending", () => {
  // 23:30 IST on 31 March is 18:00 UTC — still FY 25-26, not the new one.
  assert.equal(financialYear("2026-03-31T18:00:00Z"), "25-26");
});

test("serial numbers are per financial year and zero-padded", () => {
  assert.equal(creditNoteNumber({ sequence: 1, date: "2026-05-01T06:00:00Z" }), "CN/26-27/0001");
  assert.equal(creditNoteNumber({ sequence: 42, date: "2026-05-01T06:00:00Z" }), "CN/26-27/0042");
  assert.equal(creditNoteNumber({ sequence: 1, date: "2026-02-01T06:00:00Z" }), "CN/25-26/0001");
});

const ITEMS = [
  { design_id: "a", quantity_boxes: 10, price_per_box: 100, gst_rate: 18 },
  { design_id: "b", quantity_boxes: 5, price_per_box: 200, gst_rate: 12 },
];

test("a full return credits the whole bill", () => {
  const cn = computeCreditNote({ originalItems: ITEMS, returnedQty: { a: 10, b: 5 }, gstMode: "included" });
  close(cn.totalCredit, 2000, "gross credited");
  close(cn.taxableValue, 1000 / 1.18 + 1000 / 1.12, "taxable at each line's own rate");
  assert.equal(cn.isFullReturn, true);
});

test("each line is credited at the rate it was sold at, not today's rate", () => {
  // The 12% line must not be credited at 18% just because another line was 18%.
  const cn = computeCreditNote({ originalItems: ITEMS, returnedQty: { b: 5 }, gstMode: "included" });
  close(cn.taxAmount, 1000 - 1000 / 1.12, "12% credited on the 12% line");
  assert.equal(cn.lines[0].gstRate, 12);
});

test("a partial return credits only what came back", () => {
  const cn = computeCreditNote({ originalItems: ITEMS, returnedQty: { a: 3 }, gstMode: "included" });
  close(cn.totalCredit, 300, "3 units of a 100 rupee item");
  assert.equal(cn.isFullReturn, false);
  assert.equal(cn.lines.length, 1, "untouched lines are not in the note");
});

test("returning more than was sold credits only what was sold", () => {
  const cn = computeCreditNote({ originalItems: ITEMS, returnedQty: { a: 999 }, gstMode: "included" });
  close(cn.totalCredit, 1000, "capped at the ten units actually billed");
});

test("a discount is credited in the same proportion it was given", () => {
  // 2000 bill with 200 off; returning half the value returns half the discount.
  const cn = computeCreditNote({
    originalItems: ITEMS, returnedQty: { a: 10 },   // 1000 of the 2000 gross
    discountAmount: 200, gstMode: "included",
  });
  close(cn.lines[0].discount, 100, "half the discount rides on the returned half");
  close(cn.totalCredit, 900, "customer paid 900 for these, so 900 comes back");
});

test("GST-exclusive bills credit tax on top, as they were charged", () => {
  const cn = computeCreditNote({
    originalItems: [{ design_id: "a", quantity_boxes: 1, price_per_box: 1000, gst_rate: 18 }],
    returnedQty: { a: 1 }, gstMode: "exclusive",
  });
  close(cn.taxableValue, 1000, "taxable is the listed price");
  close(cn.taxAmount, 180, "tax was added on top, so it is credited on top");
  close(cn.totalCredit, 1180, "the customer paid 1180");
});

test("a non-GST bill credits no tax", () => {
  const cn = computeCreditNote({
    originalItems: ITEMS, returnedQty: { a: 10 }, isGstInvoice: false,
  });
  assert.equal(cn.taxAmount, 0);
  close(cn.totalCredit, 1000, "the money still comes back");
});

test("an inter-state sale is credited as IGST, not CGST plus SGST", () => {
  // Crediting the wrong heads leaves the buyer unable to reverse what they claimed.
  const cn = computeCreditNote({
    originalItems: [{ design_id: "a", quantity_boxes: 1, price_per_box: 1180, gst_rate: 18 }],
    returnedQty: { a: 1 }, gstMode: "included", interState: true,
  });
  close(cn.igst, 180, "credited as IGST");
  assert.equal(cn.cgst, 0);
  assert.equal(cn.sgst, 0);
});

test("an intra-state credit splits into halves that add back exactly", () => {
  const cn = computeCreditNote({
    originalItems: [{ design_id: "a", quantity_boxes: 1, price_per_box: 1000.05, gst_rate: 18 }],
    returnedQty: { a: 1 }, gstMode: "included",
  });
  close(cn.cgst + cn.sgst, cn.taxAmount, "no paisa lost in halving");
});

test("returning nothing produces an empty note rather than a zero-value document", () => {
  const cn = computeCreditNote({ originalItems: ITEMS, returnedQty: {} });
  assert.equal(cn.lines.length, 0);
  assert.equal(cn.totalCredit, 0);
  assert.equal(cn.isFullReturn, false);
});

test("the GST adjustment deadline is 30 November after the financial year ends", () => {
  // Sale in FY 25-26 (ends 31 Mar 2026) → adjustable until 30 Nov 2026.
  const inTime = gstAdjustmentAllowed("2025-08-10T06:00:00Z", new Date("2026-10-01T06:00:00Z"));
  assert.equal(inTime.allowed, true);
  assert.equal(inTime.deadline, "2026-11-30");

  const tooLate = gstAdjustmentAllowed("2025-08-10T06:00:00Z", new Date("2026-12-05T06:00:00Z"));
  assert.equal(tooLate.allowed, false, "goods can still come back, but the tax cannot be recovered");
});
