const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

/**
 * AI-Powered Schema Generator
 * Takes shop details and generates customized database schema
 */

async function generateShopSchema(shopDetails) {
  const prompt = `
You are a database architect. Based on the following shop details, generate a database schema.

SHOP DETAILS:
- Type: ${shopDetails.shopType}
- Name: ${shopDetails.shopName}
- Products: ${JSON.stringify(shopDetails.products)}
- Low Stock Threshold: ${shopDetails.lowStockThreshold || "Not specified"}

INSTRUCTIONS:
1. Generate Supabase SQL schema
2. Include tables for: products, variants, stock, invoices, customers, transactions
3. Include intelligent columns based on shop type
4. Make it scalable and simple

RESPONSE FORMAT:
Provide ONLY valid SQL code that can be executed directly in Supabase, no explanations.

ADDITIONAL REQUIREMENTS:
- Add created_at, updated_at timestamps
- Add is_active boolean fields
- Design for multi-variant products (like tiles with colors/sizes)
- Include alert thresholds
`;

  const response = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return response.content[0].text;
}

/**
 * Generate UI Configuration
 * Based on shop type and products, generate UI field configurations
 */

async function generateUIConfig(shopDetails) {
  const prompt = `
You are a UI/UX architect. Based on shop details, generate a JSON configuration for dynamic UI.

SHOP DETAILS:
- Type: ${shopDetails.shopType}
- Products: ${JSON.stringify(shopDetails.products)}

Generate a JSON configuration with:
1. Dashboard widgets
2. Form fields for product entry
3. Stock tracking display fields
4. Invoice fields
5. Alert configurations

Response ONLY valid JSON, no explanations.

Example structure:
{
  "dashboard": {
    "widgets": [...]
  },
  "productForm": {
    "fields": [...]
  }
}
`;

  const response = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return JSON.parse(response.content[0].text);
}

/**
 * Generate Alert Rules
 * Based on product types, create smart alert configurations
 */

async function generateAlertRules(shopDetails) {
  const prompt = `
You are an inventory management expert. Generate alert rules for this shop.

SHOP TYPE: ${shopDetails.shopType}
PRODUCTS: ${JSON.stringify(shopDetails.products)}

Generate alert rules JSON with:
1. Low stock alerts (thresholds)
2. Expiry alerts (for perishables)
3. Fast-moving product alerts
4. Reorder recommendations
5. Seasonal alerts

Response ONLY valid JSON.
`;

  const response = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1200,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return JSON.parse(response.content[0].text);
}

/**
 * Generate Onboarding Questions
 * Based on shop type, generate contextual onboarding questions
 */

async function generateOnboardingQuestions(shopType) {
  const prompt = `
Generate 5-7 onboarding questions for a ${shopType} shop owner.
Questions should help understand:
1. Current inventory level
2. Product categories
3. Pricing structure
4. Stock thresholds
5. Business model (wholesale/retail/both)

Response as JSON array of questions with field types (text, number, select, etc).
`;

  const response = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 800,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return JSON.parse(response.content[0].text);
}

module.exports = {
  generateShopSchema,
  generateUIConfig,
  generateAlertRules,
  generateOnboardingQuestions,
};
