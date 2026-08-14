"use strict";

/**
 * Delivery pincode → state, for deciding place of supply on a shipped order.
 *
 * Why this exists. gstPlace.js is right that for a counter sale to an unregistered buyer
 * the place of supply is the shop's own state — the goods are handed over there. An online
 * order is not a counter sale. Under CGST Act s.10(1)(a), where a supply involves movement
 * of goods the place of supply is where that movement terminates: the delivery address. So
 * a parcel sent from Bihar to Karnataka is inter-state and attracts IGST, and billing it
 * CGST+SGST is wrong on the face of the invoice — the total collected is right, but the
 * heads are wrong, the buyer cannot take credit correctly, and GSTR-1 does not reconcile.
 *
 * How the mapping works, and where it refuses to guess. India's postal circles line up
 * with states at two digits for most of the country, but several ranges straddle a state
 * boundary — Uttarakhand inside Uttar Pradesh's range, Telangana inside Andhra Pradesh's,
 * Chhattisgarh inside Madhya Pradesh's. Those are resolved at three digits.
 *
 * Anything this table cannot place with confidence returns null rather than a best guess.
 * A wrong state produces a confidently wrong tax split on a legal document, which is worse
 * than the honest fallback: the caller keeps the existing behaviour and can flag the
 * invoice for a human. Being unsure is recoverable; being wrong and certain is not.
 */

// Two-digit prefix → [state name, GST state code]. Only unambiguous ranges live here.
const TWO = {
  "11": ["Delhi", "07"],
  "12": ["Haryana", "06"], "13": ["Haryana", "06"],
  "14": ["Punjab", "03"], "15": ["Punjab", "03"], "16": ["Punjab", "03"],
  "17": ["Himachal Pradesh", "02"],
  "18": ["Jammu and Kashmir", "01"], "19": ["Jammu and Kashmir", "01"],
  "30": ["Rajasthan", "08"], "31": ["Rajasthan", "08"], "32": ["Rajasthan", "08"],
  "33": ["Rajasthan", "08"], "34": ["Rajasthan", "08"],
  "36": ["Gujarat", "24"], "37": ["Gujarat", "24"], "38": ["Gujarat", "24"], "39": ["Gujarat", "24"],
  "40": ["Maharashtra", "27"], "41": ["Maharashtra", "27"], "42": ["Maharashtra", "27"],
  "43": ["Maharashtra", "27"], "44": ["Maharashtra", "27"],
  "45": ["Madhya Pradesh", "23"], "46": ["Madhya Pradesh", "23"], "47": ["Madhya Pradesh", "23"],
  "50": ["Telangana", "36"],
  "56": ["Karnataka", "29"], "57": ["Karnataka", "29"], "58": ["Karnataka", "29"], "59": ["Karnataka", "29"],
  "60": ["Tamil Nadu", "33"], "61": ["Tamil Nadu", "33"], "62": ["Tamil Nadu", "33"],
  "63": ["Tamil Nadu", "33"], "64": ["Tamil Nadu", "33"],
  "67": ["Kerala", "32"], "68": ["Kerala", "32"], "69": ["Kerala", "32"],
  "70": ["West Bengal", "19"], "71": ["West Bengal", "19"], "72": ["West Bengal", "19"],
  "73": ["West Bengal", "19"], "74": ["West Bengal", "19"],
  "75": ["Odisha", "21"], "76": ["Odisha", "21"], "77": ["Odisha", "21"],
  "78": ["Assam", "18"],
  "80": ["Bihar", "10"], "81": ["Bihar", "10"], "82": ["Bihar", "10"],
  "83": ["Jharkhand", "20"], "84": ["Bihar", "10"], "85": ["Bihar", "10"],
  "90": ["Army Post Office", null], "91": ["Army Post Office", null],
  "92": ["Army Post Office", null], "93": ["Army Post Office", null],
};

// Three-digit prefix → [state, code]. These win over the two-digit table and exist only
// where a two-digit range crosses a state line.
const THREE = {
  // Uttarakhand sits inside Uttar Pradesh's 20–28 range.
  "244": ["Uttarakhand", "05"], "246": ["Uttarakhand", "05"], "247": ["Uttarakhand", "05"],
  "248": ["Uttarakhand", "05"], "249": ["Uttarakhand", "05"],
  "262": ["Uttarakhand", "05"], "263": ["Uttarakhand", "05"],
  // Chhattisgarh sits inside Madhya Pradesh's 45–48 range.
  "490": ["Chhattisgarh", "22"], "491": ["Chhattisgarh", "22"], "492": ["Chhattisgarh", "22"],
  "493": ["Chhattisgarh", "22"], "494": ["Chhattisgarh", "22"], "495": ["Chhattisgarh", "22"],
  "496": ["Chhattisgarh", "22"], "497": ["Chhattisgarh", "22"],
  // Goa has its own short range inside Maharashtra's.
  "403": ["Goa", "30"],
  // The north-east shares the 79x block.
  "790": ["Arunachal Pradesh", "12"], "791": ["Arunachal Pradesh", "12"], "792": ["Arunachal Pradesh", "12"],
  "793": ["Meghalaya", "17"], "794": ["Meghalaya", "17"],
  "795": ["Manipur", "14"],
  "796": ["Mizoram", "15"],
  "797": ["Nagaland", "13"], "798": ["Nagaland", "13"],
  "799": ["Tripura", "16"],
  "737": ["Sikkim", "11"],
  // Puducherry is scattered inside Tamil Nadu and Kerala.
  "605": ["Puducherry", "34"], "607": ["Puducherry", "34"], "673": ["Puducherry", "34"],
  // Chandigarh inside Punjab's range.
  "160": ["Chandigarh", "04"],
};

// Ranges that genuinely straddle a boundary at both two and three digits, where the honest
// answer is "not sure". Andhra Pradesh and Telangana were one state until 2014 and their
// 51–53 pincodes interleave; Uttar Pradesh's remaining 20–28 blocks likewise. Returning
// null here is the point: see the note at the top of the file.
const AMBIGUOUS_TWO = new Set(["51", "52", "53"]);

function stateFromPincode(pincode) {
  const pin = String(pincode || "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(pin)) return null;

  const three = THREE[pin.slice(0, 3)];
  if (three) return { state: three[0], stateCode: three[1] };

  const two = pin.slice(0, 2);
  if (AMBIGUOUS_TWO.has(two)) return null;

  // Uttar Pradesh occupies 20–28 apart from the Uttarakhand blocks already handled above.
  if (["20", "21", "22", "23", "24", "25", "26", "27", "28"].includes(two)) {
    return { state: "Uttar Pradesh", stateCode: "09" };
  }

  const hit = TWO[two];
  if (!hit || !hit[1]) return null;   // unknown, or a field post office with no GST state
  return { state: hit[0], stateCode: hit[1] };
}

module.exports = { stateFromPincode };
