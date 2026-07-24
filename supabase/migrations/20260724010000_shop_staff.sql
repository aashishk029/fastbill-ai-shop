-- Staff / multi-user login: a shop owner can add limited-permission staff accounts under
-- their own shop, logging in with their own phone+PIN but operating on the owner's shopId.
CREATE TABLE IF NOT EXISTS shop_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  can_edit_price BOOLEAN DEFAULT false,
  can_delete BOOLEAN DEFAULT false,
  can_manage_staff BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(phone)
);

CREATE INDEX IF NOT EXISTS idx_shop_staff_shop ON shop_staff(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_staff_phone ON shop_staff(phone);

-- Every other table in this project has RLS disabled (the app authenticates via its own
-- phone+PIN scheme, not Supabase auth) — new tables default to RLS-on and silently reject
-- all writes from the anon key otherwise.
ALTER TABLE shop_staff DISABLE ROW LEVEL SECURITY;
