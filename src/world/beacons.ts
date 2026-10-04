import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { GLSL_COMMON } from '../render/glsl';

// Lights seen from afar after dark: the red aviation lights on the tall things (the power plant's chimney and
// boilers, the unloaders' booms, the wind turbines' nacelles) and the plant's floodlights and street lamps.
// Points a few pixels across, larger near, dimmed by the haze; their glow is the bloom's. Each light's kind
// sets its colour and whether it flashes: obstacle lights on a structure over 150 m flash red at night
// (ICAO Annex 14, medium intensity: 20–60 a minute), the others burn steady; the port's and the channel's
// marks flash red to port and green to starboard as a ship comes in from the sea (IALA region A). Things that
// move (buoys, ships) move their lights each frame (`move`).

export const BEACON = { flashing: 0, red: 1, sodium: 2, white: 3, green: 4, lighthouse: 5 } as const;
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
  vCol = aKind < 1.5 ? vec3(1.0, 0.07, 0.03) : aKind < 2.5 ? vec3(1.0, 0.56, 0.2) : aKind < 3.5 ? vec3(0.88, 0.94, 1.0) : aKind < 4.5 ? vec3(0.1, 1.0, 0.35) : vec3(1.0, 0.97, 0.9);
  // about forty flashes a minute, all together; the green marks a flash every four seconds; the lighthouse a
  // white flash every fifteen, the lens's beam sweeping past (half a second, brightest in its middle)
  float sweep = fract(uTime / 15.0);
  float on = aKind < 0.5 ? step(fract(uTime * 0.667), 0.3) : aKind > 4.5 ? smoothstep(0.035, 0.0, abs(sweep - 0.02)) : aKind > 3.5 ? step(fract(uTime * 0.25 + position.x * 0.013), 0.12) : 1.0;
  // lit from dusk; the haze swallows them with distance
  vA = on * smoothstep(0.2, 0.65, uNight) * exp(-d * uFogDensity * 0.45) * (1.0 - 0.5 * smoothstep(0.3, 0.9, uRain));
  vCol *= aKind < 1.5 ? 1.0 : aKind < 2.5 ? 0.45 : aKind < 3.5 ? 0.6 : aKind < 4.5 ? 1.0 : 2.5;
  // a lighthouse is seen 21 nautical miles off: it keeps its size far beyond the others
  gl_PointSize = uPR * (aKind > 4.5 ? clamp(9000.0 / max(d, 1.0), 6.0, 34.0) : clamp(1600.0 / max(d, 1.0), 2.5, 14.0));
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
  private readonly pos: BufferAttribute;

  constructor(lights: readonly Beacon[]) {
    const pos = new Float32Array(lights.length * 3);
    const kind = new Float32Array(lights.length);
    lights.forEach((l, i) => {
      pos.set([l.x, l.y, l.z], i * 3);
      kind[i] = l.kind;
    });
    const g = new BufferGeometry();
    this.pos = new BufferAttribute(pos, 3);
    g.setAttribute('position', this.pos);
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

  /** Moves light `i` (in the order given); call `commit` once the frame's moves are done. */
  move(i: number, x: number, y: number, z: number): void {
    this.pos.setXYZ(i, x, y, z);
  }

  commit(): void {
    this.pos.needsUpdate = true;
  }
}
