import { BoxGeometry, Color, ConeGeometry, CylinderGeometry, Euler, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, OctahedronGeometry, Quaternion, Vector3 } from 'three';
import { G } from '../core/globals';
import { Rng } from '../core/rng';
import { LINES, place } from '../geo/data';
import { MeshBuilder, rgb, scaleRgb, slab, strut, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { claddingTexture } from '../render/textures';
import { BEACON, Beacons, type Beacon } from './beacons';
import { terrainHeight } from './geography';
import { BERTHS, CHANNEL, ENTRANCE, QUAY, TERMINAL_DEPTH, berthPoint, breakwaterLine } from './portSite';
import { waveHeight } from './waves';

// Matarbari deep-sea port as D5 has it, finished (GEOGRAPHY_PLAN.md §8.6), where world/portSite.ts lays it out:
// - the two breakwaters along OSM's lines: rubble mounds at their real cross-section (crest +6.5 m, 14 m wide,
//   1:1.5 sides) armoured with concrete units on the seaward face, a crown wall along the crest, and a light
//   at each head (red to port coming in, green to starboard: IALA region A);
// - the container berth: its quay wall, fenders and bollards, three ship-to-shore cranes on rails (two
//   working, one with its boom raised), the stacked yard behind with its rubber-tyred gantries, light masts,
//   the terminal's office and workshop;
// - the multipurpose berth with two mobile harbour cranes;
// - lateral buoys along the channel, bobbing on the waves, their lights flashing at night.
// Colours, the armour's kind and the cranes' make are [মডেল]: the terminal is still being built (2029).

const CREST = 6.5;
const CREST_WIDTH = 14;
/** Run per rise of the mound's sides. */
const MOUND_SIDE = 1.5;
/** The deepest its toe reaches (m about MSL): the natural bed at the port's mouth. */
const MOUND_BED = -9;

const ROCK: RGB = rgb('#5d5a54');
const CONCRETE: RGB = rgb('#b5b2aa');
const ARMOUR: RGB = rgb('#a6a39b');
const WHITE: RGB = rgb('#efefeb');
const CRANE_BLUE: RGB = rgb('#4f7fae');
const YELLOW: RGB = rgb('#e7b81c');
const RUBBER: RGB = rgb('#1d1d1d');
const DARK: RGB = rgb('#3c4044');
const WINDOWS: RGB = rgb('#2c3238');

const CONTAINER_COLOURS = ['#1f5fa6', '#b52a20', '#d9b21f', '#1d7a3a', '#e66a1c', '#dcdcd8', '#5b6670', '#7a2f2a', '#2e3d6b', '#2d95c6'].map((c) => rgb(c));

interface Sets {
  concrete: MeshBuilder;
  steel: MeshBuilder;
  clad: MeshBuilder;
}

const m4 = new Matrix4();
const q4 = new Quaternion();
const e4 = new Euler();
const v4 = new Vector3();
const s4 = new Vector3();

/** A three geometry placed, turned (Euler) and scaled, in one colour. */
function put(b: MeshBuilder, g: ConstructorParameters<typeof Mesh>[0], x: number, y: number, z: number, c: RGB, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): void {
  if (!g) return;
  b.add(g, m4.compose(v4.set(x, y, z), q4.setFromEuler(e4.set(rx, ry, rz)), s4.set(sx, sy, sz)), c);
}

// ---------- the breakwaters ----------

/**
 * One breakwater along OSM's line: the mound's profile swept along it (down to the bed), the crest paved, a
 * crown wall on its seaward edge, armour units in rows down the seaward face to low water.
 */
function breakwater(s: Sets, armour: Matrix4[], rng: Rng, p: Float32Array, inside: { x: number; z: number }): { x: number; z: number; out: { x: number; z: number } } {
  // points every ~6 m along the line, with the line's direction there
  const pts: { x: number; z: number; dx: number; dz: number }[] = [];
  for (let k = 2; k < p.length; k += 2) {
    const ax = p[k - 2];
    const az = p[k - 1];
    const bx = p[k];
    const bz = p[k + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) continue;
    const n = Math.max(1, Math.round(len / 6));
    for (let i = k === 2 ? 0 : 1; i <= n; i++) pts.push({ x: ax + ((bx - ax) * i) / n, z: az + ((bz - az) * i) / n, dx: (bx - ax) / len, dz: (bz - az) / len });
  }
  // which side is the sea's: away from the harbour's middle
  const mid = pts[pts.length >> 1];
  const nx0 = mid.dz;
  const nz0 = -mid.dx;
  const seaSide = (inside.x - mid.x) * nx0 + (inside.z - mid.z) * nz0 > 0 ? -1 : 1;
  const rings: number[] = [];
  const profiles: { x: number; z: number; nx: number; nz: number; bed: number; half: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    // the normal toward the sea
    const nx = dz * seaSide;
    const nz = -dx * seaSide;
    // its toe on the natural bed (the channel dredged beside its head does not undercut it)
    const bed = Math.min(Math.max(terrainHeight(pts[i].x, pts[i].z), MOUND_BED), -1);
    const half = CREST_WIDTH / 2 + MOUND_SIDE * (CREST - bed);
    profiles.push({ x: pts[i].x, z: pts[i].z, nx, nz, bed, half });
    const k = s.concrete.vertexCount;
    rings.push(k);
    const side = 1 / Math.hypot(1, MOUND_SIDE);
    const shade = 0.85 + 0.3 * rng.next();
    // sea toe, sea crest, harbour crest, harbour toe (the crest's two points twice, for its own flat normal)
    const P = (o: number, y: number) => new Vector3(pts[i].x + nx * o, y, pts[i].z + nz * o);
    s.concrete.vertex(P(half, bed - 1), new Vector3(nx * MOUND_SIDE * side, side, nz * MOUND_SIDE * side), 0, 0, scaleRgb(ROCK, shade));
    s.concrete.vertex(P(CREST_WIDTH / 2, CREST), new Vector3(nx * MOUND_SIDE * side, side, nz * MOUND_SIDE * side), 0, 1, scaleRgb(ROCK, shade));
    s.concrete.vertex(P(CREST_WIDTH / 2, CREST), new Vector3(0, 1, 0), 0, 0, CONCRETE);
    s.concrete.vertex(P(-CREST_WIDTH / 2, CREST), new Vector3(0, 1, 0), 1, 0, CONCRETE);
    s.concrete.vertex(P(-CREST_WIDTH / 2, CREST), new Vector3(-nx * MOUND_SIDE * side, side, -nz * MOUND_SIDE * side), 0, 1, scaleRgb(ROCK, shade * 0.95));
    s.concrete.vertex(P(-half, bed - 1), new Vector3(-nx * MOUND_SIDE * side, side, -nz * MOUND_SIDE * side), 0, 0, scaleRgb(ROCK, shade * 0.95));
  }
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    // wound to face out whichever way the line runs relative to the sea
    const quad = (p0: number, p1: number) => (seaSide > 0 ? s.concrete.quad(a + p0, a + p1, b + p1, b + p0) : s.concrete.quad(a + p0, b + p0, b + p1, a + p1));
    quad(0, 1);
    quad(2, 3);
    quad(4, 5);
  }
  // the crown wall on the seaward edge of the crest
  for (let i = 0; i < profiles.length - 1; i++) {
    const a = profiles[i];
    const b = profiles[i + 1];
    const o = CREST_WIDTH / 2 - 1;
    strut(s.concrete, a.x + a.nx * o, CREST + 1.2, a.z + a.nz * o, b.x + b.nx * o, CREST + 1.2, b.z + b.nz * o, 1.5, CONCRETE, 2.4);
  }
  // armour units in rows down the seaward face, from the crest to just under low water, jumbled
  for (let i = 0; i < profiles.length; i++) {
    const pr = profiles[i];
    for (let row = 0; ; row++) {
      const y = CREST - 0.6 - row * 1.5;
      if (y < Math.max(pr.bed, -2)) break;
      const o = CREST_WIDTH / 2 + (CREST - y) * MOUND_SIDE + 0.3;
      for (const shift of [0, 0.5]) {
        if (rng.next() < 0.15) continue;
        const along = (shift + rng.range(-0.15, 0.15)) * 6;
        const sc = rng.range(1.3, 1.8);
        armour.push(
          new Matrix4().compose(
            new Vector3(pr.x + pr.nx * o + pts[i].dx * along, y, pr.z + pr.nz * o + pts[i].dz * along),
            new Quaternion().setFromEuler(new Euler(rng.range(0, Math.PI), rng.range(0, Math.PI * 2), rng.range(0, Math.PI))),
            new Vector3(sc, sc * rng.range(0.8, 1.1), sc),
          ),
        );
      }
    }
  }
  // the round head: the seaward half of the profile swept on round its end to the harbour side
  const head = profiles[profiles.length - 1];
  const fwd = pts[pts.length - 1];
  const steps = 10;
  const cap = s.concrete.vertexCount;
  const side = 1 / Math.hypot(1, MOUND_SIDE);
  for (let k = 0; k <= steps; k++) {
    const th = (k / steps) * Math.PI;
    const ox = head.nx * Math.cos(th) + fwd.dx * Math.sin(th);
    const oz = head.nz * Math.cos(th) + fwd.dz * Math.sin(th);
    const n = new Vector3(ox * MOUND_SIDE * side, side, oz * MOUND_SIDE * side);
    s.concrete.vertex(new Vector3(head.x + ox * head.half, head.bed - 1, head.z + oz * head.half), n, 0, 0, scaleRgb(ROCK, 0.9));
    s.concrete.vertex(new Vector3(head.x + ox * (CREST_WIDTH / 2), CREST, head.z + oz * (CREST_WIDTH / 2)), n, 0, 1, scaleRgb(ROCK, 0.9));
  }
  const top = s.concrete.vertexCount;
  s.concrete.vertex(new Vector3(head.x, CREST, head.z), new Vector3(0, 1, 0), 0, 0, CONCRETE);
  for (let k = 0; k <= steps; k++) {
    const th = (k / steps) * Math.PI;
    const ox = head.nx * Math.cos(th) + fwd.dx * Math.sin(th);
    const oz = head.nz * Math.cos(th) + fwd.dz * Math.sin(th);
    s.concrete.vertex(new Vector3(head.x + ox * (CREST_WIDTH / 2), CREST, head.z + oz * (CREST_WIDTH / 2)), new Vector3(0, 1, 0), 0, 0, CONCRETE);
  }
  for (let k = 0; k < steps; k++) {
    const a = cap + k * 2;
    const b = a + 2;
    // wound outward: round from the sea side through the head's front
    if (seaSide > 0) s.concrete.quad(a, b, b + 1, a + 1);
    else s.concrete.quad(a, a + 1, b + 1, b);
    if (seaSide > 0) s.concrete.tri(top, top + 2 + k, top + 1 + k);
    else s.concrete.tri(top, top + 1 + k, top + 2 + k);
  }
  return { x: head.x, z: head.z, out: { x: head.nx, z: head.nz } };
}

