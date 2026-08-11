# FastBahi — Complete AI Handoff Brief

> **Purpose of this file.** Hand this single document to any AI assistant (Claude, GPT, Gemini, a coding agent) with no other context, and it should understand what FastBahi is, how every part works, why each design decision was made, what is deliberately unfinished, and what it must not break.
>
> **Verified against source on 2026-07-29** by reading `backend/server.js` (3,225 lines), the mobile repo, migrations, workflows and live endpoint probes — not from memory. Where this file disagrees with `ARCHITECTURE.md` (last audited 2026-06-18), **this file is newer**.
>
> **Instruction to the AI reading this:** treat line numbers as approximate — re-grep before editing. Verify any claim about live data by calling the API. Do not perform schema changes, dependency additions, or paid-infra changes without explicit human approval (see §14).

---

## 1. What FastBahi is, in one page

A billing + shop-management mobile app for small Indian shopkeepers (MSME). Android-first, works offline-ish, 10 Indian languages, GST-compliant invoicing.

- **User:** a shopkeeper in a tier-2/3 Indian town — tiles/marble, kirana (grocery), electronics, clothing, pharmacy, jewellery, restaurant, or general trade. Often not fluent in English, often not tech-savvy, usually on a cheap Android phone.
- **Jobs it does:** make a bill (GST or plain), track stock, track *udhari* (credit given to customers) and supplier dues, send payment reminders on WhatsApp, log expenses, show GST + income-tax summaries, and answer plain-language business questions.
- **Owner:** Bharat Advanced Energy (BAE) — solo founder, `aashishk029@gmail.com`. (Older strings may say "Bharat Ananta Energy"; the company was renamed to **Advanced**. "BAE" is unchanged.)
- **Business stage:** pre-revenue. Everything runs on free tiers on purpose. Currently preparing a **free pilot** with a handful of friendly shopkeepers, then a Play Store release.
- **Codename in old notes:** "Project Naruto" — same thing as FastBahi.

### Domain vocabulary an AI will hit in this codebase
| Term | Meaning |
|---|---|
| **Bakaya** | outstanding / money owed. Two directions: customers owe the shop, shop owes suppliers. |
| **Udhari** | credit sale — goods handed over, payment later. Sets `payment_status='credit'`. |
| **GSTIN** | 15-char GST registration number. Presence ⇒ B2B invoice. |
| **GSTR-1** | monthly GST sales return. The Tax screen prepares the numbers for it. |
| **ITC** | input tax credit — GST paid on purchases, offsettable against GST collected. |
| **Sec 44AD / ITR-4** | presumptive income-tax scheme for small business (6% digital / 8% cash of turnover). |
| **HSN code** | product classification code that determines the GST rate. |
| **Boxes** | legacy unit name. Every quantity column is literally called `quantity_boxes` even when the shop sells kg, sqft, litre or plates. Do not rename — see §11. |

---

## 2. Repositories, hosting, live URLs

| Piece | Path on the founder's Mac | Git remote | Hosting |
|---|---|---|---|
| Backend (Express + Supabase) | `~/Documents/Claude/Projects/Project Naruto-Bharat Ananta Energy (BAE)/fastbill-ai-shop` | `github.com/aashishk029/fastbill-ai-shop` | Render free tier, auto-deploys on push to `main` |
| Mobile (React Native + Expo) | `.../fastbill-mobile` | `github.com/aashishk029/fastbill-mobile` | EAS cloud builds → APK / AAB |
| Web build of the same app | same mobile repo | — | Vercel via `deploy-web.sh` (`expo export --platform web`) |
| Privacy policy page | `~/fastbill-legal/` | — | Vercel → `https://fastbill-legal.vercel.app` |
| Sales / pilot / launch docs | `~/fastbill-sales-kit/` | — | local only |

- **Live API base:** `https://fastbill-ai-shop.onrender.com/api`
- Mobile hard-codes that base URL in `src/utils/api.js` (axios, 90 s timeout). There is no staging environment — the app talks to production.
- **Backend deploy:** `git push origin main` → Render runs `npm install` then `node backend/server.js`. No CI gate. Verify with `node --check backend/server.js` and a local boot *before* pushing.
- **Mobile deploy:** `npx eas build -p android --profile preview` (APK for sideloading) or `--profile production` (AAB for Play Store). **Bump `expo.android.versionCode` in `app.json` every build.** Keystore is EAS-managed.
- Repo root also contains a legacy `frontend/` React app and several stale docs (`DEPLOY_NOW.md`, `WEEK1_COMPLETION_REPORT.md`, `TESTING_STATUS.md`). The mobile app is the real client; `frontend/` is not deployed.

