import { BufferAttribute, BufferGeometry, CylinderGeometry, Group, LineSegments, Matrix4, Mesh, MeshStandardMaterial, ShaderMaterial, Vector3 } from 'three';
import type { Material } from 'three';
import { G } from '../core/globals';
import { KIND, LINES, kindAt } from '../geo/data';
import { MeshBuilder, rgb, slab, strut, type RGB } from '../render/builder';
import { GLSL_COMMON } from '../render/glsl';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { plasterTexture } from '../render/textures';
import { terrainHeight } from './geography';
import { onPlant } from './plantSite';

// The power lines OpenStreetMap draws (geo/vectors.bin): a support at every point of a line, its kind by the
// voltage: the 400 kV line north from the Matarbari plant on double-circuit lattice towers, the 132 kV lines
// on smaller single-circuit ones, the 11 and 33 kV distribution lines on concrete poles. Towers and poles at
// real size (D1), so the spans between them are a third as long as they are and the wires hang a little
// slacker than they would. The wires are lines a pixel wide, as faint as the share of the pixel a real
// conductor would cover. The substations OSM outlines are fenced yards with a
// couple of gantries and a transformer. Tower shapes and heights are [মডেল]: OSM has none.

const WIRE_VERT = /* glsl */ `
${GLSL_COMMON}
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const WIRE_FRAG = /* glsl */ `
${GLSL_COMMON}
varying vec3 vWorld;
void main() {
  // a conductor is a few centimetres thick: drawn a pixel wide it covers only a share of that pixel, the
  // less the farther off it is
  float a = clamp(70.0 / distance(vWorld, uCamPos), 0.0, 1.0);
  if (a < 0.02) discard;
  // weathered aluminium, lit by the sun (or the moon) and the sky: bright against dark ground, dark against the sky
  vec3 col = 0.35 * (uKeyColor * 0.32 + uFogColor * 0.6);
  gl_FragColor = vec4(applyAtmosphere(col, vWorld), a);
}`;

let wireMaterial: ShaderMaterial | null = null;

/** Wires hung between points, gathered into one draw. */
export class Wires {
  private readonly pos: number[] = [];

  /** A wire from a to b sagging `sag` m at its middle (the catenary as a parabola), in `n` straight pieces. */
  hang(ax: number, ay: number, az: number, bx: number, by: number, bz: number, sag: number, n = 8): void {
    let px = ax;
    let py = ay;
    let pz = az;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t - 4 * sag * t * (1 - t);
      const z = az + (bz - az) * t;
      this.pos.push(px, py, pz, x, y, z);
      px = x;
      py = y;
      pz = z;
    }
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  build(): LineSegments {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.computeBoundingSphere();
    wireMaterial ??= new ShaderMaterial({ uniforms: { ...G }, vertexShader: WIRE_VERT, fragmentShader: WIRE_FRAG, transparent: true, depthWrite: false });
    const lines = new LineSegments(g, wireMaterial);
    lines.name = 'wires';
    return lines;
  }
}

// ---------- the supports ----------

type Kind = 'hv' | 'mv' | 'pole';

/** Each kind's height (m) and the points its conductors hang from, in its frame: x across the line, y up, z along it. */
const SUPPORT: Record<Kind, { height: number; arms: readonly (readonly [number, number])[]; earth: readonly (readonly [number, number])[]; sag: number }> = {
  // 400 kV double circuit: three phases a side, strings hanging 4 m under the arms; two earth wires on the peaks
  hv: { height: 58, arms: [[-9.5, 30], [9.5, 30], [-11, 38], [11, 38], [-8.5, 46], [8.5, 46]], earth: [[-4, 58], [4, 58]], sag: 0.045 },
  // 132 kV single circuit (OSM: three cables): a delta of arms, one earth wire
  mv: { height: 34, arms: [[-4.6, 22], [4.6, 22], [-4.2, 27]], earth: [[0, 34]], sag: 0.04 },
  // 11/33 kV on a concrete pole: three pin insulators on a crossarm
  pole: { height: 11, arms: [[-0.9, 10.8], [0, 11.1], [0.9, 10.8]], earth: [], sag: 0.03 },
};

const STEEL: RGB = rgb('#8d9193');

/**
 * A lattice tower in its frame: four legs drawn in from the base to the waist, girdles and X bracing on every
 * face, the arms as trusses out to their tips, a peak (or two) for the earth wire.
 */
function latticeTower(kind: 'hv' | 'mv'): MeshBuilder {
  const b = new MeshBuilder();
  const s = SUPPORT[kind];
  const base = kind === 'hv' ? 5.5 : 3.2;
  const waist = kind === 'hv' ? 1.6 : 1.0;
  const top = s.height - (kind === 'hv' ? 4 : 3);
  const leg = kind === 'hv' ? 0.42 : 0.3;
  const brace = kind === 'hv' ? 0.16 : 0.13;
  const panels = kind === 'hv' ? 8 : 5;
  // the body's half-width at a height: tapering to the waist at the lowest arm, straight above
  const lowArm = Math.min(...s.arms.map((a) => a[1])) + (kind === 'hv' ? 4 : 2);
  const half = (y: number) => (y >= lowArm ? waist : base + (waist - base) * (y / lowArm));
  const levels: number[] = [];
  for (let i = 0; i <= panels; i++) levels.push((top * i) / panels);
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const;
  for (let i = 0; i < panels; i++) {
    const y0 = levels[i];
    const y1 = levels[i + 1];
    const h0 = half(y0);
    const h1 = half(y1);
    for (let c = 0; c < 4; c++) {
      const [cx, cz] = corners[c];
      const [nx, nz] = corners[(c + 1) % 4];
      strut(b, cx * h0, y0, cz * h0, cx * h1, y1, cz * h1, leg, STEEL);
      // the girdle round the panel's top, and a cross on each face (one diagonal on the smaller towers)
      strut(b, cx * h1, y1, cz * h1, nx * h1, y1, nz * h1, brace * 1.2, STEEL);
      strut(b, cx * h0, y0, cz * h0, nx * h1, y1, nz * h1, brace, STEEL);
      if (kind === 'hv' && i < 4) strut(b, nx * h0, y0, nz * h0, cx * h1, y1, cz * h1, brace, STEEL);
    }
  }
  // the arms: a bottom chord from each of the body's two faces to the tip, a top chord from above
  for (const [ax, ay] of s.arms) {
    const drop = kind === 'hv' ? 4 : 2;
    const y = ay + drop;
    const w = half(y);
    const side = Math.sign(ax);
    strut(b, side * w, y, -w, ax, y, 0, brace * 1.6, STEEL);
    strut(b, side * w, y, w, ax, y, 0, brace * 1.6, STEEL);
    strut(b, side * w, y + 2.4, 0, ax, y, 0, brace * 1.4, STEEL);
    // the insulator string, pale against the steel
    strut(b, ax, y, 0, ax, ay, 0, 0.18, rgb('#c9c3b6'));
  }
  // the earth peaks
  for (const [ex, ey] of s.earth) {
    for (const [cx, cz] of corners) strut(b, cx * waist, top, cz * waist, ex, ey, 0, brace * 1.3, STEEL);
  }
  // concrete footings round the legs
  for (const [cx, cz] of corners) slab(b, cx * base, 0.3, cz * base, 1.6, 1.0, 1.6, 0, rgb('#9e9a92'));
  return b;
}

/** A spun concrete pole with its crossarm and three pin insulators. */
function poleSupport(): MeshBuilder {
  const b = new MeshBuilder();
  b.add(new CylinderGeometry(0.1, 0.16, 11.4, 7), new Matrix4().makeTranslation(0, 5.7, 0), rgb('#a8a49c'));
  slab(b, 0, 10.6, 0, 2.2, 0.12, 0.12, 0, rgb('#6a6a66'), 1);
  for (const [x, y] of SUPPORT.pole.arms) b.add(new CylinderGeometry(0.06, 0.08, 0.3, 6), new Matrix4().makeTranslation(x, y - 0.12, 0), rgb('#cfc9bc'));
  return b;
}

/** Where a line's conductors attach at a support: its frame's arm tips, turned to the line and set on the ground. */
function attachments(kind: Kind, x: number, y: number, z: number, ry: number): Vector3[] {
  const s = SUPPORT[kind];
  const c = Math.cos(ry);
  const sn = Math.sin(ry);
  // frame x across the line → world (cos ry, 0, −sin ry)
  return [...s.arms, ...s.earth].map(([ax, ay]) => new Vector3(x + ax * c, y + ay, z - ax * sn));
}

/** The power lines and the substations OSM maps, apart from the Matarbari plant's own yard (world/powerPlant.ts). */
export function buildPowerLines(end: { x: number; z: number; points: readonly Vector3[] } | null): Group {
  const group = new Group();
  group.name = 'power-lines';
  const placements: Record<Kind, Placement[]> = { hv: [], mv: [], pole: [] };
  const wires = new Wires();
  const piers = new MeshBuilder();
  for (const l of LINES) {
    if (l.k !== 'power') continue;
    const kind: Kind = (l.v ?? 0) >= 300000 ? 'hv' : (l.v ?? 0) >= 100000 || l.t === 'line' ? 'mv' : 'pole';
    const p = l.points;
    const n = p.length / 2;
    // the supports off the plant's ground (the line runs on into its switchyard from the last of them)
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (!onPlant(p[i * 2], p[i * 2 + 1], 6)) idx.push(i);
    if (idx.length < 2 && !end) continue;
    let prev: Vector3[] | null = null;
    let prevAt: Vector3 | null = null;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const x = p[i * 2];
      const z = p[i * 2 + 1];
      // turned to the bisector of the line either side, so an angle tower stands square to both spans
      const a = idx[Math.max(0, k - 1)];
      const c = idx[Math.min(idx.length - 1, k + 1)];
      const ry = Math.atan2(p[c * 2] - p[a * 2], p[c * 2 + 1] - p[a * 2 + 1]);
      const ground = terrainHeight(x, z);
      // in the water (a tidal channel the line crosses) a tower stands on a concrete pier above the high tides
      const wet = kindAt(x, z) !== KIND.land;
      const y = wet ? Math.max(ground, 3.5) : ground;
      placements[kind].push({ x, y, z, ry, s: 1 });
      const here = attachments(kind, x, y, z, ry);
      if (prev && prevAt) hangSpan(wires, prev, here, Math.hypot(x - prevAt.x, z - prevAt.z) * SUPPORT[kind].sag);
      prev = here;
      prevAt = new Vector3(x, y, z);
      if (wet) piers.add(new CylinderGeometry(4, 4.5, y - ground + 2, 16), new Matrix4().makeTranslation(x, (y + ground - 2) / 2, z), rgb('#9e9a92'));
    }
    // the line that ends in the plant's switchyard: its last span runs to the gantry
    if (end && prev && prevAt && kind === 'hv' && onPlant(p[(n - 1) * 2], p[(n - 1) * 2 + 1], 40)) {
      hangSpan(wires, prev, end.points as Vector3[], Math.hypot(end.x - prevAt.x, end.z - prevAt.z) * SUPPORT.hv.sag);
    }
  }
  const steel = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.45 }), { grime: 0.15 });
  const geometry: Record<Kind, BufferGeometry> = { hv: latticeTower('hv').build(), mv: latticeTower('mv').build(), pole: poleSupport().build() };
  for (const kind of ['hv', 'mv', 'pole'] as const) {
    if (!placements[kind].length) continue;
    const mat: Material = kind === 'pole' ? concreteMat() : steel;
    group.add(instanced(geometry[kind], mat, placements[kind], { chunk: 1200, across: 1200, cast: kind !== 'pole' }));
  }
  if (piers.vertexCount) group.add(new Mesh(piers.build(), concreteMat()));
  if (!wires.empty) group.add(wires.build());
  substations(group);
  return group;
}

/** The conductors of one span: attachment k of one support to attachment k of the next (they share a frame order). */
function hangSpan(wires: Wires, a: readonly Vector3[], b: readonly Vector3[], sag: number): void {
  const n = Math.min(a.length, b.length);
  const span = a[0].distanceTo(b[0]);
  const pieces = Math.max(4, Math.min(14, Math.round(span / 10)));
  for (let k = 0; k < n; k++) wires.hang(a[k].x, a[k].y, a[k].z, b[k].x, b[k].y, b[k].z, sag, pieces);
}

let concrete: MeshStandardMaterial | null = null;
function concreteMat(): MeshStandardMaterial {
  if (!concrete) {
    const t = plasterTexture(611);
    concrete = patchMaterial(new MeshStandardMaterial({ map: t.map, normalMap: t.normal, color: '#b3afa6', vertexColors: true, roughness: 0.9 }), { grime: 0.3 });
  }
  return concrete;
}

/** The substations OSM outlines (not the plant's): a fence round the outline, two gantries and a transformer. */
function substations(group: Group): void {
  const b = new MeshBuilder();
  const steel = new MeshBuilder();
  for (const l of LINES) {
    if (l.k !== 'site' || l.t !== 'substation') continue;
    const p = l.points;
    const n = p.length / 2;
    if (onPlant(p[0], p[1], 30)) continue;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n - 1; i++) (cx += p[i * 2]), (cz += p[i * 2 + 1]);
    cx /= n - 1;
    cz /= n - 1;
    const y0 = terrainHeight(cx, cz);
    // the fence: posts and two rails along each side
    for (let i = 0; i < n - 1; i++) {
      const ax = p[i * 2];
      const az = p[i * 2 + 1];
      const bx = p[i * 2 + 2];
      const bz = p[i * 2 + 3];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.round(len / 3));
      for (let k = 0; k <= steps; k++) {
        const x = ax + ((bx - ax) * k) / steps;
        const z = az + ((bz - az) * k) / steps;
        strut(steel, x, y0, z, x, y0 + 2.4, z, 0.07, STEEL);
      }
      for (const h of [1.1, 2.3]) strut(steel, ax, y0 + h, az, bx, y0 + h, bz, 0.04, STEEL);
    }
    // two gantries across the yard and a transformer between them (the yard's long way is [মডেল])
    const g = Math.min(6, Math.max(2.5, Math.hypot(p[2] - p[0], p[3] - p[1]) / 4));
    for (const off of [-g, g]) {
      for (const side of [-3, 3]) strut(steel, cx + side, y0, cz + off, cx + side, y0 + 9, cz + off, 0.35, STEEL);
      strut(steel, cx - 3.4, y0 + 9, cz + off, cx + 3.4, y0 + 9, cz + off, 0.4, STEEL);
    }
    slab(b, cx, y0 + 1.6, cz, 3.2, 3.2, 2.2, 0, rgb('#555a5c'));
    slab(b, cx, y0 + 0.15, cz, 4, 0.3, 3, 0, rgb('#9e9a92'));
  }
  if (b.vertexCount) group.add(new Mesh(b.build(), concreteMat()));
  if (steel.vertexCount) group.add(new Mesh(steel.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.45 }), {})));
}
