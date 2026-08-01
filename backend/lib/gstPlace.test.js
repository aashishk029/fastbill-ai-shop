"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { stateCodeFromGstin, stateName, resolveSupply, splitTaxComponents } = require("./gstPlace");

const BIHAR = "10AAPFU0939F1ZV";        // shop's own state in this fixture
const MAHARASHTRA = "27AAPFU0939F1ZV";
const UP = "09AAPFU0939F1ZV";

test("the state is read from the first two digits of a GSTIN", () => {
  assert.equal(stateCodeFromGstin(BIHAR), "10");
  assert.equal(stateName("10"), "Bihar");
  assert.equal(stateCodeFromGstin(MAHARASHTRA), "27");
  assert.equal(stateName("27"), "Maharashtra");
});

test("an unreadable GSTIN yields no state rather than a wrong one", () => {
  assert.equal(stateCodeFromGstin(""), null);
  assert.equal(stateCodeFromGstin(null), null);
  assert.equal(stateCodeFromGstin("XX AAPFU"), null);
  assert.equal(stateCodeFromGstin("00AAPFU0939F1ZV"), null, "00 is not a notified state code");
});

test("same state means CGST and SGST", () => {
  const r = resolveSupply({ sellerGstin: BIHAR, buyerGstin: BIHAR });
  assert.equal(r.interState, false);
  assert.equal(r.taxKind, "cgst_sgst");
});

test("a buyer in another state means IGST", () => {
  // This is the case the app used to get legally wrong on every bill.
  const r = resolveSupply({ sellerGstin: BIHAR, buyerGstin: MAHARASHTRA });
  assert.equal(r.interState, true);
  assert.equal(r.taxKind, "igst");
  assert.equal(r.placeOfSupply, "27");
  assert.equal(r.placeOfSupplyName, "Maharashtra");
});

test("a walk-in customer with no GSTIN is an intra-state counter sale", () => {
  // Place of supply for goods handed over the counter is where they are handed
  // over, which is the shop's own state.
  const r = resolveSupply({ sellerGstin: BIHAR, buyerGstin: null });
  assert.equal(r.interState, false);
  assert.equal(r.placeOfSupply, "10");
});

test("an explicit place of supply overrides the buyer's GSTIN", () => {
  // A shopkeeper delivering to another state knows that better than any
  // inference from a registration number.
  const r = resolveSupply({ sellerGstin: BIHAR, buyerGstin: BIHAR, placeOfSupply: "09" });
  assert.equal(r.interState, true);
  assert.equal(r.placeOfSupplyName, "Uttar Pradesh");
});

test("an unregistered shop keeps its existing behaviour instead of inventing IGST", () => {
  const r = resolveSupply({ sellerGstin: null, buyerGstin: MAHARASHTRA });
  assert.equal(r.interState, false, "with no seller state there is nothing to compare");
  assert.equal(r.taxKind, "cgst_sgst");
});

test("an invalid place-of-supply code is ignored rather than obeyed", () => {
  const r = resolveSupply({ sellerGstin: BIHAR, buyerGstin: UP, placeOfSupply: "88" });
  assert.equal(r.placeOfSupply, "09", "falls back to the buyer's actual state");
});

test("intra-state tax splits into two halves that add back exactly", () => {
  const s = splitTaxComponents(180, false);
  assert.equal(s.cgst, 90);
  assert.equal(s.sgst, 90);
  assert.equal(s.igst, 0);
  assert.equal(s.cgst + s.sgst, 180);
});

test("an odd paisa is not lost when halving", () => {
  // 45.01 cannot be halved evenly; the bill must still reconcile.
  const s = splitTaxComponents(45.01, false);
  assert.equal(Math.round((s.cgst + s.sgst) * 100) / 100, 45.01);
});

test("inter-state tax is the whole amount as IGST", () => {
  const s = splitTaxComponents(180, true);
  assert.equal(s.igst, 180);
  assert.equal(s.cgst, 0);
  assert.equal(s.sgst, 0);
});

test("the total tax is identical either way — only its presentation changes", () => {
  const intra = splitTaxComponents(236.5, false);
  const inter = splitTaxComponents(236.5, true);
  const totalOf = (s) => Math.round((s.cgst + s.sgst + s.igst) * 100) / 100;
  assert.equal(totalOf(intra), 236.5);
  assert.equal(totalOf(inter), 236.5);
});
