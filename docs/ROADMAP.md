# Roadmap

Hver milepæl er "done" når: typecheck + unit + e2e er grønne, `playtest`-skill er kørt, og der er et fungerende build.

## M0 – Skelet (½ dag)
- Vite + TS strict + ESLint + Prettier + Vitest + Playwright.
- Three.js-scene, Rapier init, fixed-timestep loop, debug-overlay (fps, sim-ms).
- `window.__game` test-API bag `?debug=1`.
- Cloudflare Pages deploy virker (se skill `deploy`).

## M1 – Øen (1–2 dage)
- Chunked voxel density field (chunk 32³, voxel 0,5 m).
- Ø-generering fra seed: radial falloff + fBm-støj + huler (3D-støj) + strand.
- Marching cubes i worker, chunk-meshes med vertex-farver efter højde/hældning (græs/sten/sand).
- Rapier trimesh-collider pr. chunk.
- Vandplan med shader. Fri-flyv debug-kamera.

## M2 – Ormen (1–2 dage)
- Rapier KinematicCharacterController: gå, hop, backflip, skråninger, faldskade.
- Kamera: third-person follow, aim-mode, kollision med terræn.
- Procedural orm-model + simple animationer (squash/stretch, vrikke).
- Død i vand.

## M3 – Boom (2 dage)
- Bazooka + Granat med vind.
- Eksplosion: carve sfære i density field → re-mesh berørte chunks i worker → rebuild colliders.
- Skade, knockback, partikler, kamerarystelse, projektil-kamera.
- Mål: eksplosion inkl. rebuild < 16 ms main thread.

## Look-pass (kører parallelt med M3)
- Golden hour-lys, orm v2 (S-krop, øjenlåg/bryn, army-hjelm m. goggles), instancerede græstotter/sten/blomster.
- HUD-skal efter `docs/ART_DIRECTION.md`: holdliste m. portrætter + HP, våbenkort, rund minimap m. kompas, navneskilte.

## M4 – Tur-system og hotseat (1–2 dage)
- Tur-state machine (select → move → aim → fire → retreat → settle → resolve).
- Hold, HP-bars over orme, timer, vindindikator, våbenmenu, minimap, oversigtskamera (layout: `docs/ART_DIRECTION.md`).
- Sejr/tab-skærm. Startmenu: hold, orme pr. hold, seed.
- **Første spilbare version – deploy.**

## M5 – Flere våben og kasser
- Shotgun, Dynamite, Ninja Rope (3D-rope med Rapier rope joint + svingfysik), Cluster, Banana, Air Strike, Sheep, Jetpack, Teleport.
- Faldskærmskasser. Sudden death (stigende hav).
- Ødelæggelige hytter (voxel-strukturer i generatoren).

## M6 – Bots
- CPU-modstander med sim-baseret skud-søgning (kør sim fremad i en kopi / forenklet ballistik).
- Sværhedsgrader.

## M7 – Polish
- Lyd, musik, toon-shader, post-processing (let bloom, SSAO kun hvis budget tillader).
- Gamepad, indstillinger, performance-presets.

## M8 – Online (valgfri)
- Supabase Realtime-rum, lobby-kode, command-broadcast, desync-hash.
