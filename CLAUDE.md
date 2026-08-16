# PumpCycle

## What this is
One Cloudflare Worker with Static Assets serving two things from the same build:
- Public sales demo (demo.pumpcycle.net, pumpcycle.net) - seeded fictional data, no login.
- Per-client app (app.pumpcycle.net and future client hostnames) - real D1 database, auth required.

Host-based split, decided server-side by tenant resolution. Not a demo any more.

## The old constraints are void
CLAUDE.md previously called the stack "fixed" and forbade a backend, database, auth, router,
tests, refactors, and new packages. All of that described a throwaway demo. It is dead.
Any version of those rules seen in git history does not apply.

## Stack
- Vite + React 19, plain JavaScript (no TypeScript), Tailwind
- react-leaflet + Esri World Imagery (satellite, default) + OSM tiles - both free, no key
- Cloudflare Worker + Static Assets + D1 + R2, deployed with wrangler

## Commands
| Command | Use |
|---|---|
| `npm run dev` | Vite dev server (frontend only) |
| `npm run build` | Vite build to dist/ |
| `npm run lint` | Lint |
| `npm run test` | Vitest unit tests |
| `npm run dev:worker` | wrangler dev (full Worker + assets) |
| `npm run deploy` | build then deploy - **use this, never bare `wrangler deploy`** |

`dist/` is gitignored. Static Assets uploads whatever is on disk, so a bare `wrangler deploy`
can silently ship a stale build. The deploy script is the only safe path.

## Product: topbar + 3 tabs

Audience: 50-60-year-old non-technical owners. Big readable type, high contrast, light theme,
obvious buttons, zero clutter. Realistic data only, never lorem ipsum.

Seed: ~70 customers (residential cycleMonths 36, a few commercial restaurants cycleMonths 3).
No `type` field - commercial is the predicate `cycleMonths <= 3`.
Each customer: `phone` + optional `email` (both may be empty). Dates auto-shift so the demo never
goes stale.

1. **Map** - two tile layers (Esri satellite default, OSM alternate), both attributed.
   Scale rendering: clusters at zoom <=12, canvas dots at 13-16, exact DOM teardrops at >=17.
   Pins: green / yellow (due <=60d) / red (overdue) / gray (unknown pump date). Solid = confirmed lid; hollow = unconfirmed town/road centroid.
   Customer card: [Details | History] segmented control.
   - Details: phone (tel:), email (mailto:), tank size, cycle, notes, standalone lid photos, and offline GPS Lid Finder with heading arrow.
   - History: pumping visit log (date, gallons, price, tech, notes) and service photos.
   Commercial cards: "Commercial - Grease trap" badge. Overdue cards: reach-out strip with Call/Text/Email links. Bottom bar: [Mark pumped today] [Show on map] [Move pin] [Edit].
   Pin placement flow: fixed crosshair in center, map moves underneath, zoom >= 18 floor, 10s undo toast.

2. **Due list** - sorted by next due, filters Overdue/30/60/90/All, name/address search.
   Top counters: Overdue N - $X, Due in 30d N - $X, Reminders scheduled N.
   Revenue = count x avg job price (default $450, editable via settings popover).
   Export / Print button -> modal for Customer CSV, QuickBooks Contact CSV, Avery 5160 labels (3x10), and 4-up postcards.

3. **Reminders** - queue of upcoming reminders by contact channel.
   - Pinned top section: "Needs a good email address" for bounced emails with 1-tap "Fix" button.
   - Today section: manual SMS texts to send vs automatic 9:00 AM email sends.
   - Next 7 days upcoming view.
   - "Everything beyond" collapsible view by month.
   - Sent tab: full delivery audit history.
   - Email: residential 60d before due, commercial 15d before due; automated overdue ladder (+7/+30/+90d residential, +3/+10/+21d commercial).
   - SMS: 14d before due. "Copy text" + "Text from my phone" (sms: link). 30-day repeat warning.

Topbar: "PumpCycle" logo - badge "Live demo - sample data" - "Get this for your company"
button -> modal with offer ($500 setup + $99/mo) + form (Name, Email or phone, hidden honeypot)
-> POSTs to /api/lead (demo hosts only; returns 404 on a live client host). Sign out button on live host.

## Rules that bind

**Tenant resolution** - hostname is the only input, always. Never a header, query param, cookie,
or request body. A mapped host with missing bindings returns 503 - never a fallback database.
No `tenant_id` column anywhere, no shared tables.

**Reminder logic** - the Worker imports `src/lib/dates.js` and `src/lib/reminders.js` directly.
Due-date arithmetic is never reimplemented in SQL and never duplicated in the Worker.
A fork drifts and the UI stops matching what was actually sent.

**Cache headers** - `Cache-Control: private, no-store` is set in `worker/lib/json.js` for every
JSON response. Never set it per route - the one route it gets forgotten on is the one that leaks.

**Write funnel** - no component calls fetch for a mutation. Every write goes through one funnel.

**Storage conventions** - money: integer cents. Moments: integer ms epoch UTC.
Calendar days: TEXT 'YYYY-MM-DD'. Booleans: integer 0/1.

**Migrations** - numbered, immutable. Tracked in schema_meta.

**Mobile-responsive required. Pixel-perfection not required.**
Plain readable code, small components.
