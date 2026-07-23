-- Persist the last cost/transport/margin breakdown a shopkeeper actually set for a product,
-- on the inventory row itself — so reopening the "Set Selling Price" editor shows what was last
-- saved (not the historical purchase cost, which made it look like edits were reverting).
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS last_cost_price NUMERIC(12,2);
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS last_extra_cost NUMERIC(12,2);
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS last_margin_percent NUMERIC(6,2);
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS last_margin_amount NUMERIC(12,2);
