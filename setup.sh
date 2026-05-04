#!/bin/bash

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Kanhaiya Marbles - AI Shop Management System Setup       ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Copying from .env.example..."
    cp .env.example .env
    echo "✅ .env created. Please edit it with your credentials."
    echo ""
    echo "Required credentials:"
    echo "  - SUPABASE_URL"
    echo "  - SUPABASE_ANON_KEY"
    echo "  - SUPABASE_SERVICE_KEY"
    echo "  - ANTHROPIC_API_KEY"
    exit 1
fi

echo "✅ .env file found"
echo ""

# Install backend dependencies
echo "📦 Installing backend dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "❌ Failed to install backend dependencies"
    exit 1
fi
echo "✅ Backend dependencies installed"
echo ""

# Install frontend dependencies
echo "📦 Installing frontend dependencies..."
cd frontend
npm install
if [ $? -ne 0 ]; then
    echo "❌ Failed to install frontend dependencies"
    exit 1
fi
cd ..
echo "✅ Frontend dependencies installed"
echo ""

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Setup Complete! Next Steps:                              ║"
echo "║                                                            ║"
echo "║  1. Setup Supabase:                                        ║"
echo "║     - Create a new project at supabase.com                ║"
echo "║     - Copy your URL and keys to .env                      ║"
echo "║     - Run schema.sql in Supabase SQL editor               ║"
echo "║                                                            ║"
echo "║  2. Get API Keys:                                          ║"
echo "║     - Anthropic API key from console.anthropic.com        ║"
echo "║     - Add to .env as ANTHROPIC_API_KEY                    ║"
echo "║                                                            ║"
echo "║  3. Start Development:                                     ║"
echo "║     Terminal 1: npm dev        (Backend on :3001)         ║"
echo "║     Terminal 2: npm run client (Frontend on :3000)        ║"
echo "║                                                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
