import {
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  ShapeUtils,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { BufferGeometry } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { BUILDINGS, KIND, LINES, kindAt } from '../geo/data';
import { MeshBuilder, rgb, scaleRgb, slab, strut, type RGB } from '../render/builder';
import { GLSL_COMMON } from '../render/glsl';
import { patchMaterial } from '../render/patch';
import { claddingTexture } from '../render/textures';
import { BEACON, type Beacon } from './beacons';
import { onRoad, terrainHeight } from './geography';
import { PLANT, PLATFORM, onPlant, plantOutline, plantReserved } from './plantSite';
import { Wires } from './powerLines';

// The Matarbari coal power plant (CPGCBL, 2 × 600 MW ultra-supercritical; GEOGRAPHY_PLAN.md §8.5), on its
// platform where world/plantSite.ts lays it out. West to east, as the coal goes:
// - the coal berth on the port's basin: its deck on piles, and two grab ship unloaders on rails at OSM's cranes;
// - conveyor galleries on trestles, through transfer towers, to the yard and on up to the boilers' bunkers;
// - the coal yard: four long storage sheds, barrel-roofed, side by side;
// - the 275 m chimney, concrete, red and white bands at its top, its two steel flues standing proud;
// - for each unit a wet FGD absorber, an electrostatic precipitator on its hoppers, and an IHI once-through
//   boiler of the open kind: a steel frame round the lagged furnace and back pass, coal mills at its foot;
// - the bunker bay and the turbine hall (Toshiba's two 600 MW sets), clad in pale profiled steel;
// - the generator transformers and the 400 kV switchyard, whence the line runs north (world/powerLines.ts);
// - a boundary wall round the land side, gates where the roads come in, street lamps along them;
// - the map's own buildings on the site (Microsoft's footprints) as workshops and stores.
// At night the obstacle lights flash on the chimney (ICAO: over 150 m) and the floodlights burn sodium-orange
// on the boilers. While the plant runs, a white plume of water vapour leaves the wet chimney and leans with
// the wind, plainest in cool damp air [মডেল: whether the plant is running is not known; `running` sets it].
// Everything but the plume is static: it casts shadows and shows in the water.
// Colours are [মডেল]: no source gives them; the chimney's bands are the usual obstacle marking.

const PY = PLATFORM;

const CLAD: RGB = rgb('#e2e3de');
const CLAD_GREY: RGB = rgb('#b9bdbd');
const BLUE: RGB = rgb('#3d6ca3');
const WINDOWS: RGB = rgb('#2c3238');
const STEEL: RGB = rgb('#c3c7c8');
const STEEL_DARK: RGB = rgb('#6b7072');
const LAGGING: RGB = rgb('#aeb3b5');
const CONCRETE: RGB = rgb('#bdb9b0');
const CONCRETE_DARK: RGB = rgb('#8f8b83');
const RED: RGB = rgb('#b8281f');
const WHITE: RGB = rgb('#eeeeea');
const SOOT: RGB = rgb('#3a3a38');
const TRANSFORMER: RGB = rgb('#4f5557');
const RUBBER: RGB = rgb('#1e1e1e');

interface Sets {
  clad: MeshBuilder;
  concrete: MeshBuilder;
  steel: MeshBuilder;
}

const mat4 = new Matrix4();
const quat = new Quaternion();
const euler = new Euler();
const v3 = new Vector3();
const scl = new Vector3();

/** A three geometry placed (and turned, and scaled) in one colour. */
function put(b: MeshBuilder, g: BufferGeometry, x: number, y: number, z: number, c: RGB, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): void {
  b.add(g, mat4.compose(v3.set(x, y, z), quat.setFromEuler(euler.set(rx, ry, rz)), scl.set(sx, sy, sz)), c);
}

/** A box on the platform in the block's frame: `a` east of the chimney, `d` north; sizes along a, up, along d. */
function blockBox(b: MeshBuilder, a: number, y: number, d: number, la: number, h: number, ld: number, c: RGB): void {
  const p = PLANT.at(a, d);
  slab(b, p.x, y, p.z, la, h, ld, 0, c);
}

// ---------- the chimney ----------

function chimney(s: Sets, lights: Beacon[]): void {
  const { x, z, height: H, base, top } = PLANT.stack;
  const r = (h: number) => base + (top - base) * (h / H);
  const shell = (h0: number, h1: number, c: RGB) =>
    put(s.concrete, new LatheGeometry([new Vector2(r(h0), 0), new Vector2(r(h1), h1 - h0)], 40), x, PY + h0, z, c);
  put(s.concrete, new CylinderGeometry(base + 2.5, base + 3.2, 3, 40), x, PY + 1.5, z, CONCRETE_DARK);
  shell(0, H - 30, CONCRETE);
  for (let k = 0; k < 5; k++) shell(H - 30 + k * 6, H - 24 + k * 6, k % 2 ? WHITE : RED);
  // its top, and the two flues inside the windshield standing proud of it
  put(s.concrete, new CylinderGeometry(r(H) + 0.3, r(H) + 0.3, 0.8, 40), x, PY + H + 0.4, z, SOOT);
  for (const o of [-2.4, 2.4]) put(s.steel, new CylinderGeometry(2, 2, 4.5, 20), x, PY + H + 2.2, z + o, SOOT);
  // galleries round it at the obstacle lights' levels
  for (const h of [92, 184, H]) {
    put(s.steel, new CylinderGeometry(r(h) + 1.8, r(h) + 1.8, 0.45, 40), x, PY + h - 0.3, z, STEEL_DARK);
    for (let k = 0; k < 4; k++) {
      const ang = (k + 0.5) * (Math.PI / 2);
      lights.push({ x: x + Math.cos(ang) * (r(h) + 1.4), y: PY + h + 0.7, z: z + Math.sin(ang) * (r(h) + 1.4), kind: BEACON.flashing });
    }
  }
  // the flue ducts from the absorbers' tops into its side
  const f = PLANT.fgd;
  for (const sd of [-1, 1]) {
    const from = PLANT.at(f.a, sd * f.d);
    const to = PLANT.at(r(f.height) * 0.6, sd * 4);
    strut(s.clad, from.x, PY + f.height + 3, from.z, to.x, PY + f.height + 3, to.z, 5.5, CLAD_GREY, 6);
  }
}

// ---------- the flue gas line and the boilers ----------

function unit(s: Sets, sd: number, lights: Beacon[]): void {
  const f = PLANT.fgd;
  const e = PLANT.esp;
  const bo = PLANT.boiler;
  // the absorber: a steel drum with a shallow dome, the inlet duct from the precipitator low on its side
  const fp = PLANT.at(f.a, sd * f.d);
  put(s.clad, new CylinderGeometry(f.r, f.r, f.height, 28), fp.x, PY + f.height / 2, fp.z, CLAD);
  put(s.clad, new SphereGeometry(f.r, 28, 6, 0, Math.PI * 2, 0, Math.PI / 2), fp.x, PY + f.height, fp.z, CLAD, 0, 0, 0, 1, 0.3, 1);
  put(s.clad, new CylinderGeometry(f.r + 0.2, f.r + 0.2, 1.5, 28), fp.x, PY + f.height * 0.55, fp.z, BLUE);
  const espIn = PLANT.at(e.a - e.la / 2, sd * e.d);
  strut(s.clad, fp.x, PY + 16, fp.z, espIn.x, PY + 16, espIn.z, 5, CLAD_GREY, 6);
  // the induced-draught fans between them, low down
  const fan = PLANT.at((f.a + e.a - e.la / 2) / 2 + 2, sd * (e.d + 10));
  put(s.steel, new CylinderGeometry(3, 3, 3.5, 16), fan.x, PY + 3, fan.z, STEEL_DARK, Math.PI / 2);
  // the precipitator: its casing on hoppers on a frame, a penthouse on top
  const hoppersTop = PY + 13;
  blockBox(s.clad, e.a, hoppersTop + (e.height - 13) / 2, sd * e.d, e.la, e.height - 13, e.ld, rgb('#97a5b0'));
  blockBox(s.clad, e.a, PY + e.height + 1.5, sd * e.d, e.la * 0.8, 3, e.ld * 0.85, CLAD_GREY);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      const ha = e.a - e.la / 2 + (i + 0.5) * (e.la / 3);
      const hd = sd * e.d - e.ld / 2 + (j + 0.5) * (e.ld / 4);
      const hp = PLANT.at(ha, hd);
      put(s.steel, new ConeGeometry(5.6, 6, 4, 1), hp.x, hoppersTop - 3, hp.z, STEEL_DARK, Math.PI, Math.PI / 4);
    }
  }
  for (const ca of [-1, 0, 1]) {
    for (const cd of [-1, 1]) {
      const cp = PLANT.at(e.a + (ca * e.la) / 2.2, sd * e.d + (cd * e.ld) / 2.2);
      strut(s.steel, cp.x, PY, cp.z, cp.x, hoppersTop, cp.z, 1, STEEL_DARK);
    }
  }
  // the duct from the boiler's back pass into the precipitator
  const bpOut = PLANT.at(bo.a - bo.size / 2, sd * bo.d);
  const espEnd = PLANT.at(e.a + e.la / 2, sd * e.d);
  strut(s.clad, bpOut.x, PY + 30, bpOut.z, espEnd.x, PY + 27, espEnd.z, 7, CLAD_GREY, 8);

  // the boiler: a steel frame 40 m square, columns every 10 m round it, girders every twelve metres, crosses
  // in its corner bays; inside, the lagged furnace and the back pass hung from its top; a clad penthouse and
  // roof over all, and the stair tower at one corner
  const c0 = PLANT.at(bo.a, sd * bo.d);
  const half = bo.size / 2;
  const top = PY + bo.height;
  const at = (i: number, j: number) => ({ x: c0.x - (i - 2) * 10, z: c0.z + (j - 2) * 10 });
  const perimeter: [number, number][] = [];
  for (let i = 0; i < 4; i++) perimeter.push([i, 0]);
  for (let j = 0; j < 4; j++) perimeter.push([4, j]);
  for (let i = 4; i > 0; i--) perimeter.push([i, 4]);
  for (let j = 4; j > 0; j--) perimeter.push([0, j]);
  for (const [i, j] of perimeter) {
    const p = at(i, j);
    strut(s.steel, p.x, PY, p.z, p.x, top, p.z, 1.3, STEEL);
  }
  const levels = [12, 24, 36, 48, 60, 72, 84];
  for (const lv of levels) {
    for (let k = 0; k < perimeter.length; k++) {
      const p = at(...perimeter[k]);
      const q = at(...perimeter[(k + 1) % perimeter.length]);
      strut(s.steel, p.x, PY + lv, p.z, q.x, PY + lv, q.z, 0.8, STEEL, 1.1);
    }
  }
  // crosses in the corner bays of every face, storey by storey
  const bays: [[number, number], [number, number]][] = [];
  for (const k of [0, 3, 4, 7, 8, 11, 12, 15]) bays.push([perimeter[k], perimeter[(k + 1) % perimeter.length]]);
  const storeys = [0, ...levels];
  for (const [a, b] of bays) {
    const p = at(...a);
    const q = at(...b);
    for (let k = 0; k < storeys.length - 1; k++) {
      strut(s.steel, p.x, PY + storeys[k], p.z, q.x, PY + storeys[k + 1], q.z, 0.45, STEEL);
      strut(s.steel, q.x, PY + storeys[k], q.z, p.x, PY + storeys[k + 1], p.z, 0.45, STEEL);
    }
  }
  // grated floors at a few levels
  for (const lv of [12, 36, 60]) slab(s.steel, c0.x, PY + lv + 0.6, c0.z, bo.size - 1, 0.25, bo.size - 1, 0, STEEL_DARK, 6);
  // the furnace toward the bunker bay, the back pass toward the precipitator, the ash hopper under it
  blockBox(s.clad, bo.a + 5, PY + 18 + 35, sd * bo.d, 20, 70, 22, LAGGING);
  blockBox(s.clad, bo.a - 12, PY + 30 + 29, sd * bo.d, 12, 58, 18, scaleRgb(LAGGING, 0.9));
  blockBox(s.steel, bo.a + 5, PY + 13, sd * bo.d, 14, 10, 16, STEEL_DARK);
  // the penthouse and the roof, pale from above
  slab(s.clad, c0.x, top - 4, c0.z, bo.size + 0.4, 8, bo.size + 0.4, 0, CLAD);
  slab(s.clad, c0.x, top + 0.6, c0.z, bo.size + 2, 1.2, bo.size + 2, 0, WHITE);
  // the stair and lift tower, outside the frame's outer corner on the precipitator's side
  const st = PLANT.at(bo.a - half - 3.5, sd * (bo.d + half + 3.5));
  slab(s.clad, st.x, PY + (bo.height + 8) / 2, st.z, 6, bo.height + 8, 6, 0, CLAD_GREY);
  slab(s.clad, st.x, PY + bo.height + 8.3, st.z, 6.6, 0.6, 6.6, 0, BLUE);
  // the coal mills in a row along its outer side, each with its pipe up to the burners
  for (let k = 0; k < 5; k++) {
    const a = bo.a - 14 + k * 7;
    const mp = PLANT.at(a, sd * (bo.d + half + 4));
    put(s.steel, new CylinderGeometry(2.2, 2.6, 9, 16), mp.x, PY + 4.5, mp.z, rgb('#7c8a80'));
    const burner = PLANT.at(bo.a + 5 - 10 + k * 5, sd * (bo.d + 11));
    strut(s.steel, mp.x, PY + 9, mp.z, burner.x, PY + 28 + (k % 2) * 6, burner.z, 0.6, STEEL_DARK);
  }
  // obstacle lights on the roof's corners, floodlights round the frame
  for (const [i, j] of [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ] as const) {
    const p = at(i, j);
    lights.push({ x: p.x, y: top + 1.6, z: p.z, kind: BEACON.red });
  }
  for (const lv of [24, 48, 72]) {
    for (let k = 0; k < perimeter.length; k += 2) {
      const p = at(...perimeter[k]);
      lights.push({ x: p.x + (p.x - c0.x) * 0.04, y: PY + lv + 1.5, z: p.z + (p.z - c0.z) * 0.04, kind: BEACON.sodium });
    }
  }
}

