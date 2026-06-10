# PumpCycle — demo app

## What this is
Single-page demo web app for septic pumping companies. Public sales demo
with fictional seed data ("Hawkins Septic Co"). No real users, no real sending.

## Stack (fixed — never add libraries without asking me)
- Vite + React, plain JavaScript (no TypeScript)
- Tailwind CSS
- react-leaflet + OpenStreetMap tiles (free, no API keys)
- State: React state + localStorage (key "pumpcycle-demo-v1"), seeded from src/data/seed.json
- Deploy: Cloudflare Pages via wrangler. One Pages Function: POST /api/lead → Telegram bot (token/chat_id from env vars, never hardcoded)
- No other backend, no database, no auth, no router

## Hard constraints
- SMS/email sending is SIMULATED in UI only
- No tests, no refactors, no new npm packages, no TypeScript migration
- Mobile-responsive required; pixel-perfection not required
- Plain readable code, small components

## Product: topbar + 3 tabs
1. Map: customer pins — green / yellow (due ≤60 days) / red (overdue).
   Click pin → card: name, address, phone, tank size, last pumped, cycle,
   next due (auto-calculated), notes. Buttons: [Mark pumped today] [Edit].
2. Due list: rows sorted by next due; filters Overdue/30/60/90.
   Top counters: "Overdue: N — $X", "Due in 30d: N — $X", "Reminders scheduled: N".
   Revenue = count × avg job price (default $450, editable in a small settings popover).
3. Reminders: queue (customer, channel Email/SMS, send date = 60d and 14d
   before due, status Scheduled/Sent). Click → message preview text.
   "Send now" flips status with a toast (simulated).
Topbar: "PumpCycle" logo text • badge "Live demo — sample data" •
button "Get this for your company" → modal: 2-line offer ($500 setup + $99/mo,
live in a week, we import your data) + form (Name, Email or phone) + hidden
honeypot field + line "or just reply to my email". POSTs to /api/lead.

## Audience
Buyers are 50–60yo non-technical owners. Big readable type, high contrast,
light theme, obvious buttons, zero clutter. Realistic data, never lorem ipsum.

## Commands
dev: npm run dev | build: npm run build