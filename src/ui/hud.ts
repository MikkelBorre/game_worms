/**
 * In-game HUD (plain DOM + CSS, see docs/ART_DIRECTION.md "HUD-layout").
 *
 * Pure view: `update(model)` is called every rendered frame with a HudModel built from sim/render state.
 * Every DOM write is behind a cached-value check, so a frame where nothing changed performs no DOM writes
 * and no layout reads. The HUD never mutates sim state; user choices (weapon menu) go out via callbacks.
 */
import type { HeightmapData } from '../terrain/types';
import { teamColor as defaultTeamColor } from '../render/palette';
import { ClassSlot, el, hexCss, shade, StyleSlot, TextSlot } from './dom';
import { GRAVESTONE_SVG, weaponIcon, WIND_ARROW_SVG, wormPortraitSvg } from './icons';
import { Minimap, type MinimapFrame } from './minimap';
import { NameTagLayer, type NameTag } from './nameTags';
import { WeaponMenu } from './weaponMenu';
import { DEFAULT_WEAPON_MENU, type WeaponMenuItem } from './weapons';

export interface HudWorm {
  id: number;
  name: string;
  hp: number;
  maxHp: number;
  alive: boolean;
}

export interface HudTeam {
  id: number;
  name: string;
  /** 0xRRGGBB */
  color: number;
  worms: HudWorm[];
}

export interface HudWeapon {
  id: string;
  name: string;
  /** Remaining ammo, -1 = infinite. */
  ammo: number;
  maxAmmo: number;
}

export interface HudMapWorm {
  id: number;
  team: number;
  x: number;
  z: number;
  alive: boolean;
}

export interface HudModel {
  teams: HudTeam[];
  activeWormId: number | null;
  weapon: HudWeapon | null;
  /** Seconds left of the current turn; null hides the timer. */
  turnTimeLeft: number | null;
  /** World-space wind [x, z]; |wind| = strength in 0..1 (clamped for display). null hides it. */
  wind: [number, number] | null;
  /** Camera heading (worm convention: forward = [sin h, 0, cos h]). */
  cameraHeading: number;
  wormsOnMap: HudMapWorm[];
  nameTags: NameTag[];
  /** Optional: camera XZ, used for the minimap arrow when there is no active worm. */
  cameraXZ?: [number, number] | null;
}

export interface HudOptions {
  teamColor?: (team: number) => number;
  weapons?: readonly WeaponMenuItem[];
  /** Weapon picked in the menu (view-only; caller decides what it means). */
  onSelectWeapon?: (id: string) => void;
  /** Whether Q may toggle the menu right now (e.g. false in free-fly camera where Q = down). */
  canToggleMenu?: () => boolean;
}

export interface Hud {
  readonly root: HTMLElement;
  update(model: HudModel): void;
  /** Rasterise the minimap island (once per heightmap). */
  setHeightmap(h: HeightmapData): void;
  setVisible(visible: boolean): void;
  /** Open/close the weapon menu (toggle without argument). */
  toggleWeaponMenu(open?: boolean): void;
  readonly weaponMenuOpen: boolean;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------------------------------

interface RosterRow {
  id: number;
  root: HTMLDivElement;
  portrait: HTMLDivElement;
  hpText: TextSlot;
  hpBar: StyleSlot;
  active: ClassSlot;
  dead: ClassSlot;
  alive: boolean | null;
  hp: number;
  maxHp: number;
  color: number;
}

interface RosterTeam {
  total: TextSlot;
  out: ClassSlot;
  hasActive: ClassSlot;
  /** Team HP bar in the header (only shown when the team is collapsed). */
  bar: StyleSlot;
  barKey: number;
}

class Roster {
  readonly root: HTMLDivElement;
  private rows = new Map<number, RosterRow>();
  private teams: RosterTeam[] = [];
  /** Structure signature pieces: team id, colour, name, worm count, then worm id + name per worm. */
  private sig: (number | string)[] = [];
  private readonly compact: ClassSlot;
  private readonly tiny: ClassSlot;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud-roster', parent);
    this.compact = new ClassSlot(this.root, 'is-compact');
    this.tiny = new ClassSlot(this.root, 'is-tiny');
  }

