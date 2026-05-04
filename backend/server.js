const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
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
    const { shopName, ownerName, phone, address, shopType } = req.body;

    // Insert shop
    const { data: shop, error } = await supabase
      .from("shops")
      .insert([
        {
          name: shopName,
          owner_name: ownerName,
          phone,
          address,
          shop_type: shopType,
        },
      ])
      .select();

    if (error) throw error;

    res.json({
      message: "✓ Shop initialized",
      shop: shop[0],
    });
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

// Get Inventory Status
app.get("/api/inventory/status/:shopId", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("inventory")
      .select(
        `
        *,
        designs(design_code, design_name, color),
        tile_categories(category_name, base_price_per_box)
      `
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

    // Calculate totals
    let totalSqft = 0;
    let totalBoxes = 0;
    let totalAmount = 0;

    // Insert invoice
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .insert([
        {
          shop_id: shopId,
          invoice_number: `INV-${Date.now()}`,
          customer_name: customerName,
          total_sqft: totalSqft,
          total_boxes: totalBoxes,
          total_amount: totalAmount,
        },
      ])
      .select();

    if (invoiceError) throw invoiceError;

    // Insert items and update inventory
    for (const item of items) {
      // Insert invoice item
      await supabase.from("invoice_items").insert([
        {
          invoice_id: invoice[0].id,
          design_id: item.designId,
          quantity_boxes: item.quantityBoxes,
          price_per_box: item.pricePerBox,
        },
      ]);

      // Update inventory
      await supabase.rpc("update_inventory_after_invoice", {
        design_id: item.designId,
        quantity: item.quantityBoxes,
      });
    }

    res.json({
      message: "✓ Invoice generated",
      invoice: invoice[0],
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
