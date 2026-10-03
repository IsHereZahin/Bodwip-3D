import {
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
import { MeshBuilder, rgb, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { netTexture, strawTexture, tinTexture } from '../render/textures';
import {
  CHARS,
  KHALS,
  VILLAGES,
  VILLAGE_CENTERS,
  bankInfo,
  downstream,
  edgeHalfWidth,
  khalPoint,
  landLevel,
  nearBackwater,
  riverX,
  terrainHeight,
} from './geography';
import { buildHull, type HullShape } from './hull';

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

/** Each village's brick ghat: where its steps run down the bank (kept clear of grass). */
export const GHATS: readonly { z: number; side: 1 | -1 }[] = VILLAGES.map((v) => ({ z: v.z + v.radius * 0.3, side: v.side }));

/** Where the lift nets stand (also framed by the film tour). */
export const LIFT_NETS: readonly { z: number; side: 1 | -1 }[] = [
  { z: -260, side: 1 },
  { z: -980, side: -1 },
  { z: -1580, side: 1 },
  { z: -2240, side: 1 },
  { z: -2620, side: -1 },
];

/** Centre of a lift net's square, out over the water. */
export function liftNetCenter(net: { z: number; side: 1 | -1 }): Vector3 {
  return new Vector3(riverX(net.z) + net.side * (edgeHalfWidth(net.z, net.side) - 9), 1.1, net.z);
}

const WALLS: RGB[] = [rgb('#a88458'), rgb('#b8946a'), rgb('#9a7a4a'), rgb('#c4b69a')];

/** Huts for every village; vegetation keeps clear of them. Deterministic. */
export function planHuts(): HutPlan[] {
  const rng = new Rng(21);
  const out: HutPlan[] = [];
  VILLAGES.forEach((v, i) => {
    const c = VILLAGE_CENTERS[i];
    // long side parallel to the river, facing it
    const [dx, dz] = downstream(v.z);
    const along = Math.atan2(-dz, dx);
    const n = rng.int(4, 7);
    for (let k = 0, tries = 0; k < n && tries < 80; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = v.radius * Math.sqrt(rng.range(0, 0.5));
      const x = c.x + Math.cos(a) * d;
      const z = c.z + Math.sin(a) * d;
      if (bankInfo(x, z).inland < 14 || nearBackwater(x, z, 8)) continue;
      if (out.some((h) => Math.hypot(h.x - x, h.z - z) < 12)) continue;
      const l = rng.range(5.2, 7.5);
      const w = rng.range(3.4, 4.4);
      let y = Infinity;
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) y = Math.min(y, terrainHeight(x + ox * l * 0.5, z + oz * w * 0.5));
      out.push({
        x,
        y,
        z,
        ry: along + rng.range(-0.3, 0.3) + (rng.next() < 0.2 ? Math.PI / 2 : 0),
        l,
        w,
        roof: rng.next() < 0.55 ? 'thatch' : 'tin',
        wall: rng.pick(WALLS),
      });
      k++;
    }
  });
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

/** Brick steps down to the water. */
function ghat(b: MeshBuilder, z: number, side: 1 | -1): void {
  const we = edgeHalfWidth(z, side);
  const [dx, dz] = downstream(z);
  const along = Math.atan2(-dz, dx);
  const top = landLevel(riverX(z) + side * (we + 22), z);
  const steps = 9;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const u = we + 18 - t * 17;
    const y = top - t * (top + 0.7);
    const x = riverX(z) + side * u;
    const m = new Matrix4().compose(new Vector3(x, y - 0.6, z), new Quaternion().setFromEuler(new Euler(0, along, 0)), new Vector3(1, 1, 1));
    b.add(new BoxGeometry(4.2, 1.2, 2.4), m, i % 2 ? rgb('#8a4a32') : rgb('#7c4230'));
  }
}

const SMALL_BOAT: HullShape = { len: 6, beam: 0.62, keelMid: -0.2, keelRise: 0.6, sheerMid: 0.32, sheerRise: 0.7 };

function mooredBoat(b: MeshBuilder, z: number, side: 1 | -1, rng: Rng): void {
  const hull = new MeshBuilder();
  buildHull(hull, SMALL_BOAT, { tar: rgb('#2a2018'), top: rgb('#5a4a38') });
  const [dx, dz] = downstream(z);
  const along = Math.atan2(dx, dz);
  const x = riverX(z) + side * (edgeHalfWidth(z, side) + rng.range(-1, 1.5));
  const m = new Matrix4().compose(
    new Vector3(x, 0.05, z),
    new Quaternion().setFromEuler(new Euler(rng.range(-0.04, 0.04), along + rng.range(-0.4, 0.4), side * rng.range(0.03, 0.09))),
    new Vector3(1, 1, 1),
  );
  b.add(hull.build(), m, rgb('#3a2c20'));
}

/** Bhesal jal: a square lift net hung from crossed bamboo arms at the end of a long lever. */
function liftNet(wood: MeshBuilder, net: MeshBuilder, z: number, side: 1 | -1): void {
  const we = edgeHalfWidth(z, side);
  const cx = riverX(z);
  const pivot = new Vector3(cx + side * (we + 6), 0, z);
  pivot.y = terrainHeight(pivot.x, pivot.z) + 0.6;
  const tip = new Vector3(cx + side * (we - 7), 5.2, z);
  const center = liftNetCenter({ z, side });
  const bamboo = rgb('#8c7c50');
  taperedTube(wood, [pivot, pivot.clone().lerp(tip, 0.5).add(new Vector3(0, 0.4, 0)), tip], [0.09, 0.075, 0.06], 6, bamboo);
  // A-frame support near the water's edge
  const foot = new Vector3(cx + side * (we + 1), 0, z);
  foot.y = terrainHeight(foot.x, foot.z);
  const head = pivot.clone().lerp(tip, 0.45);
  for (const o of [-1.2, 1.2]) taperedTube(wood, [foot.clone().add(new Vector3(0, 0, o)), head], [0.07, 0.05], 5, bamboo);
  const corners: Vector3[] = [];
  for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) corners.push(center.clone().add(new Vector3(a * 3.6, -0.2, c * 3.6)));
  for (const c of corners) {
    const mid = tip.clone().lerp(c, 0.5);
    mid.add(c.clone().sub(center).setY(0).multiplyScalar(0.22));
    taperedTube(wood, [tip, mid, c], [0.05, 0.045, 0.035], 5, bamboo);
  }
  // the net sags between the corners, its belly just under the surface
  const N = 8;
  const start = net.vertexCount;
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const a = i / N;
      const c = j / N;
      const p = corners[0].clone().lerp(corners[1], a).lerp(corners[3].clone().lerp(corners[2], a), c);
      p.y -= Math.sin(Math.PI * a) * Math.sin(Math.PI * c) * 1.4;
      net.vertex(p, up, a * 3, c * 3);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = start + i * (N + 1) + j;
      net.quad(a, a + 1, a + N + 2, a + N + 1);
    }
  }
}

