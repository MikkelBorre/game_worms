/**
 * Round top-down minimap with a compass ring.
 *
 * Orientation: NORTH = −Z (up on the map), EAST = +X (right). This is the same picture as a three.js
 * camera looking straight down with up = −Z, and matches the heightmap layout (row 0 = minZ at the top).
 * The map itself is fixed north-up; only the player arrow rotates with the camera heading.
 *
 * Cost: the island is rasterised ONCE per heightmap (setHeightmap). Per frame only the small overlay
 * canvas with worm dots + arrow is redrawn, and only when a quantised dot/arrow value changed.
 */
import { WATER_LEVEL, WORLD_MIN, WORLD_SIZE, type HeightmapData } from '../terrain/types';
import { el, hexCss } from './dom';

export interface MinimapWorm {
  id: number;
  team: number;
  x: number;
  z: number;
  alive: boolean;
}

export interface MinimapFrame {
  worms: readonly MinimapWorm[];
  teamColor: (team: number) => number;
  activeWormId: number | null;
  /** Camera heading in the worm convention: forward = [sin h, 0, cos h]. */
  heading: number;
  /** Where to draw the arrow when there is no active worm (camera XZ); null = map centre. */
  fallbackXZ: readonly [number, number] | null;
}

/** Overlay canvas resolution (square). CSS scales it to the minimap size. */
const OVERLAY_RES = 320;

/** Map palette (sRGB). Kept local so look-dev palette changes don't silently restyle the HUD. */
const MAP = {
  deep: [12, 64, 140],
  mid: [22, 150, 200],
  shallow: [70, 220, 205],
  foam: [235, 250, 250],
  sand: [236, 214, 140],
  grassLow: [110, 196, 78],
  grassHigh: [66, 146, 56],
  rock: [138, 133, 128],
  rockHigh: [176, 170, 162],
} as const;

type RGB = readonly [number, number, number];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sat = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
function mixInto(out: number[], a: RGB, b: RGB, t: number): void {
  out[0] = lerp(a[0], b[0], t);
  out[1] = lerp(a[1], b[1], t);
  out[2] = lerp(a[2], b[2], t);
}

/** Rasterise a heightmap into RGBA pixels (res × res), coloured by height + slope with NW hill-shading. */
export function renderHeightmapPixels(h: HeightmapData, waterLevel = WATER_LEVEL): Uint8ClampedArray {
  const res = h.resolution;
  const px = new Uint8ClampedArray(res * res * 4);
  const cell = h.size / (res - 1);
  // Light from the north-west, fairly high (matches the default sun direction).
  const lx = -0.5,
    ly = 0.7,
    lz = -0.5;
  const ll = Math.hypot(lx, ly, lz);
  const c = [0, 0, 0];
  const at = (x: number, z: number) =>
    h.heights[Math.min(res - 1, Math.max(0, z)) * res + Math.min(res - 1, Math.max(0, x))]!;
  for (let z = 0; z < res; z++) {
    for (let x = 0; x < res; x++) {
      const y = at(x, z) - waterLevel;
      let shadeK = 1;
      if (y < 0) {
        const d = -y;
        if (d < 0.35) mixInto(c, MAP.foam, MAP.shallow, d / 0.35);
        else if (d < 2) mixInto(c, MAP.shallow, MAP.mid, (d - 0.35) / 1.65);
        else mixInto(c, MAP.mid, MAP.deep, sat((d - 2) / 6));
      } else {
        const dx = (at(x + 1, z) - at(x - 1, z)) / (2 * cell);
        const dz = (at(x, z + 1) - at(x, z - 1)) / (2 * cell);
        const nl = Math.hypot(dx, 1, dz);
        const ny = 1 / nl;
        const ndl = (-dx * lx + ly - dz * lz) / (nl * ll);
        shadeK = 0.62 + 0.5 * Math.max(0, ndl);
        if (y < 1.4) mixInto(c, MAP.sand, MAP.grassLow, sat((y - 1.0) / 0.4));
        else mixInto(c, MAP.grassLow, MAP.grassHigh, sat((y - 2) / 22));
        const rock = Math.max(sat((0.74 - ny) / 0.16), sat((y - 26) / 5));
        if (rock > 0) {
          const r0 = c[0]!,
            g0 = c[1]!,
            b0 = c[2]!;
          mixInto(c, MAP.rock, MAP.rockHigh, sat((y - 26) / 10));
          c[0] = lerp(r0, c[0]!, rock);
          c[1] = lerp(g0, c[1]!, rock);
          c[2] = lerp(b0, c[2]!, rock);
        }
      }
      const o = (z * res + x) * 4;
      px[o] = c[0]! * shadeK;
      px[o + 1] = c[1]! * shadeK;
      px[o + 2] = c[2]! * shadeK;
      px[o + 3] = 255;
    }
  }
  return px;
}