// ---------- the bunker bay, the turbine hall, the transformers, the switchyard ----------

function halls(s: Sets, lights: Beacon[], wires: Wires): { gantry: Vector3[]; entry: { x: number; z: number } } {
  const bu = PLANT.bunker;
  blockBox(s.clad, bu.a, PY + bu.height / 2, 0, bu.la, bu.height, bu.ld, CLAD);
  blockBox(s.clad, bu.a, PY + bu.height - 2.5, 0, bu.la + 0.3, 4, bu.ld + 0.3, BLUE);
  for (const y of [14, 28, 40]) blockBox(s.clad, bu.a, PY + y, 0, bu.la + 0.25, 1.4, bu.ld + 0.25, WINDOWS);
  const tu = PLANT.turbine;
  blockBox(s.clad, tu.a, PY + tu.height / 2, 0, tu.la, tu.height, tu.ld, CLAD);
  blockBox(s.clad, tu.a, PY + tu.height - 4, 0, tu.la + 0.3, 3.5, tu.ld + 0.3, BLUE);
  blockBox(s.clad, tu.a, PY + 13, 0, tu.la + 0.25, 2.2, tu.ld + 0.25, WINDOWS);
  // its roof: two shallow slopes to a ridge down its length, gables at the ends
  const ridge = PY + tu.height + 2.5;
  const eaves = PY + tu.height;
  const ends = [-tu.ld / 2 - 0.4, tu.ld / 2 + 0.4];
  for (const side of [-1, 1]) {
    const e0 = PLANT.at(tu.a + side * (tu.la / 2 + 0.6), ends[0]);
    const e1 = PLANT.at(tu.a + side * (tu.la / 2 + 0.6), ends[1]);
    const r0 = PLANT.at(tu.a, ends[0]);
    const r1 = PLANT.at(tu.a, ends[1]);
    const n = new Vector3(-side * 2.5, tu.la / 2, 0).normalize();
    const b = s.clad;
    const k = b.vertexCount;
    const roof = rgb('#7f8e9a');
    b.vertex(new Vector3(e0.x, eaves, e0.z), n, 0, 0, roof);
    b.vertex(new Vector3(e1.x, eaves, e1.z), n, tu.ld / 3, 0, roof);
    b.vertex(new Vector3(r1.x, ridge, r1.z), n, tu.ld / 3, tu.la / 6, roof);
    b.vertex(new Vector3(r0.x, ridge, r0.z), n, 0, tu.la / 6, roof);
    // wound to face up and out whichever side it is on
    if (side > 0) b.quad(k, k + 1, k + 2, k + 3);
    else b.quad(k, k + 3, k + 2, k + 1);
  }
  for (const d of ends) {
    const l = PLANT.at(tu.a - tu.la / 2, d);
    const rr = PLANT.at(tu.a + tu.la / 2, d);
    const m = PLANT.at(tu.a, d);
    const n = new Vector3(0, 0, Math.sign(d));
    const k = s.clad.vertexCount;
    s.clad.vertex(new Vector3(l.x, eaves, l.z), n, 0, 0, CLAD);
    s.clad.vertex(new Vector3(rr.x, eaves, rr.z), n, 1, 0, CLAD);
    s.clad.vertex(new Vector3(m.x, ridge, m.z), n, 0.5, 1, CLAD);
    if (d > 0) s.clad.tri(k, k + 2, k + 1);
    else s.clad.tri(k, k + 1, k + 2);
    // the big doors at each end
    blockBox(s.clad, tu.a, PY + 6, d * 0.995, 10, 12, 0.6, WINDOWS);
  }
  for (let k = 0; k < 6; k++) {
    for (const side of [-1, 1]) {
      const p = PLANT.at(tu.a + side * (tu.la / 2 + 0.6), -tu.ld / 2 + (k + 0.5) * (tu.ld / 6));
      lights.push({ x: p.x, y: PY + 22, z: p.z, kind: BEACON.sodium });
    }
  }

  // the generator transformers east of the hall, a fire wall between them
  const tr = PLANT.transformer;
  const bushings: Vector3[] = [];
  for (const sd of [-1, 1]) {
    const p = PLANT.at(tr.a, sd * tr.d);
    slab(s.concrete, p.x, PY + 0.4, p.z, 10, 0.8, 13, 0, CONCRETE_DARK);
    slab(s.steel, p.x, PY + 3.8, p.z, 5.5, 6, 8.5, 0, TRANSFORMER);
    for (let k = 0; k < 5; k++) {
      for (const side of [-1, 1]) slab(s.steel, p.x + side * 3.6, PY + 3.6, p.z - 3.4 + k * 1.7, 1.6, 4.6, 0.15, 0, TRANSFORMER);
    }
    put(s.steel, new CylinderGeometry(0.9, 0.9, 6, 12), p.x, PY + 7.6, p.z - 2.5, TRANSFORMER, 0, 0, Math.PI / 2);
    for (let k = -1; k <= 1; k++) {
      put(s.steel, new CylinderGeometry(0.18, 0.3, 3.2, 8), p.x - 1.5, PY + 8.4, p.z + k * 2.4, rgb('#b08a62'));
      bushings.push(new Vector3(p.x - 1.5, PY + 10, p.z + k * 2.4));
    }
    const wall = PLANT.at(tr.a, sd * (tr.d - 9));
    slab(s.concrete, wall.x, PY + 5, wall.z, 9, 10, 0.5, 0, CONCRETE);
  }

  // the 400 kV switchyard: a gravel yard, two rows of gantries, the breakers and their posts between, busbars
  const sw = PLANT.switchyard;
  const yardC = PLANT.at((sw.a0 + sw.a1) / 2, (sw.d0 + sw.d1) / 2);
  slab(s.concrete, yardC.x, PY + 0.08, yardC.z, sw.a1 - sw.a0, 0.16, sw.d1 - sw.d0, 0, rgb('#8d8b85'), 2);
  const rows = [sw.a0 + 4, sw.a1 - 4];
  const cols = [-27, -9, 9, 27];
  for (const a of rows) {
    for (const d of cols) {
      const p = PLANT.at(a, d);
      strut(s.steel, p.x + 1, PY, p.z, p.x + 0.3, PY + sw.gantry, p.z, 0.5, STEEL);
      strut(s.steel, p.x - 1, PY, p.z, p.x - 0.3, PY + sw.gantry, p.z, 0.5, STEEL);
    }
    const l = PLANT.at(a, cols[0]);
    const r = PLANT.at(a, cols[3]);
    strut(s.steel, l.x, PY + sw.gantry, l.z, r.x, PY + sw.gantry, r.z, 0.7, STEEL, 1.6);
  }
  const phases = [-3.5, 0, 3.5];
  for (const bay of [-18, 0, 18]) {
    for (const ph of phases) {
      for (const a of [sw.a0 + 12, (sw.a0 + sw.a1) / 2, sw.a1 - 12]) {
        const p = PLANT.at(a, bay + ph);
        strut(s.steel, p.x, PY, p.z, p.x, PY + 3, p.z, 0.35, STEEL_DARK);
        put(s.steel, new CylinderGeometry(0.22, 0.28, 3.4, 8), p.x, PY + 4.7, p.z, rgb('#b08a62'));
      }
      const p0 = PLANT.at(sw.a0 + 12, bay + ph);
      const p1 = PLANT.at(sw.a1 - 12, bay + ph);
      strut(s.steel, p0.x, PY + 6.6, p0.z, p1.x, PY + 6.6, p1.z, 0.2, STEEL);
    }
  }
  // the transformers' leads up to the gantry nearest them
  const gantryNear = (d: number) => PLANT.at(rows[0], d);
  bushings.forEach((p, k) => {
    const g = gantryNear(-27 + (k % 6) * 10.8);
    wires.hang(p.x, p.y, p.z, g.x, PY + sw.gantry - 0.8, g.z, 1.5, 8);
  });
  // where the 400 kV line's six conductors and two earth wires come in: the far gantry's beam
  const gantry: Vector3[] = [];
  for (const d of [-22.5, 22.5, -15, 15, -7.5, 7.5]) {
    const p = PLANT.at(rows[1], d);
    gantry.push(new Vector3(p.x, PY + sw.gantry - 0.8, p.z));
  }
  for (const d of [-27, 27]) {
    const p = PLANT.at(rows[1], d);
    gantry.push(new Vector3(p.x, PY + sw.gantry + 0.8, p.z));
  }
  return { gantry, entry: PLANT.at(rows[1], 0) };
}

