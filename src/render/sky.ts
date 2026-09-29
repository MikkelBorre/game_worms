import * as THREE from 'three';
import { WORLD_MIN, WORLD_SIZE } from '../terrain/types';
import { FOG, LIGHT, SKY, SUN_DIRECTION } from './palette';

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
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSunGlow;
uniform vec3 uCloud;
uniform vec3 uCloudShade;
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
  // Horizon -> mid band -> zenith. Below the horizon we stay at the horizon (= fog) colour.
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, t));
  col = mix(col, uZenith, smoothstep(0.18, 0.85, t));

  float s = max(dot(d, uSunDir), 0.0);
  col += uSunGlow * (pow(s, 6.0) * 0.18 + pow(s, 48.0) * 0.35);

  // Stylized two-tone clouds projected on a plane, crisp edges, fading towards the horizon.
  if (h > 0.015) {
    vec2 uv = d.xz / (h + 0.12) * 1.1 + vec2(uTime * 0.004, uTime * 0.002);
    float n = fbm3(uv * 1.6);
    float cover = smoothstep(0.585, 0.595, n);
    float lit = smoothstep(0.64, 0.66, fbm3(uv * 1.6 + uSunDir.xz * 0.12));
    vec3 cc = mix(uCloud, uCloudShade, 0.55 * (1.0 - lit));
    float fade = smoothstep(0.015, 0.2, h);
    col = mix(col, cc, cover * fade * 0.92);
  }

  // Sun disc (drawn over clouds so it always reads).
  col = mix(col, uSunColor * 3.0, smoothstep(0.99935, 0.9996, s));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Gradient sky dome (1 draw call), linear distance fog matching the horizon colour,
 * hemisphere fill light and a single shadow-casting sun whose orthographic frustum is fitted to the island.
 */
export function createSky(scene: THREE.Scene): Sky {
  const sunDir = new THREE.Vector3(...SUN_DIRECTION).normalize();

  scene.background = new THREE.Color(SKY.horizon);
  scene.fog = new THREE.Fog(FOG.color, FOG.near, FOG.far);

  // --- Sky dome -------------------------------------------------------------
  const domeGeo = new THREE.SphereGeometry(DOME_RADIUS, 32, 16);
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(SKY.zenith) },
      uMid: { value: new THREE.Color(SKY.mid) },
      uHorizon: { value: new THREE.Color(SKY.horizon) },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(SKY.sunColor) },
      uSunGlow: { value: new THREE.Color(SKY.sunGlow) },
      uCloud: { value: new THREE.Color(SKY.cloud) },
      uCloudShade: { value: new THREE.Color(SKY.cloudShade) },
      uTime: { value: 0 },
    },
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    // three applies fog *after* tone mapping using the raw sRGB fog colour, so the dome must skip tone
    // mapping too – otherwise the fogged horizon and the sky would not match.
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
