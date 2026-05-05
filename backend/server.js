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
    const { shopName, ownerName, phone, address, shopType, pin } = req.body;

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

    const { data: shop, error } = await supabase
      .from("shops")
      .insert([{ name: shopName, owner_name: ownerName, phone, address, shop_type: shopType, pin_hash }])
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
        designs(design_code, design_name, color,
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
    const { shopId, customerName, items } = req.body;

    // Calculate totals from items
    const totalBoxes = items.reduce((s, i) => s + (parseInt(i.quantityBoxes) || 0), 0);
    const totalAmount = items.reduce((s, i) => s + ((parseInt(i.quantityBoxes) || 0) * (parseFloat(i.pricePerBox) || 0)), 0);

    // Insert invoice
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .insert([{
        shop_id: shopId,
        invoice_number: `INV-${Date.now()}`,
        customer_name: customerName,
      }])
      .select();

    if (invoiceError) throw invoiceError;

    // Insert items and update inventory
    for (const item of items) {
      await supabase.from("invoice_items").insert([{
        invoice_id: invoice[0].id,
        design_id: item.designId,
        quantity_boxes: item.quantityBoxes,
        price_per_box: item.pricePerBox,
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
        totalAmount,
        items: items.map(i => ({
          designId: i.designId,
          quantityBoxes: i.quantityBoxes,
          pricePerBox: i.pricePerBox,
          lineTotal: (parseInt(i.quantityBoxes) || 0) * (parseFloat(i.pricePerBox) || 0),
        })),
      },
    });
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
      model: "claude-sonnet-4-6",
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
      model: "claude-sonnet-4-6",
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
    const { shopId, designCode, designName, color, categoryName, sizeMm, coverageSqft, pricePerBox, initialQuantity } = req.body;

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
      model: "claude-sonnet-4-6",
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
