/**
 * Turn system (GDD "Kerne-loop", ROADMAP M4): hotseat turns, per-team worm rotation, timers, settle, victory.
 *
 * Conceptual flow: select → move (walk/aim/fire) → retreat → settle → resolve → select … The instant steps
 * (select, resolve) and the sub-steps of move (aim, fire) are not phases of their own; the explicit, typed
 * phases are
 *
 *   idle ──startMatch──▶ move ──fire──▶ retreat ──timer──▶ settle ──resolve──▶ move (next team)
 *                         │  └──timer / endTurn / active worm died──────────▶ settle ──resolve──▶ gameOver
 *
 * Invalid transitions throw in dev builds (tests included).
 *
 * `sim.turn` is a plain object (TurnState) mutated in place every tick; render/UI read it, only commands
 * (`startMatch`, `endTurn`, worm commands) change it. Everything here counts sim ticks; no wall clock.
 * With `enabled === false` (before startMatch: free play / debug) the sim behaves exactly as without turns.
 */
import type { Vec2 } from '../core/math';
import { TICK_RATE } from '../core/loop';
import { windFromSeed } from './wind';
import type { SimWorld } from './world';

// ---------------------------------------------------------------------------
// Balance constants – tweak here. Seconds are converted to 60 Hz ticks.
// ---------------------------------------------------------------------------

/** Move phase (walk, aim, fire). */
export const TURN_SECONDS = 45;
/** Retreat after firing: the worm may still move/jump, not fire. */
export const RETREAT_SECONDS = 5;
/** Settle ends at the latest after this long, even if something is still moving. */
export const SETTLE_MAX_SECONDS = 8;
/** Settle ends early after this many consecutive quiet ticks (0.5 s). */
export const SETTLE_QUIET_TICKS = 30;
/** A grounded worm slower than this (m/s) counts as at rest for settle. */
export const SETTLE_SPEED = 0.1;
/** Shots per turn (MVP weapons are all single-shot). */
export const SHOTS_PER_TURN = 1;
/** startMatch overrides are clamped to these ranges (seconds). */
export const TURN_SECONDS_RANGE = { min: 5, max: 300 } as const;
export const RETREAT_SECONDS_RANGE = { min: 0, max: 30 } as const;

// ---------------------------------------------------------------------------

export type TurnPhase = 'idle' | 'move' | 'retreat' | 'settle' | 'gameOver';

export interface TurnState {
  /** false until startMatch; free-play/debug mode keeps the pre-M4 behaviour. */
  enabled: boolean;
  phase: TurnPhase;
  /** 1-based turn counter (0 before the match). */
  turn: number;
  /** Active team id (-1 before the match). */
  team: number;
  /** Active worm (null before the match and after gameOver). */
  wormId: number | null;
  /** Ticks left in the current phase (move: turn timer; retreat: retreat timer; settle: timeout). */
  phaseTicksLeft: number;
  /** Shots left this turn. */
  shotsLeft: number;
  /** Winning team id, -1 = draw, null = ongoing. */
  winner: number | null;
  /** Team ids still alive, in turn order. */
  teams: number[];
  // ---- additions beyond the M4 UI contract ----
  /** Turn timer (ticks): counts down in move, frozen once the worm has fired / the turn ended. */
  turnTicksLeft: number;
  /** Full move-phase length (ticks) of this match, for timer bars. */
  turnTicks: number;
  /** Full retreat length (ticks) of this match. */
  retreatTicks: number;
  /** Consecutive quiet ticks in settle (see SETTLE_QUIET_TICKS). */
  quietTicks: number;
  /** All teams of the match (incl. eliminated) in turn order. */
  order: number[];
  /** Per team in `order`: the worm that played that team's last turn (rotation), or null. */
  lastWorm: (number | null)[];
}

export interface TurnEvents {
  /** New turn (emitted after `windChanged` and `turnPhase {move}`; sim.turn is fully updated). */
  turnStarted: { turn: number; team: number; wormId: number; wind: Vec2 };
  /** Every phase change. */
  turnPhase: { phase: TurnPhase; turn: number };
  /** Resolve: the turn is over (before the next `turnStarted` or `gameOver`). */
  turnEnded: { turn: number; team: number; wormId: number | null };
  /** Winner team id, or -1 for a draw. */
  gameOver: { winner: number };
}

export interface StartMatchOptions {
  turnSeconds?: number;
  retreatSeconds?: number;
  firstTeam?: number;
}

const TRANSITIONS: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  idle: ['move'],
  move: ['retreat', 'settle'],
  retreat: ['settle'],
  settle: ['move', 'gameOver'],
  gameOver: [],
};

const PHASE_CODE: Readonly<Record<TurnPhase, number>> = {
  idle: 0,
  move: 1,
  retreat: 2,
  settle: 3,
  gameOver: 4,
};

/** Vite sets DEV; plain Node (scripts) has no import.meta.env – treat as dev. */
const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? true;

