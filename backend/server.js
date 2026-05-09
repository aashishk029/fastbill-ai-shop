const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

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
  res.json({ status: "✓ AI Shop System Running", timestamp: new Date() });
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

    // Separate low stock items
    const lowStock = data.filter((item) => item.is_low_stock);

    res.json({
      totalItems: data.length,
      lowStockCount: lowStock.length,
      inventory: data,
      lowStockItems: lowStock,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate Invoice
app.post("/api/invoices/generate", async (req, res) => {
  try {
    const { shopId, customerName, customerPhone, customerAddress, customerGstin, showGst, gstRate, gstMode, items } = req.body;
    const mode = gstMode || 'included'; // 'included' | 'exclusive'

    // Fetch HSN codes for each design from DB
    const designIds = items.map(i => i.designId).filter(Boolean);
    const { data: designsData } = await supabase
      .from("designs")
      .select("id, hsn_code, default_gst_rate, design_code, design_name")
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
app.post("/api/inventory/scan-purchase", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "No image data provided" });

    const response = await claudeClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are an expert at reading Indian purchase bills and invoices for any type of shop.
              Extract all line items from this purchase bill image.
              For each item find:
              1. Product name or item code (e.g., "Chini 50kg", "WL-001", "Paracetamol 500mg")
              2. Quantity as a number only
              3. Rate or price per unit as a number only (if visible)

              Return ONLY a valid JSON array with no other text:
              [{"designCode": "product name or code", "quantity": 50, "rate": 260}]

              Use null for fields not visible. Return [] if no items found.`
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: imageBase64,
              },
            },
          ],
        },
      ],
    });

    const extractedText = response.content[0].text;
    const items = JSON.parse(extractedText.substring(extractedText.indexOf('['), extractedText.lastIndexOf(']') + 1));
    
    res.json({ items });
  } catch (error) {
    console.error("AI Scan Error:", error);
    res.status(500).json({ error: "AI could not read the bill. Please try again or enter manually." });
  }
});

app.post("/api/inventory/confirm-scan", async (req, res) => {
  try {
    const { shopId, items } = req.body; // items: [{ designId, quantity, rate }]

    for (const item of items) {
      if (!item.designId || !item.quantity) continue;

      // Update inventory (Increment stock)
      await supabase.rpc("increment_inventory", {
        p_design_id: item.designId,
        p_quantity: parseInt(item.quantity),
      });

      // Record as purchase for credit scoring/profit tracking
      await supabase.from("purchases").insert([{
        shop_id: shopId,
        design_id: item.designId,
        quantity_boxes: parseInt(item.quantity),
        cost_per_box: parseFloat(item.rate) || 0,
        purchase_date: new Date().toISOString(),
      }]);
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

    const message = await claudeClient.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageBase64,
            },
          },
          {
            type: "text",
            text: `You are a product identification assistant for a ${shopType || "general"} shop in India.
Analyze this product image and return ONLY a JSON object (no markdown, no explanation):
{
  "designName": "product name in English",
  "color": "main color",
  "categoryName": "product category",
  "sizeMm": "size if visible e.g. 24x24",
  "priceEstimate": estimated price per unit in INR as number,
  "description": "1 line description in Hindi"
}`,
          },
        ],
      }],
    });

    const raw = message.content[0].text.trim();
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim());
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
      supabase.from("invoices")
        .select("id, invoice_number, customer_name, invoice_date, created_at, taxable_value, cgst_amount, sgst_amount, gst_rate, invoice_items(quantity_boxes, price_per_box)")
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

    // Gross sales from actual invoice items (shop-filtered via shop_id on invoices)
    const grossSales = invoices.reduce((s, inv) => {
      const invTotal = (inv.invoice_items || []).reduce((t, i) => t + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0);
      return s + invTotal;
    }, 0);

    // GST from actual stored values (null for non-GST invoices → 0)
    const taxableValue = invoices.reduce((s, inv) => s + (inv.taxable_value || 0), 0);
    const cgst = invoices.reduce((s, inv) => s + (inv.cgst_amount || 0), 0);
    const sgst = invoices.reduce((s, inv) => s + (inv.sgst_amount || 0), 0);
    const gstCollected = cgst + sgst;

    const totalPurchaseCost = purchases.reduce((s, p) => s + ((p.quantity_boxes || 0) * (p.cost_per_box || 0)), 0);
    const itcAvailable = 0; // ITC requires purchase GST invoices — not tracked yet
    const netGstPayable = Math.max(0, gstCollected - itcAvailable);

    // Monthly breakdown for GSTR-1
    const monthlyBreakdown = {};
    invoices.forEach(inv => {
      const month = (inv.created_at || inv.invoice_date || "").slice(0, 7);
      if (!month) return;
      if (!monthlyBreakdown[month]) monthlyBreakdown[month] = { invoiceCount: 0, taxableValue: 0, cgst: 0, sgst: 0, grossSales: 0 };
      monthlyBreakdown[month].invoiceCount += 1;
      monthlyBreakdown[month].taxableValue += inv.taxable_value || 0;
      monthlyBreakdown[month].cgst += inv.cgst_amount || 0;
      monthlyBreakdown[month].sgst += inv.sgst_amount || 0;
      const invGross = (inv.invoice_items || []).reduce((t, i) => t + ((i.quantity_boxes || 0) * (i.price_per_box || 0)), 0);
      monthlyBreakdown[month].grossSales += invGross;
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
