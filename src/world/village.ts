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
import { BRIDGE, JOURNEY, KHAL_LEVEL, bilReach, khalAt, khalFrame, khalHalfWidth, nearBackwater, onRoad, terrainHeight } from './geography';
import { BUILDING } from '../geo/data';
import type { BuildingPlan } from './buildings';
import { buildHull, type HullShape } from './hull';
import { SHELTERED, waveHeightGlsl, waveSlopeGlsl } from './waves';

export interface HutPlan {
  x: number;
  y: number;
  z: number;
  ry: number;
  /** Length along local x, width along local z. */
  l: number;
  w: number;
  roof: 'thatch' | 'tin';
  wall: RGB;
}

/** Where a homestead comes down to the khal: its brick ghat, how far along the khal and on which side (kept clear of grass). */
export interface Ghat {
  x: number;
  z: number;
  s: number;
  side: 1 | -1;
}

const WALLS: RGB[] = [rgb('#a88458'), rgb('#b8946a'), rgb('#9a7a4a'), rgb('#c4b69a')];
/** Houses this near the khal's middle are built as huts in detail (seen close from the boat), m. */
const HUT_REACH = 60;
/** A ghat for a homestead this near the khal, and no nearer another ghat than this (m). */
const GHAT_REACH = 38;
const GHAT_SPACING = 110;

/**
 * The map's houses near the khal, to be built here as huts in detail; the rest of the buildings are
 * world/buildings.ts's. Deterministic.
 */
export function planHuts(buildings: readonly BuildingPlan[]): { huts: HutPlan[]; rest: BuildingPlan[] } {
  const rng = new Rng(21);
  const huts: HutPlan[] = [];
  const rest: BuildingPlan[] = [];
  for (const b of buildings) {
    const f = khalFrame(b.x, b.z);
    if (b.kind !== BUILDING.house || !f || f.d > HUT_REACH) {
      rest.push(b);
      continue;
    }
    huts.push({ x: b.x, y: b.base + 0.2, z: b.z, ry: b.ry, l: b.l, w: b.w, roof: rng.next() < 0.55 ? 'thatch' : 'tin', wall: rng.pick(WALLS) });
  }
  return { huts, rest };
}

/** The ghats: one below a homestead by the khal, spaced along it, none at the bridge or where the khal opens into the bil. */
export function planGhats(huts: readonly HutPlan[]): Ghat[] {
  const out: Ghat[] = [];
  const near: { s: number; side: 1 | -1 }[] = [];
  for (const h of huts) {
    const f = khalFrame(h.x, h.z);
    if (f && f.d < GHAT_REACH) near.push({ s: f.s, side: f.side });
  }
  near.sort((a, b) => a.s - b.s);
  for (const { s, side } of near) {
    if (Math.abs(s - JOURNEY.bridge) < 45 || s > JOURNEY.head - 40) continue;
    if (out.some((g) => Math.abs(g.s - s) < GHAT_SPACING)) continue;
    const p = khalAt(s);
    const half = khalHalfWidth(s);
    out.push({ x: p.x + Math.cos(p.heading) * half * side, z: p.z - Math.sin(p.heading) * half * side, s, side });
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

/** Brick steps from the top of the bank down into the khal's water. */
function ghat(b: MeshBuilder, g: Ghat): void {
  const p = khalAt(g.s);
  const half = khalHalfWidth(g.s);
  // outward from the khal's middle toward this bank
  const nx = Math.cos(p.heading) * g.side;
  const nz = -Math.sin(p.heading) * g.side;
  const top = terrainHeight(p.x + nx * (half + 9), p.z + nz * (half + 9));
  const steps = 7;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const d = half + 8 - t * 9;
    const y = top - t * (top - KHAL_LEVEL + 0.45);
    const m = new Matrix4().compose(new Vector3(p.x + nx * d, y - 0.6, p.z + nz * d), new Quaternion().setFromEuler(new Euler(0, p.heading, 0)), new Vector3(1, 1, 1));
    b.add(new BoxGeometry(2.6, 1.2, 1.7), m, i % 2 ? rgb('#8a4a32') : rgb('#7c4230'));
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

/** A small boat tied up beside a ghat, along the bank, close in (the khal's middle stays open). */
function mooredBoat(b: MeshBuilder, moorings: Mooring[], g: Ghat, rng: Rng): void {
  const hull = new MeshBuilder();
  buildHull(hull, SMALL_BOAT, { tar: rgb('#2a2018'), top: rgb('#5a4a38') });
  const s = g.s + rng.sign() * rng.range(4.5, 6);
  const p = khalAt(s);
  const d = khalHalfWidth(s) - 1.3;
  const x = p.x + Math.cos(p.heading) * d * g.side;
  const z = p.z - Math.sin(p.heading) * d * g.side;
  const m = new Matrix4().compose(
    new Vector3(x, 0.05, z),
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

  // a haystack in some of the homesteads' yards, clear of the houses, the roads and the water
  huts.forEach((h, i) => {
    if (i % 4 !== 1) return;
    for (let k = 0; k < 6; k++) {
      const a = rng.range(0, Math.PI * 2);
      const x = h.x + Math.cos(a) * rng.range(7, 12);
      const z = h.z + Math.sin(a) * rng.range(7, 12);
      if (nearBackwater(x, z, 8) || onRoad(x, z, 2) || huts.some((o) => Math.hypot(o.x - x, o.z - z) < 7) || bilReach(x, z) < 1.4) continue;
      if (Math.hypot(x - BRIDGE.x, z - BRIDGE.z) < BRIDGE.half + 8) continue;
      haystack(hay, x, z, rng, wood);
      break;
    }
  });
  // the ghats, a boat tied up at every other one
  ghats.forEach((g, i) => {
    ghat(walls, g);
    if (i % 2 === 0) mooredBoat(afloat, moorings, g, rng);
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
  // moored boats float on the khal's water, each rocking as one piece on the (sheltered) ripples under its middle
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
  transformed.y += ${KHAL_LEVEL.toFixed(2)} + waveHeight(aMoor) * ${SHELTERED.toFixed(2)} + dot(tilt, transformed.xz - aMoor);
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
