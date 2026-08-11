"use strict";

/**
 * Tally-compatible voucher XML.
 *
 * Every month a shopkeeper's books end up with a CA, and that CA works in
 * Tally. FastBahi will not beat Tally at accounting and should not try; giving
 * it a clean handoff turns the incumbent from a competitor into a channel, and
 * removes the single most common reason a shop would stop using this app.
 *
 * Structure follows Tally's documented import format:
 *   ENVELOPE > HEADER (TALLYREQUEST=Import, ID=Vouchers) > BODY > DATA >
 *   TALLYMESSAGE > VOUCHER > LEDGERENTRIES.LIST
 *   https://help.tallysolutions.com/sample-xml/
 *
 * The rule that governs everything here: within a voucher, debits must equal
 * credits, or Tally rejects the import. In Tally's XML a negative AMOUNT is a
 * debit and a positive one a credit, so each voucher's entries must sum to
 * exactly zero. That is a property worth testing rather than eyeballing — an
 * export that fails silently at the CA's desk is worse than no export, because
 * the shopkeeper only finds out at filing time.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};

/** XML text escaping. A customer named "Sharma & Sons" must not corrupt the file. */
function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Tally wants dates as YYYYMMDD, in IST — a bill at 11pm belongs to that day. */
function tallyDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Ledger entries for one sales invoice.
 *
 * The customer is debited with the full bill value; sales and each tax head are
 * credited. Tax heads are named the way Tally's own GST ledgers are, so they
 * map onto an existing chart of accounts instead of creating strays.
 */
function salesLedgerEntries(invoice) {
  const taxable = num(invoice.taxable_value);
  const cgst = num(invoice.cgst_amount);
  const sgst = num(invoice.sgst_amount);
  const igst = num(invoice.igst_amount);
  const isGst = invoice.is_gst_invoice !== false && (taxable > 0 || cgst || sgst || igst);

  // Non-GST bills have no stored taxable value; the whole amount is sales.
  const salesValue = isGst ? taxable : num(invoice.grossAmount ?? invoice.total ?? 0);
  const total = round2(salesValue + cgst + sgst + igst);

  const entries = [
    // Negative = debit in Tally's convention. The customer owes this.
    { ledger: invoice.customer_name || "Cash Sales", amount: round2(-total), isParty: true, deemedPositive: true },
    { ledger: isGst ? "Sales" : "Sales (Non-GST)", amount: round2(salesValue), deemedPositive: false },
  ];
  if (cgst) entries.push({ ledger: "Output CGST", amount: round2(cgst), deemedPositive: false });
  if (sgst) entries.push({ ledger: "Output SGST", amount: round2(sgst), deemedPositive: false });
  if (igst) entries.push({ ledger: "Output IGST", amount: round2(igst), deemedPositive: false });

  return entries;
}

/** Ledger entries for a purchase — the mirror image of a sale. */
function purchaseLedgerEntries(purchase) {
  const taxable = num(purchase.taxable_amount) || round2(num(purchase.quantity_boxes) * num(purchase.cost_per_box));
  const gst = num(purchase.gst_amount);
  const interState = !!purchase.is_inter_state;
  const total = round2(taxable + gst);

  const entries = [
    // The supplier is credited: the shop owes them.
    { ledger: purchase.supplier_name || "Sundry Creditors", amount: round2(total), isParty: true, deemedPositive: false },
    { ledger: "Purchase", amount: round2(-taxable), deemedPositive: true },
  ];
  if (gst) {
    // Input tax is an asset, hence a debit — this is what becomes ITC.
    if (interState) {
      entries.push({ ledger: "Input IGST", amount: round2(-gst), deemedPositive: true });
    } else {
      const half = round2(gst / 2);
      entries.push({ ledger: "Input CGST", amount: round2(-(gst - half)), deemedPositive: true });
      entries.push({ ledger: "Input SGST", amount: round2(-half), deemedPositive: true });
    }
  }
  return entries;
}

/** A credit note reverses a sale, so every sign flips. */
function creditNoteLedgerEntries(note) {
  const taxable = num(note.taxable_value);
  const cgst = num(note.cgst_amount);
  const sgst = num(note.sgst_amount);
  const igst = num(note.igst_amount);
  const total = round2(taxable + cgst + sgst + igst);

  const entries = [
    { ledger: note.customer_name || "Cash Sales", amount: round2(total), isParty: true, deemedPositive: false },
    { ledger: "Sales Returns", amount: round2(-taxable), deemedPositive: true },
  ];
  if (cgst) entries.push({ ledger: "Output CGST", amount: round2(-cgst), deemedPositive: true });
  if (sgst) entries.push({ ledger: "Output SGST", amount: round2(-sgst), deemedPositive: true });
  if (igst) entries.push({ ledger: "Output IGST", amount: round2(-igst), deemedPositive: true });
  return entries;
}

