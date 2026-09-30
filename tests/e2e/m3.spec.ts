import { expect, test, type Page } from '@playwright/test';
import type { Vec3 } from '../../src/core/math';
import { openGame, shotPath } from './helpers';

// Software WebGL on a loaded CI box can be slow: give frames/screenshots room.
test.setTimeout(240_000);
const SHOT_TIMEOUT = 120_000;

/** Flat dry spot with ~20 m of gently varying ground along +x (room for a bazooka shot). */
async function launchSpot(page: Page): Promise<Vec3> {
  return page.evaluate(() => {
    const g = window.__game!;
    for (let r = 0; r < 60; r += 2)
      for (let a = 0; a < 16; a++) {
        const x = Math.cos((a / 16) * Math.PI * 2) * r;
        const z = Math.sin((a / 16) * Math.PI * 2) * r;
        const h = g.heightAt(x, z);
        let ok = h > 4 && h < 20;
        for (let d = 1; d <= 20 && ok; d++) ok = Math.abs(g.heightAt(x + d, z) - h) < 3;
        if (ok) return [x, h + 1.2, z] as Vec3;
      }
    throw new Error('no launch spot');
  });
}

/** Spawn one worm, settle it, make it active and put the camera behind it facing +x. */
async function setup(page: Page): Promise<{ spot: Vec3; id: number }> {
  const spot = await launchSpot(page);
  const id = await page.evaluate((pos) => {
    const g = window.__game!;
    g.pause(true);
    g.setWind([0, 0]);
    g.spawnWorm({ team: 0, pos });
    g.advance(90);
    const id = g.state().activeWormId!;
    g.command({ type: 'face', wormId: id, yaw: Math.PI / 2 });
    g.advance(2);
    g.cameraMode('follow');
    g.selectWorm(id); // hard cut behind the worm
    g.renderFrames(20);
    return id;
  }, spot);
  return { spot, id };
}

test('bazooka: explosion carves a crater with fireball, smoke and debris', async ({ page }) => {
  const errors = await openGame(page, 1234);
  await setup(page);
  const r = await page.evaluate(async () => {
    const g = window.__game!;
    g.fire('bazooka', [0.8, 0.35, 0], 0.45);
    // Sync chunks are fine until the blast (no carve pending); each advance() renders one frame.
    for (let i = 0; i < 150 && g.state().explosions.length === 0; i++) {
      g.advance(3);
      g.renderFrames(1, 3 / 60); // advance() renders with dt 0 – age the trail like real time would
    }
    const e = g.state().explosions[0];
    if (!e) return null;
    // Frame the blast from the side where the terrain leaves the clearest view, a few frames into the fireball.
    const [ex, ey, ez] = e.pos;
    let best = { h: Infinity, x: ex, z: ez + 11 };
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const x = ex + Math.cos(a) * 11;
      const z = ez + Math.sin(a) * 11;
      let h = -Infinity; // worst terrain height above the sight line
      for (let f = 0.1; f <= 1; f += 0.1)
        h = Math.max(h, g.heightAt(ex + (x - ex) * f, ez + (z - ez) * f) - (ey + 4 * f));
      if (h < best.h) best = { h, x, z };
    }
    g.camera([best.x, ey + 4, best.z], [ex, ey + 0.8, ez]);
    g.renderFrames(4);
    const s = g.state();
    return { e, particles: s.fx.particles, explosions: s.fx.explosions, shake: s.fx.shake };
  });
  expect(r).not.toBeNull();
  expect(r!.e.kind).toBe('weapon');
  expect(r!.e.radius).toBeGreaterThan(2);
  expect(r!.explosions).toBe(1);
  expect(r!.particles).toBeGreaterThan(50);
  await page.screenshot({ path: shotPath('m3-bazooka-fireball'), timeout: SHOT_TIMEOUT });

  const after = await page.evaluate(async (pos) => {
    const g = window.__game!;
    await g.advanceAsync(1); // wait for the crater rebuild
    g.advance(39);
    g.renderFrames(8, 5 / 60);
    return { h: g.heightAt(pos[0], pos[2]), particles: g.state().fx.particles };
  }, r!.e.pos);
  // Impact point was on the surface; the carved sphere (r = 3) leaves a clearly lower floor.
  expect(after.h).toBeLessThan(r!.e.pos[1] - 1.5);
  expect(after.particles).toBeGreaterThan(0); // smoke still hanging, debris resting
  await page.screenshot({ path: shotPath('m3-bazooka-crater'), timeout: SHOT_TIMEOUT });
  expect(errors).toEqual([]);
});

