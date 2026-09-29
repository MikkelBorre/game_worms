---
name: perf-check
description: Measure and fix WormWorld performance – fps, sim time per tick, terrain rebuild time, draw calls, bundle size. Use when the game feels slow, after terrain/render changes, or before a deploy.
---

# Perf check

1. `npm run bench:terrain` → full island mesh time + single explosion rebuild time.
2. Playwright scenario `perf` (in `tests/e2e/playtest.spec.ts`): load seed 1, run 10 explosions over 600 ticks, then read `__game.state().perf` → avg/p95 frame ms, sim ms, draw calls, triangles.
3. `npm run build` and report gzip sizes of `dist/assets/*` (use `gzip -c file | wc -c`).
4. Compare with the budget in CLAUDE.md. Print a small table: metric | now | budget | status.
5. If over budget: find the top cause (Chrome trace via Playwright `page.tracing` or targeted timers), fix only that, re-measure, and show before/after. Common wins: fewer chunk re-meshes, instanced particles, merged materials, smaller shadow frustum, lazy-loading Rapier WASM.
