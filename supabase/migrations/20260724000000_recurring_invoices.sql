-- Recurring invoices: shopkeeper sets up a template once (customer + items + frequency),
-- a scheduled job auto-generates a real invoice each time it comes due.
CREATE TABLE IF NOT EXISTS recurring_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_address TEXT,
  customer_gstin TEXT,
  items JSONB NOT NULL,
  show_gst BOOLEAN DEFAULT true,
  gst_mode TEXT DEFAULT 'included',
  discount_amount NUMERIC(12,2) DEFAULT 0,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  next_run_date DATE NOT NULL,
  active BOOLEAN DEFAULT true,
  last_generated_invoice_id UUID,
  last_generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurring_invoices_shop ON recurring_invoices(shop_id);
CREATE INDEX IF NOT EXISTS idx_recurring_invoices_due ON recurring_invoices(next_run_date) WHERE active = true;