test('grenade with a 2 s fuse explodes after ~120 ticks', async ({ page }) => {
  const errors = await openGame(page, 1234);
  await setup(page);
  const r = await page.evaluate(async () => {
    const g = window.__game!;
    const t0 = g.state().tick;
    g.fire('grenade', [0.7, 0.6, 0.2], 0.35, 2);
    g.advance(30);
    const mid = g.state();
    const p = mid.projectiles[0]!;
    g.camera([p.pos[0] - 1.2, p.pos[1] + 0.7, p.pos[2] + 1.6], p.pos);
    g.renderFrames(2);
    return { t0, visible: mid.fx.projectiles, weapon: p.weapon };
  });
  expect(r.weapon).toBe('grenade');
  expect(r.visible).toBe(1);
  await page.screenshot({ path: shotPath('m3-grenade'), timeout: SHOT_TIMEOUT });
  const boom = await page.evaluate(async () => {
    const g = window.__game!;
    for (let i = 0; i < 60 && g.state().explosions.length === 0; i++) g.advance(4);
    return g.state().explosions[0] ?? null;
  });
  expect(boom).not.toBeNull();
  // Fire command applies on tick t0 (+1 step), fuse = 120 ticks.
  expect(boom!.tick - r.t0).toBeGreaterThanOrEqual(118);
  expect(boom!.tick - r.t0).toBeLessThanOrEqual(124);
  expect(errors).toEqual([]);
});

test('projectile camera follows the rocket, holds on the blast, returns to the worm', async ({ page }) => {
  const errors = await openGame(page, 1234);
  const { id } = await setup(page);
  const r = await page.evaluate(async (id) => {
    const g = window.__game!;
    const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    g.fire('bazooka', [0.75, 0.6, 0.1], 0.85);
    let flight: { camToRocket: number; rocketToWorm: number; track: string } | null = null;
    for (let i = 0; i < 35; i++) {
      g.advance(2);
      g.renderFrames(1, 2 / 60);
    }
    const s = g.state();
    const p = s.projectiles[0];
    const w = s.worms.find((x) => x.id === id)!;
    if (p)
      flight = {
        camToRocket: dist(s.camera.pos, p.pos),
        rocketToWorm: dist(p.pos, w.pos),
        track: s.camera.track,
      };
    return flight;
  }, id);
  expect(r).not.toBeNull();
  expect(r!.track).toBe('projectile');
  expect(r!.rocketToWorm).toBeGreaterThan(20);
  expect(r!.camToRocket).toBeLessThan(14);
  await page.screenshot({ path: shotPath('m3-projectile-cam'), timeout: SHOT_TIMEOUT });

  const after = await page.evaluate(async () => {
    const g = window.__game!;
    for (let i = 0; i < 200 && g.state().explosions.length === 0; i++) {
      g.advance(3);
      g.renderFrames(1, 3 / 60);
    }
    g.renderFrames(3);
    const hold = g.state().camera.track;
    g.renderFrames(12, 6 / 60); // > 1 s hold
    return { exploded: g.state().explosions.length, hold, back: g.state().camera.track };
  });
  expect(after.exploded).toBe(1);
  expect(after.hold).toBe('hold');
  expect(after.back).toBe('worm');
  expect(errors).toEqual([]);
});

test('mouse: right = aim, hold left = charge, release = fire', async ({ page }) => {
  const errors = await openGame(page, 1234);
  await setup(page);
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await expect.poll(() => page.evaluate(() => window.__game!.state().camera.mode)).toBe('aim');
  await page.mouse.down({ button: 'left' });
  await expect
    .poll(() => page.evaluate(() => window.__game!.state().weapon.power ?? 0), { timeout: 20_000 })
    .toBeGreaterThan(0.1);
  await page.screenshot({ path: shotPath('m3-aim-charge'), timeout: SHOT_TIMEOUT });
  await page.mouse.up({ button: 'left' });
  await page.mouse.up({ button: 'right' });
  const fired = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2);
    const s = g.state();
    return { n: s.projectiles.length, weapon: s.projectiles[0]?.weapon, power: s.weapon.power };
  });
  expect(fired.n).toBe(1);
  expect(fired.weapon).toBe('bazooka');
  expect(fired.power).toBeNull();

  // Q cycles to the grenade, 4 sets its fuse.
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('Digit4');
  const w = await page.evaluate(() => window.__game!.state().weapon);
  expect(w.selected).toBe('grenade');
  expect(w.timer).toBe(4);
  expect(errors).toEqual([]);
});