export function initialTurnState(): TurnState {
  return {
    enabled: false,
    phase: 'idle',
    turn: 0,
    team: -1,
    wormId: null,
    phaseTicksLeft: 0,
    shotsLeft: 0,
    winner: null,
    teams: [],
    turnTicksLeft: 0,
    turnTicks: TURN_SECONDS * TICK_RATE,
    retreatTicks: RETREAT_SECONDS * TICK_RATE,
    quietTicks: 0,
    order: [],
    lastWorm: [],
  };
}

type WormCommandType = 'move' | 'jump' | 'face' | 'fire';

/** Owns the TurnState of one SimWorld. Driven by SimWorld: commands in apply(), update() once per tick. */
export class TurnSystem {
  readonly s: TurnState = initialTurnState();

  constructor(private readonly sim: SimWorld) {}

  // ---- commands ----------------------------------------------------------------------------------------------

  /** `startMatch` command. Returns the reason if ignored. */
  startMatch(opts: StartMatchOptions): string | null {
    const t = this.s;
    if (t.enabled) return 'match already started';
    const teams = [...new Set(this.sim.worms.filter((w) => w.alive).map((w) => w.team))].sort(
      (a, b) => a - b,
    );
    if (teams.length < 2) return 'need at least 2 teams with living worms';
    const first = finite(opts.firstTeam) ? opts.firstTeam : teams[0]!;
    // Ascending order starting at firstTeam (or the next team id above it, wrapping around).
    let k = teams.findIndex((id) => id >= first);
    if (k < 0) k = 0;
    t.order = [...teams.slice(k), ...teams.slice(0, k)];
    t.lastWorm = t.order.map(() => null);
    t.teams = [...t.order];
    t.turnTicks = secondsToTicks(opts.turnSeconds, TURN_SECONDS, TURN_SECONDS_RANGE);
    t.retreatTicks = secondsToTicks(opts.retreatSeconds, RETREAT_SECONDS, RETREAT_SECONDS_RANGE);
    t.enabled = true;
    t.turn = 0;
    t.winner = null;
    this.beginTurn(t.order[0]!);
    return null;
  }

  /** `endTurn` command: skip the rest of move / retreat. Returns the reason if ignored. */
  endTurn(): string | null {
    const t = this.s;
    if (!t.enabled) return 'no match running';
    if (t.phase !== 'move' && t.phase !== 'retreat') return `cannot end turn in ${t.phase} phase`;
    this.enterSettle();
    return null;
  }

  /**
   * Gate for worm commands (after the sim checked that the worm exists and is alive). Returns the reason the
   * command is ignored, or null if it may run. Always null while turns are disabled.
   */
  gate(type: WormCommandType, wormId: number): string | null {
    const t = this.s;
    if (!t.enabled) return null;
    if (t.phase === 'gameOver') return 'game over';
    if (wormId !== t.wormId) return 'not your turn';
    if (t.phase === 'settle') return 'turn is settling';
    if (type === 'fire' && (t.phase !== 'move' || t.shotsLeft <= 0)) return 'no shots left';
    return null;
  }

  /** A `fire` command was accepted (ammo already taken). */
  onFired(): void {
    const t = this.s;
    if (!t.enabled || t.phase !== 'move') return;
    t.shotsLeft = Math.max(0, t.shotsLeft - 1);
    if (t.shotsLeft > 0) return;
    if (t.retreatTicks > 0) {
      this.to('retreat');
      t.phaseTicksLeft = t.retreatTicks;
      this.emitPhase();
    } else this.enterSettle();
  }

  // ---- per tick ----------------------------------------------------------------------------------------------

  /** Once per tick, after physics (worm deaths, projectile removal and explosions of this tick are known). */
  update(): void {
    const t = this.s;
    if (!t.enabled) return;
    switch (t.phase) {
      case 'move':
        if (!this.activeAlive()) return this.enterSettle();
        t.phaseTicksLeft = Math.max(0, t.phaseTicksLeft - 1);
        t.turnTicksLeft = t.phaseTicksLeft;
        if (t.phaseTicksLeft === 0) this.enterSettle();
        return;
      case 'retreat':
        if (!this.activeAlive()) return this.enterSettle();
        t.phaseTicksLeft = Math.max(0, t.phaseTicksLeft - 1);
        if (t.phaseTicksLeft === 0) this.enterSettle();
        return;
      case 'settle':
        t.phaseTicksLeft = Math.max(0, t.phaseTicksLeft - 1);
        t.quietTicks = this.quiet() ? t.quietTicks + 1 : 0;
        if (t.quietTicks >= SETTLE_QUIET_TICKS || t.phaseTicksLeft === 0) this.resolve();
        return;
      default:
        return;
    }
  }

  /** Nothing in flight, nothing pending, every living worm grounded and (nearly) still. */
  quiet(): boolean {
    const sim = this.sim;
    if (sim.projectiles.length > 0 || sim.scheduledExplosions > 0 || sim.pendingTerrainEdits > 0)
      return false;
    for (const w of sim.worms) {
      if (!w.alive) continue;
      if (sim.worm(w.id)?.resting) continue;
      if (!w.grounded || w.state === 'knocked') return false;
      if (Math.hypot(w.vel[0], w.vel[1], w.vel[2]) >= SETTLE_SPEED) return false;
    }
    return true;
  }

