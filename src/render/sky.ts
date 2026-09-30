import * as THREE from 'three';
import { WORLD_MIN, WORLD_SIZE } from '../terrain/types';
import { FOG, HAZE, LIGHT, SKY, SUN_DIRECTION } from './palette';

export interface Sky {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /**
   * Keep the sky dome centred on the camera. The shadow frustum stays fitted to the island.
   * Optional timeSec drifts the clouds (static if omitted).
   */
  update(camera: THREE.Camera, timeSec?: number): void;
  dispose(): void;
}

/** Sky dome radius. Must stay inside the camera far plane (1000). */
const DOME_RADIUS = 900;
/** Vertical extent (world y) that shadow casters/receivers may occupy: sea floor → above the peaks. */
const SHADOW_Y_MIN = -8;
const SHADOW_Y_MAX = 55;

const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Push to the far plane so the dome is drawn behind everything and early-z rejects covered pixels.
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
}
`;

const skyFragment = /* glsl */ `
// All colours arrive in sRGB (display) space: the dome is neither tone mapped nor colour converted, so the
// horizon matches three's fog (which is mixed in output space) exactly, and gradients do not go muddy.
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec2 uHazeParams; // strength, exponent
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSunGlow;
uniform float uSunDiscCos;
uniform vec3 uCloud;
uniform vec3 uCloudShade;
uniform vec3 uCloudRim;
uniform float uCloudCover;
uniform float uTime;
varying vec3 vDir;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm3(vec2 p) {
  float v = 0.5 * vnoise(p);
  v += 0.25 * vnoise(p * 2.03 + 11.7);
  v += 0.125 * vnoise(p * 4.01 + 3.1);
  return v / 0.875;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = clamp(h, 0.0, 1.0);
  float s = max(dot(d, uSunDir), 0.0);
  // Horizon = fog colour shifted towards the haze colour when looking at the sun (same formula as the
  // fog chunk installed below, so distant terrain and water melt into the sky in every direction).
  vec3 horizon = mix(uHorizon, uHaze, uHazeParams.x * pow(s, uHazeParams.y));
  // Horizon -> mid band -> zenith. Below the horizon we stay at the horizon (= fog) colour.
  vec3 col = mix(horizon, uMid, smoothstep(0.0, 0.3, t));
  col = mix(col, uZenith, smoothstep(0.22, 0.9, t));
  // Warm glow around the sun.
  col += uSunGlow * (pow(s, 5.0) * 0.22 + pow(s, 40.0) * 0.4);

  // Stylized clouds projected on a plane: crisp two-tone shapes whose sun-facing edges catch a warm rim.
  if (h > 0.01) {
    vec2 uv = d.xz / (h + 0.12) * 1.1 + vec2(uTime * 0.004, uTime * 0.002);
    vec2 toSun = normalize(uSunDir.xz + vec2(1e-4));
    float n = fbm3(uv * 1.6);
    float nSun = fbm3(uv * 1.6 + toSun * 0.22);
    float cover = smoothstep(uCloudCover - 0.005, uCloudCover + 0.005, n);
    // Sun-facing half of each cloud is lit (density falls off towards the sun), the rest takes the
    // shade colour; thin cloud margins on the lit side glow warm.
    float lit = smoothstep(-0.01, 0.02, n - nSun);
    float margin = 1.0 - smoothstep(uCloudCover + 0.01, uCloudCover + 0.06, n);
    vec3 cc = mix(uCloudShade, uCloud, lit);
    cc = mix(cc, uCloudRim, margin * (lit * 0.7 + 0.3) * (0.5 + 0.5 * s));
    // Clouds near the sun glow; clouds near the horizon take on the haze colour.
    cc += uSunGlow * pow(s, 10.0) * 0.45;
    cc = mix(cc, horizon, (1.0 - smoothstep(0.01, 0.16, h)) * 0.55);
    float fade = smoothstep(0.01, 0.1, h);
    col = mix(col, cc, cover * fade * 0.95);
  }

  // Sun disc (drawn over clouds so it always reads) with a soft bloom.
  col = mix(col, uSunColor * 1.2, smoothstep(uSunDiscCos, uSunDiscCos + 0.0003, s));

  gl_FragColor = vec4(col, 1.0);
}
`;

let hazeFogInstalled = false;
const srgbTriple = (hex: number): string =>
  [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => (v / 255).toFixed(4)).join(', ');

/**
 * Directional "golden hour" haze for three's built-in fog: patches the global fog shader chunks so the fog
 * colour shifts towards HAZE.color when looking towards the sun. Every material that includes both the
 * lights and fog chunks (terrain, worms, scatter, water) gets it for free; unlit materials keep the plain
 * fog colour. The sun is read from directionalLights[0] (view space, uploaded by the renderer), so no extra
 * uniforms are needed. Must run before the first compile; idempotent.
 */
export function installHazeFog(): void {
  if (hazeFogInstalled) return;
  hazeFogInstalled = true;
  const C = THREE.ShaderChunk as Record<string, string>;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogViewPos;
#endif
`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogViewPos = mvPosition.xyz;
#endif
`;
  C.fog_pars_fragment = `${C.fog_pars_fragment}
#ifdef USE_FOG
  varying vec3 vFogViewPos;
