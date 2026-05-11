const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const { createWorker } = require("tesseract.js");

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Claude
const claudeClient = new Anthropic();

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

// Health Check
app.get("/api/health", (req, res) => {
  res.json({
    status: "✓ AI Shop System Running",
    timestamp: new Date(),
    gemini: !!process.env.GEMINI_API_KEY,
    hf: !!process.env.HF_TOKEN,
  });
});

// Initialize Shop
app.post("/api/shops/init", async (req, res) => {
  try {
    const { shopName, ownerName, phone, address, shopType, pin, gstin, pan } = req.body;

    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: "4 digit PIN zaroori hai" });
    }

    // Check phone not already registered
    const { data: existing } = await supabase
      .from("shops").select("id").eq("phone", phone).single();
    if (existing) {
      return res.status(409).json({ error: "Ye phone number pehle se registered hai. Login karo." });
    }

    const pin_hash = await bcrypt.hash(pin, 10);

    // Generate unique display ID: FB-YYYY-XXXXX
    const { count } = await supabase.from("shops").select("*", { count: "exact", head: true });
    const shopIdDisplay = `FB-${new Date().getFullYear()}-${String((count || 0) + 1).padStart(5, "0")}`;

    const { data: shop, error } = await supabase
      .from("shops")
      .insert([{
        name: shopName, owner_name: ownerName, phone, address,
        shop_type: shopType, pin_hash,
        gstin: gstin?.toUpperCase() || null,
        pan_number: pan?.toUpperCase() || null,
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

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login by phone + PIN
app.post("/api/shops/login", async (req, res) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).json({ error: "Phone aur PIN dono chahiye" });

    const { data, error } = await supabase
      .from("shops")
      .select("*")
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Koi shop nahi mila is number pe" });
    }

    // Old shops (no PIN set) — allow login without PIN for migration
    if (!data.pin_hash) {
      return res.json({ found: true, shop: data, warning: "PIN set nahi hai, please update karo" });
    }

    const valid = await bcrypt.compare(pin, data.pin_hash);
    if (!valid) {
      return res.status(401).json({ error: "Galat PIN. Dobara try karo." });
    }

    // Don't send pin_hash to client
    const { pin_hash, ...shopSafe } = data;
    res.json({ found: true, shop: shopSafe });
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
        designs(design_code, design_name, color, hsn_code, default_gst_rate,
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
app.post("/api/invoices/generate", async (req, res) => {
  try {
    const { shopId, customerName, customerPhone, customerAddress, customerGstin, showGst, gstRate, gstMode, items, paymentStatus } = req.body;
    const mode = gstMode || 'included'; // 'included' | 'exclusive'

    // Fetch HSN codes for each design from DB
    const designIds = items.map(i => i.designId).filter(Boolean);
    const { data: designsData } = await supabase
      .from("designs")
      .select("id, hsn_code, default_gst_rate, design_code, design_name, unit_type")
      .in("id", designIds);
    const designMap = {};
    (designsData || []).forEach(d => { designMap[d.id] = d; });

    const totalBoxes = items.reduce((s, i) => s + (parseInt(i.quantityBoxes) || 0), 0);
    const itemsTotal = items.reduce((s, i) => s + ((parseInt(i.quantityBoxes) || 0) * (parseFloat(i.pricePerBox) || 0)), 0);

    // Per-item GST calculation — each product uses its own GST rate from designs table
    const isGstInvoice = (showGst === true || showGst === 'true');

    const itemCalcs = items.map(i => {
      const design = designMap[i.designId] || {};
      const lineTotal = (parseInt(i.quantityBoxes) || 0) * (parseFloat(i.pricePerBox) || 0);
      const itemRate = parseFloat(i.gstRate || design.default_gst_rate || 0);
      const applyGst = isGstInvoice && itemRate > 0;
      const itemTaxable = applyGst && mode === 'included' ? lineTotal / (1 + itemRate / 100) : lineTotal;
      const itemGst = applyGst ? (mode === 'included' ? lineTotal - itemTaxable : lineTotal * itemRate / 100) : 0;
      return { lineTotal, itemTaxable, itemGst };
    });

    const taxableValue = itemCalcs.reduce((s, i) => s + i.itemTaxable, 0);
    const gstAmount = itemCalcs.reduce((s, i) => s + i.itemGst, 0);
    const grossAmount = itemCalcs.reduce((s, i) => s + i.lineTotal, 0);
    const finalGrossAmount = mode === 'exclusive' && isGstInvoice ? grossAmount + gstAmount : grossAmount;
    const cgst = gstAmount / 2;
    const sgst = gstAmount / 2;
    const invoiceType = (customerGstin && customerGstin.length === 15) ? 'B2B' : 'B2C';

    // Insert invoice
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .insert([{
        shop_id: shopId,
        invoice_number: `INV-${Date.now()}`,
        customer_name: customerName,
        customer_phone: customerPhone || null,
        customer_address: customerAddress || null,
        customer_gstin: customerGstin?.toUpperCase() || null,
        invoice_type: invoiceType,
        taxable_value: isGstInvoice ? Math.round(taxableValue * 100) / 100 : null,
        cgst_amount: isGstInvoice ? Math.round(cgst * 100) / 100 : null,
        sgst_amount: isGstInvoice ? Math.round(sgst * 100) / 100 : null,
        gst_rate: null, // mixed per-item rates — see invoice_items
        is_gst_invoice: isGstInvoice,
        payment_status: paymentStatus || 'paid',
        amount_paid: (paymentStatus === 'credit') ? 0 : null,
        table_number: req.body.tableNumber || null,
      }])
      .select();

    if (invoiceError) throw invoiceError;

    // Insert items with HSN code, update inventory
    for (const item of items) {
      const design = designMap[item.designId] || {};
      const itemHsn = item.hsnCode || design.hsn_code || null;
      const itemGstRate = item.gstRate || design.default_gst_rate || null;

      await supabase.from("invoice_items").insert([{
        invoice_id: invoice[0].id,
        design_id: item.designId,
        quantity_boxes: item.quantityBoxes,
        price_per_box: item.pricePerBox,
        hsn_code: itemHsn,
        gst_rate: itemGstRate,
      }]);

      await supabase.rpc("update_inventory_after_invoice", {
        design_id: item.designId,
        quantity: item.quantityBoxes,
      });
    }

    res.json({
      message: "✓ Invoice generated",
      invoice: {
        ...invoice[0],
        totalBoxes,
        itemsTotal: Math.round(itemsTotal),
        grossAmount: Math.round(finalGrossAmount),
        finalTotal: Math.round(finalGrossAmount),
        taxableValue: Math.round(taxableValue),
        cgst: Math.round(cgst * 100) / 100,
        sgst: Math.round(sgst * 100) / 100,
        gstAmount: Math.round(gstAmount * 100) / 100,
        isGstInvoice,
        gstRate: null,
        gstMode: mode,
        items: items.map(i => {
          const design = designMap[i.designId] || {};
          const lineTotal = (parseInt(i.quantityBoxes) || 0) * (parseFloat(i.pricePerBox) || 0);
          const itemRate = parseFloat(i.gstRate || design.default_gst_rate || rate || 0);
          const itemIsGst = isGstInvoice && itemRate > 0;
          const itemTaxable = itemIsGst && mode === 'included' ? lineTotal / (1 + itemRate / 100) : lineTotal;
          const itemGst = itemIsGst ? (mode === 'included' ? lineTotal - itemTaxable : lineTotal * itemRate / 100) : 0;
          const itemTotal = mode === 'exclusive' && itemIsGst ? lineTotal + itemGst : lineTotal;
          return {
            designId: i.designId,
            designCode: design.design_code || null,
            designName: design.design_name || null,
            quantityBoxes: i.quantityBoxes,
            pricePerBox: i.pricePerBox,
            hsnCode: i.hsnCode || design.hsn_code || null,
            gstRate: itemRate,
            lineTotal: Math.round(lineTotal * 100) / 100,
            taxableValue: Math.round(itemTaxable * 100) / 100,
            cgstAmount: Math.round(itemGst / 2 * 100) / 100,
            sgstAmount: Math.round(itemGst / 2 * 100) / 100,
            totalWithGst: Math.round(itemTotal * 100) / 100,
          };
        }),
      },
    });
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
      const qty = parseInt(item.quantity) || 0;
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

    // Generate alerts using Claude
    const alertsMessage = await claudeClient.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `You are a shop inventory advisor. Based on these low stock items, provide brief, actionable alerts:
          ${JSON.stringify(inventory)}
          
          Provide alerts as JSON array with fields: message, severity (low/medium/high), actionItem`,
        },
      ],
    });

    res.json({
      lowStockItems: inventory,
      aiInsights: alertsMessage.content[0].text,
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
// START SERVER
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

// ============================================
// CREDIT SCORE ENDPOINT (AI-Driven)
// ============================================

app.get("/api/credit-score/:shopId", async (req, res) => {
  try {
    const { shopId } = req.params;

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    // Gather ALL available local data in parallel
    const [shopRes, invoicesRes, inventoryRes, purchasesRes] = await Promise.all([
      supabase.from("shops").select("*").eq("id", shopId).single(),

      supabase.from("invoices")
        .select("invoice_number, customer_name, created_at")
        .eq("shop_id", shopId)
        .gte("created_at", ninetyDaysAgo.toISOString())
        .order("created_at", { ascending: false }),

      supabase.from("inventory")
        .select("quantity_boxes, is_low_stock, last_restocked_at, designs(design_name, design_code, tile_categories(category_name, base_price_per_box))")
        .eq("shop_id", shopId),

      supabase.from("purchases")
        .select("quantity_boxes, supplier_name, cost_per_box, purchase_date")
        .eq("shop_id", shopId)
        .gte("purchase_date", ninetyDaysAgo.toISOString())
        .order("purchase_date", { ascending: false }),
    ]);

    const shop = shopRes.data;
    const invoices = invoicesRes.data || [];
    const inventory = inventoryRes.data || [];
    const purchases = purchasesRes.data || [];

    // Build monthly revenue summary for trend analysis
    const monthlyRevenue = {};
    invoices.forEach(inv => {
      const month = inv.created_at?.slice(0, 7);
      if (month) monthlyRevenue[month] = (monthlyRevenue[month] || 0) + 1;
    });

    // Package all data for Claude
    const shopProfile = {
      name: shop?.name,
      owner: shop?.owner_name,
      address: shop?.address,
      shopType: shop?.shop_type,
      dataAvailable: {
        invoiceCount: invoices.length,
        inventoryItems: inventory.length,
        purchaseOrders: purchases.length,
        dataPeriodDays: 90,
      },
      invoiceSummary: {
        total: invoices.length,
        totalRevenue: invoices.length,
        uniqueCustomers: new Set(invoices.map(i => i.customer_name)).size,
        monthlyRevenueTrend: monthlyRevenue,
        recentInvoices: invoices.slice(0, 5),
      },
      inventorySummary: {
        totalProducts: inventory.length,
        lowStockItems: inventory.filter(i => i.is_low_stock).length,
        totalStockValue: inventory.reduce((s, i) => {
          const price = i.designs?.tile_categories?.base_price_per_box || 0;
          return s + (i.quantity_boxes * price);
        }, 0),
        categories: [...new Set(inventory.map(i => i.tile_categories?.category_name).filter(Boolean))],
      },
      purchaseSummary: {
        totalOrders: purchases.length,
        totalInvested: purchases.reduce((s, p) => s + ((p.cost_per_box || 0) * (p.quantity_boxes || 0)), 0),
        suppliers: [...new Set(purchases.map(p => p.supplier_name).filter(Boolean))],
        recentPurchases: purchases.slice(0, 3),
      },
    };

    // Claude analyzes ALL data and scores intelligently
    const claudeResp = await claudeClient.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `You are a credit scoring AI for Indian SMBs. Analyze this tile shop's business data and generate a credit score.

SHOP DATA (last 90 days):
${JSON.stringify(shopProfile, null, 2)}

INSTRUCTIONS:
- Score 300-900 (like CIBIL). Only use data that is actually available. If data is missing, note it but don't penalize heavily.
- Consider: sales activity, revenue consistency/trend, inventory management, purchase regularity, business scale.
- Return ONLY valid JSON (no extra text):

{
  "score": <number 300-900>,
  "rating": "<Excellent|Good|Fair|Poor>",
  "scoreBreakdown": {
    "salesActivity": "<Strong|Good|Fair|Weak> - <one line reason>",
    "revenueHealth": "<Strong|Good|Fair|Weak> - <one line reason>",
    "inventoryManagement": "<Strong|Good|Fair|Weak> - <one line reason>",
    "purchaseConsistency": "<Strong|Good|Fair|Weak> - <one line reason>"
  },
  "dataQuality": "<how much data was available to score - one line>",
  "adviceHindi": "<2-3 simple Hindi lines: score ka matlab aur improvement tips>"
}`
      }]
    });

    // Parse Claude's structured response
    let aiResult;
    try {
      const rawText = claudeResp.content[0].text;
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      aiResult = JSON.parse(jsonMatch[0]);
    } catch {
      aiResult = {
        score: 500,
        rating: "Fair",
        scoreBreakdown: {},
        dataQuality: "Partial data available",
        adviceHindi: "Score calculate karne mein thodi takleef hui. Dobara try karein."
      };
    }

    res.json({
      score: aiResult.score,
      rating: aiResult.rating,
      scoreBreakdown: aiResult.scoreBreakdown,
      dataQuality: aiResult.dataQuality,
      adviceHindi: aiResult.adviceHindi,
      rawStats: {
        invoicesLast90Days: invoices.length,
        totalRevenue90Days: shopProfile.invoiceSummary.totalRevenue,
        inventoryItems: inventory.length,
        lowStockItems: shopProfile.inventorySummary.lowStockItems,
        purchaseOrders90Days: purchases.length,
        uniqueCustomers: shopProfile.invoiceSummary.uniqueCustomers,
      }
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
          quantity_boxes: parseInt(quantity_boxes),
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
      .single();

    if (currentInventory) {
      const newQuantity = currentInventory.quantity_boxes + parseInt(quantity_boxes);
      const { error: updateError } = await supabase
        .from("inventory")
        .update({
          quantity_boxes: newQuantity,
          last_restocked_at: new Date().toISOString(),
        })
        .eq("design_id", design_id)
        .eq("shop_id", shopId);

      if (updateError) throw updateError;
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
        quantity_boxes: parseInt(initialQuantity) || 0,
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

    const [invoicesRes, purchasesRes, shopRes] = await Promise.allSettled([
      // No invoice_items join — use pre-stored aggregated values (O(n) not O(n*m))
      supabase.from("invoices")
        .select("id, invoice_number, customer_name, customer_gstin, invoice_type, invoice_date, created_at, taxable_value, cgst_amount, sgst_amount, gst_rate")
        .eq("shop_id", shopId)
        .gte("created_at", fyStart)
        .lte("created_at", fyEnd)
        .order("created_at", { ascending: true }),

      supabase.from("purchases")
        .select("quantity_boxes, cost_per_box, purchase_date, supplier_name")
        .eq("shop_id", shopId)
        .gte("purchase_date", fyStart)
        .lte("purchase_date", fyEnd),

      supabase.from("shops").select("*").eq("id", shopId).single(),
    ]);

    const invoices = invoicesRes.status === "fulfilled" ? invoicesRes.value.data || [] : [];
    const purchases = purchasesRes.status === "fulfilled" ? purchasesRes.value.data || [] : [];
    const shop = shopRes.status === "fulfilled" ? shopRes.value.data : {};

    // Gross sales from stored taxable_value + gst (GST invoices only — non-GST invoices have null values)
    const grossSales = invoices.reduce((s, inv) => {
      const invGross = (inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0);
      return s + invGross;
    }, 0);

    // GST from actual stored values (null for non-GST invoices → 0)
    const taxableValue = invoices.reduce((s, inv) => s + (inv.taxable_value || 0), 0);
    const cgst = invoices.reduce((s, inv) => s + (inv.cgst_amount || 0), 0);
    const sgst = invoices.reduce((s, inv) => s + (inv.sgst_amount || 0), 0);
    const gstCollected = cgst + sgst;

    const totalPurchaseCost = purchases.reduce((s, p) => s + ((p.quantity_boxes || 0) * (p.cost_per_box || 0)), 0);
    const itcAvailable = 0; // ITC requires purchase GST invoices — not tracked yet
    const netGstPayable = Math.max(0, gstCollected - itcAvailable);

    // B2B vs B2C split (for GSTR-1 filing)
    const b2bInvoices = invoices.filter(inv => inv.invoice_type === 'B2B' || inv.customer_gstin);
    const b2bTaxable = b2bInvoices.reduce((s, inv) => s + (inv.taxable_value || 0), 0);
    const b2bGst = b2bInvoices.reduce((s, inv) => s + (inv.cgst_amount || 0) + (inv.sgst_amount || 0), 0);

    // Monthly breakdown for GSTR-1 — O(n) using stored values only
    const monthlyBreakdown = {};
    invoices.forEach(inv => {
      const month = (inv.created_at || inv.invoice_date || "").slice(0, 7);
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

    // P&L for ITR
    const netProfit = taxableValue - totalPurchaseCost;

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
        grossIncome: Math.round(grossSales),
        taxableIncome: Math.round(taxableValue),
        purchaseExpenses: Math.round(totalPurchaseCost),
        grossProfit: Math.round(netProfit),
        presumptiveTaxableIncome: Math.round(taxableValue * 0.08), // 8% of turnover under ITR-4 44AD
      },
      itrNote: "ITR-4 (44AD): Agar turnover ₹3Cr se kam hai to 8% ko taxable income maan sakte ho.",
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
        .select("id, invoice_number, customer_name, customer_phone, created_at, payment_status, amount_paid, taxable_value, cgst_amount, sgst_amount, invoice_items(quantity_boxes, price_per_box)")
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
      const gross = items.reduce((s, i) => s + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0)
        || ((inv.taxable_value || 0) + (inv.cgst_amount || 0) + (inv.sgst_amount || 0));
      const outstanding = Math.round(gross - (inv.amount_paid || 0));
      return { ...inv, grossAmount: Math.round(gross), outstanding };
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
    const { status, amountPaid } = req.body; // status: 'paid'|'partial'|'credit'
    const { error } = await supabase.from("invoices")
      .update({ payment_status: status, amount_paid: amountPaid || 0 })
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Adjust inventory quantity (edit correction)
app.patch("/api/inventory/adjust", async (req, res) => {
  try {
    const { shopId, designId, inventoryId, newQuantity } = req.body;
    if (newQuantity === undefined) return res.status(400).json({ error: "newQuantity required" });
    const qty = parseInt(newQuantity);
    if (isNaN(qty) || qty < 0) return res.status(400).json({ error: "Invalid quantity" });

    let query = supabase.from("inventory").update({ quantity_boxes: qty });
    if (inventoryId) {
      query = query.eq("id", inventoryId);
    } else if (shopId && designId) {
      query = query.eq("shop_id", shopId).eq("design_id", designId);
    } else {
      return res.status(400).json({ error: "inventoryId or (shopId + designId) required" });
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
    const { status, amountPaid } = req.body;
    const { error } = await supabase.from("purchases")
      .update({ payment_status: status, amount_paid: amountPaid || 0 })
      .eq("id", req.params.id);
    if (error) throw error;
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
      .order("created_at", { ascending: false })
      .limit(100);

    if (customer) query = query.ilike("customer_name", `%${customer}%`);
    if (month) {
      query = query
        .gte("created_at", `${month}-01T00:00:00`)
        .lte("created_at", `${month}-31T23:59:59`);
    }
    if (date) {
      query = query
        .gte("created_at", `${date}T00:00:00`)
        .lte("created_at", `${date}T23:59:59`);
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

    // Fetch invoice items to restore inventory
    const { data: items, error: itemsErr } = await supabase
      .from("invoice_items")
      .select("design_id, quantity_boxes")
      .eq("invoice_id", id);
    if (itemsErr) throw itemsErr;

    // Restore inventory for each item
    for (const item of (items || [])) {
      const { data: inv } = await supabase
        .from("inventory")
        .select("id, quantity_boxes")
        .eq("design_id", item.design_id)
        .single();
      if (inv) {
        await supabase.from("inventory")
          .update({ quantity_boxes: (inv.quantity_boxes || 0) + item.quantity_boxes })
          .eq("id", inv.id);
      }
    }

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
    const { returnItems, reason } = req.body;
    // returnItems: [{ designId, quantityBoxes }]

    if (!returnItems || returnItems.length === 0) {
      return res.status(400).json({ error: "returnItems required" });
    }

    // Restore inventory for returned items
    for (const item of returnItems) {
      const { data: inv } = await supabase
        .from("inventory")
        .select("id, quantity_boxes")
        .eq("design_id", item.designId)
        .single();
      if (inv) {
        await supabase.from("inventory")
          .update({ quantity_boxes: (inv.quantity_boxes || 0) + item.quantityBoxes })
          .eq("id", inv.id);
      }
    }

    // Fetch invoice to check if fully returned
    const { data: allItems } = await supabase
      .from("invoice_items")
      .select("design_id, quantity_boxes")
      .eq("invoice_id", id);

    const totalQty = (allItems || []).reduce((s, i) => s + i.quantity_boxes, 0);
    const returnQty = returnItems.reduce((s, i) => s + i.quantityBoxes, 0);
    const newStatus = returnQty >= totalQty ? "returned" : "partial_return";

    await supabase.from("invoices")
      .update({ payment_status: newStatus, return_note: reason || "Customer return" })
      .eq("id", id);

    res.json({ success: true, returnStatus: newStatus, itemsRestored: returnItems.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
