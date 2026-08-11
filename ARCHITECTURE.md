# FastBahi — System Architecture (Mainframe Reference)

> **See `AI_HANDOFF.md` first — it is newer (verified 2026-07-29) and covers the
> July 2026 features (staff/multi-user, recurring invoices, ad slot, bank
> reconciliation, e-way prep, in-app feedback) that this file predates.**
> This file remains the deeper narrative reference for the pre-July system.
>
> Last full audit: 2026-06-18. Keep this file updated whenever you build/modify.

FastBahi = bilingual, GST-compliant billing + shop-management app for Indian
MSME shopkeepers (tiles / kirana / electronics / jewellery / restaurant).
Owner: Bharat Ananta Energy (BAE). Stack is intentionally cheap (all free tiers)
until revenue.

---

## 1. Repositories & hosting

| Piece | Repo | Hosting | Live URL |
|-------|------|---------|----------|
| Backend (Express + Supabase) | `github.com/aashishk029/fastbill-ai-shop` | Render (free, auto-deploy on push to `main`) | `https://fastbill-ai-shop.onrender.com/api` |
| Mobile (React Native + Expo) | `github.com/aashishk029/fastbill-mobile` | EAS builds → APK/AAB | (installed app) |
| Web build | same mobile repo (`expo export --platform web`) | Vercel (`deploy-web.sh`) | Vercel dist URL |

**Deploy pipeline (backend):** `git push origin main` → Render runs `npm install`
→ `node backend/server.js`. No CI gate; verify locally (`node --check`) before push.

**Deploy pipeline (mobile):** `eas build -p android --profile preview` (APK, testing)
or `--profile production` (AAB, Play Store). `versionCode` in `app.json` must bump per build.

---

## 2. Environment variables (Render dashboard — `sync:false` secrets)

| Var | Used for | Notes |
|-----|----------|-------|
| `SUPABASE_URL` | DB connection | real project: `dbyojztmtaexbiaepnif.supabase.co` |
| `SUPABASE_KEY` *or* `SUPABASE_ANON_KEY` | DB auth | code accepts either (render.yaml sets `SUPABASE_KEY`) |
| `GEMINI_API_KEY` | **all AI** (vision + BAE) | gemini-2.5-flash, free tier. The only live AI key. |
| `ALLOWED_ORIGINS` | CORS lock (optional) | comma-list; falls back to `*` if unset |
| `PORT` | server port | Render sets 10000 |
| `HF_TOKEN` | dead (BLIP removed) | unused, safe to drop |

**Anthropic SDK fully removed** — was broken on Render (`messages.create` undefined).
All AI is Gemini via raw `fetch`. Do not re-add the Anthropic SDK without testing on Render.

---

## 3. Backend — 40 endpoints (`backend/server.js`, ~2300 lines, single file)

**Auth/shop:** `POST /shops/init`, `POST /shops/login` (phone + bcrypt PIN),
`GET/PATCH /shops/:shopId` (pin_hash stripped from responses).

**Inventory:** `GET /inventory/status/:shopId`, `PATCH /inventory/adjust`,
`POST /designs/add`, photo: `POST /products/identify-photo`,
`/inventory/photo-identify`, `/inventory/scan-purchase`, `/inventory/confirm-scan`.

**Invoices:** `POST /invoices/generate` (B2B/B2C, GST incl/excl, credit/paid),
`/invoices/jewellery`, `GET /invoices/history/:shopId`, `DELETE /invoices/:id`,
`POST /invoices/:id/return`, `PATCH /invoices/:id/payment`, `GET /invoices/last-rate`.

**Purchases:** `POST /purchases/add`, `PATCH /purchases/:id/payment`, latest-rate lookups.

**Money/credit:** `GET /bakaya/:shopId` (customer + supplier dues),
`GET /reminders/overdue/:shopId` (7/15/30-day buckets), `POST /reminders/mark-sent`,
`GET /credit-score/:shopId`, `GET /tax/summary/:shopId` (GSTR-1 + ITR/P&L 44AD),
expenses CRUD, `GET /analytics/projections/:shopId`, payment-events.

**AI (BAE):**
- `POST /bae/query` — ad-hoc NL question over live shop data (RAG-lite).
- `GET /bae/briefing/:shopId` — **proactive daily intelligence.** Deterministic
  aggregates (today sales, week-over-week trend, outstanding + top overdue by age,
  low stock) computed in JS; Gemini only *narrates* into a 3-point Hinglish action
  list. **LLM never computes money numbers.** Falls back to deterministic text if
  Gemini unavailable (zero-cost, never blank).

**Infra:** `GET /health` — runs a cheap `count` query so periodic pings keep
Render + Supabase warm (see §7).