// ---------- the coal: sheds, conveyors, the berth and its unloaders ----------

/** One storage shed along x over the yard: walls, a barrel roof of profiled sheet, closed ends with doors. */
function shed(s: Sets, x0: number, x1: number, zc: number, span: number): void {
  const wall = 5;
  const rise = 17;
  const segs = 18;
  const b = s.clad;
  // the cross-section, wall foot to wall foot over the arch, with each point's outward normal (in z, y)
  const prof: { d: number; y: number; nz: number; ny: number; v: number }[] = [];
  const push = (d: number, y: number, nz: number, ny: number) => {
    const last = prof[prof.length - 1];
    const v = last ? last.v + Math.hypot(d - last.d, y - last.y) : 0;
    prof.push({ d, y, nz, ny, v });
  };
  push(-span / 2, 0, -1, 0);
  for (let i = 0; i <= segs; i++) {
    const th = Math.PI - (i / segs) * Math.PI;
    const nz = Math.cos(th) / (span / 2);
    const ny = Math.sin(th) / rise;
    const l = Math.hypot(nz, ny);
    push((span / 2) * Math.cos(th), wall + rise * Math.sin(th), nz / l, ny / l);
  }
  push(span / 2, 0, 1, 0);
  const len = x1 - x0;
  const roofC = rgb('#ebe6d8');
  const base = b.vertexCount;
  for (const p of prof) {
    const c = p.y > wall + 0.5 ? roofC : CLAD_GREY;
    b.vertex(new Vector3(x0, PY + p.y, zc + p.d), new Vector3(0, p.ny, p.nz), 0, p.v / 3, c);
    b.vertex(new Vector3(x1, PY + p.y, zc + p.d), new Vector3(0, p.ny, p.nz), len / 3, p.v / 3, c);
  }
  for (let i = 0; i < prof.length - 1; i++) {
    const a = base + i * 2;
    // wound outward: along x then up the profile
    b.quad(a, a + 2, a + 3, a + 1);
  }
  // the end walls, a fan from the middle of the floor, and a door in each
  for (const [x, nx] of [
    [x0, -1],
    [x1, 1],
  ] as const) {
    const k = b.vertexCount;
    const n = new Vector3(nx, 0, 0);
    b.vertex(new Vector3(x, PY, zc), n, 0, 0, CLAD_GREY);
    for (const p of prof) b.vertex(new Vector3(x, PY + p.y, zc + p.d), n, p.d / 3, p.y / 3, CLAD_GREY);
    for (let i = 0; i < prof.length - 1; i++) {
      if (nx > 0) b.tri(k, k + 1 + i, k + 2 + i);
      else b.tri(k, k + 2 + i, k + 1 + i);
    }
    slab(b, x + nx * 0.3, PY + 5, zc, 0.5, 10, span * 0.35, 0, WINDOWS);
  }
  // ribs over the roof every 15 m, a little proud of it
  for (let x = x0 + 7.5; x < x1 - 2; x += 15) {
    for (let i = 1; i < prof.length - 2; i++) {
      const p = prof[i];
      const q = prof[i + 1];
      strut(s.steel, x, PY + p.y + p.ny * 0.25, zc + p.d + p.nz * 0.25, x, PY + q.y + q.ny * 0.25, zc + q.d + q.nz * 0.25, 0.4, STEEL);
    }
  }
}