/** A row of bamboo stakes in the shallows with a net strung between them. */
function stakeRow(wood: MeshBuilder, net: MeshBuilder, start: Vector3, dir: Vector3, count: number, rng: Rng): void {
  const tops: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const p = start.clone().addScaledVector(dir, i * 2.6);
    const h = rng.range(2.6, 4.2);
    const lean = new Vector3(rng.range(-0.15, 0.15), 0, rng.range(-0.15, 0.15));
    const top = p.clone().add(new Vector3(0, h, 0)).add(lean);
    taperedTube(wood, [p.clone().setY(-2), top], [0.06, 0.04], 5, rgb('#7a6c48'));
    tops.push(top);
  }
  const s = net.vertexCount;
  const n = new Vector3().crossVectors(dir, new Vector3(0, 1, 0)).normalize();
  tops.forEach((t, i) => {
    net.vertex(new Vector3(t.x, -0.6, t.z), n, i * 1.7, 0);
    net.vertex(new Vector3(t.x, 1.4, t.z), n, i * 1.7, 1.3);
  });
  for (let i = 0; i < tops.length - 1; i++) net.quad(s + i * 2, s + i * 2 + 2, s + i * 2 + 3, s + i * 2 + 1);
}

// ---------- assembly ----------

export function buildVillages(huts: readonly HutPlan[]): Group {
  const rng = new Rng(33);
  const walls = new MeshBuilder();
  const thatchRoofs = new MeshBuilder();
  const tinRoofs = new MeshBuilder();
  const wood = new MeshBuilder();
  const hay = new MeshBuilder();
  const nets = new MeshBuilder();

  for (const h of huts) addHut(walls, h.roof === 'thatch' ? thatchRoofs : tinRoofs, h, rng);

  VILLAGES.forEach((v, i) => {
    const c = VILLAGE_CENTERS[i];
    for (let k = 0; k < 3; k++) {
      const a = rng.range(0, Math.PI * 2);
      const x = c.x + Math.cos(a) * v.radius * 0.55;
      const z = c.z + Math.sin(a) * v.radius * 0.55;
      if (bankInfo(x, z).inland > 10 && !nearBackwater(x, z, 6) && !huts.some((h) => Math.hypot(h.x - x, h.z - z) < 7)) haystack(hay, x, z, rng, wood);
    }
    ghat(walls, GHATS[i].z, v.side);
    mooredBoat(wood, v.z + v.radius * 0.3 + 6, v.side, rng);
    if (i % 2 === 0) mooredBoat(wood, v.z - v.radius * 0.4, v.side, rng);
  });

  for (const n of LIFT_NETS) liftNet(wood, nets, n.z, n.side);

  // a dinghy tied up in each khal, against one bank
  KHALS.forEach((_, k) => {
    const c = khalPoint(k, rng.range(0.25, 0.5));
    const side = rng.sign();
    const off = Math.max(0, c.halfWidth - 1.1);
    const hull = new MeshBuilder();
    buildHull(hull, SMALL_BOAT, { tar: rgb('#2a2018'), top: rgb('#5a4a38') });
    const m = new Matrix4().compose(
      new Vector3(c.x + Math.cos(c.heading) * side * off, 0.05, c.z - Math.sin(c.heading) * side * off),
      new Quaternion().setFromEuler(new Euler(rng.range(-0.03, 0.03), c.heading + rng.range(-0.15, 0.15), side * rng.range(0.02, 0.06))),
      new Vector3(1, 1, 1),
    );
    wood.add(hull.build(), m, rgb('#3a2c20'));
  });

  for (const ch of CHARS) {
    const z = ch.z + ch.halfLen * 0.75;
    const x = riverX(z) + ch.u + Math.sign(ch.u) * (ch.halfWid * 0.4);
    const [dx, dz] = downstream(z);
    stakeRow(wood, nets, new Vector3(x, 0, z), new Vector3(dx, 0, dz), rng.int(9, 14), rng);
  }

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
  const netMat = patchMaterial(
    new MeshStandardMaterial({ map: netTexture(), alphaTest: 0.35, alphaToCoverage: true, side: DoubleSide, roughness: 0.9 }),
    {},
  );
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
  add(hay, hayMat);
  add(nets, netMat, false);
  return group;
}
