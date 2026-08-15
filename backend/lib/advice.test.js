"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { orderQuantity, marginLeaks, affordableRestocks, onlineDemandBySku } = require("./advice");

// --- how much to order ---------------------------------------------------------------------

test("the order quantity is the textbook EOQ, checked against the closed form", () => {
  // Q* = sqrt(2DS/H). D = 2/day x 365 = 730, S = 150, H = 180 x 0.25 = 45.
  // Q* = sqrt(2 x 730 x 150 / 45) = sqrt(4866.67) = 69.76 -> 70.
  const r = orderQuantity({ dailyDemand: 2, unitCost: 180 });
  assert.equal(r.quantity, 70);
  assert.equal(r.estimatedCost, 70 * 180);
});

test("at the optimum, ordering cost and holding cost are equal", () => {
  // This is the property that makes EOQ the minimum rather than any old quantity: the two
  // cost curves cross there. If this drifts, the formula has been wired up wrongly.
  const r = orderQuantity({ dailyDemand: 5, unitCost: 200 });
  assert.ok(Math.abs(r.annualOrderingCost - r.annualHoldingCost) < 1,
    `${r.annualOrderingCost} vs ${r.annualHoldingCost}`);
});

test("doubling demand multiplies the order by root two, not by two", () => {
  // The square root is the whole point of EOQ; a linear answer means someone replaced it
  // with a rule of thumb.
  const a = orderQuantity({ dailyDemand: 2, unitCost: 180 }).eoq;
  const b = orderQuantity({ dailyDemand: 4, unitCost: 180 }).eoq;
  assert.ok(Math.abs(b / a - Math.SQRT2) < 0.02, `${b}/${a}`);
});

test("the order is never smaller than what it takes to clear the reorder point", () => {
  // A trip to the supplier that leaves the shop still below its reorder point is a wasted
  // trip.
  const r = orderQuantity({ dailyDemand: 0.2, unitCost: 900, reorderPoint: 40, onHand: 5 });
  assert.ok(r.quantity >= 35, `got ${r.quantity}`);
});

test("the order is never more than a quarter's demand", () => {
  // Cheap goods give a huge EOQ; a shelf holding two years of stock is cash in cardboard.
  const r = orderQuantity({ dailyDemand: 1, unitCost: 2 });
  assert.ok(r.quantity <= 90, `got ${r.quantity}`);
});

test("no demand or no cost means no advice, not a zero", () => {
  assert.equal(orderQuantity({ dailyDemand: 0, unitCost: 180 }), null);
  assert.equal(orderQuantity({ dailyDemand: 2, unitCost: 0 }), null);
});

// --- what is losing money --------------------------------------------------------------------

test("selling below cost is reported as a loss, with the per-unit bleed", () => {
  const [worst] = marginLeaks([{ sku: "A", price: 90, cost: 100 }]);
  assert.equal(worst.severity, "loss");
  assert.equal(worst.lossPerUnit, 10);
});

test("margin is computed on price, not marked up on cost", () => {
  // p=100, c=80 -> margin 20% on price. Markup on cost would say 25% and quietly flatter
  // every product in the shop.
  const [m] = marginLeaks([{ sku: "A", price: 100, cost: 80 }], { thinMarginPct: 30 });
  assert.equal(m.marginPct, 20);
});

test("a healthy product is not mentioned at all", () => {
  assert.deepEqual(marginLeaks([{ sku: "A", price: 100, cost: 40 }]), []);
});

test("a fast-moving small loss outranks a slow-moving big one", () => {
  const out = marginLeaks([
    { sku: "slow", price: 50, cost: 100, unitsSold: 1 },
    { sku: "fast", price: 98, cost: 100, unitsSold: 500 },
  ]);
  // The deeper percentage loss still leads, but where losses tie the volume decides.
  const tied = marginLeaks([
    { sku: "slow", price: 90, cost: 100, unitsSold: 2 },
    { sku: "fast", price: 90, cost: 100, unitsSold: 400 },
  ]);
  assert.equal(tied[0].sku, "fast");
  assert.equal(out[0].sku, "slow");
});

test("a product with no cost recorded is skipped, not guessed at", () => {
  assert.deepEqual(marginLeaks([{ sku: "A", price: 100, cost: 0 }]), []);
});

// --- what can actually be paid for ------------------------------------------------------------

test("restocks are cut off where the money runs out", () => {
  const r = affordableRestocks([
    { sku: "A", estimatedCost: 3000, daysLeft: 2 },
    { sku: "B", estimatedCost: 4000, daysLeft: 5 },
    { sku: "C", estimatedCost: 9000, daysLeft: 9 },
  ], 8000);
  assert.deepEqual(r.affordable.map((x) => x.sku), ["A", "B"]);
  assert.deepEqual(r.deferred.map((x) => x.sku), ["C"]);
  assert.equal(r.totalCost, 7000);
  assert.equal(r.cashLeft, 1000);
});

test("the most urgent is bought first, not the cheapest", () => {
  const r = affordableRestocks([
    { sku: "cheap", estimatedCost: 100, daysLeft: 30 },
    { sku: "urgent", estimatedCost: 900, daysLeft: 1 },
  ], 1000);
  assert.equal(r.affordable[0].sku, "urgent");
});

