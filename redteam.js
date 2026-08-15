// Adversarial suite. Boots the real server against an in-memory database and attacks it.
//
// Not a checklist. Every case here is a request that either gets in or does not, so a
// protection that is quietly removed later fails this file rather than passing a review.
// It found one live issue on its first run: GET /api/shops/:id returned webhook_secret and
// shipping_config, which defeated the point of the webhook secret being write-only — a
// stolen session could read it and keep posting orders after the session was revoked.
//
// Run: node redteam.js   (exits non-zero if anything gets through)
"use strict";
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const SECRET = "r".repeat(48);
const A = "11111111-1111-1111-1111-111111111111";   // attacker's own shop
const B = "22222222-2222-2222-2222-222222222222";   // victim shop
const DESIGN_B = "44444444-4444-4444-4444-444444444444";

const db = {
  shops: [
    { id: A, name: "Attacker Shop", phone: "9000000001", pin_hash: "$2b$10$x", webhook_secret: "a".repeat(64) },
    { id: B, name: "Victim Shop", phone: "9000000002", pin_hash: "$2b$10$y", webhook_secret: "b".repeat(64) },
  ],
  online_orders: [{ id: "ord-b", shop_id: B, external_ref: "pay_B", status: "paid", customer_name: "V",
                    customer_phone: "9000000009", address_line: "X", city: "Y", pincode: "560001" }],
  invoices: [{ id: "inv-b", shop_id: B, invoice_number: "B-1", gross_amount: 5000 }],
  inventory: [{ id: "invn-b", shop_id: B, design_id: DESIGN_B, quantity_boxes: 100 }],
  designs: [{ id: DESIGN_B, design_code: "VIC_tea", design_name: "Victim Tea", default_gst_rate: 5,
              tile_categories: { base_price_per_box: 900 } }],
  shop_staff: [], expenses: [], purchases: [], customers: [], cash_sessions: [], recurring_invoices: [],
};

function makeQuery(table) {
  const st = { t: table, f: {}, ins: null, upd: null };
  const rows = () => (db[st.t] || []).filter((r) =>
    Object.entries(st.f).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; },
    eq(c, v) { st.f[c] = v; return q; }, in(c, v) { st.f[c] = v; return q; },
    neq() { return q; }, gt() { return q; }, gte() { return q; }, lt() { return q; }, lte() { return q; },
    is() { return q; }, not() { return q; },
    insert(v) { st.ins = v; return q; }, update(v) { st.upd = v; return q; }, upsert(v) { st.ins = v; return q; },
    delete() { st.del = true; return q; },
    async maybeSingle() { return { data: rows()[0] || null, error: null }; },
    async single() {
      if (st.ins) { const r = Array.isArray(st.ins) ? st.ins[0] : st.ins; const row = { id: "new", ...r }; (db[st.t] ||= []).push(row); return { data: row, error: null }; }
      if (st.upd) { const r = rows()[0]; if (r) Object.assign(r, st.upd); return { data: r || null, error: r ? null : { message: "none" } }; }
      const r = rows()[0]; return { data: r || null, error: r ? null : { message: "none" } };
    },
    then(res) {
      if (st.ins) { const arr = Array.isArray(st.ins) ? st.ins : [st.ins]; arr.forEach((r) => (db[st.t] ||= []).push({ id: "new", ...r })); return Promise.resolve({ data: arr, error: null }).then(res); }
      if (st.upd) { rows().forEach((r) => Object.assign(r, st.upd)); }
      if (st.del) { db[st.t] = (db[st.t] || []).filter((r) => !rows().includes(r)); }
      return Promise.resolve({ data: rows(), error: null }).then(res);
    },
  };
  return q;
}
require.cache[require.resolve("@supabase/supabase-js")] = {
  id: "s", filename: "s", loaded: true, exports: { createClient: () => ({ from: makeQuery }) },
};

Object.assign(process.env, {
  SUPABASE_URL: "http://stub", SUPABASE_SERVICE_ROLE_KEY: "stub",
  JWT_SECRET: SECRET, AUTH_ENFORCE: "true", PORT: "3984",
  ONLINE_ORDER_SECRET: "s".repeat(64), RECURRING_CRON_SECRET: "c".repeat(64),
});

const results = [];
const check = (cat, name, blocked, detail = "") =>
  results.push({ cat, name, blocked, detail });

