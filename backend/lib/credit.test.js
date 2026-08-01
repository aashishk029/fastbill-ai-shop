"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { customerKey, currentExposure, paymentBehaviour, evaluateCreditSale, creditSummaryLine } = require("./credit");

const NOW = new Date("2026-08-02T12:00:00+05:30");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

test("one customer stays one customer despite typing differences", () => {
  // If this splits, their exposure splits, and the whole feature is pointless.
  const k = customerKey("Ramesh Kumar");
  assert.equal(customerKey("ramesh kumar"), k);
  assert.equal(customerKey("  Ramesh   Kumar  "), k);
  assert.equal(customerKey("RAMESH KUMAR"), k);
  assert.notEqual(customerKey("Ramesh Kumars"), k, "a genuinely different name stays different");
});

test("exposure sums open bills and remembers the oldest", () => {
  const e = currentExposure([
    { outstanding: 5000, created_at: daysAgo(10) },
    { outstanding: 13000, created_at: daysAgo(95) },
    { outstanding: 0, created_at: daysAgo(200) },   // settled, ignored
  ], { asOf: NOW });
  assert.equal(e.exposure, 18000);
  assert.equal(e.openBills, 2);
  assert.equal(e.oldestDays, 95);
});

test("payment behaviour needs a pattern before it claims to know one", () => {
  const two = paymentBehaviour([
    { created_at: daysAgo(40), paid_at: daysAgo(30) },
    { created_at: daysAgo(20), paid_at: daysAgo(10) },
  ], { asOf: NOW });
  assert.equal(two.billsPaid, 2);
  assert.equal(two.known, false, "two bills is not a history");

  const three = paymentBehaviour([
    { created_at: daysAgo(70), paid_at: daysAgo(50) },   // 20 days
    { created_at: daysAgo(60), paid_at: daysAgo(30) },   // 30 days
    { created_at: daysAgo(50), paid_at: daysAgo(10) },   // 40 days
  ], { asOf: NOW });
  assert.equal(three.known, true);
  assert.equal(three.averageDaysToPay, 30);
  assert.equal(three.slowest, 40);
});

test("a customer with no payment history is reported as unknown, not as perfect", () => {
  const b = paymentBehaviour([], { asOf: NOW });
  assert.equal(b.known, false);
  assert.equal(b.averageDaysToPay, null, "null, not 0 — never imply they pay same-day");
});

test("an unset limit is not a limit of zero", () => {
  // Treating unset as zero would warn on every credit sale and teach the
  // shopkeeper to dismiss warnings without reading them.
  for (const limit of [null, undefined, 0, ""]) {
    const r = evaluateCreditSale({ exposure: 5000, newAmount: 2000, creditLimit: limit });
    assert.equal(r.wouldExceed, false, `limit ${JSON.stringify(limit)} must mean "not set"`);
    assert.equal(r.creditLimit, null);
    assert.equal(r.availableCredit, null);
  }
});

test("a bill that crosses the limit is flagged with the exact shortfall", () => {
  const r = evaluateCreditSale({ exposure: 18000, newAmount: 5000, creditLimit: 20000 });
  assert.equal(r.wouldExceed, true);
  assert.equal(r.projectedExposure, 23000);
  assert.equal(r.exceedsBy, 3000);
  assert.equal(r.availableCredit, 2000);
  assert.ok(r.reasons.includes("over_limit"));
});

test("a bill exactly at the limit is allowed", () => {
  const r = evaluateCreditSale({ exposure: 15000, newAmount: 5000, creditLimit: 20000 });
  assert.equal(r.wouldExceed, false, "at the limit is within it");
  assert.equal(r.availableCredit, 5000);
});

test("warning is the default; blocking only when the shop asked for it", () => {
  const warn = evaluateCreditSale({ exposure: 30000, newAmount: 5000, creditLimit: 20000 });
  assert.equal(warn.shouldWarn, true);
  assert.equal(warn.shouldBlock, false, "a wrongly set limit must not stop a sale at the counter");

  const block = evaluateCreditSale({ exposure: 30000, newAmount: 5000, creditLimit: 20000, blockOverLimit: true });
  assert.equal(block.shouldBlock, true);
});

test("old dues raise a warning even when no limit was ever set", () => {
  // The shopkeeper who never configured a limit is exactly the one who needs telling.
  const r = evaluateCreditSale({ exposure: 12000, newAmount: 1000, creditLimit: null, oldestDays: 120 });
  assert.equal(r.shouldWarn, true);
  assert.ok(r.reasons.includes("old_dues"));
});

test("a known slow payer is flagged; an unproven one is not", () => {
  const slow = evaluateCreditSale({
    exposure: 1000, newAmount: 500,
    behaviour: { known: true, averageDaysToPay: 60 },
  });
  assert.ok(slow.reasons.includes("slow_payer"));

  const unproven = evaluateCreditSale({
    exposure: 1000, newAmount: 500,
    behaviour: { known: false, averageDaysToPay: 60 },
  });
  assert.equal(unproven.reasons.includes("slow_payer"), false, "one or two late bills is not a pattern");
});

test("a clean customer within their limit triggers nothing", () => {
  const r = evaluateCreditSale({
    exposure: 2000, newAmount: 1000, creditLimit: 20000, oldestDays: 5,
    behaviour: { known: true, averageDaysToPay: 12 },
  });
  assert.equal(r.shouldWarn, false);
  assert.equal(r.reasons.length, 0);
});

test("the summary states the numbers a shopkeeper needs to decide", () => {
  const evaluation = evaluateCreditSale({ exposure: 18000, newAmount: 5000, creditLimit: 20000 });
  const line = creditSummaryLine(evaluation, { known: true, averageDaysToPay: 22 });
  assert.match(line, /18,000/);
  assert.match(line, /20,000/);
  assert.match(line, /3,000/);
  assert.match(line, /22 days/);
});