  /** Deterministic hash input (see SimWorld.hash). */
  hashInto(mix: (v: number) => void): void {
    const t = this.s;
    mix(t.enabled ? 1 : 0);
    if (!t.enabled) return;
    mix(PHASE_CODE[t.phase]);
    mix(t.turn);
    mix(t.team);
    mix(t.wormId ?? -1);
    mix(t.phaseTicksLeft);
    mix(t.turnTicksLeft);
    mix(t.shotsLeft);
    mix(t.winner ?? -2);
    mix(t.quietTicks);
    mix(t.turnTicks);
    mix(t.retreatTicks);
    for (const id of t.teams) mix(id);
    for (let i = 0; i < t.order.length; i++) {
      mix(t.order[i]!);
      mix(t.lastWorm[i] ?? -1);
    }
  }

  /** Deep copy for snapshots. */
  snapshot(): TurnState {
    const t = this.s;
    return { ...t, teams: [...t.teams], order: [...t.order], lastWorm: [...t.lastWorm] };
  }

  // ---- internals ---------------------------------------------------------------------------------------------

  private activeAlive(): boolean {
    const id = this.s.wormId;
    return id !== null && this.sim.worms.some((w) => w.id === id && w.alive);
  }

  private to(phase: TurnPhase): void {
    const from = this.s.phase;
    if (!TRANSITIONS[from].includes(phase)) {
      const msg = `invalid turn transition ${from} → ${phase}`;
      if (DEV) throw new Error(msg);
      console.error(msg);
    }
    this.s.phase = phase;
  }

  private emitPhase(): void {
    this.sim.events.emit('turnPhase', { phase: this.s.phase, turn: this.s.turn });
  }

  private enterSettle(): void {
    const t = this.s;
    this.to('settle');
    t.phaseTicksLeft = SETTLE_MAX_SECONDS * TICK_RATE;
    t.quietTicks = 0;
    // The active worm stops: no walking on after the timer, no queued jump.
    if (t.wormId !== null) this.sim.worm(t.wormId)?.stopInput();
    this.emitPhase();
  }

  /** Resolve (instant): count survivors, then the next team's next worm – or game over. */
  private resolve(): void {
    const t = this.s;
    this.sim.events.emit('turnEnded', { turn: t.turn, team: t.team, wormId: t.wormId });
    const alive = this.aliveTeams();
    t.teams = alive;
    if (alive.length <= 1) {
      this.to('gameOver');
      t.winner = alive[0] ?? -1;
      t.wormId = null;
      t.phaseTicksLeft = 0;
      t.shotsLeft = 0;
      t.quietTicks = 0;
      this.emitPhase();
      this.sim.events.emit('gameOver', { winner: t.winner });
      return;
    }
    const n = t.order.length;
    const cur = t.order.indexOf(t.team);
    let next = alive[0]!;
    for (let i = 1; i <= n; i++) {
      const team = t.order[(cur + i) % n]!;
      if (alive.includes(team)) {
        next = team;
        break;
      }
    }
    this.beginTurn(next);
  }

  /** Select: the team's next living worm after the one that played its last turn (spawn order, wrapping). */
  private beginTurn(team: number): void {
    const t = this.s;
    const idx = t.order.indexOf(team);
    const worms = this.sim.worms.filter((w) => w.team === team);
    const last = t.lastWorm[idx] ?? null;
    const start = last === null ? 0 : worms.findIndex((w) => w.id === last) + 1;
    let wormId: number | null = null;
    for (let i = 0; i < worms.length; i++) {
      const w = worms[(start + i) % worms.length]!;
      if (w.alive) {
        wormId = w.id;
        break;
      }
    }
    if (wormId === null) throw new Error(`beginTurn: team ${team} has no living worm`);
    t.lastWorm[idx] = wormId;
    this.to('move');
    t.turn++;
    t.team = team;
    t.wormId = wormId;
    t.phaseTicksLeft = t.turnTicks;
    t.turnTicksLeft = t.turnTicks;
    t.shotsLeft = SHOTS_PER_TURN;
    t.quietTicks = 0;
    const wind = windFromSeed(this.sim.seed, t.turn);
    this.sim.wind = wind;
    this.sim.events.emit('windChanged', { wind: [wind[0], wind[1]] });
    this.emitPhase();
    this.sim.events.emit('turnStarted', { turn: t.turn, team, wormId, wind: [wind[0], wind[1]] });
  }

  private aliveTeams(): number[] {
    const alive = new Set(this.sim.worms.filter((w) => w.alive).map((w) => w.team));
    return this.s.order.filter((team) => alive.has(team));
  }
}

const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function secondsToTicks(v: number | undefined, def: number, range: { min: number; max: number }): number {
  const sec = finite(v) ? Math.min(range.max, Math.max(range.min, v)) : def;
  return Math.round(sec * TICK_RATE);
}
