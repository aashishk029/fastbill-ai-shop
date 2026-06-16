-- ============================================================
-- FastBill — PHASE 2 structural (S2 + S3)
-- Apply BEFORE paid/multi-shop launch. NOT needed for 1 free pilot.
-- These touch query code too — do with Claude in one focused session,
-- then run the full e2e test before deploying.
-- ============================================================

-- ------------------------------------------------------------
-- S2: Per-shop design codes (multi-shop scale)
-- Problem: designs.design_code is GLOBALLY UNIQUE and designs has no shop_id.
--          Shop B cannot reuse a code Shop A used.
-- Fix: denormalize shop_id onto designs, then make (shop_id, design_code) unique.
-- Requires matching CODE changes (designs/add, invoice fetch) — do together.
-- ------------------------------------------------------------
-- 1) Add column
ALTER TABLE designs ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id);
-- 2) Backfill from category → shop
UPDATE designs d
SET shop_id = tc.shop_id
FROM tile_categories tc
WHERE d.category_id = tc.id AND d.shop_id IS NULL;
-- 3) Drop the global unique, add per-shop unique
ALTER TABLE designs DROP CONSTRAINT IF EXISTS designs_design_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS designs_shop_code_uniq
  ON designs (shop_id, design_code);
-- CODE TODO (same session):
--   - designs/add: set shop_id on insert; dup-check within shop only
--   - invoices/generate ownership check can then use designs.shop_id directly

-- ------------------------------------------------------------
-- S3: Atomic invoice creation (reliability under load)
-- Problem: invoice insert + items insert + inventory decrement are 3 separate
--          calls with manual rollback in catch. A crash mid-way desyncs stock.
-- Fix: one Postgres function = one transaction. Endpoint calls it via .rpc().
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_invoice_atomic(
  p_invoice JSONB,      -- invoice row fields
  p_items   JSONB       -- array of {design_id, quantity_boxes, price_per_box, hsn_code, gst_rate}
) RETURNS UUID AS $$
DECLARE
  v_invoice_id UUID;
  v_item JSONB;
BEGIN
  INSERT INTO invoices (
    shop_id, invoice_number, customer_name, customer_phone, customer_address,
    customer_gstin, invoice_type, taxable_value, cgst_amount, sgst_amount,
    gst_rate, is_gst_invoice, payment_status, amount_paid, table_number, discount_amount
  )
  SELECT
    (p_invoice->>'shop_id')::uuid, p_invoice->>'invoice_number', p_invoice->>'customer_name',
    p_invoice->>'customer_phone', p_invoice->>'customer_address', p_invoice->>'customer_gstin',
    p_invoice->>'invoice_type', (p_invoice->>'taxable_value')::numeric,
    (p_invoice->>'cgst_amount')::numeric, (p_invoice->>'sgst_amount')::numeric,
    (p_invoice->>'gst_rate')::numeric, (p_invoice->>'is_gst_invoice')::boolean,
    p_invoice->>'payment_status', (p_invoice->>'amount_paid')::numeric,
    p_invoice->>'table_number', (p_invoice->>'discount_amount')::numeric
  RETURNING id INTO v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO invoice_items (invoice_id, design_id, quantity_boxes, price_per_box, hsn_code, gst_rate)
    VALUES (
      v_invoice_id, (v_item->>'design_id')::uuid, (v_item->>'quantity_boxes')::numeric,
      (v_item->>'price_per_box')::numeric, v_item->>'hsn_code', (v_item->>'gst_rate')::numeric
    );
    UPDATE inventory
      SET quantity_boxes = quantity_boxes - (v_item->>'quantity_boxes')::numeric, updated_at = NOW()
      WHERE shop_id = (p_invoice->>'shop_id')::uuid
        AND design_id = (v_item->>'design_id')::uuid;
  END LOOP;

  RETURN v_invoice_id;
END;
$$ LANGUAGE plpgsql;
-- CODE TODO (same session): replace the 3-step block in invoices/generate with
--   const { data } = await supabase.rpc('create_invoice_atomic', { p_invoice, p_items });
-- Keep the stock pre-check (C1) before calling.
-- ============================================================
