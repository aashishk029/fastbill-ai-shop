-- Dashboard advertisement slot — content controlled from here (Supabase), no app rebuild needed
-- to change/rotate an ad. BAE can sell this space or promote its own other products through it.
CREATE TABLE IF NOT EXISTS ads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  subtitle TEXT,
  image_url TEXT,
  link_url TEXT,
  background_color TEXT DEFAULT '#1e3a5f',
  shop_type TEXT, -- NULL = shown to all shop types; set to target one sector only
  priority INTEGER DEFAULT 0, -- higher shows first when multiple ads are active
  active BOOLEAN DEFAULT true,
  starts_at TIMESTAMPTZ DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ads_active ON ads(active);
ALTER TABLE ads DISABLE ROW LEVEL SECURITY;
