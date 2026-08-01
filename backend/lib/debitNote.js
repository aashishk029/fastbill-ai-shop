"use strict";

/**
 * Debit notes for purchase returns (CGST Act s.34, the buy-side mirror).
 *
 * When a shop sends goods back to a supplier, two things must happen and the
 * app previously did neither: stock has to come off the shelf, and the input
 * tax credit already claimed on those goods has to be REVERSED. The second is
 * the part that matters legally — keeping credit on goods that went back is
 * claiming a refund for tax the shop never ultimately bore.
 *
 * A debit note is the document that records it. Same shape as a credit note,
 * opposite direction: the supplier is debited, and input tax is given back.
 *
 * The rules mirror the sell side deliberately, because the reasoning is the
 * same: the tax is reversed at the rate that was actually charged on the
 * original purchase, and under the heads it was charged under — an inter-state
 * purchase reverses IGST, not CGST and SGST.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};

/** How the same supplier is recognised across purchases typed slightly differently. */
function supplierKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** DN/26-27/0001 — sequential within a shop's financial year, like credit notes. */
function debitNoteNumber({ sequence, financialYear }) {
  return `DN/${financialYear}/${String(sequence).padStart(4, "0")}`;
}

/**
 * Compute the debit note for returning part or all of a purchase.
 *
 * The GST reversal is proportional to what went back: return a quarter of the
 * consignment and a quarter of the credit is reversed. Computing it from the
 * item's current cost instead of the original purchase would reverse the wrong
 * amount whenever the price has moved since.
 */
function computeDebitNote({ purchase, returnQuantity, reason }) {
  const purchasedQty = num(purchase?.quantity_boxes);
  const returnQty = Math.min(Math.max(0, num(returnQuantity)), purchasedQty);
  if (returnQty <= 0 || purchasedQty <= 0) return null;

  const proportion = returnQty / purchasedQty;

  // Value at the price actually paid, not at whatever the item costs today.
  const costPerUnit = num(purchase.cost_per_box);
  const grossReturned = round2(returnQty * costPerUnit);

  // Tax as recorded on the original purchase, reversed in the same proportion.
  const originalTax = num(purchase.gst_amount);
  const originalTaxable = num(purchase.taxable_amount) || round2(purchasedQty * costPerUnit);
  const taxableReturned = round2(originalTaxable * proportion);
  const taxReversed = round2(originalTax * proportion);

  const interState = !!purchase.is_inter_state;
  const half = round2(taxReversed / 2);
  const components = interState
    ? { igst: round2(taxReversed), cgst: 0, sgst: 0 }
    : { igst: 0, cgst: round2(taxReversed - half), sgst: half };

  return {
    returnQuantity: returnQty,
    proportionReturned: round2(proportion * 100) / 100,
    isFullReturn: returnQty >= purchasedQty,
    costPerUnit,
    grossReturned,
    taxableValue: taxableReturned,
    taxReversed,
    ...components,
    totalDebit: round2(taxableReturned + taxReversed),
    // Only credit that was actually claimable gets reversed. Where no ITC was
    // ever taken — an unregistered supplier, no GSTIN recorded — there is
    // nothing to give back, and saying so avoids a reversal that would
    // overstate the shop's liability.
    itcReversed: !!purchase.itc_eligible,
    reason: reason || "Goods returned to supplier",
  };
}

module.exports = { supplierKey, debitNoteNumber, computeDebitNote };