---

## 3. Environment variables (set in the Render dashboard, not in git)

| Var | Purpose | Notes |
|---|---|---|
| `SUPABASE_URL` | Postgres/Supabase project | real host: `dbyojztmtaexbiaepnif.supabase.co` |
| `SUPABASE_ANON_KEY` **or** `SUPABASE_KEY` | DB auth | code accepts either name; `render.yaml` uses `SUPABASE_KEY`. This mismatch was once a latent outage. |
| `GEMINI_API_KEY` | **all AI features** | `gemini-2.5-flash`, free tier |
| `ALLOWED_ORIGINS` | CORS allowlist (comma-separated) | when unset, CORS falls back to `*` |
| `PORT` | Render sets `10000`; local default `3001` |
| `ANTHROPIC_API_KEY`, `HF_TOKEN` | **dead** | Anthropic SDK removed (broken on Render: `messages.create` undefined). HuggingFace BLIP endpoints are dead. Safe to delete both. |

**Local development caveat (important):** the repo-root `.env` exists but its Supabase credentials are **stale** — booting locally gives `"db": false` and `TypeError: fetch failed` on any DB call. Validation logic is testable locally; anything touching the database must be verified against the live Render deployment. `dotenv` reads `.env` from the process CWD, so start the server from the **repo root** (`node backend/server.js`), not from `backend/`.

---

## 4. Stack

**Backend** — Node + Express 4, `@supabase/supabase-js` 2, `bcrypt` (PIN hashing), `express-rate-limit` (loaded in a `try/catch` so a missing dep degrades to a no-op instead of crashing the boot), `tesseract.js` (OCR for bill scanning), `body-parser` with a **20 MB** limit (base64 images).

**Database** — Supabase Postgres, free tier, **RLS disabled on every table**. The app does not use Supabase Auth; it has its own phone+PIN scheme, so RLS-on would silently reject all anon-key writes. Any new table must include `ALTER TABLE x DISABLE ROW LEVEL SECURITY;` or writes will fail mysteriously.

**Mobile** — Expo SDK 54, React Native 0.81, React 19, `@react-navigation/bottom-tabs`, `@react-native-picker/picker`, AsyncStorage, NetInfo, `expo-camera` (barcode), `expo-image-picker`, `expo-print` + `expo-sharing` (PDF bills), `react-native-chart-kit` + `react-native-svg` (analytics), `react-native-web` (web export). `axios` for HTTP.
**`expo-constants` is NOT installed** — read the app version by importing `app.json` directly, as `DashboardScreen` does. Adding native modules forces a rebuild, so treat any dependency addition as a structural change.

**AI** — Google `gemini-2.5-flash` only, called by plain `fetch` against `generativelanguage.googleapis.com`. Used at five call sites: product-photo identification, purchase-bill OCR post-processing, the BAE Q&A endpoint, the BAE daily briefing, and AI restock alerts.

---

## 5. Data model

### 5.1 The single most important warning
`backend/database/complete_setup.sql` and `schema.sql` are the **original 2026-05 schema and are badly out of date** (they still describe a tiles-only app: `total_amount`, `coverage_sqft`, `INTEGER` quantities, no `pin_hash`, no `payment_status`). The **real** schema is that file *plus* roughly a dozen migrations in `supabase/migrations/`. When you need ground truth about a column, either read the migrations in order or query the live API — never trust `complete_setup.sql` alone.