/** A conveyor gallery on trestles from a to b (heights are its floor's), clad, with a walkway roof. */
function gallery(s: Sets, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
  strut(s.clad, ax, ay + 1.6, az, bx, by + 1.6, bz, 3.4, CLAD_GREY, 3.2);
  strut(s.clad, ax, ay + 3.3, az, bx, by + 3.3, bz, 3.9, BLUE, 0.25);
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.floor(len / 22);
  const ux = (bz - az) / len;
  const uz = -(bx - ax) / len;
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const y = ay + (by - ay) * t;
    const foot = terrainHeight(x, z);
    if (y - foot < 3) continue;
    for (const side of [-1, 1]) strut(s.steel, x + ux * side * 2.6, foot, z + uz * side * 2.6, x + ux * side * 1.5, y, z + uz * side * 1.5, 0.5, STEEL);
    strut(s.steel, x + ux * 2.2, (foot + y) / 2, z + uz * 2.2, x - ux * 2.2, (foot + y) / 2, z - uz * 2.2, 0.35, STEEL);
  }
}

/** A transfer tower: clad, a blue band at its top. */
function transferTower(s: Sets, x: number, z: number, height: number): void {
  slab(s.clad, x, PY + height / 2, z, 10, height, 10, 0, CLAD_GREY);
  slab(s.clad, x, PY + height - 1.5, z, 10.3, 2.5, 10.3, 0, BLUE);
  slab(s.clad, x, PY + height + 0.3, z, 10.8, 0.6, 10.8, 0, STEEL_DARK);
}

