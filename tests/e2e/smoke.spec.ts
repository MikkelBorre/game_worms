import { expect, test } from '@playwright/test';
import { openGame } from './helpers';

test('boots, exposes __game and renders a non-blank frame', async ({ page }) => {
  const errors = await openGame(page, 1234);
  const state = await page.evaluate(() => window.__game!.state());
  expect(state.ready).toBe(true);
  expect(state.seed).toBe(1234);

  // Canvas must not be a single flat colour.
  const distinct = await page.evaluate(() => {
    const src = document.getElementById('game') as HTMLCanvasElement;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 36;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0, 64, 36);
    const d = ctx.getImageData(0, 0, 64, 36).data;
    const set = new Set<number>();
    for (let i = 0; i < d.length; i += 4)
      set.add((d[i]! >> 4) | ((d[i + 1]! >> 4) << 4) | ((d[i + 2]! >> 4) << 8));
    return set.size;
  });
  expect(distinct).toBeGreaterThan(4);
  expect(errors).toEqual([]);
});

test('advance() ticks the sim deterministically and spawned worms fall', async ({ page }) => {
  await openGame(page, 1234);
  const result = await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    const t0 = g.state().tick;
    g.spawnWorm({ team: 0, pos: [0, 45, 0] });
    g.advance(60);
    const s = g.state();
    return { dt: s.tick - t0, worms: s.worms };
  });
  expect(result.dt).toBe(60);
  expect(result.worms).toHaveLength(1);
  expect(result.worms[0]!.pos[1]).toBeLessThan(45);
});

test('setSeed rebuilds the world', async ({ page }) => {
  await openGame(page, 1234);
  const seed = await page.evaluate(async () => {
    await window.__game!.setSeed(77);
    return window.__game!.state().seed;
  });
  expect(seed).toBe(77);
});

test('no __game without ?debug=1', async ({ page }) => {
  await page.goto('/?seed=1');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => typeof window.__game)).toBe('undefined');
});

test('seed 0 is a valid seed and builds an island', async ({ page }) => {
  const errors = await openGame(page, 0);
  const s = await page.evaluate(() => window.__game!.state());
  expect(s.seed).toBe(0);
  expect(s.terrain.nonEmptyChunks).toBeGreaterThan(50);
  expect(errors).toEqual([]);
});