  update(teams: readonly HudTeam[], activeId: number | null): void {
    if (!this.sameStructure(teams)) this.rebuild(teams);
    for (let t = 0; t < teams.length; t++) {
      const team = teams[t]!;
      let sum = 0;
      let maxSum = 0;
      let alive = 0;
      let hasActive = false;
      for (const w of team.worms) {
        const row = this.rows.get(w.id)!;
        const hp = w.alive ? Math.max(0, Math.ceil(w.hp)) : 0;
        sum += hp;
        maxSum += w.maxHp;
        if (w.alive) alive++;
        if (w.id === activeId) hasActive = true;
        const hpKey = w.alive ? hp : -2; // -2: dead (empty text, empty bar)
        if (hpKey !== row.hp || w.maxHp !== row.maxHp) {
          row.hp = hpKey;
          row.maxHp = w.maxHp;
          row.hpText.set(w.alive ? String(hp) : '');
          row.hpBar.set(`scaleX(${Math.max(0, Math.min(1, hp / Math.max(1, w.maxHp))).toFixed(3)})`);
        }
        row.active.set(w.id === activeId && w.alive);
        row.dead.set(!w.alive);
        if (row.alive !== w.alive) {
          row.alive = w.alive;
          row.portrait.innerHTML = w.alive ? wormPortraitSvg(row.color) : GRAVESTONE_SVG;
        }
      }
      const rt = this.teams[t]!;
      rt.total.set(String(sum));
      rt.out.set(team.worms.length > 0 && alive === 0);
      rt.hasActive.set(hasActive);
      const barKey = Math.round((sum / Math.max(1, maxSum)) * 1000);
      if (barKey !== rt.barKey) {
        rt.barKey = barKey;
        rt.bar.set(`scaleX(${barKey / 1000})`);
      }
    }
  }

  private sameStructure(teams: readonly HudTeam[]): boolean {
    const s = this.sig;
    let i = 0;
    const eq = (v: number | string) => s[i++] === v;
    for (const t of teams) {
      if (!eq(t.id) || !eq(t.color) || !eq(t.name) || !eq(t.worms.length)) return false;
      for (const w of t.worms) if (!eq(w.id) || !eq(w.name)) return false;
    }
    return i === s.length;
  }

  private rebuild(teams: readonly HudTeam[]): void {
    this.root.replaceChildren();
    this.rows.clear();
    this.teams = [];
    const sig: (number | string)[] = [];
    let count = 0;
    for (const t of teams) {
      sig.push(t.id, t.color, t.name, t.worms.length);
      const block = el('div', 'roster-team', this.root);
      block.dataset.team = String(t.id);
      block.style.setProperty('--team', hexCss(t.color));
      block.style.setProperty('--team-light', hexCss(shade(t.color, 0.35)));
      const head = el('div', 'roster-team-head', block);
      el('span', 'roster-team-name', head, t.name);
      const total = el('span', 'roster-team-total', head);
      const teamBar = el('span', 'roster-team-bar', head);
      this.teams.push({
        total: new TextSlot(total),
        out: new ClassSlot(block, 'is-out'),
        hasActive: new ClassSlot(block, 'has-active'),
        bar: new StyleSlot(el('span', 'roster-team-bar-fill', teamBar), 'transform'),
        barKey: -1,
      });
      for (const w of t.worms) {
        sig.push(w.id, w.name);
        count++;
        const row = el('div', 'roster-worm', block);
        row.dataset.wormId = String(w.id);
        const portrait = el('div', 'roster-portrait', row);
        const info = el('div', 'roster-info', row);
        const line = el('div', 'roster-line', info);
        el('span', 'roster-name', line, w.name);
        const hpText = el('span', 'roster-hp', line);
        const bar = el('div', 'roster-bar', info);
        const fill = el('div', 'roster-bar-fill', bar);
        this.rows.set(w.id, {
          id: w.id,
          root: row,
          portrait,
          hpText: new TextSlot(hpText),
          hpBar: new StyleSlot(fill, 'transform'),
          active: new ClassSlot(row, 'is-active'),
          dead: new ClassSlot(row, 'is-dead'),
          alive: null,
          hp: -1,
          maxHp: -1,
          color: t.color,
        });
      }
    }
    this.sig = sig;
    // Shrink the list when many worms are in play so it never runs into the weapon card. On short
    // screens a crowded roster also collapses every team except the active one to a header + team HP bar.
    this.compact.set(count > 6 && count <= 10);
    this.tiny.set(count > 10);
  }
}

