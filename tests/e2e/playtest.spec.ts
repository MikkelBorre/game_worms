import { test } from '@playwright/test';
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
