-- Bank reconciliation (CSV-import based — no live bank API/credentials available).
-- Shopkeeper exports a statement from their bank's app/site as CSV and imports it here;
-- the app suggests matches against invoices/purchases by amount within a date window.
CREATE TABLE IF NOT EXISTS bank_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  txn_date DATE NOT NULL,
  description TEXT,
  amount NUMERIC(12,2) NOT NULL,
  txn_type TEXT NOT NULL CHECK (txn_type IN ('credit','debit')),
  matched_invoice_id UUID,
  matched_purchase_id UUID,
  reconciled BOOLEAN DEFAULT false,
  imported_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_txn_shop ON bank_transactions(shop_id);
CREATE INDEX IF NOT EXISTS idx_bank_txn_reconciled ON bank_transactions(shop_id, reconciled);
ALTER TABLE bank_transactions DISABLE ROW LEVEL SECURITY;