/** The light on a breakwater's head: a white concrete tower banded in the mark's colour. */
function headLight(s: Sets, lights: Beacon[], x: number, z: number, colour: RGB, kind: Beacon['kind']): void {
  put(s.concrete, new CylinderGeometry(1.6, 2, 12, 16), x, CREST + 6, z, WHITE);
  put(s.concrete, new CylinderGeometry(1.65, 1.65, 3, 16), x, CREST + 10, z, colour);
  put(s.steel, new CylinderGeometry(0.7, 0.7, 1.4, 12), x, CREST + 12.8, z, DARK);
  lights.push({ x, y: CREST + 13, z, kind });
}

// ---------- the quays ----------

type BerthName = keyof typeof BERTHS;

/** A berth's face: the quay wall down past low water, its coping, fenders, bollards; the cranes' rails if any. */
function quay(s: Sets, name: BerthName, rails: readonly number[], depth: number): void {
  const q = BERTHS[name];
  const len = Math.hypot(q.b.x - q.a.x, q.b.z - q.a.z);
  const ux = (q.b.x - q.a.x) / len;
  const uz = (q.b.z - q.a.z) / len;
  const ry = Math.atan2(-uz, ux);
  const mid = berthPoint(name, len / 2, 0.8);
  slab(s.concrete, mid.x, (QUAY - 7) / 2, mid.z, len, QUAY + 7, 1.6, ry, CONCRETE);
  const edge = berthPoint(name, len / 2, 0.5);
  slab(s.concrete, edge.x, QUAY + 0.12, edge.z, len, 0.25, 1.2, ry, YELLOW);
  for (let t = 8; t < len - 4; t += 16) {
    const f = berthPoint(name, t, -0.6);
    slab(s.steel, f.x, QUAY - 2.6, f.z, 2.4, 3.6, 1.1, ry, RUBBER);
    const b = berthPoint(name, t + 8, 1.4);
    put(s.steel, new CylinderGeometry(0.35, 0.42, 0.8, 10), b.x, QUAY + 0.4, b.z, DARK);
  }
  for (const r of rails) {
    const p = berthPoint(name, len / 2, r);
    slab(s.steel, p.x, QUAY + 0.06, p.z, len - 4, 0.12, 0.35, ry, DARK);
  }
  // its ends walled square down past low water, as far back as the ground behind it is raised
  for (const t of [-0.8, len + 0.8]) {
    const e = berthPoint(name, t, depth / 2);
    slab(s.concrete, e.x, (QUAY - 7) / 2, e.z, 1.6, QUAY + 7, depth, ry, CONCRETE);
  }
}

