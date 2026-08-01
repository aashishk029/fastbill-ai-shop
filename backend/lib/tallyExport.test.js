"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  esc, tallyDate, salesLedgerEntries, purchaseLedgerEntries,
  creditNoteLedgerEntries, buildTallyXml,
} = require("./tallyExport");

const sum = (entries) => Math.round(entries.reduce((s, e) => s + e.amount, 0) * 100) / 100;

test("XML text is escaped so a customer name cannot corrupt the file", () => {
  assert.equal(esc("Sharma & Sons"), "Sharma &amp; Sons");
  assert.equal(esc('He said "hi" <b>'), "He said &quot;hi&quot; &lt;b&gt;");
  assert.equal(esc(null), "");
});

test("dates are YYYYMMDD in IST, so a late-night bill keeps its own day", () => {
  assert.equal(tallyDate("2026-08-01T06:00:00Z"), "20260801");
  // 23:30 IST on 1 Aug is 18:00 UTC — still 1 August for the shopkeeper.
  assert.equal(tallyDate("2026-08-01T18:00:00Z"), "20260801");
  assert.equal(tallyDate(null), "");
});

// ── The property that decides whether Tally accepts the file at all ────────
test("a GST sale balances to zero", () => {
  const entries = salesLedgerEntries({
    customer_name: "Ramesh", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, is_gst_invoice: true,
  });
  assert.equal(sum(entries), 0, "debits must equal credits or Tally rejects the import");
  assert.equal(entries[0].amount, -1180, "the customer is debited the full bill");
  assert.ok(entries.some(e => e.ledger === "Output CGST" && e.amount === 90));
});

test("an inter-state sale posts IGST and no CGST or SGST", () => {
  const entries = salesLedgerEntries({
    customer_name: "Ramesh", taxable_value: 1000, igst_amount: 180, is_gst_invoice: true,
  });
  assert.equal(sum(entries), 0);
  assert.ok(entries.some(e => e.ledger === "Output IGST"));
  assert.ok(!entries.some(e => e.ledger === "Output CGST"), "no intra-state heads on an inter-state bill");
});

test("a non-GST bill posts to its own sales ledger and still balances", () => {
  const entries = salesLedgerEntries({ customer_name: "Walk-in", grossAmount: 500, is_gst_invoice: false });
  assert.equal(sum(entries), 0);
  assert.ok(entries.some(e => e.ledger === "Sales (Non-GST)"), "kept separate so a CA can see it at a glance");
});

test("a sale with no customer name still posts, to cash", () => {
  const entries = salesLedgerEntries({ taxable_value: 100, is_gst_invoice: true });
  assert.equal(entries[0].ledger, "Cash Sales", "the sale happened; it must not vanish for want of a name");
  assert.equal(sum(entries), 0);
});

test("a purchase balances, and input tax is a debit", () => {
  const entries = purchaseLedgerEntries({
    supplier_name: "Kajaria", quantity_boxes: 10, cost_per_box: 100, taxable_amount: 1000, gst_amount: 180,
  });
  assert.equal(sum(entries), 0);
  // Input tax is an asset — it becomes ITC — so it is debited (negative).
  assert.ok(entries.some(e => e.ledger === "Input CGST" && e.amount < 0));
  assert.equal(entries[0].amount, 1180, "the supplier is credited what they are owed");
});

test("input CGST and SGST halves add back to the tax paid", () => {
  const entries = purchaseLedgerEntries({ taxable_amount: 1000, gst_amount: 45.01 });
  const halves = entries.filter(e => e.ledger.startsWith("Input")).reduce((s, e) => s + e.amount, 0);
  assert.equal(Math.round(halves * 100) / 100, -45.01, "no paisa lost when halving");
});

test("an inter-state purchase debits input IGST", () => {
  const entries = purchaseLedgerEntries({ taxable_amount: 1000, gst_amount: 180, is_inter_state: true });
  assert.equal(sum(entries), 0);
  assert.ok(entries.some(e => e.ledger === "Input IGST"));
});