export class Minimap {
  readonly root: HTMLDivElement;
  readonly mapCanvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly octx: CanvasRenderingContext2D | null;
  private minX: number = WORLD_MIN.x;
  private minZ: number = WORLD_MIN.z;
  private size: number = WORLD_SIZE.x;
  /** Quantised state of the last overlay draw, for dirty checking. */
  private lastKey: number[] = [];
  private key: number[] = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud-minimap', parent);
    this.root.setAttribute('aria-label', 'Minimap');
    const disc = el('div', 'mm-disc', this.root);
    this.mapCanvas = el('canvas', 'mm-map', disc);
    this.mapCanvas.width = this.mapCanvas.height = 2;
    this.overlay = el('canvas', 'mm-overlay', disc);
    this.overlay.width = this.overlay.height = OVERLAY_RES;
    this.octx = this.overlay.getContext('2d');
    const ring = el('div', 'mm-ring', this.root);
    // Danish compass letters: Nord, Øst, Syd, Vest.
    for (const [cls, t] of [
      ['n', 'N'],
      ['e', 'Ø'],
      ['s', 'S'],
      ['w', 'V'],
    ] as const)
      el('span', `mm-dir mm-${cls}`, ring, t);
  }

  /** Draw the island once. Call again after a seed change or a big terrain edit. */
  setHeightmap(h: HeightmapData, waterLevel = WATER_LEVEL): void {
    this.minX = h.minX;
    this.minZ = h.minZ;
    this.size = h.size;
    const res = h.resolution;
    this.mapCanvas.width = this.mapCanvas.height = res;
    const ctx = this.mapCanvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(res, res);
    img.data.set(renderHeightmapPixels(h, waterLevel));
    ctx.putImageData(img, 0, 0);
    this.lastKey.length = 0; // force overlay redraw (mapping may have changed)
  }

  private toPx(x: number, z: number): [number, number] {
    return [((x - this.minX) / this.size) * OVERLAY_RES, ((z - this.minZ) / this.size) * OVERLAY_RES];
  }

  update(f: MinimapFrame): void {
    const ctx = this.octx;
    if (!ctx) return;
    // Dirty key: quantised positions (0.5 px), alive/team/active flags, heading (~0.5°).
    const k = this.key;
    k.length = 0;
    k.push(f.activeWormId ?? -1, Math.round(f.heading * 120));
    for (const w of f.worms) {
      const [px, pz] = this.toPx(w.x, w.z);
      k.push(w.id, w.team, w.alive ? 1 : 0, Math.round(px * 2), Math.round(pz * 2));
    }
    const active = f.worms.find((w) => w.id === f.activeWormId && w.alive);
    let ax = OVERLAY_RES / 2,
      az = OVERLAY_RES / 2;
    if (active) [ax, az] = this.toPx(active.x, active.z);
    else if (f.fallbackXZ) {
      [ax, az] = this.toPx(f.fallbackXZ[0], f.fallbackXZ[1]);
      const pad = 18;
      ax = Math.min(OVERLAY_RES - pad, Math.max(pad, ax));
      az = Math.min(OVERLAY_RES - pad, Math.max(pad, az));
      k.push(Math.round(ax * 2), Math.round(az * 2));
    }
    if (sameKey(k, this.lastKey)) return;
    [this.lastKey, this.key] = [this.key, this.lastKey];

    ctx.clearRect(0, 0, OVERLAY_RES, OVERLAY_RES);
    // Dead worms: small grey crosses; alive: team dots with a white rim.
    for (const w of f.worms) {
      if (w.alive || w.id === f.activeWormId) continue;
      const [x, z] = this.toPx(w.x, w.z);
      ctx.strokeStyle = 'rgba(40,44,52,.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - 4, z - 4);
      ctx.lineTo(x + 4, z + 4);
      ctx.moveTo(x + 4, z - 4);
      ctx.lineTo(x - 4, z + 4);
      ctx.stroke();
    }
    for (const w of f.worms) {
      if (!w.alive || w === active) continue;
      const [x, z] = this.toPx(w.x, w.z);
      ctx.beginPath();
      ctx.arc(x, z, 7, 0, Math.PI * 2);
      ctx.fillStyle = hexCss(f.teamColor(w.team));
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(15,20,30,.9)';
      ctx.beginPath();
      ctx.arc(x, z, 8.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Player arrow. Screen dir of world forward [sin h, cos h] with north(−Z) up is (sin h, cos h),
    // i.e. an up-pointing arrow rotated clockwise by (π − h).
    ctx.save();
    ctx.translate(ax, az);
    ctx.rotate(Math.PI - f.heading);
    if (active) {
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.fillStyle = hexCss(f.teamColor(active.team));
      ctx.globalAlpha = 0.45;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.moveTo(0, -16);
    ctx.lineTo(11, 11);
    ctx.lineTo(0, 5);
    ctx.lineTo(-11, 11);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(15,20,30,.95)';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
}

function sameKey(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
