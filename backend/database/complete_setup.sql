-- ============================================
-- FASTBAHI COMPLETE DATABASE SETUP
-- Paste this in Supabase SQL Editor and Run
-- ============================================

-- SHOPS
CREATE TABLE IF NOT EXISTS shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  owner_name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  address TEXT NOT NULL,
  shop_type VARCHAR(50) NOT NULL,
  low_stock_threshold INTEGER DEFAULT 30,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- TILE CATEGORIES
CREATE TABLE IF NOT EXISTS tile_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  category_name VARCHAR(100) NOT NULL,
  size_mm VARCHAR(20) NOT NULL,
  coverage_sqft DECIMAL(5,2) NOT NULL,
  base_price_per_box DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- DESIGNS
CREATE TABLE IF NOT EXISTS designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES tile_categories(id),
  design_code VARCHAR(50) UNIQUE NOT NULL,
  design_name VARCHAR(100) NOT NULL,
  color VARCHAR(50),
  image_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- INVENTORY
CREATE TABLE IF NOT EXISTS inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id UUID REFERENCES designs(id),
  shop_id UUID REFERENCES shops(id),
  quantity_boxes INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER DEFAULT 30,
  is_low_stock BOOLEAN GENERATED ALWAYS AS (quantity_boxes < low_stock_threshold) STORED,
  last_restocked_at TIMESTAMP,
  reorder_quantity INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- INVOICES
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  invoice_number VARCHAR(50) UNIQUE NOT NULL,
  customer_name VARCHAR(255),
  customer_phone VARCHAR(20),
  total_sqft DECIMAL(10,2),
  total_boxes INTEGER,
  total_amount DECIMAL(12,2),
  payment_method VARCHAR(50),
  invoice_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- INVOICE ITEMS
CREATE TABLE IF NOT EXISTS invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES invoices(id),
  design_id UUID REFERENCES designs(id),
  quantity_boxes INTEGER NOT NULL,
  sqft_coverage DECIMAL(10,2),
  price_per_box DECIMAL(10,2),
  total_price DECIMAL(12,2),
  created_at TIMESTAMP DEFAULT NOW()
);

-- PURCHASES (stock reorder history)
CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  design_id UUID REFERENCES designs(id),
  quantity_boxes INTEGER NOT NULL,
  supplier_name VARCHAR(255) DEFAULT 'Direct Purchase',
  cost_per_box DECIMAL(10,2) DEFAULT 0,
  purchase_date TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ALERTS
CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  alert_type VARCHAR(50),
  design_id UUID REFERENCES designs(id),
  message TEXT NOT NULL,
  severity VARCHAR(20),
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_inventory_shop ON inventory(shop_id);
CREATE INDEX IF NOT EXISTS idx_inventory_design ON inventory(design_id);
CREATE INDEX IF NOT EXISTS idx_inventory_low_stock ON inventory(is_low_stock);
CREATE INDEX IF NOT EXISTS idx_alerts_shop ON alerts(shop_id);
CREATE INDEX IF NOT EXISTS idx_invoices_shop ON invoices(shop_id);
CREATE INDEX IF NOT EXISTS idx_purchases_shop ON purchases(shop_id);

-- RPC FUNCTION: increment inventory on purchase
CREATE OR REPLACE FUNCTION increment_inventory(p_design_id UUID, p_quantity INTEGER)
RETURNS void AS $$
BEGIN
  UPDATE inventory
  SET quantity_boxes = quantity_boxes + p_quantity,
      updated_at = NOW()
  WHERE inventory.design_id = increment_inventory.p_design_id;
END;
$$ LANGUAGE plpgsql;

-- RPC FUNCTION: deduct inventory on invoice
CREATE OR REPLACE FUNCTION update_inventory_after_invoice(design_id UUID, quantity INTEGER)
RETURNS void AS $$
BEGIN
  UPDATE inventory
  SET quantity_boxes = quantity_boxes - quantity,
      updated_at = NOW()
  WHERE inventory.design_id = update_inventory_after_invoice.design_id;
END;
$$ LANGUAGE plpgsql;