### 5.2 Tables and the columns that matter
- **`shops`** — `id`, `name`, `owner_name`, `phone`, `address`, `shop_type`, `gstin`, `pan_number`, `pin_hash` (bcrypt), `shop_id_display` (`FB-2026-XXXXX`, randomly generated to avoid a count-based race), `upi_id`, `auto_reminder_enabled`, `reminder_threshold_days`, `low_stock_threshold`.
- **`tile_categories`** — per-shop product category. `shop_id`, `category_name`, `size_mm` (**NOT NULL** — use `"N/A"`), `coverage_sqft`, `base_price_per_box`. Despite the name it is used by every shop type, not just tile shops.
- **`designs`** — the product/SKU table. `category_id`, `design_code` (**globally `UNIQUE`** — see §11), `design_name`, `color`, `hsn_code`, `default_gst_rate`, `unit_type` (`boxes|sqft|sqmeter|kg|unit|plate|litre|grams|metre`), `is_active`. **`designs` has no `shop_id`** — ownership is inferred through `tile_categories.shop_id`, or in practice through the shop's `inventory` row.
- **`inventory`** — `shop_id`, `design_id`, `quantity_boxes`, `low_stock_threshold`, `is_low_stock` (**GENERATED ALWAYS** — never insert it), `expiry_date`, and the last-saved pricing breakdown (`last_cost_price`, `last_extra_cost`, `last_margin_percent`, `last_margin_amount`).
- **`invoices`** — `shop_id`, `invoice_number` (`INV-<epoch ms>`, unique), customer fields (`customer_name/phone/address/gstin`), `invoice_type` (`B2B|B2C`), `taxable_value`, `cgst_amount`, `sgst_amount`, `gst_rate` (**always `null` on regular invoices** because rates are per-item; jewellery sets `3`), `is_gst_invoice`, `discount_amount`, `payment_status`, `amount_paid`, `table_number` (restaurants), `return_note`, `last_reminder_at`.
  `payment_status` is free-text TEXT and carries **six** meanings: `paid`, `credit`, `partial`, `cancelled`, `returned`, `partial_return`. Revenue queries everywhere exclude `cancelled` and `returned`.
- **`invoice_items`** — `invoice_id`, `design_id`, `quantity_boxes`, `price_per_box`, `hsn_code`, `gst_rate` (per-item snapshot).
- **`purchases`** — stock inward. `shop_id`, `design_id`, `quantity_boxes`, `supplier_name`, `cost_per_box`, `purchase_date`, `payment_status` (default `unpaid`), `amount_paid`, plus pricing helpers `extra_cost`, `margin_percent`, `margin_amount`, `suggested_price`.
- **`expenses`** — `shop_id`, `category` (`rent|utility|salary|transport|marketing|other`), `amount`, `note`, `expense_date`.
- **`payment_events`** — audit trail of partial payments against an invoice.
- **`shop_staff`** — `shop_id`, `staff_name`, `phone` (**UNIQUE across the whole table**), `pin_hash`, `can_edit_price`, `can_delete`, `can_manage_staff`, `active`.
- **`recurring_invoices`** — template: customer fields, `items` (JSONB), `frequency` (`daily|weekly|monthly`), `next_run_date`, `active`, `last_generated_invoice_id`.
- **`ads`** — dashboard ad slot content: `title`, `subtitle`, `image_url`, `link_url`, `shop_type` (null = all), `priority`, `active`, `starts_at`, `ends_at`. Editable from Supabase with no app release.
- **`bank_transactions`** — CSV-imported statement rows: `txn_date`, `description`, `amount`, `txn_type` (`credit|debit`), `matched_invoice_id`, `matched_purchase_id`, `reconciled`.
- **`feedback`** — in-app pilot feedback: `shop_id`, `shop_name`, `phone`, `rating` (1–5), `message`, `screen`, `app_version`, `platform`, `lang`, `resolved`. **As of 2026-07-29 the migration for this table has not yet been run in Supabase** (see §13).
- **`alerts`** — legacy table; alerts are computed on the fly, not read from here.

### 5.3 Stored procedures
Only two, both in `complete_setup.sql`: `update_inventory_after_invoice(design_id, quantity)` (decrement on sale) and `increment_inventory(p_design_id, p_quantity)` (no longer used — replaced by a read+update because of a signature mismatch). There is **no transactional invoice RPC**; see §11.

---

## 6. API surface — all 60 endpoints

Base `https://fastbill-ai-shop.onrender.com/api`. Everything is JSON. There are **no auth tokens**: the client sends `shopId` and the server validates ownership per route (see §10).

**Health / shop / auth**
`GET /health` (also warms the DB) · `POST /shops/init` · `GET /shops/:shopId` (strips `pin_hash`) · `PATCH /shops/:shopId` · `POST /shops/login` (rate-limited 20/15 min)

**Staff**
`POST|GET /shops/:shopId/staff` · `PATCH|DELETE /shops/:shopId/staff/:staffId`

