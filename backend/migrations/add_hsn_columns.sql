-- HSN Code Migration
-- Run this in Supabase SQL Editor

-- Add HSN code and default GST rate to designs table
ALTER TABLE designs
  ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(10),
  ADD COLUMN IF NOT EXISTS default_gst_rate DECIMAL(5,2) DEFAULT 18;

-- Add HSN code and GST rate to invoice_items table
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(10),
  ADD COLUMN IF NOT EXISTS gst_rate DECIMAL(5,2);

-- Update existing tile/marble products with HSN 6907 (Vitrified/Ceramic Tiles, 18% GST)
-- Only for tile_marble shops
UPDATE designs d
SET hsn_code = '6907', default_gst_rate = 18
WHERE d.hsn_code IS NULL
  AND EXISTS (
    SELECT 1 FROM tile_categories tc
    JOIN shops s ON s.id = (
      SELECT shop_id FROM inventory WHERE design_id = d.id LIMIT 1
    )
    WHERE tc.id = d.category_id
    AND s.shop_type = 'tile_marble'
  );
