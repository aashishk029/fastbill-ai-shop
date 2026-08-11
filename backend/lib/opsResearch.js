"use strict";

/**
 * Operations-research methods behind FastBahi's advice.
 *
 * These are the standard, decades-old results from inventory theory and
 * managerial accounting — not heuristics invented here, and emphatically not
 * output from a language model. A shopkeeper acting on "order 40 boxes by
 * Friday" deserves a number that can be derived, checked and argued with.
 *
 * Sources (all free, all public):
 *   - Reorder point and safety stock with variable demand AND variable lead
 *     time: ROP = μL·μD + z·√(μL·σD² + μD²·σL²)
 *     https://en.wikipedia.org/wiki/Reorder_point
 *   - EOQ = √(2DS/H), from the classic Harris/Wilson model.
 *     MIT OCW ESD.273J Logistics and Supply Chain Management, "Inventory and
 *     EOQ Models" (CC BY-NC-SA): https://ocw.mit.edu/courses/esd-273j-logistics-and-supply-chain-management-fall-2009/
 *   - Newsvendor critical ratio CR = Cu / (Cu + Co); order up to the demand
 *     quantile at CR. MIT OCW 15.772J D-Lab Supply Chains, newsvendor note.
 *   - ABC / Pareto classification by annual consumption value.
 *   - Inventory turnover, days of inventory, DSO: standard managerial accounting.
 *
 * A note on honesty that matters more than any formula here. Every one of these
 * assumes data the shop may not have: stable demand, a known lead time, a
 * meaningful sample. A kirana shop three weeks into using an app has none of
 * that. So each function reports how confident it can be, and the caller is
 * expected to stay silent rather than dress a guess up as arithmetic. Advice
 * that is confidently wrong costs a shopkeeper real money and costs us their
 * trust, which is worth more.
 */

const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// Statistics
// ─────────────────────────────────────────────────────────────────────────────

function mean(xs) {
  const a = (xs || []).map(num);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

/** Sample standard deviation (n-1). With fewer than two points there is no spread to measure. */
function stdDev(xs) {
  const a = (xs || []).map(num);
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.15e-9).
 *
 * Used to turn a service level into the z multiplier for safety stock. A lookup
 * table would only support the handful of levels someone remembered to type in;
 * this supports any level and is checked against published z values in the tests.
 */
function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return NaN;

  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];

  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safety stock covering variability in BOTH demand and lead time.
 *
 *   SS = z · √( μL·σD² + μD²·σL² )
 *
 * Ignoring lead-time variability is the more common shortcut and it is wrong in
 * exactly the situation Indian small retail lives in: the supplier who usually
 * takes four days and sometimes takes twelve.
 */
function safetyStock({ avgDailyDemand, sdDailyDemand, avgLeadTimeDays, sdLeadTimeDays = 0, serviceLevel = 0.95 }) {
  const muD = Math.max(0, num(avgDailyDemand));
  const sdD = Math.max(0, num(sdDailyDemand));
  const muL = Math.max(0, num(avgLeadTimeDays));
  const sdL = Math.max(0, num(sdLeadTimeDays));

  const z = normalQuantile(Math.min(0.9999, Math.max(0.5, num(serviceLevel))));
  const variance = muL * sdD ** 2 + muD ** 2 * sdL ** 2;
  return round2(z * Math.sqrt(Math.max(0, variance)));
}

/** Reorder point: expected demand over the lead time, plus a cushion for variability. */
function reorderPoint({ avgDailyDemand, sdDailyDemand, avgLeadTimeDays, sdLeadTimeDays = 0, serviceLevel = 0.95 }) {
  const muD = Math.max(0, num(avgDailyDemand));
  const muL = Math.max(0, num(avgLeadTimeDays));
  const ss = safetyStock({ avgDailyDemand, sdDailyDemand, avgLeadTimeDays, sdLeadTimeDays, serviceLevel });
  return {
    leadTimeDemand: round2(muD * muL),
    safetyStock: ss,
    reorderPoint: round2(muD * muL + ss),
    serviceLevel: num(serviceLevel),
  };
}

/**
 * Days until stock runs out at the current rate, and whether that is already
 * inside the lead time — the moment an order stops being optional.
 */
function stockRunway({ onHand, avgDailyDemand, avgLeadTimeDays }) {
  const rate = Math.max(0, num(avgDailyDemand));
  if (rate <= 0) return { daysLeft: null, urgent: false };
  const daysLeft = num(onHand) / rate;
  return {
    daysLeft: Math.floor(daysLeft),
    urgent: daysLeft <= num(avgLeadTimeDays),
  };
}

/**
 * Economic order quantity: EOQ = √(2·D·S / H)
 *
 * D = annual demand in units, S = fixed cost of placing one order,
 * H = cost of holding one unit for a year.
 *
 * Assumes steady demand, a fixed ordering cost and no quantity discounts. A shop
 * that gets a better rate per truckload is outside the model, and the answer
 * should be treated as a starting point rather than an instruction.
 */
function economicOrderQuantity({ annualDemand, orderCost, holdingCostPerUnitPerYear }) {
  const D = Math.max(0, num(annualDemand));
  const S = Math.max(0, num(orderCost));
  const H = num(holdingCostPerUnitPerYear);
  if (D <= 0 || S <= 0 || H <= 0) return null;

  const q = Math.sqrt((2 * D * S) / H);
  return {
    eoq: round2(q),
    ordersPerYear: round2(D / q),
    daysBetweenOrders: round2(365 / (D / q)),
    annualOrderingCost: round2((D / q) * S),
    annualHoldingCost: round2((q / 2) * H),
  };
}