#endif
`;
  C.lights_pars_begin = `#define WW_HAS_LIGHTS\n${C.lights_pars_begin}`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 wwFogColor = fogColor;
  #if defined( WW_HAS_LIGHTS ) && NUM_DIR_LIGHTS > 0
    float wwSun = max( dot( normalize( vFogViewPos ), directionalLights[ 0 ].direction ), 0.0 );
    wwFogColor = mix( fogColor, vec3( ${srgbTriple(HAZE.color)} ), ${HAZE.strength.toFixed(4)} * pow( wwSun, ${HAZE.exponent.toFixed(4)} ) );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, wwFogColor, fogFactor );
#endif
`;
}

const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace).convertLinearToSRGB();

/**
 * Gradient sky dome (1 draw call), linear distance fog matching the horizon colour,
 * hemisphere fill light and a single shadow-casting sun whose orthographic frustum is fitted to the island.
 */
export function createSky(scene: THREE.Scene): Sky {
  const sunDir = new THREE.Vector3(...SUN_DIRECTION).normalize();
  installHazeFog();

  scene.background = new THREE.Color(SKY.horizon);
  scene.fog = new THREE.Fog(FOG.color, FOG.near, FOG.far);

  // --- Sky dome -------------------------------------------------------------
  const domeGeo = new THREE.SphereGeometry(DOME_RADIUS, 32, 16);
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: srgb(SKY.zenith) },
      uMid: { value: srgb(SKY.mid) },
      uHorizon: { value: srgb(SKY.horizon) },
      uHaze: { value: srgb(HAZE.color) },
      uHazeParams: { value: new THREE.Vector2(HAZE.strength, HAZE.exponent) },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: srgb(SKY.sunColor) },
      uSunGlow: { value: srgb(SKY.sunGlow) },
      uSunDiscCos: { value: SKY.sunDiscCos },
      uCloud: { value: srgb(SKY.cloud) },
      uCloudShade: { value: srgb(SKY.cloudShade) },
      uCloudRim: { value: srgb(SKY.cloudRim) },
      uCloudCover: { value: SKY.cloudCover },
      uTime: { value: 0 },
    },
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    // three applies fog *after* tone mapping using the raw sRGB fog colour, so the dome must skip tone
    // mapping (and colour conversion – its uniforms are already sRGB) or the horizon would not match.
    toneMapped: false,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.name = 'skyDome';
  dome.frustumCulled = false;
  dome.renderOrder = 1000; // last among opaques → only fills uncovered pixels
  dome.matrixAutoUpdate = false;
  scene.add(dome);

  // --- Lights ---------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(LIGHT.hemiSky, LIGHT.hemiGround, LIGHT.hemiIntensity);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(LIGHT.sunColor, LIGHT.sunIntensity);
  sun.name = 'sun';
  const center = new THREE.Vector3(
    WORLD_MIN.x + WORLD_SIZE.x / 2,
    (SHADOW_Y_MIN + SHADOW_Y_MAX) / 2,
    WORLD_MIN.z + WORLD_SIZE.z / 2,
  );
  sun.target.position.copy(center);
  sun.position.copy(center).addScaledVector(sunDir, 200);
  sun.castShadow = true;
  sun.shadow.mapSize.set(LIGHT.shadowMapSize, LIGHT.shadowMapSize);
  sun.shadow.bias = LIGHT.shadowBias;
  sun.shadow.normalBias = LIGHT.shadowNormalBias;
  sun.shadow.radius = LIGHT.shadowRadius;
  fitShadowToBox(
    sun,
    new THREE.Box3(
      new THREE.Vector3(WORLD_MIN.x, SHADOW_Y_MIN, WORLD_MIN.z),
      new THREE.Vector3(WORLD_MIN.x + WORLD_SIZE.x, SHADOW_Y_MAX, WORLD_MIN.z + WORLD_SIZE.z),
    ),
  );
  scene.add(sun);
  scene.add(sun.target);

  return {
    sun,
    hemi,
    update(camera, timeSec) {
      if (timeSec !== undefined) domeMat.uniforms.uTime!.value = timeSec;
      dome.position.copy(camera.position);
      dome.updateMatrix();
    },
    dispose() {
      scene.remove(dome, hemi, sun, sun.target);
      domeGeo.dispose();
      domeMat.dispose();
      sun.shadow.dispose();
    },
  };
}

/** Fit the sun's orthographic shadow camera tightly around a world-space box (static, shimmer-free). */
function fitShadowToBox(sun: THREE.DirectionalLight, box: THREE.Box3): void {
  const view = new THREE.Matrix4().lookAt(sun.position, sun.target.position, new THREE.Vector3(0, 1, 0));
  view.setPosition(sun.position);
  view.invert();
  const p = new THREE.Vector3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    p.applyMatrix4(view);
    min.min(p);
    max.max(p);
  }
  const cam = sun.shadow.camera;
  const pad = 2;
  cam.left = min.x - pad;
  cam.right = max.x + pad;
  cam.bottom = min.y - pad;
  cam.top = max.y + pad;
  // Light looks down -z: near/far are distances along the view direction.
  cam.near = Math.max(0.5, -max.z - pad);
  cam.far = -min.z + pad;
  cam.updateProjectionMatrix();
}
