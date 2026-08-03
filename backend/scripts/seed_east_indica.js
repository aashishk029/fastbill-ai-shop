// Seed the East Indica Tea online store into FastBill:
//   - one shop
//   - 22 designs (one per website SKU, design_code = EIT_<sku>)
//   - 22 inventory rows for that shop (initial stock)
//
// Idempotent: safe to re-run. Designs upsert on design_code; inventory upsert on
// (shop_id, design_id). Existing stock is NOT reset on re-run.
//
// Usage:  node scripts/seed_east_indica.js
// Reads SUPABASE_URL + SUPABASE_ANON_KEY/SUPABASE_KEY from env (.env).
//
// Prints the shop id — put it in the website's EIT_SHOP_ID env var.

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY. Set them in .env first.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const HSN = "0902";       // tea
const GST = 5;            // packaged tea = 5% GST
const INITIAL_STOCK = 100; // per variant; owner adjusts later in the app

// [sku, productName, sizeLabel, price]
const VARIANTS = [
  ["plainctc_200", "Pehli — The First Chai", "200g", 139],
  ["plainctc_500", "Pehli — The First Chai", "500g", 299],
  ["plainctc_1000", "Pehli — The First Chai", "1kg", 549],
  ["elaichi_200", "Mehfil — Elaichi Chai", "200g", 179],
  ["elaichi_500", "Mehfil — Elaichi Chai", "500g", 399],
  ["elaichi_1000", "Mehfil — Elaichi Chai", "1kg", 739],
  ["ginger_200", "Kadak — Adrak Chai", "200g", 159],
  ["ginger_500", "Kadak — Adrak Chai", "500g", 349],
  ["ginger_1000", "Kadak — Adrak Chai", "1kg", 649],
  ["masala_200", "Jashn — Masala Chai", "200g", 199],
  ["masala_500", "Jashn — Masala Chai", "500g", 449],
  ["masala_1000", "Jashn — Masala Chai", "1kg", 829],
  ["assam_100", "First Light — Assam Leaf", "100g", 299],
  ["assam_250", "First Light — Assam Leaf", "250g", 599],
  ["darjeeling_100", "The Whistling Hills — Darjeeling Leaf", "100g", 349],
  ["darjeeling_250", "The Whistling Hills — Darjeeling Leaf", "250g", 699],
  ["nilgiri_100", "Once In Blue — Nilgiri Leaf", "100g", 299],
  ["nilgiri_250", "Once In Blue — Nilgiri Leaf", "250g", 599],
  ["greentea_100", "Still Morning — Assam Green Leaf", "100g", 699],
  ["greentea_250", "Still Morning — Assam Green Leaf", "250g", 1349],
  ["passport", "Chai Passport — Discovery Box", "4 × 25g", 499],
  ["milan", "Milan Pack", "2 × 25g", 199],
];

async function main() {
  // 1) Shop — find existing by name, else create.
  const SHOP_NAME = "East Indica Tea";
  let shopId;
  const { data: existingShop } = await supabase
    .from("shops").select("id").eq("name", SHOP_NAME).maybeSingle();
  if (existingShop) {
    shopId = existingShop.id;
    console.log(`Shop exists: ${shopId}`);
  } else {
    const { data, error } = await supabase.from("shops").insert([{
      name: SHOP_NAME,
      owner_name: "Aashish",
      phone: "0000000000",
      address: "Online store — eastindicatea.com",
      shop_type: "tea",
    }]).select().single();
    if (error) throw error;
    shopId = data.id;
    console.log(`Shop created: ${shopId}`);
  }

  // 2) Designs — upsert by unique design_code.
  const designRows = VARIANTS.map(([sku, name, size, price]) => ({
    design_code: `EIT_${sku}`,
    design_name: `${name} (${size})`,
    hsn_code: HSN,
    default_gst_rate: GST,
    unit_type: "pack",
    is_active: true,
  }));
  // Some deployments lack hsn/gst/unit columns until a migration runs — retry lean if so.
  let designs;
  {
    let { data, error } = await supabase.from("designs")
      .upsert(designRows, { onConflict: "design_code" }).select("id, design_code");
    if (error && /column|schema cache/i.test(error.message || "")) {
      const lean = VARIANTS.map(([sku, name, size]) => ({
        design_code: `EIT_${sku}`, design_name: `${name} (${size})`, is_active: true,
      }));
      ({ data, error } = await supabase.from("designs")
        .upsert(lean, { onConflict: "design_code" }).select("id, design_code"));
    }
    if (error) throw error;
    designs = data;
  }
  const codeToId = {};
  designs.forEach(d => { codeToId[d.design_code] = d.id; });
  console.log(`Designs upserted: ${designs.length}`);

  // 3) Inventory — one row per design for THIS shop. Don't clobber existing stock.
  const { data: haveInv } = await supabase
    .from("inventory").select("design_id").eq("shop_id", shopId);
  const haveSet = new Set((haveInv || []).map(r => r.design_id));
  const toInsert = VARIANTS
    .map(([sku]) => codeToId[`EIT_${sku}`])
    .filter(id => id && !haveSet.has(id))
    .map(design_id => ({ shop_id: shopId, design_id, quantity_boxes: INITIAL_STOCK }));
  if (toInsert.length) {
    const { error } = await supabase.from("inventory").insert(toInsert);
    if (error) throw error;
  }
  console.log(`Inventory rows added: ${toInsert.length} (skipped ${haveSet.size} existing)`);

  console.log("\n==============================================");
  console.log("DONE. Set this in the website env:");
  console.log(`  EIT_SHOP_ID=${shopId}`);
  console.log("==============================================");
}

main().catch(e => { console.error("SEED FAILED:", e.message); process.exit(1); });
