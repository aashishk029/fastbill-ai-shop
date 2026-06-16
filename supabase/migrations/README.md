# Supabase Migrations

Migrations live here in Supabase CLI format (`<timestamp>_name.sql`), so that
GitHub→Supabase auto-migrations can be switched on later with no restructuring.

## Current way to apply (manual — free, fine for pilot)
1. Supabase Dashboard → SQL Editor → New query.
2. Paste the migration file contents → Run.
3. Order: oldest timestamp first.

## Files
| File | Status | What |
|------|--------|------|
| `20250501000000_add_hsn_columns.sql` | applied earlier | HSN columns |
| `20260616120000_pilot_production.sql` | **run for pilot** | S1 decimal quantities + inventory RPC + safe empty-shop dedupe |
| `20260616120100_phase2_s2_s3.sql` | later (before paid/multi-shop) | per-shop design codes + atomic invoice RPC |

## Auto-migrations (deferred — not worth it for 1 pilot)
Needs Supabase **paid plan** + Dashboard → Integrations → GitHub → connect repo.
Once connected, pushes to `main` run new migrations automatically.
Folder structure here is already compatible, so it's a one-time connect when the time comes.