/** A frame for building on a berth: (x toward the water, y up, z along the face) from the point `t0` along it. */
function berthFrameAt(name: BerthName, t0: number): (x: number, y: number, z: number) => [number, number, number] {
  return (x, y, z) => {
    const p = berthPoint(name, t0 + z, -x);
    return [p.x, y, p.z];
  };
}

/** A beam between two points of a frame. */
function beam(b: MeshBuilder, f: (x: number, y: number, z: number) => [number, number, number], a: readonly [number, number, number], c: readonly [number, number, number], w: number, col: RGB, h = w): void {
  const [ax, ay, az] = f(...a);
  const [cx, cy, cz] = f(...c);
  strut(b, ax, ay, az, cx, cy, cz, w, col, h);
}

/**
 * A ship-to-shore container crane at real size: its portal on rails 30 m apart, the boom 60 m out over the
 * ship (or raised, idle), the A-frame and its stays, the machinery house on the back-reach, the trolley and
 * spreader. Sea-side rail at 3 m from the face.
 */
function stsCrane(s: Sets, lights: Beacon[], t0: number, raised: boolean, rng: Rng): void {
  const f = berthFrameAt('container', t0);
  const y0 = QUAY;
  const sea = -3;
  const land = -33;
  const top = y0 + 47;
  for (const x of [sea, land]) {
    for (const z of [-9, 9]) beam(s.steel, f, [x, y0 + 1, z], [x, top, z], 2.2, CRANE_BLUE);
    // the sill beam and its bogies on the rail
    beam(s.steel, f, [x, y0 + 1.8, -11], [x, y0 + 1.8, 11], 1.8, CRANE_BLUE, 2.2);
    beam(s.steel, f, [x, top, -9], [x, top, 9], 2, CRANE_BLUE, 2.6);
    // the portal's diagonals
    beam(s.steel, f, [x, y0 + 20, -9], [x, top - 2, 9], 0.9, CRANE_BLUE);
  }
  for (const z of [-9, 9]) {
    beam(s.steel, f, [sea, top, z], [land, top, z], 2, CRANE_BLUE, 2.6);
    beam(s.steel, f, [sea, y0 + 12, z], [land, y0 + 12, z], 1.2, CRANE_BLUE, 1.6);
  }
  // the boom: the back-reach girder over the yard, and the sea-side part hinged at the portal
  const by = top + 3;
  for (const z of [-1.8, 1.8]) beam(s.steel, f, [land - 17, by, z], [sea, by, z], 1.6, WHITE, 3.4);
  const tip: [number, number, number] = raised ? [sea + 63 * Math.cos(1.35), by + 63 * Math.sin(1.35), 0] : [sea + 63, by, 0];
  for (const z of [-1.8, 1.8]) beam(s.steel, f, [sea, by, z], [tip[0], tip[1], z], 1.6, WHITE, 3.4);
  // the A-frame and its stays to the boom's tip and the back-reach's end
  const apex: [number, number, number] = [sea - 9, top + 32, 0];
  for (const z of [-7, 7]) {
    beam(s.steel, f, [sea, top, z], [apex[0], apex[1], z * 0.3], 1.4, CRANE_BLUE);
    beam(s.steel, f, [sea - 18, top, z], [apex[0], apex[1], z * 0.3], 1.4, CRANE_BLUE);
  }
  beam(s.steel, f, [apex[0], apex[1], -2], [apex[0], apex[1], 2], 1.4, CRANE_BLUE);
  for (const z of [-1, 1]) {
    beam(s.steel, f, [apex[0], apex[1], z], [tip[0], tip[1] + 1.7, z], 0.35, STEEL_GREY);
    beam(s.steel, f, [apex[0], apex[1], z], [land - 15, by + 1.7, z], 0.35, STEEL_GREY);
  }
  // the machinery house on the back-reach
  const [hx, , hz] = f(land - 8, 0, 0);
  const [ax, , az] = f(land - 8 + 1, 0, 0);
  const ry = Math.atan2(-(az - hz), ax - hx);
  slab(s.clad, hx, by + 6, hz, 16, 7, 14, ry, WHITE);
  slab(s.clad, hx, by + 9.7, hz, 16.4, 0.5, 14.4, ry, CRANE_BLUE);
  // the trolley and its cab out over the ship, the spreader hanging below it
  if (!raised) {
    const at = 20 + rng.range(0, 25);
    const [tx, , tz] = f(at, 0, 0);
    slab(s.steel, tx, by - 2.6, tz, 7, 3, 6, ry, CRANE_BLUE);
    slab(s.clad, tx, by - 5.2, tz, 3, 2.6, 3, ry, WINDOWS);
    const sy = y0 + rng.range(14, 30);
    slab(s.steel, tx, sy, tz, 2.6, 1.2, 12.4, ry + Math.PI / 2, YELLOW);
    for (const o of [-4, 4]) {
      const [rx, , rz] = f(at, 0, o);
      strut(s.steel, rx, by - 4, rz, rx, sy + 0.6, rz, 0.08, DARK);
    }
    const [lx, , lz] = f(at, 0, 0);
    lights.push({ x: lx, y: by - 4.5, z: lz, kind: BEACON.white });
  }
  const [px, py, pz] = f(tip[0], tip[1] + 2, 0);
  lights.push({ x: px, y: py, z: pz, kind: BEACON.red });
  const [qx, qy, qz] = f(apex[0], apex[1] + 1, 0);
  lights.push({ x: qx, y: qy, z: qz, kind: BEACON.red });
}