function coal(s: Sets, lights: Beacon[]): void {
  const y = PLANT.yard;
  const pitch = (y.z1 - y.z0) / PLANT.sheds;
  for (let k = 0; k < PLANT.sheds; k++) shed(s, y.x0 + 2, y.x1 - 2, y.z0 + pitch * (k + 0.5), pitch - 2.5);
  // the yard's floodlight masts at its corners
  for (const [x, z] of [
    [y.x0 - 6, y.z0 - 6],
    [y.x1 + 6, y.z0 - 6],
    [y.x0 - 6, y.z1 + 6],
    [y.x1 + 6, y.z1 + 6],
  ]) {
    strut(s.steel, x, PY, z, x, PY + 30, z, 0.7, STEEL);
    slab(s.steel, x, PY + 30.5, z, 3, 0.8, 3, 0, STEEL_DARK);
    lights.push({ x, y: PY + 30, z, kind: BEACON.white });
  }
  const t = PLANT.towers;
  transferTower(s, t.berth.x, t.berth.z, t.berth.height);
  transferTower(s, t.yard.x, t.yard.z, t.yard.height);
  // berth → the tower by the yard's north-west corner → along the yard's north side → the tower at its east
  // end → up to the bunkers
  const berthEnd = { x: PLANT.berth.x1 - UNLOADER_OFFSET, z: PLANT.berth.z1 - 4 };
  gallery(s, berthEnd.x, PY + 1, berthEnd.z, t.berth.x + 5, PY + t.berth.height - 6, t.berth.z);
  gallery(s, t.berth.x - 5, PY + t.berth.height - 6, t.berth.z, t.yard.x + 5, PY + t.yard.height - 6, t.yard.z);
  const bunkerTop = PLANT.at(PLANT.bunker.a, PLANT.bunker.ld / 2 - 2);
  gallery(s, t.yard.x - 5, PY + t.yard.height - 6, t.yard.z, bunkerTop.x, PY + PLANT.bunker.height - 4, bunkerTop.z);
  // the berth's own conveyor along its deck, under the unloaders' hoppers
  const bx = PLANT.berth.x1 - UNLOADER_OFFSET;
  slab(s.clad, bx, PY + 1.2, (PLANT.berth.z0 + PLANT.berth.z1) / 2, 2.4, 2, PLANT.berth.z1 - PLANT.berth.z0 - 6, 0, CLAD_GREY);
}

