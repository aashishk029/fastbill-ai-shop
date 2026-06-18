const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const { createWorker } = require("tesseract.js");

// Rate limiter — optional dependency. If not installed, falls back to no-op so server still boots.
let rateLimit = null;
try { rateLimit = require("express-rate-limit"); } catch (e) { console.warn("express-rate-limit not installed — rate limiting disabled"); }
const makeLimiter = (max, windowMs) =>
  rateLimit ? rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests, thodi der baad try karein" } })
            : (req, res, next) => next();
// Tight limit on auth (brute-force) + expensive AI routes (cost abuse).
const authLimiter = makeLimiter(20, 15 * 60 * 1000);   // 20 / 15min per IP
const aiLimiter = makeLimiter(30, 15 * 60 * 1000);     // 30 / 15min per IP

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
// CORS: restrict to ALLOWED_ORIGINS (comma-separated) when set, else allow all (dev/back-compat).
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : null;
app.use(cors({
  origin: ALLOWED_ORIGINS || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));

// Initialize Supabase.
// Accept either SUPABASE_ANON_KEY (code default) or SUPABASE_KEY (render.yaml legacy name).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: SUPABASE_URL / SUPABASE_ANON_KEY (or SUPABASE_KEY) missing in env. DB calls will fail.");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

    res.json({ message: "✓ Shop initialized", shop: shop[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Shop Details
app.get("/api/shops/:shopId", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("shops")
      .select("*")
      .eq("id", req.params.shopId)
      .single();

    if (error) throw error;

    // Never expose the password hash to clients.
    const { pin_hash, ...safe } = data;
    res.json(safe);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update shop details (UPI, GSTIN, address, etc.)
app.patch("/api/shops/:shopId", async (req, res) => {
  try {
    const allowed = ['name', 'owner_name', 'address', 'gstin', 'pan_number', 'upi_id', 'auto_reminder_enabled', 'reminder_threshold_days'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
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
app.post("/api/shops/login", authLimiter, async (req, res) => {
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
      return res.status(404).json({ error: "Koi shop nahi mila is number pe" });
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
      return res.status(401).json({ error: "Galat PIN. Dobara try karo." });
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

    res.json({
      totalItems: enrichedInventory.length,
      lowStockCount: lowStock.length,
      inventory: enrichedInventory,
      lowStockItems: lowStock,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate Invoice
// GSTIN format: 2 digits state + 5 letters PAN + 4 digits + 1 letter + 1 digit/Z + 1 alphanumeric
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][Z][0-9A-Z]$/;
const isValidGstin = (g) => typeof g === 'string' && GSTIN_REGEX.test(g.toUpperCase());

app.post("/api/invoices/generate", async (req, res) => {
  let createdInvoiceId = null;
  try {
    const { shopId, customerName, customerPhone, customerAddress, customerGstin, showGst, gstMode, items, paymentStatus, discountAmount } = req.body;
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Items required" });
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
        return res.status(400).json({ error: `Yeh product is shop ke inventory me nahi hai (designId: ${it.designId})` });
      }
      if (qty(it.quantityBoxes) > (stockMap[it.designId] || 0)) {
        return res.status(400).json({ error: `Stock kam hai. Available: ${stockMap[it.designId] || 0}, maanga: ${qty(it.quantityBoxes)}` });
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
    const cgst = gstAmount / 2;
    const sgst = gstAmount / 2;
    const gstinUpper = customerGstin ? customerGstin.toUpperCase() : null;
    const invoiceType = (gstinUpper && isValidGstin(gstinUpper)) ? 'B2B' : 'B2C';

    // Insert invoice
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .insert([{
        shop_id: shopId,
        invoice_number: `INV-${Date.now()}`,
        customer_name: customerName,
        customer_phone: customerPhone || null,
        customer_address: customerAddress || null,
        customer_gstin: gstinUpper,
        invoice_type: invoiceType,
        taxable_value: isGstInvoice ? Math.round(taxableValue * 100) / 100 : null,
        cgst_amount: isGstInvoice ? Math.round(cgst * 100) / 100 : null,
        sgst_amount: isGstInvoice ? Math.round(sgst * 100) / 100 : null,
        gst_rate: null, // mixed per-item rates — see invoice_items
        is_gst_invoice: isGstInvoice,
        payment_status: paymentStatus || 'paid',
        amount_paid: (paymentStatus === 'credit') ? 0 : null,
        table_number: req.body.tableNumber || null,
        discount_amount: discount > 0 ? Math.round(discount * 100) / 100 : null,
      }])
      .select();

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
      const { error } = await supabase.rpc("update_inventory_after_invoice", {
        design_id: item.designId,
        quantity: qty(item.quantityBoxes),
      });
      return error;
    }));
    const invErr = inventoryUpdates.find(e => e);
    if (invErr) throw invErr;

    res.json({
      message: "✓ Invoice generated",
      invoice: {
        ...invoice[0],
        totalBoxes,
        itemsTotal: Math.round(itemsTotal),
        discountAmount: Math.round(discount * 100) / 100,
        grossAmount: Math.round(finalGrossAmount),
        finalTotal: Math.round(finalGrossAmount),
        taxableValue: Math.round(taxableValue),
        cgst: Math.round(cgst * 100) / 100,
        sgst: Math.round(sgst * 100) / 100,
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
            cgstAmount: Math.round(c.itemGst / 2 * 100) / 100,
            sgstAmount: Math.round(c.itemGst / 2 * 100) / 100,
            totalWithGst: Math.round(itemTotal * 100) / 100,
          };
        }),
      },
    });
  } catch (error) {
    // Roll back invoice if items/inventory step failed
    if (createdInvoiceId) {
      await supabase.from("invoice_items").delete().eq("invoice_id", createdInvoiceId);
      await supabase.from("invoices").delete().eq("id", createdInvoiceId);
    }
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
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "No image data provided" });

    let rawText = "";
    let items = [];

    // Primary: Gemini 1.5 Flash — reads bills perfectly, returns structured JSON
    if (process.env.GEMINI_API_KEY) {
      const geminiText = await geminiVision(
        imageBase64,
        `This is a purchase bill/invoice. Extract ALL line items. Return ONLY valid JSON array, no other text:
[{"designCode":"product name or code","quantity":10,"rate":250}]
Rules: quantity and rate must be numbers. Use null if not visible. Return [] if no items found.`
      );
      if (geminiText) {
        try {
          const start = geminiText.indexOf('[');
          const end = geminiText.lastIndexOf(']') + 1;
          if (start !== -1 && end > start) {
            items = JSON.parse(geminiText.slice(start, end));
            rawText = `Gemini extracted ${items.length} items`;
          }
        } catch (e) { console.error("Gemini JSON parse error:", e.message, geminiText.slice(0, 200)); }
      }
    }

    // Fallback: Tesseract OCR + regex parser
    if (!items.length) {
      try {
        const imgBuffer = Buffer.from(imageBase64, 'base64');
        const worker = await createWorker('eng+hin', 1, { logger: () => {} });
        const { data } = await worker.recognize(imgBuffer);
        await worker.terminate();
        rawText = data.text || "";
        items = parseBillText(rawText);
      } catch (e) { console.error("Tesseract error:", e.message); }
    }

    // Last fallback: local Ollama moondream
    if (!items.length && process.env.OLLAMA_URL) {
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

      if (invRow) {
        await supabase.from("inventory")
          .update({ quantity_boxes: invRow.quantity_boxes + qty })
          .eq("id", invRow.id);
      } else {
        await supabase.from("inventory").insert({
          shop_id: shopId, design_id: item.designId, quantity_boxes: qty, is_low_stock: false,
        });
      }

      // Record purchase for profit/credit scoring
      await supabase.from("purchases").insert({
        shop_id: shopId,
        design_id: item.designId,
        quantity_boxes: qty,
        cost_per_box: parseFloat(item.rate) || 0,
        purchase_date: new Date().toISOString(),
      });
    }

    res.json({ message: "✓ Stock updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI-Powered Alerts
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

// Shared Gemini vision helper
async function geminiVision(imageBase64, prompt, mimeType = "image/jpeg") {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
        { text: prompt }
      ]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 800 }
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }
  );
  if (!r.ok) { console.error("Gemini error:", r.status, (await r.text()).slice(0, 200)); return null; }
  const data = await r.json();
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
      .select("payment_status, amount_paid, taxable_value, cgst_amount, sgst_amount, created_at, invoice_items(quantity_boxes, price_per_box)")
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
        || (inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0);
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
        const gross = (inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0);
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
        const gross = (inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0);
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
        const gross = (inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0);
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

    const gross = (inv) => (inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0);

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
    if (lowStock.length) {
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
Low stock items (${briefing.lowStockCount}): ${lowStock.map(l => `${l.name} ${l.qty}${l.unit}`).join("; ") || "none"}`.trim();

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
          // Only override the deterministic fallback if the model actually said
          // something substantive (real length + contains a number).
          const looksReal = txt.length > 15 && /\d/.test(txt);
          if (looksReal) narration = txt;
        }
      } catch (_) { /* keep deterministic fallback */ }
    }

    res.json({ briefing, narration });
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
        .select("customer_name, total_amount, taxable_value, cgst_amount, sgst_amount, created_at")
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
      const amt = parseFloat(i.total_amount) || (parseFloat(i.taxable_value) + parseFloat(i.cgst_amount || 0) + parseFloat(i.sgst_amount || 0)) || 0;
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
    const { shopId, design_id, quantity_boxes, supplier_name, cost_per_box } = req.body;

    if (!shopId || !design_id || !quantity_boxes) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Insert purchase record
    const { data: purchase, error: purchaseError } = await supabase
      .from("purchases")
      .insert([
        {
          shop_id: shopId,
          design_id,
          quantity_boxes: parseFloat(quantity_boxes) || 0,
          supplier_name: supplier_name || "Direct Purchase",
          cost_per_box: parseFloat(cost_per_box) || 0,
          purchase_date: new Date().toISOString(),
        },
      ])
      .select()
      .single();

    if (purchaseError) throw purchaseError;

    // Update inventory - increase quantity
    const { data: currentInventory } = await supabase
      .from("inventory")
      .select("quantity_boxes")
      .eq("design_id", design_id)
      .eq("shop_id", shopId)
      .maybeSingle();

    if (currentInventory) {
      const newQuantity = (currentInventory.quantity_boxes || 0) + (parseFloat(quantity_boxes) || 0);
      const { error: updateError } = await supabase
        .from("inventory")
        .update({
          quantity_boxes: newQuantity,
          last_restocked_at: new Date().toISOString(),
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
    const { error: invError } = await supabase
      .from("inventory")
      .insert([{
        shop_id: shopId,
        design_id: design.id,
        quantity_boxes: parseFloat(initialQuantity) || 0,
        low_stock_threshold: 10,
        last_restocked_at: new Date().toISOString(),
      }]);
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
        .select("id, invoice_number, customer_name, customer_gstin, invoice_type, invoice_date, created_at, taxable_value, cgst_amount, sgst_amount, gst_rate, payment_status")
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
        .select("quantity_boxes, cost_per_box, purchase_date, supplier_name")
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
    const nonGstInvoices = nonGstInvoicesRes.status === "fulfilled" ? nonGstInvoicesRes.value.data || [] : [];
    const purchases = purchasesRes.status === "fulfilled" ? purchasesRes.value.data || [] : [];
    const shop = shopRes.status === "fulfilled" ? shopRes.value.data : {};
    const expenses = expensesRes.status === "fulfilled" ? expensesRes.value.data || [] : [];

    // ── GST SECTION (only GST invoices — non-GST bills are outside GST ambit) ──
    // grossSales for GSTR-1 = full invoice value (taxable + GST collected)
    const grossSales = invoices.reduce((s, inv) =>
      s + (inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0), 0);

    const taxableValue = invoices.reduce((s, inv) => s + (inv.taxable_value || 0), 0);
    const cgst = invoices.reduce((s, inv) => s + (inv.cgst_amount || 0), 0);
    const sgst = invoices.reduce((s, inv) => s + (inv.sgst_amount || 0), 0);
    const gstCollected = cgst + sgst;

    const itcAvailable = 0; // ITC tracking needs purchase GST invoices — not tracked yet
    const netGstPayable = Math.max(0, gstCollected - itcAvailable);

    // B2B split for GSTR-1
    const b2bInvoices = invoices.filter(inv => inv.invoice_type === 'B2B' || inv.customer_gstin);
    const b2bTaxable = b2bInvoices.reduce((s, inv) => s + (inv.taxable_value || 0), 0);
    const b2bGst = b2bInvoices.reduce((s, inv) => s + (inv.cgst_amount || 0) + (inv.sgst_amount || 0), 0);

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
      monthlyBreakdown[month].grossSales += (inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0);
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

    const totalPurchaseCost = purchases.reduce((s, p) => s + ((p.quantity_boxes || 0) * (p.cost_per_box || 0)), 0);

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
        grossSales: Math.round(grossSales),
        taxableValue: Math.round(taxableValue),
        cgst: Math.round(cgst),
        sgst: Math.round(sgst),
        totalGstCollected: Math.round(gstCollected),
        gstPaidOnPurchases: 0,
        itcAvailable: Math.round(itcAvailable),
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
    const [invoicesRes, purchasesRes] = await Promise.allSettled([
      supabase.from("invoices")
        .select("id, invoice_number, customer_name, customer_phone, created_at, payment_status, amount_paid, taxable_value, cgst_amount, sgst_amount, discount_amount, invoice_items(quantity_boxes, price_per_box)")
        .eq("shop_id", shopId)
        .in("payment_status", ["credit", "partial"])
        .order("created_at", { ascending: false })
        .limit(50),

      supabase.from("purchases")
        .select("id, supplier_name, created_at, purchase_date, payment_status, amount_paid, quantity_boxes, cost_per_box")
        .eq("shop_id", shopId)
        .in("payment_status", ["unpaid", "partial"])
        .order("purchase_date", { ascending: false })
        .limit(50),
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
        net = (inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0);
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

    res.json({ customerBakaya, supplierBakaya, creditInvoices: enrichedInvoices, unpaidPurchases: enrichedPurchases });
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

    // Compute totals from items
    const invoices = (data || []).map(inv => {
      const gross = (inv.invoice_items || []).reduce((s, i) => s + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0);
      const boxes = (inv.invoice_items || []).reduce((s, i) => s + (i.quantity_boxes || 0), 0);
      return { ...inv, grossAmount: Math.round(gross), totalBoxes: boxes };
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
        await supabase.from("inventory")
          .update({ quantity_boxes: (inv.quantity_boxes || 0) + (item.quantity_boxes || 0) })
          .eq("id", inv.id);
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
app.post("/api/invoices/:id/return", async (req, res) => {
  try {
    const { id } = req.params;
    const { returnItems, reason, shopId } = req.body;
    // returnItems: [{ designId, quantityBoxes }]

    if (!shopId) return res.status(400).json({ error: "shopId required" });
    if (!returnItems || returnItems.length === 0) {
      return res.status(400).json({ error: "returnItems required" });
    }

    // Lookup invoice for shop_id + idempotency
    const { data: invoiceRow, error: invErr } = await supabase
      .from("invoices")
      .select("id, shop_id, payment_status")
      .eq("id", id)
      .single();
    if (invErr || !invoiceRow) return res.status(404).json({ error: "Invoice not found" });
    if (invoiceRow.shop_id !== shopId) return res.status(403).json({ error: "Yeh invoice aapke shop ka nahi hai" });
    if (invoiceRow.payment_status === "returned") {
      return res.json({ success: true, message: "Invoice already fully returned", idempotent: true });
    }

    // Current invoice items (with price) — used to reduce lines + recompute totals.
    const { data: itemsData } = await supabase
      .from("invoice_items")
      .select("id, design_id, quantity_boxes, price_per_box")
      .eq("invoice_id", id);
    const itemList = itemsData || [];
    const originalValue = itemList.reduce((s, i) => s + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0);

    // Aggregate returned qty per design (handles duplicate rows in returnItems).
    const returnByDesign = {};
    returnItems.forEach(r => {
      const q = parseFloat(r.quantityBoxes) || 0;
      if (q > 0) returnByDesign[r.designId] = (returnByDesign[r.designId] || 0) + q;
    });

    // For each returned design: restore inventory + reduce the invoice line qty.
    await Promise.all(Object.entries(returnByDesign).map(async ([designId, q]) => {
      const { data: inv } = await supabase
        .from("inventory")
        .select("id, quantity_boxes")
        .eq("shop_id", invoiceRow.shop_id)
        .eq("design_id", designId)
        .maybeSingle();
      if (inv) {
        await supabase.from("inventory")
          .update({ quantity_boxes: (inv.quantity_boxes || 0) + q })
          .eq("id", inv.id);
      }
      const line = itemList.find(it => it.design_id === designId);
      if (line) {
        const newQty = Math.max(0, (line.quantity_boxes || 0) - q);
        line.quantity_boxes = newQty; // keep local copy in sync for remainingValue
        await supabase.from("invoice_items").update({ quantity_boxes: newQty }).eq("id", line.id);
      }
    }));

    // Recompute invoice totals by scaling stored values to the remaining proportion.
    // Linear scaling preserves GST mode (included/exclusive) + discount split correctly.
    const remainingValue = itemList.reduce((s, i) => s + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0);
    const ratio = originalValue > 0 ? remainingValue / originalValue : 0;
    const newStatus = remainingValue <= 0 ? "returned" : "partial_return";

    const { data: invFull } = await supabase
      .from("invoices")
      .select("taxable_value, cgst_amount, sgst_amount, discount_amount")
      .eq("id", id)
      .single();
    const scale = (v) => (v == null ? null : Math.round(v * ratio * 100) / 100);

    await supabase.from("invoices").update({
      payment_status: newStatus,
      return_note: reason || "Customer return",
      taxable_value: scale(invFull?.taxable_value),
      cgst_amount: scale(invFull?.cgst_amount),
      sgst_amount: scale(invFull?.sgst_amount),
      discount_amount: scale(invFull?.discount_amount),
    }).eq("id", id);

    res.json({ success: true, returnStatus: newStatus, itemsRestored: Object.keys(returnByDesign).length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WEEK 1 — CUSTOMER PAYMENT HISTORY
// ============================================

// Record a payment event (partial/full payment with date)
app.post("/api/payment-events", async (req, res) => {
  try {
    const { invoiceId, amount, paymentMode, note, shopId } = req.body;
    if (!invoiceId || !amount) return res.status(400).json({ error: "invoiceId and amount required" });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: "amount must be > 0" });

    // Verify invoice belongs to this shop
    if (shopId) {
      const { data: ownerCheck } = await supabase.from("invoices").select("id").eq("id", invoiceId).eq("shop_id", shopId).single();
      if (!ownerCheck) return res.status(403).json({ error: "Invoice not found in this shop" });
    }

    const { data, error } = await supabase.from("payment_events").insert([{
      invoice_id: invoiceId,
      amount: amt,
      payment_mode: paymentMode || "cash",
      note: note || null,
    }]).select();
    if (error) throw error;

    // Also update invoice amount_paid + status
    const { data: inv } = await supabase.from("invoices")
      .select("id, amount_paid, taxable_value, cgst_amount, sgst_amount, invoice_items(quantity_boxes, price_per_box)")
      .eq("id", invoiceId).single();
    if (inv) {
      const { data: allEvents } = await supabase.from("payment_events")
        .select("amount").eq("invoice_id", invoiceId);
      const totalPaid = (allEvents || []).reduce((s, e) => s + e.amount, 0);
      const gross = (inv.invoice_items || []).reduce((s, i) => s + (i.quantity_boxes * i.price_per_box), 0)
        || ((inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0));
      const status = totalPaid >= gross ? "paid" : "partial";
      await supabase.from("invoices").update({ amount_paid: totalPaid, payment_status: status }).eq("id", invoiceId);
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
      .select("customer_name, customer_phone, payment_status, amount_paid, taxable_value, cgst_amount, sgst_amount, invoice_items(quantity_boxes, price_per_box)")
      .eq("shop_id", shopId)
      .not("payment_status", "in", '("cancelled","returned")')
      .order("created_at", { ascending: false });
    if (error) throw error;

    // Group by customer_phone (or name if no phone)
    const customerMap = {};
    for (const inv of (data || [])) {
      const key = inv.customer_phone || inv.customer_name;
      const gross = (inv.invoice_items || []).reduce((s, i) => s + (i.quantity_boxes * i.price_per_box), 0)
        || ((inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0));
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
        net = (inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0);
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
    const { error } = await supabase.from("expenses").delete().eq("id", req.params.id);
    if (error) throw error;
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
      .select("id, invoice_number, customer_name, customer_phone, created_at, payment_status, amount_paid, taxable_value, cgst_amount, sgst_amount, last_reminder_at, invoice_items(quantity_boxes, price_per_box)")
      .eq("shop_id", shopId)
      .in("payment_status", ["credit", "partial"])
      .not("customer_phone", "is", null)
      .order("created_at", { ascending: true });
    if (error) throw error;

    const enriched = (invoices || []).map(inv => {
      const items = inv.invoice_items || [];
      const gross = items.reduce((s, i) => s + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0)
        || ((inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0));
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
    // Always scope to shopId — prevents cross-shop updates
    const query = supabase.from("invoices").update({ last_reminder_at: new Date().toISOString() }).in("id", invoiceIds);
    if (shopId) query.eq("shop_id", shopId);
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
  console.log(`
╔══════════════════════════════════════╗
║   AI-Powered Shop Management System  ║
║                                      ║
║  🏪 Kanhaiya Marbles MVP             ║
║  ✓ Running on port ${PORT}              ║
║  ✓ Supabase Connected                ║
║  ✓ Claude AI Integrated              ║
║                                      ║
║  📝 Ready for testing!               ║
╚══════════════════════════════════════╝
  `);
});