const STEEL_GREY: RGB = rgb('#8a8f93');

/** A mobile harbour crane on its wheeled base, its tower and cab, its boom slewed out over the berth. */
function harbourCrane(s: Sets, lights: Beacon[], t0: number, slew: number): void {
  const f = berthFrameAt('multipurpose', t0);
  const y0 = QUAY;
  const [cx, , cz] = f(-10, 0, 0);
  const [ax, , az] = f(-9, 0, 0);
  const ry = Math.atan2(-(az - cz), ax - cx);
  slab(s.steel, cx, y0 + 2.2, cz, 8, 3.2, 16, ry, YELLOW);
  for (const [x, z] of [
    [-16, -8],
    [-4, -8],
    [-16, 8],
    [-4, 8],
  ]) {
    beam(s.steel, f, [-10, y0 + 2, 0], [x, y0 + 0.6, z], 0.8, YELLOW);
    const [px, , pz] = f(x, 0, z);
    slab(s.steel, px, y0 + 0.3, pz, 1.4, 0.6, 1.4, ry, DARK);
  }
  beam(s.steel, f, [-10, y0 + 3.5, 0], [-10, y0 + 24, 0], 3.6, YELLOW);
  const [tx, , tz] = f(-10, 0, 0);
  slab(s.clad, tx, y0 + 26, tz, 7, 4, 9, ry + slew, WHITE);
  // the boom from the tower's top out over the water, slewed a little along the quay
  const reach = 46;
  const el = 0.85;
  const bx = -10 + Math.cos(slew) * reach * Math.cos(el);
  const bz = Math.sin(slew) * reach * Math.cos(el);
  const byy = y0 + 25 + reach * Math.sin(el);
  for (const o of [-0.9, 0.9]) beam(s.steel, f, [-8, y0 + 25, o], [bx, byy, bz + o * 0.4], 0.9, YELLOW, 1.3);
  beam(s.steel, f, [bx, byy, bz], [bx, y0 + 12, bz], 0.06, DARK);
  const [lx, ly, lz] = f(bx, byy + 1.5, bz);
  lights.push({ x: lx, y: ly, z: lz, kind: BEACON.red });
}

