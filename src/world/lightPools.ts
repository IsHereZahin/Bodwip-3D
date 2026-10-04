import { AdditiveBlending, Color, InstancedMesh, Matrix4, PlaneGeometry, ShaderMaterial } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { GLSL_COMMON } from '../render/glsl';
import { BEACON, type Beacon } from './beacons';
import { terrainHeight } from './geography';

// The pools of light the lamps throw on the ground at night: under the port's masts and its cranes, the plant's
// floodlights and its street lamps. The lamps themselves are points (beacons.ts); without these their yards
// stayed black. Each pool is a soft disc lying on the ground, added to what is drawn there, as wide as its lamp
// is high and as bright as the night is dark; the haze and the rain dim them as they dim the lamps.

/** Only lamps this high over the ground light a pool (m): lower ones are signs and marks, higher ones beacons. */
const HEIGHT = { min: 4, max: 45 };
/** Lamps over ground lower than this stand over the tide's reach: their light would fall on moving water. */
const DRY = 2.7;
/** A pool's radius for its lamp's height (m). */
const reach = (h: number) => Math.min(40, Math.max(7, h * 1.05));
/** Light on the ground by lamp kind (linear, before the night's share): sodium's orange, the floodlights' white. */
const TINT: Partial<Record<number, Color>> = {
  [BEACON.sodium]: new Color(1.0, 0.52, 0.18).multiplyScalar(0.55),
  [BEACON.white]: new Color(0.82, 0.88, 1.0).multiplyScalar(0.42),
};

const VERT = /* glsl */ `
${GLSL_COMMON}
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vTint = instanceColor;
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vWorld;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  // bright under the lamp, fading to its edge
  float fall = pow(max(0.0, 1.0 - r), 1.8) * (0.55 + 0.45 * smoothstep(0.45, 0.0, r));
  float k = fall * smoothstep(0.2, 0.65, uNight) * exp(-distance(vWorld, uCamPos) * uFogDensity * 0.45) * (1.0 - 0.5 * smoothstep(0.3, 0.9, uRain));
  if (k < 0.002) discard;
  gl_FragColor = vec4(vTint * k, 1.0);
}`;

/** The pools under every lamp of `lights` that stands on dry ground, in one draw (on the main camera only). */
export function buildLightPools(lights: readonly Beacon[]): InstancedMesh {
  const pools = lights.flatMap((l) => {
    const tint = TINT[l.kind];
    if (!tint) return [];
    const ground = terrainHeight(l.x, l.z);
    const h = l.y - ground;
    if (ground < DRY || h < HEIGHT.min || h > HEIGHT.max) return [];
    return [{ x: l.x, y: ground, z: l.z, r: reach(h), tint }];
  });
  const plane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const material = new ShaderMaterial({
    uniforms: { ...G },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    // lying on the ground: drawn just in front of it
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const mesh = new InstancedMesh(plane, material, Math.max(1, pools.length));
  mesh.count = pools.length;
  const m = new Matrix4();
  pools.forEach((p, i) => {
    m.makeScale(p.r * 2, 1, p.r * 2).setPosition(p.x, p.y + 0.15, p.z);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, p.tint);
  });
  mesh.computeBoundingSphere();
  mesh.name = 'light-pools';
  mesh.layers.set(LAYER_NO_REFLECT);
  mesh.renderOrder = 2;
  return mesh;
}