test("with no money nothing is affordable, and the shortfall is stated", () => {
  // "You are out of stock and cannot afford it" is the moment to call a supplier about
  // credit, so it has to be said rather than silently omitted.
  const r = affordableRestocks([{ sku: "A", estimatedCost: 5000, daysLeft: 1 }], 0);
  assert.equal(r.affordable.length, 0);
  assert.equal(r.shortBy, 5000);
});

test("when everything fits, nothing is reported as short", () => {
  const r = affordableRestocks([{ sku: "A", estimatedCost: 100, daysLeft: 1 }], 5000);
  assert.equal(r.shortBy, 0);
  assert.equal(r.deferred.length, 0);
});

// --- demand that arrived online ----------------------------------------------------------------

test("online orders are counted into per-day demand", () => {
  const now = new Date().toISOString();
  const d = onlineDemandBySku([
    { status: "paid", created_at: now, items: [{ sku: "milan", quantityBoxes: 3 }] },
    { status: "shipped", created_at: now, items: [{ sku: "milan", quantityBoxes: 3 }] },
  ], { days: 30 });
  assert.equal(d.milan.units, 6);
  assert.equal(d.milan.perDay, 0.2);
});

test("a cancelled order is not demand — nothing left the shelf", () => {
  const now = new Date().toISOString();
  const d = onlineDemandBySku([
    { status: "cancelled", created_at: now, items: [{ sku: "milan", quantityBoxes: 5 }] },
  ], { days: 30 });
  assert.deepEqual(d, {});
});

test("orders older than the window are excluded", () => {
  const old = new Date(Date.now() - 90 * 86400000).toISOString();
  const d = onlineDemandBySku([
    { status: "paid", created_at: old, items: [{ sku: "milan", quantityBoxes: 5 }] },
  ], { days: 30 });
  assert.deepEqual(d, {});
});

// --- what the shop owes before it sells anything -----------------------------------------

const { monthlyFixedCosts, shopBreakEven, perishableQuantity } = require("./advice");

test("only costs owed regardless of sales count as fixed", () => {
  // Rent, utilities and salary are owed whether or not a cup is sold. Transport and
  // marketing scale with activity, and "other" is left out rather than guessed either way.
  const f = monthlyFixedCosts([
    { category: "rent", amount: 24000 }, { category: "salary", amount: 36000 },
    { category: "marketing", amount: 9000 }, { category: "transport", amount: 3000 },
    { category: "other", amount: 5000 },
  ], { days: 90 });
  assert.equal(f.perMonth, 20000);
  assert.equal(f.sampleCount, 2);
});

test("nothing classified means no answer, not zero fixed costs", () => {
  // Reporting zero would say "you break even immediately", which is a confident lie.
  assert.equal(monthlyFixedCosts([{ category: "other", amount: 5000 }], { days: 90 }), null);
  assert.equal(monthlyFixedCosts([], { days: 90 }), null);
});

test("break-even revenue is fixed costs over contribution margin", () => {
  // 30% margin on 20,000 of fixed cost needs 66,667 of sales a month.
  const b = shopBreakEven({ revenue: 300000, cogs: 210000, fixedPerMonth: 20000, windowDays: 90 });
  assert.equal(b.contributionMarginPct, 30);
  assert.equal(b.breakEvenRevenuePerMonth, 66666.67);
  assert.equal(b.actualRevenuePerMonth, 100000);
  assert.equal(b.coveringCosts, true);
});

test("a shop below its break-even is told so", () => {
  const b = shopBreakEven({ revenue: 60000, cogs: 48000, fixedPerMonth: 20000, windowDays: 90 });
  assert.equal(b.coveringCosts, false);
});

test("selling below cost overall makes break-even meaningless, so it is not reported", () => {
  assert.equal(shopBreakEven({ revenue: 100000, cogs: 120000, fixedPerMonth: 20000 }), null);
});

// --- perishables, where leftovers are a write-off -----------------------------------------

test("a perishable is stocked at the newsvendor quantity, not the reorder point", () => {
  // Too few costs the margin (249); too many costs the whole unit (200). Not symmetric,
  // so the answer is not simply the mean.
  const p = perishableQuantity({ unitCost: 200, sellingPrice: 449, meanDemand: 30, sdDemand: 12 });
  assert.equal(p.costOfOneTooFew, 249);
  assert.equal(p.costOfOneTooMany, 200);
  assert.ok(p.quantity > 30, "margin exceeds cost, so stock above the mean");
  assert.ok(p.quantity < 40);
});

test("when a leftover costs more than a lost sale, stock below the mean", () => {
  const p = perishableQuantity({ unitCost: 400, sellingPrice: 449, meanDemand: 30, sdDemand: 12 });
  assert.ok(p.quantity < 30, `got ${p.quantity}`);
});

test("a product sold at or below cost yields no perishable answer", () => {
  assert.equal(perishableQuantity({ unitCost: 449, sellingPrice: 449, meanDemand: 30, sdDemand: 5 }), null);
});
