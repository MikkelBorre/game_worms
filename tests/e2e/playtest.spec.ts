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

// ---------------------------------------------------------------------------------------------
// M2 – worms and cameras. Seed 1234 has a gentle sandy beach on the +Z side of the island
// (x ≈ 0, z ≈ 44–53 slopes from ~3 m down to the water). The sun is to the north-west (−Z), so worms
// facing −Z (yaw π) are front-lit for a camera standing inland of them.
// ---------------------------------------------------------------------------------------------

/** Spawn worms, let them land, and return their ids. Runs inside the page. */
async function spawnOnBeach(
  page: import('@playwright/test').Page,
  spots: { team: number; x: number; z: number }[],
): Promise<number[]> {
  return page.evaluate((spots) => {
    const g = window.__game!;
    g.pause(true);
    const before = g.state().worms.length;
    for (const s of spots) g.spawnWorm({ team: s.team, pos: [s.x, g.heightAt(s.x, s.z) + 1.2, s.z] });
    g.advance(90);
    return g
      .state()
      .worms.slice(before)
      .map((w) => w.id);
  }, spots);
}

/** Tick the sim and render in lock-step so render-time animations (walk cycle, blink, fx) advance. */
async function stepAndRender(page: import('@playwright/test').Page, ticks: number, every = 2) {
  await page.evaluate(
    ([ticks, every]) => {
      const g = window.__game!;
      for (let i = 0; i < ticks; i += every) {
        g.advance(every);
        g.renderFrames(1, every / 60);
      }
    },
    [ticks, every] as const,
  );
}

test('worm close-up: four teams on the beach', async ({ page }) => {
  const errors = await openGame(page, 1234);
  const ids = await spawnOnBeach(page, [
    { team: 0, x: -1.8, z: 46 },
    { team: 1, x: -0.6, z: 46 },
    { team: 2, x: 0.6, z: 46 },
    { team: 3, x: 1.8, z: 46 },
  ]);
  const perf = await page.evaluate((ids) => {
    const g = window.__game!;
    // Face inland (towards the sun and the camera), slightly varied.
    ids.forEach((id, i) => g.command({ type: 'face', wormId: id, yaw: Math.PI + (i - 1.5) * 0.18 }));
    g.advance(1);
    g.renderFrames(20, 1 / 30); // let the visual yaw settle
    const h = g.heightAt(0, 46);
    g.camera([0.3, h + 1.35, 42.6], [0, h + 0.6, 46]);
    g.renderFrames(2, 1 / 30);
    return g.state().perf;
  }, ids);
  console.log('PERF worm close-up', JSON.stringify(perf));
  await page.screenshot({ path: shotPath('worm-closeup') });
  expect(errors).toEqual([]);
});

test('worm walking mid-stride (side view)', async ({ page }) => {
  const errors = await openGame(page, 1234);
  const [id] = await spawnOnBeach(page, [{ team: 1, x: -3, z: 46 }]);
  await page.evaluate((id) => {
    window.__game!.command({ type: 'move', wormId: id!, dir: [1, 0] });
  }, id);
  await stepAndRender(page, 48, 6);
  await page.evaluate((id) => {
    const g = window.__game!;
    const w = g.state().worms.find((x) => x.id === id)!;
    // Side view from inland (−Z), sun behind-left of the camera.
    g.camera([w.pos[0] + 0.4, w.pos[1] + 0.9, w.pos[2] - 3.4], [w.pos[0] + 0.2, w.pos[1] - 0.05, w.pos[2]]);
  }, id);
  await page.screenshot({ path: shotPath('worm-walking') });
  const st = await page.evaluate((id) => window.__game!.state().worms.find((x) => x.id === id)!.state, id);
  expect(st).toBe('walk');
  expect(errors).toEqual([]);
});

