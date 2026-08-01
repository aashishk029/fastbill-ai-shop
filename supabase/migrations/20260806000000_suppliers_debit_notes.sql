-- ============================================================
-- Supplier master and purchase returns (debit notes)
--
-- The buy side has been far thinner than the sell side: a supplier was a
-- free-text name typed onto each purchase, and there was no way to send goods
-- back at all. Both matter.
--
-- Without a supplier record there is nobody to hold terms, a GSTIN or a
-- payment history against — so payables ageing cannot name a party properly and
-- ITC cannot be tied to a registered dealer.
--
-- Without a purchase return, goods sent back stayed on the shelf in the app AND
-- the input tax credit claimed on them was never reversed. Keeping credit on
-- goods that went back is claiming a refund for tax the shop never bore.
--
-- Like customers, suppliers are matched on a normalised name and carry no
-- foreign key onto purchases, so nothing on the existing purchase write path
-- changes and no backfill is needed.
-- ============================================================

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  -- lower(trim(name)) with runs of whitespace collapsed.
  supplier_key TEXT NOT NULL,

  phone TEXT,
  address TEXT,
  gstin TEXT,
  -- Days the supplier allows before payment is due. Drives payables ageing.
  credit_days INTEGER,
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (shop_id, supplier_key)
);

CREATE INDEX IF NOT EXISTS idx_suppliers_shop ON suppliers(shop_id);

CREATE TABLE IF NOT EXISTS debit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,

  debit_note_number TEXT NOT NULL,
  financial_year TEXT NOT NULL,
  sequence INTEGER NOT NULL,

  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT,

  supplier_name TEXT,
  supplier_gstin TEXT,
  supplier_invoice_no TEXT,
  original_purchase_date TIMESTAMPTZ,

  design_id UUID,
  return_quantity NUMERIC(12,3) NOT NULL,
  cost_per_unit NUMERIC(12,2),

  taxable_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  cgst_amount NUMERIC(12,2) DEFAULT 0,
  sgst_amount NUMERIC(12,2) DEFAULT 0,
  igst_amount NUMERIC(12,2) DEFAULT 0,
  total_debit NUMERIC(12,2) NOT NULL DEFAULT 0,

  is_inter_state BOOLEAN DEFAULT false,
  is_full_return BOOLEAN DEFAULT false,
  -- False when no credit was ever claimable on the original purchase (an
  -- unregistered supplier), so nothing is reversed and the shop's liability is
  -- not overstated.
  itc_reversed BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (shop_id, debit_note_number)
);

CREATE INDEX IF NOT EXISTS idx_debit_notes_shop ON debit_notes(shop_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_debit_notes_purchase ON debit_notes(purchase_id);

ALTER TABLE suppliers DISABLE ROW LEVEL SECURITY;
ALTER TABLE debit_notes DISABLE ROW LEVEL SECURITY;

SELECT count(*) AS suppliers_rows FROM suppliers;
