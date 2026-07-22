-- Per-purchase transportation/misc cost + profit margin, so a shopkeeper never has
-- to separately go set a selling price after restocking — it's computed and blended
-- into tile_categories.base_price_per_box automatically by the backend.
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS extra_cost NUMERIC(12,2) DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS margin_percent NUMERIC(6,2);
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS margin_amount NUMERIC(12,2);
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS suggested_price NUMERIC(12,2);