/** How far in from the berth's seaward edge the unloaders' portals stand (m): their seaward rail near the edge. */
const UNLOADER_OFFSET = 10;

/** A grab ship unloader on the berth at (x, z): portal on rails, machinery house, boom out over the water (+x). */
function unloader(s: Sets, x: number, z: number, lights: Beacon[], wires: Wires): void {
  const y0 = PY;
  const portal = 18;
  for (const dx of [-8, 8]) {
    for (const dz of [-7, 7]) strut(s.steel, x + dx, y0 + 0.6, z + dz, x + dx * 0.9, y0 + portal, z + dz * 0.9, 1.4, WHITE);
    // the sill beam on its bogies along the rail
    strut(s.steel, x + dx, y0 + 0.8, z - 8, x + dx, y0 + 0.8, z + 8, 1.2, STEEL_DARK, 1.4);
  }
  slab(s.steel, x, y0 + portal + 1, z, 18, 2, 15, 0, WHITE);
  // the hopper the grab drops into, on the portal's seaward side
  slab(s.steel, x + 5, y0 + portal - 4, z, 8, 5, 8, 0, scaleRgb(WHITE, 0.9));
  put(s.steel, new ConeGeometry(5.2, 4, 4), x + 5, y0 + portal - 8.5, z, STEEL_DARK, Math.PI, Math.PI / 4);
  // the machinery house on the landward side, the operator's cab under the boom
  slab(s.clad, x - 5, y0 + portal + 6, z, 11, 8, 11, 0, BLUE);
  slab(s.clad, x + 12, y0 + portal + 4.2, z + 2.6, 3.2, 3, 3, 0, WINDOWS);
  // the apex frame and the boom, from its back-reach over the land to its tip over the ship
  const apex = { x: x + 1, y: y0 + portal + 26 };
  for (const dz of [-3.5, 3.5]) {
    strut(s.steel, x - 6, y0 + portal + 2, z + dz * 1.6, apex.x, apex.y, z + dz * 0.4, 1, WHITE);
    strut(s.steel, x + 6, y0 + portal + 2, z + dz * 1.6, apex.x, apex.y, z + dz * 0.4, 1, WHITE);
  }
  const boomY = y0 + portal + 9;
  strut(s.steel, x - 24, boomY, z, x + 44, boomY, z, 2.4, WHITE, 3.2);
  for (const dz of [-0.9, 0.9]) {
    strut(s.steel, apex.x, apex.y, z + dz, x + 40, boomY + 1.6, z + dz, 0.45, STEEL);
    strut(s.steel, apex.x, apex.y, z + dz, x - 22, boomY + 1.6, z + dz, 0.45, STEEL);
  }
  // the trolley out over the hold and the grab hanging from it
  slab(s.steel, x + 30, boomY - 2.2, z, 5, 2, 3.6, 0, STEEL_DARK);
  slab(s.steel, x + 30, y0 + 9, z, 3.6, 3, 3.2, 0, rgb('#c58b2a'));
  for (const dz of [-1, 1]) wires.hang(x + 30, boomY - 3.2, z + dz, x + 30, y0 + 10.5, z + dz, 0, 2);
  lights.push({ x: x + 44, y: boomY + 2, z, kind: BEACON.red });
  lights.push({ x: apex.x, y: apex.y + 1, z, kind: BEACON.red });
  lights.push({ x: x + 22, y: boomY - 2, z, kind: BEACON.white });
}

/** The piers near the plant (OSM's outlines): the coal berth and the oil jetty level with the platform, the small landings on the Kohelia lower. */
function piers(s: Sets): void {
  const out = plantOutline();
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let k = 0; k < out.length; k += 2) {
    x0 = Math.min(x0, out[k]);
    x1 = Math.max(x1, out[k]);
    z0 = Math.min(z0, out[k + 1]);
    z1 = Math.max(z1, out[k + 1]);
  }
  for (const l of LINES) {
    if (l.k !== 'structure' || l.t !== 'pier') continue;
    const p = l.points;
    const n = p.length / 2;
    if (n < 4 || p[0] < x0 - 60 || p[0] > x1 + 60 || p[1] < z0 - 60 || p[1] > z1 + 60) continue;
    let touches = false;
    for (let i = 0; i < n; i++) touches ||= onPlant(p[i * 2], p[i * 2 + 1], 8);
    const top = touches ? PY : 4.2;
    const contour: Vector2[] = [];
    for (let i = 0; i < n - 1; i++) contour.push(new Vector2(p[i * 2], p[i * 2 + 1]));
    // a deck: its top over the outline, its edges down a metre and a half
    const tris = ShapeUtils.triangulateShape(contour, []);
    const up = new Vector3(0, 1, 0);
    const b = s.concrete;
    const k = b.vertexCount;
    for (const c of contour) b.vertex(new Vector3(c.x, top, c.y), up, c.x / 3, c.y / 3, CONCRETE);
    for (const [i0, i1, i2] of tris) {
      const a = contour[i0];
      const bq = contour[i1];
      const c = contour[i2];
      // a triangle faces up (+y) when it turns clockwise in (x, z)
      const turn = (bq.x - a.x) * (c.y - a.y) - (bq.y - a.y) * (c.x - a.x);
      if (turn < 0) b.tri(k + i0, k + i1, k + i2);
      else b.tri(k + i0, k + i2, k + i1);
    }
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i];
      const c = contour[(i + 1) % contour.length];
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      if (len < 0.2) continue;
      slab(b, (a.x + c.x) / 2, top - 0.8, (a.y + c.y) / 2, len, 1.6, 0.3, Math.atan2(-(c.y - a.y), c.x - a.x), CONCRETE_DARK);
    }
    // piles on a grid under it, down into the bed
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const c of contour) (minX = Math.min(minX, c.x)), (maxX = Math.max(maxX, c.x)), (minZ = Math.min(minZ, c.y)), (maxZ = Math.max(maxZ, c.y));
    const pile = new CylinderGeometry(0.5, 0.5, 1, 8);
    for (let x = minX + 3; x < maxX - 1; x += 7) {
      for (let z = minZ + 3; z < maxZ - 1; z += 7) {
        if (!inside(contour, x, z)) continue;
        const bed = Math.min(terrainHeight(x, z), top - 3);
        const bottom = bed - 6;
        put(b, pile, x, (top - 1.6 + bottom) / 2, z, CONCRETE_DARK, 0, 0, 0, 1, top - 1.6 - bottom, 1);
      }
    }
    // fenders along its seaward face
    if (touches) {
      for (let z = minZ + 4; z < maxZ - 2; z += 12) {
        if (!inside(contour, maxX - 1, z)) continue;
        put(s.steel, new CylinderGeometry(0.8, 0.8, 2.6, 10), maxX + 0.5, top - 2, z, RUBBER);
        put(s.steel, new CylinderGeometry(0.35, 0.4, 0.8, 10), maxX - 1.2, top + 0.4, z + 6, SOOT);
      }
    }
  }
}

