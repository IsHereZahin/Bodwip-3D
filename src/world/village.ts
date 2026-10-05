import {
  BufferAttribute,
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector2,
  Vector3,
} from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, rgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { strawTexture, tinTexture } from '../render/textures';
import { HOMESTEAD_MOUNDS, WATER_LEVEL, bankAt, nearBackwater, onRoad, shapePoint, terrainHeight, type Mound } from './geography';
import { HUB_GHAT } from './plan';
import { buildHull, type HullShape } from './hull';
import { SHELTERED, waveHeightGlsl, waveSlopeGlsl } from './waves';
import type { Waterway } from './waterways';

// The homesteads (বাড়ি): on each mound the houses stand round the swept yard (উঠান), the main house across
// its back looking out over it toward the way the homestead faces, the others along its sides, the kitchen
// at a front corner and the cowshed at the back; a haystack by the mound's foot. Where a homestead comes
// down to the river or the khal it has its own ghat, and a boat tied up at some of them.

export interface HutPlan {
  x: number;
  y: number;
  z: number;
  ry: number;
  /** Length along local x, width along local z (its door looks along local +z). */
  l: number;
  w: number;
  roof: 'thatch' | 'tin';
  wall: RGB;
  kind: 'house' | 'kitchen' | 'shed';
}

/** Where a homestead (or the village) comes down to its water: its ghat's foot at the water's edge, the way up the bank, and the waterway. */
export interface Ghat {
  x: number;
  z: number;
  up: number;
  way: Waterway;
  s: number;
  side: 1 | -1;
}

const WALLS: RGB[] = [rgb('#a88458'), rgb('#b8946a'), rgb('#9a7a4a'), rgb('#c4b69a')];

/** The houses of one homestead, laid round its yard in the mound's frame (u toward its face, v across). */
function homestead(m: Mound, rng: Rng, out: HutPlan[]): void {
  const put = (u: number, v: number, turn: number, l: number, w: number, kind: HutPlan['kind'], roof: HutPlan['roof']) => {
    const p = shapePoint(m, u, v);
    out.push({ x: p.x, y: terrainHeight(p.x, p.z) + 0.02, z: p.z, ry: m.face + turn, l, w, roof, wall: rng.pick(WALLS), kind });
  };
  const tin = (): HutPlan['roof'] => (rng.next() < 0.6 ? 'tin' : 'thatch');
  // the main house across the back of the yard, looking out over it
  put(-m.hu * 0.5, rng.range(-1, 1), 0, rng.range(7.5, 9.5), rng.range(4.4, 5.2), 'house', tin());
  // one or two houses along the yard's sides, facing in
  const sides = rng.next() < 0.55 ? [1, -1] : [rng.sign()];
  for (const side of sides) put(rng.range(-2.5, 0.5), side * m.hv * 0.52, (side * Math.PI) / 2, rng.range(5.8, 7.2), rng.range(3.8, 4.4), 'house', tin());
  // the kitchen at a front corner, under thatch, and the cowshed at a back corner
  const k = sides.length === 2 ? rng.sign() : -sides[0];
  put(m.hu * 0.4, k * m.hv * 0.52, (k * Math.PI) / 2, rng.range(3.2, 3.8), rng.range(2.8, 3.2), 'kitchen', 'thatch');
  put(-m.hu * 0.52, -k * m.hv * 0.62, (-k * Math.PI) / 2, rng.range(4.5, 5.5), rng.range(3, 3.4), 'shed', rng.next() < 0.7 ? 'thatch' : 'tin');
}

/** The homesteads' houses, deterministic. */
export function planHuts(): HutPlan[] {
  const rng = new Rng(21);
  const huts: HutPlan[] = [];
  for (const m of HOMESTEAD_MOUNDS) homestead(m, rng, huts);
  return huts;
}

/** The ghats: the village's below the banyan first, then each homestead's that has one, at the water's edge of the nearest bank. */
export function planGhats(): Ghat[] {
  const out: Ghat[] = [];
  const at = (x: number, z: number) => {
    const b = bankAt(x, z);
    if (b) out.push({ x: b.x, z: b.z, up: b.up, way: b.way, s: b.s, side: b.side });
  };
  at(HUB_GHAT[0], HUB_GHAT[1]);
  // a homestead's ghat comes down from its front, straight to the water
  for (const m of HOMESTEAD_MOUNDS) {
    if (!m.home?.ghat) continue;
    const front = shapePoint(m, m.hu + 4, 0);
    at(front.x, front.z);
  }
  return out;
}