**Inventory / products**
`GET /inventory/status/:shopId` (enriched with `last_supplier`, `last_cost`, low-stock list, and items expiring within 30 days) · `PATCH /inventory/adjust` · `DELETE /inventory/:inventoryId` · `PATCH /inventory/set-price` · `POST /inventory/scan-purchase` (Tesseract OCR + Gemini) · `POST /inventory/confirm-scan` · `POST /inventory/photo-identify` · `POST /designs/add` · `PATCH /designs/:designId/unit` · `POST /products/identify-photo` · `POST /shops/:shopId/repair-shared-pricing`

**Invoices**
`POST /invoices/generate` · `POST /invoices/jewellery` · `GET /invoices/history/:shopId` (filters: `customer`, `month`, `date`) · `PATCH /invoices/:id/payment` · `DELETE /invoices/:id` (cancel) · `POST /invoices/:id/return` · `POST /invoices/:id/eway-bill-data` · `GET /invoices/last-rate/:shopId`

**Recurring invoices**
`POST /recurring-invoices` · `GET /recurring-invoices/:shopId` · `PATCH|DELETE /recurring-invoices/:id` · `POST /recurring-invoices/run-due` (called by a daily GitHub Action)

**Purchases**
`POST /purchases/add` · `PATCH /purchases/:id/payment` · `GET /purchases/latest-rate/:shopId/:designId`

**Money owed / customers / reminders**
`GET /bakaya/:shopId` · `GET /customers/:shopId` · `GET /customers/:shopId/history` · `GET /customers/credit-score/:shopId/:customerName` · `POST|GET /payment-events[/:invoiceId]` · `GET /reminders/overdue/:shopId` · `POST /reminders/mark-sent`

**Money out / tax / analytics**
`POST|GET|DELETE /expenses[/:shopId|/:id]` · `GET /tax/summary/:shopId?year=YYYY` · `GET /analytics/projections/:shopId?months=N` · `GET /credit-score/:shopId`

**AI**
`GET /alerts/:shopId` (restock advice) · `POST /bae/query` (free-text business Q&A) · `GET /bae/briefing/:shopId?lang=xx` (daily top-3 actions)

**Misc**
`GET /jewellery/rates` · `GET /ads/active?shopType=x` · `POST /feedback` · `POST /bank-transactions/import` · `GET /bank-transactions/:shopId` · `GET /bank-transactions/:shopId/suggestions` · `PATCH /bank-transactions/:id/match`

---

## 7. Core business logic — the parts that must not be broken

### 7.1 Invoice generation (`createInvoiceCore`, ~line 480)
Deliberately extracted into one shared function used by **both** `POST /invoices/generate` and the recurring-invoice scheduler, so the two can never drift apart on money math. Order of operations:

1. Require `shopId` and a non-empty `items` array.
2. Load each `designId`'s `hsn_code`, `default_gst_rate`, `unit_type`.
3. **Ownership + oversell guard:** load this shop's `inventory` rows for those designs. A design absent from this shop's inventory is rejected (this is the only ownership proof available, since `designs` has no `shop_id`), and any quantity above stock on hand is rejected.
4. Compute per-line gross = `qty × rate` (both `parseFloat`, so decimals work).
5. **Allocate the bill-level discount proportionally across lines**, then compute GST on the discounted amount. Discount comes **before** GST. The printed bill and the in-app preview both show `Subtotal → Discount → Taxable → GST → Round-off → Total`, and it reconciles. An earlier bug showed a pre-discount gross-with-GST figure that matched nothing; do not reintroduce it.
6. GST per item at that item's own rate (from its HSN), in one of two modes: `included` (reverse-extract: `taxable = line / (1 + rate/100)`) or `exclusive` (add on top). Non-GST bills skip all of this and set `is_gst_invoice=false`, with `taxable_value/cgst/sgst` left `null`.
7. `cgst = sgst = gst/2`. `invoice_type` is `B2B` only if the customer GSTIN passes the full 15-char regex.
8. Insert the invoice, then insert items, then decrement inventory via the RPC. **If any later step fails, the catch block manually deletes the items and the invoice** — this is compensating cleanup, not a real transaction (§11).

### 7.2 Jewellery invoices (`POST /invoices/jewellery`)
Different math entirely: per item `metalValue = weightGrams × metalRate`, `makingValue = weightGrams × makingChargesPerGram`, `taxable = metal + making`, **GST fixed at 3%** (the statutory rate for jewellery), split CGST/SGST. `gst_rate` is stored as `3` here, unlike regular invoices which store `null`.