function inside(poly: readonly Vector2[], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// ---------- the wall, the lamps, the site's other buildings ----------

/** The boundary wall round the land side of the site, a gate gap wherever a road comes through; none along the basin's quay. */
function boundary(s: Sets): void {
  const p = plantOutline();
  const n = p.length / 2;
  for (let i = 0; i < n - 1; i++) {
    const ax = p[i * 2];
    const az = p[i * 2 + 1];
    const bx = p[i * 2 + 2];
    const bz = p[i * 2 + 3];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1) continue;
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    const pieces = Math.max(1, Math.round(len / 4));
    const ry = Math.atan2(-uz, ux);
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      // the quay: water a few metres out either side of the line (the outline runs along the basin there)
      const quay = [-8, 8].some((o) => kindAt(x - uz * o, z + ux * o) !== KIND.land);
      if (quay || onRoad(x, z, 2)) continue;
      slab(s.concrete, x, PY + 1.25, z, len / pieces + 0.02, 2.5, 0.25, ry, CONCRETE);
      slab(s.concrete, x, PY + 2.55, z, len / pieces + 0.02, 0.12, 0.4, ry, CONCRETE_DARK);
      if (k % 2 === 0) slab(s.concrete, x - (ux * len) / pieces / 2, PY + 1.35, z - (uz * len) / pieces / 2, 0.45, 2.7, 0.45, ry, CONCRETE_DARK);
    }
  }
}

/** Street lamps along the site's roads every 30 m, standing off them. */
function lamps(s: Sets, lights: Beacon[]): void {
  for (const l of LINES) {
    if (l.k !== 'road') continue;
    const p = l.points;
    let carry = 0;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k];
      const az = p[k + 1];
      const len = Math.hypot(p[k + 2] - ax, p[k + 3] - az);
      if (len < 0.1) continue;
      const ux = (p[k + 2] - ax) / len;
      const uz = (p[k + 3] - az) / len;
      for (let d = 30 - carry; d < len; d += 30) {
        const x = ax + ux * d - uz * 4;
        const z = az + uz * d + ux * 4;
        if (!onPlant(x, z, -4) || plantReserved(x, z, 3) || onRoad(x, z, 0.5)) continue;
        strut(s.steel, x, PY, z, x, PY + 9, z, 0.2, STEEL_DARK);
        strut(s.steel, x, PY + 9, z, x + uz * 1.4, PY + 9.1, z - ux * 1.4, 0.12, STEEL_DARK);
        lights.push({ x: x + uz * 1.4, y: PY + 8.8, z: z - ux * 1.4, kind: BEACON.sodium });
      }
      carry = (carry + len) % 30;
    }
  }
}

/** The map's buildings on the site, off the plant's own parts: workshops, stores and offices, clad, flat-roofed. */
function siteBuildings(s: Sets): void {
  const B = BUILDINGS;
  for (let i = 0; i < B.count; i++) {
    const x = B.x[i];
    const z = B.z[i];
    const l = B.l[i];
    const w = B.w[i];
    const reach = 0.5 * Math.hypot(l, w);
    if (!onPlant(x, z, -reach - 2) || plantReserved(x, z, reach + 4) || onRoad(x, z, reach * 0.6)) continue;
    const area = l * w;
    const h = area > 1500 ? 14 : area > 300 ? 8 : 4;
    const wall = area > 300 ? CLAD : rgb('#d9d4c4');
    slab(s.clad, x, PY + h / 2, z, l, h, w, B.yaw[i], wall);
    slab(s.clad, x, PY + h + 0.25, z, l + 0.5, 0.5, w + 0.5, B.yaw[i], area > 300 ? rgb('#6e8fa8') : rgb('#7d8a7a'));
    if (h >= 8) slab(s.clad, x, PY + h * 0.55, z, l + 0.2, 1.4, w + 0.2, B.yaw[i], WINDOWS);
  }
}

// ---------- the plume ----------

