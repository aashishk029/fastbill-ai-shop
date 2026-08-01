"use strict";

/**
 * Ageing of money owed — both directions.
 *
 * "You are owed ₹80,000" is not actionable. "₹62,000 of it is over 90 days old
 * and ₹41,000 of that is one customer" is. Ageing is the standard way every
 * accountant looks at receivables, and it is what turns a bakaya list into a
 * collection plan.
 *
 * Pure functions with an injectable `asOf` so the buckets can be tested without
 * waiting for time to pass.
 */

// Standard Indian trade practice: 30-day buckets, everything past 90 in one
// bucket because by then the conversation is the same regardless of exact age.
const BUCKETS = ["0-30", "31-60", "61-90", "90+"];

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

/**
 * Whole days between a date and now, counted on IST calendar days.
 *
 * Calendar days, not elapsed hours: a bill raised at 11pm yesterday is 1 day
 * old this morning, not 0. A shopkeeper counts days the same way.
 */
function daysOld(date, asOf = new Date()) {
  if (!date) return 0;
  const then = new Date(date);
  if (isNaN(then.getTime())) return 0;
  const istDay = (d) => Math.floor((d.getTime() + IST_OFFSET_MS) / DAY_MS);
  return Math.max(0, istDay(new Date(asOf)) - istDay(then));
}

function bucketFor(days) {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/**
 * Summarise a set of outstanding rows into ageing buckets.
 *
 * rows: [{ [dateField], [amountField], ... }]
 * Rows with nothing outstanding are ignored rather than counted as zero-value
 * entries, so "12 bills pending" means twelve bills that actually owe money.
 */
function ageingSummary(rows, { dateField = "created_at", amountField = "outstanding", asOf = new Date() } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => num(r && r[amountField]) > 0);

  const buckets = {};
  for (const b of BUCKETS) buckets[b] = { amount: 0, count: 0 };

  let total = 0;
  let oldestDays = 0;
  let weightedDaySum = 0;

  for (const row of list) {
    const amount = num(row[amountField]);
    const days = daysOld(row[dateField], asOf);
    const b = bucketFor(days);
    buckets[b].amount += amount;
    buckets[b].count += 1;
    total += amount;
    weightedDaySum += amount * days;
    if (days > oldestDays) oldestDays = days;
  }

  for (const b of BUCKETS) buckets[b].amount = Math.round(buckets[b].amount);

  return {
    buckets,
    total: Math.round(total),
    count: list.length,
    oldestDays,
    // Weighted by rupee, not by bill count: one large old bill matters more than
    // three small fresh ones, and this is the number that reflects that.
    averageDays: total > 0 ? Math.round(weightedDaySum / total) : 0,
    // The headline for a shopkeeper: money that is genuinely stuck.
    overdue90Plus: Math.round(buckets["90+"].amount),
  };
}

/**
 * Group outstanding rows by the party who owes (or is owed), so a shopkeeper
 * can see who to chase first rather than a flat list of bills.
 *
 * Sorted by amount, since that is the order collection effort should follow.
 */
function groupByParty(rows, { partyField, dateField = "created_at", amountField = "outstanding", asOf = new Date() } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => num(r && r[amountField]) > 0);
  const map = new Map();

  for (const row of list) {
    // Unnamed parties are grouped together rather than dropped — the money is
    // still owed even when the name was never entered.
    const name = (row[partyField] || "").trim() || "—";
    const key = name.toLowerCase();
    const amount = num(row[amountField]);
    const days = daysOld(row[dateField], asOf);

    const existing = map.get(key) || { name, outstanding: 0, bills: 0, oldestDays: 0, phone: null };
    existing.outstanding += amount;
    existing.bills += 1;
    if (days > existing.oldestDays) existing.oldestDays = days;
    if (!existing.phone && row.customer_phone) existing.phone = row.customer_phone;
    map.set(key, existing);
  }

  return [...map.values()]
    .map(p => ({ ...p, outstanding: Math.round(p.outstanding), bucket: bucketFor(p.oldestDays) }))
    .sort((a, b) => b.outstanding - a.outstanding);
}

module.exports = { BUCKETS, daysOld, bucketFor, ageingSummary, groupByParty };