/**
 * ABC classification by annual consumption value (Pareto).
 *
 * A = items making up the first 80% of value, B = next 15%, C = the rest.
 * The point is attention, not accounting: A items deserve tight control, C items
 * deserve to be left alone.
 */
function abcClassification(items) {
  const rows = (Array.isArray(items) ? items : [])
    .map(i => ({ ...i, annualValue: Math.max(0, num(i.annualValue)) }))
    .filter(i => i.annualValue > 0)
    .sort((a, b) => b.annualValue - a.annualValue);

  const total = rows.reduce((s, i) => s + i.annualValue, 0);
  if (total <= 0) return [];

  // The item that CROSSES a boundary belongs to the class it completes, judged on
  // the cumulative share before it is added. Classifying on the cumulative after
  // adding would leave class A empty whenever a single item exceeds 80% of value
  // on its own — which happens in small shops with one dominant line, and an
  // empty "vital few" is useless advice.
  let cumulative = 0;
  return rows.map(row => {
    const before = cumulative / total;
    cumulative += row.annualValue;
    return {
      ...row,
      shareOfValue: round2((row.annualValue / total) * 100),
      cumulativeShare: round2((cumulative / total) * 100),
      class: before < 0.8 ? "A" : before < 0.95 ? "B" : "C",
    };
  });
}

/**
 * Inventory turnover and days of inventory.
 *   turnover = COGS / average inventory value
 *   days     = 365 / turnover
 * Low turnover means capital sitting on a shelf instead of working.
 */
function inventoryTurnover({ costOfGoodsSold, averageInventoryValue, periodDays = 365 }) {
  const cogs = num(costOfGoodsSold);
  const avg = num(averageInventoryValue);
  if (avg <= 0 || cogs <= 0) return null;
  const turns = cogs / avg;
  return {
    turnover: round2(turns),
    daysOfInventory: Math.round(periodDays / turns),
  };
}

/**
 * Days sales outstanding: (receivables / credit sales) × days.
 * How long the shop's own money stays in someone else's pocket.
 */
function daysSalesOutstanding({ receivables, creditSales, periodDays = 365 }) {
  const ar = num(receivables);
  const sales = num(creditSales);
  if (sales <= 0) return null;
  return Math.round((ar / sales) * periodDays);
}

/**
 * Newsvendor order quantity for a perishable, single-season item.
 *
 *   Cu = profit forgone per unit short  = price − cost
 *   Co = loss per unit left over        = cost − salvage
 *   critical ratio = Cu / (Cu + Co)
 *   Q* = the demand quantile at that ratio
 *
 * With normally distributed demand, Q* = μ + z(CR)·σ. Relevant for milk, bread,
 * vegetables and anything with an expiry date — the classic tradeoff between
 * running out and throwing out.
 */
function newsvendorQuantity({ unitCost, sellingPrice, salvageValue = 0, meanDemand, sdDemand }) {
  const cost = num(unitCost);
  const price = num(sellingPrice);
  const salvage = num(salvageValue);
  const mu = Math.max(0, num(meanDemand));
  const sd = Math.max(0, num(sdDemand));

  const underage = price - cost;   // cost of having too few
  const overage = cost - salvage;  // cost of having too many
  if (underage <= 0 || overage <= 0) return null;

  const criticalRatio = underage / (underage + overage);
  const z = normalQuantile(criticalRatio);
  return {
    criticalRatio: round2(criticalRatio),
    underageCost: round2(underage),
    overageCost: round2(overage),
    optimalQuantity: Math.max(0, round2(mu + z * sd)),
  };
}

/**
 * Contribution margin and break-even.
 *   contribution per unit = price − variable cost
 *   break-even units      = fixed costs / contribution per unit
 * Tells a shopkeeper how much they must sell before the month stops losing money.
 */
function breakEven({ pricePerUnit, variableCostPerUnit, fixedCosts }) {
  const price = num(pricePerUnit);
  const variable = num(variableCostPerUnit);
  const fixed = Math.max(0, num(fixedCosts));
  const contribution = price - variable;
  if (contribution <= 0) return null;

  return {
    contributionPerUnit: round2(contribution),
    contributionMarginPercent: price > 0 ? round2((contribution / price) * 100) : 0,
    breakEvenUnits: Math.ceil(fixed / contribution),
    breakEvenRevenue: round2(Math.ceil(fixed / contribution) * price),
  };
}

/**
 * How much a recommendation can be trusted, from how much history stands behind it.
 *
 * Deliberately conservative. Two weeks of data cannot support a confident
 * restock instruction, and saying so is more useful than a precise-looking
 * number built on nothing.
 */
function confidenceFrom({ observations, daysOfHistory }) {
  const n = num(observations);
  const days = num(daysOfHistory);
  if (n >= 30 && days >= 60) return { level: "high", usable: true };
  if (n >= 10 && days >= 21) return { level: "medium", usable: true };
  if (n >= 4 && days >= 14) return { level: "low", usable: true };
  return { level: "insufficient", usable: false };
}

module.exports = {
  mean, stdDev, normalQuantile,
  safetyStock, reorderPoint, stockRunway, economicOrderQuantity,
  abcClassification, inventoryTurnover, daysSalesOutstanding,
  newsvendorQuantity, breakEven, confidenceFrom,
};
