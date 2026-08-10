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
   Pins: green / yellow (due <=60d) / red (overdue). Click pin -> card with name, address,
   phone (tel:), email (mailto:), tank size, last pumped, cycle, next due, notes.
   Commercial cards: "Commercial - Grease trap" badge. Overdue cards: reach-out strip with
   Call/Email links. Buttons: [Mark pumped today] [Edit].
   Drop-lid-pin flow: FAB shows a draggable blue pin; desktop has side panel alongside;
   mobile is two-step (full-screen pin placement, then a sheet for service type + name + save).
   Save creates a real customer via addCustomer.

2. **Due list** - sorted by next due, filters Overdue/30/60/90, name/address search.
   Top counters: Overdue N - $X, Due in 30d N - $X, Reminders scheduled N.
   Revenue = count x avg job price (default $450, editable via settings popover).

3. **Reminders** - queue of upcoming reminders by contact channel. Email if customer has email;
   SMS if customer has phone; both -> two rows; neither -> no reminder. Sent items move to Sent
   filter. Overdue customers currently drop out of the queue entirely - a separate od1/od2/od3
   overdue rule is planned but NOT built yet, so today the most urgent customers are the ones
   the system never contacts.
   Email: residential 60d before due, commercial 15d before due.
   SMS: 14d before due. Desktop "Copy text"; mobile "Copy text" + "Text from my phone" (sms:
   link). Manual "Mark as sent". Caption: "One tap sends from your phone."
   Message text adapts: commercial uses FOG/grease-trap/90-day wording; residential plain.

Topbar: "PumpCycle" logo - badge "Live demo - sample data" - "Get this for your company"
button -> modal with offer ($500 setup + $99/mo) + form (Name, Email or phone, hidden honeypot)
-> POSTs to /api/lead (demo hosts only; returns 404 on a live client host).

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
