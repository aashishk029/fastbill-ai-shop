"use strict";

/**
 * Customer credit exposure and limits.
 *
 * The app makes giving udhari a single toggle, and until now said nothing when
 * a customer was already deep in debt. Small shops most often lose money not to
 * theft or bad pricing but to credit quietly accumulating against one or two
 * customers who were always going to be slow.
 *
 * This module answers three questions before a credit sale is written:
 *   how much does this customer already owe, how do they actually pay, and
 *   would this bill take them past what the shopkeeper decided to allow.
 *
 * Pure functions, injectable `asOf`, no database.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

/**
 * How the same customer is recognised across bills. "Ramesh Kumar",
 * "ramesh kumar" and " Ramesh  Kumar " are one person; anything else would
 * split their exposure and defeat the entire feature.
 */
function customerKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function daysBetween(from, to) {
  if (!from || !to) return 0;
  const a = new Date(from), b = new Date(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  const istDay = (d) => Math.floor((d.getTime() + IST_OFFSET_MS) / DAY_MS);
  return istDay(b) - istDay(a);
}

/**
 * What a customer owes right now, from their open bills.
 * `outstanding` is expected to already be net of part payments.
 */
function currentExposure(openInvoices, { asOf = new Date() } = {}) {
  const list = (Array.isArray(openInvoices) ? openInvoices : []).filter(i => num(i && i.outstanding) > 0);
  let total = 0;
  let oldestDays = 0;
  for (const inv of list) {
    total += num(inv.outstanding);
    const age = daysBetween(inv.created_at, asOf);
    if (age > oldestDays) oldestDays = age;
  }
  return { exposure: Math.round(total), openBills: list.length, oldestDays };
}

/**
 * How this customer actually pays, from bills they have already settled.
 *
 * Judged on behaviour rather than on the shopkeeper's impression: a customer
 * who always pays, just slowly, is a different risk from one who disappears.
 */
function paymentBehaviour(settledInvoices, { asOf = new Date() } = {}) {
  const list = (Array.isArray(settledInvoices) ? settledInvoices : [])
    .filter(i => i && i.created_at && (i.paid_at || i.updated_at));

  if (list.length === 0) return { billsPaid: 0, averageDaysToPay: null, slowest: null, known: false };

  let sum = 0, slowest = 0;
  for (const inv of list) {
    const d = Math.max(0, daysBetween(inv.created_at, inv.paid_at || inv.updated_at));
    sum += d;
    if (d > slowest) slowest = d;
  }
  return {
    billsPaid: list.length,
    averageDaysToPay: Math.round(sum / list.length),
    slowest,
    // Two bills is not a pattern. Say so rather than dress up a guess as history.
    known: list.length >= 3,
  };
}

/**
 * Would this credit sale take the customer past their limit?
 *
 * A missing, null or zero limit means no limit has been set — never a limit of
 * zero. Treating "unset" as "zero" would warn on every credit sale and train
 * the shopkeeper to dismiss warnings without reading them, which is worse than
 * having no warning at all.
 */
function evaluateCreditSale({ exposure = 0, newAmount = 0, creditLimit = null, blockOverLimit = false, behaviour = null, oldestDays = 0 }) {
  const limit = num(creditLimit);
  const hasLimit = limit > 0;
  const exp = num(exposure);
  const amount = num(newAmount);
  const projected = Math.round(exp + amount);

  const result = {
    exposure: Math.round(exp),
    newAmount: Math.round(amount),
    projectedExposure: projected,
    creditLimit: hasLimit ? Math.round(limit) : null,
    availableCredit: hasLimit ? Math.round(Math.max(0, limit - exp)) : null,
    exceedsBy: hasLimit ? Math.round(Math.max(0, projected - limit)) : 0,
    wouldExceed: hasLimit && projected > limit,
    shouldBlock: false,
    reasons: [],
  };

  if (result.wouldExceed) {
    result.reasons.push("over_limit");
    result.shouldBlock = !!blockOverLimit;
  }

  // Signals worth raising even when no limit was ever set — a shopkeeper who
  // never configured a limit is exactly the one who needs telling.
  if (oldestDays >= 90 && exp > 0) result.reasons.push("old_dues");
  if (behaviour && behaviour.known && behaviour.averageDaysToPay >= 45) result.reasons.push("slow_payer");

  result.shouldWarn = result.reasons.length > 0;
  return result;
}

/**
 * One plain sentence a shopkeeper can act on, in English. The app translates
 * the pieces; this keeps the *decision* deterministic rather than asking a
 * language model to decide whether someone is creditworthy.
 */
function creditSummaryLine(evaluation, behaviour) {
  const parts = [];
  if (evaluation.exposure > 0) parts.push(`already owes ₹${evaluation.exposure.toLocaleString("en-IN")}`);
  if (evaluation.wouldExceed) {
    parts.push(`this bill crosses the ₹${evaluation.creditLimit.toLocaleString("en-IN")} limit by ₹${evaluation.exceedsBy.toLocaleString("en-IN")}`);
  }
  if (behaviour && behaviour.known) parts.push(`usually pays in ${behaviour.averageDaysToPay} days`);
  return parts.join("; ");
}

module.exports = { customerKey, currentExposure, paymentBehaviour, evaluateCreditSale, creditSummaryLine, daysBetween };
