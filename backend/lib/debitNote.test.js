"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { supplierKey, debitNoteNumber, computeDebitNote } = require("./debitNote");

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.02, `${msg}: got ${a}, want ${b}`);

// A consignment: 100 units at ₹100, 18% GST, credit claimed.
const PURCHASE = {
  quantity_boxes: 100,
  cost_per_box: 100,
  taxable_amount: 10000,
  gst_amount: 1800,
  itc_eligible: true,
};

test("one supplier stays one supplier despite typing differences", () => {
  const k = supplierKey("Kajaria Ceramics");
  assert.equal(supplierKey("kajaria ceramics"), k);
  assert.equal(supplierKey("  Kajaria   Ceramics "), k);
  assert.notEqual(supplierKey("Kajaria Tiles"), k);
});

test("serial numbers are per financial year", () => {
  assert.equal(debitNoteNumber({ sequence: 1, financialYear: "26-27" }), "DN/26-27/0001");
  assert.equal(debitNoteNumber({ sequence: 137, financialYear: "26-27" }), "DN/26-27/0137");
});

test("a full return reverses the whole purchase and all of its credit", () => {
  const dn = computeDebitNote({ purchase: PURCHASE, returnQuantity: 100 });
  close(dn.taxableValue, 10000, "taxable");
  close(dn.taxReversed, 1800, "the entire credit goes back");
  close(dn.totalDebit, 11800, "what the supplier owes back");
  assert.equal(dn.isFullReturn, true);
});

test("a partial return reverses credit in the same proportion", () => {
  // Quarter of the consignment back → quarter of the credit reversed.
  const dn = computeDebitNote({ purchase: PURCHASE, returnQuantity: 25 });
  close(dn.taxableValue, 2500, "taxable");
  close(dn.taxReversed, 450, "a quarter of 1800");
  assert.equal(dn.isFullReturn, false);
});

test("returning more than was bought reverses only what was bought", () => {
  const dn = computeDebitNote({ purchase: PURCHASE, returnQuantity: 500 });
  close(dn.taxReversed, 1800, "capped at the credit actually taken");
  assert.equal(dn.returnQuantity, 100);
});

test("value uses the price actually paid, not today's price", () => {
  // The tile cost 100 then; it costs 150 now. The supplier owes back what was paid.
  const dn = computeDebitNote({ purchase: PURCHASE, returnQuantity: 10 });
  close(dn.grossReturned, 1000, "10 units at the ₹100 they were bought at");
  close(dn.costPerUnit, 100, "the original price");
});

test("an inter-state purchase reverses IGST, not CGST and SGST", () => {
  const dn = computeDebitNote({
    purchase: { ...PURCHASE, is_inter_state: true }, returnQuantity: 100,
  });
  close(dn.igst, 1800, "reversed under the head it was charged under");
  assert.equal(dn.cgst, 0);
  assert.equal(dn.sgst, 0);
});

test("intra-state halves add back to the tax reversed", () => {
  const dn = computeDebitNote({
    purchase: { ...PURCHASE, gst_amount: 45.01 }, returnQuantity: 100,
  });
  close(dn.cgst + dn.sgst, dn.taxReversed, "no paisa lost in halving");
});

test("goods bought with no credit claimed reverse no credit", () => {
  // An unregistered supplier: no ITC was ever taken, so there is nothing to
  // give back, and reversing anyway would overstate what the shop owes.
  const dn = computeDebitNote({
    purchase: { ...PURCHASE, gst_amount: 0, itc_eligible: false }, returnQuantity: 100,
  });
  assert.equal(dn.itcReversed, false);
  assert.equal(dn.taxReversed, 0);
  close(dn.totalDebit, 10000, "the goods still come off the books");
});

test("a purchase with no GST recorded still produces a valid return", () => {
  const dn = computeDebitNote({
    purchase: { quantity_boxes: 20, cost_per_box: 50 }, returnQuantity: 5,
  });
  close(dn.taxableValue, 250, "falls back to quantity times cost");
  assert.equal(dn.taxReversed, 0);
});

test("returning nothing produces no note at all", () => {
  assert.equal(computeDebitNote({ purchase: PURCHASE, returnQuantity: 0 }), null);
  assert.equal(computeDebitNote({ purchase: PURCHASE, returnQuantity: -5 }), null);
  assert.equal(computeDebitNote({ purchase: { quantity_boxes: 0 }, returnQuantity: 5 }), null);
});
