# FastBahi — System Architecture (Mainframe Reference)

> **Last full audit: 2026-08-14.** Sections 3, 4, 8, 9 and 10–13 were rewritten then;
> everything else predates it and is older. `AI_HANDOFF.md` (2026-07-29) covers the July
> features (staff/multi-user, recurring invoices, ad slot, bank reconciliation, e-way prep,
> in-app feedback).
>
> Keep this file updated whenever you build or modify. Where a decision looks odd, the
> reason is written down — read it before undoing it.

**Current shape:** `backend/server.js` ~5,500 lines, 84 routes, 14 library modules under
`backend/lib/`, 248 tests (`npm test`), 20 SQL migrations.

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

### Security model (server-side) — rewritten 2026-08-07..14

**Sessions.** Login and signup issue a signed JWT (`backend/lib/auth.js`). One app-level
gate mounted *ahead of routing* answers, per request: is there a valid session, and does the
shop this request names match it. Gating centrally rather than per route means a route added
later is covered by default rather than by remembering.

Three details that are easy to get wrong, and were:

- **`req.params` is empty in `app.use()` middleware.** Express fills params only after a
  route matches. The first version read `req.params.shopId`, always got `undefined`, and so
  passed everything while looking correct. Shop position is matched from the *path*
  explicitly, per HTTP method, because several paths mean different things per verb
  (`GET /api/orders/:shopId` lists; `DELETE /api/recurring-invoices/:id` removes one row).
- **Express defaults `strict routing` OFF and `case sensitive routing` OFF**, so
  `/api/shops/<id>/` and `/API/SHOPS/<id>` reach the same handler. Matching only the
  canonical spelling was a live bypass — a session for one shop read another by appending a
  slash. `normalisePath()` + `/i` on every pattern fixes it; the captured id keeps its
  original case so the comparison still works.
- **A session is not authorisation.** Routes naming a record by its own id (`/invoices/:id`)
  resolve that record's owning shop first, or a valid session could delete another shop's
  invoice by guessing an id. Absent and not-yours return the same reply, so ids cannot be
  probed.

A guard test parses `server.js` and asserts every `:shopId` route appears in the scope
table — adding a shop-scoped route without registering it fails the suite rather than
shipping unguarded. It has already caught one.

**`AUTH_ENFORCE`** must be `"true"` to block; anything else runs every check in report-only
and logs what it *would* have refused. That existed so a build already on a shopkeeper's
phone kept working during rollout. **It is `true` in production since 2026-08-13.** Check
`GET /api/health` → `auth.enforced`.

**Staff permissions** are enforced server-side, not by hiding buttons. Deleting, price
edits, returns and staff management check the permission; the check reads the staff row
from the database rather than the token, because permissions are stamped in at login and a
session lasts 30 days — trusting the token would keep a revoked permission alive for a
month and leave a removed employee with full access. Every staff request re-reads that row,
so deactivation takes effect at once.

**Price is enforced, not just displayed.** `canEditPrice` originally guarded only the
catalogue, while the price a customer actually pays arrived in the invoice body unchecked —
a cashier could hold "cannot edit price" and still sell a ₹900 box for ₹100. Staff without
the permission are now held to the catalogue price and refused a discount. The flag is set
*after* `...req.body` is spread; before it, a caller could send `lockToCatalogPrice:false`.

**Other controls.** `express-rate-limit` is a hard dependency (it was optional with a no-op
fallback, so a failed install shipped no rate limiting and no symptom); `trust proxy` is a
fixed single hop; login is limited per-phone as well as per-IP, because probing production
showed merely *sending* an `X-Forwarded-For` header opened a second bucket; body limit is
1 MB except four image/import routes; login returns one message for unknown phone and wrong
PIN alike, so numbers cannot be harvested. **Exactly HTTP 500** is masked to a generic
sentence and the real error logged — 4xx and 503 are chosen deliberately and pass through.
Secrets: none in either repo, and none in 140 commits of history.

---

## 4. Database (Supabase Postgres, RLS **enabled**)

