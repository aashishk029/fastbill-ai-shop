"use strict";

/**
 * These test the textbook results against values that can be looked up
 * independently — published z tables, worked EOQ examples, the newsvendor
 * critical ratio. If one fails, either the code is wrong or a shopkeeper is
 * about to be told to buy the wrong amount of stock.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mean, stdDev, normalQuantile,
  safetyStock, reorderPoint, stockRunway, economicOrderQuantity,
  abcClassification, inventoryTurnover, daysSalesOutstanding,
  newsvendorQuantity, breakEven, confidenceFrom,
} = require("./opsResearch");

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ~${b}`);

// ── Statistics ─────────────────────────────────────────────────────────────
test("standard deviation uses the sample formula and needs two points", () => {
  close(mean([2, 4, 6]), 4, 1e-9, "mean");
  close(stdDev([2, 4, 4, 4, 5, 5, 7, 9]), 2.13809, 1e-4, "sample sd");
  assert.equal(stdDev([5]), 0, "a single observation has no measurable spread");
  assert.equal(stdDev([]), 0);
});

test("service-level z values match published normal tables", () => {
  close(normalQuantile(0.50), 0, 1e-6, "z(50%)");
  close(normalQuantile(0.90), 1.28155, 1e-4, "z(90%)");
  close(normalQuantile(0.95), 1.64485, 1e-4, "z(95%)");
  close(normalQuantile(0.975), 1.95996, 1e-4, "z(97.5%)");
  close(normalQuantile(0.99), 2.32635, 1e-4, "z(99%)");
  assert.ok(Number.isNaN(normalQuantile(0)), "a probability of 0 or 1 has no finite z");
  assert.ok(Number.isNaN(normalQuantile(1)));
});

// ── Safety stock and reorder point ─────────────────────────────────────────
test("safety stock covers demand variability over the lead time", () => {
  // 10/day, sd 2, lead time 9 days, 95% service:
  // SS = 1.645 × sqrt(9 × 4) = 1.645 × 6 = 9.87
  const ss = safetyStock({ avgDailyDemand: 10, sdDailyDemand: 2, avgLeadTimeDays: 9, serviceLevel: 0.95 });
  close(ss, 9.87, 0.05, "safety stock");
});

test("a supplier with an unreliable lead time needs far more cushion", () => {
  // The case Indian small retail actually lives in: usually 6 days, sometimes 12.
  const steady = safetyStock({ avgDailyDemand: 10, sdDailyDemand: 2, avgLeadTimeDays: 6, sdLeadTimeDays: 0 });
  const erratic = safetyStock({ avgDailyDemand: 10, sdDailyDemand: 2, avgLeadTimeDays: 6, sdLeadTimeDays: 3 });
  assert.ok(erratic > steady * 3, `erratic supplier should dominate the cushion: ${erratic} vs ${steady}`);
  // SS = 1.645 × sqrt(6×4 + 100×9) = 1.645 × sqrt(924) ≈ 50.0
  close(erratic, 50.0, 0.5, "with lead-time variability");
});

test("a higher service level demands more stock", () => {
  const s90 = safetyStock({ avgDailyDemand: 10, sdDailyDemand: 3, avgLeadTimeDays: 4, serviceLevel: 0.90 });
  const s99 = safetyStock({ avgDailyDemand: 10, sdDailyDemand: 3, avgLeadTimeDays: 4, serviceLevel: 0.99 });
  assert.ok(s99 > s90, "99% availability costs more inventory than 90%");
});

test("the reorder point is lead-time demand plus the cushion", () => {
  const r = reorderPoint({ avgDailyDemand: 10, sdDailyDemand: 2, avgLeadTimeDays: 9, serviceLevel: 0.95 });
  close(r.leadTimeDemand, 90, 1e-6, "demand during lead time");
  close(r.reorderPoint, 99.87, 0.05, "reorder point");
});

test("perfectly steady demand still gives a reorder point, just no cushion", () => {
  const r = reorderPoint({ avgDailyDemand: 5, sdDailyDemand: 0, avgLeadTimeDays: 4 });
  assert.equal(r.safetyStock, 0);
  close(r.reorderPoint, 20, 1e-6, "just the lead-time demand");
});

// ── Runway ─────────────────────────────────────────────────────────────────
test("runway becomes urgent once stock will not outlast the lead time", () => {
  assert.equal(stockRunway({ onHand: 100, avgDailyDemand: 10, avgLeadTimeDays: 6 }).daysLeft, 10);
  assert.equal(stockRunway({ onHand: 100, avgDailyDemand: 10, avgLeadTimeDays: 6 }).urgent, false);
  assert.equal(stockRunway({ onHand: 40, avgDailyDemand: 10, avgLeadTimeDays: 6 }).urgent, true);
});

test("an item that never sells has no runway rather than an infinite one", () => {
  const r = stockRunway({ onHand: 50, avgDailyDemand: 0, avgLeadTimeDays: 5 });
  assert.equal(r.daysLeft, null, "null, not Infinity — the app must not print a number here");
  assert.equal(r.urgent, false);
});

// ── EOQ ────────────────────────────────────────────────────────────────────
test("EOQ matches the classic worked example", () => {
  // D = 1000, S = 100, H = 5 → sqrt(2×1000×100/5) = sqrt(40000) = 200
  const e = economicOrderQuantity({ annualDemand: 1000, orderCost: 100, holdingCostPerUnitPerYear: 5 });
  close(e.eoq, 200, 1e-6, "EOQ");
  close(e.ordersPerYear, 5, 1e-6, "orders per year");
});

test("at the EOQ, ordering cost and holding cost are equal", () => {
  // The defining property of the optimum — a good check that the algebra is right.
  const e = economicOrderQuantity({ annualDemand: 2400, orderCost: 250, holdingCostPerUnitPerYear: 12 });
  close(e.annualOrderingCost, e.annualHoldingCost, 0.5, "the two costs balance at the optimum");
});

test("EOQ is undefined without real inputs rather than returning zero", () => {
  assert.equal(economicOrderQuantity({ annualDemand: 0, orderCost: 100, holdingCostPerUnitPerYear: 5 }), null);
  assert.equal(economicOrderQuantity({ annualDemand: 100, orderCost: 100, holdingCostPerUnitPerYear: 0 }), null);
});

// ── ABC ────────────────────────────────────────────────────────────────────
test("ABC puts the vital few in class A", () => {
  const classified = abcClassification([
    { id: "x", annualValue: 70000 },
    { id: "y", annualValue: 20000 },
    { id: "z", annualValue: 8000 },
    { id: "w", annualValue: 2000 },
  ]);
  assert.equal(classified[0].id, "x");
  assert.equal(classified[0].class, "A", "70% of value in one item");
  assert.equal(classified[1].class, "A", "the item crossing the 80% line completes class A");
  assert.equal(classified[3].class, "C", "the trivial many");
  close(classified[0].shareOfValue, 70, 0.01, "share of value");
});


test("one dominant item does not leave class A empty", () => {
  // A small shop where a single line is most of the value. Classifying on the
  // cumulative AFTER adding would put it in C and leave the vital few empty.
  const classified = abcClassification([
    { id: "big", annualValue: 90000 },
    { id: "small", annualValue: 10000 },
  ]);
  assert.equal(classified[0].class, "A");
  assert.ok(classified.some(c => c.class === "A"), "there is always a vital few");
});

test("items with no value are left out rather than classified", () => {
  const classified = abcClassification([{ id: "a", annualValue: 100 }, { id: "b", annualValue: 0 }]);
  assert.equal(classified.length, 1);
  assert.deepEqual(abcClassification([]), []);
});

// ── Turnover, DSO ──────────────────────────────────────────────────────────
test("turnover and days of inventory are consistent with each other", () => {
  const t = inventoryTurnover({ costOfGoodsSold: 1200000, averageInventoryValue: 200000 });
  close(t.turnover, 6, 1e-6, "six turns a year");
  assert.equal(t.daysOfInventory, 61, "365 / 6");
});

test("turnover is undefined with no stock or no sales", () => {
  assert.equal(inventoryTurnover({ costOfGoodsSold: 100, averageInventoryValue: 0 }), null);
  assert.equal(inventoryTurnover({ costOfGoodsSold: 0, averageInventoryValue: 100 }), null);
});

test("DSO measures how long the shop's money sits with customers", () => {
  // 50,000 owed against 500,000 of credit sales in a year.
  assert.equal(daysSalesOutstanding({ receivables: 50000, creditSales: 500000 }), 37);
  assert.equal(daysSalesOutstanding({ receivables: 5000, creditSales: 0 }), null, "no credit sales, no ratio");
});

// ── Newsvendor ─────────────────────────────────────────────────────────────
test("the critical ratio is underage over total mismatch cost", () => {
  // Buy at 30, sell at 50, unsold worth 10.
  // Cu = 20, Co = 20 → CR = 0.5 → order the mean.
  const n = newsvendorQuantity({ unitCost: 30, sellingPrice: 50, salvageValue: 10, meanDemand: 100, sdDemand: 20 });
  close(n.criticalRatio, 0.5, 1e-9, "critical ratio");
  close(n.optimalQuantity, 100, 0.01, "at CR 0.5 the optimum is the mean demand");
});

test("a high-margin item worth little when unsold is worth over-stocking", () => {
  // Cu = 80, Co = 20 → CR = 0.8 → order above the mean.
  const n = newsvendorQuantity({ unitCost: 20, sellingPrice: 100, salvageValue: 0, meanDemand: 100, sdDemand: 25 });
  close(n.criticalRatio, 0.8, 1e-9, "critical ratio");
  assert.ok(n.optimalQuantity > 100, "stock more than average when running out is expensive");
  close(n.optimalQuantity, 100 + 0.8416 * 25, 0.1, "mean + z(0.8)·sd");
});

test("a thin-margin perishable is worth under-stocking", () => {
  // Cu = 5, Co = 45 → CR = 0.1 → order well below the mean.
  const n = newsvendorQuantity({ unitCost: 50, sellingPrice: 55, salvageValue: 5, meanDemand: 100, sdDemand: 20 });
  assert.ok(n.optimalQuantity < 100, "throwing it out hurts more than missing a sale");
});

test("an item sold at or below cost has no newsvendor answer", () => {
  assert.equal(newsvendorQuantity({ unitCost: 50, sellingPrice: 50, meanDemand: 10, sdDemand: 2 }), null);
  assert.equal(newsvendorQuantity({ unitCost: 50, sellingPrice: 40, meanDemand: 10, sdDemand: 2 }), null);
});

// ── Break-even ─────────────────────────────────────────────────────────────
test("break-even is fixed costs divided by contribution", () => {
  const b = breakEven({ pricePerUnit: 100, variableCostPerUnit: 60, fixedCosts: 20000 });
  close(b.contributionPerUnit, 40, 1e-9, "contribution");
  assert.equal(b.breakEvenUnits, 500);
  close(b.contributionMarginPercent, 40, 1e-9, "margin %");
});

test("selling below variable cost never breaks even, however much is sold", () => {
  assert.equal(breakEven({ pricePerUnit: 50, variableCostPerUnit: 60, fixedCosts: 1000 }), null);
});

// ── Confidence gate ────────────────────────────────────────────────────────
test("thin history is reported as insufficient rather than dressed up", () => {
  // The whole point: a shop two weeks in must not be given a confident number.
  assert.equal(confidenceFrom({ observations: 3, daysOfHistory: 10 }).usable, false);
  assert.equal(confidenceFrom({ observations: 100, daysOfHistory: 5 }).usable, false, "a busy week is still one week");
  assert.equal(confidenceFrom({ observations: 5, daysOfHistory: 20 }).level, "low");
  assert.equal(confidenceFrom({ observations: 15, daysOfHistory: 30 }).level, "medium");
  assert.equal(confidenceFrom({ observations: 40, daysOfHistory: 90 }).level, "high");
});
