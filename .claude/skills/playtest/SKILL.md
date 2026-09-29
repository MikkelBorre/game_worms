---
name: playtest
description: Visually and functionally playtest WormWorld in a real browser via Playwright with deterministic scenarios and screenshots. Use after any visual or gameplay change, and at the end of every milestone.
---

# Playtest

The game exposes `window.__game` when loaded with `?debug=1` (see CLAUDE.md rule 7).

1. Make sure the dev server runs: `npm run dev -- --port 5173` in the background (reuse if already up).
2. Run `npx playwright test tests/e2e/playtest.spec.ts`. If the spec lacks a scenario for what you just built, add one first. Pattern:
   ```ts
   await page.goto('/?debug=1&seed=1234');
   await page.waitForFunction(() => (window as any).__game?.ready);
   await page.evaluate(() => {
     const g = (window as any).__game;
     g.spawnWorm({ team: 0, pos: [0, 20, 0] });
     g.fire('bazooka', [1, 0.4, 0], 0.7);
     g.advance(240);
   });
   await page.screenshot({ path: 'test-results/playtest/bazooka-crater.png' });
   ```
   Use WebGL-capable launch args: `--use-gl=angle --use-angle=swiftshader` if headless rendering is black.
3. **Open and look at every screenshot** with the Read tool. Describe what you actually see. Don't assume it worked.
4. Read `__game.state().perf` and compare with the budget in CLAUDE.md.
5. Report: scenarios run, what the screenshots show, perf, and any problems. If something looks wrong, fix it and re-run before reporting done.
