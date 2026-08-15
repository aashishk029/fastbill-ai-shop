"use strict";

/**
 * Turning operations-research numbers into advice a shopkeeper can act on.
 *
 * opsResearch.js holds the formulas. This holds the policy: which of those numbers is worth
 * saying out loud, in what order, and when to stay quiet. They are kept apart because the
 * formulas are settled results that do not change, while the policy is a judgement about
 * this business that will.
 *
 * Three rules run through everything here.
 *
 * Say the quantity, not just the direction. "Restock soon" makes the shopkeeper do the
 * arithmetic that the app already has the data for. economicOrderQuantity was written
 * months ago and never called; ordering little and often burns the ordering cost, ordering
 * big burns the cash and the shelf.
 *
 * Advice that cannot be paid for is not advice. Telling a shop to buy forty thousand rupees
 * of stock when there are eight thousand in the drawer is worse than saying nothing: it is
 * confidently useless, and it teaches the shopkeeper to stop reading. Restock advice is
 * therefore ranked against money actually available and cut off where it runs out.
 *
 * Silence beats a guess. Every function reports the confidence it was computed at, and the
 * caller is expected to drop anything weak rather than dress it up. A kirana shop three
 * weeks into using an app has no demand history worth the name.
 */

/*
 * The mathematics, and where each result comes from. Every source is free and public.
 *
 *  Economic order quantity (Harris 1913; Wilson):
 *      Q* = sqrt( 2 D S / H )
 *    D annual demand, S cost of placing one order, H cost of holding one unit for a year.
 *    Minimises the sum of ordering and holding cost, which is convex in Q, so the turning
 *    point is the optimum rather than merely a stationary point.
 *    MIT OCW ESD.273J Logistics and Supply Chain Management — Inventory and EOQ Models.
 *
 *  Reorder point with variable demand and variable lead time:
 *      ROP = mu_L mu_D + z sqrt( mu_L sigma_D^2 + mu_D^2 sigma_L^2 )
 *    The second term is safety stock: z standard deviations of demand over an uncertain
 *    lead time, where z is the normal quantile of the service level. Implemented in
 *    opsResearch.js; used here to decide the minimum worth ordering.
 *
 *  Gross margin, and why it is computed on price rather than cost:
 *      m = (p - c) / p
 *    Margin on price is what compounds into the P&L; markup on cost, (p-c)/c, flatters the
 *    same trade. Standard managerial accounting (Harvard Business School note on
 *    contribution margin; any cost-accounting text agrees).
 *
 *  Budget-constrained selection:
 *      maximise coverage subject to  sum(cost_i) <= cash
 *    This is a knapsack, which is NP-hard in general. Solving it exactly would be false
 *    precision here: the costs are estimates and the shopkeeper reorders weekly. A greedy
 *    pass ordered by urgency is used instead, which is what a person does anyway — buy
 *    what runs out first — and is optimal when items are taken in urgency order.
 *
 *  Confidence:
 *    Thresholds on sample size and history length, from opsResearch.confidenceFrom. A
 *    standard deviation from four observations is arithmetic, not evidence.
 */

const ops = require("./opsResearch");

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const round0 = (n) => Math.round(Number(n) || 0);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * How much to order, not just whether to.
 *
 * EOQ balances the cost of placing an order against the cost of holding what it brings.
 * The classic model wants an ordering cost and a holding cost, neither of which a kirana
 * shop tracks, so both are estimated from what the shop does record and the answer is
 * clamped to something a person would actually buy: never less than what is needed to
 * clear the reorder point, never more than a quarter's demand sitting on a shelf.
 */
