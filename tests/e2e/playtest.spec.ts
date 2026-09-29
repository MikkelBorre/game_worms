import { expect, test } from '@playwright/test';
import { openGame, shotPath } from './helpers';

/**
 * Deterministic visual scenarios. Screenshots land in test-results/playtest/ and are reviewed by eye.
 * Perf is printed so the playtest/perf-check skills can compare with the budget in CLAUDE.md.
 */

test('overview of island', async ({ page }) => {
  await openGame(page, 1234);
  await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    g.camera([0, 90, 140], [0, 0, 0]);
    g.renderFrames(30);
  });
  await page.screenshot({ path: shotPath('overview-seed1234') });
});

test('perf after 600 ticks', async ({ page }) => {
  await openGame(page, 1);
  await page.evaluate(() => window.__game!.camera([0, 60, 110], [0, 5, 0]));
  await page.waitForTimeout(3000); // real-time frames for fps
  const perf = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(600);
    const s = g.state();
    return { perf: s.perf, terrain: s.terrain };
  });
  console.log('PERF', JSON.stringify(perf));
  await page.screenshot({ path: shotPath('perf-seed1') });
});

test('water shoreline close-up', async ({ page }) => {
  const errors = await openGame(page, 1234);
  const perf = await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    // A worm hovering over the shallows shows shadows on the water.
    g.spawnWorm({ team: 0, pos: [20, 3, 58] });
    g.advance(1);
    g.camera([30, 7, 72], [8, 0, 40]);
    // Few large steps (1.5 s of wave/foam time). Queuing many heavy frames in one task starves swiftshader.
    g.renderFrames(6, 0.25);
    return g.state().perf;
  });
  await page.waitForTimeout(1000);
  console.log('PERF shoreline', JSON.stringify(perf));
  await page.screenshot({ path: shotPath('water-shoreline') });
  expect(errors).toEqual([]);
});

test('horizon and fog towards the sun', async ({ page }) => {
  await openGame(page, 1234);
  await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    // Sun sits to the north-west (-x, -z); look past the island towards it for glints + haze.
    g.camera([70, 12, 90], [-40, 8, -60]);
    g.renderFrames(4, 0.25);
  });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: shotPath('horizon-fog') });
});

test('terrain shading and shadows close-up', async ({ page }) => {
  await openGame(page, 1234);
  await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    // Sun behind the camera (north-west): lit faces, cast shadows falling away from the camera.
    g.camera([-55, 38, -40], [5, 10, 5]);
    g.renderFrames(3);
  });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: shotPath('terrain-closeup') });
});

test('overview orbit mode', async ({ page }) => {
  await openGame(page, 1234);
  const mode = await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    g.cameraMode('overview');
    // Few, large steps (dt is capped at 0.1 s by the rig).
    g.renderFrames(12, 0.1);
    return g.state().camera.mode;
  });
  await page.waitForTimeout(1000);
  console.log('camera mode', mode);
  await page.screenshot({ path: shotPath('overview-orbit') });
});

test('camera rig: setPose is stable, Tab toggles, WASD flies', async ({ page }) => {
  const errors = await openGame(page, 1234);
  const still = await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    g.camera([10, 20, 60], [0, 5, 0]);
    const a = g.state().camera.pos;
    g.renderFrames(60);
    const b = g.state().camera.pos;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  });
  expect(still).toBeLessThan(1e-4);

  await page
    .locator('#game')
    .focus()
    .catch(() => {});
  await page.keyboard.down('KeyW');
  const moved = await page.evaluate(() => {
    const g = window.__game!;
    const a = g.state().camera.pos;
    g.renderFrames(30); // 0.5 s
    const b = g.state().camera.pos;
    return { dz: b[2] - a[2], mode: g.state().camera.mode };
  });
  await page.keyboard.up('KeyW');
  expect(moved.mode).toBe('free');
  expect(moved.dz).toBeLessThan(-3); // flew towards the target (−z)

  await page.keyboard.press('Tab');
  const mode = await page.evaluate(() => {
    const g = window.__game!;
    g.renderFrames(30, 1 / 10);
    return g.state().camera.mode;
  });
  expect(mode).toBe('overview');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => window.__game!.state().camera.mode)).toBe('free');
  expect(errors).toEqual([]);
});