Key tables: `shops`, `designs` (no shop_id — linked via `tile_categories`),
`tile_categories`, `inventory` (`quantity_boxes NUMERIC(12,3)`, `is_low_stock`
GENERATED), `invoices` (payment_status: paid/credit/partial/cancelled/returned),
`invoice_items`, `purchases`, `expenses`, **`online_orders`** (see §11).

`shops` also carries, added 2026-08: **`webhook_secret`** (per-shop, §12),
**`shipping_provider` + `shipping_config`** (per-shop courier, §12).
Full column list: `backend/database/schema.sql`.

**RLS is on, and it protects less than it looks like it does.** The backend connects as
`service_role`, which *bypasses RLS entirely*. So RLS defends against someone hitting the
Supabase REST API directly with a leaked anon key; it does nothing about a hole in this API.
Do not read "RLS enabled" as "tenants are isolated" — that is what §3 and §12 are for.

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
- ~~**S4** enable Supabase RLS / move writes behind service key.~~ **Done** — RLS on,
  backend authenticates as `service_role`. Read the caveat in §4.
- `ALLOWED_ORIGINS` is unset, so CORS is open to every origin and the server warns at boot.
  Deliberately not set: the web client deploys to a Vercel domain that is not fixed here, and
  a wrong value breaks it. Low risk because the session travels in a header, not a cookie, so
  a third-party page still cannot read anything. **If you ever set it, it must include
  `https://eastindicatea.com`** or the orders admin page stops working.
- `POST /api/inventory/scan-purchase` and `POST /api/products/identify-photo` are the only
  two routes with no shop scope at all. That is correct — they are pure OCR/AI and touch no
  shop data — but do not add anything to them that reads the database.
- **A2** paid Supabase/Render (or rely on keep-warm) before many paid shops.
- Payment **collection** (in-app money movement) needs Razorpay + registered entity + KYC
  — deferred. Current "payment request" = free WhatsApp + `upi://` deeplink (no gateway, no KYC).

---

## 9. Tax stance (legal — do not change without reason)

GSTR-1 includes only GST invoices. **ITR/P&L turnover includes non-GST (cash) sales**
— excluding them = under-reporting income = illegal. 44AD updated AY 2026-27 (6% digital /
8% cash, ₹3 Cr limit). **GST place of supply is now correct for shipped orders (2026-08-14).** It was not, and
this mattered: every inter-state online order was billed CGST+SGST at the seller's own
state. The total collected was right — which is why nothing looked wrong — but the heads
were not, so the buyer could not take credit and GSTR-1 would not reconcile. A defect on
the face of a legal document.

`backend/lib/gstPlace.js` is right that for a *counter* sale to an unregistered buyer the
place of supply is the shop's own state; the goods are handed over there. An online order is
not a counter sale: where a supply involves movement of goods, place of supply is where that
movement terminates (CGST Act s.10(1)(a)). `backend/lib/pincodeState.js` derives the buyer's
state from the delivery pincode and the webhook passes it as `placeOfSupply`.

This only became possible once orders stored the address in discrete columns — the pincode
used to be flattened into one printable line before it reached the backend.

**Where it will not guess.** Postal circles match states at two digits for most of India, but
Uttarakhand sits inside Uttar Pradesh's range, Chhattisgarh inside Madhya Pradesh's, Goa
inside Maharashtra's, and the north-east shares one block — resolved at three digits. Andhra
Pradesh and Telangana were one state until 2014 and their pincodes interleave, so those
return `null` and the counter-sale default stands. A wrong state on a tax invoice is worse
than a conservative one: being unsure is recoverable, being wrong and certain is not.

---

## 10. Library modules (`backend/lib/`)

Pure, testable, no Express and no Supabase. `server.js` is a single large file; anything
worth reasoning about independently lives here so it can be tested without booting the app.

| Module | What it decides |
|---|---|
| `auth.js` | sessions, shop scope, record ownership, staff permissions (§3) |
| `opsResearch.js` | the operations-research formulas — EOQ, reorder point, ABC, newsvendor, turnover, DSO, confidence |
| `advice.js` | which of those numbers is worth saying, in what order, and when to stay quiet (§13) |
| `pincodeState.js` | delivery pincode → state, for GST place of supply (§9) |
| `shipping.js` | courier adapter interface + order lifecycle rules (§11) |
| `gstPlace.js` | CGST+SGST vs IGST |
| `money.js`, `credit.js`, `creditNote.js`, `debitNote.js`, `ageing.js`, `cashbook.js`, `csv.js`, `tallyExport.js` | billing, credit and export arithmetic |