test('worm backflip mid-air', async ({ page }) => {
  const errors = await openGame(page, 1234);
  const [id] = await spawnOnBeach(page, [{ team: 2, x: 0, z: 46 }]);
  const info = await page.evaluate((id) => {
    const g = window.__game!;
    g.command({ type: 'face', wormId: id!, yaw: Math.PI / 2 }); // face +X, flip goes towards −X
    g.advance(2);
    g.command({ type: 'jump', wormId: id!, kind: 'backflip' });
    // ~0.6 s of a ~1.4 s flight: just past the apex → worm upside down-ish.
    for (let i = 0; i < 40; i += 2) {
      g.advance(2);
      g.renderFrames(1, 2 / 60);
    }
    const w = g.state().worms.find((x) => x.id === id)!;
    g.camera([w.pos[0] - 0.6, w.pos[1] + 0.4, w.pos[2] - 4.2], [w.pos[0] - 0.3, w.pos[1] - 0.3, w.pos[2]]);
    return { state: w.state, y: w.pos[1], ground: g.heightAt(w.pos[0], w.pos[2]) };
  }, id);
  console.log('backflip', JSON.stringify(info));
  await page.screenshot({ path: shotPath('worm-backflip') });
  expect(info.state).toBe('backflip');
  expect(errors).toEqual([]);
});

test('follow camera behind the active worm', async ({ page }) => {
  const errors = await openGame(page, 1234);
  const [id] = await spawnOnBeach(page, [
    { team: 3, x: 0, z: 45 },
    { team: 0, x: 3, z: 49 },
  ]);
  const cam = await page.evaluate((id) => {
    const g = window.__game!;
    g.selectWorm(id!);
    g.command({ type: 'face', wormId: id!, yaw: Math.PI * 0.8 }); // towards the sun
    g.advance(1);
    g.cameraMode('follow');
    g.renderFrames(40, 1 / 20); // damped swoop from the overview pose
    return g.state().camera;
  }, id);
  console.log('follow camera', JSON.stringify(cam));
  await page.screenshot({ path: shotPath('camera-follow') });
  expect(cam.mode).toBe('follow');
  expect(errors).toEqual([]);
});

test('aim camera over the shoulder', async ({ page }) => {
  const errors = await openGame(page, 1234);
  const [id] = await spawnOnBeach(page, [
    { team: 1, x: 0, z: 45 },
    { team: 2, x: -2.5, z: 40 },
  ]);
  const cam = await page.evaluate((id) => {
    const g = window.__game!;
    g.selectWorm(id!);
    g.command({ type: 'face', wormId: id!, yaw: Math.PI });
    g.advance(1);
    g.cameraMode('follow');
    g.renderFrames(30, 1 / 20);
    g.cameraMode('aim');
    g.renderFrames(30, 1 / 20);
    return g.state().camera;
  }, id);
  console.log('aim camera', JSON.stringify(cam));
  await page.screenshot({ path: shotPath('camera-aim') });
  expect(cam.mode).toBe('aim');
  expect(errors).toEqual([]);
});

test('worm walks into the sea: splash', async ({ page }) => {
  const errors = await openGame(page, 1234);
  const [id] = await spawnOnBeach(page, [{ team: 0, x: 0, z: 50.5 }]);
  const res = await page.evaluate((id) => {
    const g = window.__game!;
    g.command({ type: 'move', wormId: id!, dir: [0, 1] });
    const alive = () => g.state().worms.find((x) => x.id === id)!.alive;
    // Coarse chunks: every advance() renders a frame, and many queued heavy frames starve swiftshader.
    let ticks = 0;
    while (alive() && ticks < 600) {
      g.advance(20);
      ticks += 20;
    }
    g.renderFrames(5, 1 / 30); // ~0.2 s into the splash
    const w = g.state().worms.find((x) => x.id === id)!;
    g.camera([w.pos[0] - 3.5, 2.2, w.pos[2] - 4.5], [w.pos[0], 0.5, w.pos[2]]);
    return { ticks, alive: w.alive, pos: w.pos };
  }, id);
  console.log('splash', JSON.stringify(res));
  await page.screenshot({ path: shotPath('worm-splash') });
  expect(res.alive).toBe(false);
  expect(errors).toEqual([]);
});
