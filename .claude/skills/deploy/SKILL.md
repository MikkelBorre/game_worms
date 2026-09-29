---
name: deploy
description: Build and deploy WormWorld as a static site to Cloudflare Pages on Mikkel's subdomain. Use when the user says deploy, ship, publish, or at the end of a playable milestone.
---

# Deploy (Cloudflare Pages)

The game is 100 % static – no server processes. The domain stays at e-studio; only a CNAME points the subdomain to Cloudflare Pages.

## First-time setup (guide Mikkel through it, he clicks)
1. Push the repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick the repo.
   - Framework preset: **Vite** · Build command: `npm run build` · Output: `dist` · Env: `NODE_VERSION=22`.
3. Pages project → Custom domains → add e.g. `worms.<hans-domæne>.dk`. Cloudflare shows a CNAME target like `<project>.pages.dev`.
4. In e-studio cPanel → Zone Editor → add **CNAME** `worms` → `<project>.pages.dev`. Nothing else on the domain changes.
5. Wait for SSL to go active in Cloudflare (usually minutes).

## Every deploy
1. `npm run typecheck && npm test && npm run build && npm run preview` – smoke test the preview with a quick Playwright run against it.
2. Verify `dist/` contains the Rapier `.wasm` (or that it's inlined by the `-compat` package) and total gzip size is within budget.
3. Commit and push to `main` → Cloudflare builds automatically. Preview deployments are created for other branches.
4. After deploy, open the production URL with Playwright, wait for `__game.ready` (with `?debug=1`), and take one screenshot to confirm.

## Fallback: e-studio cPanel directly
Allowed (static files are an ordinary website). Upload `dist/` contents to a subfolder/subdomain docroot via FTP (`lftp -e "mirror -R dist/ public_html/worms; quit" ftp://...`). Add `.htaccess` with `AddType application/wasm .wasm`. Never run background processes there.