function orderQuantity({ dailyDemand, unitCost, orderingCost = 150, holdingRatePerYear = 0.25, reorderPoint = 0, onHand = 0 }) {
  const d = num(dailyDemand), c = num(unitCost);
  if (d <= 0 || c <= 0) return null;

  const annualDemand = d * 365;
  const holdingPerUnitPerYear = c * holdingRatePerYear;
  const result = ops.economicOrderQuantity({
    annualDemand,
    orderCost: num(orderingCost),
    holdingCostPerUnitPerYear: holdingPerUnitPerYear,
  });
  if (!result || !isFinite(result.eoq) || result.eoq <= 0) return null;
  const eoq = result.eoq;

  // Two bounds that pull in opposite directions, and the order they are applied in matters.
  //
  // The cap keeps cheap goods from producing a shelf holding two years of stock — a large
  // EOQ is cash turned into cardboard. The floor is what it takes to get back above the
  // reorder point, because a trip to the supplier that leaves the shop still below it is a
  // wasted trip.
  //
  // So the cap is applied to the EOQ only, and the floor is applied last. Clamping the
  // other way round let the cap cut into the floor and produce the one genuinely useless
  // answer: "order this much, and still be short".
  const shortfall = Math.max(0, num(reorderPoint) - num(onHand));
  const quarterOfDemand = Math.max(round0(d * 90), 1);
  const qty = Math.max(Math.min(round0(eoq), quarterOfDemand), round0(shortfall), 1);

  return {
    quantity: qty,
    eoq: round0(eoq),
    estimatedCost: round2(qty * c),
    daysOfCover: d > 0 ? round0(qty / d) : null,
    ordersPerYear: result.ordersPerYear,
    // What the EOQ is trading off, so the number can be argued with rather than obeyed.
    annualOrderingCost: result.annualOrderingCost,
    annualHoldingCost: result.annualHoldingCost,
  };
}

/**
 * Products that are not making money.
 *
 * Sold below cost is a leak that hides inside a healthy-looking revenue line — the shop is
 * busy and still going backwards. Thin margin is reported separately because it may be
 * deliberate (a loss leader), so it is surfaced as information rather than an alarm.
 */
function marginLeaks(items, { thinMarginPct = 10 } = {}) {
  const out = [];
  for (const it of items || []) {
    const price = num(it.price), cost = num(it.cost);
    if (price <= 0 || cost <= 0) continue;          // nothing to compare
    const marginPct = ((price - cost) / price) * 100;
    if (marginPct < 0) {
      out.push({ ...it, marginPct: round2(marginPct), severity: "loss",
        lossPerUnit: round2(cost - price) });
    } else if (marginPct < thinMarginPct) {
      out.push({ ...it, marginPct: round2(marginPct), severity: "thin" });
    }
  }
  // Worst first, and within that the ones that sell most — a two-rupee loss on a fast
  // mover costs more than a fifty-rupee loss on something that shifts twice a year.
  return out.sort((a, b) =>
    (a.marginPct - b.marginPct) || (num(b.unitsSold) - num(a.unitsSold)));
}

/**
 * Fit the restock list to the money that exists.
 *
 * Returns the ones that can be paid for, in the order they should be bought, plus the ones
 * that cannot — because "you are out of stock on this and cannot afford it" is itself worth
 * knowing, and is the moment to talk to a supplier about credit rather than to discover it
 * at the counter.
 */
function affordableRestocks(restocks, cashAvailable) {
  const cash = num(cashAvailable);
  // Urgency first: what runs out soonest. Ties break toward the cheaper item, so a limited
  // budget clears more shelves.
  const ranked = [...(restocks || [])].sort((a, b) =>
    (num(a.daysLeft ?? 9999) - num(b.daysLeft ?? 9999)) || (num(a.estimatedCost) - num(b.estimatedCost)));

  const afford = [], defer = [];
  let spent = 0;
  for (const r of ranked) {
    const c = num(r.estimatedCost);
    if (c > 0 && spent + c <= cash) { afford.push(r); spent += c; }
    else defer.push(r);
  }
  return {
    affordable: afford,
    deferred: defer,
    totalCost: round2(spent),
    cashAvailable: round2(cash),
    cashLeft: round2(Math.max(0, cash - spent)),
    // Only meaningful when something was actually deferred for want of money.
    shortBy: defer.length ? round2(defer.reduce((s, r) => s + num(r.estimatedCost), 0)) : 0,
  };
}

/**
 * Demand seen online, per SKU, as a daily rate.
 *
 * An online order draws down the same shelf as a counter sale, so leaving it out of the
 * restock maths understates demand on exactly the products that are growing. Cancelled
 * orders are excluded: nothing left the shelf.
 */
