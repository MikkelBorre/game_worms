# Deploy – Cloudflare Pages + subdomæne hos e-studio

Spillet er 100 % statiske filer (`dist/`). Ingen server. Domænet bliver hos e-studio – kun én CNAME-record peger
subdomænet (fx `worms.<dit-domæne>.dk`) over på Cloudflare Pages.

## Første gang (ca. 10 min, du klikker)

1. **Cloudflare-konto**: opret gratis på https://dash.cloudflare.com (hvis du ikke har en).
2. **Workers & Pages → Create → Pages → Connect to Git** → vælg GitHub-repoet `MikkelBorre/game_worms`.
   - Production branch: `main`
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Environment variable: `NODE_VERSION` = `22` (repoet har også `.node-version`)
3. **Save and Deploy**. Første build tager 1–2 min. Du får en URL som `https://game-worms.pages.dev` – test den.
4. **Custom domain**: Pages-projektet → *Custom domains* → *Set up a custom domain* → skriv fx
   `worms.<dit-domæne>.dk`. Cloudflare viser en CNAME-target (`<projekt>.pages.dev`).
5. **e-studio cPanel → Zone Editor** → dit domæne → *Add Record* → type **CNAME**,
   navn `worms`, værdi `<projekt>.pages.dev`, TTL standard. Intet andet på domænet ændres.
6. Vent til Cloudflare viser domænet som **Active** (SSL udstedes automatisk, typisk få minutter, max ~24 t for DNS).

## Hver deploy
- Merge til `main` → Cloudflare bygger og udgiver automatisk.
- Andre branches/PR's får automatisk **preview-URL'er** (`<hash>.<projekt>.pages.dev`) – godt til at teste før merge.

## Tjekliste før merge til main
`npm run typecheck && npm test && npm run build` (CI gør det også) og bundle < 3 MB gzip.

## Noter
- Rapier-WASM er inlinet i JS-bundlen (`@dimforge/rapier3d-compat`), så der skal ikke sættes MIME-type for `.wasm`.
- `public/_headers` giver hashede assets 1 års cache og `index.html` `no-cache`, så nye deploys slår igennem med det samme.
- Fallback uden Cloudflare: upload indholdet af `dist/` til en mappe på e-studio via FTP (se `.claude/skills/deploy/SKILL.md`).