const PLUME_VERT = /* glsl */ `
${GLSL_COMMON}
uniform vec3 uTop;
uniform float uPlume;
attribute float aSeed;
varying vec2 vUv;
varying vec3 vWorld;
varying float vA;
varying float vSeed;
void main() {
  // each puff is born at the flue, rises fast while it is warm, levels off and drifts downwind growing
  float life = 90.0;
  float age = fract(uTime / life + aSeed) * life;
  float k = age / life;
  float ws = 1.2 + 4.0 * uWind.z;
  float rise = 70.0 * (1.0 - exp(-age / 14.0)) / (0.6 + 0.4 * uWind.z) + age * 0.12;
  vec3 c = uTop + vec3(uWind.x, 0.0, uWind.y) * ws * age + vec3(0.0, rise, 0.0);
  c += vec3(sin(age * 0.21 + aSeed * 40.0), 0.5 * sin(age * 0.17 + aSeed * 23.0), cos(age * 0.19 + aSeed * 31.0)) * (1.5 + age * 0.25);
  float size = 6.0 + age * 0.75;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 p = c + (right * position.x + up * position.y) * size * 2.0;
  vWorld = p;
  vUv = position.xy + 0.5;
  vSeed = aSeed;
  vA = uPlume * smoothstep(0.0, 0.04, k) * (1.0 - smoothstep(0.2, 1.0, k));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const PLUME_FRAG = /* glsl */ `
${GLSL_COMMON}
varying vec2 vUv;
varying vec3 vWorld;
varying float vA;
varying float vSeed;
void main() {
  vec2 q = vUv - 0.5;
  float n = vnoise(vUv * 3.0 + vSeed * 17.0) * 0.6 + vnoise(vUv * 7.0 + vSeed * 5.0) * 0.4;
  float a = smoothstep(1.0, 0.2, length(q) * 2.0 + (n - 0.5) * 0.7) * vA * 0.45;
  if (a < 0.004) discard;
  // white vapour lit by the sun (or the moon) and the sky's haze, shadowed a little underneath
  vec3 col = uKeyColor * (0.12 + 0.2 * max(uKeyDir.y, 0.0)) * (0.8 + 0.4 * vUv.y) + uFogColor * 0.85;
  gl_FragColor = vec4(applyAtmosphere(col, vWorld), a);
}`;

/** The vapour from the chimney: 60 soft puffs on their own clock, drawn back to front by the GPU's luck. */
function plume(): { mesh: Mesh; strength: { value: number } } {
  const n = 60;
  const g = new InstancedBufferGeometry();
  const quad = new PlaneGeometry(1, 1);
  g.index = quad.index;
  g.setAttribute('position', quad.getAttribute('position'));
  const seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) seeds[i] = i / n;
  g.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
  g.instanceCount = n;
  const strength = { value: 0 };
  const top = new Vector3(PLANT.stack.x, PY + PLANT.stack.height + 4, PLANT.stack.z);
  const mesh = new Mesh(
    g,
    new ShaderMaterial({
      uniforms: { ...G, uTop: { value: top }, uPlume: strength },
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    }),
  );
  mesh.name = 'plant-plume';
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER_NO_REFLECT);
  return { mesh, strength };
}

// ---------- the whole ----------

export class PowerPlant {
  readonly group = new Group();
  readonly lights: Beacon[] = [];
  /** Whether the plant is generating (its plume shows): not known for today, so it is taken to be. */
  running = true;
  /** The points the 400 kV line's conductors end at on the switchyard's far gantry, and where that is. */
  readonly lineEnd: { x: number; z: number; points: readonly Vector3[] };
  private readonly plume: { mesh: Mesh; strength: { value: number } };

  constructor() {
    this.group.name = 'power-plant';
    const s: Sets = { clad: new MeshBuilder(), concrete: new MeshBuilder(), steel: new MeshBuilder() };
    const wires = new Wires();
    chimney(s, this.lights);
    for (const sd of [-1, 1]) unit(s, sd, this.lights);
    const yard = halls(s, this.lights, wires);
    this.lineEnd = { ...yard.entry, points: yard.gantry };
    coal(s, this.lights);
    // at OSM's cranes along the berth, on its rails
    for (const c of PLANT.cranes) unloader(s, PLANT.berth.x1 - UNLOADER_OFFSET, c.z, this.lights, wires);
    piers(s);
    boundary(s);
    lamps(s, this.lights);
    siteBuildings(s);

    // concrete plain: a plaster texture stretched up the chimney's 275 m reads as rust
    const mats: Record<keyof Sets, MeshStandardMaterial> = {
      clad: patchMaterial(new MeshStandardMaterial({ map: claddingTexture(712), vertexColors: true, roughness: 0.55, metalness: 0.2 }), { grime: 0.12 }),
      concrete: patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), { grime: 0.35 }),
      steel: patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 }), { grime: 0.15 }),
    };
    for (const key of Object.keys(s) as (keyof Sets)[]) {
      if (!s[key].vertexCount) continue;
      const mesh = new Mesh(s[key].build(), mats[key]);
      mesh.name = `power-plant-${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    if (!wires.empty) this.group.add(wires.build());
    this.plume = plume();
    this.group.add(this.plume.mesh);
  }

  /** The plume's strength: plainest in cool damp air (night, the wet months, rain), gone when the plant stops. */
  update(dt: number): void {
    const damp = 0.45 + 0.3 * (1 - G.uSeasonA.value.y) + 0.2 * G.uNight.value + 0.2 * G.uOvercast.value;
    const want = this.running ? Math.min(1, damp) : 0;
    const s = this.plume.strength;
    s.value += (want - s.value) * Math.min(1, dt * 0.2);
    this.plume.mesh.visible = s.value > 0.01;
  }

  /** How loud the plant's drone is at `eye` (0..1): full by its walls, a tenth a kilometre and a half off, none when it stands. */
  loudness(eye: Vector3): number {
    if (!this.running) return 0;
    const c = PLANT.at(PLANT.boiler.a, 0);
    return Math.min(1, 150 / Math.max(150, Math.hypot(eye.x - c.x, eye.y - PY, eye.z - c.z)));
  }

  /** Jump the plume straight to its strength (for stills and a fresh start). */
  settle(): void {
    this.plume.strength.value = 0;
    this.update(1e3);
  }
}
