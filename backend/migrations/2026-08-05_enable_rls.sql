-- Fix Supabase "Table publicly accessible" (RLS disabled) security alert.
--
-- SAFE PRECONDITION (verified 2026-08-05): no client — web frontend or mobile app —
-- talks to Supabase directly. Both go only through the backend API on Render. So the
-- backend is the ONLY database client. Once the backend authenticates with the
-- service_role key (which BYPASSES RLS), we can enable RLS everywhere and add NO
-- policies: anon/public is denied by default, the backend keeps full access.
--
-- ORDER OF OPERATIONS — do NOT run this until the backend is already using the
-- service_role key on Render and verified working, or every query breaks.
--
--   1. Supabase → Settings → API → copy the `service_role` secret.
--   2. Render → fastbill-ai-shop → Environment → set the backend's Supabase key
--      env to that service_role value → redeploy → confirm /api/health db:true
--      and app login works.
--   3. THEN run this file in the Supabase SQL editor.
--   4. Verify: app still works (service_role bypasses RLS) AND a raw REST call with
--      the anon key is now denied.

-- Enable RLS on every base table in the public schema. Adding no policy means the
-- default deny applies to anon/authenticated; service_role bypasses RLS entirely.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t.tablename);
    -- FORCE also applies RLS to the table owner, closing another bypass path.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t.tablename);
    RAISE NOTICE 'RLS enabled: %', t.tablename;
  END LOOP;
END $$;

-- Sanity list — every public table should now show rowsecurity = true.
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
