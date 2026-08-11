"use strict";

/**
 * Money math for FastBahi — extracted so it can be tested without a database,
 * a network, or booting the server.
 *
 * Everything a shopkeeper trusts lives here: what a line item costs, how a
 * discount is applied, how GST is split, and what input credit is claimable.
 * These are the calculations where a silent regression shows up as a wrong
 * number on a printed bill in front of a customer, which is not recoverable by
 * an apology — so they are pure functions with tests, not inline arithmetic
 * spread across route handlers.
 *
 * Rules encoded here, each of which was once a bug:
 *  - Discount applies BEFORE GST, allocated proportionally across lines.
 *  - GST 'included' mode reverse-extracts; 'exclusive' adds on top.
 *  - Every item carries its own rate (from its HSN), so a bill can mix rates.
 *  - Reclaimable GST is not a cost, so it must not sit in the pricing basis.
 */

// GSTIN: 2-digit state code, 5-letter PAN prefix, 4 digits, 1 letter, entity
// code, 'Z', then a checksum character.
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][Z][0-9A-Z]$/;

function isValidGstin(g) {
  return typeof g === "string" && GSTIN_REGEX.test(g.toUpperCase());
}

/** Round to paise. Money is never compared or stored at full float precision. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

/**
 * Split a gross amount into taxable value and GST.
 * @param mode 'included' (gross contains GST) | 'exclusive' (GST adds on top)
 */
function splitGst(gross, rate, mode) {
  const g = num(gross);
  const r = num(rate);
  if (r <= 0) return { taxable: round2(g), gst: 0 };
  if (mode === "exclusive") return { taxable: round2(g), gst: round2(g * r / 100) };
  const taxable = g / (1 + r / 100);
  return { taxable: round2(taxable), gst: round2(g - taxable) };
}

/**
 * Compute a full invoice from its lines.
 *
 * items: [{ quantity, rate, gstRate }]
 * Returns per-line detail plus invoice totals. `discount` is a bill-level
 * rupee amount spread proportionally over the lines by their pre-discount value.
 */
function computeInvoice({ items, discount = 0, isGstInvoice = false, gstMode = "included" }) {
  const list = Array.isArray(items) ? items : [];
  const disc = Math.max(0, num(discount));
  const mode = gstMode === "exclusive" ? "exclusive" : "included";

  const preDiscount = list.map(i => num(i.quantity) * num(i.rate));
  const preSum = preDiscount.reduce((s, n) => s + n, 0);

  const lines = list.map((item, idx) => {
    const grossLine = preDiscount[idx];
    // Proportional allocation. When every line is zero there is nothing to
    // allocate against, so no discount is applied rather than dividing by zero.
    const lineDiscount = preSum > 0 ? disc * (grossLine / preSum) : 0;
    const lineTotal = Math.max(0, grossLine - lineDiscount);

    const rate = num(item.gstRate);
    const applyGst = isGstInvoice && rate > 0;
    const { taxable, gst } = applyGst
      ? splitGst(lineTotal, rate, mode)
      : { taxable: lineTotal, gst: 0 };

    return {
      quantity: num(item.quantity),
      rate: num(item.rate),
      gstRate: rate,
      grossLine: round2(grossLine),
      lineDiscount: round2(lineDiscount),
      lineTotal: round2(lineTotal),
      taxable: round2(taxable),
      gst: round2(gst),
      cgst: round2(gst / 2),
      sgst: round2(gst / 2),
      // What this line shows as its final amount on the bill.
      lineFinal: round2(mode === "exclusive" && applyGst ? lineTotal + gst : lineTotal),
    };
  });

  const taxableValue = round2(lines.reduce((s, l) => s + l.taxable, 0));
  const gstAmount = round2(lines.reduce((s, l) => s + l.gst, 0));
  const afterDiscount = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const total = round2(mode === "exclusive" && isGstInvoice ? afterDiscount + gstAmount : afterDiscount);

  return {
    lines,
    subtotal: round2(preSum),
    discount: round2(Math.min(disc, preSum)),
    afterDiscount,
    taxableValue,
    gstAmount,
    cgst: round2(gstAmount / 2),
    sgst: round2(gstAmount / 2),
    total,
    roundOff: round2(Math.round(total) - total),
    payable: Math.round(total),
  };
}

/**
 * Jewellery billing. Different shape entirely: value is metal weight × rate plus
 * making charges per gram, and GST is the statutory 3% rather than an HSN rate.
 */
const GST_JEWELLERY = 3;

function computeJewelleryInvoice({ items, isGstInvoice = true }) {
  const lines = (Array.isArray(items) ? items : []).map(item => {
    const weight = num(item.weightGrams);
    const metalValue = weight * num(item.metalRate);
    const makingValue = weight * num(item.makingChargesPerGram);
    const taxable = metalValue + makingValue;
    const gst = isGstInvoice ? taxable * GST_JEWELLERY / 100 : 0;
    return {
      weightGrams: weight,
      metalValue: round2(metalValue),
      makingValue: round2(makingValue),
      taxable: round2(taxable),
      gst: round2(gst),
      lineTotal: round2(taxable + gst),
    };
  });

  const taxableValue = round2(lines.reduce((s, l) => s + l.taxable, 0));
  const gstAmount = round2(lines.reduce((s, l) => s + l.gst, 0));
  return {
    lines,
    taxableValue,
    gstAmount,
    cgst: round2(gstAmount / 2),
    sgst: round2(gstAmount / 2),
    gstRate: GST_JEWELLERY,
    total: round2(taxableValue + gstAmount),
  };
}