function onlineDemandBySku(orders, { days = 30 } = {}) {
  const window = Math.max(1, num(days));
  const cutoff = Date.now() - window * 86400000;
  const totals = {};
  for (const o of orders || []) {
    if (!o || o.status === "cancelled") continue;
    if (o.created_at && new Date(o.created_at).getTime() < cutoff) continue;
    for (const it of Array.isArray(o.items) ? o.items : []) {
      const sku = String(it.sku || it.name || "").trim();
      if (!sku) continue;
      totals[sku] = (totals[sku] || 0) + num(it.quantityBoxes ?? it.qty ?? 1);
    }
  }
  const out = {};
  for (const [sku, units] of Object.entries(totals)) {
    out[sku] = { units, perDay: round2(units / window) };
  }
  return out;
}

/**
 * Monthly fixed costs, separated from the ones that move with sales.
 *
 * Break-even needs to know what the shop owes before it sells anything. The expense
 * categories already record this: rent, utilities and salary are owed whether or not a
 * single cup is sold, while transport and marketing scale with activity. "other" is left
 * out rather than guessed at in either direction.
 *
 * This is a classification, not a measurement, and it is stated as an assumption wherever
 * the result is shown — a shopkeeper who pays commission-based salary would be misread by
 * it, and should be able to see why the number came out as it did.
 */
const FIXED_CATEGORIES = new Set(["rent", "utility", "salary"]);

function monthlyFixedCosts(expenses, { days = 90 } = {}) {
  const months = Math.max(1, num(days) / 30);
  let fixed = 0, counted = 0;
  for (const e of expenses || []) {
    if (!FIXED_CATEGORIES.has(String(e.category || "").toLowerCase())) continue;
    fixed += num(e.amount); counted++;
  }
  if (!counted) return null;      // nothing classified — say nothing rather than imply zero
  return { perMonth: round2(fixed / months), sampleCount: counted, windowDays: num(days) };
}

/**
 * How much a shop must sell each month before it starts earning.
 *
 * Contribution per rupee of sales is taken from the shop's own realised margin rather than
 * a single product's, because a shop covers its rent out of everything it sells.
 */
function shopBreakEven({ revenue, cogs, fixedPerMonth, windowDays = 90 }) {
  const rev = num(revenue), cost = num(cogs), fx = num(fixedPerMonth);
  if (rev <= 0 || fx <= 0) return null;
  const contributionRatio = (rev - cost) / rev;
  if (contributionRatio <= 0) return null;     // selling below cost overall; break-even is meaningless
  const months = Math.max(1, num(windowDays) / 30);
  return {
    fixedPerMonth: round2(fx),
    contributionMarginPct: round2(contributionRatio * 100),
    breakEvenRevenuePerMonth: round2(fx / contributionRatio),
    actualRevenuePerMonth: round2(rev / months),
    coveringCosts: (rev / months) >= (fx / contributionRatio),
  };
}

/**
 * How much of a perishable to stock, when what is left over is a write-off.
 *
 * The reorder-point model assumes stock keeps. For anything with an expiry date it does
 * not: order too little and the margin is lost, order too much and the whole cost is lost,
 * and those two are not symmetric. The newsvendor critical ratio is the standard answer —
 * stock up to the demand quantile where the cost of one more equals the cost of one fewer.
 */
function perishableQuantity({ unitCost, sellingPrice, meanDemand, sdDemand, salvageValue = 0 }) {
  const r = ops.newsvendorQuantity({
    unitCost, sellingPrice, salvageValue,
    meanDemand: num(meanDemand), sdDemand: num(sdDemand),
  });
  if (!r) return null;
  return {
    quantity: Math.max(0, Math.round(r.optimalQuantity)),
    serviceImplied: round2(r.criticalRatio * 100),
    costOfOneTooFew: r.underageCost,
    costOfOneTooMany: r.overageCost,
  };
}

module.exports = { orderQuantity, marginLeaks, affordableRestocks, onlineDemandBySku,
                  monthlyFixedCosts, shopBreakEven, perishableQuantity };
