import { expect, type Page } from '@playwright/test';
import type { GameTestApi } from '../../src/debug/testApi';

export type GameApi = GameTestApi;

/** Load the game in debug mode with a fixed seed and wait for __game.ready. Returns collected page errors. */
export async function openGame(page: Page, seed = 1234, extra = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(`/?debug=1&seed=${seed}${extra}`);
  await page.waitForFunction(() => window.__game?.ready === true, undefined, { timeout: 60_000 });
  await expect(page.locator('#fatal')).toHaveCount(0);
  return errors;
}

export const shotPath = (name: string) => `test-results/playtest/${name}.png`;
