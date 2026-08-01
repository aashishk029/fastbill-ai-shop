"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { expectedCash, reconcile, summarisePaymentModes } = require("./cashbook");

test("expected cash is opening plus cash in, minus cash out", () => {
  const e = expectedCash({
    openingCash: 2000,
    cashSales: 15000,
    cashCollections: 3000,   // old udhari recovered in cash
    cashExpenses: 1200,      // tea, transport, wages paid from the drawer
    cashPayouts: 5000,       // supplier paid in cash
  });
  assert.equal(e, 13800);
});

test("a UPI sale never enters the drawer", () => {
  // Counting digital sales as cash would manufacture a shortfall every day.
  const withUpi = expectedCash({ openingCash: 1000, cashSales: 5000 });
  assert.equal(withUpi, 6000, "only the cash portion is expected in the box");
});

test("an empty day still balances", () => {
  assert.equal(expectedCash({}), 0);
  assert.equal(expectedCash({ openingCash: 500 }), 500);
});

test("a matching count is reported as tallied", () => {
  const r = reconcile({ counted: 13800, expected: 13800 });
  assert.equal(r.status, "tally");
  assert.equal(r.difference, 0);
});

test("small rounding drift does not cry wolf", () => {
  // A day of rupee-rounded bills can legitimately drift a few rupees.
  const r = reconcile({ counted: 13797, expected: 13800 });
  assert.equal(r.status, "tally");
  assert.equal(r.withinTolerance, true);
  assert.equal(r.difference, -3, "the drift is still reported, just not alarmed on");
});

test("a real shortfall is named plainly", () => {
  const r = reconcile({ counted: 13300, expected: 13800 });
  assert.equal(r.status, "short");
  assert.equal(r.difference, -500);
  assert.equal(r.magnitude, 500);
  assert.equal(r.withinTolerance, false);
});

test("extra cash is flagged too, not quietly accepted", () => {
  // Excess usually means a sale went unbilled, which matters as much as a shortfall.
  const r = reconcile({ counted: 14300, expected: 13800 });
  assert.equal(r.status, "excess");
  assert.equal(r.difference, 500);
});

test("tolerance is configurable and zero tolerance is honoured", () => {
  const strict = reconcile({ counted: 999, expected: 1000, tolerance: 0 });
  assert.equal(strict.status, "short");
});

test("payment modes are split, and bills with no mode are called unknown", () => {
  const s = summarisePaymentModes([
    { payment_mode: "cash", taxable_value: 1000 },
    { payment_mode: "CASH", taxable_value: 500 },        // case does not matter
    { payment_mode: "upi", taxable_value: 2000 },
    { payment_mode: null, taxable_value: 700 },          // written before mode was captured
    { taxable_value: 300 },                              // ditto
  ]);
  assert.equal(s.cash, 1500);
  assert.equal(s.upi, 2000);
  assert.equal(s.unknown, 1000, "never silently counted as cash");
  assert.equal(s.unknownCount, 2);
});

test("GST components are included in the amount settled", () => {
  const s = summarisePaymentModes([
    { payment_mode: "cash", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90 },
  ]);
  assert.equal(s.cash, 1180, "the customer handed over the full bill value, tax included");
});

test("an unrecognised mode is treated as unknown rather than dropped", () => {
  const s = summarisePaymentModes([{ payment_mode: "cheque", taxable_value: 400 }]);
  assert.equal(s.unknown, 400, "the money existed; it must land somewhere");
});