### Security model (server-side)
Client sends `shopId` as identity (no JWT yet). Ownership is enforced per-route:
mutations require `shopId` and filter/verify `shop_id` ownership (403 on mismatch).
Rate limiting via `express-rate-limit` (`authLimiter` on login). PIN bcrypt-hashed;
null-hash legacy shops self-enroll PIN on first login. **Gap (backlog S4):** RLS
disabled in Supabase + anon key in client bundle — fine for pilot, fix before scale.

---

## 4. Database (Supabase Postgres, RLS disabled)

Key tables: `shops`, `designs` (no shop_id — linked via `tile_categories`),
`tile_categories`, `inventory` (`quantity_boxes NUMERIC(12,3)`, `is_low_stock`
GENERATED), `invoices` (payment_status: paid/credit/partial/cancelled/returned),
`invoice_items`, `purchases`, `expenses`. Full column list: `backend/database/schema.sql`.

**Migrations:** `supabase/migrations/` in Supabase-CLI format. Apply manually in
SQL Editor (oldest timestamp first). `20260616120000_pilot_production.sql` = S1
decimals + RPC + safe empty-shop dedupe (run for pilot). `..._phase2_s2_s3.sql` =
per-shop design codes (S2) + atomic invoice RPC (S3), defer to before paid/multi-shop.

---

## 5. Mobile app (Expo SDK 54, RN 0.81, new architecture ON)

- Package: `com.aashishk029.fastbill`. EAS projectId `2b7d679e-...`. OTA via expo-updates.
- API base: `src/utils/api.js` → onrender URL, 90s timeout (cold-start margin; keep-warm reduces need).
- Screens: `src/screens/*` — Dashboard, Invoice, Stock, Tax, Customers, Credit,
  Alerts, Expenses, Jewellery, Setup (login/register), LanguagePicker, Analytics.
- Nav: bottom-tabs (`@react-navigation`). Multi-shop login picker handled in SetupScreen.

### Design system (`src/theme/PrestigeTheme.js` + components)
"Prestige" = deep slate `#0F172A`, brand navy `#1E3A5F`, matte gold `#C5A021`.
Tokens: `radius` ladder, layered `shadows` (soft/card/prestige), semantic color tints.
Reusable: `PrestigeButton` (variants + press feedback), `PrestigeCard`, `PrestigeInput`.
**Rule:** new UI should consume these tokens/components, not hardcode colors/radii.

### i18n (`src/i18n/`)
`strings.js` = key → per-language map. `LanguageContext.js` exposes `useLanguage()` + `t('key')`.
`t()` **falls back to English** for any missing key — so partial language coverage never breaks UI.
**10 languages:** English + Hindi (full, 258 keys) and Tamil, Telugu, Kannada, Malayalam,
Gujarati, Marathi, Bengali, Punjabi (core ~123 keys — high-frequency screens; dense GST/tax
jargon falls back to English, which is how those technical terms are used in practice).
Picker (`LanguagePickerScreen.js`) is data-driven from a `LANGUAGES` array (native endonyms).
**To extend a language:** add the missing keys to its block in `strings.js` — no other change.
Regional translations are best-effort and should be spot-checked by a native speaker before scale.

---

## 6. AI / Intelligence layer

All AI = **Gemini 2.5 Flash** (free tier) via `fetch`. Two patterns:
1. **Vision** (`geminiVision()`): product photo ID, bill OCR (Tesseract.js + Gemini).
2. **Business reasoning** (BAE query + briefing): always feed **pre-computed real
   numbers** as context; LLM does language/insight only. `thinkingConfig.thinkingBudget: 0`
   on briefing to stop 2.5-flash burning output budget on reasoning (truncation fix).

**Shinobu** (BAE's security LLM) is intentionally NOT embedded here — different domain
(security), no live serving, frozen. Future link = cross-sell security product, not code-merge.

---

## 7. Keep-warm (anti-outage)

Render free sleeps ~15min idle; Supabase free pauses ~1 week idle → login dies mid-demo.
`.github/workflows/keepwarm.yml` pings `/health` every 10min (health does a DB query →
keeps both warm). Free (GitHub Actions). Avoids needing paid Supabase ($25/mo) at pilot stage.

---

## 8. Known backlog (do not silently "fix" — these are deliberate deferrals)

- **S2** per-shop unique design codes (currently global unique → blocks multi-shop scale).
- **S3** atomic invoice generate (currently manual rollback in catch).
- **S4** enable Supabase RLS / move writes behind service key.
- **A2** paid Supabase/Render (or rely on keep-warm) before many paid shops.
- Payment **collection** (in-app money movement) needs Razorpay + registered entity + KYC
  — deferred. Current "payment request" = free WhatsApp + `upi://` deeplink (no gateway, no KYC).

---

## 9. Tax stance (legal — do not change without reason)

GSTR-1 includes only GST invoices. **ITR/P&L turnover includes non-GST (cash) sales**
— excluding them = under-reporting income = illegal. 44AD updated AY 2026-27 (6% digital /
8% cash, ₹3 Cr limit). GST split CGST+SGST only (no IGST inter-state yet).