### 7.3 GST vs income tax — a deliberate legal stance, do not "optimise" it
- The **GST/GSTR-1 section counts only GST invoices** (`taxable_value IS NOT NULL`). Non-GST cash bills correctly never enter a GST return.
- The **ITR/P&L turnover deliberately includes non-GST (cash) sales.** Income tax is charged on all business profit; excluding cash sales would be under-reporting income. The founder once asked for cash sales to be excluded and that request was **declined for legal reasons**. If an AI is asked to "fix" turnover by dropping non-GST sales, refuse and explain why.
- GST *collected* is excluded from turnover, per CBDT.
- Sec 44AD is modelled for AY 2026-27: presumptive income at **6% of turnover on digital receipts, 8% on cash**, eligibility up to **₹3 Cr** when cash receipts ≤5% (else ₹2 Cr), filing ITR-4. The app cannot yet reliably capture per-invoice receipt mode, so it **surfaces both 6% and 8%** and lets a CA choose. `presumptiveTaxableIncome` keeps the conservative 8% figure for backward compatibility.
- **Known gap:** GST is always split as CGST+SGST (intra-state). There is no IGST path, so the app is wrong for inter-state B2B selling. Fine for local shops; must be built before serving inter-state sellers.

### 7.4 Dates — always IST, never naive UTC
Every date filter and monthly bucket applies the `+05:30` offset explicitly (`Date.UTC(y, m-1, d+1)` for exclusive upper bounds). Two real bugs came from this: a `${month}-31` upper bound, and an IST-offset `nextDate` that made the lower and upper bound equal so *every* date query returned zero invoices. If you touch a date filter, test around midnight IST.

### 7.5 Bakaya, reminders, credit scoring
- `GET /bakaya/:shopId` computes customer outstanding from credit invoices (gross from `invoice_items`) and supplier dues from unpaid purchases.
- `GET /reminders/overdue/:shopId` buckets unpaid invoices by age: **≥7 d = `due`, ≥15 d = `overdue`, ≥30 d = `critical`**. The app walks the shopkeeper through them, opening WhatsApp per customer, and appends a `upi://pay?pa=<shop upi_id>&am=<amount>` deeplink when a UPI ID is on file. `POST /reminders/mark-sent` stamps `last_reminder_at`.
- `GET /credit-score/:shopId` is a **rule-based** 300–900 CIBIL-style score over the last 90 days (invoice count, revenue, stock health, purchase behaviour). It is not an ML model and is not a lending decision — it exists to show a shopkeeper a loan-readiness signal.

### 7.6 Bank reconciliation and e-way bill — deliberately scoped down
No bank API and no NIC e-way-bill credentials are available, so: reconciliation works from a **CSV the shopkeeper exports from their own bank app**, matching on amount within a date window and asking for manual confirmation; the e-way endpoint only **prepares the EWB-01 field values** for manual entry on the government portal. Nothing files or fetches automatically. Do not describe these as integrations.

