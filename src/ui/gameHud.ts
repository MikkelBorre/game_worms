/**
 * Glue between Game and the HUD: builds a HudModel from sim + render state once per rendered frame.
 * Reads only – never mutates sim state. All model arrays/objects are reused between frames.
 */
import type { Vec3 } from '../core/math';
import type { Game } from '../game';
import { teamColor } from '../render/palette';
import { RAPIER } from '../sim/physics';
import { WORM_MAX_HP } from '../sim/worm';
import type { HeightmapData } from '../terrain/types';
import { createHud, type Hud, type HudMapWorm, type HudModel, type HudTeam, type HudWorm } from './hud';
import { teamName, wormName } from './names';
import { projectNameTags, type NameTagSource } from './nameTags';
import { weaponDisplayName } from './weapons';

export interface GameHud {
  readonly hud: Hud;
  /** Call after each rendered frame (after camera + worm views were updated). */
  update(): void;
  setHeightmap(h: HeightmapData): void;
  dispose(): void;
}

/** Frames between terrain-occlusion re-checks of one name tag (checks are staggered across worms). */
const OCCLUSION_INTERVAL = 4;

export interface AttachHudOptions {
  /**
   * Fill the not-yet-implemented parts (turn timer, wind) with fake animated values so the full layout
   * can be seen/screenshotted before the turn system exists (?hud=demo). View-only.
   */
  demo?: boolean;
}

export function attachHud(game: Game, root: HTMLElement, opts: AttachHudOptions = {}): GameHud {
  // View-only weapon choice until the sim has a weapon registry / selectWeapon command.
  let weaponId = 'bazooka';
  const hud = createHud(root, {
    teamColor,
    onSelectWeapon: (id) => {
      weaponId = id;
    },
    canToggleMenu: () => game.cameraRig.mode !== 'free',
  });

  const model: HudModel = {
    teams: [],
    activeWormId: null,
    weapon: { id: weaponId, name: weaponDisplayName(weaponId), ammo: -1, maxAmmo: -1 },
    turnTimeLeft: null,
    wind: null,
    cameraHeading: 0,
    wormsOnMap: [],
    nameTags: [],
    cameraXZ: [0, 0],
  };
  const sources: NameTagSource[] = [];
  const hudWorms = new Map<number, HudWorm>();
  let wormCount = -1;
  let simRef: unknown = null;

  /** Rebuild team/worm lists when worms were added (spawn order defines per-team name index). */
  const rebuild = () => {
    const worms = game.sim.worms;
    model.teams = [];
    model.wormsOnMap = [];
    sources.length = 0;
    hudWorms.clear();
    const byTeam = new Map<number, HudTeam>();
    for (const w of worms) {
      let team = byTeam.get(w.team);
      if (!team) {
        team = { id: w.team, name: teamName(w.team), color: teamColor(w.team), worms: [] };
        byTeam.set(w.team, team);
      }
      const hw: HudWorm = {
        id: w.id,
        name: wormName(w.team, team.worms.length),
        hp: w.hp,
        maxHp: WORM_MAX_HP,
        alive: w.alive,
      };
      team.worms.push(hw);
      hudWorms.set(w.id, hw);
      model.wormsOnMap.push({ id: w.id, team: w.team, x: w.pos[0], z: w.pos[2], alive: w.alive });
      sources.push({ id: w.id, team: w.team, hp: w.hp, alive: w.alive, name: hw.name });
    }
    model.teams = [...byTeam.values()].sort((a, b) => a.id - b.id);
    wormCount = worms.length;
    simRef = game.sim;
  };

  // Terrain occlusion for name tags (camera → tag anchor, worms ignored), cached per worm.
  const occl = new Map<number, { frame: number; hidden: boolean }>();
  let frame = 0;
  const dir: Vec3 = [0, 0, 0];
  const occluded = (id: number, from: Vec3, to: Vec3): boolean => {
    let c = occl.get(id);
    if (c && frame - c.frame < OCCLUSION_INTERVAL && (id + frame) % OCCLUSION_INTERVAL !== 0) return c.hidden;
    dir[0] = to[0] - from[0];
    dir[1] = to[1] - from[1];
    dir[2] = to[2] - from[2];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    let hidden = false;
    if (len > 0.5) {
      const ray = new RAPIER.Ray(
        { x: from[0], y: from[1], z: from[2] },
        { x: dir[0] / len, y: dir[1] / len, z: dir[2] / len },
      );
      // Stop a bit short of the anchor so the ground right under a worm doesn't count.
      const hit = game.sim.physics.castRay(ray, len - 0.3, true, RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
      hidden = hit !== null;
    }
    if (!c) occl.set(id, (c = { frame, hidden }));
    c.frame = frame;
    c.hidden = hidden;
    return hidden;
  };

  const renderPose = (id: number) => game.wormView.renderPose(id);
  const demoWind: [number, number] = [0, 0];

  return {
    hud,
    update() {
      frame++;
      const sim = game.sim;
      if (!sim) return;
      if (sim !== simRef || sim.worms.length !== wormCount) {
        rebuild();
        occl.clear();
      }
      const worms = sim.worms;
      for (let i = 0; i < worms.length; i++) {
        const w = worms[i]!;
        const hw = hudWorms.get(w.id)!;
        hw.hp = w.hp;
        hw.alive = w.alive;
        const mw: HudMapWorm = model.wormsOnMap[i]!;
        const p = game.wormView.renderPose(w.id)?.pos ?? w.pos;
        mw.x = p[0];
        mw.z = p[2];
        mw.alive = w.alive;
        const s = sources[i]!;
        s.hp = w.hp;
        s.alive = w.alive;
      }
      model.activeWormId = game.activeWormId;
      model.cameraHeading = game.cameraRig.heading();
      const cam = game.ctx.camera;
      model.cameraXZ![0] = cam.position.x;
      model.cameraXZ![1] = cam.position.z;
      if (model.weapon!.id !== weaponId) {
        model.weapon = { id: weaponId, name: weaponDisplayName(weaponId), ammo: -1, maxAmmo: -1 };
      }
      if (opts.demo) {
        const t = frame / 60; // rendered frames, so screenshots are reproducible
        model.turnTimeLeft = 45 - (t % 45);
        demoWind[0] = 0.55 * Math.sin(0.4 + t * 0.05);
        demoWind[1] = -0.55 * Math.cos(0.4 + t * 0.05);
        model.wind = demoWind;
      }
      const mode = game.cameraRig.mode;
      projectNameTags(cam, sources, renderPose, {
        out: model.nameTags,
        hideId: mode === 'follow' || mode === 'aim' ? game.activeWormId : null,
        occluded,
      });
      hud.update(model);
    },
    setHeightmap(h) {
      hud.setHeightmap(h);
    },
    dispose() {
      hud.dispose();
    },
  };
}
