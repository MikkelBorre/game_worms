/**
 * Shared look-dev constants for sky, fog, lighting and water.
 * Colours are sRGB hex (three.js converts them to the linear working space).
 * Tweak here – sky.ts and water.ts both read from this file so fog/horizon/water stay in sync.
 */

/** Available look-dev lighting presets (cosmetic only). */
export type LightingPresetName = 'goldenHour' | 'day';

/** Switch the whole look here. 'goldenHour' is the default art direction (docs/ART_DIRECTION.md). */
export const LIGHTING_PRESET: LightingPresetName = 'goldenHour';

interface LightingPreset {
  /** Direction pointing TOWARDS the sun (normalised where used). */
  sunDirection: readonly [number, number, number];
  sky: {
    zenith: number;
    mid: number;
    /** Horizon = fog colour. Must stay identical so the ocean edge melts into the sky. */
    horizon: number;
    sunColor: number;
    sunGlow: number;
    /** Sun disc angular size: cos of the disc edge (smaller = bigger disc). */
    sunDiscCos: number;
    cloud: number;
    cloudShade: number;
    /** Bright rim on cloud edges that face the sun. */
    cloudRim: number;
    /** Cloud coverage threshold on the fbm (lower = more cloud). */
    cloudCover: number;
  };
  /**
   * Directional haze: fog and horizon shift towards `color` when looking towards the sun
   * (weight = strength · max(dot(view, sun), 0)^exponent). Shared by the sky dome and every lit material.
   */
  haze: { color: number; strength: number; exponent: number };
  fog: { near: number; far: number };
  light: {
    sunColor: number;
    sunIntensity: number;
    hemiSky: number;
    hemiGround: number;
    hemiIntensity: number;
    /**
     * Toon ramp for the sun, 16 texels over dot(N, L) ∈ [-1, 1] (0.125 per texel; index 8 = dot 0..0.125).
     * Values 0–255. A low sun needs the bright bands to start at small dot values.
     */
    toonRamp: readonly number[];
  };
  /** Water glint: broad sun path strength / tightness and sparkle strength. */
  glint: { path: number; pathPower: number; sparkle: number };
}