// ---------- parts ----------

const m4 = new Matrix4();
const q4 = new Quaternion();
const e4 = new Euler();
const v4 = new Vector3();
const s4 = new Vector3(1, 1, 1);

function placed(base: Matrix4, x: number, y: number, z: number, ry = 0): Matrix4 {
  q4.setFromEuler(e4.set(0, ry, 0));
  return new Matrix4().multiplyMatrices(base, m4.compose(v4.set(x, y, z), q4, s4));
}

/**
 * Do-chala roof: two slopes whose ridge and eaves curve down toward the ends, the shape that
 * Bengal's huts gave to its temples. u runs along the ridge, v down the slope.
 */
function chalaRoof(b: MeshBuilder, m: Matrix4, l: number, w: number, wallTop: number, rise: number, over: number, droop: number): void {
  const A = 14;
  const S = 6;
  const half = w / 2 + over;
  const tWall = w / 2 / half;
  const eave = wallTop + 0.12 - rise * (1 - tWall);
  const normalMatrix = new Matrix4().extractRotation(m);
  const p = new Vector3();
  const n = new Vector3();
  for (const side of [-1, 1]) {
    const start = b.vertexCount;
    for (let i = 0; i <= A; i++) {
      const a = i / A;
      const x = (a - 0.5) * (l + 2 * over);
      const e = (2 * a - 1) ** 2;
      for (let j = 0; j <= S; j++) {
        const t = j / S;
        const y = eave + rise * (1 - t) - droop * e * (0.5 + 0.5 * t) - 0.1 * t * (1 - t);
        p.set(x, y, side * t * half).applyMatrix4(m);
        n.set(0, half, side * rise).normalize().applyMatrix4(normalMatrix);
        b.vertex(p, n, x / 1.6, (t * half) / 1.6);
      }
    }
    for (let i = 0; i < A; i++) {
      for (let j = 0; j < S; j++) {
        const a0 = start + i * (S + 1) + j;
        const a1 = a0 + S + 1;
        if (side > 0) b.quad(a0, a0 + 1, a1 + 1, a1);
        else b.quad(a0, a1, a1 + 1, a0 + 1);
      }
    }
    // a thick thatch edge hangs below the eave
    const lip = b.vertexCount;
    for (let i = 0; i <= A; i++) {
      const a = i / A;
      const x = (a - 0.5) * (l + 2 * over);
      const e = (2 * a - 1) ** 2;
      const y = eave - droop * e;
      n.set(0, 0, side).applyMatrix4(normalMatrix);
      b.vertex(p.set(x, y, side * half).applyMatrix4(m), n, x / 1.6, 0);
      b.vertex(p.set(x, y - 0.22, side * half * 0.97).applyMatrix4(m), n, x / 1.6, 0.15);
    }
    for (let i = 0; i < A; i++) b.quad(lip + i * 2, lip + i * 2 + 1, lip + i * 2 + 3, lip + i * 2 + 2);
  }
}

function ridgeHeight(l: number, w: number, wallTop: number, rise: number, over: number, droop: number, x: number): number {
  const half = w / 2 + over;
  const eave = wallTop + 0.12 - rise * (1 - w / 2 / half);
  const a = x / (l + 2 * over) + 0.5;
  return eave + rise - droop * (2 * a - 1) ** 2 * 0.5;
}

function gable(b: MeshBuilder, m: Matrix4, l: number, w: number, wallTop: number, apex: number, color: RGB): void {
  const normalMatrix = new Matrix4().extractRotation(m);
  for (const side of [-1, 1]) {
    const x = (side * l) / 2;
    const n = new Vector3(side, 0, 0).applyMatrix4(normalMatrix);
    const i0 = b.vertex(new Vector3(x, wallTop, -w / 2).applyMatrix4(m), n, 0, 0, color);
    const i1 = b.vertex(new Vector3(x, wallTop, w / 2).applyMatrix4(m), n, 1, 0, color);
    const i2 = b.vertex(new Vector3(x, apex, 0).applyMatrix4(m), n, 0.5, 1, color);
    if (side > 0) b.tri(i0, i2, i1);
    else b.tri(i0, i1, i2);
  }
}

