# WormWorld – open world Worms i 3D (browser)

Et hobbyprojekt: klassisk Worms-DNA (turbaseret, sjove våben, ødelæggeligt terræn, vand = død)
men i en **fri 3D open world-ø**, hvor ormene kan gå, hoppe, svinge i rope og flyve frit.

Læs `docs/GDD.md` (design) og `docs/ROADMAP.md` (milepæle) før du starter på en ny milepæl.

## Stack (låst – foreslå ændringer, men skift ikke uden at spørge)

| Område | Valg | Hvorfor |
|---|---|---|
| Sprog | TypeScript (strict) | Typesikkerhed på tværs af sim og rendering |
| Build | Vite | Hurtig HMR, statisk output |
| Rendering | Three.js (WebGL2) | Modent, stort økosystem |
| Fysik | `@dimforge/rapier3d-compat` | WASM, deterministisk, character controller indbygget |
| Terræn | Voxel density field + marching cubes i Web Worker | Ødelæggeligt terræn i 3D |
| Støj | `simplex-noise` | Procedural ø |
| UI/HUD | Plain DOM + CSS (ingen React) | Enkelt, ingen framework-overhead |
| Lyd | Web Audio API (howler.js hvis nødvendigt) | |
| Test | Vitest (logik) + Playwright (smoke/visual) | |
| Hosting | Cloudflare Pages (statisk) på subdomæne via CNAME | Gratis, auto-deploy fra GitHub |
| Online (senere) | Supabase Realtime (broadcast af kommandoer) | Ingen egen server nødvendig |

**Ingen permanent server.** Spillet er 100 % statiske filer. Ingen Node-backend.

## Arkitektur

```
src/
  main.ts                 # bootstrap
  core/
    loop.ts               # fixed timestep 60 Hz sim + interpoleret render
    events.ts             # typed event bus
    rng.ts                # seeded RNG (mulberry32) – ALDRIG Math.random i sim
    commands.ts           # input -> Command (serialiserbar) -> sim
  sim/                    # ren spillogik, ingen Three.js-imports her
    world.ts              # Rapier world, entities
    turn.ts               # tur-state machine
    worm.ts               # orm-state, HP, team
    weapons/              # ét modul pr. våben + registry.ts
    explosion.ts          # skade, knockback, terræn-carve
    water.ts              # vandniveau, sudden death
  terrain/
    voxels.ts             # chunked density field (Float32Array pr. chunk)
    generate.ts           # ø-generering fra seed
    mesher.worker.ts      # marching cubes i worker
    colliders.ts          # Rapier trimesh pr. chunk, rebuild ved ændring
  render/
    scene.ts, lights.ts, materials.ts
    terrainView.ts        # chunk-meshes
    wormView.ts, fx.ts    # partikler, eksplosioner
    camera.ts             # follow / aim / projectile-cam / overview
  ui/
    hud.ts, minimap.ts, weaponMenu.ts, menus.ts
  debug/
    testApi.ts            # window.__game (kun når ?debug=1)
tests/
  unit/                   # vitest
  e2e/                    # playwright
```

### Hårde regler
1. **Sim og render er adskilt.** `sim/` og `terrain/` må ikke importere `three`. Render læser sim-state.
2. **Alt input går gennem `Command`s.** Det gør replays, bots og online multiplayer gratis senere.
3. **Deterministisk sim:** fixed timestep, seeded RNG, ingen `Date.now()`/`Math.random()` i sim.
4. **Våben er data + et lille modul.** Brug skill `add-weapon`.
5. **Terræn-mesh bygges i worker.** Main thread må aldrig køre marching cubes.
6. **Performance-budget:** 60 fps på en almindelig laptop (integreret GPU), < 3 ms sim-tid pr. tick, eksplosion-rebuild < 16 ms for berørte chunks. Bundle < 3 MB gzip.
7. **`?debug=1`** eksponerer `window.__game` med: `state()`, `spawnWorm()`, `fire(weapon, dir, power)`, `advance(ticks)`, `setSeed(n)`, `screenshot()`. Playwright-tests bruger kun dette API.

## Arbejdsform
- **Vis altid en kort plan før du koder** en ny feature. Vent ikke på godkendelse ved små ting, men ved arkitekturændringer.
- **Slet aldrig filer** uden eksplicit godkendelse fra Mikkel.
- Arbejd i milepæle fra `docs/ROADMAP.md`. Afslut hver milepæl med: `npm run typecheck && npm test && npm run e2e`, derefter skill `playtest`.
- Commit efter hver fungerende delopgave med konventionelle beskeder (`feat:`, `fix:`, `perf:`).
- Brug subagents til afgrænsede opgaver (se `.claude/agents/`). Kør uafhængige agents parallelt.
- Svar og kommentarer til Mikkel på **dansk**, kode og kodekommentarer på **engelsk**.

## Kommandoer
```
npm run dev        # vite dev server
npm run build      # produktion til dist/
npm run preview    # test build lokalt
npm run typecheck  # tsc --noEmit
npm test           # vitest
npm run e2e        # playwright
```