// ---------- the yard ----------

/** The container stacks behind the container berth, rows of blocks along it, and their gantries over them. */
function yard(s: Sets, rng: Rng, containers: { m: Matrix4; c: RGB }[], lights: Beacon[]): void {
  const len = Math.hypot(BERTHS.container.b.x - BERTHS.container.a.x, BERTHS.container.b.z - BERTHS.container.a.z);
  const q = BERTHS.container;
  const ux = (q.b.x - q.a.x) / len;
  const uz = (q.b.z - q.a.z) / len;
  const ry = Math.atan2(-uz, ux);
  const quat = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ry);
  const ONE = new Vector3(1, 1, 1);
  const rows = 6;
  const pitch = 2.75;
  for (const s0 of [48, 76, 104]) {
    for (const [t0, t1] of [
      [18, 150],
      [172, len - 18],
    ]) {
      const bays = Math.floor((t1 - t0) / 12.6);
      for (let bay = 0; bay < bays; bay++) {
        for (let row = 0; row < rows; row++) {
          // fuller in the middle of a block, ragged at its ends
          const hump = Math.sin(((bay + 0.5) / bays) * Math.PI);
          const tiers = Math.max(0, Math.min(5, Math.round(rng.range(0, 2.2) + hump * 2.6 - (row === 0 ? 1 : 0))));
          for (let k = 0; k < tiers; k++) {
            const p = berthPoint('container', t0 + bay * 12.6 + 6.3, s0 + row * pitch);
            containers.push({ m: new Matrix4().compose(new Vector3(p.x, QUAY + 1.3 + k * 2.6, p.z), quat, ONE), c: rng.pick(CONTAINER_COLOURS) });
          }
        }
      }
      // a rubber-tyred gantry over the block, somewhere along it
      const at = t0 + rng.range(10, t1 - t0 - 10);
      const f = berthFrameAt('container', at);
      const span = [-(s0 - 3), -(s0 + rows * pitch + 3)];
      for (const x of span) {
        for (const z of [-3.5, 3.5]) beam(s.steel, f, [x, QUAY + 1, z], [x, QUAY + 19, z], 0.9, WHITE);
        beam(s.steel, f, [x, QUAY + 1.4, -4], [x, QUAY + 1.4, 4], 0.8, YELLOW, 1.2);
      }
      for (const z of [-3.5, 3.5]) beam(s.steel, f, [span[0], QUAY + 19, z], [span[1], QUAY + 19, z], 0.9, WHITE, 1.6);
      const [tx, , tz] = f((span[0] + span[1]) / 2, 0, 0);
      slab(s.steel, tx, QUAY + 18, tz, 4, 2, 6, ry, YELLOW);
    }
  }
  // the light masts round the yard, the office and the workshop behind it
  for (const [t, sd] of [
    [30, 128],
    [len / 2, 128],
    [len - 30, 128],
    [90, 40],
    [len - 90, 40],
  ]) {
    const p = berthPoint('container', t, sd);
    strut(s.steel, p.x, QUAY, p.z, p.x, QUAY + 32, p.z, 0.8, STEEL_GREY);
    slab(s.steel, p.x, QUAY + 32.4, p.z, 3.4, 0.9, 3.4, ry, DARK);
    lights.push({ x: p.x, y: QUAY + 32, z: p.z, kind: BEACON.white });
  }
  const office = berthPoint('container', len - 40, 128);
  slab(s.clad, office.x, QUAY + 8, office.z, 40, 16, 16, ry, WHITE);
  for (const y of [3, 7, 11, 15]) slab(s.clad, office.x, QUAY + y, office.z, 40.3, 1.6, 16.3, ry, WINDOWS);
  const shop = berthPoint('container', 50, 130);
  slab(s.clad, shop.x, QUAY + 6.5, shop.z, 46, 13, 22, ry, rgb('#c9ccc8'));
  slab(s.clad, shop.x, QUAY + 13.3, shop.z, 46.6, 0.6, 22.6, ry, CRANE_BLUE);
}

