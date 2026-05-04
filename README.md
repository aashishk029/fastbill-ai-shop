# 🏪 Kanhaiya Marbles - AI-Powered Shop Management System

An intelligent, universal shop management platform that uses Claude AI to automatically adapt to any business type (tile shop, cycle shop, pharmacy, etc.) with zero manual configuration.

## 🎯 Project Vision

Build a **single application** that works for ANY shop type by using AI to dynamically generate:
- Database schemas
- UI configurations  
- Inventory rules
- Stock alerts
- Business recommendations

Currently piloting with **Kanhaiya Marbles** (Sanjay Kumar Sharma, Siwan) - a tile distribution business.

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│         React Frontend (Port 3000)      │
│  - Dashboard (Inventory Overview)       │
│  - Invoice Creation (Auto Stock Deduct) │
│  - Stock Management (Auto Reorder)      │
│  - Alerts Panel (Claude AI Insights)    │
└──────────────┬──────────────────────────┘
               │ HTTP/REST
┌──────────────▼──────────────────────────┐
│    Express.js Backend (Port 3001)       │
│  - 7 API Endpoints                      │
│  - Supabase PostgreSQL Integration      │
│  - Claude AI Integration                │
└──────────────┬──────────────────────────┘
               │ 
┌──────────────▼──────────────────────────┐
│      Supabase PostgreSQL Database       │
│  - 9 Tables (Shops, Inventory, etc)     │
│  - Real-time Capabilities               │
│  - Generated Columns for Computed Stats │
└─────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│         Claude AI (Anthropic)           │
│  - Schema Generation                    │
│  - Alert Intelligence                   │
│  - Recommendations                      │
└─────────────────────────────────────────┘
```

## 📁 Project Structure

```
fastbill-ai-shop/
├── backend/
│   ├── server.js                 # Express server (6 endpoints)
│   ├── ai-schema-generator.js    # Claude AI schema generation
│   └── database/
│       └── schema.sql             # PostgreSQL schema (9 tables)
├── frontend/
│   ├── src/
│   │   ├── App.js                # Root component
│   │   ├── App.css               # Styling
│   │   ├── index.js              # Entry point
│   │   ├── index.css             # Global styles
│   │   └── components/
│   │       ├── Dashboard.js       # Inventory overview
│   │       ├── InvoiceForm.js     # Create invoices
│   │       ├── StockForm.js       # Add stock
│   │       └── AlertsPanel.js     # AI alerts & insights
│   ├── public/
│   │   └── index.html
│   ├── package.json
│   └── .env                       # API URL config
├── package.json                   # Backend deps
├── .env.example                   # Environment template
└── README.md                      # This file
```

## 🗄️ Database Schema

### Core Tables (9 total)

1. **shops** - Store information about each shop
2. **tile_categories** - Categories of tiles (e.g., 12/18 Wall Tile, 24/24 Vitrified)
3. **designs** - Individual tile designs with codes and colors
4. **inventory** - Current stock levels (with computed `is_low_stock` column)
5. **invoices** - Customer sales transactions
6. **invoice_items** - Line items in each invoice
7. **purchases** - Stock purchases from suppliers
8. **alerts** - System-generated alerts
9. **ai_recommendations** - Claude AI insights

All tables indexed on `shop_id`, `design_id`, and `is_low_stock` for performance.

## 🚀 Quick Start

### Prerequisites

- Node.js 16+
- npm or yarn
- Supabase account (free tier works)
- Anthropic API key (Claude)

### 1. Setup Environment Variables

```bash
cp .env.example .env
```

Edit `.env`:
```
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_KEY=your_service_key
ANTHROPIC_API_KEY=your_claude_api_key
NODE_ENV=development
PORT=3001
FRONTEND_URL=http://localhost:3000
```

### 2. Setup Supabase Database

1. Create a new Supabase project
2. Run the schema from `backend/database/schema.sql` in the SQL editor
3. Copy your project URL and keys to `.env`

### 3. Install Backend Dependencies

```bash
npm install
```

### 4. Install Frontend Dependencies

```bash
cd frontend
npm install
cd ..
```

### 5. Run Backend

```bash
npm start          # Production
npm dev            # Development with auto-reload
```

Backend runs on `http://localhost:3001`

### 6. Run Frontend (in another terminal)

```bash
npm run client
```

Frontend runs on `http://localhost:3000`

## 📡 API Endpoints

### Health Check
```
GET /api/health
Returns: { status: "running", timestamp: "2026-05-04T..." }
```

### Initialize Shop
```
POST /api/shops/init
Body: {
  shopName: "Kanhaiya Marbles",
  ownerName: "Sanjay Kumar Sharma",
  phone: "6202146538",
  address: "Tarwara More, Siwan",
  shopType: "tile_marble"
}
Returns: { id, name, owner_name, ... }
```

### Get Shop Details
```
GET /api/shops/:shopId
Returns: Full shop object with all details
```

### Get Inventory Status
```
GET /api/inventory/status/:shopId
Returns: {
  total_items: 32,
  low_stock_count: 5,
  inventory: [...],
  low_stock_items: [...]
}
```

