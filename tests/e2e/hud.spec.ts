import { expect, test } from '@playwright/test';
import { openGame, shotPath } from './helpers';

// Screenshots of a full WebGL frame are slow under software GL; give these tests room.
test.setTimeout(240_000);

test('HUD: roster, minimap, name tags and weapon menu', async ({ page }) => {
  const errors = await openGame(page, 1234, '&hud=1&teams=2&worms=3');
  const state = await page.evaluate(() => {
    const g = window.__game!;
    g.pause(true);
    g.advance(90); // spawn + settle
    g.cameraMode('overview');
    g.renderFrames(30);
    return g.state();
  });
  expect(state.worms).toHaveLength(6);

  // Roster: 2 teams × 3 worms, the active worm highlighted.
  await expect(page.locator('.roster-team')).toHaveCount(2);
  await expect(page.locator('.roster-worm')).toHaveCount(6);
  await expect(page.locator('.roster-worm.is-active')).toHaveCount(1);
  await expect(page.locator('.roster-worm.is-active')).toHaveAttribute(
    'data-worm-id',
    String(state.activeWormId),
  );
  await expect(page.locator('.roster-worm').first()).toContainText('Konrad');

  // Minimap island raster is not blank (sea + sand + grass + rock).
  const colours = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.mm-map')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const set = new Set<number>();
    for (let i = 0; i < d.length; i += 16)
      set.add((d[i]! >> 4) | ((d[i + 1]! >> 4) << 4) | ((d[i + 2]! >> 4) << 8));
    return { size: c.width, distinct: set.size };
  });
  expect(colours.size).toBeGreaterThanOrEqual(128);
  expect(colours.distinct).toBeGreaterThan(20);

  // Name tags for worms on screen in the overview camera, positioned inside the viewport.
  const tags = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.hud-tag.is-visible')].map((t) => {
      const r = t.getBoundingClientRect();
      return { text: t.textContent, x: r.x + r.width / 2, y: r.bottom };
    }),
  );
  expect(tags.length).toBeGreaterThanOrEqual(3);
  for (const t of tags) {
    expect(t.x).toBeGreaterThan(0);
    expect(t.x).toBeLessThan(1280);
    expect(t.y).toBeGreaterThan(0);
    expect(t.y).toBeLessThan(720);
  }

  // Weapon card shows the placeholder weapon.
  await expect(page.locator('.hud-weapon .weapon-name')).toHaveText('Bazooka');
  await expect(page.locator('.hud-weapon .weapon-ammo')).toHaveText('∞');

  // Q opens the weapon menu with the current weapon selected.
  const menu = page.locator('.hud-weapon-menu');
  await expect(menu).toBeHidden();
  await page.keyboard.press('KeyQ');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.wm-item')).toHaveCount(9);
  await expect(menu.locator('.wm-item.is-selected')).toHaveAttribute('data-weapon', 'bazooka');
  await page.evaluate(() => window.__game!.renderFrames(2));
  // 'disabled' fast-forwards the menu's pop-in CSS animation to its end state.
  await page.screenshot({ path: shotPath('hud'), timeout: 180_000, animations: 'disabled' });

  // Picking a weapon closes the menu and updates the card (view-only until weapons exist in the sim).
  await menu.locator('.wm-item[data-weapon="grenade"]').click();
  await expect(menu).toBeHidden();
  await page.evaluate(() => window.__game!.renderFrames(1));
  await expect(page.locator('.hud-weapon .weapon-name')).toHaveText('Granat');

  expect(errors).toEqual([]);
});

test('HUD is off in debug mode without ?hud=1', async ({ page }) => {
  await openGame(page, 1234, '&teams=1&worms=1');
  await expect(page.locator('#hud')).toHaveCount(0);
});