function addHut(walls: MeshBuilder, roof: MeshBuilder, h: HutPlan, rng: Rng): void {
  const base = new Matrix4().compose(new Vector3(h.x, h.y, h.z), new Quaternion().setFromEuler(new Euler(0, h.ry, 0)), new Vector3(1, 1, 1));
  const plinthH = 0.55;
  const wallH = rng.range(2.0, 2.4);
  const wallTop = plinthH + wallH;
  walls.add(new BoxGeometry(h.l + 1.3, plinthH + 0.6, h.w + 1.3), placed(base, 0, (plinthH - 0.6) / 2, 0), rgb('#6b5134'));
  walls.add(new BoxGeometry(h.l + 0.04, 0.55, h.w + 0.04), placed(base, 0, plinthH + 0.27, 0), rgb('#5a4026'));
  walls.add(new BoxGeometry(h.l, wallH, h.w), placed(base, 0, plinthH + wallH / 2, 0), h.wall);
  const dark = rgb('#22160d');
  const doorX = rng.range(-h.l * 0.2, h.l * 0.2);
  walls.add(new BoxGeometry(0.95, 1.65, 0.08), placed(base, doorX, plinthH + 0.83, h.w / 2 + 0.01), dark);
  for (const wx of [doorX - 1.6, doorX + 1.6]) {
    if (Math.abs(wx) < h.l / 2 - 0.6) walls.add(new BoxGeometry(0.55, 0.5, 0.08), placed(base, wx, plinthH + 1.35, h.w / 2 + 0.01), dark);
  }
  const thatch = h.roof === 'thatch';
  const rise = thatch ? 1.7 : 1.05;
  const over = thatch ? 0.65 : 0.45;
  const droop = thatch ? 0.38 : 0.06;
  chalaRoof(roof, base, h.l, h.w, wallTop, rise, over, droop);
  gable(walls, base, h.l, h.w, wallTop, ridgeHeight(h.l, h.w, wallTop, rise, over, droop, h.l / 2) - 0.05, h.wall);
}

function haystack(b: MeshBuilder, x: number, z: number, rng: Rng, poles: MeshBuilder): void {
  const y = terrainHeight(x, z) - 0.1;
  const r = rng.range(1.3, 1.9);
  const hgt = rng.range(2.8, 3.6);
  const profile = [
    new Vector2(0.01, 0),
    new Vector2(r, 0),
    new Vector2(r * 1.08, hgt * 0.25),
    new Vector2(r * 0.95, hgt * 0.55),
    new Vector2(r * 0.6, hgt * 0.82),
    new Vector2(r * 0.2, hgt * 0.97),
    new Vector2(0.01, hgt),
  ];
  b.add(new LatheGeometry(profile, 14), new Matrix4().makeTranslation(x, y, z));
  poles.add(new CylinderGeometry(0.05, 0.06, 1.4, 5), new Matrix4().makeTranslation(x, y + hgt + 0.4, z), rgb('#6a5a3e'));
}

/** Brick steps from the top of the bank down into the water, square to the bank. */
function ghat(b: MeshBuilder, g: Ghat): void {
  const ux = Math.sin(g.up);
  const uz = Math.cos(g.up);
  const steps = 9;
  const top = terrainHeight(g.x + ux * 9, g.z + uz * 9);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const d = 9 - t * 10.2;
    const y = top - t * (top - WATER_LEVEL + 0.45);
    const m = new Matrix4().compose(new Vector3(g.x + ux * d, y - 0.6, g.z + uz * d), new Quaternion().setFromEuler(new Euler(0, g.up, 0)), new Vector3(1, 1, 1));
    b.add(new BoxGeometry(2.6, 1.2, 1.4), m, i % 2 ? rgb('#8a4a32') : rgb('#7c4230'));
  }
}

const SMALL_BOAT: HullShape = { len: 6, beam: 0.62, keelMid: -0.2, keelRise: 0.6, sheerMid: 0.32, sheerRise: 0.7 };

/** Where each boat tied up in the `afloat` builder lies: its vertices, and its middle (for the waves under it). */
interface Mooring {
  from: number;
  to: number;
  x: number;
  z: number;
}

/** Adds a moored boat's hull to `b` and notes where it lies. */
function moor(b: MeshBuilder, moorings: Mooring[], hull: MeshBuilder, m: Matrix4): void {
  const from = b.vertexCount;
  b.add(hull.build(), m, rgb('#3a2c20'));
  moorings.push({ from, to: b.vertexCount, x: m.elements[12], z: m.elements[14] });
}

