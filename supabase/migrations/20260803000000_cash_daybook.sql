-- ============================================================
-- Counter cash: day open, day close, and how the sale was paid
--
-- How a kirana shop actually ends its day — count the drawer, compare it with
-- what the day should have produced, and record the difference while the memory
-- is fresh. Its absence was conspicuous: FastBill could tell a shopkeeper their
-- sales but not whether the cash in the box matched them.
--
-- payment_mode on invoices is a prerequisite, not a bonus. Without knowing which
-- sales were cash and which were UPI, "expected cash in drawer" is a fabricated
-- number, and a fabricated number is worse than no feature.
-- ============================================================

-- How a paid bill was actually settled. NULL means "not recorded" — every
-- invoice written before this migration. Reported as unknown rather than
-- silently assumed to be cash, which would make every early day-close wrong.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_mode TEXT;   -- cash | upi | card | bank
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_mode TEXT;   -- cash | upi | bank

CREATE TABLE IF NOT EXISTS cash_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by UUID,                       -- shop_staff.id when a staff member opened it
  opening_cash NUMERIC(12,2) NOT NULL DEFAULT 0,

  closed_at TIMESTAMPTZ,
  closed_by UUID,
  counted_cash NUMERIC(12,2),           -- what was physically in the drawer
  expected_cash NUMERIC(12,2),          -- what the day's records say should be there
  difference NUMERIC(12,2),             -- counted - expected; negative is short

  -- The composition at close, kept so a past day can be explained without
  -- recomputing it from invoices that may since have been cancelled or returned.
  cash_sales NUMERIC(12,2),
  cash_collections NUMERIC(12,2),       -- old udhari collected in cash
  cash_expenses NUMERIC(12,2),
  cash_payouts NUMERIC(12,2),           -- suppliers paid in cash

  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_sessions_shop ON cash_sessions(shop_id, opened_at DESC);
-- At most one open session per shop. A second open drawer would make every
-- expected-cash figure ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_sessions_one_open
  ON cash_sessions(shop_id) WHERE closed_at IS NULL;

ALTER TABLE cash_sessions DISABLE ROW LEVEL SECURITY;

SELECT count(*) AS cash_sessions_rows FROM cash_sessions;
