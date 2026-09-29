export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

export interface LoopCallbacks {
  /** Advance the simulation exactly one fixed tick. */
  step(): void;
  /** Render; alpha in [0,1) is the interpolation factor between the previous and current tick. */
  render(alpha: number, frameDt: number): void;
}

export interface PerfStats {
  fps: number;
  frameMsAvg: number;
  frameMsP95: number;
  simMsAvg: number;
  simMsMax: number;
  ticks: number;
}

const WINDOW = 120;

/** Rolling-window timing stats. */
export class PerfMeter {
  private frames: number[] = [];
  private sims: number[] = [];
  ticks = 0;

  addFrame(ms: number): void {
    this.frames.push(ms);
    if (this.frames.length > WINDOW) this.frames.shift();
  }

  addSim(ms: number): void {
    this.ticks++;
    this.sims.push(ms);
    if (this.sims.length > WINDOW) this.sims.shift();
  }

  stats(): PerfStats {
    const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    const sorted = [...this.frames].sort((a, b) => a - b);
    const p95 = sorted.length
      ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0)
      : 0;
    const frameMsAvg = avg(this.frames);
    return {
      fps: frameMsAvg > 0 ? 1000 / frameMsAvg : 0,
      frameMsAvg,
      frameMsP95: p95,
      simMsAvg: avg(this.sims),
      simMsMax: this.sims.length ? Math.max(...this.sims) : 0,
      ticks: this.ticks,
    };
  }
}

/**
 * Fixed-timestep loop (60 Hz sim) with interpolated rendering.
 * Wall-clock timing lives here (outside sim/) and never feeds into sim state.
 */
export class GameLoop {
  readonly perf = new PerfMeter();
  paused = false;
  private accumulator = 0;
  private last = 0;
  private rafId = 0;
  private running = false;
  private readonly maxStepsPerFrame = 5;

  constructor(
    private readonly cb: LoopCallbacks,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = this.now();
    const frame = () => {
      if (!this.running) return;
      this.frame(this.now());
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Process one frame at wall time `t` (ms). Exposed for tests. */
  frame(t: number): void {
    const dtMs = Math.min(t - this.last, 250);
    this.last = t;
    this.perf.addFrame(dtMs);
    if (!this.paused) {
      this.accumulator += dtMs / 1000;
      let steps = 0;
      while (this.accumulator >= TICK_DT && steps < this.maxStepsPerFrame) {
        this.tick();
        this.accumulator -= TICK_DT;
        steps++;
      }
      // Spiral-of-death guard: drop excess time instead of catching up forever.
      if (steps === this.maxStepsPerFrame) this.accumulator = 0;
    }
    this.cb.render(this.paused ? 1 : this.accumulator / TICK_DT, dtMs / 1000);
  }

  /** Run exactly n sim ticks synchronously (debug/test API). */
  advance(n: number): void {
    for (let i = 0; i < n; i++) this.tick();
    this.accumulator = 0;
    this.cb.render(1, 0);
  }

  private tick(): void {
    const t0 = this.now();
    this.cb.step();
    this.perf.addSim(this.now() - t0);
  }
}