/** A small boat tied up beside a ghat, along the bank, close in (the water's middle stays open). */
function mooredBoat(b: MeshBuilder, moorings: Mooring[], g: Ghat, rng: Rng): void {
  const hull = new MeshBuilder();
  buildHull(hull, SMALL_BOAT, { tar: rgb('#2a2018'), top: rgb('#5a4a38') });
  const s = g.s + rng.sign() * rng.range(4.5, 6);
  const p = g.way.at(s);
  const e = g.way.beside(s, g.side, g.way.half(s) - 1.3);
  const m = new Matrix4().compose(
    new Vector3(e.x, 0.05, e.z),
    new Quaternion().setFromEuler(new Euler(rng.range(-0.04, 0.04), p.heading + rng.range(-0.15, 0.15), g.side * rng.range(0.02, 0.06))),
    new Vector3(1, 1, 1),
  );
  moor(b, moorings, hull, m);
}

// ---------- assembly ----------

export function buildVillages(huts: readonly HutPlan[], ghats: readonly Ghat[]): Group {
  const rng = new Rng(33);
  const walls = new MeshBuilder();
  const thatchRoofs = new MeshBuilder();
  const tinRoofs = new MeshBuilder();
  const wood = new MeshBuilder();
  /** Boats tied up at the ghats: they ride the khal's water and its ripples. */
  const afloat = new MeshBuilder();
  const moorings: Mooring[] = [];
  const hay = new MeshBuilder();

  for (const h of huts) addHut(walls, h.roof === 'thatch' ? thatchRoofs : tinRoofs, h, rng);

  // a haystack or two by most homesteads, at the foot of the mound's back corner, clear of the houses, the ways and the water
  for (const m of HOMESTEAD_MOUNDS) {
    if (rng.next() < 0.25) continue;
    const stacks = rng.next() < 0.4 ? 2 : 1;
    for (let n = 0, k = 0; n < stacks && k < 8; k++) {
      const p = shapePoint(m, -m.hu * rng.range(0.2, 0.8), rng.sign() * (m.hv + rng.range(1.5, 4)));
      if (nearBackwater(p.x, p.z, 6) || onRoad(p.x, p.z, 2.5) || huts.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 6)) continue;
      haystack(hay, p.x, p.z, rng, wood);
      n++;
    }
  }
  // the ghats, a boat tied up at every other one and a second at the village's
  ghats.forEach((g, i) => {
    ghat(walls, g);
    if (i % 2 === 0) mooredBoat(afloat, moorings, g, rng);
    if (i === 0) mooredBoat(afloat, moorings, g, rng);
  });


  const group = new Group();
  group.name = 'villages';
  const wallMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), { grime: 0.45 });
  const thatchMat = patchMaterial(new MeshStandardMaterial({ map: strawTexture(41), roughness: 0.95, side: DoubleSide }), {
    grime: 0.3,
    translucency: 0.35,
  });
  const tinMat = patchMaterial(
    new MeshStandardMaterial({ map: tinTexture(42), roughness: 0.48, metalness: 0.55, side: DoubleSide }),
    { grime: 0.2 },
  );
  const woodMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), { grime: 0.35 });
  const hayMat = patchMaterial(new MeshStandardMaterial({ map: strawTexture(43), roughness: 0.95 }), { grime: 0.25 });
  const add = (b: MeshBuilder, mat: MeshStandardMaterial, cast = true) => {
    if (!b.vertexCount) return;
    const mesh = new Mesh(b.build(), mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(walls, wallMat);
  add(thatchRoofs, thatchMat);
  add(tinRoofs, tinMat);
  add(wood, woodMat);
  // moored boats float on the water, each rocking as one piece on the (sheltered) ripples under its middle
  const boats = afloat.build();
  const middles = new Float32Array(boats.getAttribute('position').count * 2);
  for (const m of moorings) for (let k = m.from; k < m.to; k++) middles.set([m.x, m.z], k * 2);
  boats.setAttribute('aMoor', new BufferAttribute(middles, 2));
  const moored = new Mesh(
    boats,
    patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), {
      grime: 0.35,
      vertex: {
        key: 'moored',
        pars: `attribute vec2 aMoor;\n${waveHeightGlsl()}\n${waveSlopeGlsl()}\n`,
        code: `{
  vec2 tilt = waveSlope(aMoor) * ${SHELTERED.toFixed(2)};
  transformed.y += ${WATER_LEVEL.toFixed(2)} + waveHeight(aMoor) * ${SHELTERED.toFixed(2)} + dot(tilt, transformed.xz - aMoor);
}`,
      },
    }),
  );
  moored.castShadow = true;
  moored.receiveShadow = true;
  group.add(moored);
  add(hay, hayMat);
  return group;
}
