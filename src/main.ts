import './style.css';
import { Game } from './game';
import { createDebugOverlay } from './debug/overlay';
import { installTestApi } from './debug/testApi';
import { parseSeed } from './core/seed';
import { attachHud } from './ui/gameHud';

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

  const count = (key: string, fallback: number, max: number) => {
    const n = Number.parseInt(params.get(key) ?? '', 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : fallback;
  };
  const teams = count('teams', debug ? 0 : 2, 4);
  const wormsPerTeam = count('worms', 3, 4);

  const game = await Game.create(canvas, { seed, debug, teams, wormsPerTeam });
  loading.remove();
  // HUD: always shown in normal play. In debug mode (tests/screenshots) it is OFF unless ?hud=1, so the
  // existing e2e screenshots stay comparable and HUD-free. ?hud=demo also fakes timer + wind (layout preview).
  const hudParam = params.get('hud');
  const showHud = !debug || hudParam === '1' || hudParam === 'demo';
  if (showHud) {
    game.hud = attachHud(game, ui, { demo: hudParam === 'demo' });
    game.hud.setHeightmap(game.terrain.heightmap(256)); // later reloads call it from Game.load()
    document.body.classList.add('hud-on');
    // Debug-only handle for HUD cost measurements (tests use window.__game only).
    if (debug) (window as unknown as { __hud?: unknown }).__hud = game.hud;
  }
  createDebugOverlay(game, ui, debug);
  if (!debug) showControlsHint(ui);
  if (debug) installTestApi(game);
}

function showControlsHint(ui: HTMLElement): void {
  const el = document.createElement('div');
  el.id = 'controls-hint';
  el.innerHTML =
    '<b>WASD</b> gå · <b>Space</b> hop (2× = backflip) · <b>Mus</b> kig (klik for at låse) · ' +
    '<b>Højreklik</b> sigt · <b>Q</b> våben · <b>Tab</b> oversigt · <b>N</b> næste orm';
  ui.appendChild(el);
}

main().catch((err: unknown) => {
  console.error(err);
  const el = document.createElement('pre');
  el.id = 'fatal';
  el.textContent = `WormWorld crashed:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  document.body.appendChild(el);
});