**`opsResearch.js` and `advice.js` are deliberately separate.** The formulas are settled
results that do not change; the policy about *this* business will.

---

## 11. Online orders and fulfilment (2026-08-13)

Before this, a paid website order became an invoice and then vanished. An invoice records
what was sold; it has no field for where the parcel goes and no state that changes after it
is raised. Nothing could answer "which orders still need packing", and **the delivery
address the website collected was being discarded on arrival**.

**`online_orders` is a separate table, not columns on `invoices`.** They have different
lifetimes and different truths: an invoice is fixed once raised, an order moves for days
afterwards, and a cancelled order still leaves its invoice behind. They share one link.
The address is stored as *discrete columns* because a carrier wants pincode and state on
their own — pincode decides serviceability, rate, and (see §9) the tax split.
Unique on `(shop_id, external_ref)`, which is what makes the webhook safe to retry.

**Lifecycle:** `paid → packed → shipped → delivered`, `cancelled` reachable from any of
them. Enforced in `shipping.js`; status only moves forward, so nothing can erase that a
parcel went out — including a confused carrier response.

**Three rules worth keeping.** The address is validated *before* the carrier is called, so a
missing pincode is reported plainly instead of arriving as an opaque rejection after the
shopkeeper has committed. Booking twice is refused (409) rather than made idempotent — a
second booking strands the first AWB and a parcel already handed over cannot be un-handed.
Recording the order **cannot fail the webhook**: money is taken and stock already
decremented, so a bookkeeping row must never make the caller retry a billing operation; it
logs, and the daily reconcile replays it.

**Carrier is behind an adapter.** `name / isConfigured / createShipment / track`. The mock
is the default so a fresh deploy books nothing real by accident; it returns an obviously
fake `MOCK…` AWB and sets `mock:true`, which both UIs surface loudly. **A named-but-
unconfigured adapter is a 503, never a silent fall back to the mock** — falling back would
hand a shop a fake AWB it believed was real. Adding a real courier = one adapter file.

**Routes:** `GET /api/orders/:shopId` (defaults to pending), `GET /api/orders/detail/:id`,
`POST /api/orders/:id/ship`, `PATCH /api/orders/:id/status`, `GET /api/orders/:id/track`.
**UIs:** mobile Orders tab (🚚 — stock owns 📦) and `eastindicatea.com/admin.html`, which
signs in with the same FastBahi shop login and prints packing slips one per sheet.

---

## 12. Multi-tenant isolation (2026-08-13/14)

Audited route by route. Of 84 routes: 7 public (no shop data), 41 scoped by path, 18 by a
record-ownership lookup, 16 by `shopId` in the body, 2 unscoped — the OCR/AI pair, which
touch no shop data.

Everything a second shop would otherwise have shared is now its own:

| | How |
|---|---|
| Data | `shop_id` on every shop table; `designs`/`invoice_items` via parent |
| Session | JWT scoped to one shop; another shop's data is 403/404 |
| **Webhook credential** | `shops.webhook_secret`, per shop |
| **Courier account** | `shops.shipping_provider` + `shipping_config`, per shop |

**Why per-shop webhook secrets.** The webhook authenticated with one shared
`ONLINE_ORDER_SECRET` and then read `shopId` from the body. With one shop that is fine.
With two it is a cross-tenant hole: every shop's website necessarily holds the same secret,
so any of them could post an order into any other shop's inventory by naming a different
`shopId`. The shop is now read first and the secret compared against *that shop's own*, so
the secret proves **which** shop is calling. Registration mints one, so a new shop is never
left on the shared value. The shared value is still consulted for a shop that has none, and
every such fallback is logged by shop id — **once that log is quiet, delete
`ONLINE_ORDER_SECRET` from the host.**

**Why per-shop courier config.** A courier account is a shop's own commercial relationship —
its rates, its pickup, its liability — and cannot be shared any more than a bank account.
A shop's own credentials beat anything platform-wide, so a leftover token cannot quietly
book on the wrong account. There is deliberately **no default provider**.

