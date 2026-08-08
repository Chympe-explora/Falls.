# 🌊 FALLS — Premium Food Ordering Platform
**Swiggy-inspired UX + GitHub Pages + Render + Telegram Control**

Original premium design — glassmorphism + waterfall background + modern food cards. NOT a copy of Swiggy's branding/code.

## Architecture (Single Source of Truth: Render Backend)

QR -> GitHub Pages (frontend/index.html) -> premium startup animation -> checks /health/ready -> wakes Render if cold -> loads restaurants -> Customer browses -> Cart -> Checkout -> UPI -> Receipt -> Order Code (FOOD-YYYYMMDD-XXXX) -> Backend creates order snapshot (prices from server) -> Telegram bot notifies restaurant -> Customer live tracking

Hosting split:
- GitHub Pages -> customer frontend
- Render -> backend/API + Telegram webhooks + file persistence
- Telegram Bot -> Super Admin + Restaurant control
- WhatsApp -> support only

## Features Implemented (54 requirements)

Customer:
- Startup screen with real readiness check (no fake %)
- Glassmorphism + waterfall background
- Restaurant discovery (20 seeded, scales unlimited)
- Pinned / Highlighted / Open / Busy badges
- Search restaurants, food, cuisine
- Categories: Burgers, Pizza, Noodles, Chicken, Veg, Snacks, Desserts, Drinks
- Restaurant page with cover, logo, menu categories, food cards
- Food detail modal, persistent bottom cart, multi-step checkout, UPI + QR, receipt upload, duplicate protection (idempotency), unique order code, live tracking

Restaurant Onboarding:
- Hamburger menu hidden register -> PENDING -> silent Telegram to Super Admin -> Approve/Reject -> secure linking token https://t.me/<bot>?start=link_<token> -> setup wizard -> GO LIVE

Telegram Restaurant Bot:
- Menu: Orders, Menu, Prices, Payments, Profile, Hours, Open/Close, Busy, Staff, Sales, Settings
- Add item flow: name -> price -> image -> description -> category -> SAVE instantly live
- Management: ADD/EDIT/DELETE/PRICE/IMAGE/AVAILABLE/HIDE/SHOW
- Price changes only future orders (snapshot integrity)
- Payments: ADD UPI, UPLOAD QR, preview, save
- Orders: Accept/Reject with callback safety (first wins), Receipt verification
- Status: Accept -> Preparing -> Ready -> Completed

Super Admin Bot:
- Menu: Restaurants, Orders, Payments, Customers, Complaints, Analytics, Announcements, Settings, Emergency, System Health
- Controls: Pin/Unpin, Highlight, Suspend, etc. All audited

Security:
- Secrets in Render env, never GitHub
- Server-side price validation
- Order snapshot, JWT, Telegram ID verification, rate limiting, audit logs

## Quick Deploy
1. Backend to Render: New Web Service, root backend, npm install, node server.js, set env vars (JWT_SECRET, TELEGRAM_BOT_TOKEN, SUPER_ADMIN_TELEGRAM_IDS, FRONTEND_URL, BACKEND_URL)
2. Set Telegram webhook (must include secret_token, matching WEBHOOK_SECRET env var, or the bot will reject every update with 401):
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<BACKEND>/telegram/webhook&secret_token=<WEBHOOK_SECRET>
3. Frontend to GitHub Pages: push frontend/ folder, set BACKEND_URL in app.js, enable Pages
4. Test full flow: register -> Telegram approve -> link -> /additem -> /setupi -> /golive -> order -> accept -> tracking

See docs/DEPLOYMENT.md for detailed steps.

## Local Dev
cd backend
npm install
TELEGRAM_BOT_TOKEN=dummy SUPER_ADMIN_TELEGRAM_IDS=123456 node server.js
Open frontend/index.html via live server

## Staff PIN access (no new env vars needed)
Counter staff without the owner's Telegram can manage today's orders at
frontend/staff.html using a 6-digit PIN, scoped to today only (no menu,
prices, or payment access):
- Owner gets today's PIN via Telegram automatically at midnight, and can
  regenerate it anytime by sending /staffpin (old PIN stops working
  immediately) or tapping 👥 Staff in the bot menu.
- Staff enter Restaurant ID + PIN at staff.html to accept/reject and move
  orders through Preparing -> Ready -> Completed.

## Files
- frontend/index.html, style.css, app.js
- frontend/staff.html (staff daily-PIN order view - deploy alongside index.html)
- backend/server.js (complete backend + bot)
- backend/package.json, render.yaml