/**
 * Split what was paid to a supplier, and decide whether the GST is claimable.
 *
 * Input credit is only real when all three hold: this shop is registered, the
 * supplier is registered (their GSTIN is on the bill), and a rate was entered.
 * Decided here rather than trusted from a client, since it changes tax liability.
 *
 * Deliberate limit: final entitlement also needs the supplier to have filed,
 * which is only visible in GSTR-2B. This returns what the shop's own records
 * support, and callers must label it that way.
 */
function computePurchaseGst({ grossValue, gstRate, gstMode, supplierGstin, shopGstin }) {
  const rate = num(gstRate);
  const mode = gstMode || "none";
  const hasRate = rate > 0 && mode !== "none";

  if (!hasRate) {
    return { taxableAmount: round2(grossValue), gstAmount: 0, gstRate: null, gstMode: "none", itcEligible: false };
  }

  const { taxable, gst } = splitGst(grossValue, rate, mode);
  const itcEligible = !!(shopGstin && supplierGstin && isValidGstin(String(supplierGstin)));

  return { taxableAmount: taxable, gstAmount: gst, gstRate: rate, gstMode: mode, itcEligible };
}

/**
 * Cost basis for setting a selling price.
 *
 * Reclaimable GST is not a cost — it comes back — so pricing on the gross paid
 * would silently overprice every item for a registered shop. For a shop with no
 * GSTIN nothing is reclaimable, so the gross amount is the true cost.
 * Transport/misc is spread across the units bought either way.
 */
function pricingCostPerUnit({ quantity, costPerUnit, extraCost = 0, purchaseGst = null }) {
  const qty = num(quantity);
  const extra = Math.max(0, num(extraCost));
  const base = purchaseGst && purchaseGst.itcEligible && qty > 0
    ? purchaseGst.taxableAmount / qty
    : num(costPerUnit);
  return round2(base + (qty > 0 ? extra / qty : 0));
}

function suggestedPrice({ effectiveCost, marginPercent = null, marginAmount = null }) {
  const cost = num(effectiveCost);
  if (marginPercent !== null && marginPercent !== undefined && marginPercent !== "") {
    return round2(cost * (1 + num(marginPercent) / 100));
  }
  if (marginAmount !== null && marginAmount !== undefined && marginAmount !== "") {
    return round2(cost + num(marginAmount));
  }
  return null;
}

/**
 * Aggregate input credit across a shop's purchases for a period.
 * `blocked` is GST that was paid but cannot be claimed — usually because no
 * supplier GSTIN was recorded. Surfacing it tells a shopkeeper what not
 * collecting proper tax invoices is actually costing them.
 */
function summariseItc(purchases) {
  const rows = Array.isArray(purchases) ? purchases : [];
  const paid = rows.reduce((s, p) => s + num(p.gst_amount), 0);
  const available = rows.reduce((s, p) => s + (p.itc_eligible ? num(p.gst_amount) : 0), 0);
  return {
    gstPaidOnPurchases: round2(paid),
    itcAvailable: round2(available),
    itcBlocked: round2(paid - available),
    purchasesWithoutGst: rows.filter(p => !num(p.gst_amount)).length,
  };
}

/**
 * Cost of goods for the P&L.
 * Where GST was reclaimed as ITC the tax is not an expense, so the taxable
 * value is used; counting the gross while also claiming the credit would deduct
 * the same tax twice. Where nothing is reclaimable the GST genuinely is a cost.
 */
function purchaseCostForPnl(purchases) {
  return round2((Array.isArray(purchases) ? purchases : []).reduce((s, p) => {
    if (p.itc_eligible && p.taxable_amount) return s + num(p.taxable_amount);
    return s + num(p.quantity_boxes) * num(p.cost_per_box);
  }, 0));
}

/**
 * The tax on an invoice row, whichever way it was split.
 *
 * Before IGST existed this was written inline as cgst + sgst in seventeen
 * places. Every one of them would silently under-report an inter-state bill,
 * so the definition lives here once and callers use it.
 */
function invoiceTaxTotal(inv) {
  if (!inv) return 0;
  return round2(num(inv.cgst_amount) + num(inv.sgst_amount) + num(inv.igst_amount));
}

/**
 * What the customer owes on an invoice: taxable value plus tax.
 *
 * For a non-GST bill there is no stored taxable value, so the caller must pass
 * the item gross; that path stays with the caller because only it knows whether
 * the items were loaded.
 */
function invoiceGrossValue(inv) {
  if (!inv) return 0;
  return round2(num(inv.taxable_value) + invoiceTaxTotal(inv));
}

module.exports = {
  GSTIN_REGEX,
  GST_JEWELLERY,
  isValidGstin,
  round2,
  splitGst,
  computeInvoice,
  computeJewelleryInvoice,
  computePurchaseGst,
  pricingCostPerUnit,
  suggestedPrice,
  summariseItc,
  purchaseCostForPnl,
  invoiceTaxTotal,
  invoiceGrossValue,
};