### Create Invoice (Auto Inventory Update)
```
POST /api/invoices/generate
Body: {
  shopId: "uuid",
  customerName: "John Doe",
  customerPhone: "9876543210",
  items: [
    {
      design_id: "uuid",
      quantity_boxes: 5,
      price_per_box: 260
    }
  ]
}
Returns: { success: true, invoice: {...} }
```

### Add Stock/Purchase
```
POST /api/purchases/add
Body: {
  shopId: "uuid",
  design_id: "uuid",
  quantity_boxes: 10,
  supplier_name: "ABC Tiles",
  cost_per_box: 150
}
Returns: { success: true, purchase: {...} }
```

### Get Alerts & AI Insights
```
GET /api/alerts/:shopId
Returns: {
  low_stock_items: [...],
  ai_insights: "Claude-generated recommendations"
}
```

## 🎨 Frontend Features

### Dashboard
- Total inventory count
- Low stock count with health status
- List of all low-stock items
- Shop information card

### Invoice Creation
- Design selection with availability
- Quantity input
- Automatic price calculation
- Auto inventory deduction on submit
- Invoice summary table

### Stock Management
- Design selection for restocking
- Quantity input
- Supplier tracking
- Cost per box recording
- Current stock summary table

### Alerts Panel
- AI-generated insights and recommendations
- Low stock alerts
- Severity indicators (High, Medium, Low)
- Actionable recommendations

## 🤖 Claude AI Integration

### Dynamic Schema Generation
The `ai-schema-generator.js` module uses Claude to:
- Generate SQL schemas based on shop type
- Create UI configurations dynamically
- Define alert rules automatically
- Generate onboarding questions

### Real-time Insights
The `/api/alerts` endpoint sends inventory data to Claude for:
- Intelligent stock recommendations
- Sales trend analysis
- Pricing suggestions
- Reorder optimization

## 📈 Kanhaiya Marbles Sample Data

### Tile Categories (8 total)
- 12/18 Wall Tile (9 sqft/box, ₹260/box)
- 12/12 Bathroom Floor (8 sqft/box, ₹260/box)
- 16/16 Parking (9 sqft/box, ₹350/box)
- 24/24 Vitrified (16 sqft/box, ₹700/box)
- 24/24 Porcelain/Matt (16 sqft/box, ₹500/box)
- 24/24 Double Charge (16 sqft/box, ₹685/box)
- 24/24 Granite Matt (16 sqft/box, ₹610/box)
- 24/24 Marble/Glossy (16 sqft/box, ₹720/box)

### Design Codes
Each category has 2-4 designs with codes like:
- WL-001 (Wall Tile, Design 1)
- VT-002 (Vitrified Tile, Design 2)
- etc.

### Initial Stock (Estimated)
- Low stock threshold: 30 boxes
- Stock range: 22-55 boxes per design
- Designed to test alert functionality

## 🧪 Testing Checklist

- [ ] Initialize shop with Kanhaiya Marbles data
- [ ] View dashboard with inventory summary
- [ ] Create sample invoice and verify stock deduction
- [ ] Add stock and verify inventory update
- [ ] Check low stock alerts
- [ ] View Claude AI insights
- [ ] Test responsive design on mobile

## 📅 Timeline

### Week 1 (May 4-11) ✅ In Progress
- ✅ Backend API (6 endpoints)
- ✅ Frontend React (4 screens)
- ⏳ Supabase setup and schema creation
- ⏳ Environment configuration
- ⏳ Local testing

### Week 2 (May 11-18) 📋 Pending
- Alpha testing with Sanjay Kumar Sharma (Kanhaiya Marbles)
- Feedback collection
- Bug fixes

### Week 3 (May 18-25) 📋 Pending
- Iterations based on feedback
- Performance optimization
- Second and third shopkeeper testing

### Week 4 (May 25-31) 📋 Pending
- Final polish
- Investor presentation materials
- Deployment readiness

## 🚀 Deployment

### Frontend Deployment (Vercel)
```bash
cd frontend
vercel deploy
```

### Backend Deployment (Render/Heroku)
```bash
# Set environment variables in platform
git push heroku main
```

## 🔗 Key Technologies

- **Frontend**: React 18, Axios, CSS3
- **Backend**: Express.js, Supabase SDK, Anthropic SDK
- **Database**: PostgreSQL (via Supabase)
- **AI**: Claude 3.5 Sonnet
- **Deployment**: Vercel (frontend), Render (backend)

## 💡 Next Steps

1. Create Supabase project and run schema
2. Configure environment variables
3. Install all dependencies
4. Test locally (backend + frontend)
5. Deploy to production
6. Begin Week 2 alpha testing with shopkeepers

## 📞 Contact

**Project Owner**: Aashish K  
**Email**: aashishk029@gmail.com  
**First Pilot Shop**: Kanhaiya Marbles (Sanjay Kumar Sharma, 6202146538)

---

**Status**: MVP Phase (Week 1/4)  
**Last Updated**: May 4, 2026