const toSun = (azimuthDeg: number, elevationDeg: number): [number, number, number] => {
  // Azimuth 0 = −Z (north, "into the default overview"), positive towards −X (west).
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return [-Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
};

const PRESETS: Record<LightingPresetName, LightingPreset> = {
  goldenHour: {
    // Low sun in front of the default overview camera (which looks towards −Z), a bit to the west:
    // the sun path lies across the sea beside the island, slopes get warm side light.
    sunDirection: toSun(40, 23),
    sky: {
      zenith: 0x2f6fd0,
      mid: 0x78b4ec,
      horizon: 0xf6cfae,
      sunColor: 0xfff2c4,
      sunGlow: 0xffb45a,
      sunDiscCos: 0.99905,
      cloud: 0xfff0dc,
      cloudShade: 0xcdbfdc,
      cloudRim: 0xffd79a,
      cloudCover: 0.6,
    },
    haze: { color: 0xffc27a, strength: 0.85, exponent: 3.0 },
    fog: { near: 150, far: 760 },
    light: {
      sunColor: 0xffc890,
      sunIntensity: 2.9,
      hemiSky: 0x9db4ff,
      hemiGround: 0xa07a5a,
      hemiIntensity: 3.5,
      toonRamp: [0, 0, 0, 0, 0, 0, 0, 0, 165, 215, 245, 255, 255, 255, 255, 255],
    },
    glint: { path: 0.9, pathPower: 10, sparkle: 1.2 },
  },
  day: {
    sunDirection: [-0.55, 0.6, -0.4],
    sky: {
      zenith: 0x2a7fe0,
      mid: 0x6cb8f0,
      horizon: 0xc4e6f2,
      sunColor: 0xfff1d6,
      sunGlow: 0xffe2a8,
      sunDiscCos: 0.99935,
      cloud: 0xffffff,
      cloudShade: 0xc9d8ea,
      cloudRim: 0xffffff,
      cloudCover: 0.585,
    },
    haze: { color: 0xe6f0f0, strength: 0.25, exponent: 4.0 },
    fog: { near: 170, far: 780 },
    light: {
      sunColor: 0xfff0d8,
      sunIntensity: 2.5,
      hemiSky: 0xcfe8ff,
      hemiGround: 0x8a7a58,
      hemiIntensity: 2.3,
      toonRamp: [0, 0, 0, 0, 0, 0, 0, 0, 150, 150, 215, 215, 255, 255, 255, 255],
    },
    glint: { path: 0.22, pathPower: 24, sparkle: 0.75 },
  },
};

const P = PRESETS[LIGHTING_PRESET];

/** Unit-ish direction pointing TOWARDS the sun (normalised where used). */
export const SUN_DIRECTION: readonly [number, number, number] = P.sunDirection;

export const SKY = P.sky;

export const HAZE = P.haze;

export const FOG = {
  color: SKY.horizon,
  /** Linear fog start/end in metres (view depth). The island is 160 m across. */
  near: P.fog.near,
  far: P.fog.far,
} as const;

export const LIGHT = {
  ...P.light,
  /** Shadow map edge in texels (budget cap 2048). */
  shadowMapSize: 2048,
  shadowBias: -0.0003,
  shadowNormalBias: 0.12,
  shadowRadius: 1.5,
} as const;

export const GLINT = P.glint;

export const WATER = {
  shallow: 0x46e6d0,
  mid: 0x19a9cf,
  deep: 0x0c4f9e,
  foam: 0xf6fdff,
  /** Depth (m) at which the colour reaches `mid` / `deep`. */
  midDepth: 1.6,
  deepDepth: 7.0,
  /** Width (m) of the animated foam band measured horizontally from the shoreline. */
  foamWidth: 5.0,
  /** Spacing (m) of the foam stripes that travel towards the beach, and their speed (stripes/s). */
  foamStripeSpacing: 2.2,
  foamSpeed: 0.3,
  /** Global wave amplitude multiplier (1 = ~0.25 m crest-to-mean). */
  waveAmplitude: 1.0,
  /** Radius (m) from the island centre over which vertex waves fade out to the flat far ocean. */
  waveFadeStart: 110,
  waveFadeEnd: 150,
  specular: 1.4,
  fresnel: 0.55,
} as const;

/** Team colours (helmets, active-worm marker, later HUD). Index = WormState.team % length. */
export const TEAM_COLORS: readonly number[] = [
  0xe8302a, // red
  0x2a6cf0, // blue
  0x2cc14a, // green
  0xf7c21b, // yellow
];

export const teamColor = (team: number): number =>
  TEAM_COLORS[((team % TEAM_COLORS.length) + TEAM_COLORS.length) % TEAM_COLORS.length] ?? 0xffffff;

/** Procedural worm look (wormModel.ts). */
export const WORM_COLORS = {
  skin: 0xff7d9c,
  /** Lighter front/belly. */
  belly: 0xffb0c0,
  /** Darker ring bands on the lower body (segments). */
  segment: 0xd9587a,
  eyeWhite: 0xffffff,
  pupil: 0x141018,
  mouth: 0x7a1f35,
  /** Helmet brim/rim = team colour multiplied by this. */
  helmetRimShade: 0.72,
  /** Cartoon outline (inverted hull). */
  outline: 0x2a1420,
} as const;

export const GRAVE_COLORS = {
  stone: 0xb9c0c8,
  stoneDark: 0x8e97a3,
  engraving: 0x5a6270,
  dirt: 0x7a5534,
} as const;

export const SPLASH_COLORS = {
  droplet: 0xe4f8ff,
  ring: 0xffffff,
} as const;