function ledgerEntryXml(e) {
  return `        <LEDGERENTRIES.LIST>
          <LEDGERNAME>${esc(e.ledger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${e.deemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>${e.isParty ? "\n          <ISPARTYLEDGER>Yes</ISPARTYLEDGER>" : ""}
          <AMOUNT>${e.amount.toFixed(2)}</AMOUNT>
        </LEDGERENTRIES.LIST>`;
}

function voucherXml({ vchType, date, voucherNumber, narration, entries, reference }) {
  return `      <VOUCHER VCHTYPE="${esc(vchType)}" ACTION="Create">
        <DATE>${date}</DATE>
        <VOUCHERTYPENAME>${esc(vchType)}</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${esc(voucherNumber)}</VOUCHERNUMBER>${reference ? `\n        <REFERENCE>${esc(reference)}</REFERENCE>` : ""}
        <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
        <ISINVOICE>Yes</ISINVOICE>${narration ? `\n        <NARRATION>${esc(narration)}</NARRATION>` : ""}
${entries.map(ledgerEntryXml).join("\n")}
      </VOUCHER>`;
}

/**
 * Build the import file.
 *
 * Any voucher whose entries do not sum to zero is left OUT and reported back,
 * rather than shipped in a file that Tally will reject wholesale. One bad row
 * must not cost the shopkeeper the whole month's export.
 */
function buildTallyXml({ companyName, invoices = [], purchases = [], creditNotes = [] }) {
  const vouchers = [];
  const rejected = [];

  const balanced = (entries) =>
    Math.abs(entries.reduce((s, e) => s + e.amount, 0)) < 0.02;

  /**
   * Balancing is necessary but not sufficient. A GST invoice carrying tax but no
   * taxable value balances perfectly and posts a fraction of the real bill —
   * ₹180 of tax on a ₹5,000 sale, with the sale itself silently absent. Tally
   * would accept it and the CA would file it. So the voucher is also checked
   * against the bill value the app already knows.
   */
  const salesInconsistency = (inv) => {
    const taxable = num(inv.taxable_value);
    const tax = num(inv.cgst_amount) + num(inv.sgst_amount) + num(inv.igst_amount);
    if (tax > 0 && taxable <= 0) return "tax recorded with no taxable value";

    // Compare against what will actually be posted, computed the same way the
    // ledger entries are — checking `taxable` alone would wrongly reject every
    // non-GST bill, whose value lives in grossAmount rather than taxable_value.
    const known = num(inv.grossAmount ?? inv.total ?? 0);
    if (known <= 0) return null;
    const posted = -num(salesLedgerEntries(inv)[0].amount);
    if (Math.abs(known - posted) > Math.max(1, known * 0.02)) {
      return `voucher total ${round2(posted)} does not match the bill value ${round2(known)}`;
    }
    return null;
  };

  for (const inv of invoices) {
    const problem = salesInconsistency(inv);
    if (problem) {
      rejected.push({ type: "sales", number: inv.invoice_number, reason: problem });
      continue;
    }
    const entries = salesLedgerEntries(inv);
    if (!balanced(entries)) {
      rejected.push({ type: "sales", number: inv.invoice_number, reason: "entries do not balance" });
      continue;
    }
    vouchers.push(voucherXml({
      vchType: "Sales",
      date: tallyDate(inv.created_at || inv.invoice_date),
      voucherNumber: inv.invoice_number,
      narration: inv.customer_gstin ? `GSTIN ${inv.customer_gstin}` : null,
      entries,
    }));
  }

  for (const p of purchases) {
    const entries = purchaseLedgerEntries(p);
    if (!balanced(entries)) {
      rejected.push({ type: "purchase", number: p.supplier_invoice_no || p.id, reason: "entries do not balance" });
      continue;
    }
    vouchers.push(voucherXml({
      vchType: "Purchase",
      date: tallyDate(p.purchase_date),
      voucherNumber: p.supplier_invoice_no || `PUR-${String(p.id || "").slice(0, 8)}`,
      narration: p.supplier_gstin ? `GSTIN ${p.supplier_gstin}` : null,
      entries,
    }));
  }

  for (const cn of creditNotes) {
    const entries = creditNoteLedgerEntries(cn);
    if (!balanced(entries)) {
      rejected.push({ type: "credit_note", number: cn.credit_note_number, reason: "entries do not balance" });
      continue;
    }
    vouchers.push(voucherXml({
      vchType: "Credit Note",
      date: tallyDate(cn.issued_at),
      voucherNumber: cn.credit_note_number,
      reference: cn.original_invoice_number,
      narration: cn.reason,
      entries,
    }));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${esc(companyName || "")}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
    </DESC>
    <DATA>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
${vouchers.join("\n")}
      </TALLYMESSAGE>
    </DATA>
  </BODY>
</ENVELOPE>
`;

  return { xml, voucherCount: vouchers.length, rejected };
}

module.exports = {
  esc, tallyDate,
  salesLedgerEntries, purchaseLedgerEntries, creditNoteLedgerEntries,
  buildTallyXml,
};
