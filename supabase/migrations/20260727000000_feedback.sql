-- In-app feedback capture for the pilot. A shopkeeper taps "Send feedback" on the dashboard;
-- the message lands here with shop context (id/name/phone) so a reply is possible without
-- chasing WhatsApp threads. Read it from the Supabase table editor.
CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id) ON DELETE SET NULL,
  shop_name TEXT,
  phone TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  message TEXT NOT NULL,
  screen TEXT,
  app_version TEXT,
  platform TEXT,
  lang TEXT,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_shop ON feedback(shop_id);

-- Same as every other table here: the app authenticates with its own phone+PIN scheme,
-- not Supabase auth, so RLS-on would silently reject all anon-key writes.
ALTER TABLE feedback DISABLE ROW LEVEL SECURITY;
