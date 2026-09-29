/**
 * Name tags over worms: projection helper (three.js camera → CSS pixels) and the DOM layer.
 * The layer only writes a tag's transform when it moved ≥ 0.5 px / scaled ≥ 1 %, and only toggles
 * visibility on change, so a static scene costs zero DOM writes per frame.
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import { ClassSlot, el, hexCss, shade, StyleSlot, TextSlot } from './dom';

export interface NameTag {
  id: number;
  name: string;
  hp: number;
  team: number;
  /** CSS pixels from the top-left of the viewport (anchor = point above the worm's head). */
  screenX: number;
  screenY: number;
  visible: boolean;
  /** Distance scale, 1 = close, ~0.55 = far. */
  scale: number;
}

/** What projectNameTags needs per worm (WormState + a display name). */
export interface NameTagSource {
  id: number;
  team: number;
  hp: number;
  alive: boolean;
  name: string;
}

export interface ProjectOptions {
  /** Viewport size in CSS px (default: window inner size – the canvas is fullscreen). */
  width?: number;
  height?: number;
  /** Anchor height above the worm centre (m). Above the bouncing active marker (~1.3 m). */
  headOffset?: number;
  /** Worm whose tag is hidden (the active worm in follow/aim – it has the 3D marker). */
  hideId?: number | null;
  /** Terrain occlusion test from the camera to the anchor; return true to hide the tag. */
  occluded?: (id: number, from: Vec3, to: Vec3) => boolean;
  /** Reused output array (avoids per-frame allocation). */
  out?: NameTag[];
}

export const NAME_TAG = {
  headOffset: 1.55,
  /** Scale 1 up to nearDist, falls linearly to minScale at farDist (m). */
  nearDist: 10,
  farDist: 80,
  minScale: 0.55,
  /** NDC margin before a tag counts as offscreen. */
  ndcMargin: 1.05,
};

const v = new THREE.Vector3();
const camPos: Vec3 = [0, 0, 0];
const anchor: Vec3 = [0, 0, 0];

/**
 * Project worm head anchors to screen space. Dead worms, worms without a render pose, worms behind the
 * camera or offscreen get visible = false.
 */
export function projectNameTags(
  camera: THREE.PerspectiveCamera,
  worms: readonly NameTagSource[],
  renderPose: (id: number) => { pos: Vec3 } | null,
  opts: ProjectOptions = {},
): NameTag[] {
  const out = opts.out ?? [];
  const w = opts.width ?? window.innerWidth;
  const h = opts.height ?? window.innerHeight;
  const off = opts.headOffset ?? NAME_TAG.headOffset;
  const m = NAME_TAG.ndcMargin;
  camera.updateMatrixWorld();
  const cp = camera.matrixWorld.elements;
  camPos[0] = cp[12]!;
  camPos[1] = cp[13]!;
  camPos[2] = cp[14]!;
  out.length = worms.length;
  for (let i = 0; i < worms.length; i++) {
    const src = worms[i]!;
    const t = (out[i] ??= { id: 0, name: '', hp: 0, team: 0, screenX: 0, screenY: 0, visible: false, scale: 1 });
    t.id = src.id;
    t.name = src.name;
    t.hp = src.hp;
    t.team = src.team;
    t.visible = false;
    if (!src.alive || src.id === opts.hideId) continue;
    const pose = renderPose(src.id);
    if (!pose) continue;
    anchor[0] = pose.pos[0];
    anchor[1] = pose.pos[1] + off;
    anchor[2] = pose.pos[2];
    v.set(anchor[0], anchor[1], anchor[2]).applyMatrix4(camera.matrixWorldInverse);
    if (v.z > -camera.near) continue; // behind the camera
    const dist = v.length();
    v.applyMatrix4(camera.projectionMatrix);
    if (v.x < -m || v.x > m || v.y < -m || v.y > m) continue;
    if (opts.occluded?.(src.id, camPos, anchor)) continue;
    t.screenX = (v.x * 0.5 + 0.5) * w;
    t.screenY = (0.5 - v.y * 0.5) * h;
    const k = (dist - NAME_TAG.nearDist) / (NAME_TAG.farDist - NAME_TAG.nearDist);
    t.scale = 1 - (1 - NAME_TAG.minScale) * Math.min(1, Math.max(0, k));
    t.visible = true;
  }
  return out;
}

interface TagView {
  root: HTMLDivElement;
  name: TextSlot;
  hp: TextSlot;
  visible: ClassSlot;
  active: ClassSlot;
  low: ClassSlot;
  transform: StyleSlot;
  team: number;
  qx: number;
  qy: number;
  qs: number;
}

/** DOM layer of name tags, keyed by worm id. */
export class NameTagLayer {
  readonly root: HTMLDivElement;
  private readonly views = new Map<number, TagView>();
  private readonly seen = new Set<number>();

  constructor(
    parent: HTMLElement,
    private readonly teamColor: (team: number) => number,
  ) {
    this.root = el('div', 'hud-tags', parent);
  }

  update(tags: readonly NameTag[], activeWormId: number | null): void {
    this.seen.clear();
    for (const t of tags) {
      this.seen.add(t.id);
      let view = this.views.get(t.id);
      if (!view) {
        view = this.create(t.id);
        this.views.set(t.id, view);
      }
      if (view.team !== t.team) {
        view.team = t.team;
        const c = this.teamColor(t.team);
        view.root.style.setProperty('--team', hexCss(c));
        view.root.style.setProperty('--team-light', hexCss(shade(c, 0.45)));
      }
      view.visible.set(t.visible);
      if (!t.visible) continue;
      view.name.set(t.name);
      view.hp.set(String(Math.max(0, Math.ceil(t.hp))));
      view.low.set(t.hp <= 25);
      view.active.set(t.id === activeWormId);
      const qx = Math.round(t.screenX * 2);
      const qy = Math.round(t.screenY * 2);
      const qs = Math.round(t.scale * 100);
      if (qx !== view.qx || qy !== view.qy || qs !== view.qs) {
        view.qx = qx;
        view.qy = qy;
        view.qs = qs;
        view.transform.set(
          `translate3d(${(qx / 2).toFixed(1)}px,${(qy / 2).toFixed(1)}px,0) translate(-50%,-100%) scale(${qs / 100})`,
        );
      }
    }
    for (const [id, view] of this.views) {
      if (this.seen.has(id)) continue;
      view.root.remove();
      this.views.delete(id);
    }
  }

  private create(id: number): TagView {
    const root = el('div', 'hud-tag', this.root);
    root.dataset.wormId = String(id);
    const pill = el('div', 'tag-pill', root);
    const name = el('span', 'tag-name', pill);
    const hp = el('span', 'tag-hp', pill);
    el('div', 'tag-marker', root);
    return {
      root,
      name: new TextSlot(name),
      hp: new TextSlot(hp),
      visible: new ClassSlot(root, 'is-visible'),
      active: new ClassSlot(root, 'is-active'),
      low: new ClassSlot(root, 'is-low'),
      transform: new StyleSlot(root, 'transform'),
      team: -1,
      qx: NaN,
      qy: NaN,
      qs: NaN,
    };
  }

  dispose(): void {
    this.root.remove();
    this.views.clear();
  }
}