### 7.7 AI usage rules
- One model everywhere: `gemini-2.5-flash` via `fetch`. `gemini-1.5-flash` is not enabled on this project.
- **The LLM never computes money.** For the daily briefing, the backend computes all aggregates deterministically (today's sales, week-over-week trend, outstanding + overdue, low stock) and Gemini only *narrates* the top-3 actions in the user's language, with `thinkingBudget: 0` to avoid truncation. If Gemini's free quota is exhausted, a deterministic English fallback is returned. Preserve this split — an LLM inventing a revenue figure for a shopkeeper is unacceptable.
- Vision paths (`identify-photo`, `photo-identify`, `scan-purchase`) tolerate prose responses with a JSON-extraction fallback. Client-side image quality is dropped to 0.3 to stay under the 20 MB body limit.

---

## 8. Mobile app structure

**Navigation** (`App.js`) — a bottom-tab navigator gated by three conditions:
1. No language chosen → `LanguagePickerScreen`.
2. No `shopId` in AsyncStorage → `SetupScreen` (register or login).
3. Otherwise tabs: **Dashboard, Invoice, Stock, Tax**, plus **Jewellery** only when `shop_type === 'jewellery'`, plus **Admin** only when the user is *not* staff.

`App.js` owns the shared state (`shopData`, `inventoryStatus`, `alerts`) and re-fetches all three every 30 s via `Promise.allSettled`. On first login after setup it shows `OnboardingTour`. Logout clears `shopId`, `isStaff`, `staffPermissions`, `staffId`.

**Screens** (`src/screens/`): Dashboard (hero shop card, today's sales, BAE briefing card, bakaya ledger, reminder walkthrough, ad slot, BAE chat FAB, refer button, feedback button), Invoice (new bill + history, B2B/GST/udhari toggles, returns, print/share), Stock (add stock, barcode scan, AI photo add, HSN picker, price/margin editor, expiry), Tax, Customers, Expenses, Jewellery, Staff, BankRecon, Analytics, Alerts, Credit, Setup, LanguagePicker. `AdminToolsScreen` is a thin wrapper that toggles between Analytics / Staff / Bank so those three don't each consume a bottom-tab slot.

**Design system** — `src/theme/PrestigeTheme.js` (navy `#1E3A5F`, gold accent `#C5A021`, radius ladder, layered shadows, semantic tints) with `PrestigeButton` / `PrestigeCard` / `PrestigeInput`. New UI should consume tokens rather than hardcode colours. No gradient or animation libraries are installed by choice.

**i18n** — `src/i18n/strings.js` + `LanguageContext` exposing `t()`. Ten languages: **en and hi with 570 keys each; ta, te, kn, ml, gu, mr, bn, pa with 423 each.** Missing keys fall back to English, so partial coverage is non-breaking. Printed bill labels are translated too, except GST-statutory terms which stay in English on purpose. Translations are best-effort machine output — a native speaker spot-check is still pending.

**Offline behaviour** — `src/utils/syncManager.js` queues invoice/stock requests in AsyncStorage when a request fails, and a NetInfo listener replays the queue through the normal server path on reconnect. This is a **power-cut safety net, not offline-first architecture**: reads still need the network, and a queued bill is not visible in history until it syncs.

**Print / share** — bills render as HTML → `expo-print` PDF → `expo-sharing` on device; on web they open as a blob URL in a new tab. `App.js` injects `@media print` CSS to hide navigation and buttons.

**Two platform traps.** (a) `Alert.alert` silently no-ops on React Native Web, so all user messaging goes through `src/utils/alert.js` (`showAlert` / `confirmAction`) which uses `window.alert`/`window.confirm` on web. (b) Android in dark mode inherits white text in inputs, so **every** `TextInput` style must explicitly set `color: '#1e293b'`.

---

## 9. Scheduled jobs

- `.github/workflows/keepwarm.yml` — `curl`s `/api/health` **every 10 minutes**, and fails the run if the response lacks `"db":true`. This exists because of a real outage: the Supabase free project **auto-pauses after ~1 week idle** and login died mid-demo (`fetch failed` → `521` → `Could not find table 'public.shops' in schema cache`). The health route deliberately runs a cheap count query so the ping warms Postgres too, and Render's free tier never cold-sleeps (~50 s first request otherwise). Keeping this workflow enabled substitutes for a $25/mo paid Supabase plan.
- `.github/workflows/recurring-invoices.yml` — `POST /recurring-invoices/run-due` daily at 03:00 UTC (08:30 IST).

**If login ever breaks in production, check this first:** Supabase project paused → restore it from the dashboard and wait ~3 minutes. Data survives the pause. The login code has never been the cause.

---

## 10. Security model and its history

**Original design flaw (found and fixed 2026-06-16):** there was no server-side authentication at all. The client was fully trusted, `shopId` came from the request body as the only identity, and ownership checks were optional or missing — so omitting `shopId` let you mutate any record by id, and `inventory/adjust` with an `inventoryId` performed no shop check whatsoever.

What is in place now:
- **PIN auth** — phone + 4–6 digit PIN, bcrypt-hashed. A shop with a `null pin_hash` **self-enrols** the PIN typed on first login instead of accepting any PIN (that bypass was live and all three test shops had null hashes). Multiple shops on one phone return an array for the client to pick from. If the phone is not an owner, `shop_staff` is checked and the parent shop plus a permissions object is returned. `pin_hash` is stripped from every shop response.
- **Ownership enforcement** — `shopId` is required and always filtered on invoice/purchase payment patches, inventory adjust, invoice delete and invoice return (403 when `invoice.shop_id !== shopId`). Invoice generation proves design ownership through the shop's own inventory rows.
- **Staff permissions are enforced server-side** — `set-price` and `delete-inventory` verify the staff row's `can_edit_price` / `can_delete`, not merely a hidden button.
- **Rate limiting** — 20 requests/15 min on login; a 30/15 min limiter is available for AI routes.
- **CORS** — locked to `ALLOWED_ORIGINS` when set, otherwise `*`.
- **Oversell and negative stock** blocked at invoice generation.

**What is still weak, honestly:** there are no session tokens — any client that knows a `shopId` UUID can read that shop's data; **RLS is disabled and the Supabase anon key ships inside the client bundle**; and the anon key therefore permits direct table access outside the API. Fixing this properly means enabling RLS with policies or routing all writes through a server-only service key (§11, S4). This is acceptable for a supervised free pilot and **not** acceptable for a paid public launch.

---

## 11. Known limitations, traps, and the structural backlog

The founder's standing rule: **do not make structural changes without explicit approval.** These are known, deliberately deferred, and each has a reason.

| ID | Issue | Why it matters | Status |
|---|---|---|---|
| **S1** | `quantity_boxes` was `INTEGER` while the app sells sqft/grams/kg/litre via `parseFloat` | fractional quantities truncated/rejected | **applied** — migrated to `NUMERIC(12,3)` before the pilot |
| **S2** | `designs.design_code` is **globally** `UNIQUE`, and `designs` has no `shop_id` | two different shops cannot reuse a product code — breaks multi-shop SaaS scale | deferred to phase 2 |
| **S3** | invoice generate / jewellery / delete / return are **not atomic** — manual rollback in a `catch` | a partial failure under load can desync stock against invoices | deferred to phase 2 (`PHASE2_S2_S3_before_paid_launch.sql`) |
| **S4** | RLS disabled + anon key in the client bundle | direct table access is possible outside the API | deferred; blocks paid launch |
| — | No IGST path (always CGST+SGST) | wrong for inter-state B2B | build before serving inter-state sellers |
| — | Receipt mode (cash vs digital) not captured per invoice | cannot auto-choose 6% vs 8% under 44AD | both figures surfaced instead |
| — | `complete_setup.sql` is stale | misleads anyone reading it as current schema | read migrations instead |
| — | Free-tier cold start | first request after idle can take ~50 s; app shows a spinner | keep-warm cron mitigates |
| — | Machine translations unverified | eight regional languages unchecked by native speakers | pending spot-check |
| — | 3 duplicate "Kanhaiya Marbles" test shops (root cause: an exists-check using `.single()` that threw when duplicates already existed, letting another duplicate register — the check now uses `.limit(1)`) | dirty pilot data | resolved by the wipe script when run |

**Traps that have each cost a debugging session:**
- New Supabase tables default to **RLS on** → anon-key writes silently fail. Always add `DISABLE ROW LEVEL SECURITY`.
- `inventory.is_low_stock` is a **generated column** — inserting it errors.
- `tile_categories.size_mm` is `NOT NULL` — pass `"N/A"`.
- `Alert.alert` is a no-op on Expo web (§8).
- Android dark mode makes unstyled `TextInput` text invisible (§8).
- `expo-constants` is not a dependency (§4).
- The Anthropic SDK is broken on Render; HuggingFace BLIP/moondream endpoints are dead. Use Gemini.
- `dotenv` needs the server started from the repo root, and the local `.env` Supabase creds are stale (§3).

---

## 12. Working conventions the founder expects

1. **No rushed deploys.** A local end-to-end check must pass before any push or cloud build: `node --check backend/server.js`, boot the server, hit `/api/health`; for mobile, `npx expo export --platform android` to catch bundling/import errors before spending an EAS build.
2. **Structural changes need explicit authorisation** — schema migrations, new dependencies, architecture rewrites, anything irreversible or costing money. Routine fixes, checks and builds do not.
3. **Spend nothing until there is revenue.** Free tiers everywhere; the keep-warm cron exists specifically to avoid a paid Supabase plan.
4. **Language purity in the UI** — content should be in one language per screen, not Hinglish. Backend error strings are still Hinglish (`"Stock kam hai"`, `"Galat PIN"`) and are surfaced to users; treat that as known debt.
5. **Update the docs you touch.** `ARCHITECTURE.md` is the deeper narrative reference; this file is the current top-level brief. Keep both honest about what is *not* built.
6. **Be honest about capability limits in user-facing copy** — e.g. bank reconciliation is CSV-based, the e-way feature only prepares fields. No feature should imply a government or bank integration that does not exist.

---

## 13. State as of 2026-07-29 (pilot launch prep)

**Live and verified:** backend healthy (`{"db":true,"gemini":true}`); every migration through `20260724030000` is applied in Supabase (recurring invoices, staff, ads, bank transactions, expiry and margin columns all respond); both repos clean and pushed.

**Latest build:** `~/Downloads/FastBahi-v16-pilot.apk` — 96 MB, `versionCode 16`, EAS preview build `5118a743`, EAS-managed keystore. Contains everything described here, including the new feedback button.

**Pilot artifacts:**
- `~/fastbill-sales-kit/PILOT_SETUP.sql` — Part A: idempotent schema catch-up (the `feedback` table + all July columns). Part B: destructive `TRUNCATE` of every shop, commented out by default. Supersedes the older `WIPE_AND_MIGRATE.sql`.
- `~/fastbill-sales-kit/PILOT_GUIDE_HINDI.md` — shopkeeper handout in Hindi: install (Android APK / iPhone web link), setup, five first-day tasks, how to send feedback, FAQ.
- Also in that folder: `PLAY_STORE_SUBMISSION.md` (listing copy, Data Safety answers, content rating, screenshot guide), `FINAL_REVIEW_CHECKLIST.md`, `PILOT_RUNBOOK.md`, `FASTBAHI_REVIEW.md` (severity-ranked audit), `00_BAE_STRATEGY.md`, offer sheet / outreach / target list, landing page.

**The one open blocker:** Part A of `PILOT_SETUP.sql` has **not** been run in Supabase, so `POST /api/feedback` currently returns `Could not find the table 'public.feedback'`. Everything else in the app works. Only the founder can run it — no Supabase admin credential exists locally; the real key lives only in Render's environment.

**Next steps after that:** verify the feedback POST live → hand the APK plus the Hindi guide to pilot shopkeepers (iPhone users get the Vercel web link; an APK will not install on iOS, and a native iOS build needs $99/yr, deferred since Android is ~95% of this market) → read `feedback` rows from the Supabase table editor → fix what the pilot surfaces → Play Store submission (needs a $25 developer account and 2–8 screenshots; the listing pack is already written).

**Not built, considered:** true offline-first, bulk SMS, online catalog/storefront, staff salary register, barcode-driven fast checkout, e-way bill filing, IGST, in-app subscription billing. A company entity (LLP), bank account, and a payment gateway are prerequisites for charging anyone at all.

---

## 14. Quick reference for an AI starting work here

```bash
# paths
cd "~/Documents/Claude/Projects/Project Naruto-Bharat Ananta Energy (BAE)/fastbill-ai-shop"   # backend
cd "~/Documents/Claude/Projects/Project Naruto-Bharat Ananta Energy (BAE)/fastbill-mobile"    # mobile

# verify backend before pushing (from repo ROOT, not backend/)
node --check backend/server.js
PORT=3011 node backend/server.js &      # local .env DB creds are stale -> "db": false is expected
curl -s localhost:3011/api/health

# probe live state (safe, read-only). A zero UUID confirms a table exists without touching data.
curl -s https://fastbill-ai-shop.onrender.com/api/health
curl -s https://fastbill-ai-shop.onrender.com/api/inventory/status/00000000-0000-0000-0000-000000000000

# verify mobile bundles before spending an EAS build
npx expo export --platform android --output-dir /tmp/fb-export

# builds (bump app.json expo.android.versionCode first)
npx eas build -p android --profile preview      # APK, sideload
npx eas build -p android --profile production   # AAB, Play Store
bash deploy-web.sh                              # web -> Vercel

# find things
grep -noE 'app\.(get|post|patch|delete)\("[^"]+"' backend/server.js   # every route + line number
ls supabase/migrations/                                               # real schema history
```

**Before changing money math, read `createInvoiceCore` end to end** (§7.1) — discount-before-GST ordering, proportional allocation, the two GST modes and the oversell guard are all load-bearing and each was a bug once.

**Do not, without asking:** change the schema, add a dependency, alter the ITR turnover stance (§7.3), remove the keep-warm workflow, let an LLM compute a money figure (§7.7), or push straight to production without the local checks above.
