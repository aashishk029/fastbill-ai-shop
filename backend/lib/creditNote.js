"use strict";

/**
 * Credit notes for sales returns (CGST Act s.34).
 *
 * When goods come back, the law does not let a shopkeeper quietly edit the
 * invoice that was already issued — that invoice is a document the customer
 * holds and may have claimed credit against. The correct instrument is a
 * separate credit note that references the original invoice, states the tax
 * being credited, carries its own serial number, and is reported in GSTR-1
 * table 9B where it reduces output tax.
 *
 * Two rules this module exists to enforce:
 *
 *  1. A credit note is computed from the ORIGINAL invoice's rates, GST mode and
 *     discount — not from whatever the product's rate happens to be today. If a
 *     tile was sold at 12% and the rate later became 18%, the credit is 12%.
 *
 *  2. The credit follows the same tax heads as the sale. An inter-state sale is
 *     credited as IGST; crediting it as CGST+SGST would leave the buyer unable
 *     to reverse what they actually claimed.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};

/**
 * Indian financial year label for a date: 1 April to 31 March.
 * Credit note serial numbers restart each financial year, so this decides which
 * series a note belongs to.
 */
function financialYear(date = new Date()) {
  const d = new Date(date);
  // Work in IST, since a sale at 11pm on 31 March IST belongs to that FY.
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const startYear = ist.getUTCMonth() >= 3 ? y : y - 1; // month 3 = April
  return `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
}

/**
 * Serial number for a credit note.
 *
 * Must be unique and sequential within a shop for a financial year. The count is
 * supplied by the caller (a COUNT over existing notes) and the database carries
 * a unique constraint, so a race produces a conflict the caller retries rather
 * than two notes sharing a number.
 */
function creditNoteNumber({ sequence, date = new Date() }) {
  const fy = financialYear(date);
  return `CN/${fy}/${String(sequence).padStart(4, "0")}`;
}

/**
 * Compute the credit for a set of returned quantities against the original bill.
 *
 * originalItems: [{ design_id, quantity_boxes, price_per_box, gst_rate }]
 * returnedQty:   { [design_id]: quantity }
 *
 * A bill-level discount is credited in the same proportion it was originally
 * allocated, so a partial return credits partial discount — otherwise a customer
 * returning half a discounted bill would be refunded more than they paid.
 */
function computeCreditNote({
  originalItems,
  returnedQty,
  gstMode = "included",
  isGstInvoice = true,
  discountAmount = 0,
  interState = false,
}) {
  const items = Array.isArray(originalItems) ? originalItems : [];
  const discount = Math.max(0, num(discountAmount));

  const originalGross = items.reduce((s, i) => s + num(i.quantity_boxes) * num(i.price_per_box), 0);

  const lines = [];
  let taxableTotal = 0;
  let taxTotal = 0;
  let creditedGross = 0;

  for (const item of items) {
    const qty = Math.min(num(returnedQty?.[item.design_id]), num(item.quantity_boxes));
    if (qty <= 0) continue;

    const rate = num(item.price_per_box);
    const lineGross = qty * rate;

    // The share of the bill-level discount that sat on the returned quantity.
    const lineDiscount = originalGross > 0 ? discount * (lineGross / originalGross) : 0;
    const lineNet = Math.max(0, lineGross - lineDiscount);

    // The rate as it was on the original bill, not today's rate.
    const gstRate = num(item.gst_rate);
    const applyGst = isGstInvoice && gstRate > 0;
    const taxable = applyGst && gstMode === "included" ? lineNet / (1 + gstRate / 100) : lineNet;
    const tax = applyGst ? (gstMode === "included" ? lineNet - taxable : lineNet * gstRate / 100) : 0;

    lines.push({
      designId: item.design_id,
      quantity: qty,
      pricePerUnit: rate,
      grossValue: round2(lineGross),
      discount: round2(lineDiscount),
      taxableValue: round2(taxable),
      gstRate,
      taxAmount: round2(tax),
    });

    taxableTotal += taxable;
    taxTotal += tax;
    creditedGross += gstMode === "exclusive" && applyGst ? lineNet + tax : lineNet;
  }

  // Same heads as the original supply.
  const half = round2(taxTotal / 2);
  const components = interState
    ? { igst: round2(taxTotal), cgst: 0, sgst: 0 }
    : { igst: 0, cgst: round2(taxTotal - half), sgst: half };

  return {
    lines,
    taxableValue: round2(taxableTotal),
    taxAmount: round2(taxTotal),
    ...components,
    totalCredit: round2(creditedGross),
    isFullReturn: lines.length > 0 && items.every(i => num(returnedQty?.[i.design_id]) >= num(i.quantity_boxes)),
  };
}

/**
 * Whether a credit note can still reduce GST liability.
 *
 * Section 34(2): the adjustment must be declared by 30 November following the
 * end of the financial year in which the supply was made (or the annual return,
 * whichever is earlier). Past that the goods can still be taken back — the tax
 * simply cannot be recovered, and the shopkeeper deserves to be told that rather
 * than discover it from a notice.
 */
function gstAdjustmentAllowed(invoiceDate, asOf = new Date()) {
  if (!invoiceDate) return { allowed: true, deadline: null };
  const inv = new Date(invoiceDate);
  if (isNaN(inv.getTime())) return { allowed: true, deadline: null };

  const ist = new Date(inv.getTime() + 5.5 * 60 * 60 * 1000);
  const fyStartYear = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  // 30 November after the FY ends: FY 2025-26 ends 31 Mar 2026, deadline 30 Nov 2026.
  const deadline = new Date(Date.UTC(fyStartYear + 1, 10, 30, 18, 29, 59)); // 30 Nov, 23:59:59 IST

  return {
    allowed: new Date(asOf) <= deadline,
    deadline: deadline.toISOString().slice(0, 10),
  };
}

module.exports = { financialYear, creditNoteNumber, computeCreditNote, gstAdjustmentAllowed };