// ---------- the port ----------

/** The lateral buoys along the channel: red to port, green to starboard as a ship comes in from the sea. */
interface Buoy {
  x: number;
  z: number;
  red: boolean;
  phase: number;
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpP = new Vector3();
const ONE3 = new Vector3(1, 1, 1);

export class Port {
  readonly group = new Group();
  /** Lights that stand still (the cranes, the masts, the breakwaters' heads); the buoys' move with them. */
  readonly lights: Beacon[] = [];
  private readonly buoys: Buoy[] = [];
  private readonly redBuoys: InstancedMesh;
  private readonly greenBuoys: InstancedMesh;
  private readonly buoyLights: Beacons;

  constructor() {
    this.group.name = 'port';
    const rng = new Rng(813);
    const s: Sets = { concrete: new MeshBuilder(), steel: new MeshBuilder(), clad: new MeshBuilder() };
    const armour: Matrix4[] = [];
    const port = place('matarbari-port').world;
    // the harbour's middle, to tell each breakwater's sea side
    const inside = CHANNEL[3];
    const walls = LINES.filter((l) => l.k === 'structure' && l.t === 'breakwater' && Math.hypot(l.points[0] - port.x, l.points[1] - port.z) < 2500);
    const perimeter = (p: Float32Array) => {
      let l = 0;
      for (let k = 2; k < p.length; k += 2) l += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
      return l;
    };
    walls.sort((a, b) => perimeter(b.points) - perimeter(a.points));
    walls.forEach((l, i) => {
      const head = breakwater(s, armour, rng, breakwaterLine(l.points), inside);
      // the longer, northern breakwater is on a ship's port hand coming in
      const north = i === 0;
      headLight(s, this.lights, head.x, head.z, north ? rgb('#c0281e') : rgb('#1f8a3c'), north ? BEACON.flashing : BEACON.green);
    });
    quay(s, 'container', [3, 33], TERMINAL_DEPTH.container);
    quay(s, 'multipurpose', [], TERMINAL_DEPTH.multipurpose);
    stsCrane(s, this.lights, 70, false, rng);
    stsCrane(s, this.lights, 165, false, rng);
    stsCrane(s, this.lights, 262, true, rng);
    harbourCrane(s, this.lights, 60, 0.35);
    harbourCrane(s, this.lights, 160, -0.25);
    const containers: { m: Matrix4; c: RGB }[] = [];
    yard(s, rng, containers, this.lights);

    const clad = claddingTexture(814);
    const mats = {
      concrete: patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), { grime: 0.35 }),
      steel: patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 }), { grime: 0.15 }),
      clad: patchMaterial(new MeshStandardMaterial({ map: clad, vertexColors: true, roughness: 0.55, metalness: 0.2 }), { grime: 0.12 }),
    };
    for (const key of Object.keys(s) as (keyof Sets)[]) {
      if (!s[key].vertexCount) continue;
      const mesh = new Mesh(s[key].build(), mats[key]);
      mesh.name = `port-${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    // the breakwaters' armour, jumbled concrete units
    const unit = new OctahedronGeometry(1, 0);
    const armourMesh = new InstancedMesh(unit, patchMaterial(new MeshStandardMaterial({ color: '#ffffff', vertexColors: false, roughness: 0.95 }), { grime: 0.5 }), armour.length);
    armour.forEach((m, i) => armourMesh.setMatrixAt(i, m));
    (armourMesh.material as MeshStandardMaterial).color.setRGB(ARMOUR[0], ARMOUR[1], ARMOUR[2]);
    armourMesh.castShadow = true;
    armourMesh.receiveShadow = true;
    armourMesh.computeBoundingSphere();
    armourMesh.name = 'port-armour';
    this.group.add(armourMesh);
    // the containers, each its line's colour, corrugated
    const box = new BoxGeometry(12.19, 2.59, 2.44);
    const boxes = new InstancedMesh(box, patchMaterial(new MeshStandardMaterial({ map: clad, roughness: 0.6, metalness: 0.25 }), { grime: 0.2 }), containers.length);
    const tint = new Color();
    containers.forEach((c, i) => {
      boxes.setMatrixAt(i, c.m);
      boxes.setColorAt(i, tint.setRGB(c.c[0], c.c[1], c.c[2]));
    });
    boxes.castShadow = true;
    boxes.receiveShadow = true;
    boxes.computeBoundingSphere();
    boxes.name = 'port-containers';
    this.group.add(boxes);

    // the buoys: pairs every 500 m from the entrance out to the channel's sea end, and two inside
    for (let k = ENTRANCE; k < CHANNEL.length - 1; k++) {
      const a = CHANNEL[k];
      const b = CHANNEL[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const ux = (b.x - a.x) / len;
      const uz = (b.z - a.z) / len;
      for (let d = k === ENTRANCE ? 150 : 0; d < len; d += 500) {
        const half = a.half + ((b.half - a.half) * d) / len;
        const x = a.x + ux * d;
        const z = a.z + uz * d;
        // coming in from the sea (along −u) the port hand lies along (−uz, ux) (x west, z north)
        this.buoys.push({ x: x - uz * (half + 8), z: z + ux * (half + 8), red: true, phase: rng.range(0, 6) });
        this.buoys.push({ x: x + uz * (half + 8), z: z - ux * (half + 8), red: false, phase: rng.range(0, 6) });
      }
    }
    const buoyShape = (topmark: 'can' | 'cone', colour: RGB) => {
      const b = new MeshBuilder();
      b.add(new CylinderGeometry(1.1, 1.3, 2.2, 14), new Matrix4().makeTranslation(0, 0.4, 0), colour);
      b.add(new CylinderGeometry(0.25, 0.35, 3, 8), new Matrix4().makeTranslation(0, 2.6, 0), colour);
      if (topmark === 'can') b.add(new CylinderGeometry(0.45, 0.45, 0.8, 10), new Matrix4().makeTranslation(0, 4.4, 0), colour);
      else b.add(new ConeGeometry(0.5, 0.9, 10), new Matrix4().makeTranslation(0, 4.45, 0), colour);
      b.add(new CylinderGeometry(1.32, 1.32, 0.35, 14), new Matrix4().makeTranslation(0, -0.6, 0), DARK);
      return b.build();
    };
    const buoyMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), { grime: 0.2 });
    const reds = this.buoys.filter((b) => b.red);
    const greens = this.buoys.filter((b) => !b.red);
    this.redBuoys = new InstancedMesh(buoyShape('can', rgb('#c0281e')), buoyMat, reds.length);
    this.greenBuoys = new InstancedMesh(buoyShape('cone', rgb('#1f8a3c')), buoyMat, greens.length);
    for (const m of [this.redBuoys, this.greenBuoys]) {
      // they bob: never in the shadow map, which is not redrawn as they move
      m.frustumCulled = false;
      m.receiveShadow = true;
      this.group.add(m);
    }
    this.buoys.sort((a, b) => Number(b.red) - Number(a.red));
    this.buoyLights = new Beacons(this.buoys.map((b) => ({ x: b.x, y: 5, z: b.z, kind: b.red ? BEACON.flashing : BEACON.green })));
    this.group.add(this.buoyLights.points);
    this.update(0);
  }

  setPixelRatio(pr: number): void {
    this.buoyLights.setPixelRatio(pr);
  }

  /** The buoys ride the waves, leaning with the water's slope. */
  update(t: number): void {
    let r = 0;
    let g = 0;
    this.buoys.forEach((b, i) => {
      const h = waveHeight(b.x, b.z, t);
      const lean = 0.06 * Math.sin(t * 0.9 + b.phase);
      tmpQ.setFromEuler(tmpE.set(lean, 0, 0.06 * Math.cos(t * 0.7 + b.phase)));
      tmpM.compose(tmpP.set(b.x, G.uWaterLevel.value + h, b.z), tmpQ, ONE3);
      if (b.red) this.redBuoys.setMatrixAt(r++, tmpM);
      else this.greenBuoys.setMatrixAt(g++, tmpM);
      this.buoyLights.move(i, b.x, G.uWaterLevel.value + h + 5, b.z);
    });
    this.redBuoys.instanceMatrix.needsUpdate = true;
    this.greenBuoys.instanceMatrix.needsUpdate = true;
    this.buoyLights.commit();
  }
}
