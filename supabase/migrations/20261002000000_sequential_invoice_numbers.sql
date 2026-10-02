-- ============================================================
-- Sequential invoice numbers (CGST Rule 46(b))
--
-- invoice_number was `INV-<millisecond timestamp>` — unique, but not the
-- "consecutive serial number" the rule requires, and uniqueness was scoped
-- GLOBALLY across every shop on this platform rather than per shop. GST
-- requires uniqueness per GSTIN (per shop here), not across unrelated
-- businesses sharing this app — and a global constraint also means two
-- shops could never both legitimately start their own series at 0001.
--
-- From here on, a new invoice is numbered INV/<FY>/<sequence>, sequential
-- within a shop's financial year — the same scheme credit_notes already
-- uses (20260805000000_credit_notes.sql). Existing invoice numbers are
-- left untouched: they were valid serials when issued, and rewriting
-- billing history is its own defect. Old rows simply have a NULL
-- financial_year/sequence, which the new numbering's COUNT query ignores,
-- so every shop's new series starts cleanly at 0001 from here.
-- ============================================================

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS financial_year TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sequence INTEGER;

-- Drop the old UNIQUE(invoice_number) constraint, whatever it happens to be
-- named — looked up by the column it covers rather than a hardcoded name,
-- since backend/database/schema.sql is documented as stale and may not
-- match what is actually live.
DO $$
DECLARE
  old_constraint TEXT;
BEGIN
  SELECT con.conname INTO old_constraint
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'invoices'
    AND con.contype = 'u'
    AND (
      SELECT array_agg(a.attname ORDER BY a.attname)
      FROM unnest(con.conkey) AS k(attnum)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    ) = ARRAY['invoice_number'];

  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE invoices DROP CONSTRAINT %I', old_constraint);
  END IF;
END $$;

-- Replacement: unique per shop, not globally. Wrapped so re-running this
-- file (e.g. pasted into the SQL editor twice by mistake) does not error.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_shop_invoice_number_key') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_shop_invoice_number_key UNIQUE (shop_id, invoice_number);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_shop_fy ON invoices(shop_id, financial_year);

SELECT count(*) AS invoices_rows FROM invoices;
