const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const { createWorker } = require("tesseract.js");

// Rate limiter. This is a required dependency, not an optional one: it is the only thing
// standing between a 4-6 digit PIN and an offline-speed brute force. It used to be wrapped
// in try/catch with a no-op fallback, which meant a failed install silently shipped a
// server with no rate limiting at all — a security control that disables itself on error
// is worse than none, because nothing looks broken. Fail loudly at boot instead.
const rateLimit = require("express-rate-limit");
const makeLimiter = (max, windowMs) =>
  rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests, thodi der baad try karein" } });
// Tight limit on auth (brute-force) + expensive AI routes (cost abuse).
const authLimiter = makeLimiter(20, 15 * 60 * 1000);   // 20 / 15min per IP
const aiLimiter = makeLimiter(30, 15 * 60 * 1000);     // 30 / 15min per IP
// Writes that change money-critical or identity fields.
const writeLimiter = makeLimiter(60, 15 * 60 * 1000);  // 60 / 15min per IP

// Per-account login limit, keyed on the phone being logged into rather than the caller's
// address. An IP-keyed limit alone is only as trustworthy as the hop count we infer from
// X-Forwarded-For: probing production showed that merely sending that header lands a
// caller in a second bucket, doubling the attempts available. Keying on the phone removes
// the proxy from the question entirely — rotating IPs no longer buys a fresh budget,
// because the target of a PIN brute force is one specific account. 10 tries per 15
// minutes leaves a shopkeeper who fumbles their own PIN plenty of room while capping an
// attacker at a rate that cannot exhaust even a 4-digit space in any useful time.
const loginPhoneLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Requests with no phone cannot authenticate anyway; bucket them together so a flood of
  // malformed bodies still costs the attacker something.
  keyGenerator: (req) => `phone:${String(req.body?.phone || "none")}`,
  message: { error: "Bahut baar galat PIN. 15 minute baad try karein" },
});

const app = express();
const PORT = process.env.PORT || 3001;

// Render (and any managed host) terminates TLS at a proxy, so req.ip is the proxy's
// address unless we trust exactly one forwarding hop. Without this every request looks
// like the same IP and the limiters above throttle all shops together. Trusting a fixed
// hop count (not `true`) keeps X-Forwarded-For unspoofable — a client-supplied header
// cannot shift the perceived IP and slip past the auth limiter.
app.set('trust proxy', 1);

