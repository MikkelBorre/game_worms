import type { Command } from '../core/commands';
import type { Vec2 } from '../core/math';
import { moveDirFromKeys, sameDir, type MoveKeys } from './moveDir';

export interface ControlsHost {
  /** Worm currently controlled by the local player, or null. */
  activeWormId(): number | null;
  /** Camera heading in the worm yaw convention (forward = [sin h, cos h]). */
  heading(): number;
  /** True when WASD belongs to the worm (follow/aim camera), false in free-fly/overview. */
  wormInputEnabled(): boolean;
  send(cmd: Command): void;
  /** Cycle to the next worm (debug/hotseat helper until the turn system exists). */
  nextWorm(): void;
}

const KEYMAP: Record<string, keyof MoveKeys> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/**
 * Keyboard → Commands. Never touches sim state directly (CLAUDE.md rule 2).
 * Mouse look / aim / Tab are owned by the camera rig.
 */
export class Controls {
  private keys: MoveKeys = { forward: false, back: false, left: false, right: false };
  private lastDir: Vec2 = [0, 0];
  private lastWorm: number | null = null;
  private readonly onDown = (e: KeyboardEvent) => this.keyDown(e);
  private readonly onUp = (e: KeyboardEvent) => this.keyUp(e);
  private readonly onBlur = () => this.releaseAll();

  constructor(
    private readonly host: ControlsHost,
    private readonly target: Window = window,
  ) {
    target.addEventListener('keydown', this.onDown);
    target.addEventListener('keyup', this.onUp);
    target.addEventListener('blur', this.onBlur);
  }

  /** Call once per rendered frame: emits a move command when the resolved direction changes. */
  update(): void {
    const id = this.host.activeWormId();
    if (id !== this.lastWorm) {
      // Stop the previously controlled worm so it doesn't keep walking after a switch.
      if (this.lastWorm !== null && (this.lastDir[0] !== 0 || this.lastDir[1] !== 0)) {
        this.host.send({ type: 'move', wormId: this.lastWorm, dir: [0, 0] });
      }
      this.lastWorm = id;
      this.lastDir = [0, 0];
    }
    if (id === null) return;
    const dir: Vec2 = this.host.wormInputEnabled() ? moveDirFromKeys(this.keys, this.host.heading()) : [0, 0];
    if (!sameDir(dir, this.lastDir)) {
      this.lastDir = dir;
      this.host.send({ type: 'move', wormId: id, dir });
    }
  }

  private keyDown(e: KeyboardEvent): void {
    const k = KEYMAP[e.code];
    if (k) {
      this.keys[k] = true;
      return;
    }
    if (e.repeat) return;
    const id = this.host.activeWormId();
    if (e.code === 'Space' && id !== null && this.host.wormInputEnabled()) {
      e.preventDefault();
      this.host.send({ type: 'jump', wormId: id });
    } else if (e.code === 'KeyN') {
      this.host.nextWorm();
    }
  }

  private keyUp(e: KeyboardEvent): void {
    const k = KEYMAP[e.code];
    if (k) this.keys[k] = false;
  }

  private releaseAll(): void {
    this.keys = { forward: false, back: false, left: false, right: false };
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onDown);
    this.target.removeEventListener('keyup', this.onUp);
    this.target.removeEventListener('blur', this.onBlur);
  }
}
