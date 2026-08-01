-- ============================================================
-- Customer credit limits
--
-- FastBill actively encourages udhari (one toggle on the bill) but never warned
-- when a customer was already over-extended — which is the single most common
-- way a small shop loses money. This adds a per-customer limit and the record
-- of when a shopkeeper knowingly went past it.
--
-- Deliberately NOT a foreign key on invoices. Invoices keep storing
-- customer_name as text exactly as before, so nothing on the billing write path
-- changes and no backfill is needed. Customers are matched by a normalised name
-- per shop — the same rule the bakaya grouping already uses.
-- ============================================================

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  -- Display name as the shopkeeper typed it.
  name TEXT NOT NULL,
  -- lower(trim(name)) — how the same customer is recognised across bills that
  -- were typed with different capitalisation or stray spaces.
  customer_key TEXT NOT NULL,

  phone TEXT,
  address TEXT,
  gstin TEXT,

  -- 0 or NULL means "no limit set" — never treat it as "limit of zero", which
  -- would warn on every single credit sale and train the shopkeeper to ignore
  -- warnings entirely.
  credit_limit NUMERIC(12,2),
  -- Expected days to pay. Informational for now; drives reminders later.
  credit_days INTEGER,
  -- Off by default: a warning a shopkeeper can override is far safer at the
  -- counter than a hard block on a wrongly configured limit.
  block_over_limit BOOLEAN DEFAULT false,

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (shop_id, customer_key)
);

CREATE INDEX IF NOT EXISTS idx_customers_shop ON customers(shop_id);

-- Same as every other table here: this app authenticates with its own phone+PIN
-- scheme rather than Supabase auth, so RLS-on would reject all anon-key writes.
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;

-- When a shopkeeper was warned and chose to sell on credit anyway. Worth
-- recording: it is the difference between a mistake and a decision, and it is
-- what makes "you overrode the limit 6 times for this customer" possible later.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS credit_limit_overridden BOOLEAN DEFAULT false;

SELECT count(*) AS customers_rows FROM customers;