// Middleware
// CORS: restrict to ALLOWED_ORIGINS (comma-separated) when set, else allow all (dev/back-compat).
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : null;
if (!ALLOWED_ORIGINS) {
  console.warn(
    "SECURITY: ALLOWED_ORIGINS is not set — CORS is open to every origin. " +
    "Set it on the host (comma-separated, e.g. https://app.example.com,https://example.com) before serving real shops."
  );
}
app.use(cors({
  origin: ALLOWED_ORIGINS || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body size. 20mb on every route let an unauthenticated caller pin the process's memory
// with a handful of junk requests. Only the routes that carry a base64 image or an
// imported statement need room; everything else is small JSON, so the default is 1mb.
// The large parser is mounted on those paths first — a global 1mb parser would reject
// the upload before the route-level one ever ran.
const LARGE_BODY_PATHS = [
  "/api/inventory/scan-purchase",
  "/api/inventory/photo-identify",
  "/api/products/identify-photo",
  "/api/bank-transactions/import",
];
app.use(LARGE_BODY_PATHS, bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

// Initialize Supabase.
// Prefer the service_role key: the backend is the only database client (no browser or
// mobile client talks to Supabase directly), so it must authenticate as service_role to
// keep full access once Row-Level Security is enabled on every table. Falls back to the
// anon/legacy key when the service key is not set, so this stays backward compatible and
// causes no downtime on deploy — the switch happens the moment SUPABASE_SERVICE_ROLE_KEY
// is added to the environment.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY;
// Misconfigured credentials must not crash the process. createClient() throws on an
// empty URL, which turned a bad env var into a boot loop — the server would die before
// it could serve /api/health and say what was wrong. Now it starts, every DB call
// returns a clear error, and health reports db:false so the fault is visible.
let supabase;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: SUPABASE_URL / SUPABASE_ANON_KEY (or SUPABASE_KEY) missing in env. DB calls will fail.");
  const dbError = { message: "Database not configured (SUPABASE_URL / SUPABASE_ANON_KEY missing)" };
  const failing = {
    select: () => failing, insert: () => failing, update: () => failing, delete: () => failing,
    upsert: () => failing, eq: () => failing, neq: () => failing, gt: () => failing, gte: () => failing,
    lt: () => failing, lte: () => failing, in: () => failing, is: () => failing, not: () => failing,
    ilike: () => failing, like: () => failing, order: () => failing, limit: () => failing,
    range: () => failing, single: () => failing, maybeSingle: () => failing,
    then: (resolve) => resolve({ data: null, error: dbError }),
  };
  supabase = { from: () => failing, rpc: async () => ({ data: null, error: dbError }) };
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ============================================
// KANHAIYA MARBLES INITIAL DATA
// ============================================

const KANHAIYA_MARBLES = {
  shopType: "tile_marble",
  shopName: "Kanhaiya Marbles",
  ownerName: "Sanjay Kumar Sharma",
  phone: "6202146538",
  address: "Tarwara More, Siwan",
  categories: [
    {
      categoryName: "12/18 Wall Tile",
      sizeMm: "12x18",
      coverageSqft: 9,
      basePricePerBox: 260,
      designs: [
        { code: "WL-001", name: "Cream/Beige", color: "Cream", quantity: 55 },
        { code: "WL-002", name: "Grey", color: "Grey", quantity: 42 },
        { code: "WL-003", name: "White", color: "White", quantity: 38 },
        { code: "WL-004", name: "Black", color: "Black", quantity: 28 },
      ],
    },
    {
      categoryName: "12/12 Bathroom Floor",
      sizeMm: "12x12",
      coverageSqft: 8,
      basePricePerBox: 260,
      designs: [
        { code: "BF-001", name: "White", color: "White", quantity: 45 },
        { code: "BF-002", name: "Blue", color: "Blue", quantity: 25 },
        { code: "BF-003", name: "Beige", color: "Beige", quantity: 35 },
      ],
    },
    {
      categoryName: "16/16 Parking",
      sizeMm: "16x16",
      coverageSqft: 9,
      basePricePerBox: 350,
      designs: [
        { code: "PK-001", name: "Grey", color: "Grey", quantity: 40 },
        { code: "PK-002", name: "Red", color: "Red", quantity: 32 },
        { code: "PK-003", name: "Dark Grey", color: "Dark Grey", quantity: 22 },
      ],
    },
    {
      categoryName: "24/24 Vitrified",
      sizeMm: "24x24",
      coverageSqft: 16,
      basePricePerBox: 700,
      designs: [
        { code: "VT-001", name: "Marble White", color: "White", quantity: 50 },
        { code: "VT-002", name: "Black Series", color: "Black", quantity: 35 },
        { code: "VT-003", name: "Beige", color: "Beige", quantity: 38 },
      ],
    },
    {
      categoryName: "24/24 Porcelain/Matt",
      sizeMm: "24x24",
      coverageSqft: 16,
      basePricePerBox: 500,
      designs: [
        { code: "PM-001", name: "Light Grey", color: "Light Grey", quantity: 45 },
        { code: "PM-002", name: "Dark", color: "Dark", quantity: 30 },
        { code: "PM-003", name: "White", color: "White", quantity: 26 },
      ],
    },
    {
      categoryName: "24/24 Double Charge",
      sizeMm: "24x24",
      coverageSqft: 16,
      basePricePerBox: 685,
      designs: [
        { code: "DC-001", name: "Dark Series A", color: "Dark", quantity: 48 },
        { code: "DC-002", name: "Dark Series B", color: "Dark", quantity: 42 },
      ],
    },
    {
      categoryName: "24/48 Carving/GVT",
      sizeMm: "24x48",
      coverageSqft: 16,
      basePricePerBox: 730,
      designs: [
        { code: "GVT-001", name: "Design A", color: "Mixed", quantity: 35 },
        { code: "GVT-002", name: "Design B", color: "Mixed", quantity: 28 },
      ],
    },
    {
      categoryName: "24/48 High Gloss",
      sizeMm: "24x48",
      coverageSqft: 16,
      basePricePerBox: 900,
      designs: [
        { code: "HG-001", name: "Z-Black", color: "Black", quantity: 40 },
        { code: "HG-002", name: "Glossy White", color: "White", quantity: 33 },
      ],
    },
  ],
  lowStockThreshold: 30,
};

// ============================================
// ROUTES
// ============================================

// Health Check — also does a cheap Supabase query so a periodic ping
// keeps BOTH Render (no cold sleep) AND the Supabase free project (no
// week-idle pause) warm. See .github/workflows/keepwarm.yml.
app.get("/api/health", async (req, res) => {
  // Pick up a migration applied since boot (see recheckSchemaIfNeeded).
  await recheckSchemaIfNeeded();
  let db = false;
  try {
    // Lightweight: count-only, no rows returned. Touches Postgres → resets idle timer.
    const { error } = await supabase
      .from("shops")
      .select("id", { count: "exact", head: true });
    db = !error;
  } catch (_) {
    db = false;
  }
  res.json({
    status: "✓ AI Shop System Running",
    timestamp: new Date(),
    db,
    gemini: !!process.env.GEMINI_API_KEY,
    igstReady: HAS_IGST_COLUMN,
    // Present only when something is actually wrong, so a clean shop stays quiet.
    ...(RLS_BLOCKED.size ? { rlsBlocked: [...RLS_BLOCKED.keys()] } : {}),
    hf: !!process.env.HF_TOKEN,
  });
});

// Initialize Shop
app.post("/api/shops/init", async (req, res) => {
  try {
    const { shopName, ownerName, phone, address, shopType, pin, gstin, pan, upiId } = req.body;

    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: "4 digit PIN zaroori hai" });
    }

    // Check phone not already registered.
    // Use list (not .single()) — .single() throws when duplicates already exist, which used to
    // let yet another duplicate slip through. Any existing row blocks re-registration.
    const { data: existing } = await supabase
      .from("shops").select("id").eq("phone", phone).limit(1);
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: "Ye phone number pehle se registered hai. Login karo." });
    }

    const pin_hash = await bcrypt.hash(pin, 10);

    // Generate unique display ID: FB-YYYY-XXXXX (random — count+1 had race condition)
    const shopIdDisplay = `FB-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;

    const { data: shop, error } = await supabase
      .from("shops")
      .insert([{
        name: shopName, owner_name: ownerName, phone, address,
        shop_type: shopType, pin_hash,
        gstin: gstin?.toUpperCase() || null,
        pan_number: pan?.toUpperCase() || null,
        upi_id: upiId || null,
        shop_id_display: shopIdDisplay,
      }])
      .select();

    if (error) throw error;

    const { pin_hash: _hash, ...safeShop } = shop[0];
    res.json({ message: "✓ Shop initialized", shop: safeShop });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Shop Details
app.get("/api/shops/:shopId", async (req, res) => {
  try {
    // maybeSingle, not single: a shop that does not exist is a 404, not a 500.
    // This route is called on every app launch, so a stale shopId used to
    // surface as "Cannot coerce the result to a single JSON object" — a
    // Postgres internal message shown to a shopkeeper, with a 500 that reads
    // like the server is broken.
    const { data, error } = await supabase
      .from("shops")
      .select("*")
      .eq("id", req.params.shopId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Shop nahi mila" });

    // Never expose the password hash to clients.
    const { pin_hash, ...safe } = data;
    res.json(safe);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update shop details (UPI, GSTIN, address, etc.)
// Fields that decide where money lands or what a tax invoice claims. Rewriting upi_id
// redirects every customer payment to an attacker's handle; gstin/pan_number/owner_name/
// address are printed on GST invoices, so changing them forges a legal document. These
// used to be editable by anyone who knew the shop UUID — a UUID travels in logs, URLs and
// screenshots, so it is an identifier, never a credential. They now require the shop PIN.
const SENSITIVE_SHOP_FIELDS = ['name', 'owner_name', 'address', 'gstin', 'pan_number', 'upi_id'];
// Display preferences. No money or legal meaning, so they stay open until route-level
// auth lands and covers every write uniformly.
const PREFERENCE_SHOP_FIELDS = ['auto_reminder_enabled', 'reminder_threshold_days'];

app.patch("/api/shops/:shopId", writeLimiter, async (req, res) => {
  try {
    const allowed = [...SENSITIVE_SHOP_FIELDS, ...PREFERENCE_SHOP_FIELDS];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    // Verify the PIN before touching anything sensitive. Checked against the shop being
    // edited, so knowing some other shop's PIN grants nothing here.
    const touchesSensitive = SENSITIVE_SHOP_FIELDS.some(k => updates[k] !== undefined);
    if (touchesSensitive) {
      const gate = await verifyShopPin(req.params.shopId, req.body?.pin);
      if (!gate.ok) {
        const status = gate.status === 400 ? 401 : gate.status;
        return res.status(status).json({
          error: gate.status === 400 ? "Shop details badalne ke liye PIN chahiye" : gate.error,
          pinRequired: true,
        });
      }
    }
    if (updates.gstin) updates.gstin = updates.gstin.toUpperCase();
    if (updates.pan_number) updates.pan_number = updates.pan_number.toUpperCase();
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid fields to update" });

    const { data, error } = await supabase
      .from("shops")
      .update(updates)
      .eq("id", req.params.shopId)
      .select()
      .single();
    if (error) throw error;
    const { pin_hash, ...safe } = data;
    res.json({ success: true, shop: safe });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login by phone + PIN. One phone may own multiple shops.
// One message for every login failure. Distinct "no shop on this number" vs "wrong PIN"
// replies let anyone test phone numbers against the database and harvest the list of
// registered shopkeepers, which also narrows a PIN brute force to numbers known to exist.
const LOGIN_FAILED = "Phone ya PIN galat hai";

app.post("/api/shops/login", authLimiter, loginPhoneLimiter, async (req, res) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).json({ error: "Phone aur PIN dono chahiye" });
    if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: "PIN 4-6 digit ka hona chahiye" });

    const { data: shops, error } = await supabase
      .from("shops")
      .select("*")
      .eq("phone", phone)
      .order("created_at", { ascending: false });

    if (error) throw error;
    if (!shops || shops.length === 0) {
      // Not an owner phone — check if it's a staff account added under some shop.
      const { data: staffRow } = await supabase
        .from("shop_staff").select("*").eq("phone", phone).eq("active", true).maybeSingle();
      if (!staffRow) return res.status(401).json({ error: LOGIN_FAILED });
      const staffOk = await bcrypt.compare(String(pin), staffRow.pin_hash);
      if (!staffOk) return res.status(401).json({ error: LOGIN_FAILED });

      const { data: parentShop, error: shopErr } = await supabase
        .from("shops").select("*").eq("id", staffRow.shop_id).single();
      if (shopErr || !parentShop) return res.status(404).json({ error: "Shop nahi mila" });
      const { pin_hash, ...safeShop } = parentShop;
      return res.json({
        found: true,
        shop: safeShop,
        isStaff: true,
        staffId: staffRow.id,
        staffName: staffRow.staff_name,
        staffPermissions: {
          canEditPrice: staffRow.can_edit_price,
          canDelete: staffRow.can_delete,
          canManageStaff: staffRow.can_manage_staff,
        },
      });
    }

    // Match PIN against each shop (each shop has own pin_hash).
    // SECURITY: never allow login on a null pin_hash with any PIN (old bypass).
    // Migration: a legacy shop with no pin_hash adopts the PIN typed on this first login (self-enroll),
    // then is protected by it on every future login.
    const matched = [];
    for (const shop of shops) {
      let ok = false;
      if (!shop.pin_hash) {
        const newHash = await bcrypt.hash(String(pin), 10);
        await supabase.from("shops").update({ pin_hash: newHash }).eq("id", shop.id);
        ok = true; // first-login enrollment
      } else {
        ok = await bcrypt.compare(String(pin), shop.pin_hash);
      }
      if (ok) {
        const { pin_hash, ...safe } = shop;
        matched.push(safe);
      }
    }

    if (matched.length === 0) {
      return res.status(401).json({ error: LOGIN_FAILED });
    }
    if (matched.length === 1) {
      return res.json({ found: true, shop: matched[0] });
    }
    // Multiple shops on this phone+PIN — client picks one
    res.json({ found: true, multiple: true, shops: matched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STAFF / MULTI-USER LOGIN
// ============================================

app.post("/api/shops/:shopId/staff", async (req, res) => {
  try {
    const { staffName, phone, pin, canEditPrice, canDelete, canManageStaff } = req.body;
    if (!staffName || !phone || !pin) return res.status(400).json({ error: "staffName, phone, pin required" });
    if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: "PIN 4-6 digit ka hona chahiye" });

    // A phone can't be both an owner account and a staff account, or staff on two shops.
    const { data: existingShop } = await supabase.from("shops").select("id").eq("phone", phone).maybeSingle();
    if (existingShop) return res.status(409).json({ error: "Ye phone number pehle se ek shop-owner account hai" });
    const { data: existingStaff } = await supabase.from("shop_staff").select("id").eq("phone", phone).maybeSingle();
    if (existingStaff) return res.status(409).json({ error: "Ye phone number pehle se staff account hai" });

    const pin_hash = await bcrypt.hash(String(pin), 10);
    const { data, error } = await supabase.from("shop_staff").insert([{
      shop_id: req.params.shopId,
      staff_name: staffName,
      phone,
      pin_hash,
      can_edit_price: !!canEditPrice,
      can_delete: !!canDelete,
      can_manage_staff: !!canManageStaff,
    }]).select("id, staff_name, phone, can_edit_price, can_delete, can_manage_staff, active, created_at").single();
    if (error) throw error;
    res.json({ success: true, staff: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/shops/:shopId/staff", async (req, res) => {
  try {
    const { data, error } = await supabase.from("shop_staff")
      .select("id, staff_name, phone, can_edit_price, can_delete, can_manage_staff, active, created_at")
      .eq("shop_id", req.params.shopId).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ staff: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/shops/:shopId/staff/:staffId", async (req, res) => {
  try {
    const allowed = ['can_edit_price', 'can_delete', 'can_manage_staff', 'active'];
    const updates = {};
    for (const [camelKey, snakeKey] of [['canEditPrice', 'can_edit_price'], ['canDelete', 'can_delete'], ['canManageStaff', 'can_manage_staff'], ['active', 'active']]) {
      if (req.body[camelKey] !== undefined) updates[snakeKey] = !!req.body[camelKey];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid fields to update" });
    const { data, error } = await supabase.from("shop_staff")
      .update(updates).eq("id", req.params.staffId).eq("shop_id", req.params.shopId).select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Staff not found in this shop" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/shops/:shopId/staff/:staffId", async (req, res) => {
  try {
    const { data, error } = await supabase.from("shop_staff")
      .delete().eq("id", req.params.staffId).eq("shop_id", req.params.shopId).select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Staff not found in this shop" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Inventory Status
app.get("/api/inventory/status/:shopId", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("inventory")
      .select(
        `*,
        designs(design_code, design_name, color, hsn_code, default_gst_rate, unit_type,
          tile_categories(category_name, base_price_per_box)
        )`
      )
      .eq("shop_id", req.params.shopId);

    if (error) throw error;

    // Enrich with latest purchase (supplier + cost) per design — single batch query
    const designIds = (data || []).map(d => d.design_id).filter(Boolean);
    let latestPurchaseMap = {};
    if (designIds.length > 0) {
      const { data: purchasesData } = await supabase
        .from('purchases')
        .select('design_id, supplier_name, cost_per_box, purchase_date')
        .eq('shop_id', req.params.shopId)
        .in('design_id', designIds)
        .order('purchase_date', { ascending: false });
      (purchasesData || []).forEach(p => {
        if (!latestPurchaseMap[p.design_id]) {
          latestPurchaseMap[p.design_id] = { supplier: p.supplier_name, cost: p.cost_per_box };
        }
      });
    }

    const enrichedInventory = (data || []).map(item => ({
      ...item,
      last_supplier: latestPurchaseMap[item.design_id]?.supplier || null,
      last_cost: latestPurchaseMap[item.design_id]?.cost || null,
    }));

    const lowStock = enrichedInventory.filter((item) => item.is_low_stock);

    // Expiry: flag items already expired or expiring within 30 days (grocery/pharmacy).
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    const expiringItems = enrichedInventory
      .filter(i => i.expiry_date && (i.quantity_boxes || 0) > 0)
      .map(i => ({ ...i, daysToExpiry: Math.floor((new Date(i.expiry_date) - today) / dayMs) }))
      .filter(i => i.daysToExpiry <= 30)
      .sort((a, b) => a.daysToExpiry - b.daysToExpiry);

    res.json({
      totalItems: enrichedInventory.length,
      lowStockCount: lowStock.length,
      inventory: enrichedInventory,
      lowStockItems: lowStock,
      expiringCount: expiringItems.length,
      expiringItems,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate Invoice
// GSTIN format: 2 digits state + 5 letters PAN + 4 digits + 1 letter + 1 digit/Z + 1 alphanumeric
// Money math lives in backend/lib/money.js so it can be tested without a database
// or a running server (`npm test`). Route handlers must call these rather than
// re-implementing arithmetic inline — a second copy is how the client and server
// discount ordering silently drifted apart once before.
const { GSTIN_REGEX, isValidGstin, computePurchaseGst, summariseItc, purchaseCostForPnl, invoiceTaxTotal, invoiceGrossValue } = require("./lib/money");
const { toCsv } = require("./lib/csv");
const { buildTallyXml } = require("./lib/tallyExport");
const { ageingSummary, groupByParty } = require("./lib/ageing");
const { customerKey, currentExposure, paymentBehaviour, evaluateCreditSale, creditSummaryLine } = require("./lib/credit");
const { expectedCash, reconcile, summarisePaymentModes } = require("./lib/cashbook");
const { resolveSupply, splitTaxComponents, stateCodeFromGstin, stateName } = require("./lib/gstPlace");
const { financialYear, creditNoteNumber, computeCreditNote, gstAdjustmentAllowed } = require("./lib/creditNote");
const ops = require("./lib/opsResearch");
const { supplierKey, debitNoteNumber, computeDebitNote } = require("./lib/debitNote");

// Whether migration 20260804000000 has been applied. PostgREST errors on an
// unknown column, so a query that asks for igst_amount before the migration
// would fail outright — the flag lets one set of queries serve both states.
// Probed once at boot and re-probed if a query later disagrees.
let HAS_IGST_COLUMN = false;
// Both columns arrive in the same migration, so one flag governs both.
const igstCol = () => (HAS_IGST_COLUMN ? ", igst_amount, is_inter_state" : "");
async function probeIgstColumn() {
  try {
    const { error } = await supabase.from("invoices").select("igst_amount").limit(1);
    const wasPresent = HAS_IGST_COLUMN;
    HAS_IGST_COLUMN = !error;
    if (HAS_IGST_COLUMN && !wasPresent) console.log("igst_amount detected — inter-state billing active");
    if (!HAS_IGST_COLUMN) console.warn("igst_amount not present — run migration 20260804000000 for inter-state billing");
  } catch {
    HAS_IGST_COLUMN = false;
  }
}
probeIgstColumn();

// The probe runs at boot, but a migration is applied by a human at some later
// moment — and this server does not restart when that happens. Without
// re-probing, every query would keep omitting igst_amount until the next
// deploy, silently under-reporting inter-state bills long after the database
// was ready for them.
//
// Re-checked from the health route rather than on a timer: the keep-warm cron
// already calls it every ten minutes, so this costs nothing extra and stops as
// soon as the column appears.
async function recheckSchemaIfNeeded() {
  if (!HAS_IGST_COLUMN) await probeIgstColumn();
}

/**
 * Remember tables whose writes were rejected by row-level security.
 *
 * This failure is dangerous precisely because it is quiet in the other
 * direction: with RLS on and no policy a SELECT returns zero rows rather than
 * an error, so the app shows "no credit notes" when the truth is "not allowed
 * to read credit notes", and nothing looks wrong to anyone.
 *
 * It cannot be detected by reading — a locked table and an empty table are
 * identical from the outside — and a probe INSERT would pollute real data. So
 * the signal used is the one that arrives on its own: a write that fails. The
 * first shopkeeper to hit it turns an isolated error string into a standing
 * diagnostic that /api/health reports.
 */
const RLS_BLOCKED = new Map();

function noteIfRlsError(table, error) {
  if (error && /row-level security/i.test(error.message || "")) {
    if (!RLS_BLOCKED.has(table)) {
      console.error(`RLS is blocking writes to "${table}" — run FIX_RLS.sql. Reads on this table return zero rows silently.`);
    }
    RLS_BLOCKED.set(table, new Date().toISOString());
  }
  return error;
}


// Core invoice-generation logic, shared by the HTTP endpoint and the recurring-invoices
// scheduler (both need identical math/rollback behavior — duplicating it would risk the two
// drifting apart, like the client/backend discount-order bug did earlier).
async function createInvoiceCore({ shopId, customerName, customerPhone, customerAddress, customerGstin, showGst, gstMode, items, paymentStatus, paymentMode, discountAmount, tableNumber, placeOfSupply, creditLimitOverridden = false, invoiceNumber = null }) {
  let createdInvoiceId = null;
  try {
    if (!shopId) throw Object.assign(new Error("shopId required"), { status: 400 });
    if (!Array.isArray(items) || items.length === 0) throw Object.assign(new Error("Items required"), { status: 400 });

    // Idempotency: when a caller supplies its own invoiceNumber (e.g. an online-store
    // webhook keying on the payment id), return the already-created invoice instead of
    // billing — and decrementing stock — a second time on a retry or page refresh.
    if (invoiceNumber) {
      const { data: existing } = await supabase
        .from("invoices").select("*").eq("shop_id", shopId).eq("invoice_number", invoiceNumber).maybeSingle();
      if (existing) return { message: "✓ Invoice already recorded", invoice: existing, idempotent: true };
    }
    const mode = gstMode || 'included'; // 'included' | 'exclusive'
    const discount = Math.max(0, parseFloat(discountAmount) || 0);

    const qty = (v) => parseFloat(v) || 0;
    const price = (v) => parseFloat(v) || 0;

    // Fetch HSN codes for each design from DB
    const designIds = items.map(i => i.designId).filter(Boolean);
    const { data: designsData } = await supabase
      .from("designs")
      .select("id, hsn_code, default_gst_rate, design_code, design_name, unit_type")
      .in("id", designIds);
    const designMap = {};
    (designsData || []).forEach(d => { designMap[d.id] = d; });

    // SECURITY + STOCK: only sell items that exist in THIS shop's inventory, and never oversell.
    // (designs has no shop_id; a shop's inventory row is the ownership proof.)
    const { data: invRows, error: invFetchErr } = await supabase
      .from("inventory")
      .select("design_id, quantity_boxes")
      .eq("shop_id", shopId)
      .in("design_id", designIds);
    if (invFetchErr) throw invFetchErr;
    const stockMap = {};
    (invRows || []).forEach(r => { stockMap[r.design_id] = r.quantity_boxes; });
    for (const it of items) {
      if (!(it.designId in stockMap)) {
        throw Object.assign(new Error(`Yeh product is shop ke inventory me nahi hai (designId: ${it.designId})`), { status: 400 });
      }
      if (qty(it.quantityBoxes) > (stockMap[it.designId] || 0)) {
        throw Object.assign(new Error(`Stock kam hai. Available: ${stockMap[it.designId] || 0}, maanga: ${qty(it.quantityBoxes)}`), { status: 400 });
      }
    }

    const totalBoxes = items.reduce((s, i) => s + qty(i.quantityBoxes), 0);
    const itemsTotal = items.reduce((s, i) => s + (qty(i.quantityBoxes) * price(i.pricePerBox)), 0);

    // Per-item GST calculation — each product uses its own GST rate from designs table
    const isGstInvoice = (showGst === true || showGst === 'true');

    // Pre-discount line totals (used for proportional discount allocation)
    const preDiscountLines = items.map(i => qty(i.quantityBoxes) * price(i.pricePerBox));
    const preDiscountSum = preDiscountLines.reduce((s, n) => s + n, 0) || 1;

    const itemCalcs = items.map((i, idx) => {
      const design = designMap[i.designId] || {};
      const grossLine = preDiscountLines[idx];
      // Allocate discount proportionally across line items
      const lineDiscount = preDiscountSum > 0 ? discount * (grossLine / preDiscountSum) : 0;
      const lineTotal = Math.max(0, grossLine - lineDiscount);
      const itemRate = parseFloat(i.gstRate || design.default_gst_rate || 0);
      const applyGst = isGstInvoice && itemRate > 0;
      const itemTaxable = applyGst && mode === 'included' ? lineTotal / (1 + itemRate / 100) : lineTotal;
      const itemGst = applyGst ? (mode === 'included' ? lineTotal - itemTaxable : lineTotal * itemRate / 100) : 0;
      return { grossLine, lineDiscount, lineTotal, itemTaxable, itemGst, itemRate, applyGst };
    });

    const taxableValue = itemCalcs.reduce((s, i) => s + i.itemTaxable, 0);
    const gstAmount = itemCalcs.reduce((s, i) => s + i.itemGst, 0);
    const grossAmount = itemCalcs.reduce((s, i) => s + i.lineTotal, 0);
    const finalGrossAmount = mode === 'exclusive' && isGstInvoice ? grossAmount + gstAmount : grossAmount;
    const gstinUpper = customerGstin ? customerGstin.toUpperCase() : null;
    const invoiceType = (gstinUpper && isValidGstin(gstinUpper)) ? 'B2B' : 'B2C';

    // Place of supply decides whether this is CGST+SGST or IGST. Selling to a
    // buyer in another state attracts IGST at the full rate; billing it as
    // CGST+SGST is legally wrong and breaks the buyer's credit and the seller's
    // GSTR-1. The seller's own state comes from their GSTIN (or an explicitly
    // recorded state_code when the shop is unregistered).
    const { data: sellerShop } = await supabase
      .from("shops").select("gstin, state_code").eq("id", shopId).maybeSingle();
    const sellerGstin = sellerShop?.gstin || null;
    const supply = resolveSupply({
      sellerGstin: sellerGstin || (sellerShop?.state_code ? `${sellerShop.state_code}AAAAA0000A1Z0` : null),
      buyerGstin: gstinUpper,
      placeOfSupply,
    });
    const { igst, cgst, sgst } = splitTaxComponents(gstAmount, supply.interState);

    // Insert invoice
    const invoiceRow = {
      shop_id: shopId,
      invoice_number: invoiceNumber || `INV-${Date.now()}`,
      customer_name: customerName,
      customer_phone: customerPhone || null,
      customer_address: customerAddress || null,
      customer_gstin: gstinUpper,
      invoice_type: invoiceType,
      taxable_value: isGstInvoice ? Math.round(taxableValue * 100) / 100 : null,
      cgst_amount: isGstInvoice ? cgst : null,
      sgst_amount: isGstInvoice ? sgst : null,
      gst_rate: null, // mixed per-item rates — see invoice_items
      is_gst_invoice: isGstInvoice,
      payment_status: paymentStatus || 'paid',
      amount_paid: (paymentStatus === 'credit') ? 0 : null,
      table_number: tableNumber || null,
      discount_amount: discount > 0 ? Math.round(discount * 100) / 100 : null,
    };

    // How the customer settled it. Only meaningful on a paid bill — an udhari
    // bill has not been paid by anything yet. Left null when not supplied, and
    // reported as "not recorded" rather than assumed to be cash, because
    // assuming would make every day-close wrong.
    // Columns added by migration 20260804000000; stripped by the fallback below
    // if the database has not caught up yet.
    if (isGstInvoice && supply.interState) invoiceRow.igst_amount = igst;
    invoiceRow.place_of_supply = supply.placeOfSupply || null;
    invoiceRow.is_inter_state = supply.interState;

    const PAYMENT_MODES = ["cash", "upi", "card", "bank"];
    const settledBy = String(paymentMode || "").toLowerCase();
    if ((paymentStatus || "paid") === "paid" && PAYMENT_MODES.includes(settledBy)) {
      invoiceRow.payment_mode = settledBy;
    }

    // Recording that a shopkeeper was warned and sold on credit anyway: the
    // difference between a mistake and a decision. The column only exists after
    // migration 20260802000000, so a missing-column error retries without it —
    // an audit field must never be the reason a bill cannot be raised.
    let { data: invoice, error: invoiceError } = await supabase
      .from("invoices").insert([{ ...invoiceRow, credit_limit_overridden: !!creditLimitOverridden }]).select();
    if (invoiceError && /column|schema cache/i.test(invoiceError.message || "")) {
      // Retry without the columns added by later migrations. Billing must work
      // on a database that has not caught up yet; the audit detail can wait.
      const { credit_limit_overridden, payment_mode, igst_amount, place_of_supply, is_inter_state, ...preMigration } = { ...invoiceRow };

      // But tax must never vanish. On an inter-state bill the tax was placed in
      // igst_amount and cgst/sgst were zero — dropping the column here would
      // store a bill with no tax at all. Record it the way this app always did
      // until the migration lands: half in each. The total stays correct; only
      // the legally required split is postponed.
      if (isGstInvoice && supply.interState) {
        const half = Math.round((gstAmount / 2) * 100) / 100;
        preMigration.cgst_amount = Math.round((gstAmount - half) * 100) / 100;
        preMigration.sgst_amount = half;
        console.warn("inter-state bill recorded as CGST+SGST — run migration 20260804000000 to bill IGST correctly");
      }
      ({ data: invoice, error: invoiceError } = await supabase.from("invoices").insert([preMigration]).select());
    }

    if (invoiceError) throw invoiceError;
    createdInvoiceId = invoice[0].id;

    // Insert items + decrement inventory in parallel; if anything fails, roll back invoice
    const itemRows = items.map((item, idx) => {
      const design = designMap[item.designId] || {};
      return {
        invoice_id: createdInvoiceId,
        design_id: item.designId,
        quantity_boxes: qty(item.quantityBoxes),
        price_per_box: price(item.pricePerBox),
        hsn_code: item.hsnCode || design.hsn_code || null,
        gst_rate: item.gstRate || design.default_gst_rate || null,
      };
    });

    const { error: itemsErr } = await supabase.from("invoice_items").insert(itemRows);
    if (itemsErr) throw itemsErr;

    const inventoryUpdates = await Promise.all(items.map(async (item) => {
      // Scope the decrement to this shop (see the 2026-08-01 migration). The 3-argument
      // form only exists once that migration has run, and this backend deploys before a
      // human runs SQL — so fall back to the original 2-argument call rather than break
      // billing in the window between the two. Remove the fallback once migrated.
      let { error } = await supabase.rpc("update_inventory_after_invoice", {
        design_id: item.designId,
        quantity: qty(item.quantityBoxes),
        p_shop_id: shopId,
      });
      if (error && /function|schema cache|argument/i.test(error.message || "")) {
        console.warn("update_inventory_after_invoice: p_shop_id not available yet, falling back — run migration 20260801000000");
        ({ error } = await supabase.rpc("update_inventory_after_invoice", {
          design_id: item.designId,
          quantity: qty(item.quantityBoxes),
        }));
      }
      return error;
    }));
    const invErr = inventoryUpdates.find(e => e);
    if (invErr) throw invErr;

    return {
      message: "✓ Invoice generated",
      invoice: {
        ...invoice[0],
        totalBoxes,
        itemsTotal: Math.round(itemsTotal),
        discountAmount: Math.round(discount * 100) / 100,
        grossAmount: Math.round(finalGrossAmount),
        finalTotal: Math.round(finalGrossAmount),
        taxableValue: Math.round(taxableValue),
        cgst,
        sgst,
        igst,
        interState: supply.interState,
        placeOfSupply: supply.placeOfSupply,
        placeOfSupplyName: supply.placeOfSupplyName,
        gstAmount: Math.round(gstAmount * 100) / 100,
        isGstInvoice,
        gstRate: null,
        gstMode: mode,
        items: items.map((i, idx) => {
          const design = designMap[i.designId] || {};
          const c = itemCalcs[idx];
          const itemTotal = mode === 'exclusive' && c.applyGst ? c.lineTotal + c.itemGst : c.lineTotal;
          return {
            designId: i.designId,
            designCode: design.design_code || null,
            designName: design.design_name || null,
            quantityBoxes: qty(i.quantityBoxes),
            pricePerBox: price(i.pricePerBox),
            hsnCode: i.hsnCode || design.hsn_code || null,
            gstRate: c.itemRate,
            grossLine: Math.round(c.grossLine * 100) / 100,
            lineDiscount: Math.round(c.lineDiscount * 100) / 100,
            lineTotal: Math.round(c.lineTotal * 100) / 100,
            taxableValue: Math.round(c.itemTaxable * 100) / 100,
            cgstAmount: supply.interState ? 0 : Math.round(c.itemGst / 2 * 100) / 100,
            sgstAmount: supply.interState ? 0 : Math.round(c.itemGst / 2 * 100) / 100,
            igstAmount: supply.interState ? Math.round(c.itemGst * 100) / 100 : 0,
            totalWithGst: Math.round(itemTotal * 100) / 100,
          };
        }),
      },
    };
  } catch (error) {
    // Roll back invoice if items/inventory step failed
    if (createdInvoiceId) {
      await supabase.from("invoice_items").delete().eq("invoice_id", createdInvoiceId);
      await supabase.from("invoices").delete().eq("id", createdInvoiceId);
    }
    throw error;
  }
}

// ============================================
// CUSTOMER CREDIT LIMITS
//
// The app makes giving udhari one toggle and, until now, said nothing when a
// customer was already deep in debt — the most common way a small shop loses
// money. Exposure, payment behaviour and the limit are assembled here; the
// decision logic itself lives in lib/credit.js and is tested.
// ============================================

// Gather everything needed to judge a credit sale to one customer.
// Returns null when the customer has no name (walk-in cash-style credit),
// since there is nobody to track exposure against.
async function assessCustomerCredit(shopId, customerName, newAmount) {
  const key = customerKey(customerName);
  if (!shopId || !key) return null;

  const [openRes, settledRes, customerRes] = await Promise.allSettled([
    supabase.from("invoices")
      .select(`id, customer_name, created_at, amount_paid, taxable_value, cgst_amount, sgst_amount${igstCol()}, discount_amount, invoice_items(quantity_boxes, price_per_box)`)
      .eq("shop_id", shopId).in("payment_status", ["credit", "partial"]).limit(500),
    supabase.from("invoices")
      .select("customer_name, created_at, updated_at")
      .eq("shop_id", shopId).eq("payment_status", "paid").order("created_at", { ascending: false }).limit(200),
    supabase.from("customers").select("*").eq("shop_id", shopId).eq("customer_key", key).maybeSingle(),
  ]);

  const rows = (r) => (r.status === "fulfilled" && !r.value.error ? r.value.data || [] : []);

  // Match on the normalised name so bills typed with different capitalisation
  // still count towards the same person's exposure.
  const mine = rows(openRes).filter(i => customerKey(i.customer_name) === key).map(inv => {
    const items = inv.invoice_items || [];
    const net = inv.taxable_value != null
      ? invoiceGrossValue(inv)
      : Math.max(0, items.reduce((s, i) => s + (i.quantity_boxes || 0) * (i.price_per_box || 0), 0) - (inv.discount_amount || 0));
    return { ...inv, outstanding: Math.round(net - (inv.amount_paid || 0)) };
  });

  const settled = rows(settledRes).filter(i => customerKey(i.customer_name) === key);
  const customer = customerRes.status === "fulfilled" && !customerRes.value.error ? customerRes.value.data : null;

  const exposure = currentExposure(mine);
  const behaviour = paymentBehaviour(settled);
  const evaluation = evaluateCreditSale({
    exposure: exposure.exposure,
    newAmount,
    creditLimit: customer?.credit_limit,
    blockOverLimit: customer?.block_over_limit,
    behaviour,
    oldestDays: exposure.oldestDays,
  });

  return {
    customer: customer ? { name: customer.name, creditLimit: customer.credit_limit, creditDays: customer.credit_days, blockOverLimit: customer.block_over_limit } : null,
    ...exposure,
    behaviour,
    ...evaluation,
    summary: creditSummaryLine(evaluation, behaviour),
  };
}

// Ask before billing: what does this customer owe, and should I be careful?
app.get("/api/customers/:shopId/credit-check", async (req, res) => {
  try {
    const assessment = await assessCustomerCredit(req.params.shopId, req.query.name, parseFloat(req.query.amount) || 0);
    if (!assessment) return res.json({ applicable: false });
    res.json({ applicable: true, ...assessment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set or clear a customer's limit. Upsert on the normalised name, so the
// shopkeeper never has to create a customer record before billing them.
app.put("/api/customers/:shopId/limit", async (req, res) => {
  try {
    const { shopId } = req.params;
    const { name, creditLimit, creditDays, blockOverLimit, phone, notes } = req.body;
    const key = customerKey(name);
    if (!key) return res.status(400).json({ error: "Customer ka naam chahiye" });

    const limit = creditLimit === null || creditLimit === "" ? null : parseFloat(creditLimit);
    if (limit !== null && (isNaN(limit) || limit < 0)) return res.status(400).json({ error: "Credit limit galat hai" });

    const { data, error } = await supabase.from("customers").upsert({
      shop_id: shopId,
      name: String(name).trim(),
      customer_key: key,
      credit_limit: limit,
      credit_days: creditDays === null || creditDays === "" ? null : parseInt(creditDays),
      block_over_limit: !!blockOverLimit,
      phone: phone || null,
      notes: notes || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "shop_id,customer_key" }).select().single();

    if (noteIfRlsError("customers", error)) throw error;
    res.json({ success: true, customer: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Every customer who has a limit set, with what they currently owe against it.
app.get("/api/customers/:shopId/limits", async (req, res) => {
  try {
    const { shopId } = req.params;
    const [custRes, openRes] = await Promise.allSettled([
      supabase.from("customers").select("*").eq("shop_id", shopId).order("name"),
      supabase.from("invoices")
        .select(`customer_name, amount_paid, taxable_value, cgst_amount, sgst_amount${igstCol()}, discount_amount, created_at, invoice_items(quantity_boxes, price_per_box)`)
        .eq("shop_id", shopId).in("payment_status", ["credit", "partial"]).limit(2000),
    ]);

    if (custRes.status === "fulfilled" && custRes.value.error) {
      // Migration not run yet — say so rather than pretend there are no customers.
      return res.json({ customers: [], unavailable: true });
    }

    const customers = custRes.status === "fulfilled" ? custRes.value.data || [] : [];
    const open = openRes.status === "fulfilled" && !openRes.value.error ? openRes.value.data || [] : [];

    const exposureByKey = {};
    for (const inv of open) {
      const key = customerKey(inv.customer_name);
      const items = inv.invoice_items || [];
      const net = inv.taxable_value != null
        ? invoiceGrossValue(inv)
        : Math.max(0, items.reduce((s, i) => s + (i.quantity_boxes || 0) * (i.price_per_box || 0), 0) - (inv.discount_amount || 0));
      exposureByKey[key] = (exposureByKey[key] || 0) + Math.round(net - (inv.amount_paid || 0));
    }

    res.json({
      customers: customers.map(c => {
        const exposure = Math.max(0, exposureByKey[c.customer_key] || 0);
        const limit = parseFloat(c.credit_limit) || 0;
        return {
          ...c,
          exposure,
          availableCredit: limit > 0 ? Math.round(Math.max(0, limit - exposure)) : null,
          overLimit: limit > 0 && exposure > limit,
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/invoices/generate", async (req, res) => {
  try {
    // Credit check runs here rather than inside createInvoiceCore on purpose:
    // the recurring-invoice scheduler shares that core and has no human present
    // to see a warning or authorise an override, so it must never be blocked.
    let creditAssessment = null;
    if (req.body?.paymentStatus === "credit" && req.body?.customerName) {
      const grossGuess = (req.body.items || []).reduce(
        (s, i) => s + (parseFloat(i.quantityBoxes) || 0) * (parseFloat(i.pricePerBox) || 0), 0,
      ) - (parseFloat(req.body.discountAmount) || 0);
      creditAssessment = await assessCustomerCredit(req.body.shopId, req.body.customerName, Math.max(0, grossGuess));

      if (creditAssessment?.shouldBlock && !req.body.overrideCreditLimit) {
        return res.status(409).json({
          error: "Credit limit se zyada ho raha hai",
          creditBlocked: true,
          credit: creditAssessment,
        });
      }
    }

    const result = await createInvoiceCore({
      ...req.body,
      creditLimitOverridden: !!(creditAssessment?.wouldExceed),
    });

    // Warnings ride along with the successful response so the app can tell the
    // shopkeeper what just happened without blocking the sale.
    if (creditAssessment?.shouldWarn) result.creditWarning = creditAssessment;
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ============================================
// ONLINE-STORE WEBHOOK (website / Shopify / IG shop → FastBill)
// ============================================
// A shop that also sells online posts each PAID order here. FastBill decrements
// that shop's inventory and records a bill — so online + counter sales draw down
// one stock and the owner never oversells or bills twice.
//
//   POST /api/webhooks/online-order
//   header: x-webhook-secret: <ONLINE_ORDER_SECRET>   (server-to-server auth)
//   body: {
//     shopId,                       // the FastBill shop this store belongs to
//     externalRef,                  // payment id — used as the idempotency key
//     source?,                      // "web" | "shopify" | ... (invoice number prefix)
//     showGst?, gstMode?,           // default: non-GST sales record
//     customer?: { name, phone, address, gstin, placeOfSupply },
//     items: [ { sku, quantityBoxes, pricePerBox, gstRate? } ]   // sku = design_code
//   }
//
// Auth note: these endpoints otherwise trust shopId alone (RLS disabled), so this
// server-to-server route MUST carry the shared secret — without it, anyone could
// draw down any shop's stock.
app.post("/api/webhooks/online-order", async (req, res) => {
  try {
    const secret = process.env.ONLINE_ORDER_SECRET;
    if (!secret) return res.status(503).json({ error: "Online-order webhook not configured (ONLINE_ORDER_SECRET missing)" });
    const provided = req.get("x-webhook-secret") || "";
    // Constant-time compare so the secret can't be guessed a byte at a time.
    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { shopId, externalRef, source, customer, items, showGst, gstMode } = req.body || {};
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    if (!externalRef) return res.status(400).json({ error: "externalRef required (payment id)" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "items required" });

    // Map each SKU (design_code) to this shop's design_id. Only codes the shop
    // actually stocks resolve — an unknown SKU is rejected, never silently dropped.
    const skus = items.map(i => String(i.sku || "").trim()).filter(Boolean);
    if (skus.length !== items.length) return res.status(400).json({ error: "every item needs a sku" });
    const { data: designRows, error: dErr } = await supabase
      .from("designs").select("id, design_code").in("design_code", skus);
    if (dErr) throw dErr;
    const codeToId = {};
    (designRows || []).forEach(d => { codeToId[d.design_code] = d.id; });
    const unknown = skus.filter(s => !(s in codeToId));
    if (unknown.length) return res.status(400).json({ error: `Unknown SKU(s): ${unknown.join(", ")}` });

    const coreItems = items.map(i => ({
      designId: codeToId[String(i.sku).trim()],
      quantityBoxes: i.quantityBoxes,
      pricePerBox: i.pricePerBox,
      gstRate: i.gstRate,
    }));

    const invoiceNumber = `${(source || "WEB").toUpperCase()}-${externalRef}`;
    const result = await createInvoiceCore({
      shopId,
      customerName: customer?.name || "Online order",
      customerPhone: customer?.phone || null,
      customerAddress: customer?.address || null,
      customerGstin: customer?.gstin || null,
      placeOfSupply: customer?.placeOfSupply || null,
      showGst: showGst === true,           // default: plain sales record, no GST split
      gstMode: gstMode || "included",
      items: coreItems,
      paymentStatus: "paid",
      paymentMode: "upi",                  // online payment gateway
      invoiceNumber,                       // idempotency key = source + payment id
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ============================================
// RECURRING INVOICES
// ============================================

function advanceRecurringDate(dateStr, frequency) {
  const d = new Date(dateStr + "T00:00:00Z");
  if (frequency === "daily") d.setUTCDate(d.getUTCDate() + 1);
  else if (frequency === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1); // monthly
  return d.toISOString().slice(0, 10);
}

app.post("/api/recurring-invoices", async (req, res) => {
  try {
    const { shopId, customerName, customerPhone, customerAddress, customerGstin,
      items, showGst, gstMode, discountAmount, frequency, startDate } = req.body;
    if (!shopId || !customerName) return res.status(400).json({ error: "shopId and customerName required" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Items required" });
    if (!["daily", "weekly", "monthly"].includes(frequency)) return res.status(400).json({ error: "frequency must be daily/weekly/monthly" });

    const { data, error } = await supabase.from("recurring_invoices").insert([{
      shop_id: shopId,
      customer_name: customerName,
      customer_phone: customerPhone || null,
      customer_address: customerAddress || null,
      customer_gstin: customerGstin || null,
      items,
      show_gst: showGst !== false,
      gst_mode: gstMode || "included",
      discount_amount: discountAmount || 0,
      frequency,
      next_run_date: startDate || new Date().toISOString().slice(0, 10),
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, recurringInvoice: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/recurring-invoices/:shopId", async (req, res) => {
  try {
    const { data, error } = await supabase.from("recurring_invoices")
      .select("*").eq("shop_id", req.params.shopId).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ recurringInvoices: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/recurring-invoices/:id", async (req, res) => {
  try {
    const { shopId, active } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    const { data, error } = await supabase.from("recurring_invoices")
      .update({ active: !!active })
      .eq("id", req.params.id).eq("shop_id", shopId).select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Not found in this shop" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/recurring-invoices/:id", async (req, res) => {
  try {
    const { shopId } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    const { data, error } = await supabase.from("recurring_invoices")
      .delete().eq("id", req.params.id).eq("shop_id", shopId).select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Not found in this shop" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cron entry point (called daily by a GitHub Action, same pattern as keep-warm) — generates
// a real invoice for every active template whose next_run_date has arrived, for every shop.
app.post("/api/recurring-invoices/run-due", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: due, error } = await supabase.from("recurring_invoices")
      .select("*").eq("active", true).lte("next_run_date", today);
    if (error) throw error;

    const results = [];
    for (const tpl of due || []) {
      try {
        const result = await createInvoiceCore({
          shopId: tpl.shop_id,
          customerName: tpl.customer_name,
          customerPhone: tpl.customer_phone,
          customerAddress: tpl.customer_address,
          customerGstin: tpl.customer_gstin,
          items: tpl.items,
          showGst: tpl.show_gst,
          gstMode: tpl.gst_mode,
          discountAmount: tpl.discount_amount,
          paymentStatus: "paid",
        });
        const nextDate = advanceRecurringDate(tpl.next_run_date, tpl.frequency);
        await supabase.from("recurring_invoices").update({
          next_run_date: nextDate,
          last_generated_invoice_id: result.invoice.id,
          last_generated_at: new Date().toISOString(),
        }).eq("id", tpl.id);
        results.push({ id: tpl.id, invoiceId: result.invoice.id, status: "generated" });
      } catch (e) {
        results.push({ id: tpl.id, status: "failed", error: e.message });
      }
    }
    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI-Powered Scan-to-Stock (Purchase Entry)
// Parse bill text into structured line items
function parseBillText(text) {
  if (!text || text.length < 5) return [];
  const items = [];
  const lines = text.split(/\n|;/).map(l => l.trim()).filter(l => l.length > 2);
  for (const line of lines) {
    // Format: NAME | QTY | RATE
    const pipe = line.match(/^(.+?)\s*\|\s*(\d+\.?\d*)\s*\|\s*(\d+\.?\d*)/);
    if (pipe) { items.push({ designCode: pipe[1].trim(), quantity: parseFloat(pipe[2]), rate: parseFloat(pipe[3]) }); continue; }
    // Format: NAME QTY RATE (end of line)
    const nums = line.match(/^(.+?)\s+(\d+)\s+(\d+\.?\d*)\s*$/);
    if (nums && parseFloat(nums[2]) < 10000) { items.push({ designCode: nums[1].trim(), quantity: parseFloat(nums[2]), rate: parseFloat(nums[3]) }); continue; }
    // Format: NAME x QTY @ RATE
    const atSign = line.match(/^(.+?)\s+[xX×]\s*(\d+\.?\d*)\s*@\s*(\d+\.?\d*)/);
    if (atSign) { items.push({ designCode: atSign[1].trim(), quantity: parseFloat(atSign[2]), rate: parseFloat(atSign[3]) }); }
  }
  return items.slice(0, 25);
}

app.post("/api/inventory/scan-purchase", async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "No file data provided" });
    const isPdf = mimeType === "application/pdf";

    let rawText = "";
    let items = [];

    // Primary: Gemini — reads bill images AND PDFs directly (native document understanding), returns structured JSON
    if (process.env.GEMINI_API_KEY) {
      const geminiText = await geminiVision(
        imageBase64,
        `This is a purchase bill/invoice${isPdf ? " (PDF, may have multiple pages)" : ""}, possibly a photo taken at an angle or with a shaky hand — read through blur/skew/glare as best you can. Extract ALL line items. Return ONLY valid JSON array, no markdown, no code fences, no other text:
[{"designCode":"product name or code","hsnCode":"HSN code if printed on bill","unit":"unit of measure exactly as printed (e.g. BOX, SQFT, NOS, KG, PCS)","quantity":10,"rate":250}]
Rules: quantity and rate must be numbers. hsnCode is usually a 4-8 digit code near the item row. Tiles are usually billed in BOX, marble/granite in SQFT — read the actual unit column/abbreviation on the bill rather than guessing. Use null if a field is not visible. Return [] only if truly no item rows exist.`,
        isPdf ? "application/pdf" : "image/jpeg",
        2048
      );
      if (geminiText) {
        try {
          // Strip markdown code fences some responses wrap the JSON in, despite instructions not to.
          const cleaned = geminiText.replace(/```json/gi, '').replace(/```/g, '');
          const start = cleaned.indexOf('[');
          const end = cleaned.lastIndexOf(']') + 1;
          if (start !== -1 && end > start) {
            items = JSON.parse(cleaned.slice(start, end));
            rawText = `Gemini extracted ${items.length} items`;
          } else {
            console.error("Gemini returned no JSON array:", cleaned.slice(0, 300));
          }
        } catch (e) { console.error("Gemini JSON parse error:", e.message, geminiText.slice(0, 300)); }
      } else {
        console.error("Gemini returned empty response for scan-purchase");
      }
    }

    // Fallback: Tesseract OCR + regex parser (images only — can't OCR raw PDF bytes)
    if (!items.length && !isPdf) {
      try {
        const imgBuffer = Buffer.from(imageBase64, 'base64');
        // Purchase bills from suppliers are printed in English/GST-standard format almost always —
        // 'eng+hin' misreads Latin characters as Devanagari glyphs on this kind of text, producing garbage.
        const worker = await createWorker('eng', 1, { logger: () => {} });
        const { data } = await worker.recognize(imgBuffer);
        await worker.terminate();
        rawText = data.text || "";
        items = parseBillText(rawText);
      } catch (e) { console.error("Tesseract error:", e.message); }
    }

    // Last fallback: local Ollama moondream (images only)
    if (!items.length && !isPdf && process.env.OLLAMA_URL) {
      try {
        const r = await fetch(`${process.env.OLLAMA_URL}/api/generate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "moondream:latest", prompt: "List bill items as: NAME | QTY | RATE", images: [imageBase64], stream: false }),
          signal: AbortSignal.timeout(25000),
        });
        if (r.ok) { rawText = (await r.json()).response || ""; items = parseBillText(rawText); }
      } catch (e) { console.error("Ollama scan error:", e.message); }
    }

    res.json({ items, rawText: rawText.slice(0, 800) });
  } catch (error) {
    console.error("Bill Scan Error:", error);
    res.status(500).json({ error: "Bill scan failed. Enter manually.", items: [], rawText: "" });
  }
});

