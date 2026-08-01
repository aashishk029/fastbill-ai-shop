"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { daysOld, bucketFor, ageingSummary, groupByParty } = require("./ageing");

// A fixed "now" so bucket boundaries are testable without waiting for time.
const NOW = new Date("2026-08-01T12:00:00+05:30");
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

test("age is counted in IST calendar days, not elapsed hours", () => {
  // A bill raised at 11pm is one day old the next morning, which is how a
  // shopkeeper counts it — not zero because 13 hours have not made 24.
  const lateLastNight = new Date("2026-07-31T23:00:00+05:30").toISOString();
  assert.equal(daysOld(lateLastNight, NOW), 1);

  const thisMorning = new Date("2026-08-01T09:00:00+05:30").toISOString();
  assert.equal(daysOld(thisMorning, NOW), 0);
});

test("a future or malformed date never produces a negative age", () => {
  assert.equal(daysOld(new Date(NOW.getTime() + 5 * 86400000).toISOString(), NOW), 0);
  assert.equal(daysOld("not a date", NOW), 0);
  assert.equal(daysOld(null, NOW), 0);
});

test("bucket boundaries fall where an accountant expects", () => {
  assert.equal(bucketFor(0), "0-30");
  assert.equal(bucketFor(30), "0-30");
  assert.equal(bucketFor(31), "31-60");
  assert.equal(bucketFor(60), "31-60");
  assert.equal(bucketFor(61), "61-90");
  assert.equal(bucketFor(90), "61-90");
  assert.equal(bucketFor(91), "90+");
  assert.equal(bucketFor(400), "90+");
});

test("amounts land in the right bucket and the buckets reconcile to the total", () => {
  const s = ageingSummary([
    { created_at: daysAgo(5), outstanding: 1000 },
    { created_at: daysAgo(45), outstanding: 2000 },
    { created_at: daysAgo(75), outstanding: 3000 },
    { created_at: daysAgo(200), outstanding: 4000 },
  ], { asOf: NOW });

  assert.equal(s.buckets["0-30"].amount, 1000);
  assert.equal(s.buckets["31-60"].amount, 2000);
  assert.equal(s.buckets["61-90"].amount, 3000);
  assert.equal(s.buckets["90+"].amount, 4000);
  assert.equal(s.total, 10000);
  const sum = Object.values(s.buckets).reduce((a, b) => a + b.amount, 0);
  assert.equal(sum, s.total, "buckets must add up to the total");
});

test("money stuck beyond 90 days is surfaced as its own headline", () => {
  const s = ageingSummary([
    { created_at: daysAgo(10), outstanding: 5000 },
    { created_at: daysAgo(120), outstanding: 62000 },
  ], { asOf: NOW });
  assert.equal(s.overdue90Plus, 62000);
  assert.equal(s.oldestDays, 120);
});

test("average age is weighted by rupees, not by bill count", () => {
  // One big old bill should dominate three small fresh ones.
  const s = ageingSummary([
    { created_at: daysAgo(100), outstanding: 90000 },
    { created_at: daysAgo(1), outstanding: 1000 },
    { created_at: daysAgo(1), outstanding: 1000 },
    { created_at: daysAgo(1), outstanding: 1000 },
  ], { asOf: NOW });
  assert.ok(s.averageDays > 90, `weighted average should be dominated by the large old bill, got ${s.averageDays}`);
});

test("settled rows are ignored, so counts mean bills that actually owe money", () => {
  const s = ageingSummary([
    { created_at: daysAgo(5), outstanding: 1000 },
    { created_at: daysAgo(5), outstanding: 0 },
    { created_at: daysAgo(5), outstanding: -50 },
  ], { asOf: NOW });
  assert.equal(s.count, 1);
  assert.equal(s.total, 1000);
});

test("an empty ledger produces zeros, not NaN", () => {
  const s = ageingSummary([], { asOf: NOW });
  assert.equal(s.total, 0);
  assert.equal(s.averageDays, 0);
  assert.equal(s.oldestDays, 0);
  assert.equal(s.count, 0);
});

test("a party's bills are combined and sorted by how much they owe", () => {
  const parties = groupByParty([
    { customer_name: "Ramesh", created_at: daysAgo(10), outstanding: 5000, customer_phone: "9876543210" },
    { customer_name: "Ramesh", created_at: daysAgo(95), outstanding: 13000 },
    { customer_name: "Suresh", created_at: daysAgo(3), outstanding: 2000 },
  ], { partyField: "customer_name", asOf: NOW });

  assert.equal(parties.length, 2);
  assert.equal(parties[0].name, "Ramesh", "largest debtor comes first");
  assert.equal(parties[0].outstanding, 18000);
  assert.equal(parties[0].bills, 2);
  assert.equal(parties[0].oldestDays, 95, "the oldest bill sets the party's age");
  assert.equal(parties[0].bucket, "90+");
  assert.equal(parties[0].phone, "9876543210", "a phone from any of their bills is kept for chasing");
});

test("the same customer written with different capitalisation is one party", () => {
  const parties = groupByParty([
    { customer_name: "Ramesh Kumar", created_at: daysAgo(5), outstanding: 1000 },
    { customer_name: "ramesh kumar", created_at: daysAgo(5), outstanding: 500 },
  ], { partyField: "customer_name", asOf: NOW });
  assert.equal(parties.length, 1);
  assert.equal(parties[0].outstanding, 1500);
});

test("bills with no name recorded are still counted, not dropped", () => {
  const parties = groupByParty([
    { customer_name: "", created_at: daysAgo(5), outstanding: 700 },
    { customer_name: null, created_at: daysAgo(5), outstanding: 300 },
  ], { partyField: "customer_name", asOf: NOW });
  assert.equal(parties.length, 1, "grouped together under a placeholder");
  assert.equal(parties[0].outstanding, 1000, "the money is owed whether or not a name was typed");
});
