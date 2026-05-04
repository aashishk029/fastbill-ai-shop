# 🚀 Deployment Guide - Kanhaiya Marbles AI Shop Management System

This guide covers deploying the AI-powered shop management system to production.

## 🏢 Deployment Architecture

```
Client Browser
    ↓
Vercel (Frontend - React)
    ↓ HTTPS
Render/Railway (Backend - Express)
    ↓
Supabase PostgreSQL (Database)
    ↓
Anthropic Claude API (AI Services)
```

## 📋 Prerequisites

- GitHub account (for version control)
- Vercel account (for frontend deployment)
- Render or Railway account (for backend)
- Supabase project (already set up locally)
- Anthropic API key

## 📦 Phase 1: Prepare for Deployment

### 1. Initialize Git Repository

```bash
cd /path/to/fastbill-ai-shop
git init
git add .
git commit -m "Initial commit: AI-powered shop management system"
```

### 2. Create GitHub Repository

1. Go to https://github.com/new
2. Create repository: `kanhaiya-marbles-ai`
3. Push local code:

```bash
git remote add origin https://github.com/YOUR_USERNAME/kanhaiya-marbles-ai.git
git branch -M main
git push -u origin main
```

### 3. Verify Environment Variables

Ensure all `.env` variables are ready:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`
- `ANTHROPIC_API_KEY`

**⚠️ NEVER commit .env to GitHub**

## 🎨 Phase 2: Deploy Frontend (Vercel)

### Step 1: Connect GitHub to Vercel

1. Go to https://vercel.com
2. Click "Import Project"
3. Select "Import Git Repository"
4. Choose your `kanhaiya-marbles-ai` repository
5. Click Import

### Step 2: Configure Vercel Project

1. **Project Settings:**
   - Framework Preset: `Create React App`
   - Root Directory: `frontend`
   - Build Command: `npm run build`
   - Output Directory: `build`

2. **Environment Variables:**
   - Add `REACT_APP_API_URL`: `https://your-backend-url.com/api`

3. **Click Deploy**

### Step 3: Configure Custom Domain (Optional)

1. In Vercel Dashboard → Settings → Domains
2. Add your custom domain
3. Update DNS records with Vercel's nameservers

**Vercel Deployment Complete!** ✅

## 🔧 Phase 3: Deploy Backend (Render)

### Step 1: Connect Render to GitHub

1. Go to https://render.com
2. Click "New +" → "Web Service"
3. Select "Deploy an existing repository"
4. Choose your GitHub repository

### Step 2: Configure Backend Service

| Setting | Value |
|---------|-------|
| **Name** | kanhaiya-marbles-api |
| **Environment** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Plan** | Free/Paid (choose as needed) |

### Step 3: Add Environment Variables

Click "Environment" and add:

```
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_KEY=your_service_key
ANTHROPIC_API_KEY=your_api_key
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://your-vercel-app.vercel.app
```

### Step 4: Deploy

1. Click "Create Web Service"
2. Wait for deployment (2-5 minutes)
3. Copy the Render URL (e.g., `https://kanhaiya-marbles-api.onrender.com`)

### Step 5: Update Frontend API URL

1. Go back to Vercel Dashboard
2. Settings → Environment Variables
3. Update `REACT_APP_API_URL` to your Render backend URL
4. Trigger a redeployment

**Backend Deployment Complete!** ✅

## 🗄️ Phase 4: Database Setup

### Verify Supabase is Production-Ready

1. Go to your Supabase dashboard
2. Verify all tables exist:
   - `shops`
   - `tile_categories`
   - `designs`
   - `inventory`
   - `invoices`
   - `invoice_items`
   - `purchases`
   - `alerts`
   - `ai_recommendations`

3. Check RLS (Row Level Security) policies
4. Verify backups are enabled

**Database Ready!** ✅

## ✅ Deployment Verification

### Test Frontend

1. Visit your Vercel URL
2. Test initialization screen
3. Verify all buttons work
4. Check responsive design on mobile

### Test Backend API

```bash
# Health check
curl https://your-backend-url/api/health

# Should return:
# {"status":"running","timestamp":"..."}
```

### Test Full Flow

1. Initialize shop
2. Create an invoice
3. Add stock
4. Check alerts
5. Verify database records

## 📊 Monitoring & Maintenance

### Vercel Monitoring

1. Dashboard → Analytics
2. Monitor build times
3. Check error rates
4. View deployment history

### Render Monitoring

1. Dashboard → Metrics
2. Monitor CPU/Memory usage
3. Check logs for errors
4. Set up notifications

### Supabase Monitoring

1. Go to Supabase Dashboard
2. Check database activity
3. Monitor quota usage
4. Review query performance

## 🔒 Security Checklist

- [ ] .env file is in .gitignore
- [ ] API keys are stored as environment variables
- [ ] CORS is properly configured
- [ ] Database RLS policies are enabled
- [ ] HTTPS is enforced (Vercel/Render handle this)
- [ ] API rate limiting is implemented
- [ ] Database backups are automated
- [ ] Error messages don't expose sensitive info

## 🚨 Troubleshooting

### Frontend Won't Load

**Error**: "Cannot find module 'react'"
- **Solution**: Ensure `frontend/` root is set in Vercel

**Error**: "API URL undefined"
- **Solution**: Check `REACT_APP_API_URL` in Vercel environment variables

### Backend Won't Start

**Error**: "Cannot connect to Supabase"
- **Solution**: Verify `SUPABASE_URL` and keys in Render environment

**Error**: "ANTHROPIC_API_KEY not found"
- **Solution**: Add to Render environment variables

### Database Connection Issues

**Error**: "connection refused"
- **Solution**: Verify Supabase URL and keys match

## 📱 Testing with Real Shopkeepers

### Pre-Alpha (Week 1)
- Verify system stability
- Test all features locally
- Load test with sample data

### Alpha (Week 2-3)
- Provide access to Sanjay Kumar Sharma
- Collect feedback
- Monitor server logs
- Fix critical issues

### Beta (Week 4)
- Expand to 2 more shopkeepers
- Performance optimization
- Prepare investor demo

## 🔄 Continuous Deployment

### Auto Deploy on Git Push

Both Vercel and Render support automatic deployments:

1. Push code to main branch
2. Vercel/Render automatically builds and deploys
3. Takes ~5 minutes total

### Manual Rollback

If issues occur:

**Vercel**: Dashboard → Deployments → Previous version → Redeploy

**Render**: Dashboard → Deploys → Select previous version

## 📞 Post-Deployment Support

### Monitoring Checklist (Weekly)

- [ ] Check error logs
- [ ] Monitor database growth
- [ ] Verify API response times
- [ ] Check for failed transactions
- [ ] Review user feedback
- [ ] Update AI model if needed

### Scaling (If Needed)

- **Vercel Pro**: Unlimited builds, better performance
- **Render Paid**: Auto-scaling, dedicated IP
- **Supabase**: Upgrade storage and compute

## 🎉 Deployment Timeline

| Phase | Timeline | Status |
|-------|----------|--------|
| Frontend (Vercel) | 5 mins | ✅ |
| Backend (Render) | 5-10 mins | ✅ |
| Database (Supabase) | Already done | ✅ |
| Testing | 30 mins | ✅ |
| **Total** | **~1 hour** | **Ready** |

---

**Next Steps After Deployment:**
1. Share URLs with Sanjay Kumar Sharma
2. Collect feedback from Week 2 testing
3. Iterate based on shopkeeper feedback
4. Prepare for Week 3-4 expansion

**Contact**: aashishk029@gmail.com
