"use strict";

/**
 * Tests for FastBill's money math. Run with `npm test` (uses node:test — no
 * dependency to install).
 *
 * These are not coverage theatre. Every case below is either a rule a
 * shopkeeper's bill depends on, or an actual bug this codebase has already
 * shipped once. If one of these fails, a real bill is wrong.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isValidGstin, splitGst, computeInvoice, computeJewelleryInvoice,
  computePurchaseGst, pricingCostPerUnit, suggestedPrice,
  summariseItc, purchaseCostForPnl,
} = require("./money");

const GSTIN = "27AAPFU0939F1ZV";
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.02, `${msg}: got ${a}, want ${b}`);

// ── GSTIN validation ───────────────────────────────────────────────────────
test("GSTIN validation accepts a well-formed number and rejects malformed ones", () => {
  assert.equal(isValidGstin(GSTIN), true);
  assert.equal(isValidGstin(GSTIN.toLowerCase()), true, "case is normalised");
  assert.equal(isValidGstin("27AAPFU0939F1Z"), false, "14 chars");
  assert.equal(isValidGstin("ABAAPFU0939F1ZV"), false, "state code must be digits");
  assert.equal(isValidGstin(""), false);
  assert.equal(isValidGstin(null), false);
});

// ── GST split ──────────────────────────────────────────────────────────────
test("GST included mode reverse-extracts tax from a gross amount", () => {
  const { taxable, gst } = splitGst(1180, 18, "included");
  close(taxable, 1000, "taxable");
  close(gst, 180, "gst");
});

test("GST exclusive mode adds tax on top", () => {
  const { taxable, gst } = splitGst(1000, 18, "exclusive");
  close(taxable, 1000, "taxable");
  close(gst, 180, "gst");
});

test("a zero rate produces no tax in either mode", () => {
  assert.equal(splitGst(500, 0, "included").gst, 0);
  assert.equal(splitGst(500, 0, "exclusive").gst, 0);
});

// ── Invoice: the discount-before-GST rule ──────────────────────────────────
test("discount is applied before GST, not after", () => {
  // 1000 gross, 100 off, 18% included → tax is computed on 900, not 1000.
  const r = computeInvoice({
    items: [{ quantity: 10, rate: 100, gstRate: 18 }],
    discount: 100, isGstInvoice: true, gstMode: "included",
  });
  close(r.afterDiscount, 900, "after discount");
  close(r.taxableValue, 900 / 1.18, "taxable");
  close(r.gstAmount, 900 - 900 / 1.18, "gst");
  close(r.total, 900, "total stays the discounted gross in included mode");
});

test("a bill-level discount is split across lines in proportion to their value", () => {
  const r = computeInvoice({
    items: [
      { quantity: 1, rate: 300, gstRate: 18 },  // 75% of value
      { quantity: 1, rate: 100, gstRate: 18 },  // 25% of value
    ],
    discount: 40, isGstInvoice: true,
  });
  close(r.lines[0].lineDiscount, 30, "big line takes 75% of the discount");
  close(r.lines[1].lineDiscount, 10, "small line takes 25%");
  close(r.lines[0].lineDiscount + r.lines[1].lineDiscount, 40, "allocation is exact");
});

test("the bill reconciles: subtotal - discount = sum of line totals", () => {
  const r = computeInvoice({
    items: [
      { quantity: 3, rate: 249.5, gstRate: 12 },
      { quantity: 2, rate: 80, gstRate: 5 },
      { quantity: 1.5, rate: 400, gstRate: 18 },
    ],
    discount: 137, isGstInvoice: true,
  });
  const lineSum = r.lines.reduce((s, l) => s + l.lineTotal, 0);
  close(lineSum, r.subtotal - r.discount, "lines reconcile to subtotal minus discount");
  close(r.taxableValue + r.gstAmount, r.afterDiscount, "taxable + gst = discounted gross");
});

test("each line keeps its own GST rate, so a bill can mix rates", () => {
  const r = computeInvoice({
    items: [
      { quantity: 1, rate: 1000, gstRate: 5 },
      { quantity: 1, rate: 1000, gstRate: 18 },
    ],
    isGstInvoice: true, gstMode: "exclusive",
  });
  close(r.lines[0].gst, 50, "5% line");
  close(r.lines[1].gst, 180, "18% line");
  close(r.gstAmount, 230, "total gst is the sum of per-line tax");
});

test("CGST and SGST are an equal half of the tax", () => {
  const r = computeInvoice({ items: [{ quantity: 1, rate: 1180, gstRate: 18 }], isGstInvoice: true });
  close(r.cgst, r.sgst, "halves are equal");
  close(r.cgst + r.sgst, r.gstAmount, "halves reconstitute the whole");
});

test("a non-GST bill carries no tax at all", () => {
  const r = computeInvoice({ items: [{ quantity: 2, rate: 500, gstRate: 18 }], isGstInvoice: false });
  assert.equal(r.gstAmount, 0);
  close(r.taxableValue, 1000, "whole amount is plain revenue");
});

test("decimal quantities survive — shops sell sqft, grams, litres, not just boxes", () => {
  const r = computeInvoice({ items: [{ quantity: 2.5, rate: 120, gstRate: 18 }], isGstInvoice: true });
  close(r.subtotal, 300, "2.5 x 120 is not truncated to 2 x 120");
});

test("a discount larger than the bill cannot make a line negative", () => {
  const r = computeInvoice({ items: [{ quantity: 1, rate: 100, gstRate: 18 }], discount: 500, isGstInvoice: true });
  assert.ok(r.lines[0].lineTotal >= 0, "line total floors at zero");
  assert.ok(r.total >= 0, "total floors at zero");
});

test("an empty or zero-value bill does not divide by zero", () => {
  const empty = computeInvoice({ items: [], discount: 50, isGstInvoice: true });
  assert.equal(empty.total, 0);
  const zero = computeInvoice({ items: [{ quantity: 0, rate: 0, gstRate: 18 }], discount: 50, isGstInvoice: true });
  assert.ok(Number.isFinite(zero.total), "no NaN leaks into a total");
});

// ── Jewellery ──────────────────────────────────────────────────────────────
test("jewellery bills metal plus making charges at the statutory 3%", () => {
  const r = computeJewelleryInvoice({
    items: [{ weightGrams: 10, metalRate: 7000, makingChargesPerGram: 500 }],
  });
  close(r.lines[0].metalValue, 70000, "metal");
  close(r.lines[0].makingValue, 5000, "making");
  close(r.taxableValue, 75000, "taxable includes making charges");
  close(r.gstAmount, 2250, "3% of 75000");
  assert.equal(r.gstRate, 3);
});

// ── Purchase GST and ITC eligibility ───────────────────────────────────────
test("input credit needs shop registered, supplier registered, and a rate", () => {
  const base = { grossValue: 1180, gstRate: 18, gstMode: "included" };
  assert.equal(computePurchaseGst({ ...base, supplierGstin: GSTIN, shopGstin: GSTIN }).itcEligible, true);
  assert.equal(computePurchaseGst({ ...base, supplierGstin: null, shopGstin: GSTIN }).itcEligible, false, "no supplier GSTIN");
  assert.equal(computePurchaseGst({ ...base, supplierGstin: GSTIN, shopGstin: null }).itcEligible, false, "shop not registered");
  assert.equal(computePurchaseGst({ ...base, supplierGstin: "NOTAGSTIN", shopGstin: GSTIN }).itcEligible, false, "malformed GSTIN");
  assert.equal(
    computePurchaseGst({ grossValue: 500, gstRate: null, gstMode: "none", supplierGstin: GSTIN, shopGstin: GSTIN }).itcEligible,
    false, "no rate entered",
  );
});

test("purchase GST splits the same way as sales GST", () => {
  const inc = computePurchaseGst({ grossValue: 1180, gstRate: 18, gstMode: "included", supplierGstin: GSTIN, shopGstin: GSTIN });
  close(inc.taxableAmount, 1000, "included taxable");
  close(inc.gstAmount, 180, "included gst");
  const exc = computePurchaseGst({ grossValue: 1000, gstRate: 18, gstMode: "exclusive", supplierGstin: GSTIN, shopGstin: GSTIN });
  close(exc.gstAmount, 180, "exclusive gst");
});

// ── Pricing basis ──────────────────────────────────────────────────────────
test("reclaimable GST is excluded from the pricing basis, so items are not overpriced", () => {
  const gst = computePurchaseGst({ grossValue: 1180, gstRate: 18, gstMode: "included", supplierGstin: GSTIN, shopGstin: GSTIN });
  const cost = pricingCostPerUnit({ quantity: 10, costPerUnit: 118, purchaseGst: gst });
  close(cost, 100, "prices off the 1000 net, not the 1180 paid");
});

test("without input credit the full amount paid is the cost", () => {
  const gst = computePurchaseGst({ grossValue: 1180, gstRate: 18, gstMode: "included", supplierGstin: null, shopGstin: null });
  const cost = pricingCostPerUnit({ quantity: 10, costPerUnit: 118, purchaseGst: gst });
  close(cost, 118, "unregistered shop cannot reclaim, so gross is the cost");
});

test("transport cost is spread across the units bought", () => {
  close(pricingCostPerUnit({ quantity: 10, costPerUnit: 100, extraCost: 250 }), 125, "25 per unit");
  close(pricingCostPerUnit({ quantity: 0, costPerUnit: 100, extraCost: 250 }), 100, "no divide-by-zero at zero quantity");
});

test("margin can be a percentage or a flat amount", () => {
  close(suggestedPrice({ effectiveCost: 100, marginPercent: 20 }), 120, "percent");
  close(suggestedPrice({ effectiveCost: 100, marginAmount: 35 }), 135, "flat");
  assert.equal(suggestedPrice({ effectiveCost: 100 }), null, "no margin given means no suggestion");
});

// ── ITC aggregation and the P&L ────────────────────────────────────────────
test("blocked credit is reported separately from claimable credit", () => {
  const s = summariseItc([
    { gst_amount: 180, itc_eligible: true },
    { gst_amount: 90, itc_eligible: false },   // supplier GSTIN never collected
    { gst_amount: null, itc_eligible: false }, // no GST recorded at all
  ]);
  close(s.gstPaidOnPurchases, 270, "total paid");
  close(s.itcAvailable, 180, "claimable");
  close(s.itcBlocked, 90, "paid but lost");
  assert.equal(s.purchasesWithoutGst, 1);
});

test("tax is not both credited and expensed", () => {
  // 1180 paid with 180 reclaimed: the expense is 1000, not 1180.
  const claimed = purchaseCostForPnl([
    { quantity_boxes: 10, cost_per_box: 118, gst_amount: 180, taxable_amount: 1000, itc_eligible: true },
  ]);
  close(claimed, 1000, "ITC-claimed purchase is expensed net of tax");

  // Nothing reclaimed: the tax really was a cost.
  const notClaimed = purchaseCostForPnl([
    { quantity_boxes: 10, cost_per_box: 118, gst_amount: 180, taxable_amount: 1000, itc_eligible: false },
  ]);
  close(notClaimed, 1180, "unclaimed purchase is expensed gross");
});

test("purchases recorded before GST capture existed still count as cost", () => {
  const legacy = purchaseCostForPnl([{ quantity_boxes: 5, cost_per_box: 200 }]);
  close(legacy, 1000, "no GST columns must not mean zero cost of goods");
});
