// Runs computeDecisions against realistic data.
//
// advice.js has unit tests, but those cover the functions in isolation, not the wiring: the
// engine reads eight tables, and a rename or a reordered destructure breaks it silently
// while every unit test still passes. This asserts the whole path — 90 days of sales in,
// EOQ quantities, affordability, margin leaks and online demand out.
//
// Run: node decisions.e2e.js   (exits non-zero on any failure)
"use strict";
const path = require("path");
const jwt = require("jsonwebtoken");

const SECRET = "z".repeat(48);
const SHOP = "11111111-1111-1111-1111-111111111111";
const D1 = "aaaaaaaa-0000-0000-0000-000000000001";   // fast mover, sold below cost
const D2 = "aaaaaaaa-0000-0000-0000-000000000002";   // healthy, needs restock
const D3 = "aaaaaaaa-0000-0000-0000-000000000003";   // dead stock

// 90 days of sales so confidenceFrom() reports something usable.
const invoices = [];
for (let day = 0; day < 90; day++) {
  const created = new Date(Date.now() - day * 86400000).toISOString();
  invoices.push({
    id: `inv${day}`, created_at: created, payment_status: "paid",
    invoice_items: [
      { design_id: D1, quantity_boxes: 3, price_per_box: 290 },
      ...(day % 2 === 0 ? [{ design_id: D2, quantity_boxes: 2, price_per_box: 900 }] : []),
    ],
  });
}

const db = {
  invoices,
  inventory: [
    { design_id: D1, quantity_boxes: 12, last_cost_price: 300,
      designs: { design_code: "plainctc", design_name: "Pehli", unit_type: "packs",
                 tile_categories: { base_price_per_box: 290 } } },       // price < cost
    { design_id: D2, quantity_boxes: 6, last_cost_price: 500,
      designs: { design_code: "milan", design_name: "Milan", unit_type: "packs",
                 tile_categories: { base_price_per_box: 900 } } },
    { design_id: D3, quantity_boxes: 80, last_cost_price: 200,
      designs: { design_code: "nilgiri", design_name: "Nilgiri", unit_type: "packs",
                 tile_categories: { base_price_per_box: 449 } } },       // never sells
  ],
  purchases: [
    { design_id: D1, quantity_boxes: 100, cost_per_box: 300, purchase_date: "2026-05-01" },
    { design_id: D2, quantity_boxes: 60, cost_per_box: 500, purchase_date: "2026-05-01" },
    { design_id: D3, quantity_boxes: 80, cost_per_box: 200, purchase_date: "2026-02-01" },
  ],
  expenses: [
    { amount: 60000, expense_date: new Date().toISOString(), category: "rent" },
    { amount: 30000, expense_date: new Date().toISOString(), category: "salary" },
    { amount: 9000, expense_date: new Date().toISOString(), category: "marketing" },
  ],
  online_orders: [
    { status: "paid", created_at: new Date().toISOString(), items: [{ sku: "EIT_milan", quantityBoxes: 4 }] },
    { status: "shipped", created_at: new Date().toISOString(), items: [{ sku: "EIT_milan", quantityBoxes: 2 }] },
    { status: "cancelled", created_at: new Date().toISOString(), items: [{ sku: "EIT_milan", quantityBoxes: 99 }] },
  ],
  cash_sessions: [{ opening_cash: 5000, cash_sales: 12000, cash_collections: 1000, cash_expenses: 2000, cash_payouts: 1000 }],
  shops: [{ id: SHOP, name: "Test", gstin: "10ATEPD4915G1ZC" }],
  customers: [], shop_staff: [],
};