// ---------------------------------------------------------------------------------------------------
// Turn timer + wind (top centre)
// ---------------------------------------------------------------------------------------------------

class TurnInfo {
  readonly root: HTMLDivElement;
  private readonly timerBox: HTMLDivElement;
  private readonly windBox: HTMLDivElement;
  private readonly timerText: TextSlot;
  private readonly urgent: ClassSlot;
  private readonly windArrow: StyleSlot;
  private readonly windFill: StyleSlot;
  private readonly windText: TextSlot;
  private timerShown: boolean | null = null;
  private windShown: boolean | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud-turn', parent);
    this.timerBox = el('div', 'hud-panel turn-timer', this.root);
    el('span', 'turn-timer-icon', this.timerBox).innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13.5" r="8" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 13.5V9M9.5 2.5h5M18.5 6.5l1.5-1.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
    const tt = el('span', 'turn-timer-text', this.timerBox);
    this.timerText = new TextSlot(tt);
    this.urgent = new ClassSlot(this.timerBox, 'is-urgent');
    this.windBox = el('div', 'hud-panel turn-wind', this.root);
    el('span', 'turn-wind-label', this.windBox, 'Vind');
    const arrow = el('span', 'turn-wind-arrow', this.windBox);
    arrow.innerHTML = WIND_ARROW_SVG;
    this.windArrow = new StyleSlot(arrow, 'transform');
    const bar = el('span', 'turn-wind-bar', this.windBox);
    this.windFill = new StyleSlot(el('span', 'turn-wind-fill', bar), 'transform');
    this.windText = new TextSlot(el('span', 'turn-wind-text', this.windBox));
    this.timerBox.hidden = true;
    this.windBox.hidden = true;
  }

  update(time: number | null, wind: [number, number] | null, heading: number): void {
    const showTimer = time !== null;
    if (showTimer !== this.timerShown) this.timerBox.hidden = !(this.timerShown = showTimer);
    if (time !== null) {
      const s = Math.max(0, Math.ceil(time));
      this.timerText.set(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      this.urgent.set(s <= 10);
    }
    const showWind = wind !== null;
    if (showWind !== this.windShown) this.windBox.hidden = !(this.windShown = showWind);
    if (wind !== null) {
      const strength = Math.min(1, Math.hypot(wind[0], wind[1]));
      // Arrow is camera-relative: up = where the camera looks. Increasing heading turns left, so a wind
      // blowing toward heading hw appears rotated by −(hw − heading) (CSS rotate is clockwise).
      const rel = strength > 1e-4 ? Math.atan2(wind[0], wind[1]) - heading : 0;
      const deg = Math.round((-rel * 180) / Math.PI);
      this.windArrow.set(`rotate(${((deg % 360) + 360) % 360}deg)`);
      const q = Math.round(strength * 20) / 20;
      this.windFill.set(`scaleX(${q})`);
      this.windText.set(String(Math.round(strength * 10)));
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Weapon card (bottom left)
// ---------------------------------------------------------------------------------------------------

class WeaponCard {
  readonly root: HTMLDivElement;
  private readonly icon: HTMLDivElement;
  private readonly name: TextSlot;
  private readonly ammo: TextSlot;
  private readonly empty: ClassSlot;
  private iconId: string | null = null;
  private shown: boolean | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud-panel hud-weapon', parent);
    this.icon = el('div', 'weapon-icon', this.root);
    const info = el('div', 'weapon-info', this.root);
    this.name = new TextSlot(el('div', 'weapon-name', info));
    this.ammo = new TextSlot(el('div', 'weapon-ammo', info));
    this.empty = new ClassSlot(this.root, 'is-empty');
    el('div', 'weapon-key', this.root, 'Q');
  }

  update(w: HudWeapon | null): void {
    const show = w !== null;
    if (show !== this.shown) this.root.hidden = !(this.shown = show);
    if (!w) return;
    if (w.id !== this.iconId) {
      this.iconId = w.id;
      this.icon.innerHTML = weaponIcon(w.id);
      this.root.dataset.weapon = w.id;
    }
    this.name.set(w.name);
    this.ammo.set(w.ammo < 0 ? '∞' : `${w.ammo} / ${w.maxAmmo}`);
    this.empty.set(w.ammo === 0);
  }
}

// ---------------------------------------------------------------------------------------------------

export function createHud(root: HTMLElement, opts: HudOptions = {}): Hud {
  const teamColor = opts.teamColor ?? defaultTeamColor;
  const hudEl = el('div', '', root);
  hudEl.id = 'hud';
  const tags = new NameTagLayer(hudEl, teamColor);
  const roster = new Roster(hudEl);
  const turn = new TurnInfo(hudEl);
  const minimap = new Minimap(hudEl);
  const card = new WeaponCard(hudEl);
  let selectedWeapon: string | null = null;
  const menu = new WeaponMenu(hudEl, opts.weapons ?? DEFAULT_WEAPON_MENU, (id) => {
    selectedWeapon = id;
    menu.setSelected(id);
    opts.onSelectWeapon?.(id);
  });
  let visible = true;
  const mapFrame: MinimapFrame = { worms: [], teamColor, activeWormId: null, heading: 0, fallbackXZ: null };

  const onKey = (e: KeyboardEvent) => {
    if (!visible || e.repeat) return;
    if (e.code === 'KeyQ') {
      if (opts.canToggleMenu && !opts.canToggleMenu()) return;
      menu.setOpen(!menu.isOpen);
    } else if (e.code === 'Escape' && menu.isOpen) {
      menu.setOpen(false);
    }
  };
  window.addEventListener('keydown', onKey);

  const hud: Hud = {
    root: hudEl,
    update(m) {
      if (!visible) return;
      roster.update(m.teams, m.activeWormId);
      turn.update(m.turnTimeLeft, m.wind, m.cameraHeading);
      mapFrame.worms = m.wormsOnMap;
      mapFrame.activeWormId = m.activeWormId;
      mapFrame.heading = m.cameraHeading;
      mapFrame.fallbackXZ = m.cameraXZ ?? null;
      minimap.update(mapFrame);
      card.update(m.weapon);
      if (m.weapon && m.weapon.id !== selectedWeapon) {
        selectedWeapon = m.weapon.id;
        menu.setSelected(selectedWeapon);
      }
      tags.update(m.nameTags, m.activeWormId);
    },
    setHeightmap(h) {
      minimap.setHeightmap(h);
    },
    setVisible(v) {
      visible = v;
      hudEl.hidden = !v;
      if (!v) menu.setOpen(false);
    },
    toggleWeaponMenu(open) {
      menu.setOpen(open ?? !menu.isOpen);
    },
    get weaponMenuOpen() {
      return menu.isOpen;
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      tags.dispose();
      menu.dispose();
      hudEl.remove();
    },
  };
  return hud;
}
