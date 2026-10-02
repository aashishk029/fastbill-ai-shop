"use strict";

/**
 * Sequential invoice numbers (CGST Rule 46(b)).
 *
 * invoice_number used to be `INV-${Date.now()}` — unique, but not the
 * "consecutive serial number" the rule requires, and not scoped to a
 * financial year. Mirrors credit_notes' own numbering (creditNote.js):
 * INV/<FY>/<sequence>, sequential within a shop's financial year, at most
 * 16 characters (rule's own limit; "INV/26-27/00001" is 15).
 */

const { financialYear } = require("./creditNote");

function invoiceNumber({ sequence, date = new Date() }) {
  const fy = financialYear(date);
  return `INV/${fy}/${String(sequence).padStart(5, "0")}`;
}

module.exports = { invoiceNumber };
