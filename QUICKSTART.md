# ⚡ Quick Start Guide

Get the AI-powered shop management system running in 5 minutes.

## 🚀 Before You Start

You need:
- Node.js 16+ installed
- Supabase account (free: supabase.com)
- Anthropic API key (free: console.anthropic.com)

## 📋 Step 1: Setup (2 minutes)

```bash
# 1. Navigate to project directory
cd fastbill-ai-shop

# 2. Run setup script
bash setup.sh

# 3. The script will ask you to configure .env
# Open .env in your editor and add your credentials:
# - SUPABASE_URL
# - SUPABASE_ANON_KEY
# - SUPABASE_SERVICE_KEY
# - ANTHROPIC_API_KEY
```

## 🗄️ Step 2: Database (1 minute)

1. Go to https://supabase.com and create a new project
2. Copy your project URL and keys
3. In Supabase, go to SQL editor
4. Copy all SQL from `backend/database/schema.sql`
5. Paste and run it in Supabase SQL editor
6. Copy the URL and keys into `.env`

## 🚀 Step 3: Start (2 minutes)

### Terminal 1 - Backend
```bash
npm dev
# Backend runs on http://localhost:3001
```

### Terminal 2 - Frontend
```bash
npm run client
# Frontend runs on http://localhost:3000
```

## ✅ Step 4: Test

1. Open http://localhost:3000 in browser
2. Click "Start" to initialize shop
3. You'll see "Kanhaiya Marbles" dashboard
4. Try:
   - Creating an invoice
   - Adding stock
   - Viewing alerts

## 🎉 Done!

Your AI-powered shop system is running locally.

---

## 📱 Testing Shortcuts

### Quick Invoice
- Customer: "Test Customer"
- Design: Any tile design
- Quantity: 5 boxes
- Click "Create Invoice"
- Stock should auto-decrease

### Check Alerts
- Click "Alerts" button
- See Claude AI recommendations
- Low stock items highlighted

### Add Stock
- Click "Add Stock"
- Select a design
- Enter quantity: 10
- Click "Add Stock"
- Check inventory increased

---

## 🚨 Troubleshooting

**Port 3001 already in use:**
```bash
# Change PORT in .env or kill process on that port
lsof -ti:3001 | xargs kill -9
```

**Cannot connect to Supabase:**
- Verify credentials in .env
- Check Supabase project is active
- Run schema.sql in SQL editor

**Frontend can't reach backend:**
- Check frontend/.env has correct API URL
- Backend must be running on 3001

**npm: command not found:**
- Install Node.js from nodejs.org

---

## 📚 Next Steps

1. **Customize data**: Edit sample inventory in `backend/server.js`
2. **Deploy**: Follow `DEPLOYMENT.md` for production setup
3. **Add features**: Extend with your own endpoints
4. **Share with shopkeeper**: Deploy and test with real user

---

## 📞 Need Help?

Check these docs:
- `README.md` - Full documentation
- `DEPLOYMENT.md` - Deployment guide
- `DEVELOPMENT_SUMMARY.md` - What's been built

---

**Happy coding! 🎉**