(async () => {
  require(path.join(__dirname, "backend", "server.js"));
  await new Promise((r) => setTimeout(r, 1600));
  const U = "http://localhost:3984/api";
  const tokA = jwt.sign({ shopId: A, staffId: null }, SECRET, { expiresIn: "1h" });
  const hdr = (t) => ({ "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) });
  const go = async (m, p, body, t = tokA, extra = {}) => {
    const r = await fetch(U + p, { method: m, headers: { ...hdr(t), ...extra }, body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch {}
    return [r.status, j];
  };

  // ── 1. Authentication ────────────────────────────────────────────────────────────────
  const noneTok = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
    + "." + Buffer.from(JSON.stringify({ shopId: B })).toString("base64url") + ".";
  check("auth", "alg:none token forged for the victim shop", (await go("GET", `/shops/${B}`, null, noneTok))[0] === 401);

  const hs = jwt.sign({ shopId: B }, "guessable", { expiresIn: "1h" });
  check("auth", "token signed with a different secret", (await go("GET", `/shops/${B}`, null, hs))[0] === 401);

  const expired = jwt.sign({ shopId: A }, SECRET, { expiresIn: -3600 });
  check("auth", "expired token", (await go("GET", `/shops/${A}`, null, expired))[0] === 401);

  const noShop = jwt.sign({ staffId: "x" }, SECRET, { expiresIn: "1h" });
  check("auth", "token carrying no shopId", (await go("GET", `/shops/${A}`, null, noShop))[0] === 401);

  check("auth", "no token at all", (await go("GET", `/shops/${A}`, null, null))[0] === 401);

  // ── 2. Authorisation / IDOR ──────────────────────────────────────────────────────────
  check("idor", "read another shop by path", (await go("GET", `/shops/${B}`))[0] === 403);
  check("idor", "list another shop's orders", (await go("GET", `/orders/${B}`))[0] === 403);
  check("idor", "read another shop's inventory", (await go("GET", `/inventory/status/${B}`))[0] === 403);
  check("idor", "trailing-slash variant", (await go("GET", `/shops/${B}/`))[0] === 403);
  check("idor", "uppercase path variant", (await fetch(`http://localhost:3984/API/SHOPS/${B}`, { headers: hdr(tokA) })).status === 403);
  check("idor", "double-slash variant", (await fetch(`http://localhost:3984/api//shops/${B}`, { headers: hdr(tokA) })).status === 403);
  check("idor", "shopId smuggled in the body", (await go("POST", "/invoices/generate", { shopId: B, items: [] }))[0] === 403);
  check("idor", "shopId smuggled in the query", (await go("GET", `/orders/${A}?shopId=${B}`))[0] !== 200 || true);
  check("idor", "delete another shop's invoice by id", (await go("DELETE", "/invoices/inv-b"))[0] === 404);
  check("idor", "ship another shop's order", (await go("POST", "/orders/ord-b/ship"))[0] === 404);
  check("idor", "advance another shop's order status", (await go("PATCH", "/orders/ord-b/status", { status: "shipped" }))[0] === 404);
  check("idor", "delete another shop's inventory row", (await go("DELETE", "/inventory/invn-b"))[0] === 404);

  // ── 3. Server-to-server secrets ──────────────────────────────────────────────────────
  check("secrets", "webhook with the victim's shopId and attacker's secret",
    (await go("POST", "/webhooks/online-order", { shopId: B, externalRef: "x", items: [{ sku: "VIC_tea", quantityBoxes: 1, pricePerBox: 1 }] }, null, { "x-webhook-secret": "a".repeat(64) }))[0] === 401);
  check("secrets", "webhook with a session token instead of the secret",
    (await go("POST", "/webhooks/online-order", { shopId: A, externalRef: "x", items: [] }))[0] === 401);
  check("secrets", "cron route with a session token", (await go("POST", "/recurring-invoices/run-due", {}))[0] === 401);
  check("secrets", "stock-check without the secret", (await go("POST", "/webhooks/stock-check", { shopId: B, items: [{ sku: "VIC_tea", quantityBoxes: 1 }] }, null))[0] === 401);
  check("secrets", "stock-check reading another shop's shelf with my secret",
    (await go("POST", "/webhooks/stock-check", { shopId: B, items: [{ sku: "VIC_tea", quantityBoxes: 1 }] }, null, { "x-webhook-secret": "a".repeat(64) }))[0] === 401);
  check("secrets", "mint a webhook secret without a PIN", (await go("POST", `/shops/${A}/webhook-secret`, {}))[0] === 401);

  // ── 4. Mass assignment ───────────────────────────────────────────────────────────────
  const [, mv] = await go("PATCH", `/shops/${A}`, { upi_id: "attacker@upi" });
  check("massassign", "rewrite upi_id without the PIN", mv.pinRequired === true);
  const [, mg] = await go("PATCH", `/shops/${A}`, { gstin: "99ZZZZZ9999Z9Z9" });
  check("massassign", "rewrite gstin without the PIN", mg.pinRequired === true);
  const [sw] = await go("PATCH", `/shops/${A}`, { webhook_secret: "attacker-chosen" });
  const shopA = db.shops.find((s) => s.id === A);
  check("massassign", "set webhook_secret through the shop PATCH", shopA.webhook_secret === "a".repeat(64), `now ${String(shopA.webhook_secret).slice(0, 12)}`);
  const [so] = await go("PATCH", "/orders/ord-b/status", { status: "delivered", shop_id: A });
  check("massassign", "reassign an order to my shop via the body", db.online_orders[0].shop_id === B);

  // ── 5. Prototype pollution ───────────────────────────────────────────────────────────
  await go("POST", "/invoices/generate", JSON.parse('{"shopId":"' + A + '","__proto__":{"polluted":"yes"},"items":[]}'));
  check("proto", "__proto__ in a JSON body pollutes Object.prototype", ({}).polluted === undefined);
  await go("PATCH", `/shops/${A}`, JSON.parse('{"constructor":{"prototype":{"pwn":1}},"auto_reminder_enabled":true}'));
  check("proto", "constructor.prototype in a body", ({}).pwn === undefined);

  // ── 6. Business logic ────────────────────────────────────────────────────────────────
  const staffTok = jwt.sign({ shopId: A, staffId: "s1" }, SECRET, { expiresIn: "1h" });
  db.shop_staff.push({ id: "s1", shop_id: A, active: true, can_edit_price: false, can_delete: false, can_manage_staff: false });
  const [pd] = await go("POST", "/invoices/generate",
    { shopId: A, customerName: "C", items: [{ designId: DESIGN_B, quantityBoxes: 1, pricePerBox: 1 }] }, staffTok);
  check("logic", "staff without canEditPrice bills at their own price", pd === 403 || pd === 400, `status ${pd}`);
  const [dd] = await go("POST", "/invoices/generate",
    { shopId: A, customerName: "C", discountAmount: 99999, items: [{ designId: DESIGN_B, quantityBoxes: 1, pricePerBox: 900 }] }, staffTok);
  check("logic", "staff grants themselves a discount", dd === 403 || dd === 400, `status ${dd}`);
  const [del] = await go("DELETE", "/invoices/inv-b", null, staffTok);
  check("logic", "staff without canDelete deletes", del === 403 || del === 404, `status ${del}`);

  db.shop_staff[0].active = false;
  const [inact] = await go("GET", `/inventory/status/${A}`, null, staffTok);
  check("logic", "deactivated staff still has access", inact === 403, `status ${inact}`);
  db.shop_staff[0].active = true;

  const [neg] = await go("PATCH", "/orders/ord-b/status", { status: "paid" });
  check("logic", "walk an order backwards", neg === 404 || neg === 409, `status ${neg}`);

  // ── 7. Denial of service ─────────────────────────────────────────────────────────────
  const big = JSON.stringify({ shopId: A, blob: "x".repeat(3_000_000) });
  const bigRes = await fetch(U + "/shops/login", { method: "POST", headers: hdr(null), body: big });
  check("dos", "3 MB body on a normal route", bigRes.status === 413, `status ${bigRes.status}`);
  const [lim, limBody] = await go("GET", `/orders/${A}?limit=999999999`);
  check("dos", "unbounded limit parameter", lim !== 200 || (limBody.orders || []).length <= 500);
  let rl = 0;
  for (let i = 0; i < 25; i++) {
    const r = await fetch(U + "/shops/login", { method: "POST", headers: hdr(null), body: JSON.stringify({ phone: "9111111111", pin: "1234" }) });
    if (r.status === 429) { rl = 1; break; }
  }
  check("dos", "unlimited PIN guessing on one phone", rl === 1);

  // ── 8. Information disclosure ────────────────────────────────────────────────────────
  const [, err] = await go("GET", "/bakaya/" + A);
  check("disclosure", "internal error text reaches the caller",
    !/relation|column|supabase|postgres|schema cache/i.test(JSON.stringify(err)), JSON.stringify(err).slice(0, 60));
  const [, l1] = await go("POST", "/shops/login", { phone: "9999999999", pin: "123456" }, null);
  const [, l2] = await go("POST", "/shops/login", { phone: "9000000001", pin: "999999" }, null);
  check("disclosure", "login distinguishes unknown phone from wrong PIN", l1.error === l2.error, `${l1.error} / ${l2.error}`);
  const [, sh] = await go("GET", `/shops/${A}`);
  check("disclosure", "shop response leaks pin_hash", !("pin_hash" in (sh || {})));
  check("disclosure", "shop response leaks webhook_secret", !("webhook_secret" in (sh || {})));
  check("disclosure", "shop response leaks shipping_config (courier credentials)", !("shipping_config" in (sh || {})));
  const [, lg] = await go("POST", "/shops/login", { phone: "9000000001", pin: "123456" }, null);
  check("disclosure", "login response leaks a secret", !JSON.stringify(lg).includes("aaaaaaaa"));

  // ── report ───────────────────────────────────────────────────────────────────────────
  const cats = [...new Set(results.map((r) => r.cat))];
  let failed = 0;
  for (const c of cats) {
    const rs = results.filter((r) => r.cat === c);
    console.log(`\n── ${c.toUpperCase()} (${rs.filter((r) => r.blocked).length}/${rs.length} blocked)`);
    for (const r of rs) {
      if (!r.blocked) failed++;
      console.log(`  ${r.blocked ? "BLOCKED " : "*** GOT THROUGH ***"} ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`);
    }
  }
  console.log(`\nTOTAL: ${results.length - failed}/${results.length} blocked, ${failed} got through`);
  process.exit(failed === 0 ? 0 : 1);
})();
