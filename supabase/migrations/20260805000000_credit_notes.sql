-- ============================================================
-- Credit notes for sales returns (CGST Act s.34)
--
-- Until now a return edited the original invoice: item quantities were reduced
-- and the stored taxable value, CGST and SGST were scaled down. That is not
-- permitted. An issued tax invoice is a document the customer holds and may
-- have claimed input credit against; it cannot be quietly altered, and doing so
-- destroys any record of what was actually sold.
--
-- The lawful instrument is a separate credit note referencing the original
-- invoice, carrying its own serial number, stating the tax being credited, and
-- reported in GSTR-1 table 9B where it reduces output tax.
--
-- Existing invoices already scaled by the old behaviour are left alone. They
-- cannot be reconstructed, and rewriting history would be its own error; from
-- here on, invoices stay intact and returns produce credit notes.
-- ============================================================

CREATE TABLE IF NOT EXISTS credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,

  -- CN/26-27/0001 — restarts each financial year, sequential within a shop.
  credit_note_number TEXT NOT NULL,
  financial_year TEXT NOT NULL,
  sequence INTEGER NOT NULL,

  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT,

  -- Snapshot of the customer as billed, so the note stands on its own.
  customer_name TEXT,
  customer_phone TEXT,
  customer_gstin TEXT,
  original_invoice_number TEXT,
  original_invoice_date TIMESTAMPTZ,

  taxable_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  cgst_amount NUMERIC(12,2) DEFAULT 0,
  sgst_amount NUMERIC(12,2) DEFAULT 0,
  igst_amount NUMERIC(12,2) DEFAULT 0,
  total_credit NUMERIC(12,2) NOT NULL DEFAULT 0,

  is_inter_state BOOLEAN DEFAULT false,
  place_of_supply TEXT,
  is_full_return BOOLEAN DEFAULT false,

  -- Per-line detail as JSON: quantities, the rate each line was SOLD at, and the
  -- share of discount credited. Kept on the note so the document can be
  -- reprinted years later even if the product or its rate has changed.
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Whether the tax could still be adjusted under s.34(2) when this was issued
  -- (30 November following the financial year of supply). Recorded rather than
  -- recomputed, because the answer depends on when the note was raised.
  gst_adjustable BOOLEAN DEFAULT true,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Two notes must never share a number within a shop's year. A race on the
  -- sequence therefore fails loudly and is retried, rather than producing
  -- duplicate serial numbers on statutory documents.
  UNIQUE (shop_id, credit_note_number)
);

CREATE INDEX IF NOT EXISTS idx_credit_notes_shop ON credit_notes(shop_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes(invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_fy ON credit_notes(shop_id, financial_year);

ALTER TABLE credit_notes DISABLE ROW LEVEL SECURITY;

SELECT count(*) AS credit_notes_rows FROM credit_notes;
