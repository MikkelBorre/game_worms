import './style.css';
import { Game } from './game';
import { createDebugOverlay } from './debug/overlay';
import { installTestApi } from './debug/testApi';
import { parseSeed } from './core/seed';

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const debug = params.get('debug') === '1';
  const seed = parseSeed(params.get('seed'));

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const ui = document.getElementById('ui') as HTMLElement;
  const loading = document.createElement('div');
  loading.id = 'loading';
  loading.textContent = 'Genererer ø…';
  ui.appendChild(loading);

  const game = await Game.create(canvas, { seed, debug });
  loading.remove();
  createDebugOverlay(game, ui, debug);
  if (debug) installTestApi(game);
}

main().catch((err: unknown) => {
  console.error(err);
  const el = document.createElement('pre');
  el.id = 'fatal';
  el.textContent = `WormWorld crashed:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  document.body.appendChild(el);
});
