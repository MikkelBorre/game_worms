/**
 * Fire input: hold LEFT mouse while aiming (right mouse held → aim camera) to charge power 0→1 over
 * FIRE_INPUT.chargeTime; release (or reach full power) to send a `fire` Command. Q cycles weapons, 1–5 set the
 * grenade fuse. Never touches sim state (CLAUDE.md rule 2).
 *
 * Includes a tiny self-contained power meter / weapon label / crosshair in plain DOM; the HUD (src/ui) will
 * replace it and can read `weapon`, `timer`, `charging` and `power` from here (via Game).
 */
import type { Command } from '../core/commands';
import type { Vec3 } from '../core/math';
import { getWeapon, WEAPONS } from '../sim/weapons/registry';

export const FIRE_INPUT = {
  /** Seconds from 0 to full power (auto-fires at full power). */
  chargeTime: 1.5,
  /** Grenade fuse set by keys 1–5 (seconds). */
  timerKeys: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'] as const,
  cycleKey: 'KeyQ',
};

export interface FireHost {
  activeWormId(): number | null;
  /** True while the camera is in aim mode (right mouse held). */
  aiming(): boolean;
  /** True when WASD/keys belong to the worm (follow/aim), false in free/overview. */
  wormInputEnabled(): boolean;
  /** False while e.g. the active worm's projectile is still flying. */
  canFire(): boolean;
  /** Unit world aim direction (camera crosshair). */
  aimDirection(out: Vec3): Vec3;
  send(cmd: Command): void;
}

const LABELS: Record<string, string> = { bazooka: 'Bazooka', grenade: 'Granat' };

export class FireInput {
  /** Selected weapon id (registry). */
  weapon: string = WEAPONS[0]?.id ?? 'bazooka';
  /** Fuse (s) for usesTimer weapons. */
  timer = 3;
  charging = false;
  /** Current charge 0..1 (valid while charging). */
  power = 0;
  private readonly dir: Vec3 = [0, 0, 0];
  private readonly el: HTMLElement | null;
  private readonly fill: HTMLElement | null;
  private readonly label: HTMLElement | null;
  private readonly cross: HTMLElement | null;
  private lastLabel = '';
  private readonly onDown = (e: MouseEvent) => this.mouseDown(e);
  private readonly onUp = (e: MouseEvent) => this.mouseUp(e);
  private readonly onKey = (e: KeyboardEvent) => this.keyDown(e);
  private readonly onBlur = () => this.cancel();

  constructor(
    private readonly host: FireHost,
    private readonly dom: HTMLElement,
    ui: HTMLElement | null,
  ) {
    dom.addEventListener('mousedown', this.onDown);
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('blur', this.onBlur);
    if (ui) {
      this.el = document.createElement('div');
      this.el.id = 'fire-meter';
      this.el.style.cssText =
        'position:absolute;left:50%;bottom:52px;transform:translateX(-50%);min-width:220px;padding:6px 10px 8px;' +
        'background:rgba(15,20,30,0.72);border-radius:10px;color:#fff;font:600 13px/1.3 system-ui,sans-serif;' +
        'text-align:center;box-shadow:0 4px 14px rgba(0,0,0,0.3);display:none;';
      this.label = document.createElement('div');
      const bar = document.createElement('div');
      bar.style.cssText =
        'margin-top:5px;height:9px;border-radius:5px;background:rgba(255,255,255,0.18);overflow:hidden;';
      this.fill = document.createElement('div');
      this.fill.style.cssText =
        'height:100%;width:0%;border-radius:5px;background:linear-gradient(90deg,#ffe066,#ff9f1c 60%,#e8302a);';
      bar.appendChild(this.fill);
      this.el.append(this.label, bar);
      ui.appendChild(this.el);
      this.cross = document.createElement('div');
      this.cross.id = 'aim-crosshair';
      this.cross.style.cssText =
        'position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;display:none;' +
        'border:2px solid rgba(255,255,255,0.9);border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,0.35);';
      const dot = document.createElement('div');
      dot.style.cssText =
        'position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%;' +
        'background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,0.35);';
      this.cross.appendChild(dot);
      ui.appendChild(this.cross);
    } else {
      this.el = this.fill = this.label = this.cross = null;
    }
  }

  /** Per rendered frame: advance the charge, auto-fire at full power, refresh the meter. */
  update(rawDt: number): void {
    const dt = Math.min(Math.max(rawDt, 0), 0.1);
    const aiming = this.host.aiming() && this.host.activeWormId() !== null;
    if (this.charging) {
      if (!aiming) this.cancel();
      else {
        this.power = Math.min(1, this.power + dt / FIRE_INPUT.chargeTime);
        if (this.power >= 1) this.release();
      }
    }
    this.render(aiming);
  }

  /** Q cycles weapons only while no weapon menu owns the key (the HUD disables this). */
  cycleOnKey = true;

  /** Cycle to the next weapon in registry order. */
  cycleWeapon(): void {
    const i = WEAPONS.findIndex((w) => w.id === this.weapon);
    this.weapon = WEAPONS[(i + 1) % WEAPONS.length]!.id;
    this.cancel();
  }

  selectWeapon(id: string): void {
    if (getWeapon(id)) this.weapon = id;
  }

  private mouseDown(e: MouseEvent): void {
    if (e.button !== 0 || this.charging) return;
    if (!this.host.aiming() || this.host.activeWormId() === null || !this.host.canFire()) return;
    const w = getWeapon(this.weapon);
    if (!w) return;
    this.power = 0;
    this.charging = true;
    if (!w.usesPower) this.release();
  }

  private mouseUp(e: MouseEvent): void {
    if (e.button === 0 && this.charging) this.release();
  }

  private keyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.repeat || !this.host.wormInputEnabled()) return;
    if (e.code === FIRE_INPUT.cycleKey && this.cycleOnKey) {
      this.cycleWeapon();
      return;
    }
    const k = (FIRE_INPUT.timerKeys as readonly string[]).indexOf(e.code);
    if (k >= 0) this.timer = k + 1;
  }

  /** Fire with the current charge. */
  private release(): void {
    const id = this.host.activeWormId();
    const w = getWeapon(this.weapon);
    const power = this.power;
    this.charging = false;
    this.power = 0;
    if (id === null || !w || !this.host.canFire()) return;
    const [x, y, z] = this.host.aimDirection(this.dir);
    this.host.send({
      type: 'fire',
      wormId: id,
      weapon: w.id,
      dir: [x, y, z],
      power: w.usesPower ? power : 0,
      ...(w.usesTimer ? { timer: this.timer } : {}),
    });
  }

  private cancel(): void {
    this.charging = false;
    this.power = 0;
  }

  private render(aiming: boolean): void {
    if (!this.el || !this.fill || !this.label || !this.cross) return;
    const show = aiming || this.charging;
    this.el.style.display = show ? 'block' : 'none';
    this.cross.style.display = aiming ? 'block' : 'none';
    if (!show) return;
    const w = getWeapon(this.weapon);
    const name = LABELS[this.weapon] ?? w?.name ?? this.weapon;
    const text = `${name}${w?.usesTimer ? ` · ${this.timer} s` : ''}  —  hold venstre klik · Q våben${
      w?.usesTimer ? ' · 1–5 timer' : ''
    }`;
    if (text !== this.lastLabel) {
      this.label.textContent = text;
      this.lastLabel = text;
    }
    this.fill.style.width = `${Math.round(this.power * 100)}%`;
  }

  dispose(): void {
    this.dom.removeEventListener('mousedown', this.onDown);
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.el?.remove();
    this.cross?.remove();
  }
}
