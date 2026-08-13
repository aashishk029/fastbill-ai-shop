-- Online orders as their own record, separate from the invoice they produce.
--
-- Until now a paid website order became an invoice and nothing else. An invoice is an
-- accounting record: what was sold, for how much, what tax applied. It has no idea where
-- the goods go or whether they have gone. So the shop could bill an online order and then
-- had nowhere to answer "which orders still need packing", "what is the courier tracking
-- number", "has this been delivered" — the delivery address was not even stored.
--
-- Keeping the two apart rather than bolting columns onto invoices matters because they have
-- different lifetimes and different truths. An invoice is fixed once raised; an order moves
-- through states for days afterwards. A cancelled order still leaves its invoice and credit
-- note behind. One order maps to one invoice, and that link is all they need to share.

CREATE TABLE IF NOT EXISTS online_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  -- The payment id from the gateway. Also the idempotency key: a retried webhook or a
  -- refreshed success page must not create a second order.
  external_ref VARCHAR(120) NOT NULL,
  source VARCHAR(30) DEFAULT 'web',
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,

  -- paid → packed → shipped → delivered, with cancelled reachable from any of them.
  status VARCHAR(20) NOT NULL DEFAULT 'paid',

  -- Where it goes. Kept as discrete columns, not one blob: a courier API wants pincode and
  -- state as separate fields, and pincode is what decides serviceability and rate.
  customer_name VARCHAR(120),
  customer_phone VARCHAR(20),
  customer_email VARCHAR(160),
  address_line TEXT,
  city VARCHAR(80),
  state VARCHAR(80),
  pincode VARCHAR(10),
  country VARCHAR(60) DEFAULT 'India',

  amount NUMERIC(12,2),
  -- What was ordered, as it was at the time. The invoice holds the accounting truth; this
  -- is so a packing slip can be printed years later even if a product was renamed.
  items JSONB,

  -- Filled once a courier is booked. courier_provider names which adapter did it, so a
  -- shop that changes courier keeps its old shipments readable.
  courier_provider VARCHAR(40),
  shipment_ref VARCHAR(120),
  awb VARCHAR(60),
  label_url TEXT,
  tracking_url TEXT,

  packed_at TIMESTAMPTZ,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- One order per payment per shop. This is what makes the webhook safe to retry.
CREATE UNIQUE INDEX IF NOT EXISTS online_orders_shop_ref_idx
  ON online_orders (shop_id, external_ref);

-- The list a shopkeeper opens every morning: this shop's orders, newest first, usually
-- filtered to the ones still needing work.
CREATE INDEX IF NOT EXISTS online_orders_shop_status_idx
  ON online_orders (shop_id, status, created_at DESC);

-- Match the rest of the schema: RLS on, no policies. Every query arrives through the
-- backend as service_role, which bypasses RLS; this closes the table to direct REST access.
ALTER TABLE online_orders ENABLE ROW LEVEL SECURITY;
