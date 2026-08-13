# e2e acceptance scripts

These are Playwright-Core headless-Chromium scripts that were verified green against the
production build on 2026-08-10. They are evidence artifacts: do not reformat, rewrite, or
convert them to Vitest. A fresh agent must be able to re-run exactly what was run on that date.

New maintained regressions live beside those frozen evidence artifacts and may be updated with
the behavior they protect:

- `ux_map_app.mjs` — mobile Undo geometry and exact undo; App-owned Add draft/discard/success;
  intercepted exact/road/locality/pinless/far/pending/race geocodes; Due Show/Place exact-ID
  navigation and queue state; live-bootstrap demo-data isolation. Run against the port 4212
  preview with `node e2e/ux_map_app.mjs`, or set `PUMPCYCLE_E2E_URL` for a local Worker.
- `scale_benchmark.mjs` — deterministic 1,000-customer phone/CPU-throttled map benchmark with
  cluster/canvas/DOM count invariants. Build, run Wrangler on port 8787, then execute
  `node e2e/scale_benchmark.mjs`.

## Prerequisites

- Node installed (project already has `playwright-core` in devDependencies)
- Chromium build 1228 installed via playwright at the hardcoded path below.

**Hardcoded Chromium path:**
```
%LOCALAPPDATA%\ms-playwright\chromium-1228\chrome-win64\chrome.exe
```

This is build 1228. If that exact build is absent the scripts will fail to launch. Install it with:
```
npx playwright install chromium
```
Note: the installed build number may differ from 1228 if you install a newer playwright-core;
in that case update the path in each script or use `process.env.LOCALAPPDATA` with the
correct build directory.

## How to run

1. Build the SPA:
   ```
   npm run build
   ```

2. Start vite preview on port 4212:
   ```
   npx vite preview --port 4212 --strictPort
   ```
   Keep this running in a separate terminal.

3. In another terminal, run any script with Node directly:
   ```
   node e2e/tA_prod.mjs
   node e2e/tB_prod.mjs
   node e2e/tC_prod.mjs
   node e2e/tD_prod.mjs
   node e2e/tE_prod.mjs
   node e2e/tG.mjs
   node e2e/tZ4.mjs
   node e2e/tZ5.mjs
   ```

## Script index

### Verified green (all confirmed on 2026-08-10 against the production build)

| Script | What it tests |
|---|---|
| `tA_prod.mjs` | Full user path: add geocoded customer twice, map flies to z19, coords persisted |
| `tB_prod.mjs` | Stale-coordinate race: slow answer for A must not contaminate address B (2 cases) |
| `tB2.mjs` | Follow-up on C2: polls until cross-country flyTo settles at z19 (**uses port 4211**) |
| `tC_prod.mjs` | Regression suite (R1-R8): non-geocoded add, abort, timeout, double-click, unmount race, Enter key, drop-lid-pin flow |
| `tD_prod.mjs` | Already-mounted map path: flyTarget consumed exactly once, no re-fire on re-render |
| `tE_prod.mjs` | Exact Leaflet zoom/center after real user path, read off the live map instance |
| `tG.mjs` | Touch gating: desktop markers are draggable, mobile markers are not; mobile tap opens card |
| `tZ4.mjs` | Double-click race: second click at button coords after modal closes must not zoom-in the map |
| `tZ5.mjs` | Human-realistic double-click (clickCount=2) race at 100ms and 250ms gaps |

### Additional scripts (not in the verified-green list; may still run)

| Script | Port | Notes |
|---|---|---|
| `tF.mjs` | 4212 | Round 2: draggable pins, map-view persistence, trailing-space geocode |
| `tZ.mjs` | 4212 | Extra adversarial cases |
| `tZ2.mjs` | 4212 | Early double-click race iteration |
| `tZ3.mjs` | 4212 | Instrumented: what happens to the map on double-click Save |
| `vH.mjs` | 4212 | Intermediate verification script |
| `vI.mjs` | 4212 | Intermediate verification script |
| `vJ.mjs` | 4212 | Intermediate verification script |
| `vK.mjs` | 4212 | Intermediate verification script |
| `vL.mjs` | 4212 | Intermediate verification script |
| `vM.mjs` | 4212 | Intermediate verification script |
| `x1_prod.mjs` | 4212 | Extended verification script |
| `x2_prod.mjs` | 4212 | Extended verification script |
| `x2b_probe.mjs` | 4212 | Probe script |
| `x3_prod.mjs` | 4212 | Extended verification script |
| `x2_dev.mjs` | 4213 | Requires `wrangler dev` on port 4213, not vite preview |
| `x3_dev.mjs` | 4213 | Requires `wrangler dev` on port 4213, not vite preview |

## Skipped scripts and reasons

| Skipped | Reason |
|---|---|
| `tA.mjs` | Superseded by `tA_prod.mjs` (same tests, old dev port 4211) |
| `tB.mjs` | Superseded by `tB_prod.mjs` (same tests, old dev port 4211) |
| `tC.mjs` | Superseded by `tC_prod.mjs` (same tests, old dev port 4211) |
| `tD.mjs` | Superseded by `tD_prod.mjs` (same tests, old dev port 4211) |
| `t1.mjs` through `t9.mjs` | From a much earlier iteration (ports 4188 and 4199); entirely superseded |

## SUPERSEDED as of 2026-08-11 - do not re-run as a pass/fail gate

These scripts are frozen evidence of the runs that produced them, so they are
kept byte-identical and are NOT updated when the app changes. On 2026-08-11 the
address lookup was rebuilt and two behaviours these scripts assert on were
deliberately removed:

1. **The Gastonia jitter fallback is gone.** An address that geocodes to nothing
   used to drop a random pin near Gastonia NC (`35.26 +/- 0.06`, `-81.18 +/- 0.09`).
   It now stores no location at all: `lat` and `lng` are both `null` and the
   customer appears under "No pin yet (N)" instead of on a fake pin. The old
   behaviour put a Pennsylvania client's customer in North Carolina.
2. **The `Found — map will fly here on save.` string is gone**, replaced by an
   echo of the address the geocoder actually matched, plus separate copy for
   road-level and town-level results.

Any script matching `Gastonia`, `35.26`, `jitter`, `Found —` or
`Address not found` therefore fails against current code, and that failure is
the intended change rather than a regression. The behaviours that replaced them
are covered by `test/worker/geocode.test.js` and
`test/lib/geocode-normalize.test.js`, which do run in `npm test`.

Affected: `tA_prod`, `tB2`, `tB_prod`, `tC_prod`, `tE_prod`, `tF`, `tZ`, `tZ2`,
`tZ3`, `tZ4`, `tZ5`, `vH`, `vI`, `vJ`, `vK`, `vL`, `x1_prod`, `x2_dev`,
`x2_prod`, `x2b_probe`, `x3_dev`, `x3_prod`.

Still valid: `tD_prod` (already-mounted fly), `tG` (touch draggability),
`vM`, `tZ`-family assertions about double-click that do not touch the fallback.
