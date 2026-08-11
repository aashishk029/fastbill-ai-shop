-- ============================================================
-- FastBahi — Expiry / batch tracking (2026-06-23)
-- Adds an optional expiry date to stock rows so grocery/pharmacy
-- shops get near-expiry + expired alerts (top documented kirana loss).
-- Safe + additive. Run once in Supabase SQL Editor.
-- ============================================================
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS expiry_date DATE;
CREATE INDEX IF NOT EXISTS idx_inventory_expiry ON inventory(expiry_date) WHERE expiry_date IS NOT NULL;
