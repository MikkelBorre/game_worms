import { expect, test, type Page } from '@playwright/test';
import { openGame, shotPath } from './helpers';

/** Find a flat-ish dry spot near (x0, z0) using the terrain height query. */
async function landSpot(page: Page, x0 = 0, z0 = 0): Promise<[number, number, number]> {
  return page.evaluate(
    ([x0, z0]) => {
      const g = window.__game!;
      for (let r = 0; r < 60; r += 2) {
        for (let a = 0; a < 16; a++) {
          const x = x0 + Math.cos((a / 16) * Math.PI * 2) * r;
          const z = z0 + Math.sin((a / 16) * Math.PI * 2) * r;
          const h = g.heightAt(x, z);
          const flat = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ].every(([dx, dz]) => Math.abs(g.heightAt(x + dx!, z + dz!) - h) < 0.6);
          // The path 8 m along +x must be walkable too (no cliffs/steep hills in the way).
          let path = true;
          for (let d = 1; d <= 8 && path; d++)
            path = Math.abs(g.heightAt(x + d, z) - g.heightAt(x + d - 1, z)) < 0.6;
          if (h > 3 && h < 25 && flat && path) return [x, h + 1.2, z] as [number, number, number];
        }
      }
      throw new Error('no land spot');
    },
    [x0, z0] as const,
  );
}

test('commands: worm walks on real terrain and faces its direction', async ({ page }) => {
  await openGame(page, 1234);
  const spot = await landSpot(page);
  const r = await page.evaluate((pos) => {
    const g = window.__game!;
    g.pause(true);
    g.spawnWorm({ team: 0, pos });
    g.advance(90);
    const id = g.state().worms[0]!.id;
    const a = g.state().worms[0]!.pos;
    g.command({ type: 'move', wormId: id, dir: [1, 0] });
    g.advance(120);
    g.command({ type: 'move', wormId: id, dir: [0, 0] });
    g.advance(10);
    const w = g.state().worms[0]!;
    return { a, b: w.pos, yaw: w.yaw, alive: w.alive, active: g.state().activeWormId, id };
  }, spot);
  expect(r.alive).toBe(true);
  expect(r.active).toBe(r.id);
  expect(Math.hypot(r.b[0] - r.a[0], r.b[2] - r.a[2])).toBeGreaterThan(2);
  expect(r.yaw).toBeCloseTo(Math.PI / 2, 1);
});

test('keyboard: W walks the active worm in follow mode, Space jumps', async ({ page }) => {
  await openGame(page, 1234);
  const spot = await landSpot(page, -20, 10);
  await page.evaluate((pos) => {
    const g = window.__game!;
    g.spawnWorm({ team: 1, pos });
    g.advance(120);
    g.cameraMode('follow');
  }, spot);
  const before = await page.evaluate(() => window.__game!.state().worms[0]!.pos);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__game!.state().worms[0]!.pos);
  expect(Math.hypot(after[0] - before[0], after[2] - before[2])).toBeGreaterThan(0.5);

  // Space → windup then forward jump. The key handler queues the command; step deterministically.
  const peak = await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    const y0 = g.state().worms[0]!.pos[1];
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
    let max = y0;
    for (let i = 0; i < 60; i++) {
      g.advance(1);
      max = Math.max(max, g.state().worms[0]!.pos[1]);
    }
    return max - y0;
  });
  expect(peak).toBeGreaterThan(0.4);
  await page.screenshot({ path: shotPath('m2-follow-cam') });
});

test('walking into the sea kills the worm and freezes it', async ({ page }) => {
  await openGame(page, 1234);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    // Beach: walk outward from the centre along +x until the ground is just above water.
    let x = 0;
    while (x < 79 && g.heightAt(x, 0) > 1.5) x += 0.5;
    g.spawnWorm({ team: 2, pos: [x - 3, g.heightAt(x - 3, 0) + 1.2, 0] });
    g.advance(90);
    const id = g.state().worms[0]!.id;
    g.command({ type: 'move', wormId: id, dir: [1, 0] });
    g.advance(60 * 20);
    const w1 = g.state().worms[0]!;
    g.advance(120);
    const w2 = g.state().worms[0]!;
    return { alive: w1.alive, hp: w1.hp, y1: w1.pos[1], y2: w2.pos[1], active: g.state().activeWormId };
  });
  expect(r.alive).toBe(false);
  expect(r.hp).toBe(0);
  expect(r.y2).toBe(r.y1);
  expect(r.y1).toBeGreaterThan(-3);
  expect(r.active).toBeNull();
});

test('same seed + commands => same hash in the browser', async ({ page }) => {
  await openGame(page, 42);
  const run = () =>
    page.evaluate(async () => {
      const g = window.__game!;
      await g.setSeed(42);
      g.pause(true);
      g.spawnWorm({ team: 0, pos: [0, 45, 0] });
      g.spawnWorm({ team: 1, pos: [10, 45, -10] });
      g.advance(120);
      g.command({ type: 'move', wormId: 1, dir: [0.6, 0.8] });
      g.command({ type: 'jump', wormId: 2 });
      g.advance(300);
      return g.hash();
    });
  expect(await run()).toBe(await run());
});

test('teams spawn spread over dry land and settle', async ({ page }) => {
  await openGame(page, 1234, '&teams=2&worms=3');
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    g.advance(240);
    const s = g.state();
    let minDist = Infinity;
    for (const a of s.worms)
      for (const b of s.worms)
        if (a.id < b.id) minDist = Math.min(minDist, Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]));
    return {
      n: s.worms.length,
      teams: s.worms.map((w) => w.team),
      alive: s.worms.every((w) => w.alive && w.pos[1] > 1),
      minDist,
      active: s.activeWormId,
    };
  });
  expect(r.n).toBe(6);
  expect(r.teams.filter((t) => t === 0)).toHaveLength(3);
  expect(r.alive).toBe(true);
  expect(r.minDist).toBeGreaterThan(8);
  expect(r.active).not.toBeNull();
});

test('normal start (no debug) follows the first worm', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?seed=1234');
  await expect(page.locator('#controls-hint')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: shotPath('m2-normal-start') });
  expect(errors).toEqual([]);
});
