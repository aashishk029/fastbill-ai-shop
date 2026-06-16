-- ============================================================
-- FastBill — Pilot Production Migration (2026-06-16)
-- Run this ONCE in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe + reversible-friendly. Read each section's comment before running.
-- ============================================================

-- ------------------------------------------------------------
-- S1: Decimal quantities (tile=sqft, jewellery=grams, kirana=kg/litre)
-- Problem: quantity_boxes was INTEGER → fractional quantities truncated
--          → wrong stock counts and wrong bill amounts.
-- Fix: widen to NUMERIC(12,3) in all 3 tables + the inventory RPC.
-- ------------------------------------------------------------
-- inventory.quantity_boxes is referenced by GENERATED column is_low_stock,
-- so drop it first, alter the type, then re-create it.
ALTER TABLE inventory DROP COLUMN is_low_stock;
ALTER TABLE inventory ALTER COLUMN quantity_boxes TYPE NUMERIC(12,3);
ALTER TABLE inventory ADD COLUMN is_low_stock BOOLEAN
  GENERATED ALWAYS AS (quantity_boxes < low_stock_threshold) STORED;

ALTER TABLE invoice_items  ALTER COLUMN quantity_boxes TYPE NUMERIC(12,3);
ALTER TABLE purchases      ALTER COLUMN quantity_boxes TYPE NUMERIC(12,3);

-- RPC used by invoice generation — quantity param must also accept decimals.
CREATE OR REPLACE FUNCTION update_inventory_after_invoice(design_id UUID, quantity NUMERIC)
RETURNS void AS $$
BEGIN
  UPDATE inventory
  SET quantity_boxes = quantity_boxes - quantity,
      updated_at = NOW()
  WHERE inventory.design_id = update_inventory_after_invoice.design_id;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- D1: Remove duplicate/empty test shops for the pilot phone.
-- STEP 1 — INSPECT FIRST (run this SELECT alone, look at the result):
--   SELECT s.id, s.name, s.created_at,
--     (SELECT count(*) FROM invoices  i   WHERE i.shop_id  = s.id) AS invoices,
--     (SELECT count(*) FROM inventory inv WHERE inv.shop_id = s.id) AS inventory_rows
--   FROM shops s WHERE s.phone = '6202146538' ORDER BY s.created_at;
--
-- STEP 2 — DELETE ONLY EMPTY DUPLICATES (0 invoices AND 0 inventory).
-- This can NEVER delete a shop that has real data. Safe to run.
DELETE FROM shops s
WHERE s.phone = '6202146538'
  AND NOT EXISTS (SELECT 1 FROM invoices  i   WHERE i.shop_id  = s.id)
  AND NOT EXISTS (SELECT 1 FROM inventory inv WHERE inv.shop_id = s.id);

-- ------------------------------------------------------------
-- VERIFY after running:
--   SELECT id, name, phone, pin_hash IS NOT NULL AS has_pin
--   FROM shops WHERE phone = '6202146538';
-- Expect: fewer rows, and after next app login each remaining shop has_pin = true.
-- ============================================================