app.post("/api/inventory/confirm-scan", async (req, res) => {
  try {
    const { shopId, items } = req.body;
    if (!shopId || !items?.length) return res.status(400).json({ error: "shopId and items required" });

    for (const item of items) {
      if (!item.designId || !item.quantity) continue;
      const qty = parseFloat(item.quantity) || 0;
      if (qty <= 0) continue;

      // Increment existing inventory row, or create if missing
      const { data: invRow } = await supabase
        .from("inventory")
        .select("id, quantity_boxes")
        .eq("shop_id", shopId)
        .eq("design_id", item.designId)
        .maybeSingle();

      let inventoryRowId;
      if (invRow) {
        const { error: updErr } = await supabase.from("inventory")
          .update({ quantity_boxes: invRow.quantity_boxes + qty })
          .eq("id", invRow.id);
        if (updErr) throw updErr;
        inventoryRowId = invRow.id;
      } else {
        // is_low_stock is a GENERATED column — never insert it, Postgres rejects explicit values.
        // .select() forces PostgREST to return the inserted row so RLS-denied inserts surface as errors
        // instead of silently returning success with zero rows written.
        const { data: insData, error: insErr } = await supabase.from("inventory").insert({
          shop_id: shopId, design_id: item.designId, quantity_boxes: qty,
        }).select();
        if (insErr) throw insErr;
        if (!insData || insData.length === 0) throw new Error("Inventory row insert returned no data (possibly blocked by RLS)");
        inventoryRowId = insData[0].id;
      }

      // Transportation/misc cost + margin, same as manual add-stock — blended into
      // per-unit cost and the product's selling price, no separate step needed.
      const baseCost = parseFloat(item.rate) || 0;
      const extra = Math.max(0, parseFloat(item.extraCost) || 0);
      const effectiveCost = baseCost + (qty > 0 ? extra / qty : 0);
      const marginPct = item.marginPercent !== undefined && item.marginPercent !== null && item.marginPercent !== '' ? parseFloat(item.marginPercent) : null;
      const marginAmt = item.marginAmount !== undefined && item.marginAmount !== null && item.marginAmount !== '' ? parseFloat(item.marginAmount) : null;
      const suggestedPrice = marginPct !== null ? effectiveCost * (1 + marginPct / 100)
        : marginAmt !== null ? effectiveCost + marginAmt
        : null;

      const { error: breakdownErr } = await supabase.from("inventory")
        .update({ last_cost_price: baseCost, last_extra_cost: extra, last_margin_percent: marginPct, last_margin_amount: marginAmt })
        .eq("id", inventoryRowId);
      if (breakdownErr) console.error("confirm-scan: failed to persist price breakdown:", breakdownErr.message);

      // Record purchase for profit/credit scoring
      const { error: purchInsErr } = await supabase.from("purchases").insert({
        shop_id: shopId,
        design_id: item.designId,
        quantity_boxes: qty,
        cost_per_box: baseCost,
        extra_cost: extra,
        margin_percent: marginPct,
        margin_amount: marginAmt,
        suggested_price: suggestedPrice,
        purchase_date: new Date().toISOString(),
      });
      if (purchInsErr) console.error("confirm-scan: failed to record purchase:", purchInsErr.message);

      if (suggestedPrice !== null) {
        const categoryId = await ensureExclusiveCategory(item.designId);
        if (categoryId) {
          const { error: priceErr } = await supabase.from("tile_categories")
            .update({ base_price_per_box: suggestedPrice })
            .eq("id", categoryId);
          if (priceErr) console.error("confirm-scan: failed to blend price:", priceErr.message);
        }
      }
    }

    res.json({ message: "✓ Stock updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SUPPLIERS AND PURCHASE RETURNS
//
// The buy side has been much thinner than the sell side. A supplier was a name
// typed onto each purchase, and goods could not be sent back at all — which
// meant returned stock stayed on the shelf in the app and the input credit
// claimed on it was never reversed. Keeping credit on goods that went back is
// claiming a refund for tax the shop never ultimately bore.
// ============================================

app.put("/api/suppliers/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const { name, phone, gstin, address, creditDays, notes } = req.body;
    const key = supplierKey(name);
    if (!key) return res.status(400).json({ error: "Supplier ka naam chahiye" });

    const upper = gstin ? String(gstin).toUpperCase() : null;
    if (upper && !isValidGstin(upper)) return res.status(400).json({ error: "GSTIN galat hai" });

    const { data, error } = await supabase.from("suppliers").upsert({
      shop_id: shopId,
      name: String(name).trim(),
      supplier_key: key,
      phone: phone || null,
      gstin: upper,
      address: address || null,
      credit_days: creditDays === null || creditDays === "" ? null : parseInt(creditDays),
      notes: notes || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "shop_id,supplier_key" }).select().single();

    if (error && /relation|does not exist|schema cache/i.test(error.message || "")) {
      return res.status(501).json({ error: "Supplier table nahi hai — migration 20260806000000 chalayein" });
    }
    if (noteIfRlsError("suppliers", error)) throw error;
    res.json({ success: true, supplier: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Suppliers with what is still owed to each, so payables have a named party
// rather than a free-text string.
app.get("/api/suppliers/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const [supRes, purchRes] = await Promise.allSettled([
      supabase.from("suppliers").select("*").eq("shop_id", shopId).order("name"),
      supabase.from("purchases")
        .select("supplier_name, quantity_boxes, cost_per_box, amount_paid, payment_status, purchase_date")
        .eq("shop_id", shopId).in("payment_status", ["unpaid", "partial"]).limit(2000),
    ]);

    if (supRes.status === "fulfilled" && supRes.value.error) {
      return res.json({ suppliers: [], unavailable: true });
    }
    const suppliers = supRes.status === "fulfilled" ? supRes.value.data || [] : [];
    const open = purchRes.status === "fulfilled" && !purchRes.value.error ? purchRes.value.data || [] : [];

    const owedByKey = {};
    for (const p of open) {
      const key = supplierKey(p.supplier_name);
      const gross = (parseFloat(p.quantity_boxes) || 0) * (parseFloat(p.cost_per_box) || 0);
      owedByKey[key] = (owedByKey[key] || 0) + Math.max(0, gross - (parseFloat(p.amount_paid) || 0));
    }

    res.json({
      suppliers: suppliers.map(sup => ({ ...sup, outstanding: Math.round(owedByKey[sup.supplier_key] || 0) })),
      // Names seen on purchases that have no supplier record yet — the shopkeeper
      // can promote them rather than retyping.
      unregistered: [...new Set(open.map(p => p.supplier_name).filter(Boolean))]
        .filter(n => !suppliers.some(sup => sup.supplier_key === supplierKey(n))),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send goods back to a supplier: stock comes off the shelf and the credit
// claimed on those goods is reversed by a debit note.
app.post("/api/purchases/:id/return", async (req, res) => {
  try {
    const { id } = req.params;
    const { shopId, returnQuantity, reason } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    if (!returnQuantity || parseFloat(returnQuantity) <= 0) {
      return res.status(400).json({ error: "Kitna maal wapas kar rahe hain?" });
    }

    const { data: purchase, error: pErr } = await supabase.from("purchases")
      .select("*").eq("id", id).eq("shop_id", shopId).maybeSingle();
    if (pErr) throw pErr;
    if (!purchase) return res.status(404).json({ error: "Purchase nahi mila" });

    // Quantities already returned on earlier notes, so the same goods cannot be
    // sent back twice and reverse the credit twice.
    const { data: priorNotes } = await supabase.from("debit_notes")
      .select("return_quantity").eq("purchase_id", id);
    const alreadyReturned = (priorNotes || []).reduce((s, n) => s + (parseFloat(n.return_quantity) || 0), 0);
    const remaining = (parseFloat(purchase.quantity_boxes) || 0) - alreadyReturned;
    if (remaining <= 0) {
      return res.status(409).json({ error: "Is purchase ka sara maal pehle hi wapas ho chuka hai" });
    }

    const note = computeDebitNote({
      purchase: { ...purchase, quantity_boxes: remaining },
      returnQuantity,
      reason,
    });
    if (!note) return res.status(400).json({ error: "Wapas karne layak maal nahi hai" });

    // Stock must actually leave the shelf. Doing this before the note is written
    // means a failure here stops the whole return rather than producing a
    // document for goods still sitting in the shop.
    const { data: inv } = await supabase.from("inventory")
      .select("id, quantity_boxes").eq("shop_id", shopId).eq("design_id", purchase.design_id).maybeSingle();
    if (inv) {
      const newQty = Math.max(0, (parseFloat(inv.quantity_boxes) || 0) - note.returnQuantity);
      const { error: invErr } = await supabase.from("inventory")
        .update({ quantity_boxes: newQty }).eq("id", inv.id);
      if (invErr) throw invErr;
    }

    const fy = financialYear();
    const { count } = await supabase.from("debit_notes")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId).eq("financial_year", fy);

    let saved = null, lastErr = null;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      const sequence = (count || 0) + 1 + attempt;
      const { data, error } = await supabase.from("debit_notes").insert([{
        shop_id: shopId,
        purchase_id: id,
        debit_note_number: debitNoteNumber({ sequence, financialYear: fy }),
        financial_year: fy,
        sequence,
        reason: note.reason,
        supplier_name: purchase.supplier_name,
        supplier_gstin: purchase.supplier_gstin,
        supplier_invoice_no: purchase.supplier_invoice_no,
        original_purchase_date: purchase.purchase_date,
        design_id: purchase.design_id,
        return_quantity: note.returnQuantity,
        cost_per_unit: note.costPerUnit,
        taxable_value: note.taxableValue,
        cgst_amount: note.cgst,
        sgst_amount: note.sgst,
        igst_amount: note.igst,
        total_debit: note.totalDebit,
        is_inter_state: !!purchase.is_inter_state,
        is_full_return: note.isFullReturn,
        itc_reversed: note.itcReversed,
      }]).select().single();
      if (!error) { saved = data; break; }
      lastErr = noteIfRlsError("debit_notes", error);
      if (!/duplicate key|unique/i.test(error.message || "")) break;
    }

    if (!saved) {
      const migrationMissing = /relation|does not exist|schema cache/i.test(lastErr?.message || "");
      return res.status(migrationMissing ? 501 : 500).json({
        error: migrationMissing
          ? "Debit note table nahi hai — migration 20260806000000 chalayein"
          : `Debit note ban nahi paya: ${lastErr?.message}`,
        stockAdjusted: true,
      });
    }

    res.json({
      success: true,
      debitNote: saved,
      itcReversed: note.itcReversed,
      note: note.itcReversed
        ? `₹${note.taxReversed.toLocaleString("en-IN")} input credit reversed on this return.`
        : "No input credit was claimed on this purchase, so nothing is reversed.",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/debit-notes/:shopId", async (req, res) => {
  try {
    const { data, error } = await supabase.from("debit_notes")
      .select("*").eq("shop_id", req.params.shopId).order("issued_at", { ascending: false }).limit(500);
    if (error && /relation|does not exist|schema cache/i.test(error.message || "")) {
      return res.json({ debitNotes: [], unavailable: true });
    }
    if (error) throw error;
    const notes = data || [];
    res.json({
      debitNotes: notes,
      totalDebited: Math.round(notes.reduce((s, n) => s + (parseFloat(n.total_debit) || 0), 0)),
      itcReversedTotal: Math.round(notes.reduce((s, n) =>
        s + (n.itc_reversed ? (parseFloat(n.cgst_amount) || 0) + (parseFloat(n.sgst_amount) || 0) + (parseFloat(n.igst_amount) || 0) : 0), 0)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DECISIONS — what the shopkeeper should actually do
//
// Every number here comes from standard operations research (see lib/opsResearch.js
// for the formulas and their sources), computed from this shop's own history.
// Nothing on this route is generated by a language model. The model's job, when
// it runs at all, is to say these findings in the shopkeeper's language — never
// to decide what they are.
//
// The other half of the design is restraint: a shop three weeks old has no
// demand distribution worth the name, so a recommendation that cannot be
// supported is withheld rather than dressed up in arithmetic.
// ============================================

// Lead time is not measurable from what the app records — purchases carry the
// date stock arrived, never the date it was ordered. Rather than infer one from
// nothing, a default is assumed and every recommendation that depends on it says
// so, so a shopkeeper who knows their supplier takes 15 days can discount the
// advice accordingly.
const ASSUMED_LEAD_TIME_DAYS = 7;
const DEAD_STOCK_DAYS = 60;

async function computeDecisions(shopId, query = {}) {
  {
    const req = { params: { shopId }, query };
    const windowDays = Math.min(365, Math.max(30, parseInt(req.query.days) || 90));
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();
    const leadTime = Math.max(1, parseFloat(req.query.leadTimeDays) || ASSUMED_LEAD_TIME_DAYS);
    const serviceLevel = Math.min(0.995, Math.max(0.5, parseFloat(req.query.serviceLevel) || 0.95));

    const [salesRes, invRes, purchRes, bakayaInvRes, expRes] = await Promise.allSettled([
      supabase.from("invoices")
        .select("id, created_at, payment_status, invoice_items(design_id, quantity_boxes, price_per_box)")
        .eq("shop_id", shopId).gte("created_at", since)
        .not("payment_status", "in", '("cancelled","returned")').limit(3000),
      supabase.from("inventory")
        .select("design_id, quantity_boxes, expiry_date, last_cost_price, designs(design_code, design_name, unit_type)")
        .eq("shop_id", shopId),
      // All purchases, not just the window: stock bought eight months ago still
      // has a cost, and without it the money-stuck-on-the-shelf finding — the
      // most valuable one this engine produces — never fires at all.
      supabase.from("purchases").select("design_id, quantity_boxes, cost_per_box, purchase_date")
        .eq("shop_id", shopId).order("purchase_date", { ascending: true }).limit(5000),
      supabase.from("invoices")
        .select(`created_at, amount_paid, taxable_value, cgst_amount, sgst_amount${igstCol()}, payment_status, invoice_items(quantity_boxes, price_per_box)`)
        .eq("shop_id", shopId).in("payment_status", ["credit", "partial"]).limit(2000),
      supabase.from("expenses").select("amount, expense_date").eq("shop_id", shopId).gte("expense_date", since),
    ]);

    const rows = (r) => (r.status === "fulfilled" && !r.value.error ? r.value.data || [] : []);
    const sales = rows(salesRes);
    const inventory = rows(invRes);
    const purchases = rows(purchRes);
    const openInvoices = rows(bakayaInvRes);
    const expenses = rows(expRes);

    // Daily units sold per design, so demand has a distribution rather than a single average.
    const dayKey = (iso) => new Date(new Date(iso).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
    const perDesign = {};
    for (const inv of sales) {
      const day = dayKey(inv.created_at);
      for (const item of (inv.invoice_items || [])) {
        const d = item.design_id;
        if (!d) continue;
        perDesign[d] = perDesign[d] || { daily: {}, revenue: 0, units: 0, lastSold: null };
        perDesign[d].daily[day] = (perDesign[d].daily[day] || 0) + (parseFloat(item.quantity_boxes) || 0);
        perDesign[d].units += parseFloat(item.quantity_boxes) || 0;
        perDesign[d].revenue += (parseFloat(item.quantity_boxes) || 0) * (parseFloat(item.price_per_box) || 0);
        if (!perDesign[d].lastSold || inv.created_at > perDesign[d].lastSold) perDesign[d].lastSold = inv.created_at;
      }
    }

    // Last known cost per design, for valuing what is sitting on the shelf.
    // Purchases are ordered oldest-first, so the last write wins = most recent.
    const lastCost = {};
    for (const p of purchases) {
      const c = parseFloat(p.cost_per_box) || 0;
      if (p.design_id && c > 0) lastCost[p.design_id] = c;
    }

    // Where a shop has both a recorded purchase price and a cost typed into the
    // pricing editor, the purchase wins. One is a transaction that happened; the
    // other is a number someone typed into a form, and in real data the typed
    // field frequently holds a selling price by mistake — which would value the
    // shelf at several times what it is worth and turn every dead-stock figure
    // into fiction.
    const costFor = (row) => {
      const purchased = lastCost[row.design_id] || 0;
      const typed = parseFloat(row.last_cost_price) || 0;
      return purchased > 0 ? purchased : typed;
    };

    const recommendations = [];
    const abcInput = [];

    for (const row of inventory) {
      const d = row.design_id;
      const name = row.designs?.design_name || row.designs?.design_code || "product";
      const unit = row.designs?.unit_type || "units";
      const onHand = parseFloat(row.quantity_boxes) || 0;
      const stats = perDesign[d];
      const cost = costFor(row);

      // Demand series across the whole window, zeros included — a product that
      // sold 50 on one day and nothing for 89 others is not "50 a day".
      const series = [];
      for (let i = 0; i < windowDays; i++) {
        const day = new Date(Date.now() - i * 86400000);
        series.push(stats?.daily[dayKey(day.toISOString())] || 0);
      }
      const avgDaily = ops.mean(series);
      const sdDaily = ops.stdDev(series);
      const sellingDays = series.filter(x => x > 0).length;
      const confidence = ops.confidenceFrom({ observations: sellingDays, daysOfHistory: windowDays });

      abcInput.push({ designId: d, name, annualValue: (stats?.revenue || 0) * (365 / windowDays) });

      // ── Restock: reorder point vs what is on the shelf ──
      if (confidence.usable && avgDaily > 0) {
        const rop = ops.reorderPoint({
          avgDailyDemand: avgDaily, sdDailyDemand: sdDaily,
          avgLeadTimeDays: leadTime, serviceLevel,
        });
        const runway = ops.stockRunway({ onHand, avgDailyDemand: avgDaily, avgLeadTimeDays: leadTime });

        if (onHand <= rop.reorderPoint) {
          // Order enough to cover the lead time plus a cycle, less what is left.
          const suggested = Math.max(0, Math.ceil(rop.reorderPoint + avgDaily * leadTime - onHand));
          recommendations.push({
            type: "restock",
            priority: runway.urgent ? "high" : "medium",
            designId: d,
            title: `Order ${suggested} ${unit} of ${name}`,
            because: {
              onHand: Math.round(onHand * 100) / 100,
              sellsPerDay: Math.round(avgDaily * 100) / 100,
              daysLeft: runway.daysLeft,
              reorderPoint: rop.reorderPoint,
              safetyStock: rop.safetyStock,
              assumedLeadTimeDays: leadTime,
              serviceLevel,
            },
            // Value at risk: what a stockout would cost in lost sales over the
            // lead time, not the value of the order.
            rupeeImpact: Math.round(avgDaily * leadTime * (cost || 0)),
            method: "Reorder point with safety stock (variable demand and lead time)",
            confidence: confidence.level,
          });
        }
      }

      // ── Dead stock: capital sitting still ──
      const daysSinceSold = stats?.lastSold
        ? Math.floor((Date.now() - new Date(stats.lastSold).getTime()) / 86400000)
        : null;
      if (onHand > 0 && cost > 0 && (daysSinceSold === null || daysSinceSold >= DEAD_STOCK_DAYS)) {
        const tied = Math.round(onHand * cost);
        if (tied >= 1000) {
          recommendations.push({
            type: "dead_stock",
            priority: tied >= 20000 ? "high" : "medium",
            designId: d,
            title: `₹${tied.toLocaleString("en-IN")} stuck in ${name}`,
            because: {
              onHand: Math.round(onHand * 100) / 100,
              daysSinceLastSale: daysSinceSold,
              costPerUnit: cost,
              neverSold: daysSinceSold === null,
            },
            rupeeImpact: tied,
            method: "No movement in the observation window; capital valued at last known cost",
            confidence: windowDays >= 60 ? "high" : "low",
          });
        }
      }

      // ── Expiry: a deadline the shelf imposes ──
      if (row.expiry_date && onHand > 0) {
        const daysToExpiry = Math.floor((new Date(row.expiry_date) - Date.now()) / 86400000);
        if (daysToExpiry <= 30) {
          const clearable = avgDaily > 0 ? Math.min(onHand, avgDaily * Math.max(0, daysToExpiry)) : 0;
          const atRisk = Math.round(Math.max(0, onHand - clearable) * (cost || 0));
          if (atRisk > 0 || daysToExpiry < 0) {
            recommendations.push({
              type: "expiry",
              priority: daysToExpiry <= 7 ? "high" : "medium",
              designId: d,
              title: daysToExpiry < 0
                ? `${name} has expired — remove ${Math.round(onHand)} ${unit}`
                : `Clear ${name} within ${daysToExpiry} days or lose ₹${atRisk.toLocaleString("en-IN")}`,
              because: {
                onHand: Math.round(onHand * 100) / 100,
                daysToExpiry,
                sellsPerDay: Math.round(avgDaily * 100) / 100,
                willSellBeforeExpiry: Math.round(clearable * 100) / 100,
              },
              rupeeImpact: atRisk,
              method: "Expiry date against observed sales rate",
              confidence: confidence.level,
            });
          }
        }
      }
    }

    // ── ABC: where attention is worth spending ──
    const abc = ops.abcClassification(abcInput);
    const classA = abc.filter(i => i.class === "A");

    // ── Receivables: how long the shop's money sits elsewhere ──
    const outstanding = openInvoices.reduce((s, inv) => {
      const items = inv.invoice_items || [];
      const net = inv.taxable_value != null
        ? invoiceGrossValue(inv)
        : items.reduce((t, i) => t + (i.quantity_boxes || 0) * (i.price_per_box || 0), 0);
      return s + Math.max(0, net - (inv.amount_paid || 0));
    }, 0);
    const creditSalesInWindow = openInvoices.reduce((s, inv) => {
      const items = inv.invoice_items || [];
      return s + (inv.taxable_value != null
        ? invoiceGrossValue(inv)
        : items.reduce((t, i) => t + (i.quantity_boxes || 0) * (i.price_per_box || 0), 0));
    }, 0);
    const dso = ops.daysSalesOutstanding({
      receivables: outstanding, creditSales: creditSalesInWindow, periodDays: windowDays,
    });

    if (dso !== null && dso > 45 && outstanding > 0) {
      recommendations.push({
        type: "receivables",
        priority: dso > 90 ? "high" : "medium",
        title: `₹${Math.round(outstanding).toLocaleString("en-IN")} is taking about ${dso} days to come back`,
        because: { outstanding: Math.round(outstanding), daysSalesOutstanding: dso, windowDays },
        rupeeImpact: Math.round(outstanding),
        method: "Days sales outstanding = (receivables / credit sales) × days",
        confidence: openInvoices.length >= 5 ? "medium" : "low",
      });
    }

    // ── Inventory turnover: is capital working or resting ──
    const inventoryValue = inventory.reduce((s, r) =>
      s + (parseFloat(r.quantity_boxes) || 0) * costFor(r), 0);
    const cogsWindow = Object.entries(perDesign).reduce((s, [d, st]) => s + st.units * (lastCost[d] || 0), 0);
    const turnover = ops.inventoryTurnover({
      costOfGoodsSold: cogsWindow * (365 / windowDays),
      averageInventoryValue: inventoryValue,
    });

    // A shop that barely sold anything in the window produces a technically
    // correct "5441 days of inventory". That number is arithmetic, not
    // information — it alarms without informing. Below a quarter of a turn a
    // year there simply is not enough movement to describe, and saying so is
    // more useful than printing a figure nobody can act on.
    const turnoverMeaningful = !!turnover && turnover.turnover >= 0.25;

    // Where the typed cost and the actual purchase price disagree badly, that is
    // worth telling the shopkeeper: it is usually a selling price entered in a
    // cost field, and it silently distorts every margin and valuation they see.
    for (const row of inventory) {
      const purchased = lastCost[row.design_id] || 0;
      const typed = parseFloat(row.last_cost_price) || 0;
      if (purchased > 0 && typed > 0 && typed > purchased * 2) {
        recommendations.push({
          type: "data_check",
          priority: "low",
          designId: row.design_id,
          title: `Check the cost recorded for ${row.designs?.design_name || "a product"}`,
          because: {
            costTypedInApp: typed,
            actualPurchasePrice: purchased,
            note: "The cost saved in the pricing screen is far above what was actually paid — often a selling price entered by mistake.",
          },
          rupeeImpact: 0,
          method: "Comparison of the recorded purchase price against the cost stored on the product",
          confidence: "high",
        });
      }
    }

    recommendations.sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
      return (b.rupeeImpact || 0) - (a.rupeeImpact || 0);
    });

    return {
      windowDays,
      assumptions: {
        leadTimeDays: leadTime,
        leadTimeIsAssumed: !req.query.leadTimeDays,
        serviceLevel,
        note: "Lead time is not recorded anywhere in the app (purchases capture arrival, not order date), so it is assumed. Pass ?leadTimeDays= to use your supplier's real figure.",
      },
      recommendations: recommendations.slice(0, 20),
      totalRupeeImpact: recommendations.reduce((s, r) => s + (r.rupeeImpact || 0), 0),
      health: {
        inventoryValue: Math.round(inventoryValue),
        inventoryTurnover: turnoverMeaningful ? turnover.turnover : null,
        daysOfInventory: turnoverMeaningful ? turnover.daysOfInventory : null,
        turnoverNote: turnoverMeaningful ? null : "Too little movement in this period to measure turnover.",
        daysSalesOutstanding: dso,
        outstanding: Math.round(outstanding),
        expensesInWindow: Math.round(expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)),
      },
      abc: {
        classA: classA.slice(0, 10),
        counts: {
          A: abc.filter(i => i.class === "A").length,
          B: abc.filter(i => i.class === "B").length,
          C: abc.filter(i => i.class === "C").length,
        },
        note: "Class A items carry most of the value and deserve the tightest stock control.",
      },
      methodology: "Reorder point with safety stock, ABC/Pareto, inventory turnover and DSO — computed from this shop's own sales history. No figure on this page is generated by a language model.",
    };
  }
}

app.get("/api/decisions/:shopId", async (req, res) => {
  try {
    res.json(await computeDecisions(req.params.shopId, req.query));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// COUNTER CASH — open the day, close the day, find the difference
//
// The daily ritual of a small shop: count the box at closing time. What matters
// is not the day's sales but the gap between what the records imply and what is
// actually in hand. A ₹200 shortfall found the same evening is a question
// someone can still answer; found a month later it is unrecoverable.
// ============================================

// Everything that moved cash since the session opened.
async function cashMovementsSince(shopId, since) {
  const [invRes, eventRes, expRes, purchaseRes] = await Promise.allSettled([
    supabase.from("invoices")
      .select(`payment_mode, payment_status, taxable_value, cgst_amount, sgst_amount${igstCol()}, discount_amount, created_at, invoice_items(quantity_boxes, price_per_box)`)
      .eq("shop_id", shopId).gte("created_at", since)
      .not("payment_status", "in", '("cancelled","returned","credit")'),
    supabase.from("payment_events")
      .select("amount, payment_mode, created_at").eq("shop_id", shopId).gte("created_at", since),
    supabase.from("expenses")
      .select("amount, payment_mode, expense_date").eq("shop_id", shopId).gte("expense_date", since),
    supabase.from("purchases")
      .select("amount_paid, payment_status, purchase_date").eq("shop_id", shopId).gte("purchase_date", since),
  ]);

  const rows = (r) => (r.status === "fulfilled" && !r.value.error ? r.value.data || [] : []);

  // Bill value as the customer paid it: taxable + GST, or items minus discount
  // for a non-GST bill.
  const billValue = (inv) => {
    if (inv.taxable_value != null) {
      return invoiceGrossValue(inv);
    }
    const gross = (inv.invoice_items || []).reduce((s, i) => s + (i.quantity_boxes || 0) * (i.price_per_box || 0), 0);
    return Math.max(0, gross - (inv.discount_amount || 0));
  };

  const invoices = rows(invRes);
  const modes = summarisePaymentModes(invoices, { amountOf: billValue });

  // Collections against older udhari. Payment events carry their own mode.
  const cashCollections = rows(eventRes)
    .filter(e => String(e.payment_mode || "").toLowerCase() === "cash")
    .reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

  // Expenses with no mode recorded are treated as cash: petty shop expenses are
  // overwhelmingly paid from the drawer, and the alternative — ignoring them —
  // would systematically overstate the cash that should be in hand.
  const cashExpenses = rows(expRes)
    .filter(e => ["cash", "", null, undefined].includes(e.payment_mode ? String(e.payment_mode).toLowerCase() : ""))
    .reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

  const cashPayouts = rows(purchaseRes).reduce((s, p) => s + (parseFloat(p.amount_paid) || 0), 0);

  return {
    cashSales: modes.cash,
    modes,
    cashCollections: Math.round(cashCollections * 100) / 100,
    cashExpenses: Math.round(cashExpenses * 100) / 100,
    cashPayouts: Math.round(cashPayouts * 100) / 100,
    invoiceCount: invoices.length,
  };
}

// Start the day with what is already in the drawer.
app.post("/api/cash-sessions/open", async (req, res) => {
  try {
    const { shopId, openingCash, staffId } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });

    const { data: existing } = await supabase.from("cash_sessions")
      .select("id").eq("shop_id", shopId).is("closed_at", null).maybeSingle();
    if (existing) return res.status(409).json({ error: "Ek din pehle se khula hai", sessionId: existing.id });

    const { data, error } = await supabase.from("cash_sessions").insert([{
      shop_id: shopId,
      opening_cash: parseFloat(openingCash) || 0,
      opened_by: staffId || null,
    }]).select().single();
    if (noteIfRlsError("cash_sessions", error)) throw error;
    res.json({ success: true, session: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// The open session with a live view of what the drawer should hold.
app.get("/api/cash-sessions/current/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const { data: session, error } = await supabase.from("cash_sessions")
      .select("*").eq("shop_id", shopId).is("closed_at", null).maybeSingle();

    if (error && /relation|does not exist|schema cache/i.test(error.message || "")) {
      return res.json({ open: false, unavailable: true });
    }
    if (!session) return res.json({ open: false });

    const movements = await cashMovementsSince(shopId, session.opened_at);
    const expected = expectedCash({ openingCash: session.opening_cash, ...movements });

    res.json({ open: true, session, movements, expectedCash: expected });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Close the day: count the box, record the difference while memory is fresh.
app.post("/api/cash-sessions/:id/close", async (req, res) => {
  try {
    const { id } = req.params;
    const { shopId, countedCash, note, staffId } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    if (countedCash === undefined || countedCash === null || countedCash === "") {
      return res.status(400).json({ error: "Ginti hui nagdi daalein" });
    }

    // Scope by shop as well as id — an id alone must never close another shop's day.
    const { data: session, error: findErr } = await supabase.from("cash_sessions")
      .select("*").eq("id", id).eq("shop_id", shopId).maybeSingle();
    if (findErr) throw findErr;
    if (!session) return res.status(404).json({ error: "Session nahi mila" });
    if (session.closed_at) return res.status(409).json({ error: "Yeh din pehle hi band ho chuka hai" });

    const movements = await cashMovementsSince(shopId, session.opened_at);
    const expected = expectedCash({ openingCash: session.opening_cash, ...movements });
    const result = reconcile({ counted: parseFloat(countedCash), expected });

    const { data, error } = await supabase.from("cash_sessions").update({
      closed_at: new Date().toISOString(),
      closed_by: staffId || null,
      counted_cash: result.counted,
      expected_cash: result.expected,
      difference: result.difference,
      cash_sales: movements.cashSales,
      cash_collections: movements.cashCollections,
      cash_expenses: movements.cashExpenses,
      cash_payouts: movements.cashPayouts,
      note: note || null,
    }).eq("id", id).eq("shop_id", shopId).select().single();
    if (error) throw error;

    res.json({ success: true, session: data, reconciliation: result, movements });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Past days, for spotting a pattern rather than a one-off.
app.get("/api/cash-sessions/:shopId", async (req, res) => {
  try {
    const { data, error } = await supabase.from("cash_sessions")
      .select("*").eq("shop_id", req.params.shopId)
      .not("closed_at", "is", null)
      .order("opened_at", { ascending: false }).limit(30);
    if (error && /relation|does not exist|schema cache/i.test(error.message || "")) {
      return res.json({ sessions: [], unavailable: true });
    }
    if (error) throw error;

    const sessions = data || [];
    const shortDays = sessions.filter(s => (parseFloat(s.difference) || 0) < -5).length;
    const totalShort = sessions.reduce((sum, s) => {
      const d = parseFloat(s.difference) || 0;
      return d < 0 ? sum + Math.abs(d) : sum;
    }, 0);

    res.json({ sessions, shortDays, totalShort: Math.round(totalShort) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DATA EXPORT — the shopkeeper's own data, on demand
//
// A business asked to run itself inside FastBill must be able to take everything
// back out: for their accountant, for their own records, and as the honest answer
// to "what happens if you shut down". Nothing here is a favour to the user; a
// system of record that cannot be exported is a hostage.
//
// This is a bulk exfiltration endpoint, so it is deliberately stricter than the
// rest of the API: POST (never a shareable GET URL), the account PIN must be
// re-entered, and it is rate limited. Until proper sessions exist, knowing a
// shop's UUID must not be enough to walk away with the whole business.
// ============================================

const exportLimiter = makeLimiter(10, 60 * 60 * 1000); // 10 exports/hour per IP

// Shared gate: verify the PIN belongs to this shop before releasing any bulk data.
async function verifyShopPin(shopId, pin) {
  if (!shopId) return { ok: false, status: 400, error: "shopId required" };
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return { ok: false, status: 400, error: "PIN 4-6 digit ka hona chahiye" };

  const { data: shop, error } = await supabase
    .from("shops").select("id, name, owner_name, phone, address, shop_type, gstin, pan_number, upi_id, shop_id_display, pin_hash, created_at")
    .eq("id", shopId).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!shop) return { ok: false, status: 404, error: "Shop nahi mila" };
  if (!shop.pin_hash) return { ok: false, status: 403, error: "Pehle app me PIN set karein" };

  const match = await bcrypt.compare(String(pin), shop.pin_hash);
  if (!match) return { ok: false, status: 401, error: "Galat PIN" };

  const { pin_hash, ...safeShop } = shop;
  return { ok: true, shop: safeShop };
}

// Everything this shop owns, as one JSON document.
app.post("/api/export/:shopId", exportLimiter, async (req, res) => {
  try {
    const { shopId } = req.params;
    const gate = await verifyShopPin(shopId, req.body?.pin);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

    // Invoices carry their line items so a bill can be reconstructed from the
    // export alone — an export you cannot rebuild from is not portability.
    const [invoices, inventory, purchases, expenses, payments, staff, recurring, bank] = await Promise.all([
      supabase.from("invoices").select("*, invoice_items(*)").eq("shop_id", shopId).order("created_at"),
      supabase.from("inventory").select("*, designs(design_code, design_name, color, hsn_code, default_gst_rate, unit_type)").eq("shop_id", shopId),
      supabase.from("purchases").select("*").eq("shop_id", shopId).order("purchase_date"),
      supabase.from("expenses").select("*").eq("shop_id", shopId).order("expense_date"),
      supabase.from("payment_events").select("*").eq("shop_id", shopId).order("created_at"),
      supabase.from("shop_staff").select("id, staff_name, phone, can_edit_price, can_delete, can_manage_staff, active, created_at").eq("shop_id", shopId),
      supabase.from("recurring_invoices").select("*").eq("shop_id", shopId),
      supabase.from("bank_transactions").select("*").eq("shop_id", shopId).order("txn_date"),
    ]);

    // A table that does not exist yet (migration not run) must not fail the whole
    // export — the rest of the shop's data is still theirs to take.
    const rows = (r) => (r && !r.error ? r.data || [] : []);
    const skipped = [
      ["staff", staff], ["recurringInvoices", recurring], ["bankTransactions", bank],
    ].filter(([, r]) => r && r.error).map(([name]) => name);

    res.json({
      exportedAt: new Date().toISOString(),
      format: "fastbill-export-v1",
      shop: gate.shop,
      counts: {
        invoices: rows(invoices).length,
        inventory: rows(inventory).length,
        purchases: rows(purchases).length,
        expenses: rows(expenses).length,
        paymentEvents: rows(payments).length,
      },
      invoices: rows(invoices),
      inventory: rows(inventory),
      purchases: rows(purchases),
      expenses: rows(expenses),
      paymentEvents: rows(payments),
      staff: rows(staff),
      recurringInvoices: rows(recurring),
      bankTransactions: rows(bank),
      // Honest about what could not be included, rather than silently omitting it.
      unavailable: skipped,
      note: "Your data, exported from FastBill. Keep this file safe — it contains customer names and phone numbers.",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// One entity as a spreadsheet, for handing to an accountant.
app.post("/api/export/:shopId/csv", exportLimiter, async (req, res) => {
  try {
    const { shopId } = req.params;
    const entity = String(req.query.entity || req.body?.entity || "invoices");
    const gate = await verifyShopPin(shopId, req.body?.pin);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

    let rows = [];
    let columns = null;

    if (entity === "invoices") {
      const { data } = await supabase.from("invoices")
        .select(`invoice_number, created_at, customer_name, customer_phone, customer_gstin, invoice_type, is_gst_invoice, taxable_value, cgst_amount, sgst_amount${igstCol()}, discount_amount, payment_status, amount_paid`)
        .eq("shop_id", shopId).order("created_at");
      rows = (data || []).map(r => ({
        ...r,
        // The figure a shopkeeper actually recognises as the bill amount.
        total: Math.round((invoiceGrossValue(r)) * 100) / 100,
      }));
    } else if (entity === "invoice_items") {
      const { data } = await supabase.from("invoices")
        .select("invoice_number, created_at, invoice_items(quantity_boxes, price_per_box, hsn_code, gst_rate, designs(design_code, design_name))")
        .eq("shop_id", shopId).order("created_at");
      rows = (data || []).flatMap(inv => (inv.invoice_items || []).map(it => ({
        invoice_number: inv.invoice_number,
        date: inv.created_at,
        product_code: it.designs?.design_code || null,
        product: it.designs?.design_name || null,
        quantity: it.quantity_boxes,
        rate: it.price_per_box,
        hsn_code: it.hsn_code,
        gst_rate: it.gst_rate,
        line_total: Math.round((it.quantity_boxes || 0) * (it.price_per_box || 0) * 100) / 100,
      })));
    } else if (entity === "purchases") {
      const { data } = await supabase.from("purchases").select("*").eq("shop_id", shopId).order("purchase_date");
      rows = data || [];
    } else if (entity === "inventory") {
      const { data } = await supabase.from("inventory")
        .select("quantity_boxes, low_stock_threshold, expiry_date, last_restocked_at, designs(design_code, design_name, color, hsn_code, default_gst_rate, unit_type)")
        .eq("shop_id", shopId);
      rows = (data || []).map(r => ({
        product_code: r.designs?.design_code || null,
        product: r.designs?.design_name || null,
        colour: r.designs?.color || null,
        unit: r.designs?.unit_type || null,
        hsn_code: r.designs?.hsn_code || null,
        gst_rate: r.designs?.default_gst_rate || null,
        quantity: r.quantity_boxes,
        low_stock_threshold: r.low_stock_threshold,
        expiry_date: r.expiry_date,
        last_restocked_at: r.last_restocked_at,
      }));
    } else if (entity === "expenses") {
      const { data } = await supabase.from("expenses").select("category, amount, note, expense_date").eq("shop_id", shopId).order("expense_date");
      rows = data || [];
    } else {
      return res.status(400).json({ error: "Unknown entity. Use invoices, invoice_items, purchases, inventory or expenses." });
    }

    const csv = toCsv(rows, columns);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="fastbill-${entity}-${stamp}.csv"`);
    // UTF-8 BOM so Excel renders Devanagari and other Indic scripts correctly
    // instead of mojibake — without it a Hindi customer name is unreadable.
    res.send("﻿" + csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// The books, in the shape the shopkeeper's accountant actually works in.
//
// FastBill will not beat Tally at accounting and should not try. A clean
// handoff turns the incumbent from a competitor into a channel — and removes
// the most common reason a shop would abandon this app at year end.
//
// PIN-gated like every other bulk export: this is the whole book.
app.post("/api/export/:shopId/tally", exportLimiter, async (req, res) => {
  try {
    const { shopId } = req.params;
    const gate = await verifyShopPin(shopId, req.body?.pin);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

    // Default to the current financial year, which is the unit a CA works in.
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 3600000);
    const fyStartYear = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
    const from = req.body?.from || `${fyStartYear}-04-01T00:00:00+05:30`;
    const to = req.body?.to || `${fyStartYear + 1}-03-31T23:59:59+05:30`;

    const [invRes, purchRes, cnRes] = await Promise.allSettled([
      supabase.from("invoices")
        .select(`id, invoice_number, created_at, customer_name, customer_gstin, is_gst_invoice, taxable_value, cgst_amount, sgst_amount${igstCol()}, discount_amount, payment_status, invoice_items(quantity_boxes, price_per_box)`)
        .eq("shop_id", shopId).gte("created_at", from).lte("created_at", to)
        .not("payment_status", "in", '("cancelled")')
        .order("created_at"),
      supabase.from("purchases").select("*").eq("shop_id", shopId)
        .gte("purchase_date", from).lte("purchase_date", to).order("purchase_date"),
      supabase.from("credit_notes").select("*").eq("shop_id", shopId)
        .gte("issued_at", from).lte("issued_at", to).order("issued_at"),
    ]);

    const rows = (r) => (r.status === "fulfilled" && !r.value.error ? r.value.data || [] : []);

    // Attach the bill value the app itself computes, so the exporter can check
    // its vouchers against it rather than trusting the stored tax fields alone.
    const invoices = rows(invRes).map(inv => ({
      ...inv,
      grossAmount: inv.taxable_value != null
        ? invoiceGrossValue(inv)
        : Math.max(0, (inv.invoice_items || []).reduce((s, i) => s + (i.quantity_boxes || 0) * (i.price_per_box || 0), 0) - (inv.discount_amount || 0)),
    }));

    const { xml, voucherCount, rejected } = buildTallyXml({
      companyName: gate.shop?.name,
      invoices,
      purchases: rows(purchRes),
      creditNotes: rows(cnRes),
    });

    if (req.body?.format === "json") {
      // Lets the app show what will be sent, and what could not be, before the
      // shopkeeper hands a file to their accountant.
      return res.json({ voucherCount, rejected, from, to, xmlLength: xml.length });
    }

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tally-${fyStartYear}-${String(fyStartYear + 1).slice(2)}.xml"`);
    // Rejected vouchers travel in a header so a caller downloading the file
    // still learns that something was left out.
    res.setHeader("X-Vouchers-Exported", String(voucherCount));
    res.setHeader("X-Vouchers-Rejected", String(rejected.length));
    res.send(xml);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PILOT FEEDBACK — in-app "something is wrong / missing" capture
// ============================================

// Rate-limited with the shared auth limiter tier if available (spam guard), else open.
app.post("/api/feedback", async (req, res) => {
  try {
    const { shopId, shopName, phone, rating, message, screen, appVersion, platform, lang } = req.body;
    const text = (message || "").trim();
    if (!text) return res.status(400).json({ error: "message required" });
    if (text.length > 2000) return res.status(400).json({ error: "message too long" });
    if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ error: "rating must be 1-5" });
    }

    const { error: rawFeedbackErr } = await supabase.from("feedback").insert([{
      shop_id: shopId || null,
      shop_name: shopName || null,
      phone: phone || null,
      rating: rating ?? null,
      message: text,
      screen: screen || null,
      app_version: appVersion || null,
      platform: platform || null,
      lang: lang || null,
    }]);
    const error = noteIfRlsError("feedback", rawFeedbackErr);
    if (error) throw error;

    res.json({ message: "✓ Feedback received" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI-Powered Alerts
// Dashboard ad slot — returns the single highest-priority active ad, optionally targeted to
// this shop's type. Content is managed directly in the ads table (Supabase), no app update needed.
app.get("/api/ads/active", async (req, res) => {
  try {
    const { shopType } = req.query;
    const now = new Date().toISOString();
    let query = supabase.from("ads").select("*")
      .eq("active", true)
      .lte("starts_at", now)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });
    const { data, error } = await query;
    if (error) throw error;

    const live = (data || []).filter(ad => !ad.ends_at || ad.ends_at > now);
    const targeted = shopType ? live.find(ad => ad.shop_type === shopType) : null;
    const generic = live.find(ad => !ad.shop_type);
    const ad = targeted || generic || live[0] || null;
    res.json({ ad });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// BANK RECONCILIATION (CSV import — no live bank API)
// ============================================

app.post("/api/bank-transactions/import", async (req, res) => {
  try {
    const { shopId, transactions } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    if (!Array.isArray(transactions) || transactions.length === 0) return res.status(400).json({ error: "transactions array required" });

    const rows = transactions.map(t => ({
      shop_id: shopId,
      txn_date: t.date,
      description: t.description || null,
      amount: Math.abs(parseFloat(t.amount) || 0),
      txn_type: t.type === 'debit' ? 'debit' : 'credit',
    })).filter(r => r.txn_date && r.amount > 0);

    if (rows.length === 0) return res.status(400).json({ error: "No valid rows to import" });

    const { data, error } = await supabase.from("bank_transactions").insert(rows).select();
    if (error) throw error;
    res.json({ success: true, imported: data.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/bank-transactions/:shopId", async (req, res) => {
  try {
    const { unreconciled } = req.query;
    let query = supabase.from("bank_transactions").select("*").eq("shop_id", req.params.shopId).order("txn_date", { ascending: false });
    if (unreconciled === 'true') query = query.eq("reconciled", false);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ transactions: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Suggest matches — credit txns against unpaid/partial invoices, debit txns against unpaid
// purchases, same shop, matching amount (±₹1 rounding tolerance) within a 7-day window.
// Suggestions only — nothing is auto-marked reconciled, the shopkeeper confirms each one.
app.get("/api/bank-transactions/:shopId/suggestions", async (req, res) => {
  try {
    const { shopId } = req.params;
    const { data: unreconciled, error } = await supabase.from("bank_transactions")
      .select("*").eq("shop_id", shopId).eq("reconciled", false);
    if (error) throw error;

    const { data: invoices } = await supabase.from("invoices")
      .select(`id, invoice_number, customer_name, taxable_value, cgst_amount, sgst_amount${igstCol()}, discount_amount, payment_status, created_at`)
      .eq("shop_id", shopId).in("payment_status", ["credit", "partial"]);
    const { data: purchases } = await supabase.from("purchases")
      .select("id, supplier_name, cost_per_box, quantity_boxes, extra_cost, payment_status, purchase_date")
      .eq("shop_id", shopId).in("payment_status", ["unpaid", "partial"]);

    const withinDays = (a, b, days) => Math.abs(new Date(a) - new Date(b)) <= days * 86400000;

    const suggestions = (unreconciled || []).map(txn => {
      let candidates = [];
      if (txn.txn_type === 'credit') {
        candidates = (invoices || []).filter(inv => {
          const total = invoiceGrossValue(inv);
          return Math.abs(total - txn.amount) <= 1 && withinDays(inv.created_at, txn.txn_date, 7);
        }).map(inv => ({ type: 'invoice', id: inv.id, label: `${inv.invoice_number} — ${inv.customer_name}` }));
      } else {
        candidates = (purchases || []).filter(p => {
          const total = (p.cost_per_box || 0) * (p.quantity_boxes || 0) + (p.extra_cost || 0);
          return Math.abs(total - txn.amount) <= 1 && withinDays(p.purchase_date, txn.txn_date, 7);
        }).map(p => ({ type: 'purchase', id: p.id, label: `${p.supplier_name} — ₹${Math.round((p.cost_per_box || 0) * (p.quantity_boxes || 0))}` }));
      }
      return { transactionId: txn.id, amount: txn.amount, date: txn.txn_date, description: txn.description, txnType: txn.txn_type, candidates };
    }).filter(s => s.candidates.length > 0);

    res.json({ suggestions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/bank-transactions/:id/match", async (req, res) => {
  try {
    const { shopId, invoiceId, purchaseId, reconciled } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    const updates = { reconciled: reconciled !== false };
    if (invoiceId) updates.matched_invoice_id = invoiceId;
    if (purchaseId) updates.matched_purchase_id = purchaseId;
    const { data, error } = await supabase.from("bank_transactions")
      .update(updates).eq("id", req.params.id).eq("shop_id", shopId).select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Transaction not found in this shop" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/alerts/:shopId", async (req, res) => {
  try {
    const { data: inventory, error } = await supabase
      .from("inventory")
      .select(
        `
        *,
        designs(design_code, design_name)
      `
      )
      .eq("shop_id", req.params.shopId)
      .eq("is_low_stock", true);

    if (error) throw error;

    // Generate alert message using Gemini (free, no API key issues)
    let message = inventory.length > 0
      ? `${inventory.length} items low stock. Jaldi restock karo.`
      : "Sab items ka stock theek hai.";
    try {
      if (inventory.length > 0) {
        const names = inventory.slice(0, 5).map(i => i.designs?.design_name || i.designs?.design_code).filter(Boolean).join(', ');
        const prompt = `Ek dukandar ke paas ye items kam hain: ${names}. 1-2 short Hindi sentences mein urgent restock advice do.`;
        const gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 80 } }) }
        );
        const gData = await gRes.json();
        const text = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) message = text.trim();
      }
    } catch {}

    res.json({
      lowStockItems: inventory,
      message,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Selling price lives on tile_categories.base_price_per_box, shared by every design in that
// category — fine when a category genuinely is one priced product line, but scanned/quick-added
// products were being dumped into one shared "General" category per shop, so setting one
// product's price silently changed every other product sharing that category (and vice versa —
// the invoice screen and the inventory price-editor could show completely different numbers for
// the same-looking product because they were reading two different designs' shared category).
// Self-heals a shop the first time ANY price-setting action touches a design that's still sharing
// a category with siblings: clones the category exclusively for this design, keeping its current
// price/size as the starting point, then callers update price on the clone. No schema change,
// no data loss — just splits an over-shared row apart the first time it matters.
async function ensureExclusiveCategory(designId) {
  const { data: design } = await supabase.from("designs").select("category_id").eq("id", designId).maybeSingle();
  if (!design?.category_id) return null;

  const { data: siblings } = await supabase.from("designs").select("id").eq("category_id", design.category_id);
  if (!siblings || siblings.length <= 1) return design.category_id; // already exclusive to this design

  const { data: origCat, error: fetchErr } = await supabase
    .from("tile_categories").select("*").eq("id", design.category_id).maybeSingle();
  if (fetchErr || !origCat) return design.category_id;

  const { data: newCat, error: insErr } = await supabase.from("tile_categories").insert({
    shop_id: origCat.shop_id,
    category_name: origCat.category_name,
    size_mm: origCat.size_mm,
    coverage_sqft: origCat.coverage_sqft,
    base_price_per_box: origCat.base_price_per_box,
  }).select().single();
  if (insErr || !newCat) return design.category_id;

  await supabase.from("designs").update({ category_id: newCat.id }).eq("id", designId);
  return newCat.id;
}

// Shared Gemini vision helper
async function geminiVision(imageBase64, prompt, mimeType = "image/jpeg", maxOutputTokens = 800) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
        { text: prompt }
      ]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens }
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) }
  );
  if (!r.ok) { console.error("Gemini error:", r.status, (await r.text()).slice(0, 200)); return null; }
  const data = await r.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason === "MAX_TOKENS") console.error("Gemini response truncated (MAX_TOKENS) — raise maxOutputTokens for this call");
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ============================================
// AI — Photo → Product Identify (Gemini 1.5 Flash free)
// ============================================
app.post("/api/inventory/photo-identify", async (req, res) => {
  try {
    const { imageBase64, shopId } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    // Fetch shop's inventory for matching
    const { data: inventory } = await supabase
      .from("inventory")
      .select("design_id, designs(design_code, design_name, color)")
      .eq("shop_id", shopId);
    const productList = (inventory || []).map(i =>
      `${i.designs?.design_code}: ${i.designs?.design_name} ${i.designs?.color || ''}`
    ).join(", ");

    let description = null;

    // Primary: Gemini 1.5 Flash (free 15 RPM, has vision)
    description = await geminiVision(
      imageBase64,
      `Shop products: ${productList.slice(0, 500)}. What product is shown in this image? Match to closest product from the list if possible. Reply in one sentence with product name and code.`
    );

    // Fallback: local Ollama moondream (local dev only)
    if (!description && process.env.OLLAMA_URL) {
      try {
        const r = await fetch(`${process.env.OLLAMA_URL}/api/generate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "moondream:latest", prompt: `Products: ${productList.slice(0,300)}. What product is this?`, images: [imageBase64], stream: false }),
          signal: AbortSignal.timeout(20000),
        });
        if (r.ok) description = (await r.json()).response || null;
      } catch {}
    }

    // Try to match description to existing inventory
    const descLower = (description || '').toLowerCase();
    const matched = (inventory || []).find(i => {
      const code = (i.designs?.design_code || '').toLowerCase();
      const name = (i.designs?.design_name || '').toLowerCase();
      return descLower.includes(code) || descLower.includes(name);
    });

    res.json({
      description,
      matchedDesignId: matched?.design_id || null,
      matchedName: matched ? `${matched.designs?.design_code} — ${matched.designs?.design_name}` : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, description: null, matchedDesignId: null });
  }
});

// ============================================
// Customer Credit Score (rule-based, free)
// ============================================
app.get("/api/customers/credit-score/:shopId/:customerName", async (req, res) => {
  try {
    const { shopId, customerName } = req.params;
    const { data: invoices } = await supabase
      .from("invoices")
      .select(`payment_status, amount_paid, taxable_value, cgst_amount, sgst_amount${igstCol()}, created_at, invoice_items(quantity_boxes, price_per_box)`)
      .eq("shop_id", shopId)
      .ilike("customer_name", `%${customerName}%`)
      .order("created_at", { ascending: false })
      .limit(20);

    if (!invoices || invoices.length === 0) {
      return res.json({ score: null, label: "New Customer", totalBills: 0, totalCredit: 0, paid: 0 });
    }

    const total = invoices.length;
    const paid = invoices.filter(i => i.payment_status === "paid").length;
    const credit = invoices.filter(i => i.payment_status === "credit").length;
    const partial = invoices.filter(i => i.payment_status === "partial").length;
    const totalAmount = invoices.reduce((s, inv) => {
      const gross = (inv.invoice_items || []).reduce((a, i) => a + (i.quantity_boxes || 0) * (i.price_per_box || 0), 0)
        || invoiceGrossValue(inv);
      return s + gross;
    }, 0);
    const paidAmount = invoices.reduce((s, i) => s + (i.amount_paid || 0), 0);

    // Score 0-100
    const payRate = total > 0 ? paid / total : 0;
    const score = Math.round(
      payRate * 50 +                          // payment rate: max 50pts
      (total >= 5 ? 20 : total * 4) +         // loyalty: max 20pts
      (credit === 0 ? 20 : Math.max(0, 20 - credit * 5)) + // no pending: max 20pts
      (totalAmount > 50000 ? 10 : totalAmount / 5000) // volume: max 10pts
    );

    const label = score >= 80 ? "Excellent" : score >= 60 ? "Good" : score >= 40 ? "Average" : "Risky";
    res.json({ score: Math.min(100, score), label, totalBills: total, paid, credit, partial, totalAmount: Math.round(totalAmount), paidAmount: Math.round(paidAmount) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Last rate per customer per product
// ============================================
app.get("/api/invoices/last-rate/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const { customerName } = req.query;
    if (!customerName) return res.status(400).json({ error: "customerName required" });

    const { data } = await supabase
      .from("invoice_items")
      .select("design_id, price_per_box, invoices!inner(customer_name, created_at, shop_id)")
      .eq("invoices.shop_id", shopId)
      .ilike("invoices.customer_name", `%${customerName}%`)
      .order("invoices.created_at", { ascending: false })
      .limit(50);

    // Last rate per design_id
    const rateMap = {};
    (data || []).forEach(item => {
      if (!rateMap[item.design_id]) rateMap[item.design_id] = item.price_per_box;
    });
    res.json({ rates: rateMap });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// BAE INTELLIGENCE — /bae/query
// ============================================

app.post("/api/bae/query", async (req, res) => {
  const { shopId, question } = req.body;
  if (!shopId || !question) return res.status(400).json({ error: "shopId and question required" });

  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    // Pull all relevant data in parallel
    const [invRes, invCtRes, bakayaRes, stockRes, purRes] = await Promise.allSettled([
      // Revenue summary: last 90 days invoices (paid)
      supabase.from("invoices")
        .select("created_at,taxable_value,cgst_amount,sgst_amount,amount_paid,payment_status,customer_name")
        .eq("shop_id", shopId)
        .gte("created_at", since)
        .not("payment_status", "in", '("cancelled","returned")')
        .order("created_at", { ascending: false })
        .limit(200),

      // Recent 10 invoices for context
      supabase.from("invoices")
        .select("invoice_number,created_at,customer_name,taxable_value,cgst_amount,sgst_amount,payment_status,amount_paid")
        .eq("shop_id", shopId)
        .order("created_at", { ascending: false })
        .limit(10),

      // Bakaya customers
      supabase.from("invoices")
        .select("customer_name,customer_phone,amount_paid,taxable_value,cgst_amount,sgst_amount")
        .eq("shop_id", shopId)
        .in("payment_status", ["credit", "partial"]),

      // Low stock
      supabase.from("inventory")
        .select("quantity_boxes,low_stock_threshold,is_low_stock,designs(design_name,design_code)")
        .eq("shop_id", shopId)
        .eq("is_low_stock", true)
        .limit(20),

      // Recent purchases
      supabase.from("purchases")
        .select("supplier_name,quantity_boxes,cost_per_box,payment_status,purchase_date")
        .eq("shop_id", shopId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    // Build revenue summary
    let totalBilled = 0, totalCollected = 0, invoiceCount = 0;
    const monthlyRev = {};
    if (invRes.status === "fulfilled" && invRes.value.data) {
      for (const inv of invRes.value.data) {
        const gross = invoiceGrossValue(inv);
        const paid  = inv.payment_status === "paid" ? gross : (inv.amount_paid || 0);
        totalBilled += gross;
        totalCollected += paid;
        invoiceCount++;
        const month = inv.created_at.slice(0, 7);
        if (!monthlyRev[month]) monthlyRev[month] = { billed: 0, count: 0 };
        monthlyRev[month].billed += gross;
        monthlyRev[month].count++;
      }
    }
    const monthLines = Object.entries(monthlyRev).sort().map(
      ([m, d]) => `${m}: ₹${Math.round(d.billed)} (${d.count} invoices)`
    ).join(", ");

    // Build bakaya summary
    const customerBakaya = {};
    if (bakayaRes.status === "fulfilled" && bakayaRes.value.data) {
      for (const inv of bakayaRes.value.data) {
        const gross = invoiceGrossValue(inv);
        const key   = inv.customer_phone || inv.customer_name;
        if (!customerBakaya[key]) customerBakaya[key] = { name: inv.customer_name, billed: 0, paid: 0 };
        customerBakaya[key].billed += gross;
        customerBakaya[key].paid   += inv.amount_paid || 0;
      }
    }
    const bakayaLines = Object.values(customerBakaya)
      .map(c => `${c.name}: ₹${Math.round(c.billed - c.paid)} outstanding`)
      .join("; ") || "No outstanding bakaya";

    // Recent invoices
    const recentInvLines = (invCtRes.status === "fulfilled" && invCtRes.value.data || [])
      .map(inv => {
        const gross = invoiceGrossValue(inv);
        return `${inv.created_at.slice(0, 10)} ${inv.customer_name} ₹${Math.round(gross)} (${inv.payment_status})`;
      }).join("\n") || "None";

    // Low stock
    const stockLines = (stockRes.status === "fulfilled" && stockRes.value.data || [])
      .map(s => `${s.designs?.design_name || "?"}: ${s.quantity_boxes} boxes (threshold ${s.low_stock_threshold || 10})`)
      .join("; ") || "All stock OK";

    // Purchases
    const purLines = (purRes.status === "fulfilled" && purRes.value.data || [])
      .map(p => `${p.supplier_name} on ${(p.purchase_date || "").slice(0, 10)}: ${p.quantity_boxes} boxes @ ₹${p.cost_per_box} (${p.payment_status})`)
      .join("\n") || "None";

    const context = `
REVENUE (last 90 days):
- Total billed: ₹${Math.round(totalBilled)} across ${invoiceCount} invoices
- Total collected: ₹${Math.round(totalCollected)}
- Total outstanding: ₹${Math.round(totalBilled - totalCollected)}
- Monthly breakdown: ${monthLines || "N/A"}

BAKAYA (credit/partial):
${bakayaLines}

RECENT INVOICES:
${recentInvLines}

LOW STOCK ITEMS:
${stockLines}

RECENT PURCHASES:
${purLines}
`.trim();

    const geminiKey = process.env.GEMINI_API_KEY;
    let answer = "AI unavailable";
    if (geminiKey) {
      const geminiBody = {
        contents: [{ parts: [{ text: `You are BAE — an AI business assistant for an Indian MSME shop using FastBill.
Answer using ONLY the data below. Be specific with ₹ amounts and names. 2-4 lines max. Hindi/English mix OK.

${context}

Question: ${question}

Answer:` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
      };
      const gr = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiBody), signal: AbortSignal.timeout(30000) }
      );
      if (gr.ok) {
        const gd = await gr.json();
        answer = gd?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "No answer";
      }
    }
    res.json({ answer, context_used: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// BAE BRIEFING — proactive daily intelligence
// GET /api/bae/briefing/:shopId
// All ₹/counts computed deterministically here (NEVER by the LLM — money data
// must not hallucinate). Gemini only narrates the pre-computed facts into a
// short Hindi/English action list. Returns { briefing, narration }.
// ============================================
const LANG_NAMES = {
  en: "English", hi: "Hindi", bn: "Bengali", mr: "Marathi", te: "Telugu",
  ta: "Tamil", gu: "Gujarati", kn: "Kannada", ml: "Malayalam", pa: "Punjabi",
};

app.get("/api/bae/briefing/:shopId", async (req, res) => {
  const { shopId } = req.params;
  if (!shopId) return res.status(400).json({ error: "shopId required" });
  const langCode = (req.query.lang || "en").toString().toLowerCase();
  const langName = LANG_NAMES[langCode] || "English";

  try {
    // IST day boundaries
    const IST = 5.5 * 60 * 60 * 1000;
    const nowIst = new Date(Date.now() + IST);
    const istMidnight = new Date(nowIst); istMidnight.setUTCHours(0, 0, 0, 0);
    const todayStartUTC = new Date(istMidnight.getTime() - IST).toISOString();
    const since14UTC = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const gross = (inv) => invoiceGrossValue(inv);

    const [invRes, bakayaRes, stockRes] = await Promise.allSettled([
      // Last 14 days of revenue invoices (for today + week-over-week trend)
      supabase.from("invoices")
        .select("created_at,taxable_value,cgst_amount,sgst_amount,payment_status")
        .eq("shop_id", shopId)
        .gte("created_at", since14UTC)
        .not("payment_status", "in", '("cancelled","returned")')
        .limit(500),

      // Outstanding credit/partial invoices (for payment risk by age)
      supabase.from("invoices")
        .select("customer_name,customer_phone,created_at,taxable_value,cgst_amount,sgst_amount,amount_paid")
        .eq("shop_id", shopId)
        .in("payment_status", ["credit", "partial"])
        .limit(300),

      // Low stock items
      supabase.from("inventory")
        .select("quantity_boxes,low_stock_threshold,designs(design_name,design_code,unit_type)")
        .eq("shop_id", shopId)
        .eq("is_low_stock", true)
        .limit(50),
    ]);

    const invoices = (invRes.status === "fulfilled" && invRes.value.data) || [];
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // --- Sales: today + this-week vs last-week ---
    let todaySales = 0, todayCount = 0, weekSales = 0, prevWeekSales = 0;
    for (const inv of invoices) {
      const g = gross(inv);
      const t = new Date(inv.created_at).getTime();
      if (inv.created_at >= todayStartUTC) { todaySales += g; todayCount++; }
      const ageDays = (now - t) / dayMs;
      if (ageDays <= 7) weekSales += g;
      else if (ageDays <= 14) prevWeekSales += g;
    }
    const weekTrendPct = prevWeekSales > 0
      ? Math.round(((weekSales - prevWeekSales) / prevWeekSales) * 100)
      : null;

    // --- Bakaya: outstanding + oldest/highest-risk customers ---
    const bakayaRows = (bakayaRes.status === "fulfilled" && bakayaRes.value.data) || [];
    const custMap = {};
    for (const inv of bakayaRows) {
      const out = Math.round(gross(inv) - (inv.amount_paid || 0));
      if (out <= 0) continue;
      const key = inv.customer_phone || inv.customer_name || "?";
      const ageDays = Math.floor((now - new Date(inv.created_at).getTime()) / dayMs);
      if (!custMap[key]) custMap[key] = { name: inv.customer_name || "Customer", phone: inv.customer_phone || null, outstanding: 0, oldestDays: 0 };
      custMap[key].outstanding += out;
      custMap[key].oldestDays = Math.max(custMap[key].oldestDays, ageDays);
    }
    const overdue = Object.values(custMap)
      .sort((a, b) => (b.oldestDays - a.oldestDays) || (b.outstanding - a.outstanding))
      .slice(0, 3);
    const totalOutstanding = Object.values(custMap).reduce((s, c) => s + c.outstanding, 0);

    // --- Low stock ---
    const lowStockRows = (stockRes.status === "fulfilled" && stockRes.value.data) || [];
    const lowStock = lowStockRows.slice(0, 5).map(s => ({
      name: s.designs?.design_name || s.designs?.design_code || "Item",
      qty: s.quantity_boxes,
      unit: s.designs?.unit_type || "boxes",
    }));

    const briefing = {
      generatedAt: new Date().toISOString(),
      todaySales: Math.round(todaySales),
      todayCount,
      weekSales: Math.round(weekSales),
      prevWeekSales: Math.round(prevWeekSales),
      weekTrendPct,
      totalOutstanding,
      lowStockCount: lowStockRows.length,
      lowStock,
      overdue,
    };

    // --- Deterministic fallback action items (used only if Gemini down) ---
    // Kept in plain English (universal) — the per-language narration comes from Gemini.
    const facts = [];
    if (weekTrendPct !== null) {
      facts.push(weekTrendPct >= 0
        ? `This week sales up ${weekTrendPct}% (₹${briefing.weekSales}).`
        : `This week sales down ${Math.abs(weekTrendPct)}% (₹${briefing.weekSales}).`);
    }
    if (overdue.length) {
      const top = overdue[0];
      facts.push(`Collect ₹${top.outstanding} from ${top.name} (${top.oldestDays} days overdue).`);
    }
    // Restock advice from the reorder-point model rather than the static low-stock
    // threshold. A fixed threshold ignores how fast a thing sells: 25 boxes is a
    // crisis for an item selling 20 a day and ample for one selling half a day.
    // Falls back to the threshold list only if the model has too little history.
    let decisionFacts = [];
    try {
      const decisions = await computeDecisions(shopId, {});
      decisionFacts = (decisions.recommendations || []).slice(0, 3).map(r => {
        if (r.type === "restock") {
          return `${r.title} — ${r.because.daysLeft} days of stock left at ${r.because.sellsPerDay}/day.`;
        }
        if (r.type === "expiry") return r.title + ".";
        if (r.type === "dead_stock") return `${r.title} — no sale in ${r.because.daysSinceLastSale ?? "over " + 60} days.`;
        if (r.type === "receivables") return r.title + ".";
        return r.title;
      });
    } catch (_) { /* fall through to the threshold list */ }

    if (decisionFacts.length) {
      facts.push(...decisionFacts);
    } else if (lowStock.length) {
      facts.push(`${briefing.lowStockCount} item(s) low on stock, e.g. ${lowStock[0].name} (${lowStock[0].qty} ${lowStock[0].unit}).`);
    }
    if (!facts.length) facts.push("All good today. Nothing urgent.");

    // --- Gemini narration (language only, over the computed facts) ---
    let narration = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const factBlock = `
Today's sales: ₹${briefing.todaySales} (${briefing.todayCount} bills)
This week vs last week: ₹${briefing.weekSales} vs ₹${briefing.prevWeekSales}${weekTrendPct !== null ? ` (${weekTrendPct}%)` : ""}
Total udhaar baaki: ₹${totalOutstanding}
Top overdue: ${overdue.map(o => `${o.name} ₹${o.outstanding} (${o.oldestDays}d)`).join("; ") || "none"}
Low stock items (${briefing.lowStockCount}): ${lowStock.map(l => `${l.name} ${l.qty}${l.unit}`).join("; ") || "none"}
${decisionFacts.length ? "Computed findings (highest priority first):\n" + decisionFacts.map(f => "- " + f).join("\n") : ""}`.trim();

        const body = {
          contents: [{ parts: [{ text: `You are BAE, an AI business co-pilot for an Indian shopkeeper using FastBill.
From the FACTS below, write the TOP 3 most important things the owner should do today.
Rules: use ONLY these numbers (do not invent any). Write the ENTIRE response ONLY in ${langName} language (its native script) — no other language mixed in (keep ₹ amounts and proper names as-is). Each point ONE short line, action-oriented. Number them 1-3. No preamble.

FACTS:
${factBlock}

Output exactly 3 numbered lines (1., 2., 3.) and nothing else:` }] }],
          // thinkingBudget 0 disables 2.5-flash internal reasoning, which would
          // otherwise eat the output budget and truncate the answer mid-line.
          generationConfig: { temperature: 0.3, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } }
        };
        const gr = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }
        );
        if (gr.ok) {
          const gd = await gr.json();
          let txt = (gd?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
          // Strip any echoed heading like "Top 3 ...:" the model sometimes prepends.
          txt = txt.replace(/^top\s*3[^\n:]*:?\s*/i, "").trim();
          // The model's job is to say OUR findings in the shopkeeper's language,
          // never to decide what they are. "Contains a digit" let invented advice
          // through — a generic "focus on sales today" passes that test while
          // silently dropping the ₹99,560 sitting dead on a shelf.
          //
          // So require the narration to actually carry at least one of the
          // distinctive figures we supplied. If it does not, the model has
          // wandered off and the deterministic text is kept instead.
          const supplied = (factBlock.match(/\d[\d,]{2,}/g) || []).map(n => n.replace(/,/g, ""));
          const carriesOurNumbers = supplied.length === 0
            || supplied.some(n => txt.replace(/,/g, "").includes(n));
          const looksReal = txt.length > 15 && /\d/.test(txt) && carriesOurNumbers;
          if (looksReal) narration = txt;
          else if (supplied.length) {
            console.warn("briefing: model output dropped the computed figures — keeping deterministic text");
          }
        }
      } catch (_) { /* keep deterministic fallback */ }
    }

    // The computed findings ship alongside the narration. It makes the guarantee
    // auditable — anyone can check that what the shopkeeper was told matches what
    // was calculated — and gives the app something to fall back on when a model
    // is unavailable.
    res.json({ briefing, narration, facts, source: decisionFacts.length ? "decision-engine" : "basic" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CREDIT SCORE ENDPOINT (AI-Driven)
// ============================================

app.get("/api/credit-score/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const [invoicesRes, inventoryRes, purchasesRes] = await Promise.all([
      supabase.from("invoices")
        .select(`customer_name, total_amount, taxable_value, cgst_amount, sgst_amount${igstCol()}, created_at`)
        .eq("shop_id", shopId)
        .not("payment_status", "in", '("cancelled","returned")')
        .gte("created_at", ninetyDaysAgo.toISOString()),
      supabase.from("inventory")
        .select("quantity_boxes, is_low_stock, low_stock_threshold")
        .eq("shop_id", shopId),
      supabase.from("purchases")
        .select("quantity_boxes, cost_per_box")
        .eq("shop_id", shopId)
        .gte("purchase_date", ninetyDaysAgo.toISOString()),
    ]);

    const invoices = invoicesRes.data || [];
    const inventory = inventoryRes.data || [];
    const purchases = purchasesRes.data || [];

    // ── Rule-based scoring (300–900, CIBIL style) ──────────────────────────
    const invoiceCount   = invoices.length;
    const totalRevenue   = invoices.reduce((s, i) => {
      const amt = parseFloat(i.total_amount) || invoiceGrossValue(i) || 0;
      return s + amt;
    }, 0);
    const uniqueCustomers = new Set(invoices.map(i => i.customer_name).filter(Boolean)).size;
    const lowStockCount  = inventory.filter(i => i.is_low_stock).length;
    const lowStockRatio  = inventory.length > 0 ? lowStockCount / inventory.length : 0;
    const purchaseCount  = purchases.length;

    // Each pillar: 0–150 pts  →  total additional 0–600  →  final 300–900
    const s1 = invoiceCount  >= 30 ? 150 : invoiceCount  >= 15 ? 120 : invoiceCount  >= 5 ? 80 : invoiceCount  >= 1 ? 40 : 0;
    const s2 = totalRevenue  >= 100000 ? 150 : totalRevenue >= 50000 ? 120 : totalRevenue >= 20000 ? 80 : totalRevenue >= 5000 ? 40 : 0;
    const s3 = inventory.length === 0 ? 75
             : lowStockRatio <= 0.10 ? 150 : lowStockRatio <= 0.25 ? 120 : lowStockRatio <= 0.50 ? 75 : 30;
    const s4 = purchaseCount >= 5 ? 150 : purchaseCount >= 3 ? 120 : purchaseCount >= 1 ? 70 : 0;

    const finalScore = Math.min(900, Math.max(300, 300 + s1 + s2 + s3 + s4));
    const rating     = finalScore >= 750 ? 'Excellent' : finalScore >= 600 ? 'Good' : finalScore >= 450 ? 'Fair' : 'Poor';

    const lvl = (s, thresholds, labels) => labels[thresholds.findIndex(t => s >= t)] || labels[labels.length - 1];
    const salesLvl   = lvl(s1, [150, 120, 80, 40], ['Strong','Good','Fair','Weak']);
    const revLvl     = lvl(s2, [150, 120, 80, 40], ['Strong','Good','Fair','Weak']);
    const invLvl     = lvl(s3, [150, 120, 75, 30], ['Strong','Good','Fair','Weak']);
    const purchLvl   = lvl(s4, [150, 120, 70], ['Strong','Good','Fair','Weak']);

    // ── Gemini: Hindi advice (non-blocking, fallback if fails) ────────────
    let adviceHindi = "Regular bills banao, stock maintain karo, purchases record karo — score automatically badhega.";
    try {
      const prompt = `Ek Indian dukandar ka 90-din ka business summary:\n- ${invoiceCount} bills, revenue ₹${Math.round(totalRevenue).toLocaleString('en-IN')}\n- ${uniqueCustomers} customers, ${inventory.length} products, ${lowStockCount} low-stock\n- Credit score: ${finalScore}/900 (${rating})\n\n2-3 simple Hindi sentences: score ka matlab aur kya kare score badhane ke liye. Sirf Hindi mein.`;
      const gRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 250, temperature: 0.7 } }) }
      );
      const gData = await gRes.json();
      const text = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) adviceHindi = text.trim();
    } catch {}

    res.json({
      score: finalScore,
      rating,
      scoreBreakdown: {
        salesActivity:        `${salesLvl} - ${invoiceCount} bills in 90 days`,
        revenueHealth:        `${revLvl} - ₹${Math.round(totalRevenue).toLocaleString('en-IN')} revenue`,
        inventoryManagement:  `${invLvl} - ${lowStockCount}/${inventory.length} items low stock`,
        purchaseConsistency:  `${purchLvl} - ${purchaseCount} purchase orders`,
      },
      dataQuality: `${invoiceCount} invoices, ${inventory.length} products, ${purchaseCount} purchases analyzed (90 days)`,
      adviceHindi,
      rawStats: {
        invoicesLast90Days:  invoiceCount,
        totalRevenue90Days:  Math.round(totalRevenue),
        inventoryItems:      inventory.length,
        lowStockItems:       lowStockCount,
        purchaseOrders90Days: purchaseCount,
        uniqueCustomers,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;

// ============================================
// ADD STOCK / PURCHASES ENDPOINT
// ============================================

app.post("/api/purchases/add", async (req, res) => {
  try {
    const { shopId, design_id, quantity_boxes, supplier_name, cost_per_box, extraCost, marginPercent, marginAmount,
            gstRate, gstMode, supplierGstin, supplierInvoiceNo, supplierInvoiceDate } = req.body;

    if (!shopId || !design_id || !quantity_boxes) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const qty = parseFloat(quantity_boxes) || 0;
    const baseCost = parseFloat(cost_per_box) || 0;
    const extra = Math.max(0, parseFloat(extraCost) || 0);

    // Is this shop GST-registered? Decides whether any input credit exists at all.
    const { data: shopRow } = await supabase.from("shops").select("gstin").eq("id", shopId).maybeSingle();
    const gst = computePurchaseGst({
      grossValue: qty * baseCost,
      gstRate, gstMode, supplierGstin, shopGstin: shopRow?.gstin,
    });

    // Cost basis for pricing. When the GST is reclaimable as ITC it is not a cost —
    // it comes back — so the selling price must be built on the GST-exclusive cost.
    // Pricing on the gross amount in that case would silently overprice every item.
    // For a shop with no GSTIN nothing is reclaimable, so gross is the true cost.
    const costForPricing = gst.itcEligible && qty > 0 ? gst.taxableAmount / qty : baseCost;
    // Transportation/misc cost spread across the units bought, so it's blended into per-unit cost.
    const effectiveCost = costForPricing + (qty > 0 ? extra / qty : 0);
    const marginPct = marginPercent !== undefined && marginPercent !== null && marginPercent !== '' ? parseFloat(marginPercent) : null;
    const marginAmt = marginAmount !== undefined && marginAmount !== null && marginAmount !== '' ? parseFloat(marginAmount) : null;
    const suggestedPrice = marginPct !== null ? effectiveCost * (1 + marginPct / 100)
      : marginAmt !== null ? effectiveCost + marginAmt
      : null;

    // Insert purchase record
    const baseRow = {
      shop_id: shopId,
      design_id,
      quantity_boxes: qty,
      supplier_name: supplier_name || "Direct Purchase",
      cost_per_box: baseCost,
      extra_cost: extra,
      margin_percent: marginPct,
      margin_amount: marginAmt,
      suggested_price: suggestedPrice,
      purchase_date: new Date().toISOString(),
    };
    const gstRow = {
      gst_rate: gst.gstRate,
      gst_amount: gst.gstAmount || null,
      taxable_amount: gst.gstAmount ? gst.taxableAmount : null,
      gst_mode: gst.gstMode,
      supplier_gstin: supplierGstin ? String(supplierGstin).toUpperCase() : null,
      supplier_invoice_no: supplierInvoiceNo || null,
      supplier_invoice_date: supplierInvoiceDate || null,
      itc_eligible: gst.itcEligible,
    };

    // The GST columns only exist after migration 20260801000000. This backend deploys
    // before a human runs that SQL, so a missing-column error must not stop a shopkeeper
    // from adding stock — record the purchase without the GST detail instead.
    let { data: purchase, error: purchaseError } = await supabase
      .from("purchases").insert([{ ...baseRow, ...gstRow }]).select().single();
    if (purchaseError && /column|schema cache/i.test(purchaseError.message || "")) {
      console.warn("purchases/add: GST columns not present yet — run migration 20260801000000");
      ({ data: purchase, error: purchaseError } = await supabase
        .from("purchases").insert([baseRow]).select().single());
    }

    if (purchaseError) throw purchaseError;

    // Blend the computed selling price straight into the product's price —
    // so the shopkeeper never has to separately go set it before the next invoice.
    if (suggestedPrice !== null) {
      const categoryId = await ensureExclusiveCategory(design_id);
      if (categoryId) {
        const { error: priceErr } = await supabase.from("tile_categories")
          .update({ base_price_per_box: suggestedPrice })
          .eq("id", categoryId);
        if (priceErr) console.error("purchases/add: failed to blend price:", priceErr.message);
      }
    }

    // Update inventory - increase quantity
    const { data: currentInventory } = await supabase
      .from("inventory")
      .select("quantity_boxes")
      .eq("design_id", design_id)
      .eq("shop_id", shopId)
      .maybeSingle();

    // Remember this purchase's cost/transport/margin breakdown on the inventory row, so
    // reopening "Set Selling Price" later shows what was actually last entered here.
    const priceBreakdown = { last_cost_price: baseCost, last_extra_cost: extra, last_margin_percent: marginPct, last_margin_amount: marginAmt };

    if (currentInventory) {
      const newQuantity = (currentInventory.quantity_boxes || 0) + (parseFloat(quantity_boxes) || 0);
      const { error: updateError } = await supabase
        .from("inventory")
        .update({
          quantity_boxes: newQuantity,
          last_restocked_at: new Date().toISOString(),
          ...priceBreakdown,
        })
        .eq("design_id", design_id)
        .eq("shop_id", shopId);

      if (updateError) throw updateError;
    } else {
      // No inventory row yet for this design — create one so stock is not silently lost.
      const { error: createError } = await supabase
        .from("inventory")
        .insert([{
          shop_id: shopId,
          design_id,
          quantity_boxes: parseFloat(quantity_boxes) || 0,
          low_stock_threshold: 10,
          last_restocked_at: new Date().toISOString(),
          ...priceBreakdown,
        }]);
      if (createError) throw createError;
    }

    res.json({
      success: true,
      purchase,
      message: "Stock added successfully",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get latest purchase rate + supplier for a design (auto-fill in stock form)
app.get("/api/purchases/latest-rate/:shopId/:designId", async (req, res) => {
  try {
    const { shopId, designId } = req.params;
    const { data, error } = await supabase
      .from('purchases')
      .select('cost_per_box, supplier_name, purchase_date')
      .eq('shop_id', shopId)
      .eq('design_id', designId)
      .order('purchase_date', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return res.json({ cost_per_box: null, supplier_name: null });

    res.json({
      cost_per_box: data.cost_per_box || null,
      supplier_name: data.supplier_name || null,
      last_purchased: data.purchase_date,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add New Product/Design
app.post("/api/designs/add", async (req, res) => {
  try {
    const { shopId, designCode, designName, color, categoryName, sizeMm, coverageSqft, pricePerBox, initialQuantity, hsnCode, defaultGstRate } = req.body;

    if (!shopId || !designName || !categoryName) {
      return res.status(400).json({ error: "shopId, designName, categoryName zaroori hai" });
    }

    // Find or create category
    let categoryId;
    const { data: existingCat } = await supabase
      .from("tile_categories")
      .select("id")
      .eq("shop_id", shopId)
      .ilike("category_name", categoryName)
      .single();

    if (existingCat) {
      categoryId = existingCat.id;
    } else {
      const { data: newCat, error: catError } = await supabase
        .from("tile_categories")
        .insert([{
          shop_id: shopId,
          category_name: categoryName,
          size_mm: sizeMm || "N/A",
          coverage_sqft: parseFloat(coverageSqft) || 0,
          base_price_per_box: parseFloat(pricePerBox) || 0,
        }])
        .select()
        .single();
      if (catError) throw catError;
      categoryId = newCat.id;
    }

    // Auto-generate code if not provided
    const code = designCode || `PROD-${Date.now().toString().slice(-5)}`;

    // Insert design (no shop_id column in designs table)
    const { data: design, error: designError } = await supabase
      .from("designs")
      .insert([{
        category_id: categoryId,
        design_code: code,
        design_name: designName,
        color: color || "",
        hsn_code: hsnCode || null,
        default_gst_rate: parseFloat(defaultGstRate) || 18,
        unit_type: req.body.unitType || 'boxes',
      }])
      .select()
      .single();
    if (designError) throw designError;

    // Create inventory entry (is_low_stock is GENERATED column, don't insert it)
    const invRow = {
      shop_id: shopId,
      design_id: design.id,
      quantity_boxes: parseFloat(initialQuantity) || 0,
      low_stock_threshold: 10,
      last_restocked_at: new Date().toISOString(),
    };
    // expiry_date is optional (grocery/pharmacy). Only set when provided so this
    // insert still works before the expiry migration has been applied.
    if (req.body.expiryDate) invRow.expiry_date = req.body.expiryDate;
    const { error: invError } = await supabase.from("inventory").insert([invRow]);
    if (invError) throw invError;

    res.json({ success: true, design, message: "Naya product add ho gaya!" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Identify Product from Photo using Claude Vision
app.post("/api/products/identify-photo", async (req, res) => {
  try {
    const { imageBase64, shopType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Image required" });

    const prompt = `You are a product identification assistant for a ${shopType || "general"} shop in India.
Analyze this product image and return ONLY a valid JSON object (no markdown, no explanation):
{"designName":"product name in English","color":"main color","categoryName":"product category","sizeMm":"size if visible e.g. 24x24","priceEstimate":0,"description":"1 line description"}`;

    const raw = await geminiVision(imageBase64, prompt);
    if (!raw) return res.status(503).json({ error: "AI unavailable. Check GEMINI_API_KEY." });

    // Robust JSON extraction — handle markdown, prose, partial JSON
    let json = null;
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}') + 1;
      if (start !== -1 && end > start) json = JSON.parse(cleaned.slice(start, end));
    } catch {}

    // Fallback: build product from raw text if JSON failed
    if (!json) {
      const lines = raw.split('\n').filter(l => l.trim());
      json = {
        designName: lines[0]?.replace(/^(product|name|item)[\s:]+/i, '').trim() || 'Unknown Product',
        color: (raw.match(/color[:\s]+([^\n,]+)/i) || [])[1]?.trim() || '',
        categoryName: (raw.match(/categor\w*[:\s]+([^\n,]+)/i) || [])[1]?.trim() || 'General',
        sizeMm: (raw.match(/size[:\s]+([^\n,]+)/i) || [])[1]?.trim() || '',
        priceEstimate: parseInt((raw.match(/price[:\s₹]+(\d+)/i) || [])[1]) || 0,
        description: lines.slice(0, 2).join(' ').slice(0, 100),
      };
    }

    res.json({ success: true, product: json });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// TAX SUMMARY (GST + ITR)
// ============================================

app.get("/api/tax/summary/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const { year } = req.query; // e.g. 2025 for FY 2025-26
    const fy = parseInt(year) || new Date().getFullYear();
    // IST = UTC+5:30 — use explicit IST midnight to avoid boundary errors
    const fyStart = `${fy}-04-01T00:00:00+05:30`;
    const fyEnd   = `${fy + 1}-03-31T23:59:59+05:30`;

    const [invoicesRes, nonGstInvoicesRes, purchasesRes, shopRes, expensesRes] = await Promise.allSettled([
      // GST invoices only — pre-stored aggregated values (O(n))
      supabase.from("invoices")
        .select(`id, invoice_number, customer_name, customer_gstin, invoice_type, invoice_date, created_at, taxable_value, cgst_amount, sgst_amount${igstCol()}, gst_rate, payment_status`)
        .eq("shop_id", shopId)
        .gte("created_at", fyStart)
        .lte("created_at", fyEnd)
        .not("taxable_value", "is", null)
        .not("payment_status", "in", '("cancelled","returned")')
        .order("created_at", { ascending: true }),

      // Non-GST invoices — need invoice_items to compute revenue (for ITR only)
      supabase.from("invoices")
        .select("id, created_at, payment_status, invoice_items(quantity_boxes, price_per_box)")
        .eq("shop_id", shopId)
        .gte("created_at", fyStart)
        .lte("created_at", fyEnd)
        .is("taxable_value", null)
        .not("payment_status", "in", '("cancelled","returned")'),

      supabase.from("purchases")
        .select("quantity_boxes, cost_per_box, purchase_date, supplier_name, gst_amount, taxable_amount, itc_eligible, supplier_gstin")
        .eq("shop_id", shopId)
        .gte("purchase_date", fyStart)
        .lte("purchase_date", fyEnd),

      supabase.from("shops").select("*").eq("id", shopId).single(),

      // Expenses for the FY
      supabase.from("expenses")
        .select("category, amount, expense_date")
        .eq("shop_id", shopId)
        .gte("expense_date", fyStart)
        .lte("expense_date", fyEnd),
    ]);

    const invoices = invoicesRes.status === "fulfilled" ? invoicesRes.value.data || [] : [];

    // Credit notes issued this year. Since a return no longer edits the original
    // invoice, a partially returned bill still carries its full value here — the
    // credit has to be subtracted, or output tax is overstated by exactly the
    // amount that was given back.
    //
    // Notes against invoices that are excluded entirely (cancelled, fully
    // returned) are skipped too, otherwise the credit would be counted while the
    // sale it reverses never was.
    const { data: cnRows } = await supabase.from("credit_notes")
      .select("id, invoice_id, credit_note_number, issued_at, customer_name, customer_gstin, taxable_value, cgst_amount, sgst_amount, igst_amount, total_credit, is_inter_state, original_invoice_number")
      .eq("shop_id", shopId).gte("issued_at", fyStart).lte("issued_at", fyEnd);

    const countedInvoiceIds = new Set(invoices.map(i => i.id));
    const creditNotes = (cnRows || []).filter(n => countedInvoiceIds.has(n.invoice_id));
    const cnTaxable = creditNotes.reduce((s, n) => s + (parseFloat(n.taxable_value) || 0), 0);
    const cnCgst = creditNotes.reduce((s, n) => s + (parseFloat(n.cgst_amount) || 0), 0);
    const cnSgst = creditNotes.reduce((s, n) => s + (parseFloat(n.sgst_amount) || 0), 0);
    const cnIgst = creditNotes.reduce((s, n) => s + (parseFloat(n.igst_amount) || 0), 0);
    const cnTotal = creditNotes.reduce((s, n) => s + (parseFloat(n.total_credit) || 0), 0);
    const nonGstInvoices = nonGstInvoicesRes.status === "fulfilled" ? nonGstInvoicesRes.value.data || [] : [];
    let purchases = purchasesRes.status === "fulfilled" ? purchasesRes.value.data || [] : [];
    // The GST columns above only exist after migration 20260801000000. Without this retry a
    // missing column would silently produce an empty purchase list — i.e. a P&L showing zero
    // cost of goods, which is worse than showing no ITC. Refetch the pre-migration shape.
    const purchasesErr = purchasesRes.status === "fulfilled" ? purchasesRes.value.error : purchasesRes.reason;
    if (purchasesErr && /column|schema cache/i.test(purchasesErr.message || "")) {
      console.warn("tax/summary: purchase GST columns not present yet — run migration 20260801000000");
      const { data: legacy } = await supabase.from("purchases")
        .select("quantity_boxes, cost_per_box, purchase_date, supplier_name")
        .eq("shop_id", shopId).gte("purchase_date", fyStart).lte("purchase_date", fyEnd);
      purchases = legacy || [];
    }
    const shop = shopRes.status === "fulfilled" ? shopRes.value.data : {};
    const expenses = expensesRes.status === "fulfilled" ? expensesRes.value.data || [] : [];

    // ── GST SECTION (only GST invoices — non-GST bills are outside GST ambit) ──
    // grossSales for GSTR-1 = full invoice value (taxable + GST collected)
    const grossSales = invoices.reduce((s, inv) =>
      s + invoiceGrossValue(inv), 0);

    const taxableValue = invoices.reduce((s, inv) => s + (inv.taxable_value || 0), 0);
    const cgst = invoices.reduce((s, inv) => s + (inv.cgst_amount || 0), 0);
    const sgst = invoices.reduce((s, inv) => s + (inv.sgst_amount || 0), 0);
    // Inter-state sales sit in IGST and belong in a separate GSTR-1 table, so
    // they are reported as their own line rather than folded into CGST+SGST.
    const igstCollected = invoices.reduce((s, inv) => s + (inv.igst_amount || 0), 0);
    const interStateInvoices = invoices.filter(inv => inv.is_inter_state).length;
    // Net of credit notes: what was actually supplied and is actually payable.
    const gstCollected = (cgst - cnCgst) + (sgst - cnSgst) + (igstCollected - cnIgst);

    // ── INPUT TAX CREDIT ──
    // GST paid to suppliers, split by whether it is actually claimable. A purchase only
    // yields credit when the supplier's GSTIN was recorded (proof of a tax invoice from a
    // registered dealer) — anything else is a cost, not a credit, and is reported
    // separately so the shopkeeper can see what they are losing by not collecting bills.
    const { gstPaidOnPurchases, itcAvailable, itcBlocked, purchasesWithoutGst } = summariseItc(purchases);

    // Credit reversed by purchase returns. Goods that went back to the supplier
    // cannot keep their input credit — holding on to it is claiming a refund for
    // tax the shop never ultimately bore. Reversals net off the claim.
    const { data: dnRows } = await supabase.from("debit_notes")
      .select("cgst_amount, sgst_amount, igst_amount, itc_reversed, issued_at")
      .eq("shop_id", shopId).gte("issued_at", fyStart).lte("issued_at", fyEnd);
    const itcReversed = (dnRows || []).reduce((s, n) => s + (n.itc_reversed
      ? (parseFloat(n.cgst_amount) || 0) + (parseFloat(n.sgst_amount) || 0) + (parseFloat(n.igst_amount) || 0)
      : 0), 0);

    const itcNet = Math.max(0, itcAvailable - itcReversed);
    const netGstPayable = Math.max(0, gstCollected - itcNet);

    // B2B split for GSTR-1
    const b2bInvoices = invoices.filter(inv => inv.invoice_type === 'B2B' || inv.customer_gstin);
    const b2bTaxable = b2bInvoices.reduce((s, inv) => s + (inv.taxable_value || 0), 0);
    const b2bGst = b2bInvoices.reduce((s, inv) => s + invoiceTaxTotal(inv), 0);

    // Monthly breakdown for GSTR-1 — bucket by IST month, not UTC
    const istMonth = (iso) => {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
      return ist.toISOString().slice(0, 7);
    };
    const monthlyBreakdown = {};
    invoices.forEach(inv => {
      const month = istMonth(inv.created_at || inv.invoice_date);
      if (!month) return;
      if (!monthlyBreakdown[month]) monthlyBreakdown[month] = { invoiceCount: 0, taxableValue: 0, cgst: 0, sgst: 0, grossSales: 0, b2bCount: 0 };
      monthlyBreakdown[month].invoiceCount += 1;
      monthlyBreakdown[month].taxableValue += inv.taxable_value || 0;
      monthlyBreakdown[month].cgst += inv.cgst_amount || 0;
      monthlyBreakdown[month].sgst += inv.sgst_amount || 0;
      monthlyBreakdown[month].grossSales += invoiceGrossValue(inv);
      if (inv.invoice_type === 'B2B' || inv.customer_gstin) monthlyBreakdown[month].b2bCount += 1;
    });
    Object.keys(monthlyBreakdown).forEach(m => {
      monthlyBreakdown[m].taxableValue = Math.round(monthlyBreakdown[m].taxableValue);
      monthlyBreakdown[m].cgst = Math.round(monthlyBreakdown[m].cgst);
      monthlyBreakdown[m].sgst = Math.round(monthlyBreakdown[m].sgst);
      monthlyBreakdown[m].grossSales = Math.round(monthlyBreakdown[m].grossSales);
    });

    // ── ITR / P&L SECTION ──
    // Per CBDT: GST collected & deposited is NOT part of turnover under Sec 44AD.
    // Turnover = GST-exclusive sales (taxableValue) + non-GST bill revenue
    const nonGstRevenue = nonGstInvoices.reduce((s, inv) =>
      s + (inv.invoice_items || []).reduce((ls, item) =>
        ls + ((item.quantity_boxes || 0) * (item.price_per_box || 0)), 0), 0);

    // Total business turnover (ITR base)
    const totalTurnover = taxableValue + nonGstRevenue;

    // Where GST was reclaimed as ITC the tax is not an expense — see purchaseCostForPnl.
    const totalPurchaseCost = purchaseCostForPnl(purchases);

    // Operating expenses (rent/utility/salary/etc.) — separate from COGS
    const expensesByCategory = {};
    const totalExpenses = expenses.reduce((s, e) => {
      expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + (e.amount || 0);
      return s + (e.amount || 0);
    }, 0);

    const grossProfit = totalTurnover - totalPurchaseCost;
    const netProfit = grossProfit - totalExpenses;

    // Sec 44AD presumptive (FY 2025-26 / AY 2026-27):
    //  - 8% of turnover on CASH receipts; 6% on DIGITAL receipts (bank/UPI/cheque).
    //  - Eligibility limit: ₹2 Cr turnover, or ₹3 Cr if cash receipts ≤ 5% (95%+ digital).
    // App does not yet capture per-invoice receipt mode reliably, so we surface BOTH:
    // 8% (conservative, all-cash) and 6% (best case, all-digital). CA picks the real split.
    const presumptive8 = Math.round(totalTurnover * 0.08); // cash receipts
    const presumptive6 = Math.round(totalTurnover * 0.06); // digital receipts (>=95% digital)
    const presumptiveTaxableIncome = presumptive8; // backward-compat (conservative default)
    const turnoverLimit44AD = 30000000; // ₹3 Cr (digital); ₹2 Cr if cash > 5%
    const eligible44AD = totalTurnover <= turnoverLimit44AD;

    res.json({
      shop: { name: shop?.name, owner: shop?.owner_name, phone: shop?.phone, gstin: shop?.gstin || null },
      fy: `${fy}-${fy + 1}`,
      gst: {
        // Reported net of credit notes; the gross figures and the credit are
        // both shown so a CA can fill Table 4 and Table 9B separately.
        grossSales: Math.round(grossSales - cnTotal),
        grossSalesBeforeCredits: Math.round(grossSales),
        taxableValue: Math.round(taxableValue - cnTaxable),
        taxableValueBeforeCredits: Math.round(taxableValue),
        cgst: Math.round(cgst - cnCgst),
        sgst: Math.round(sgst - cnSgst),
        creditNotes: {
          count: creditNotes.length,
          taxableValue: Math.round(cnTaxable),
          cgst: Math.round(cnCgst),
          sgst: Math.round(cnSgst),
          igst: Math.round(cnIgst),
          totalCredited: Math.round(cnTotal),
          note: "GSTR-1 table 9B (credit/debit notes). These reduce output tax for the period.",
        },
        totalGstCollected: Math.round(gstCollected),
        igst: Math.round(igstCollected - cnIgst),
        interStateInvoices,
        gstPaidOnPurchases: Math.round(gstPaidOnPurchases),
        itcAvailable: Math.round(itcNet),
        itcClaimedBeforeReversals: Math.round(itcAvailable),
        itcReversedOnReturns: Math.round(itcReversed),
        itcBlocked: Math.round(itcBlocked),          // GST paid where no supplier GSTIN was recorded
        purchasesWithoutGst,                          // purchases with no GST captured at all
        itcNote: "ITC as per your own purchase records. Final entitlement depends on the supplier having filed their return — verify against GSTR-2B on the GST portal before claiming.",
        netGstPayable: Math.round(netGstPayable),
        totalInvoices: invoices.length,
        b2bInvoices: b2bInvoices.length,
        b2bTaxableValue: Math.round(b2bTaxable),
        b2bGstCollected: Math.round(b2bGst),
        monthlyBreakdown,
      },
      pnl: {
        grossIncome: Math.round(totalTurnover),        // GST-ex turnover + non-GST bills
        gstInvoiceRevenue: Math.round(taxableValue),  // from GST bills (ex-GST)
        nonGstRevenue: Math.round(nonGstRevenue),     // from non-GST bills
        nonGstInvoiceCount: nonGstInvoices.length,
        purchaseExpenses: Math.round(totalPurchaseCost),
        operatingExpenses: Math.round(totalExpenses),
        expensesByCategory,
        grossProfit: Math.round(grossProfit),
        netProfit: Math.round(netProfit),
        presumptiveTaxableIncome,                     // 8% (conservative) — backward compat
        presumptiveIncome8Cash: presumptive8,         // 8% if receipts in cash
        presumptiveIncome6Digital: presumptive6,      // 6% if 95%+ receipts digital
        eligible44AD,                                 // turnover within limit?
        turnoverLimit44AD,
      },
      itrNote: "Sec 44AD (AY 2026-27): presumptive income = 6% of turnover on digital receipts, 8% on cash. Eligible if turnover ≤ ₹3 Cr (cash ≤ 5%) else ₹2 Cr. Income tax is on PROFIT and includes ALL sales — GST and non-GST bills both count as income. GST tax collected is excluded from turnover (CBDT). File ITR-4.",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bakaya Ledger — customer outstanding + supplier dues
app.get("/api/bakaya/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    // These were capped at 50 rows, which silently understated the headline
    // total for any shop with more than 50 open bills — the one number a
    // shopkeeper checks daily. Totals must cover every open bill; the cap here
    // is a safety valve, not a page size, and the response says when it bites.
    const OPEN_BILL_CAP = 2000;
    const [invoicesRes, purchasesRes] = await Promise.allSettled([
      supabase.from("invoices")
        .select(`id, invoice_number, customer_name, customer_phone, created_at, payment_status, amount_paid, taxable_value, cgst_amount, sgst_amount${igstCol()}, discount_amount, invoice_items(quantity_boxes, price_per_box)`)
        .eq("shop_id", shopId)
        .in("payment_status", ["credit", "partial"])
        .order("created_at", { ascending: false })
        .limit(OPEN_BILL_CAP),

      supabase.from("purchases")
        .select("id, supplier_name, created_at, purchase_date, payment_status, amount_paid, quantity_boxes, cost_per_box")
        .eq("shop_id", shopId)
        .in("payment_status", ["unpaid", "partial"])
        .order("purchase_date", { ascending: false })
        .limit(OPEN_BILL_CAP),
    ]);

    const creditInvoices = invoicesRes.status === "fulfilled" ? invoicesRes.value.data || [] : [];
    const unpaidPurchases = purchasesRes.status === "fulfilled" ? purchasesRes.value.data || [] : [];

    // Batch fetch invoice_items separately — relational join can silently fail for some invoices
    const invoiceIds = creditInvoices.map(i => i.id);
    let itemsByInvoice = {};
    if (invoiceIds.length > 0) {
      const { data: itemsData } = await supabase
        .from("invoice_items")
        .select("invoice_id, quantity_boxes, price_per_box")
        .in("invoice_id", invoiceIds);
      (itemsData || []).forEach(item => {
        if (!itemsByInvoice[item.invoice_id]) itemsByInvoice[item.invoice_id] = [];
        itemsByInvoice[item.invoice_id].push(item);
      });
    }

    const enrichedInvoices = creditInvoices.map(inv => {
      const items = itemsByInvoice[inv.id] || inv.invoice_items || [];
      // Net payable = what customer actually owes (AFTER discount).
      let net;
      if (inv.taxable_value != null) {
        // GST invoice: stored taxable + GST is already net of discount.
        net = invoiceGrossValue(inv);
      } else {
        // Non-GST invoice: items gross minus discount.
        const itemsGross = items.reduce((s, i) => s + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0);
        net = Math.max(0, itemsGross - (inv.discount_amount || 0));
      }
      const outstanding = Math.round(net - (inv.amount_paid || 0));
      return { ...inv, grossAmount: Math.round(net), outstanding };
    });

    const enrichedPurchases = unpaidPurchases.map(p => {
      const gross = (p.quantity_boxes || 0) * (p.cost_per_box || 0);
      const outstanding = Math.round(gross - (p.amount_paid || 0));
      return { ...p, grossAmount: Math.round(gross), outstanding };
    });

    const customerBakaya = enrichedInvoices.reduce((s, i) => s + i.outstanding, 0);
    const supplierBakaya = enrichedPurchases.reduce((s, p) => s + p.outstanding, 0);

    // Ageing turns a total into a plan: which money is merely recent, which is
    // stuck, and who to chase first. Suppliers are aged off purchase_date, which
    // is when the obligation actually started.
    const customerAgeing = ageingSummary(enrichedInvoices, { dateField: "created_at" });
    const supplierAgeing = ageingSummary(enrichedPurchases, { dateField: "purchase_date" });
    const topDebtors = groupByParty(enrichedInvoices, { partyField: "customer_name", dateField: "created_at" });
    const topCreditors = groupByParty(enrichedPurchases, { partyField: "supplier_name", dateField: "purchase_date" });

    res.json({
      customerBakaya,
      supplierBakaya,
      // Lists stay capped for payload size; totals and ageing above cover everything.
      creditInvoices: enrichedInvoices.slice(0, 50),
      unpaidPurchases: enrichedPurchases.slice(0, 50),
      customerAgeing,
      supplierAgeing,
      topDebtors: topDebtors.slice(0, 10),
      topCreditors: topCreditors.slice(0, 10),
      truncated: enrichedInvoices.length >= OPEN_BILL_CAP || enrichedPurchases.length >= OPEN_BILL_CAP,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark invoice payment (paid / partial)
app.patch("/api/invoices/:id/payment", async (req, res) => {
  try {
    const { status, amountPaid, shopId } = req.body; // status: 'paid'|'partial'|'credit'
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    const { data, error } = await supabase.from("invoices")
      .update({ payment_status: status, amount_paid: amountPaid || 0 })
      .eq("id", req.params.id)
      .eq("shop_id", shopId)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Invoice not found in this shop" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Adjust inventory quantity (edit correction)
app.patch("/api/inventory/adjust", async (req, res) => {
  try {
    const { shopId, designId, inventoryId, newQuantity } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    if (newQuantity === undefined) return res.status(400).json({ error: "newQuantity required" });
    const qty = parseFloat(newQuantity);
    if (isNaN(qty) || qty < 0) return res.status(400).json({ error: "Invalid quantity" });

    // Always scope to shopId so one shop can never edit another's stock.
    let query = supabase.from("inventory").update({ quantity_boxes: qty }).eq("shop_id", shopId);
    if (inventoryId) {
      query = query.eq("id", inventoryId);
    } else if (designId) {
      query = query.eq("design_id", designId);
    } else {
      return res.status(400).json({ error: "inventoryId or designId required" });
    }

    const { data, error } = await query.select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Inventory row not found" });
    res.json({ success: true, updated: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove a product from a shop's Current Inventory. Deletes only the inventory row (this shop's
// stock listing) — never the design or past invoices/purchases, so billing history stays intact.
// If a request carries a staffId, verify that staff member belongs to this shop and has the
// named permission — enforced server-side so hiding a button in the app isn't the only thing
// stopping a staff account from calling these endpoints directly.
async function checkStaffPermission(shopId, staffId, permissionColumn) {
  if (!staffId) return true; // owner request — no staffId sent
  const { data } = await supabase.from("shop_staff")
    .select(permissionColumn).eq("id", staffId).eq("shop_id", shopId).eq("active", true).maybeSingle();
  return !!data?.[permissionColumn];
}

app.delete("/api/inventory/:inventoryId", async (req, res) => {
  try {
    const { shopId, staffId } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    if (!(await checkStaffPermission(shopId, staffId, "can_delete"))) {
      return res.status(403).json({ error: "Aapko delete karne ki permission nahi hai" });
    }
    const { data, error } = await supabase.from("inventory")
      .delete()
      .eq("id", req.params.inventoryId)
      .eq("shop_id", shopId)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Inventory row not found in this shop" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fix a product's unit of measurement (e.g. was created as sqft, should be boxes for a ceramic
// tile) — same shop-ownership check as other design edits, via its inventory row.
app.patch("/api/designs/:designId/unit", async (req, res) => {
  try {
    const { shopId, unitType } = req.body;
    if (!shopId || !unitType) return res.status(400).json({ error: "shopId and unitType required" });
    const { data: invRow } = await supabase
      .from("inventory").select("id").eq("shop_id", shopId).eq("design_id", req.params.designId).maybeSingle();
    if (!invRow) return res.status(404).json({ error: "Product not found in this shop's inventory" });

    const { data, error } = await supabase.from("designs")
      .update({ unit_type: unitType })
      .eq("id", req.params.designId)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, design: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// One-time repair: split EVERY design in a shop into its own exclusive tile_categories row right
// now, instead of waiting for each product's price to be individually re-saved (ensureExclusiveCategory
// normally only decouples lazily, the first time a given design's price is touched). Needed for shops
// that had products sharing a category (e.g. all bill-scanned products previously landed in one
// "General" bucket) before that was fixed — those already-contaminated prices stay wrong until each
// affected product is split out. This does NOT recover which distinct price each product should have
// had (that information was already overwritten by the sharing bug) — it only stops further
// cross-contamination. Shopkeeper must still re-enter the correct price per product afterwards.
app.post("/api/shops/:shopId/repair-shared-pricing", async (req, res) => {
  try {
    const { data: invRows, error } = await supabase
      .from("inventory")
      .select("design_id, last_cost_price, last_extra_cost, last_margin_percent, last_margin_amount")
      .eq("shop_id", req.params.shopId);
    if (error) throw error;

    let splitCount = 0, recomputedCount = 0;
    for (const row of invRows || []) {
      const designId = row.design_id;
      const { data: design } = await supabase.from("designs").select("category_id").eq("id", designId).maybeSingle();
      if (!design?.category_id) continue;
      const { data: siblings } = await supabase.from("designs").select("id").eq("category_id", design.category_id);
      const wasShared = siblings && siblings.length > 1;
      const categoryId = await ensureExclusiveCategory(designId);
      if (wasShared) splitCount++;

      // Not just isolate — recompute this design's OWN price from the cost/transport/margin it
      // was last set with, so a shared/contaminated price gets actually corrected here too,
      // instead of leaving the stale shared number sitting in the now-exclusive category.
      if (categoryId && row.last_cost_price !== null && row.last_cost_price !== undefined) {
        const cost = parseFloat(row.last_cost_price) || 0;
        const extra = Math.max(0, parseFloat(row.last_extra_cost) || 0);
        const effectiveCost = cost + extra;
        const marginPct = row.last_margin_percent !== null && row.last_margin_percent !== undefined ? parseFloat(row.last_margin_percent) : null;
        const marginAmt = row.last_margin_amount !== null && row.last_margin_amount !== undefined ? parseFloat(row.last_margin_amount) : null;
        const suggestedPrice = marginPct !== null ? effectiveCost * (1 + marginPct / 100)
          : marginAmt !== null ? effectiveCost + marginAmt
          : effectiveCost;
        await supabase.from("tile_categories").update({ base_price_per_box: suggestedPrice }).eq("id", categoryId);
        recomputedCount++;
      }
    }

    res.json({ success: true, totalProducts: invRows.length, splitIntoExclusiveCategories: splitCount, pricesRecomputed: recomputedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set a product's selling price from cost + transport/misc + margin, without touching stock quantity.
// Same blend-it-in formula as purchases/add and confirm-scan, so a shopkeeper can fix pricing
// on an already-stocked product straight from the Current Inventory list.
app.patch("/api/inventory/set-price", async (req, res) => {
  try {
    const { shopId, designId, baseCost, extraCost, marginPercent, marginAmount, staffId } = req.body;
    if (!shopId || !designId) return res.status(400).json({ error: "shopId and designId required" });
    if (!(await checkStaffPermission(shopId, staffId, "can_edit_price"))) {
      return res.status(403).json({ error: "Aapko price change karne ki permission nahi hai" });
    }

    // Ownership proof: this shop must actually stock this design.
    const { data: invRow } = await supabase
      .from("inventory").select("id").eq("shop_id", shopId).eq("design_id", designId).maybeSingle();
    if (!invRow) return res.status(404).json({ error: "Product not found in this shop's inventory" });

    const cost = parseFloat(baseCost) || 0;
    const extra = Math.max(0, parseFloat(extraCost) || 0);
    const effectiveCost = cost + extra;
    const marginPct = marginPercent !== undefined && marginPercent !== null && marginPercent !== '' ? parseFloat(marginPercent) : null;
    const marginAmt = marginAmount !== undefined && marginAmount !== null && marginAmount !== '' ? parseFloat(marginAmount) : null;
    const suggestedPrice = marginPct !== null ? effectiveCost * (1 + marginPct / 100)
      : marginAmt !== null ? effectiveCost + marginAmt
      : effectiveCost;

    const categoryId = await ensureExclusiveCategory(designId);
    if (!categoryId) return res.status(404).json({ error: "Product category not found" });

    const { error: updErr } = await supabase.from("tile_categories")
      .update({ base_price_per_box: suggestedPrice })
      .eq("id", categoryId);
    if (updErr) throw updErr;

    // Remember exactly what was entered here, so reopening this editor later shows the
    // last-set breakdown instead of a stale historical purchase cost.
    const { error: breakdownErr } = await supabase.from("inventory")
      .update({ last_cost_price: cost, last_extra_cost: extra, last_margin_percent: marginPct, last_margin_amount: marginAmt })
      .eq("id", invRow.id);
    if (breakdownErr) console.error("set-price: failed to persist price breakdown:", breakdownErr.message);

    res.json({ success: true, suggestedPrice });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark purchase payment
app.patch("/api/purchases/:id/payment", async (req, res) => {
  try {
    const { status, amountPaid, shopId } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    const { data, error } = await supabase.from("purchases")
      .update({ payment_status: status, amount_paid: amountPaid || 0 })
      .eq("id", req.params.id)
      .eq("shop_id", shopId)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Purchase not found in this shop" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Invoice History with filters
app.get("/api/invoices/history/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const { customer, month, date } = req.query; // month=2026-05, date=2026-05-06

    let query = supabase
      .from("invoices")
      .select(`*, invoice_items(quantity_boxes, price_per_box, design_id, hsn_code, gst_rate, designs(design_code, design_name, hsn_code, default_gst_rate))`)
      .eq("shop_id", shopId)
      // Hide cancelled + fully-returned bills from history (partial_return stays — still a real sale).
      .not("payment_status", "in", '("cancelled","returned")')
      .order("created_at", { ascending: false })
      .limit(100);

    if (customer) query = query.ilike("customer_name", `%${customer}%`);
    if (month) {
      // month=YYYY-MM. Use next-month-01 as exclusive upper bound to handle 28/30/31 day months.
      const [yr, mo] = month.split('-').map(Number);
      const nextYr = mo === 12 ? yr + 1 : yr;
      const nextMo = mo === 12 ? 1 : mo + 1;
      const nextMonth = `${nextYr}-${String(nextMo).padStart(2, '0')}`;
      query = query
        .gte("created_at", `${month}-01T00:00:00+05:30`)
        .lt("created_at", `${nextMonth}-01T00:00:00+05:30`);
    }
    if (date) {
      // date=YYYY-MM-DD in IST. Use next-day exclusive bound.
      // Use UTC date arithmetic to avoid IST offset collapsing nextDate back to same day.
      const [dyr, dmo, ddd] = date.split('-').map(Number);
      const nextDate = new Date(Date.UTC(dyr, dmo - 1, ddd + 1)).toISOString().slice(0, 10);
      query = query
        .gte("created_at", `${date}T00:00:00+05:30`)
        .lt("created_at", `${nextDate}T00:00:00+05:30`);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Credits issued against these bills. A return no longer edits the invoice,
    // so a partially returned bill still shows its full value here — without
    // subtracting the credit, the day's sales would include goods that came back.
    const rows = data || [];
    const creditedByInvoice = {};
    if (rows.length > 0) {
      const { data: cns } = await supabase.from("credit_notes")
        .select("invoice_id, total_credit")
        .in("invoice_id", rows.map(r => r.id));
      for (const n of (cns || [])) {
        creditedByInvoice[n.invoice_id] = (creditedByInvoice[n.invoice_id] || 0) + (parseFloat(n.total_credit) || 0);
      }
    }

    // Compute totals from items
    const invoices = rows.map(inv => {
      const gross = (inv.invoice_items || []).reduce((s, i) => s + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0);
      const boxes = (inv.invoice_items || []).reduce((s, i) => s + (i.quantity_boxes || 0), 0);
      const credited = Math.round(creditedByInvoice[inv.id] || 0);
      return {
        ...inv,
        // grossAmount stays the net figure the app has always displayed, so
        // nothing downstream changes shape; the parts are exposed alongside.
        grossAmount: Math.max(0, Math.round(gross) - credited),
        billedAmount: Math.round(gross),
        creditedAmount: credited,
        totalBoxes: boxes,
      };
    });

    const monthlyTotal = invoices.reduce((s, i) => s + i.grossAmount, 0);

    res.json({ invoices, count: invoices.length, monthlyTotal });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel / Delete invoice — restores inventory
app.delete("/api/invoices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const shopId = req.body?.shopId || req.query.shopId;
    if (!shopId) return res.status(400).json({ error: "shopId required" });

    // Fetch invoice to check idempotency + get shop_id
    const { data: invoiceRow, error: invErr } = await supabase
      .from("invoices")
      .select("id, shop_id, payment_status")
      .eq("id", id)
      .single();
    if (invErr || !invoiceRow) return res.status(404).json({ error: "Invoice not found" });
    if (invoiceRow.shop_id !== shopId) return res.status(403).json({ error: "Yeh invoice aapke shop ka nahi hai" });
    if (["cancelled", "returned"].includes(invoiceRow.payment_status)) {
      return res.json({ success: true, message: "Invoice already cancelled", idempotent: true });
    }

    // Fetch invoice items to restore inventory
    const { data: items, error: itemsErr } = await supabase
      .from("invoice_items")
      .select("design_id, quantity_boxes")
      .eq("invoice_id", id);
    if (itemsErr) throw itemsErr;

    // Restore inventory for each item (parallel, shop_id scoped)
    await Promise.all((items || []).map(async (item) => {
      const { data: inv } = await supabase
        .from("inventory")
        .select("id, quantity_boxes")
        .eq("shop_id", invoiceRow.shop_id)
        .eq("design_id", item.design_id)
        .maybeSingle();
      if (inv) {
        const { error: restoreErr } = await supabase.from("inventory")
          .update({ quantity_boxes: (inv.quantity_boxes || 0) + (item.quantity_boxes || 0) })
          .eq("id", inv.id);
        if (restoreErr) throw restoreErr;
      }
    }));

    // Mark invoice as cancelled (soft delete)
    const { error: updateErr } = await supabase
      .from("invoices")
      .update({ payment_status: "cancelled" })
      .eq("id", id);
    if (updateErr) throw updateErr;

    res.json({ success: true, message: "Invoice cancelled, inventory restored" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Return / Exchange invoice items — partial or full return
// E-way bill DATA PREP — no live NIC e-way-bill portal API access (needs government API
// credentials the shop doesn't have), so this doesn't file anything automatically. It builds
// the exact fields the NIC EWB-01 form asks for from the invoice + transport details the
// shopkeeper types in, so they can paste/type them into ewaybillgst.gov.in in under a minute
// instead of hunting for each number across the invoice.
app.post("/api/invoices/:id/eway-bill-data", async (req, res) => {
  try {
    const { shopId, transporterName, transporterId, vehicleNumber, distanceKm } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });

    const { data: invoice, error } = await supabase.from("invoices")
      .select("*, invoice_items(quantity_boxes, price_per_box, hsn_code, gst_rate, designs(design_name))")
      .eq("id", req.params.id).eq("shop_id", shopId).single();
    if (error || !invoice) return res.status(404).json({ error: "Invoice not found in this shop" });

    const { data: shop } = await supabase.from("shops").select("name, gstin, address").eq("id", shopId).maybeSingle();

    const grossValue = invoiceGrossValue(invoice);
    // E-way bill is mandatory above ₹50,000 goods value (CGST Rules 138) — flagging so the
    // shopkeeper isn't left guessing whether this invoice even needs one.
    const required = grossValue > 50000;

    res.json({
      required,
      thresholdNote: "E-way bill mandatory for goods value > ₹50,000 (CGST Rule 138). Below that it's optional unless your state requires it for intrastate movement.",
      ewbData: {
        supplierGstin: shop?.gstin || null,
        supplierName: shop?.name || null,
        supplierAddress: shop?.address || null,
        documentNumber: invoice.invoice_number,
        documentDate: invoice.created_at?.slice(0, 10),
        recipientName: invoice.customer_name,
        recipientGstin: invoice.customer_gstin || null,
        invoiceType: invoice.invoice_type,
        totalTaxableValue: invoice.taxable_value,
        // The EWB-01 form takes IGST for an inter-state consignment — which is
        // precisely the case where an e-way bill matters most.
        cgstAmount: invoice.is_inter_state ? 0 : invoice.cgst_amount,
        sgstAmount: invoice.is_inter_state ? 0 : invoice.sgst_amount,
        igstAmount: invoice.igst_amount || 0,
        placeOfSupply: invoice.place_of_supply || null,
        supplyType: invoice.is_inter_state ? "Inter-State" : "Intra-State",
        totalInvoiceValue: Math.round(grossValue),
        transporterName: transporterName || null,
        transporterId: transporterId || null,
        vehicleNumber: vehicleNumber || null,
        approxDistanceKm: distanceKm || null,
        items: (invoice.invoice_items || []).map(i => ({
          productName: i.designs?.design_name || null,
          hsnCode: i.hsn_code,
          quantity: i.quantity_boxes,
          taxableValue: (i.quantity_boxes || 0) * (i.price_per_box || 0),
          gstRate: i.gst_rate,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Credit notes a shop has issued. Statutory documents, so they are listed in
// their own right rather than only as a side effect of a return.
app.get("/api/credit-notes/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    let query = supabase.from("credit_notes").select("*").eq("shop_id", shopId).order("issued_at", { ascending: false });
    if (req.query.fy) query = query.eq("financial_year", req.query.fy);
    if (req.query.invoiceId) query = query.eq("invoice_id", req.query.invoiceId);

    const { data, error } = await query.limit(500);
    if (error && /relation|does not exist|schema cache/i.test(error.message || "")) {
      return res.json({ creditNotes: [], unavailable: true });
    }
    if (error) throw error;

    const notes = data || [];
    res.json({
      creditNotes: notes,
      totalCredited: Math.round(notes.reduce((s, n) => s + (parseFloat(n.total_credit) || 0), 0)),
      taxCredited: Math.round(notes.reduce((s, n) =>
        s + (parseFloat(n.cgst_amount) || 0) + (parseFloat(n.sgst_amount) || 0) + (parseFloat(n.igst_amount) || 0), 0)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// One credit note, with everything needed to print it as a document.
app.get("/api/credit-notes/:shopId/:id", async (req, res) => {
  try {
    const { shopId, id } = req.params;
    const { data: note, error } = await supabase.from("credit_notes")
      .select("*").eq("id", id).eq("shop_id", shopId).maybeSingle();
    // Same treatment as the list endpoint: a missing table is a deployment
    // state, not a database error to show a shopkeeper verbatim.
    if (error && /relation|does not exist|schema cache/i.test(error.message || "")) {
      return res.status(501).json({ error: "Credit note table nahi hai — migration 20260805000000 chalayein" });
    }
    if (error) throw error;
    if (!note) return res.status(404).json({ error: "Credit note nahi mila" });

    const { data: shop } = await supabase.from("shops")
      .select("name, owner_name, address, phone, gstin").eq("id", shopId).maybeSingle();

    res.json({ creditNote: note, shop });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/invoices/:id/return", async (req, res) => {
  try {
    const { id } = req.params;
    const { returnItems, reason, shopId } = req.body;
    // returnItems: [{ designId, quantityBoxes }]

    if (!shopId) return res.status(400).json({ error: "shopId required" });
    if (!returnItems || returnItems.length === 0) {
      return res.status(400).json({ error: "returnItems required" });
    }

    // The invoice as issued. It is NOT modified by a return — see the credit
    // note migration for why. Only its payment_status changes, so the app can
    // still show that goods came back.
    const { data: invoiceRow, error: invErr } = await supabase
      .from("invoices")
      .select(`id, shop_id, payment_status, invoice_number, created_at, customer_name, customer_phone, customer_gstin, discount_amount, is_gst_invoice, taxable_value, cgst_amount, sgst_amount${igstCol()}${HAS_IGST_COLUMN ? ", place_of_supply" : ""}`)
      .eq("id", id)
      .maybeSingle();
    if (invErr || !invoiceRow) return res.status(404).json({ error: "Invoice not found" });
    if (invoiceRow.shop_id !== shopId) return res.status(403).json({ error: "Yeh invoice aapke shop ka nahi hai" });
    if (invoiceRow.payment_status === "returned") {
      return res.json({ success: true, message: "Invoice already fully returned", idempotent: true });
    }

    const { data: itemsData } = await supabase
      .from("invoice_items")
      .select("id, design_id, quantity_boxes, price_per_box, gst_rate")
      .eq("invoice_id", id);
    const itemList = itemsData || [];
    if (itemList.length === 0) return res.status(400).json({ error: "Is invoice me koi item nahi hai" });

    // Aggregate returned quantity per design (handles duplicate rows in returnItems).
    const returnByDesign = {};
    returnItems.forEach(r => {
      const q = parseFloat(r.quantityBoxes) || 0;
      if (q > 0) returnByDesign[r.designId] = (returnByDesign[r.designId] || 0) + q;
    });
    if (Object.keys(returnByDesign).length === 0) {
      return res.status(400).json({ error: "Koi quantity wapas nahi aayi" });
    }

    // Already-credited quantities, so returning the same goods twice cannot
    // credit them twice.
    const { data: priorNotes } = await supabase
      .from("credit_notes").select("lines").eq("invoice_id", id);
    const alreadyCredited = {};
    for (const note of (priorNotes || [])) {
      for (const line of (note.lines || [])) {
        alreadyCredited[line.designId] = (alreadyCredited[line.designId] || 0) + (parseFloat(line.quantity) || 0);
      }
    }
    const remainingItems = itemList.map(i => ({
      ...i,
      quantity_boxes: Math.max(0, (parseFloat(i.quantity_boxes) || 0) - (alreadyCredited[i.design_id] || 0)),
    }));
    if (remainingItems.every(i => i.quantity_boxes <= 0)) {
      return res.status(409).json({ error: "Is invoice ka sara maal pehle hi wapas ho chuka hai" });
    }

    // The GST mode is not stored on the invoice, so it is inferred from what was
    // recorded: if the stored taxable value is less than the item gross, tax was
    // inside the price. Inferring beats assuming, and both paths are tested.
    const itemGross = itemList.reduce((s, i) => s + (parseFloat(i.quantity_boxes) || 0) * (parseFloat(i.price_per_box) || 0), 0);
    const netOfDiscount = Math.max(0, itemGross - (parseFloat(invoiceRow.discount_amount) || 0));
    const storedTaxable = parseFloat(invoiceRow.taxable_value) || 0;
    const isGstInvoice = invoiceRow.is_gst_invoice !== false && storedTaxable > 0;
    const gstMode = isGstInvoice && storedTaxable < netOfDiscount - 0.5 ? "included" : "exclusive";
    const interState = !!invoiceRow.is_inter_state || (parseFloat(invoiceRow.igst_amount) || 0) > 0;

    const credit = computeCreditNote({
      originalItems: remainingItems,
      returnedQty: returnByDesign,
      gstMode,
      isGstInvoice,
      discountAmount: invoiceRow.discount_amount,
      interState,
    });
    if (credit.lines.length === 0) {
      return res.status(400).json({ error: "Yeh maal is invoice me nahi hai" });
    }

    // Restore stock for what came back.
    await Promise.all(credit.lines.map(async (line) => {
      const { data: inv } = await supabase
        .from("inventory")
        .select("id, quantity_boxes")
        .eq("shop_id", shopId)
        .eq("design_id", line.designId)
        .maybeSingle();
      if (inv) {
        const { error: restoreErr } = await supabase.from("inventory")
          .update({ quantity_boxes: (inv.quantity_boxes || 0) + line.quantity })
          .eq("id", inv.id);
        if (restoreErr) throw restoreErr;
      }
    }));

    // Issue the credit note. The serial number must be unique within the shop's
    // financial year, so a conflict from a concurrent return is retried with the
    // next sequence rather than silently reusing a number.
    const fy = financialYear();
    const adjustment = gstAdjustmentAllowed(invoiceRow.created_at);
    let creditNote = null, cnError = null;

    const { count } = await supabase.from("credit_notes")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId).eq("financial_year", fy);

    for (let attempt = 0; attempt < 5 && !creditNote; attempt++) {
      const sequence = (count || 0) + 1 + attempt;
      const row = {
        shop_id: shopId,
        invoice_id: id,
        credit_note_number: creditNoteNumber({ sequence }),
        financial_year: fy,
        sequence,
        reason: reason || "Customer return",
        customer_name: invoiceRow.customer_name,
        customer_phone: invoiceRow.customer_phone,
        customer_gstin: invoiceRow.customer_gstin,
        original_invoice_number: invoiceRow.invoice_number,
        original_invoice_date: invoiceRow.created_at,
        taxable_value: credit.taxableValue,
        cgst_amount: credit.cgst,
        sgst_amount: credit.sgst,
        igst_amount: credit.igst,
        total_credit: credit.totalCredit,
        is_inter_state: interState,
        place_of_supply: invoiceRow.place_of_supply || null,
        is_full_return: credit.isFullReturn,
        lines: credit.lines,
        gst_adjustable: adjustment.allowed,
      };
      const { data, error } = await supabase.from("credit_notes").insert([row]).select().single();
      if (!error) { creditNote = data; break; }
      cnError = noteIfRlsError("credit_notes", error);
      // A duplicate serial is a race worth retrying; anything else is not.
      if (!/duplicate key|unique/i.test(error.message || "")) break;
    }

    // Stock is already back on the shelf. If the note could not be written, say
    // so plainly instead of reporting a clean return that produced no document.
    if (!creditNote) {
      const migrationMissing = /relation|does not exist|schema cache/i.test(cnError?.message || "");
      return res.status(migrationMissing ? 501 : 500).json({
        error: migrationMissing
          ? "Credit note table nahi hai — migration 20260805000000 chalayein"
          : `Credit note ban nahi paya: ${cnError?.message}`,
        stockRestored: true,
      });
    }

    // Mark the invoice's return state without touching its amounts.
    const totalRemaining = remainingItems.reduce((s, i) => s + i.quantity_boxes, 0);
    const returnedNow = credit.lines.reduce((s, l) => s + l.quantity, 0);
    const newStatus = returnedNow >= totalRemaining ? "returned" : "partial_return";

    const { error: statusErr } = await supabase.from("invoices").update({
      payment_status: newStatus,
      return_note: reason || "Customer return",
    }).eq("id", id).eq("shop_id", shopId);
    if (statusErr) throw statusErr;

    res.json({
      success: true,
      returnStatus: newStatus,
      creditNote,
      gstAdjustment: adjustment,
      // Stated rather than buried: the goods can come back at any time, but the
      // tax can only be recovered inside the statutory window.
      note: adjustment.allowed
        ? null
        : `GST adjustment window closed on ${adjustment.deadline}. Goods returned, but the tax on this sale can no longer be reduced.`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/payment-events", async (req, res) => {
  try {
    const { invoiceId, amount, paymentMode, note, shopId } = req.body;
    if (!invoiceId || !amount) return res.status(400).json({ error: "invoiceId and amount required" });
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: "amount must be > 0" });

    // Verify invoice belongs to this shop — was previously skipped entirely when shopId was
    // omitted from the request, letting a payment event be logged against any shop's invoice.
    const { data: ownerCheck } = await supabase.from("invoices").select("id").eq("id", invoiceId).eq("shop_id", shopId).single();
    if (!ownerCheck) return res.status(403).json({ error: "Invoice not found in this shop" });

    const { data, error } = await supabase.from("payment_events").insert([{
      invoice_id: invoiceId,
      amount: amt,
      payment_mode: paymentMode || "cash",
      note: note || null,
    }]).select();
    if (error) throw error;

    // Also update invoice amount_paid + status
    const { data: inv } = await supabase.from("invoices")
      .select(`id, amount_paid, taxable_value, cgst_amount, sgst_amount${igstCol()}, invoice_items(quantity_boxes, price_per_box)`)
      .eq("id", invoiceId).single();
    if (inv) {
      const { data: allEvents } = await supabase.from("payment_events")
        .select("amount").eq("invoice_id", invoiceId);
      const totalPaid = (allEvents || []).reduce((s, e) => s + e.amount, 0);
      const gross = (inv.invoice_items || []).reduce((s, i) => s + (i.quantity_boxes * i.price_per_box), 0)
        || (invoiceGrossValue(inv));
      const status = totalPaid >= gross ? "paid" : "partial";
      const { error: statusErr } = await supabase.from("invoices").update({ amount_paid: totalPaid, payment_status: status }).eq("id", invoiceId);
      if (statusErr) throw statusErr;
    }
    res.json({ success: true, event: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all payment events for an invoice
app.get("/api/payment-events/:invoiceId", async (req, res) => {
  try {
    const { data, error } = await supabase.from("payment_events")
      .select("*").eq("invoice_id", req.params.invoiceId).order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// All customers list (derived from invoices)
app.get("/api/customers/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const { data, error } = await supabase.from("invoices")
      .select(`customer_name, customer_phone, payment_status, amount_paid, taxable_value, cgst_amount, sgst_amount${igstCol()}, invoice_items(quantity_boxes, price_per_box)`)
      .eq("shop_id", shopId)
      .not("payment_status", "in", '("cancelled","returned")')
      .order("created_at", { ascending: false });
    if (error) throw error;

    // Group by customer_phone (or name if no phone)
    const customerMap = {};
    for (const inv of (data || [])) {
      const key = inv.customer_phone || inv.customer_name;
      const gross = (inv.invoice_items || []).reduce((s, i) => s + (i.quantity_boxes * i.price_per_box), 0)
        || (invoiceGrossValue(inv));
      if (!customerMap[key]) {
        customerMap[key] = { name: inv.customer_name, phone: inv.customer_phone, totalBilled: 0, totalPaid: 0, invoiceCount: 0 };
      }
      customerMap[key].totalBilled += Math.round(gross);
      customerMap[key].totalPaid += (inv.amount_paid || (inv.payment_status === 'paid' ? gross : 0));
      customerMap[key].invoiceCount += 1;
    }

    const customers = Object.values(customerMap).map(c => ({
      ...c,
      totalBilled: Math.round(c.totalBilled),
      totalPaid: Math.round(c.totalPaid),
      outstanding: Math.round(c.totalBilled - c.totalPaid),
    })).sort((a, b) => b.outstanding - a.outstanding);

    res.json(customers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Full invoice + payment history for one customer
app.get("/api/customers/:shopId/history", async (req, res) => {
  try {
    const { shopId } = req.params;
    const { phone, name } = req.query;
    if (!phone && !name) return res.status(400).json({ error: "phone or name required" });

    let query = supabase.from("invoices")
      .select("*, invoice_items(quantity_boxes, price_per_box, design_id, hsn_code, gst_rate, designs(design_code, design_name))")
      .eq("shop_id", shopId)
      .not("payment_status", "in", '("cancelled","returned")')
      .order("created_at", { ascending: false });

    if (phone) query = query.ilike("customer_phone", `%${phone}%`);
    else query = query.ilike("customer_name", `%${name}%`);

    const { data: invoices, error } = await query;
    if (error) throw error;

    // Fetch payment events for each invoice
    const invoiceIds = (invoices || []).map(i => i.id);
    let eventsByInvoice = {};
    if (invoiceIds.length > 0) {
      const { data: events } = await supabase.from("payment_events")
        .select("*").in("invoice_id", invoiceIds).order("created_at", { ascending: false });
      (events || []).forEach(e => {
        if (!eventsByInvoice[e.invoice_id]) eventsByInvoice[e.invoice_id] = [];
        eventsByInvoice[e.invoice_id].push(e);
      });
    }

    const enriched = (invoices || []).map(inv => {
      // Net payable = AFTER discount (what customer actually owes).
      let net;
      if (inv.taxable_value != null) {
        net = invoiceGrossValue(inv);
      } else {
        const itemsGross = (inv.invoice_items || []).reduce((s, i) => s + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0);
        net = Math.max(0, itemsGross - (inv.discount_amount || 0));
      }
      const paid = inv.amount_paid || (inv.payment_status === 'paid' ? net : 0);
      return { ...inv, grossAmount: Math.round(net), amountPaid: Math.round(paid), outstanding: Math.round(net - paid), paymentEvents: eventsByInvoice[inv.id] || [] };
    });

    const totalBilled = enriched.reduce((s, i) => s + i.grossAmount, 0);
    const totalPaid = enriched.reduce((s, i) => s + i.amountPaid, 0);

    res.json({ invoices: enriched, totalBilled, totalPaid, outstanding: totalBilled - totalPaid,
      customerName: invoices?.[0]?.customer_name, customerPhone: invoices?.[0]?.customer_phone });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WEEK 2 — ANALYTICS & PROJECTIONS
// ============================================

app.get("/api/analytics/projections/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const months = parseInt(req.query.months) || 6;
    const since = new Date();
    since.setMonth(since.getMonth() - months);

    const { data: invoices, error } = await supabase.from("invoices")
      .select("created_at, payment_status, invoice_items(quantity_boxes, price_per_box, design_id, designs(design_name))")
      .eq("shop_id", shopId)
      .not("payment_status", "in", '("cancelled","returned")')
      .gte("created_at", since.toISOString())
      .order("created_at");
    if (error) throw error;

    // Group by month
    const monthly = {};
    const dayOfWeek = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    const itemVelocity = {};

    for (const inv of (invoices || [])) {
      const month = inv.created_at.slice(0, 7);
      const gross = (inv.invoice_items || []).reduce((s, i) => s + (i.quantity_boxes * i.price_per_box), 0);
      if (!monthly[month]) monthly[month] = { month, revenue: 0, invoiceCount: 0 };
      monthly[month].revenue += Math.round(gross);
      monthly[month].invoiceCount += 1;
      dayOfWeek[new Date(inv.created_at).getDay()] += Math.round(gross);

      for (const item of (inv.invoice_items || [])) {
        const n = item.designs?.design_name || item.design_id;
        if (!itemVelocity[n]) itemVelocity[n] = 0;
        itemVelocity[n] += item.quantity_boxes;
      }
    }

    const monthlyArr = Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month));
    const revenues = monthlyArr.map(m => m.revenue);
    const avgRevenue = revenues.length > 0 ? revenues.reduce((s, v) => s + v, 0) / revenues.length : 0;

    // Simple linear projection: last 3 months trend
    const last3 = revenues.slice(-3);
    const trend = last3.length >= 2 ? (last3[last3.length - 1] - last3[0]) / (last3.length - 1) : 0;
    const projectedNext = Math.round(Math.max(0, (last3[last3.length - 1] || avgRevenue) + trend));

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const peakDay = dayNames[Object.entries(dayOfWeek).sort((a, b) => b[1] - a[1])[0][0]];

    const slowItems = Object.entries(itemVelocity)
      .sort((a, b) => a[1] - b[1]).slice(0, 5).map(([name, qty]) => ({ name, qty }));
    const topItems = Object.entries(itemVelocity)
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty }));

    // Gemini insights
    let insights = [], warnings = [];
    try {
      const prompt = `Shop monthly revenue last ${months} months: ${JSON.stringify(monthlyArr)}.
Peak day: ${peakDay}. Top items: ${topItems.map(i=>i.name).join(', ')}.
Slow items: ${slowItems.map(i=>i.name).join(', ')}. Projected next month: ₹${projectedNext}.
Give 3 short actionable Hindi/English insights for Indian shopkeeper. Reply JSON only: {"insights":["..."],"warnings":["..."]}`;

      const gRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 300, temperature: 0.5 } }) }
      );
      const gData = await gRes.json();
      const text = gData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) { const parsed = JSON.parse(match[0]); insights = parsed.insights || []; warnings = parsed.warnings || []; }
    } catch {}

    res.json({ monthly: monthlyArr, projectedNext, avgRevenue: Math.round(avgRevenue), peakDay, topItems, slowItems, dayOfWeek, insights, warnings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WEEK 3 — JEWELLERY MODE
// ============================================

// Live gold/silver rates (fallback static if API fails)
app.get("/api/jewellery/rates", async (req, res) => {
  try {
    // Static fallback rates (update daily via cron if needed)
    // In production: fetch from MCX or commodity API
    res.json({
      gold22k: 6850,   // per gram INR (approximate)
      gold18k: 5600,
      gold24k: 7450,
      silver: 85,      // per gram
      platinum: 3200,
      lastUpdated: new Date().toISOString(),
      note: "Indicative rates. Verify with current MCX before billing."
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Jewellery invoice: weight-based billing
app.post("/api/invoices/jewellery", async (req, res) => {
  let createdInvoiceId = null;
  try {
    const { shopId, customerName, customerPhone, customerAddress, customerGstin,
      items, paymentStatus, showGst } = req.body;
    // items: [{ designId, weightGrams, metalRate, makingChargesPerGram, purity, hsnCode }]

    if (!shopId) return res.status(400).json({ error: "shopId required" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Items required" });
    const isGst = showGst === true || showGst === 'true';
    const GST_JEWELLERY = 3; // 3% GST on jewellery

    let totalTaxable = 0, totalGst = 0, finalTotal = 0;
    const itemCalcs = (items || []).map(item => {
      const weight = parseFloat(item.weightGrams) || 0;
      const rate = parseFloat(item.metalRate) || 0;
      const making = parseFloat(item.makingChargesPerGram) || 0;
      const metalValue = weight * rate;
      const makingValue = weight * making;
      const taxable = metalValue + makingValue;
      const gst = isGst ? taxable * GST_JEWELLERY / 100 : 0;
      const lineTotal = taxable + gst;
      totalTaxable += taxable;
      totalGst += gst;
      finalTotal += lineTotal;
      return { ...item, metalValue: Math.round(metalValue), makingValue: Math.round(makingValue), taxable: Math.round(taxable), gst: Math.round(gst), lineTotal: Math.round(lineTotal) };
    });

    const cgst = totalGst / 2;
    const sgst = totalGst / 2;
    const gstinUpper = customerGstin ? customerGstin.toUpperCase() : null;
    const invoiceType = (gstinUpper && isValidGstin(gstinUpper)) ? 'B2B' : 'B2C';

    const { data: invoice, error } = await supabase.from("invoices").insert([{
      shop_id: shopId,
      invoice_number: `JW-${Date.now()}`,
      customer_name: customerName,
      customer_phone: customerPhone || null,
      customer_address: customerAddress || null,
      customer_gstin: gstinUpper,
      invoice_type: invoiceType,
      taxable_value: Math.round(totalTaxable * 100) / 100,
      cgst_amount: Math.round(cgst * 100) / 100,
      sgst_amount: Math.round(sgst * 100) / 100,
      gst_rate: GST_JEWELLERY,
      is_gst_invoice: isGst,
      payment_status: paymentStatus || 'paid',
      amount_paid: paymentStatus === 'credit' ? 0 : null,
    }]).select();
    if (error) throw error;
    createdInvoiceId = invoice[0].id;

    // Batch insert invoice_items; roll back invoice if it fails
    const itemRows = itemCalcs.map(item => ({
      invoice_id: createdInvoiceId,
      design_id: item.designId || null,
      quantity_boxes: item.weightGrams,
      price_per_box: item.metalRate,
      hsn_code: item.hsnCode || '7113',
      gst_rate: GST_JEWELLERY,
    }));
    const { error: itemsErr } = await supabase.from("invoice_items").insert(itemRows);
    if (itemsErr) throw itemsErr;

    res.json({ message: "✓ Jewellery invoice generated", invoice: { ...invoice[0], items: itemCalcs, grossAmount: Math.round(finalTotal), cgst: Math.round(cgst), sgst: Math.round(sgst), isGstInvoice: isGst } });
  } catch (error) {
    if (createdInvoiceId) {
      await supabase.from("invoice_items").delete().eq("invoice_id", createdInvoiceId);
      await supabase.from("invoices").delete().eq("id", createdInvoiceId);
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// EXPENSE TRACKER
// ============================================

const EXPENSE_CATEGORIES = ['rent', 'utility', 'salary', 'transport', 'marketing', 'other'];

app.post("/api/expenses", async (req, res) => {
  try {
    const { shopId, category, amount, note, expenseDate } = req.body;
    if (!shopId || !category || !amount) return res.status(400).json({ error: "shopId, category, amount required" });
    if (!EXPENSE_CATEGORIES.includes(category)) return res.status(400).json({ error: "Invalid category" });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: "amount must be > 0" });

    const { data, error } = await supabase.from("expenses").insert([{
      shop_id: shopId,
      category,
      amount: amt,
      note: note || null,
      expense_date: expenseDate || new Date().toISOString(),
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, expense: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/expenses/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const { month, year } = req.query;
    let query = supabase.from("expenses").select("*").eq("shop_id", shopId).order("expense_date", { ascending: false });
    if (month) {
      const [yr, mo] = month.split('-').map(Number);
      const nextYr = mo === 12 ? yr + 1 : yr;
      const nextMo = mo === 12 ? 1 : mo + 1;
      const nextMonth = `${nextYr}-${String(nextMo).padStart(2, '0')}`;
      query = query.gte("expense_date", `${month}-01T00:00:00+05:30`)
                   .lt("expense_date", `${nextMonth}-01T00:00:00+05:30`);
    } else if (year) {
      const fy = parseInt(year);
      query = query.gte("expense_date", `${fy}-04-01T00:00:00+05:30`)
                   .lte("expense_date", `${fy + 1}-03-31T23:59:59+05:30`);
    }
    const { data, error } = await query;
    if (error) throw error;

    const byCategory = {};
    const total = (data || []).reduce((s, e) => {
      byCategory[e.category] = (byCategory[e.category] || 0) + (e.amount || 0);
      return s + (e.amount || 0);
    }, 0);

    res.json({ expenses: data || [], total: Math.round(total), byCategory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/expenses/:id", async (req, res) => {
  try {
    const shopId = req.body?.shopId || req.query.shopId;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    // Scope the delete to this shop — without this, any shop could delete another
    // shop's expense record just by knowing/guessing its id.
    const { data, error } = await supabase.from("expenses")
      .delete()
      .eq("id", req.params.id)
      .eq("shop_id", shopId)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Expense not found in this shop" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// OVERDUE BAKAYA REMINDERS
// ============================================

// List overdue credit/partial invoices grouped by age bucket
app.get("/api/reminders/overdue/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const { data: invoices, error } = await supabase
      .from("invoices")
      .select(`id, invoice_number, customer_name, customer_phone, created_at, payment_status, amount_paid, taxable_value, cgst_amount, sgst_amount${igstCol()}, last_reminder_at, invoice_items(quantity_boxes, price_per_box)`)
      .eq("shop_id", shopId)
      .in("payment_status", ["credit", "partial"])
      .not("customer_phone", "is", null)
      .order("created_at", { ascending: true });
    if (error) throw error;

    const enriched = (invoices || []).map(inv => {
      const items = inv.invoice_items || [];
      const gross = items.reduce((s, i) => s + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0)
        || (invoiceGrossValue(inv));
      const outstanding = Math.round(gross - (inv.amount_paid || 0));
      const ageDays = Math.floor((now - new Date(inv.created_at).getTime()) / day);
      const reminderAgeDays = inv.last_reminder_at
        ? Math.floor((now - new Date(inv.last_reminder_at).getTime()) / day)
        : 999;
      let bucket = 'fresh';
      if (ageDays >= 30) bucket = 'critical';
      else if (ageDays >= 15) bucket = 'overdue';
      else if (ageDays >= 7) bucket = 'due';
      return {
        id: inv.id, invoice_number: inv.invoice_number,
        customer_name: inv.customer_name, customer_phone: inv.customer_phone,
        outstanding, ageDays, reminderAgeDays, bucket,
        created_at: inv.created_at, last_reminder_at: inv.last_reminder_at,
      };
    }).filter(i => i.outstanding > 0 && i.bucket !== 'fresh');

    const summary = {
      due: enriched.filter(i => i.bucket === 'due').length,
      overdue: enriched.filter(i => i.bucket === 'overdue').length,
      critical: enriched.filter(i => i.bucket === 'critical').length,
      total: enriched.length,
      totalAmount: enriched.reduce((s, i) => s + i.outstanding, 0),
    };

    res.json({ summary, invoices: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark reminders as sent (bulk update last_reminder_at)
app.post("/api/reminders/mark-sent", async (req, res) => {
  try {
    const { invoiceIds, shopId } = req.body;
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.status(400).json({ error: "invoiceIds array required" });
    }
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    // Supabase's query builder is immutable — .eq() returns a NEW query rather than mutating
    // the existing one, so the old "if (shopId) query.eq(...)" (discarding the return value)
    // never actually applied the shop filter. Reassigning here is what makes it take effect.
    let query = supabase.from("invoices").update({ last_reminder_at: new Date().toISOString() }).in("id", invoiceIds);
    query = query.eq("shop_id", shopId);
    const { error } = await query;
    if (error) throw error;
    res.json({ success: true, count: invoiceIds.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// START SERVER (must be after all routes registered)
// ============================================

app.listen(PORT, () => {
  // Report what is actually configured. The banner used to claim "Supabase Connected"
  // unconditionally, which is exactly the wrong thing to read while debugging an outage.
  const dbState = SUPABASE_URL && SUPABASE_KEY ? "configured" : "NOT CONFIGURED";
  const aiState = process.env.GEMINI_API_KEY ? "configured" : "not configured";
  console.log([
    "FastBill backend",
    `  port:     ${PORT}`,
    `  database: ${dbState}`,
    `  ai:       ${aiState}`,
    `  env:      ${process.env.NODE_ENV || "development"}`,
    dbState === "NOT CONFIGURED"
      ? "  WARNING: every database call will fail until SUPABASE_URL and SUPABASE_ANON_KEY are set."
      : "",
  ].filter(Boolean).join("\n"));
});
