"use strict";

/**
 * Counter cash: what should be in the drawer, and what actually is.
 *
 * The daily ritual of a small shop is counting the box at closing time. The
 * number that matters is not the day's sales — it is the difference between
 * the cash the records imply and the cash the shopkeeper is holding. A ₹200
 * shortfall found the same evening is a question someone can still answer; the
 * same shortfall found a month later is unrecoverable.
 *
 * Pure functions, no database.
 */

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * What the drawer should hold right now.
 *
 * opening + cash sales + old dues collected in cash
 *         − expenses paid in cash − suppliers paid in cash
 *
 * Only movements explicitly recorded as cash count. A UPI sale never touches
 * the drawer, and counting it would manufacture a shortfall every single day.
 */
function expectedCash({ openingCash = 0, cashSales = 0, cashCollections = 0, cashExpenses = 0, cashPayouts = 0 }) {
  return round2(
    num(openingCash) + num(cashSales) + num(cashCollections) - num(cashExpenses) - num(cashPayouts),
  );
}

/**
 * Compare the count with the expectation.
 *
 * `tolerance` exists because rounding to the rupee across a day of billing can
 * legitimately drift a few rupees, and flagging that as a discrepancy would
 * make the feature cry wolf. Anything past it is reported plainly as short or
 * excess — never softened, since a real shortfall is the whole point.
 */
function reconcile({ counted, expected, tolerance = 5 }) {
  const c = num(counted);
  const e = num(expected);
  const difference = round2(c - e);
  const tol = Math.abs(num(tolerance));

  let status = "tally";
  if (difference < -tol) status = "short";
  else if (difference > tol) status = "excess";

  return {
    counted: round2(c),
    expected: round2(e),
    difference,
    // Positive magnitude for display; `status` carries the direction.
    magnitude: Math.abs(difference),
    status,
    withinTolerance: Math.abs(difference) <= tol,
  };
}

/**
 * Split a day's paid bills by how they were settled.
 *
 * Bills written before payment mode was captured have no mode. They are
 * reported as `unknown` rather than assumed to be cash — assuming would make
 * every early day-close wrong and teach the shopkeeper the feature lies.
 */
function summarisePaymentModes(invoices, { amountOf } = {}) {
  const amount = amountOf || ((inv) =>
    num(inv.taxable_value) + num(inv.cgst_amount) + num(inv.sgst_amount));

  const totals = { cash: 0, upi: 0, card: 0, bank: 0, unknown: 0 };
  let unknownCount = 0;

  for (const inv of (Array.isArray(invoices) ? invoices : [])) {
    const mode = String(inv.payment_mode || "").toLowerCase();
    const value = amount(inv);
    if (Object.prototype.hasOwnProperty.call(totals, mode) && mode !== "unknown") {
      totals[mode] += value;
    } else {
      totals.unknown += value;
      unknownCount += 1;
    }
  }

  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
  return { ...totals, unknownCount };
}

module.exports = { expectedCash, reconcile, summarisePaymentModes };
