import type { Game } from '../game';

/** Small fps / sim-ms overlay. Toggle with F3. */
export function createDebugOverlay(game: Game, parent: HTMLElement, visible: boolean): void {
  const el = document.createElement('pre');
  el.id = 'debug-overlay';
  el.style.display = visible ? 'block' : 'none';
  parent.appendChild(el);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
  });
  const f = (n: number, d = 1) => n.toFixed(d);
  setInterval(() => {
    if (el.style.display === 'none') return;
    const s = game.state();
    const p = s.perf;
    el.textContent =
      `fps ${f(p.fps, 0)}  frame ${f(p.frameMsAvg)}ms p95 ${f(p.frameMsP95)}ms\n` +
      `sim ${f(p.simMsAvg, 2)}ms max ${f(p.simMsMax, 2)}ms  tick ${s.tick}\n` +
      `draws ${p.drawCalls}  tris ${(p.triangles / 1000).toFixed(0)}k\n` +
      `chunks ${s.terrain.nonEmptyChunks}/${s.terrain.chunkCount}  build ${f(s.terrain.fullBuildMs, 0)}ms\n` +
      `seed ${s.seed}  cam ${s.camera.mode}`;
  }, 250);
}