**Still platform-wide, and correctly so:** the storefront. FastBahi has zero storefront
routes and is not an e-commerce platform. East Indica's shop is a hand-built Vercel site
that talks to this API. See §14.

---

## 13. Decisions engine (`computeDecisions` + `advice.js`)

`GET /api/decisions/:shopId`, surfaced in the app's Decisions screen. **No figure it
produces comes from a language model** — every number is derived, checkable and arguable.

Five functions in `opsResearch.js` had been written, tested and never called. They are now
wired:

- **Order size from EOQ**, `Q* = sqrt(2DS/H)` (Harris/Wilson; MIT OCW ESD.273J). It replaced
  "cover the lead time plus a cycle", which ignores what an order costs to place and what
  stock costs to hold — precisely the trade-off EOQ settles.
  **Two bounds, and their order matters:** the cap (a quarter's demand) applies to the EOQ
  only, and the floor (clear the reorder point) is applied last. Clamping the other way let
  the cap cut into the floor and produced the one useless answer — *order this much, and
  still be short*. A test asserts it; it caught exactly that bug.
- **Cash-aware restock.** Ranked by urgency against the cash actually in the open session's
  drawer, and cut off where it runs out. Advice that cannot be paid for is not advice.
  Greedy, not an exact knapsack: solving it exactly would be false precision over estimated
  costs, and buying what runs out first is what a person does anyway.
  **When no session is open the section is absent, never zero** — unknown must not read as
  none, or everything would look unaffordable.
- **Margin leaks.** Products at or below cost, which hide inside a healthy revenue line.
  Margin is `(p−c)/p`, on price — markup on cost flatters every trade.
- **Online demand** folded into the same shelf, since a website order draws down the same
  stock and was being left out on exactly the products that are growing.

Sources are stated at the top of `advice.js`. `confidenceFrom` gates everything: a standard
deviation from four observations is arithmetic, not evidence, and the engine stays quiet
rather than dressing a guess up as a number.

---

## 14. What FastBahi is not

It is **not** a Shopify competitor and should not become one. There are **no storefront
routes** — no catalogue-to-web, cart, checkout, theme or domain handling. Each shop brings
its own store; FastBahi is the back office behind it.

The defensible position is the opposite one: *a billing app that pulls your online orders in
from anywhere*. Shopify does not do GST, udhari or a cashbook; Vyapar does not pull online
orders. Both of those are already built here.

**Two things to know before selling online storefronts to other shops.** COD is structurally
expensive in India — around 26% RTO against under 2% prepaid, roughly ₹561 lost per return —
so East Indica's prepaid-only checkout is protection, not a gap. And if money ever flows
through the platform's own account and is disbursed to shops, that is **payment aggregation
and needs an RBI PA licence (₹15 crore net worth)**. Each shop connecting its own Razorpay
avoids this entirely.

---

## 15. Adversarial testing (`redteam.js`)

`npm run redteam` boots the real server against an in-memory database and attacks it.
41 cases across eight categories: authentication, IDOR, server-to-server secrets, mass
assignment, prototype pollution, business logic, denial of service, information disclosure.
**It exits non-zero if anything gets through**, so a protection quietly removed later fails
here rather than passing a review. `npm run check` = syntax + unit tests + red team.

It is not a checklist. Every case is a request that either gets in or does not — a forged
`alg:none` token, an expired one, a shop id smuggled through the body, a `__proto__` key,
a staff member without `canEditPrice` billing at their own price, a 3 MB body, twenty-five
PIN guesses.

**It found a live issue on its first run.** `GET /api/shops/:shopId` returned
`webhook_secret` and `shipping_config`. Each call site fetched the row with `select("*")`
and removed `pin_hash` by destructuring, which was correct when `pin_hash` was the only
secret and silently wrong the moment secret columns were added. That defeated the reason
the webhook secret is write-only: a stolen session could read it and keep posting orders
after the session was revoked, and `shipping_config` carries the courier account's
credentials.

Fixed with one `publicShop()` helper listing the secret columns, so a future secret column
is removed everywhere by adding it to that list rather than by finding six destructurings.
The response keeps a `hasWebhookSecret` boolean, because whether one exists is useful to
the app and the value is not.

---

## 16. Stock and the storefront (2026-08-15)

**The order used to be paid for before anyone checked the shelf.** `createInvoiceCore`
refuses to oversell, but it runs inside the sync webhook, which fires *after* Razorpay has
taken the money. That refusal is a 4xx, so `_lib.postToFastBill` correctly does not retry
it, and `verify-payment` treats the sync as best-effort so it does not block the success
page. The customer was charged, shown a confirmation, and no invoice, no stock movement and
no `online_orders` row existed anywhere — the shopkeeper saw nothing. The nightly reconcile
replayed it and failed identically, so it never healed.

Two things now sit in front of that.

**`POST /api/webhooks/stock-check`** — same per-shop shared secret as the order webhook,
because what a shop has on its shelf is not public and this is server to server. Returns
which lines cannot be filled. An unknown SKU is reported as unavailable rather than ignored:
silently dropping a line would let someone pay for an order missing an item.
`create-order.js` calls it *before* Razorpay.

**`GET /api/stock`** on the storefront (Vercel) — asks the same endpoint server-side and
returns **availability, not quantities**. Whether a shop can sell you something is public;
how many are left is a competitor's view of throughput and nothing on the page needs it.
The webhook secret never reaches the browser. `shop.html` and `product.html` withhold the
Add button for anything out of stock, and it returns on its own when the shelf refills —
neither page contains a list of what is available, so nobody has to remember to edit one.

**Failing to reach either check does not block the sale.** Refusing real orders, or hiding
the catalogue, because a free-tier backend was asleep would cost more than the rare oversell
it prevents — and the post-payment check still catches that case. This narrows the window;
it does not claim to close it.

**Known, and deliberately left:** eight legacy single-size keys (`plainctc`, `elaichi`,
`ginger`, `masala`, `assam`, `darjeeling`, `nilgiri`, `greentea`) are priced on the site for
older carts but were never seeded in FastBahi, so they read as out of stock. That is the
correct outcome — the alternative was silently taking money for them. Seed them if those
carts should work. `PRODUCT_KEYS` in `api/_lib.js` is the single list both pricing and the
stock lookup read from, so a product added to one cannot be forgotten in the other.

The in-memory cache in `api/stock.js` only helps when a warm Vercel instance serves
consecutive requests; the `Cache-Control: max-age=60` header is what actually keeps traffic
off a sleeping backend.

---

## 17. Telling the customer where their order is (2026-08-17)

A shopkeeper could mark an order packed, book a courier and ship it, and the customer learned
none of it — `orders.html` only ever asked Razorpay whether the payment had gone through. The
fulfilment state was in the database and invisible to the one person waiting for the parcel.

**`POST /api/webhooks/order-status`** — keyed on the payment id the customer already holds,
guarded by the same per-shop secret as the other server-to-server routes. Returns the
fulfilment state and tracking number and **nothing else**: not the delivery address, not the
amount, nothing about the shop's other orders.

Two answers it gives on purpose. **Not found is normal**, not an error — the sync may not have
run yet, and the storefront falls back to the payment state. And **a mock booking's AWB is
withheld**: a tracking number that tracks nothing is worse than none, especially to someone
waiting for a parcel.

`api/order-status.js` on the storefront asks it server-side, so the secret never reaches the
browser. It resolves the order id in the customer's link to the captured payment id first,
because the backend keys on the payment — that is what the gateway signs and what makes the
sync idempotent. `orders.html` shows *Being Prepared / Packed / Shipped / Delivered* with the
courier and AWB, and falls back to payment state when fulfilment is unknown rather than
inventing a stage.

### An operational note for whoever works on this next

The scratchpad clone under `/private/tmp` has been silently eaten twice by macOS tmp cleanup —
`.git/HEAD`, `.git/config` and about half of `backend/lib/` removed by age while the working
tree looked fine. Both times the symptom was a test failing with
`Cannot find module './opsResearch'`, not an obvious filesystem error. **The remote is the
source of truth; re-clone rather than trying to repair.** Commit early — uncommitted work
there is not safe.
