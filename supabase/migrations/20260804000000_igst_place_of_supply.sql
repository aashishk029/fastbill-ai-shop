-- ============================================================
-- IGST and place of supply
--
-- Every bill this app has ever produced split tax as CGST+SGST, which is
-- correct only for a sale inside the seller's own state. A sale to a buyer in
-- another state attracts IGST at the full rate; a bill claiming CGST+SGST on
-- such a sale is wrong on its face — the buyer cannot take credit correctly and
-- the seller's GSTR-1 will not reconcile.
--
-- This is a legal defect being fixed, not a feature being added.
--
-- Existing rows are untouched and remain correct: they were intra-state sales
-- (the only kind this app could previously record), and igst_amount stays NULL
-- for them, which reads as "no IGST", not "unknown".
-- ============================================================

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(12,2);
-- Two-digit GST state code of the place of supply (e.g. '27' Maharashtra).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS place_of_supply TEXT;
-- Stored rather than derived so a past bill can always be explained, even if
-- the shop's own GSTIN changes later.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_inter_state BOOLEAN DEFAULT false;

-- The shop's own state. Normally inferred from the shop's GSTIN, but held
-- explicitly so an unregistered shop can still record where it operates.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS state_code TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_interstate ON invoices(shop_id, is_inter_state)
  WHERE is_inter_state = true;

SELECT count(*) AS interstate_invoices FROM invoices WHERE is_inter_state = true;
