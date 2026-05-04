# 🚀 DEPLOYMENT PLAYBOOK - Deploy Right Now

**Status**: Ready to deploy ✅  
**Time Required**: 30 minutes (fully deployed)  
**Difficulty**: Easy (follow steps exactly)

---

## 📋 Phase 1: GitHub Setup (5 minutes)

### Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Create repository: `kanhaiya-marbles-ai`
3. Copy the HTTPS clone URL

### Step 2: Push Code to GitHub

```bash
# Navigate to project
cd "/path/to/fastbill-ai-shop"

# Rename branch to main
git branch -M main

# Add remote (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/kanhaiya-marbles-ai.git

# Create initial commit
git commit -m "Initial commit: AI-powered shop management system MVP

- Backend: 7 API endpoints with Claude AI
- Frontend: React app with 4 screens
- Database: 9 PostgreSQL tables
- Deployment: Ready for Vercel + Render"

# Push to GitHub
git push -u origin main
```

**GitHub URL**: `https://github.com/YOUR_USERNAME/kanhaiya-marbles-ai`

---

## 🎨 Phase 2: Frontend Deployment to Vercel (5 minutes)

### Step 1: Connect to Vercel

1. Go to https://vercel.com
2. Sign up (or Log in)
3. Click "Add New" → "Project"
4. Click "Import Git Repository"
5. Select `kanhaiya-marbles-ai`
6. Click "Import"

### Step 2: Configure Vercel Project

**Root Directory**: `frontend`

**Build & Output Settings**:
- Build Command: `npm run build`
- Output Directory: `build`
- Install Command: `npm install`

**Environment Variables** (Add these):
```
REACT_APP_API_URL=https://kanhaiya-marbles-api.onrender.com/api
```

### Step 3: Deploy

Click "Deploy" and wait 3-5 minutes.

**Result**: Frontend URL like `https://kanhaiya-marbles-ai.vercel.app`

---

## 🔧 Phase 3: Backend Deployment to Render (10 minutes)

### Step 1: Create Render Service

1. Go to https://render.com
2. Sign up (or Log in)
3. Click "New +" → "Web Service"
4. Select "Deploy an existing repository"
5. Choose `kanhaiya-marbles-ai`
6. Click "Connect"

### Step 2: Configure Render Service

**Service Settings**:
- Name: `kanhaiya-marbles-api`
- Environment: `Node`
- Region: Auto
- Branch: `main`
- Build Command: `npm install`
- Start Command: `npm start`
- Plan: Free (for MVP)

**Environment Variables** (Add all of these):
```
SUPABASE_URL=YOUR_SUPABASE_URL
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
SUPABASE_SERVICE_KEY=YOUR_SUPABASE_SERVICE_KEY
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://kanhaiya-marbles-ai.vercel.app
```

### Step 3: Deploy

Click "Create Web Service" and wait 5-10 minutes.

**Result**: Backend URL like `https://kanhaiya-marbles-api.onrender.com`

---

## 🗄️ Phase 4: Supabase Database Setup (5 minutes)

### Step 1: Create Supabase Project

1. Go to https://supabase.com
2. Sign up (or Log in)
3. Create new project
4. Wait for setup (2-3 minutes)
5. Copy these credentials:
   - **SUPABASE_URL**: Project URL
   - **SUPABASE_ANON_KEY**: Anon key
   - **SUPABASE_SERVICE_KEY**: Service key

### Step 2: Run Database Schema

1. Open Supabase SQL Editor
2. Copy all SQL from `backend/database/schema.sql`
3. Paste into SQL editor
4. Click "Run"
5. Wait for tables to create

### Step 3: Update Environment Variables

**On Render Dashboard**:
1. Go to your backend service
2. Settings → Environment
3. Update these variables with real values:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_KEY`
   - `ANTHROPIC_API_KEY` (get from https://console.anthropic.com)
4. Click "Deploy"

---

## ✅ Phase 5: Verification (5 minutes)

### Test Backend API

```bash
curl https://kanhaiya-marbles-api.onrender.com/api/health

# Should return:
# {"status":"running","timestamp":"2026-05-04T..."}
```

### Test Frontend

1. Visit `https://kanhaiya-marbles-ai.vercel.app`
2. Click "Start" button
3. Should see "Kanhaiya Marbles" dashboard
4. Test:
   - Dashboard (should show inventory)
   - Create Invoice (should work)
   - Add Stock (should work)
   - View Alerts (should show Claude AI insights)

### Test Full Flow

1. Initialize shop
2. Create an invoice with some items
3. Check that stock decreased
4. Add stock and verify it increased
5. Check alerts panel for AI insights

---

## 🔗 Deployment URLs (After Complete)

| Service | URL |
|---------|-----|
| **Frontend** | `https://kanhaiya-marbles-ai.vercel.app` |
| **Backend** | `https://kanhaiya-marbles-api.onrender.com` |
| **API Health** | `https://kanhaiya-marbles-api.onrender.com/api/health` |

---

## 📱 Share with Shopkeeper

Once deployed, send Sanjay Kumar Sharma this link:

```
https://kanhaiya-marbles-ai.vercel.app

Username: (auto-load: Kanhaiya Marbles)
```

---

## 🚨 Troubleshooting

### Frontend Won't Load
- **Error**: "Cannot reach API"
- **Fix**: Check `REACT_APP_API_URL` in Vercel environment
- **Verify**: Backend URL is correct and running

### Backend Won't Start
- **Error**: "Cannot connect to Supabase"
- **Fix**: Verify credentials in Render environment
- **Check**: SUPABASE_URL, keys are correct

### Database Operations Fail
- **Error**: "relation does not exist"
- **Fix**: Run schema.sql in Supabase SQL editor
- **Verify**: All 9 tables created

### Redirect Loop
- **Error**: Keeps redirecting on Vercel
- **Fix**: Check FRONTEND_URL in Render matches Vercel URL
- **Update**: Clear browser cache

---

## ⏱️ Timeline

| Phase | Time | Status |
|-------|------|--------|
| GitHub Setup | 5 min | ⏳ |
| Frontend (Vercel) | 5 min | ⏳ |
| Backend (Render) | 10 min | ⏳ |
| Database (Supabase) | 5 min | ⏳ |
| Testing | 5 min | ⏳ |
| **Total** | **30 min** | ⏳ |

---

## 🎯 After Deployment

1. **Share URLs** with Sanjay Kumar Sharma
2. **Monitor logs** (check for errors)
3. **Collect feedback** on UX/features
4. **Plan Week 2** improvements based on feedback

---

## 📞 Support

- **Docs**: Check README.md for detailed API documentation
- **Issues**: Check Render/Vercel logs for error details
- **Contact**: aashishk029@gmail.com

---

## ✨ You're Deployed! 🎉

Once all phases complete, your AI shop management system will be:
- ✅ Accessible to anyone with the URL
- ✅ Connected to real Supabase database
- ✅ Running Claude AI for alerts
- ✅ Ready for shopkeeper testing

**Next Step**: Share with Sanjay Kumar Sharma for Week 2 Alpha Testing

---

**Deployment Checklist**:
- [ ] GitHub repo created & code pushed
- [ ] Vercel deployed (frontend working)
- [ ] Render deployed (backend working)
- [ ] Supabase project created & schema executed
- [ ] Environment variables added to both services
- [ ] Health check verified
- [ ] Full flow tested in browser
- [ ] URLs shared with shopkeeper

---

**Status**: Ready to deploy immediately ✅  
**Estimated completion**: 30 minutes from now  
**Difficulty**: Easy (follow steps exactly)
