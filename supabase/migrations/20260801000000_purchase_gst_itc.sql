-- ============================================================
-- Purchase GST capture → real Input Tax Credit (ITC)
--
-- Until now `itcAvailable` in /api/tax/summary was hardcoded to 0, because GST
-- paid on purchases was never recorded anywhere. That made the GST section only
-- half an answer: a registered shop's real question is "how much GST do I pay
-- this month", which is output tax MINUS input credit.
--
-- Additive and idempotent. Existing purchase rows keep working — they simply
-- have no GST recorded, which is the truthful representation of what was known
-- about them.
-- ============================================================

-- What the shopkeeper paid, split into its taxable and tax parts.
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2);
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(12,2);
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(12,2);
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS gst_mode TEXT;  -- 'included' | 'exclusive' | 'none'

-- Proof the credit is claimable: a tax invoice from a GST-registered supplier.
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_gstin TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_invoice_no TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_invoice_date DATE;

-- Set by the backend, never trusted from the client: true only when the shop is
-- GST-registered AND the supplier's GSTIN is present AND a GST rate was entered.
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS itc_eligible BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_purchases_itc ON purchases(shop_id, itc_eligible)
  WHERE itc_eligible = true;

-- ------------------------------------------------------------
-- Latent cross-shop bug in the stock-decrement RPC.
--
-- The function filtered only on design_id. Today every shop inserts its own
-- `designs` row, so no two shops share a design_id and the bug is dormant — but
-- any future path that lets two shops reference one design (SKU sharing, a
-- catalog import, marketplace sync) would make a sale in one shop silently
-- decrement another shop's stock.
--
-- p_shop_id is optional so the existing 2-argument call keeps working while the
-- backend is redeployed; the backend now always passes it.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_inventory_after_invoice(
  design_id UUID,
  quantity NUMERIC,
  p_shop_id UUID DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  UPDATE inventory
  SET quantity_boxes = quantity_boxes - quantity,
      updated_at = NOW()
  WHERE inventory.design_id = update_inventory_after_invoice.design_id
    AND (p_shop_id IS NULL OR inventory.shop_id = p_shop_id);
END;
$$ LANGUAGE plpgsql;

-- Verify (both should run without error):
SELECT count(*) AS purchases_with_gst FROM purchases WHERE gst_amount IS NOT NULL;