test("a credit note reverses a sale exactly", () => {
  const sale = salesLedgerEntries({ customer_name: "Ramesh", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, is_gst_invoice: true });
  const note = creditNoteLedgerEntries({ customer_name: "Ramesh", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90 });
  assert.equal(sum(note), 0);
  assert.equal(note[0].amount, -sale[0].amount, "the customer is credited what they were debited");
});

// ── Document assembly ──────────────────────────────────────────────────────
test("the envelope carries the tags Tally requires", () => {
  const { xml } = buildTallyXml({
    companyName: "Kanhaiya Marbles",
    invoices: [{ invoice_number: "INV-1", created_at: "2026-08-01T06:00:00Z", customer_name: "Ramesh", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, is_gst_invoice: true }],
  });
  for (const tag of ["<ENVELOPE>", "<TALLYREQUEST>Import</TALLYREQUEST>", "<ID>Vouchers</ID>",
                     "<TALLYMESSAGE", 'VCHTYPE="Sales"', "<LEDGERENTRIES.LIST>", "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>"]) {
    assert.ok(xml.includes(tag), `missing ${tag}`);
  }
  assert.ok(xml.includes("<SVCURRENTCOMPANY>Kanhaiya Marbles</SVCURRENTCOMPANY>"));
});

test("every voucher in the file balances", () => {
  const { xml, voucherCount } = buildTallyXml({
    companyName: "Shop",
    invoices: [
      { invoice_number: "INV-1", created_at: "2026-08-01T06:00:00Z", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, is_gst_invoice: true },
      { invoice_number: "INV-2", created_at: "2026-08-02T06:00:00Z", grossAmount: 250, is_gst_invoice: false },
    ],
    purchases: [{ id: "abc", purchase_date: "2026-07-20T06:00:00Z", supplier_name: "Kajaria", taxable_amount: 5000, gst_amount: 900 }],
    creditNotes: [{ credit_note_number: "CN/26-27/0001", issued_at: "2026-08-03T06:00:00Z", taxable_value: 500, cgst_amount: 45, sgst_amount: 45 }],
  });
  assert.equal(voucherCount, 4);

  // Parse each voucher's amounts back out and check the arithmetic survived.
  for (const block of xml.split("<VOUCHER ").slice(1)) {
    const amounts = [...block.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map(m => parseFloat(m[1]));
    const total = Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100;
    assert.equal(total, 0, `a voucher does not balance: ${amounts.join(", ")}`);
  }
});

test("a bill carrying tax but no taxable value is refused, not quietly shrunk", () => {
  // This balances perfectly and would post ₹180 of tax with the ₹5,000 sale
  // missing entirely. Tally would accept it; the CA would file it. Balancing is
  // necessary, not sufficient.
  const { voucherCount, rejected } = buildTallyXml({
    companyName: "Shop",
    invoices: [
      { invoice_number: "GOOD", created_at: "2026-08-01T06:00:00Z", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, is_gst_invoice: true },
      { invoice_number: "BAD", created_at: "2026-08-01T06:00:00Z", taxable_value: 0, cgst_amount: 90, sgst_amount: 90, is_gst_invoice: true, grossAmount: 5000 },
    ],
  });
  assert.equal(voucherCount, 1, "one bad row must not cost the whole month's export");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].number, "BAD");
  assert.match(rejected[0].reason, /taxable value/);
});

test("a voucher whose total disagrees with the recorded bill is refused", () => {
  const { voucherCount, rejected } = buildTallyXml({
    companyName: "Shop",
    invoices: [{
      invoice_number: "MISMATCH", created_at: "2026-08-01T06:00:00Z",
      taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, is_gst_invoice: true,
      grossAmount: 4000,   // the app says 4000; the tax fields say 1180
    }],
  });
  assert.equal(voucherCount, 0);
  assert.match(rejected[0].reason, /does not match the bill value/);
});

test("an empty period produces a valid file rather than a broken one", () => {
  const { xml, voucherCount } = buildTallyXml({ companyName: "Shop" });
  assert.equal(voucherCount, 0);
  assert.ok(xml.includes("<ENVELOPE>") && xml.includes("</ENVELOPE>"));
});
