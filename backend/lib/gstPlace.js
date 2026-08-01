"use strict";

/**
 * Place of supply, and the CGST+SGST versus IGST decision.
 *
 * Until now every bill was split CGST+SGST, which is correct only for a sale
 * inside the seller's own state. The moment a shop sells to a buyer in another
 * state the tax is IGST at the full rate, and a bill that says CGST+SGST is
 * wrong on the face of it — the buyer cannot claim credit correctly and the
 * seller's GSTR-1 does not reconcile. This is a legal defect, not a feature gap.
 *
 * The rule (CGST Act s.10 for goods, simplified for over-the-counter retail):
 *   - Both parties in the same state  → intra-state → CGST + SGST, half each
 *   - Different states                → inter-state → IGST at the full rate
 *
 * The state comes from the first two digits of a GSTIN. For an unregistered
 * buyer with no GSTIN, place of supply is where the goods are handed over —
 * which for a counter sale is the shop's own state, hence intra-state. That is
 * the honest default, and it matches what a walk-in sale actually is.
 */

// GST state codes as notified. Kept complete because an unknown code must be
// treated as unknown rather than guessed at.
const STATE_CODES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "25": "Daman and Diu", "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra", "28": "Andhra Pradesh (old)", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh",
  "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction",
};

/** The state code embedded in a GSTIN, or null when it cannot be read. */
function stateCodeFromGstin(gstin) {
  const g = String(gstin || "").trim().toUpperCase();
  if (g.length < 2) return null;
  const code = g.slice(0, 2);
  return /^[0-9]{2}$/.test(code) && STATE_CODES[code] ? code : null;
}

function stateName(code) {
  return STATE_CODES[String(code || "")] || null;
}

/**
 * Decide the tax treatment for one bill.
 *
 * `placeOfSupply` (a state code) wins when supplied, because a shopkeeper
 * delivering goods to another state knows that better than any inference. It
 * falls back to the buyer's GSTIN, and finally to the seller's own state.
 */
function resolveSupply({ sellerGstin, buyerGstin, placeOfSupply }) {
  const sellerState = stateCodeFromGstin(sellerGstin);
  const buyerState = stateCodeFromGstin(buyerGstin);
  const explicit = placeOfSupply && STATE_CODES[String(placeOfSupply)] ? String(placeOfSupply) : null;

  const supplyState = explicit || buyerState || sellerState;

  // Without the seller's own state nothing can be compared, so stay with the
  // existing intra-state behaviour rather than inventing an IGST bill.
  const interState = !!(sellerState && supplyState && supplyState !== sellerState);

  return {
    sellerState,
    buyerState,
    placeOfSupply: supplyState,
    placeOfSupplyName: stateName(supplyState),
    interState,
    // Named so callers read intent rather than a boolean at the call site.
    taxKind: interState ? "igst" : "cgst_sgst",
  };
}

/**
 * Split a computed tax amount into the components that belong on the bill.
 * The total tax never changes — only how it is presented and reported.
 */
function splitTaxComponents(gstAmount, interState) {
  const total = Math.round((parseFloat(gstAmount) || 0) * 100) / 100;
  if (interState) return { igst: total, cgst: 0, sgst: 0 };
  const half = Math.round((total / 2) * 100) / 100;
  // Give any odd paisa to CGST so the two halves always add back to the total
  // exactly; silently losing a paisa makes a bill fail to reconcile.
  return { igst: 0, cgst: Math.round((total - half) * 100) / 100, sgst: half };
}

module.exports = { STATE_CODES, stateCodeFromGstin, stateName, resolveSupply, splitTaxComponents };
