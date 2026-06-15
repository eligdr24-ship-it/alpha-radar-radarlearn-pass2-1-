# Phase 1 — Stabilize & Deploy-Ready

Changes applied to Alpha Radar v1.2 (no rebuild — incremental fixes).

## 1. Runs locally
- Verified clean install + build + boot. All API routes return 200 and the
  React SPA is served by Express.
- `npm run dev` runs server (port 10000) + Vite (port 5173) together.
- `npm run build && npm start` serves the production bundle on one port.

## 2. Fixed dependencies / scripts / routing
- **Removed poisoned lockfiles.** Both `package-lock.json` files resolved every
  package from a private internal registry (`*.internal.api.openai.org`) that
  Render/Vercel/your laptop cannot reach — `npm ci` would have failed anywhere
  else. Regenerated clean lockfiles from public npm.
- **Pinned all `"latest"` dependencies** to explicit, compatible versions
  (the old setup had pulled bleeding-edge Vite 8). Now on a stable, tested set:
  React 18.3, Vite 6.0, Express 4.21, etc.
- **Split deps correctly:** build tooling (vite, react, plugin-react,
  concurrently) moved to `devDependencies`; only runtime libs stay in
  `dependencies`.
- **Fixed dev API proxy mismatch:** the Vite proxy targeted port 10000 while
  `.env.example` set PORT=3000, so API calls would 404 in dev. Standardized the
  default on 10000 (override with `VITE_API_PORT`).

## 3. Deployment settings
- **Render (recommended):** `render.yaml` now has `healthCheckPath: /api/health`,
  pinned `NODE_VERSION=20`, and sane env defaults. Added `.node-version`.
- **Vercel (optional):** added `vercel.json` + `api/index.js` serverless
  adapter. ⚠️ Vercel functions are ephemeral — the in-memory cache and any
  future node-cron 24/7 scanning will NOT persist. Use Render (or Railway/Fly)
  for the always-on scanning goal; Vercel only if you host the SPA there.

## 4. Cleaner folder structure
- Added `.gitignore` (node_modules, `.env`, and the generated `server/public`
  build output — that folder should be built, not committed).

## 5. `.env.example`
- Rewrote with grouped sections, inline comments, and `NODE_ENV`. Every var the
  code reads is documented; copy to `.env` for local dev.

## 6. Responsive UI
- Clean `index.html` with mobile/PWA meta (`theme-color`, `viewport-fit=cover`,
  Apple web-app tags).
- Appended responsive hardening to `styles.css` (additive — original tuned
  layout untouched): no horizontal overflow, 44px tap targets on touch, iPhone
  safe-area insets for the bottom nav, a tablet breakpoint, and a <=380px phone
  breakpoint.

## How to run
```bash
cp .env.example .env      # optional; defaults work out of the box
npm install               # root deps
npm run dev               # dev: server :10000 + Vite :5173  -> open :5173
# or production:
npm run build && npm start  # -> open http://localhost:10000
```

## Not changed (by design)
- Scoring/targets engine, data sources, and the v1.3+ roadmap are untouched.
- `node-cron` and `zod` remain installed but unused — reserved for Phase 2
  (24/7 scanning, request validation).