function makeQuery(table) {
  const st = { t: table, f: {} };
  const rows = () => (db[st.t] || []).filter((r) =>
    Object.entries(st.f).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; },
    eq(c, v) { if (c !== "shop_id") st.f[c] = v; return q; },
    in(c, v) { st.f[c] = v; return q; },
    neq() { return q; }, gt() { return q; }, gte() { return q; }, lt() { return q; }, lte() { return q; },
    is() { return q; }, not() { return q; }, update() { return q; }, insert() { return q; },
    async maybeSingle() { return { data: rows()[0] || null, error: null }; },
    async single() { const r = rows()[0]; return { data: r || null, error: r ? null : { message: "none" } }; },
    then(res) { return Promise.resolve({ data: rows(), error: null }).then(res); },
  };
  return q;
}
require.cache[require.resolve("@supabase/supabase-js")] = {
  id: "s", filename: "s", loaded: true, exports: { createClient: () => ({ from: makeQuery }) },
};
Object.assign(process.env, {
  SUPABASE_URL: "http://stub", SUPABASE_SERVICE_ROLE_KEY: "stub",
  JWT_SECRET: SECRET, AUTH_ENFORCE: "true", PORT: "3983",
});

let PASSES = 0; const FAILS = [];
const out = (l, ok, x = "") => {
  if (ok) PASSES++; else FAILS.push(l);
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${x ? "  " + x : ""}`);
};

(async () => {
  require(path.join(__dirname, "backend", "server.js"));
  await new Promise((r) => setTimeout(r, 1600));
  const tok = jwt.sign({ shopId: SHOP }, SECRET, { expiresIn: "1h" });
  const res = await fetch(`http://localhost:3983/api/decisions/${SHOP}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const d = await res.json().catch(() => ({}));

  out("the route answers at all", res.status === 200, `status ${res.status} ${d.error || ""}`);
  if (res.status !== 200) { console.log(JSON.stringify(d).slice(0, 300)); process.exit(1); }

  const recs = d.recommendations || [];
  out("it produces recommendations", recs.length > 0, `${recs.length}`);

  const restocks = recs.filter((r) => r.type === "restock");
  out("restock advice appears", restocks.length > 0, `${restocks.length}`);
  out("restock says a quantity, not just 'soon'", restocks.every((r) => /Order \d+/.test(r.title)),
    restocks[0]?.title || "");
  out("restock carries what it will cost", restocks.every((r) => typeof r.estimatedCost === "number"),
    JSON.stringify(restocks[0]?.estimatedCost));

  out("affordability is present and uses real cash", !!d.affordability && d.affordability.cashOnHand === 15000,
    JSON.stringify(d.affordability?.cashOnHand));
  out("affordability ranks what to buy first", Array.isArray(d.affordability?.buyFirst),
    (d.affordability?.buyFirst || []).slice(0, 2).join(" | "));

  const losing = d.margins?.losing || [];
  out("the below-cost product is caught", losing.some((m) => m.sku === "plainctc"),
    losing.map((m) => `${m.sku} ${m.marginPct}%`).join(", "));
  out("the healthy product is not flagged", !losing.some((m) => m.sku === "milan"));

  out("online demand is counted", d.onlineDemand?.perSku?.EIT_milan?.units === 6,
    JSON.stringify(d.onlineDemand?.perSku?.EIT_milan));
  out("a cancelled online order is excluded", (d.onlineDemand?.perSku?.EIT_milan?.units || 0) === 6);

  out("dead stock is reported", recs.some((r) => r.type === "dead_stock"),
    recs.filter((r) => r.type === "dead_stock").map((r) => r.title).join(", ") || "none");

  out("methodology states no LLM produced the numbers", /language model/i.test(d.methodology || ""));

  out("break-even is reported", !!d.breakEven, JSON.stringify(d.breakEven?.breakEvenRevenuePerMonth));
  out("only rent and salary counted as fixed (marketing excluded)", d.breakEven?.fixedPerMonth === 30000,
    JSON.stringify(d.breakEven?.fixedPerMonth));
  out("break-even states its assumption", /rent/i.test(d.breakEven?.assumption || ""));

  // The cash card must vanish, not read zero, when no session is open.
  db.cash_sessions = [];
  const res2 = await fetch(`http://localhost:3983/api/decisions/${SHOP}`, { headers: { Authorization: `Bearer ${tok}` } });
  const d2 = await res2.json();
  out("with no cash session open, affordability is absent not zero", d2.affordability === null,
    JSON.stringify(d2.affordability));

  const failed = FAILS.length;
  console.log(`\nTOTAL: ${PASSES}/${PASSES + failed} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();
