import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { GLSL_COMMON } from '../render/glsl';

// Lights seen from afar after dark: the red aviation lights on the tall things (the power plant's chimney and
// boilers, the unloaders' booms, the wind turbines' nacelles) and the plant's floodlights and street lamps.
// Points a few pixels across, larger near, dimmed by the haze; their glow is the bloom's. Each light's kind
// sets its colour and whether it flashes: obstacle lights on a structure over 150 m flash red at night
// (ICAO Annex 14, medium intensity: 20–60 a minute), the others burn steady.

export const BEACON = { flashing: 0, red: 1, sodium: 2, white: 3 } as const;
export type BeaconKind = (typeof BEACON)[keyof typeof BEACON];

export interface Beacon {
  x: number;
  y: number;
  z: number;
  kind: BeaconKind;
}

const VERT = /* glsl */ `
${GLSL_COMMON}
uniform float uPR;
attribute float aKind;
varying vec3 vCol;
varying float vA;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  vCol = aKind < 1.5 ? vec3(1.0, 0.07, 0.03) : aKind < 2.5 ? vec3(1.0, 0.56, 0.2) : vec3(0.88, 0.94, 1.0);
  // about forty flashes a minute, all together
  float on = aKind < 0.5 ? step(fract(uTime * 0.667), 0.3) : 1.0;
  // lit from dusk; the haze swallows them with distance
  vA = on * smoothstep(0.2, 0.65, uNight) * exp(-d * uFogDensity * 0.45) * (1.0 - 0.5 * smoothstep(0.3, 0.9, uRain));
  vCol *= aKind < 1.5 ? 1.0 : aKind < 2.5 ? 0.45 : 0.6;
  gl_PointSize = uPR * clamp(1600.0 / max(d, 1.0), 2.5, 14.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = (smoothstep(0.5, 0.0, r) * 0.5 + smoothstep(0.2, 0.0, r)) * vA;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol * a * 8.0, 1.0);
}`;

/** All the night lights in one draw. */
export class Beacons {
  readonly points: Points;
  private readonly pr = { value: 1 };

  constructor(lights: readonly Beacon[]) {
    const pos = new Float32Array(lights.length * 3);
    const kind = new Float32Array(lights.length);
    lights.forEach((l, i) => {
      pos.set([l.x, l.y, l.z], i * 3);
      kind[i] = l.kind;
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aKind', new BufferAttribute(kind, 1));
    g.computeBoundingSphere();
    this.points = new Points(
      g,
      new ShaderMaterial({
        uniforms: { ...G, uPR: this.pr },
        vertexShader: VERT,
        fragmentShader: FRAG,
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.points.name = 'beacons';
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_NO_REFLECT);
  }

  setPixelRatio(pr: number): void {
    this.pr.value = pr;
  }
}
