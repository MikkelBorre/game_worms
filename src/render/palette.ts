/**
 * Shared look-dev constants for sky, fog, lighting and water.
 * Colours are sRGB hex (three.js converts them to the linear working space).
 * Tweak here – sky.ts and water.ts both read from this file so fog/horizon/water stay in sync.
 */

/** Unit-ish direction pointing TOWARDS the sun (normalised where used). Afternoon sun from the north-west. */
export const SUN_DIRECTION: readonly [number, number, number] = [-0.55, 0.6, -0.4];

export const SKY = {
  zenith: 0x2a7fe0,
  mid: 0x6cb8f0,
  /** Horizon = fog colour. Must stay identical so the ocean edge melts into the sky. */
  horizon: 0xc4e6f2,
  sunColor: 0xfff1d6,
  sunGlow: 0xffe2a8,
  cloud: 0xffffff,
  cloudShade: 0xc9d8ea,
} as const;

export const FOG = {
  color: SKY.horizon,
  /** Linear fog start/end in metres (view depth). The island is 160 m across. */
  near: 170,
  far: 780,
} as const;

export const LIGHT = {
  sunColor: 0xfff0d8,
  sunIntensity: 2.5,
  hemiSky: 0xcfe8ff,
  hemiGround: 0x8a7a58,
  hemiIntensity: 2.3,
  /** Shadow map edge in texels (budget cap 2048). */
  shadowMapSize: 2048,
  shadowBias: -0.0003,
  shadowNormalBias: 0.12,
  shadowRadius: 1.5,
} as const;

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
