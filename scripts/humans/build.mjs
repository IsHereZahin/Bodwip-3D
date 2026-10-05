// Builds the people from MakeHuman's CC0 data (config.mjs): for each character the base mesh shaped by the macro
// targets and scaled to the character's height, the default skeleton cut down to the bones the scene poses (the
// face's and toes' weights go to the head and the feet), each vertex's four strongest bone weights, the fitted
// eyes, eyebrows, eyelashes and hair, the garments made as shells over the skin (the skin they cover is left
// out, so it cannot show through), and the measurements the cloth and the posing need. Writes public/humans/
// (humans.json, and humans.bin deflate-raw) and cache/textures.json for textures.py.
//
//   node scripts/humans/fetch.mjs && node scripts/humans/build.mjs && python scripts/humans/textures.py

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { encodePng } from '../geo/lib/png.mjs';
import { ASSETS, CACHE, CHARACTERS, MAKEHUMAN, OUT } from './config.mjs';
import { applyTarget, fitProxy, jointAt, macroTargets, readMaterial, readObj, readProxy, readSkeleton, readTarget, readWeights } from './lib/makehuman.mjs';

const base = readObj(path.join(MAKEHUMAN, '3dobjs/base.obj'));
const skel = readSkeleton(path.join(MAKEHUMAN, 'rigs/default.mhskel'));
const rawWeights = readWeights(path.join(MAKEHUMAN, 'rigs/default_weights.mhw'));
const NV = base.v.length / 3;
const BODY = base.faces.filter((f) => f.group === 'body');
/** Position units in humans.bin: a tenth of a millimetre. */
const UNIT = 1e-4;
const MASK_SIZE = 1024;

// ---- the skeleton the scene poses ----

const FINGERS = [];
for (let f = 1; f <= 5; f++) for (let k = 1; k <= 3; k++) FINGERS.push(`finger${f}-${k}`);
const SIDED = [
  'upperleg01', 'upperleg02', 'lowerleg01', 'lowerleg02', 'foot',
  'clavicle', 'shoulder01', 'upperarm01', 'upperarm02', 'lowerarm01', 'lowerarm02', 'wrist',
  'metacarpal1', 'metacarpal2', 'metacarpal3', 'metacarpal4', ...FINGERS,
  'eye', 'orbicularis03', 'orbicularis04',
];
const KEEP = new Set(['root', 'spine05', 'spine04', 'spine03', 'spine02', 'spine01', 'neck01', 'neck02', 'neck03', 'head', ...['L', 'R'].flatMap((s) => SIDED.map((n) => `${n}.${s}`))]);
const children = {};
for (const [n, b] of Object.entries(skel.bones)) (children[b.parent ?? ''] ||= []).push(n);
/** Kept bones, every parent before its children. */
const ORDER = [];
(function walk(n) {
  if (KEEP.has(n)) ORDER.push(n);
  for (const c of (children[n] ?? []).sort()) walk(c);
})('root');
const INDEX = new Map(ORDER.map((n, i) => [n, i]));
const keptOf = (n) => {
  while (n && !KEEP.has(n)) n = skel.bones[n].parent;
  return n;
};
const PARENT = ORDER.map((n) => (n === 'root' ? -1 : INDEX.get(keptOf(skel.bones[n].parent))));

// ---- weights: by kept bone, and by body region (for what the clothes cover and the measurements) ----

const CATS = ['trunk', 'girdle', 'neck', 'head', 'upperArm', 'foreArm', 'hand', 'thigh', 'shin', 'foot'];
function category(n) {
  if (/^(root|spine0\d|pelvis|breast)/.test(n)) return 'trunk';
  if (/^(clavicle|shoulder01)/.test(n)) return 'girdle';
  if (/^neck/.test(n)) return 'neck';
  if (/^upperarm/.test(n)) return 'upperArm';
  if (/^lowerarm/.test(n)) return 'foreArm';
  if (/^(wrist|metacarpal|finger)/.test(n)) return 'hand';
  if (/^upperleg/.test(n)) return 'thigh';
  if (/^lowerleg/.test(n)) return 'shin';
  if (/^(foot|toe)/.test(n)) return 'foot';
  return 'head';
}
const catW = Object.fromEntries(CATS.map((c) => [c, new Float32Array(NV)]));
const boneW = Array.from({ length: NV }, () => new Map());
for (const [bone, list] of Object.entries(rawWeights)) {
  const c = catW[category(bone)];
  const k = INDEX.get(keptOf(bone));
  for (const [i, w] of list) {
    c[i] += w;
    boneW[i].set(k, (boneW[i].get(k) ?? 0) + w);
  }
}
const cat = (i) => Object.fromEntries(CATS.map((c) => [c, catW[c][i]]));
const arms = (c) => c.upperArm + c.foreArm + c.hand;

/** The four strongest bones of a weight map, as bytes summing to 255. */
function skinOf(map) {
  const top = [...map].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
  const idx = [0, 0, 0, 0];
  const q = [0, 0, 0, 0];
  top.forEach(([k, w], j) => {
    idx[j] = k;
    q[j] = Math.round((w / sum) * 255);
  });
  q[0] += 255 - q.reduce((a, b) => a + b, 0);
  return { idx, q };
}

/** A proxy vertex's weights: its reference vertices' weights, mixed by its fitting weights. */
function proxyWeights(ref) {
  const map = new Map();
  for (let k = 0; k < 3; k++) {
    const w = Math.max(0, ref.w[k]);
    if (!w) continue;
    for (const [b, bw] of boneW[ref.v[k]]) map.set(b, (map.get(b) ?? 0) + w * bw);
  }
  return map;
}

// ---- geometry helpers ----

const targets = new Map();
function target(file) {
  if (!targets.has(file)) targets.set(file, readTarget(path.join(MAKEHUMAN, 'targets/macrodetails', file)));
  return targets.get(file);
}

/** Corner lists → triangles (quads split along their first diagonal). */
function triangles(faces) {
  const out = [];
  for (const f of faces) for (let k = 1; k + 1 < f.corners.length; k++) out.push([f.corners[0], f.corners[k], f.corners[k + 1]]);
  return out;
}

/** Area-weighted vertex normals over `tris` (corner v indices into `pos`). */
function vertexNormals(tris, pos, count) {
  const n = new Float64Array(count * 3);
  for (const [a, b, c] of tris) {
    const A = a.v * 3;
    const B = b.v * 3;
    const C = c.v * 3;
    const ux = pos[B] - pos[A];
    const uy = pos[B + 1] - pos[A + 1];
    const uz = pos[B + 2] - pos[A + 2];
    const vx = pos[C] - pos[A];
    const vy = pos[C + 1] - pos[A + 1];
    const vz = pos[C + 2] - pos[A + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const i of [A, B, C]) {
      n[i] += nx;
      n[i + 1] += ny;
      n[i + 2] += nz;
    }
  }
  for (let i = 0; i < count; i++) {
    const l = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]) || 1;
    n[i * 3] /= l;
    n[i * 3 + 1] /= l;
    n[i * 3 + 2] /= l;
  }
  return n;
}

/**
 * A mesh part from triangles over original vertices: corners sharing a vertex and a texture coordinate become
 * one vertex. `pos`/`nrm` per original vertex (metres), `vt` the flat texture coordinates, `skin(v)` its weights.
 */
function part(tris, pos, nrm, vt, skin, cut = null) {
  const map = new Map();
  const C = [];
  const P = [];
  const N = [];
  const U = [];
  const SI = [];
  const SW = [];
  const index = [];
  for (const tri of tris)
    for (const c of tri) {
      const key = c.v * 65536 + (c.t + 1);
      let k = map.get(key);
      if (k === undefined) {
        k = map.size;
        map.set(key, k);
        for (let a = 0; a < 3; a++) {
          P.push(Math.round(pos[c.v * 3 + a] / UNIT));
          N.push(Math.round(nrm[c.v * 3 + a] * 127));
        }
        U.push(c.t >= 0 ? vt[c.t * 2] : 0, c.t >= 0 ? vt[c.t * 2 + 1] : 0);
        const s = skin(c.v);
        SI.push(...s.idx);
        SW.push(...s.q);
        if (cut) C.push(cut(c.v));
      }
      index.push(k);
    }
  return {
    position: Int16Array.from(P),
    normal: Int8Array.from(N),
    uv: Float32Array.from(U),
    skinIndex: Uint8Array.from(SI),
    skinWeight: Uint8Array.from(SW),
    index: map.size < 65536 ? Uint16Array.from(index) : Uint32Array.from(index),
    ...(cut ? { cut: Uint8Array.from(C) } : {}),
  };
}

/** Vertices inside a region whose every face lies inside it too (a face's width in from its edge). */
function interior(faces, inside) {
  const ok = new Uint8Array(NV);
  for (let i = 0; i < NV; i++) ok[i] = inside[i] ? 1 : 0;
  for (const f of faces) {
    if (f.corners.every((c) => inside[c.v])) continue;
    for (const c of f.corners) ok[c.v] = 0;
  }
  return ok;
}

// Möller–Trumbore against a horizontal ray; returns the distance or -1.
function rayHit(o, d, a, b, c) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < 0 || u > 1) return -1;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > 0 ? t : -1;
}

/**
 * The body's outline round a vertical axis through `origin`, row by row: for heights y0 + k·dy (relative to the
 * origin) the middle of the trunk front to back (zc) and, at each of `angles` directions (0 forward, π/2 toward
 * +x), how far out its skin is. Only triangles `use` accepts count (not the arms, say); misses take a neighbour's.
 */
function radiusMap(P, tris, use, origin, y0, dy, rows, angles, centreOf) {
  const pts = tris.filter(use).map(([a, b, c]) => [a, b, c].map((k) => [P[k.v * 3], P[k.v * 3 + 1], P[k.v * 3 + 2]]));
  const zc = [];
  const r = [];
  for (let k = 0; k < rows; k++) {
    const y = origin[1] + y0 + k * dy;
    const band = pts.filter((t) => Math.min(t[0][1], t[1][1], t[2][1]) <= y && Math.max(t[0][1], t[1][1], t[2][1]) >= y);
    const z = centreOf(y, band);
    zc.push(+(z - origin[2]).toFixed(4));
    const row = [];
    for (let a = 0; a < angles; a++) {
      const th = (a / angles) * Math.PI * 2;
      const d = [Math.sin(th), 0, Math.cos(th)];
      const o = [origin[0], y, z];
      let far = 0;
      for (const [A, B, C] of band) far = Math.max(far, rayHit(o, d, A, B, C));
      row.push(far);
    }
    for (let a = 0; a < angles; a++)
      if (row[a] <= 0)
        for (let s = 1; s < angles; s++) {
          const left = row[(a - s + angles) % angles];
          const right = row[(a + s) % angles];
          if (left > 0 || right > 0) {
            row[a] = Math.max(left, right);
            break;
          }
        }
    r.push(...row.map((x) => +x.toFixed(4)));
  }
  return { y0, dy, rows, angles, zc, r };
}

/** The trunk's middle front to back at height y: halfway between its front and back near the body's middle line. */
function middleZ(y, band) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of band)
    for (const p of t)
      if (Math.abs(p[0]) < 0.05 && Math.abs(p[1] - y) < 0.03) {
        lo = Math.min(lo, p[2]);
        hi = Math.max(hi, p[2]);
      }
  return Number.isFinite(lo) ? (lo + hi) / 2 : 0;
}

/** A limb's radius along it: the farthest of its own vertices from the line `a`→`b`, at 11 points from a to b. */
function limbProfile(P, a, b, mine) {
  const ax = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(...ax);
  const u = ax.map((x) => x / L);
  const out = new Array(11).fill(0);
  for (let i = 0; i < 13380; i++) {
    if (!mine(i)) continue;
    const d = [P[i * 3] - a[0], P[i * 3 + 1] - a[1], P[i * 3 + 2] - a[2]];
    const f = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / L;
    const perp = Math.hypot(d[0] - u[0] * f * L, d[1] - u[1] * f * L, d[2] - u[2] * f * L);
    for (let k = 0; k <= 10; k++) if (Math.abs(f - k / 10) < 0.06) out[k] = Math.max(out[k], perp);
  }
  for (let k = 0; k <= 10; k++) if (!out[k]) out[k] = out[k - 1] || out[k + 1] || 0.05;
  return out.map((x) => +x.toFixed(4));
}

/** Rasterises a per-vertex value over the body's texture layout (bilinear within each triangle). */
function uvMask(tris, vt, value, size) {
  const img = new Uint8Array(size * size);
  for (const tri of tris) {
    const vals = tri.map((c) => value(c.v));
    if (vals.every((x) => x <= 0)) continue;
    const pts = tri.map((c) => [vt[c.t * 2] * size, (1 - vt[c.t * 2 + 1]) * size]);
    const [p0, p1, p2] = pts;
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])) - 1);
    const x1 = Math.min(size - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])) - 1);
    const y1 = Math.min(size - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])) + 1);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((p1[0] - px) * (p2[1] - py) - (p2[0] - px) * (p1[1] - py)) / area;
        const w1 = ((p2[0] - px) * (p0[1] - py) - (p0[0] - px) * (p2[1] - py)) / area;
        const w2 = 1 - w0 - w1;
        // a texel's margin outside the triangle too, so the seams have no gaps
        if (w0 < -0.08 || w1 < -0.08 || w2 < -0.08) continue;
        const v = Math.max(0, Math.min(1, w0 * vals[0] + w1 * vals[1] + w2 * vals[2]));
        img[y * size + x] = Math.max(img[y * size + x], Math.round(v * 255));
      }
  }
  return img;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---- output: arrays packed once each (identical topology is shared between the characters) ----

const chunks = [];
let size = 0;
const packed = new Map();
function put(array) {
  const buf = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const key = array.constructor.name + createHash('sha1').update(buf).digest('hex');
  if (packed.has(key)) return packed.get(key);
  const pad = (4 - (size % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    size += pad;
  }
  const ref = { type: array.constructor.name, offset: size, length: array.length };
  chunks.push(buf);
  size += buf.length;
  packed.set(key, ref);
  return ref;
}
const putPart = (p) => Object.fromEntries(Object.entries(p).map(([k, a]) => [k, put(a)]));
const round = (p) => p.map((x) => +x.toFixed(4));

// ---- the characters ----

const bodyTris = triangles(BODY);
const out = { version: 1, unit: UNIT, bones: ORDER, parents: PARENT, characters: {} };
const textureJobs = { out: OUT, assets: ASSETS, characters: {} };
mkdirSync(OUT, { recursive: true });
mkdirSync(path.join(CACHE, 'masks'), { recursive: true });

for (const [name, spec] of Object.entries(CHARACTERS)) {
  // the body shaped by the macro targets, in metres, soles at y = 0, scaled to the height asked
  const dm = Float64Array.from(base.v);
  for (const [file, w] of macroTargets(spec.macro)) applyTarget(dm, target(file), w);
  let ymin = Infinity;
  let ymax = -Infinity;
  for (let i = 0; i < 13380; i++) {
    ymin = Math.min(ymin, dm[i * 3 + 1]);
    ymax = Math.max(ymax, dm[i * 3 + 1]);
  }
  const s = spec.height / ((ymax - ymin) * 0.1);
  const toM = (arr) => {
    const m = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i += 3) {
      m[i] = arr[i] * 0.1 * s;
      m[i + 1] = (arr[i + 1] - ymin) * 0.1 * s;
      m[i + 2] = arr[i + 2] * 0.1 * s;
    }
    return m;
  };
  const P = toM(dm);
  const pos = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const J = (bone, end = 'head') => jointAt(P, skel.joints[skel.bones[bone][end]]);
  const bones = ORDER.map((n) => ({ head: round(J(n, 'head')), tail: round(J(n, 'tail')) }));

  // landmarks
  const L = {
    pelvis: J('spine05'),
    chest: J('spine01'),
    neck: J('neck01'),
    head: J('head'),
    top: J('head', 'tail'),
    hip: J('upperleg01.L'),
    knee: J('lowerleg01.L'),
    ankle: J('foot.L'),
    gh: [J('upperarm01.L'), J('upperarm01.R')],
    elbow: [J('lowerarm01.L'), J('lowerarm01.R')],
    chin: J('jaw', 'tail'),
    jaw: J('jaw'),
    mouth: J('oris01', 'tail'),
    nose: J('levator02.L'),
    eye: J('eye.L'),
  };
  let crown = [0, 0, 0];
  for (let i = 0; i < 13380; i++) if (P[i * 3 + 1] > crown[1]) crown = pos(i);

  const bodyN = vertexNormals(bodyTris, P, NV);
  const bodySkin = (v) => skinOf(boneW[v]);
  const parts = {};
  const hide = new Uint8Array(NV);

  /**
   * A garment as a shell `offset(i)` metres off the skin, where `field(i)` (about metres, positive inside it) says
   * how far in from its edge a point is. Faces it reaches are built, and its edge is cut along the field's zero
   * by alpha (each vertex's `cut`), so it runs smooth across the mesh's faces; the skin well inside it is hidden.
   * `drape`: the front hangs straight down from what stands out most above it (a bust, a chest) instead of
   * following the skin back in under it.
   */
  const shell = (key, field, offset, drape = null) => {
    const f = new Float64Array(NV).fill(-1);
    for (let i = 0; i < 13380; i++) f[i] = field(i);
    const faces = BODY.filter((face) => face.corners.some((c) => f[c.v] > 0));
    const used = new Uint8Array(NV);
    for (const face of faces) for (const c of face.corners) used[c.v] = 1;
    const S = Float64Array.from(P);
    for (let i = 0; i < 13380; i++) {
      if (!used[i]) continue;
      const o = offset(i);
      for (let a = 0; a < 3; a++) S[i * 3 + a] += bodyN[i * 3 + a] * o;
    }
    if (drape) hang(S, used, drape);
    relax(S, faces);
    const tris = triangles(faces);
    const cut = (v) => Math.round(Math.min(1, Math.max(0, 0.5 + f[v] * 12)) * 255);
    parts[key] = part(tris, S, vertexNormals(tris, S, NV), base.vt, bodySkin, cut);
    for (let i = 0; i < 13380; i++) if (f[i] > 0.015) hide[i] = 1;
  };
  /**
   * The front of a shell falls straight from its fullest point above (a little inward, as cloth does) between
   * `drape.top` and `drape.bottom`: each point is brought forward to the cloth hanging over it; with
   * `drape.back`, the back as well, from the shoulder blades over the small of the back.
   */
  const hang = (S, used, drape) => {
    const CELL = 0.01;
    for (const face of drape.back ? [1, -1] : [1]) {
      const cols = new Map();
      const facing = (i) => used[i] && bodyN[i * 3 + 2] * face > 0.3;
      for (let i = 0; i < 13380; i++) {
        if (!facing(i)) continue;
        const y = S[i * 3 + 1];
        if (y < drape.bottom || y > drape.top + 0.12) continue;
        const kx = Math.round(S[i * 3] / CELL);
        const ky = Math.round(y / CELL);
        const col = cols.get(kx) ?? new Map();
        col.set(ky, Math.max(col.get(ky) ?? -Infinity, S[i * 3 + 2] * face));
        cols.set(kx, col);
      }
      const env = new Map();
      for (const [kx, col] of cols) {
        const keys = [...col.keys()].sort((a, b) => b - a);
        const out = new Map();
        let run = -Infinity;
        let last = keys[0];
        for (const ky of keys) {
          run = Math.max(col.get(ky), run - 0.2 * (last - ky) * CELL);
          last = ky;
          out.set(ky, run);
        }
        env.set(kx, out);
      }
      for (let i = 0; i < 13380; i++) {
        if (!facing(i)) continue;
        const y = S[i * 3 + 1];
        if (y < drape.bottom || y > drape.top) continue;
        const z = env.get(Math.round(S[i * 3] / CELL))?.get(Math.round(y / CELL));
        // fading in below the top and out toward the bottom, where it is gathered in again
        const w = smooth(drape.top, drape.top - 0.04, y) * smooth(drape.bottom, drape.bottom + 0.06, y);
        if (z !== undefined && z > S[i * 3 + 2] * face) S[i * 3 + 2] += (z * face - S[i * 3 + 2]) * w;
      }
    }
  };
  /**
   * Cloth does not follow the skin's small shapes (a nipple, the dip between muscles): the shell is smoothed a
   * few times over, each point kept at least a few millimetres off the skin.
   */
  const relax = (S, faces) => {
    const nb = new Map();
    for (const face of faces) {
      const n = face.corners.length;
      for (let k = 0; k < n; k++) {
        const a = face.corners[k].v;
        const b = face.corners[(k + 1) % n].v;
        if (!nb.has(a)) nb.set(a, new Set());
        if (!nb.has(b)) nb.set(b, new Set());
        nb.get(a).add(b);
        nb.get(b).add(a);
      }
    }
    const next = Float64Array.from(S);
    for (let iter = 0; iter < 16; iter++) {
      for (const [v, around] of nb) {
        let x = 0;
        let y = 0;
        let z = 0;
        for (const u of around) {
          x += S[u * 3];
          y += S[u * 3 + 1];
          z += S[u * 3 + 2];
        }
        const k = around.size;
        next[v * 3] = S[v * 3] * 0.5 + (x / k) * 0.5;
        next[v * 3 + 1] = S[v * 3 + 1] * 0.5 + (y / k) * 0.5;
        next[v * 3 + 2] = S[v * 3 + 2] * 0.5 + (z / k) * 0.5;
        // never closer to the skin than 4 mm
        const off = (next[v * 3] - P[v * 3]) * bodyN[v * 3] + (next[v * 3 + 1] - P[v * 3 + 1]) * bodyN[v * 3 + 1] + (next[v * 3 + 2] - P[v * 3 + 2]) * bodyN[v * 3 + 2];
        if (off < 0.004) for (let a = 0; a < 3; a++) next[v * 3 + a] += bodyN[v * 3 + a] * (0.004 - off);
      }
      for (const v of nb.keys()) for (let a = 0; a < 3; a++) S[v * 3 + a] = next[v * 3 + a];
    }
  };
  /** How far outside an ellipsoid (centre `c`, half-axes x, y, and z forward and back of its middle) a point is, about in metres. */
  const outside = (p, c, ax, ay, azFront, azBack) => {
    const dz = p[2] - c[2];
    return (Math.hypot((p[0] - c[0]) / ax, (p[1] - c[1]) / ay, dz / (dz > 0 ? azFront : azBack)) - 1) * Math.min(ax, ay);
  };
  /** The front of the trunk: 0 behind its middle, 1 well in front. */
  const frontness = (z) => smooth(0, 0.08, z - (L.chest[2] + 0.06));
  const N = L.neck;

  for (const garment of spec.wear) {
    if (garment === 'sando') {
      // a knitted sando: a scooped neck front and back, straps over the shoulders, deep armholes, its hem over the lungi's top
      shell(
        'vest',
        (i) => {
          const c = cat(i);
          const p = pos(i);
          return Math.min(
            p[1] - (L.pelvis[1] + 0.005),
            N[1] + 0.01 - p[1],
            outside(p, [0, N[1] - 0.005, N[2] + 0.045], 0.07, 0.085, 0.115, 0.15),
            outside(p, [L.gh[0][0] + 0.01, L.gh[0][1] - 0.035, L.gh[0][2]], 0.072, 0.12, 0.1, 0.1),
            outside(p, [L.gh[1][0] - 0.01, L.gh[1][1] - 0.035, L.gh[1][2]], 0.072, 0.12, 0.1, 0.1),
            (0.45 - arms(c)) * 0.1,
            (0.5 - c.head) * 0.1,
          );
        },
        (i) => {
          const [, y, z] = pos(i);
          // close on the chest, loose over the belly
          return 0.008 + 0.008 * frontness(z) * smooth(L.chest[1], L.pelvis[1] + 0.1, y);
        },
        { top: L.chest[1] + 0.03, bottom: L.pelvis[1] + 0.02 },
      );
    } else if (garment === 'lungi') {
      // the lungi is cloth (world/boatman.ts) round the hips and thighs: the skin it covers stays out
      const region = new Uint8Array(NV);
      const bottom = L.knee[1] + 0.5 * (L.hip[1] - L.knee[1]);
      for (let i = 0; i < 13380; i++) {
        const c = cat(i);
        const y = P[i * 3 + 1];
        region[i] = arms(c) < 0.3 && c.trunk + c.thigh > 0.6 && y < L.pelvis[1] + 0.025 && y > bottom ? 1 : 0;
      }
      const deep = interior(BODY, region);
      for (let i = 0; i < NV; i++) if (deep[i]) hide[i] = 1;
    } else if (garment === 'kameez') {
      // the kameez from its round neck to the hips (its skirt below is cloth), with sleeves to just above the elbows
      const sleeve = (i) => {
        const side = P[i * 3] > 0 ? 0 : 1;
        const a = L.gh[side];
        const b = L.elbow[side];
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const len = Math.hypot(...ab);
        const d = [P[i * 3] - a[0], P[i * 3 + 1] - a[1], P[i * 3 + 2] - a[2]];
        return { t: (d[0] * ab[0] + d[1] * ab[1] + d[2] * ab[2]) / (len * len), len };
      };
      shell(
        'kameez',
        (i) => {
          const c = cat(i);
          const p = pos(i);
          const { t, len } = sleeve(i);
          const arm = smooth(0.2, 0.6, arms(c));
          return Math.min(
            p[1] - (L.hip[1] + 0.03),
            N[1] + 0.03 - p[1],
            outside(p, [0, N[1] + 0.005, N[2] + 0.03], 0.066, 0.08, 0.105, 0.11),
            0.1 * (1 - arm) + (0.82 - t) * len * arm,
            (0.5 - c.head) * 0.1,
          );
        },
        (i) => {
          const c = cat(i);
          const arm = smooth(0.2, 0.6, arms(c));
          return 0.007 + arm * 0.014 * smooth(0.2, 0.82, sleeve(i).t);
        },
        { top: L.chest[1] + 0.02, bottom: L.hip[1] + 0.02, back: true },
      );
    } else if (garment === 'salwar') {
      // loose trousers from the drawstring at the waist (under the kameez) to the cuffs gathered at the ankles
      const cuff = L.ankle[1] + 0.03;
      const waist = L.pelvis[1] + 0.05;
      shell(
        'salwar',
        (i) => {
          const y = P[i * 3 + 1];
          return Math.min(waist - y, y - cuff, (0.4 - arms(cat(i))) * 0.1);
        },
        (i) => {
          const [x, y, z] = pos(i);
          const t = (y - cuff) / (waist - cuff);
          const loose = 0.008 + 0.03 * smooth(0, 0.16, t) + 0.008 * Math.sin(Math.PI * Math.min(1, t / 0.7)) - 0.022 * smooth(0.85, 1, t);
          // gathered into folds at the cuff
          const side = x > 0 ? 1 : -1;
          const knee = L.knee;
          const th = Math.atan2(z - knee[2], x - side * Math.abs(knee[0]));
          return loose + 0.005 * (1 - smooth(0, 0.14, t)) * Math.sin(th * 12);
        },
      );
    }
  }

  // the skin, without what the clothes hide
  const shown = BODY.filter((f) => !f.corners.every((c) => hide[c.v]));
  parts.body = part(triangles(shown), P, bodyN, base.vt, bodySkin);

  // eyes, eyebrows, eyelashes, hair: fitted to the shaped mesh (in MakeHuman's units, then as the body)
  const headC = [(L.head[0] + L.top[0]) / 2, (L.head[1] + L.top[1]) / 2, (L.head[2] + L.top[2]) / 2];
  const proxy = (key, file, bend) => {
    const px = readProxy(file);
    const at = toM(fitProxy(px, dm));
    const tris = triangles(px.obj.faces);
    let n = vertexNormals(tris, at, px.refs.length);
    if (bend) n = bend(at, n, px.refs.length);
    parts[key] = part(tris, at, n, px.obj.vt, (v) => skinOf(proxyWeights(px.refs[v])));
    return { px, at, n };
  };
  /** Cards' normals bent toward `dir(p)`: a crown of hair cards then shades as one soft volume. */
  const bendToward = (dir, share) => (at, n, count) => {
    const o = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      const d = dir([at[i * 3], at[i * 3 + 1], at[i * 3 + 2]]);
      let nx = n[i * 3];
      let ny = n[i * 3 + 1];
      let nz = n[i * 3 + 2];
      if (nx * d[0] + ny * d[1] + nz * d[2] < 0) [nx, ny, nz] = [-nx, -ny, -nz];
      const x = nx * (1 - share) + d[0] * share;
      const y = ny * (1 - share) + d[1] * share;
      const z = nz * (1 - share) + d[2] * share;
      const l = Math.hypot(x, y, z) || 1;
      o.set([x / l, y / l, z / l], i * 3);
    }
    return o;
  };
  const fromHead = (p) => {
    const d = [p[0] - headC[0], p[1] - headC[1], p[2] - headC[2]];
    const l = Math.hypot(...d) || 1;
    return d.map((x) => x / l);
  };
  proxy('eyes', path.join(ASSETS, 'eyes/high-poly/high-poly.mhclo'));
  proxy('brows', path.join(ASSETS, `${spec.brows}/${path.basename(spec.brows)}.mhclo`), bendToward(() => [0, 0.3, 0.95], 0.7));
  proxy('lashes', path.join(ASSETS, `${spec.lashes}/${path.basename(spec.lashes)}.mhclo`), bendToward(() => [0, 0.2, 1], 0.6));
  const hairFile = path.join(ASSETS, `${spec.hair.proxy}/${path.basename(spec.hair.proxy)}.mhclo`);
  const hair = proxy('hair', hairFile, bendToward(fromHead, 0.65));

  // the braid: its hanging part gets a chain of bones of its own, which the scene swings (world/human.ts)
  let braid = null;
  if (spec.hair.braid) braid = braidChain(hair, L, out, parts, bones);

  // measurements for the cloth and the posing
  const trunkOnly = ([a, b, c]) => [a, b, c].every((k) => arms(cat(k.v)) < 0.5 && catW.head[k.v] < 0.5 && catW.thigh[k.v] < 0.5);
  const noArms = ([a, b, c]) => [a, b, c].every((k) => arms(cat(k.v)) < 0.5 && catW.head[k.v] < 0.5);
  const sections = {
    chest: radiusMap(P, bodyTris, trunkOnly, L.chest, -0.36, 0.02, 34, 32, middleZ),
    pelvis: radiusMap(P, bodyTris, noArms, L.pelvis, -0.3, 0.02, 26, 32, middleZ),
    thigh: limbProfile(P, L.hip, L.knee, (i) => catW.thigh[i] > 0.5 && P[i * 3] > 0),
    shin: limbProfile(P, L.knee, L.ankle, (i) => catW.shin[i] > 0.5 && P[i * 3] > 0),
    upperArm: limbProfile(P, L.gh[0], L.elbow[0], (i) => catW.upperArm[i] > 0.5 && P[i * 3] > 0),
  };

  // where a beard grows (for the stubble in the skin texture): the jaw, the chin and the upper lip, not the lips
  const mask = uvMask(
    bodyTris,
    base.vt,
    (v) => {
      const c = cat(v);
      if (c.head + c.neck < 0.5) return 0;
      const [x, y, z] = pos(v);
      const ax = Math.abs(x);
      const cheek = 1 - smooth(L.nose[1] - 0.03, L.nose[1] + 0.005, y + 0.25 * Math.max(0, ax - 0.03));
      const ahead = smooth(L.jaw[2] - 0.005, L.jaw[2] + 0.025, z);
      const under = smooth(L.chin[1] - 0.05, L.chin[1] - 0.01, y);
      const lipR = Math.hypot(ax / 0.026, (y - L.mouth[1]) / 0.009);
      const lips = z > L.mouth[2] - 0.02 ? smooth(1.0, 0.8, lipR) : 0;
      const moustache = smooth(0.045, 0.02, ax) * (1 - smooth(0.004, 0.012, Math.abs(y - (L.mouth[1] + 0.016)))) * (z > L.mouth[2] - 0.015 ? 1 : 0);
      // the stubble half as dark as the moustache
      return Math.max(0, Math.min(1, Math.max(0.6 * cheek * ahead * under, moustache)) - lips);
    },
    MASK_SIZE,
  );
  const maskFile = path.join(CACHE, 'masks', `${name}_beard.png`);
  writeFileSync(maskFile, encodePng(mask, MASK_SIZE, MASK_SIZE, 1));

  const hairMat = readMaterial(hair.px.material);
  textureJobs.characters[name] = {
    skin: { ...spec.skin, mask: maskFile },
    hair: { file: path.join(path.dirname(hair.px.material), hairMat.diffuseTexture), tint: spec.hair.tint },
    eyes: spec.eyes,
    brows: path.join(spec.brows, readMaterial(path.join(ASSETS, spec.brows, `${path.basename(spec.brows)}.mhmat`)).diffuseTexture),
    lashes: path.join(spec.lashes, readMaterial(path.join(ASSETS, spec.lashes, `${path.basename(spec.lashes)}.mhmat`)).diffuseTexture),
  };

  out.characters[name] = {
    height: spec.height,
    bones,
    extra: braid,
    crown: round(crown),
    sections,
    parts: Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, putPart(p)])),
    textures: {
      skin: `${name}_skin.webp`,
      hair: `${name}_hair.webp`,
      eyes: 'eyes.webp',
      brows: `${path.basename(spec.brows)}.webp`,
      lashes: `${path.basename(spec.lashes)}.webp`,
    },
  };
  const counts = Object.entries(parts).map(([k, p]) => `${k} ${p.position.length / 3}v/${p.index.length / 3}t`).join(', ');
  console.log(`${name}: ${spec.height} m; ${counts}`);
}

/**
 * Takes the braid out of the hair's head: the hair hanging below the nape gets a chain of bones down its middle
 * (appended after the skeleton's own, the first one's parent the head), and those vertices are weighted to the
 * nearest two links. Returns the chain's joints for the scene.
 */
function braidChain(hair, L, out, parts, bones) {
  const { px, at, n } = hair;
  const count = px.refs.length;
  const nape = L.head[1] - 0.01;
  const hanging = [];
  for (let i = 0; i < count; i++) if (at[i * 3 + 1] < nape) hanging.push(i);
  if (!hanging.length) return null;
  // the braid's middle line, from the nape down, at even steps of height
  let lowest = Infinity;
  for (const i of hanging) lowest = Math.min(lowest, at[i * 3 + 1]);
  const LINKS = 8;
  const joints = [];
  for (let k = 0; k <= LINKS; k++) {
    const y = nape - ((nape - lowest) * k) / LINKS;
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const i of hanging)
      if (Math.abs(at[i * 3 + 1] - y) < (nape - lowest) / LINKS / 1.5) {
        sx += at[i * 3];
        sz += at[i * 3 + 2];
        n++;
      }
    joints.push(n ? [sx / n, y, sz / n] : joints[k - 1]);
  }
  const first = bones.length;
  const head = out.bones.indexOf('head');
  const chain = [];
  for (let k = 0; k < LINKS; k++) chain.push({ head: round(joints[k]), tail: round(joints[k + 1]), parent: k ? first + k - 1 : head });
  // each hanging vertex to the two links its height lies between, faded in from the head over the first link
  const tris = triangles(px.obj.faces);
  const skinBraid = (v) => {
    const y = at[v * 3 + 1];
    if (y >= nape) return skinOf(proxyWeights(px.refs[v]));
    const f = Math.min(LINKS - 1e-6, ((nape - y) / (nape - lowest)) * LINKS);
    const k = Math.floor(f);
    const w = f - k;
    const map = new Map();
    if (k === 0 && w < 0.5) {
      for (const [b, bw] of proxyWeights(px.refs[v])) map.set(b, bw * (1 - 2 * w) * 0.5);
      map.set(first, (map.get(first) ?? 0) + 0.5 + w);
    } else {
      map.set(first + k, 1 - w + (k === LINKS - 1 ? w : 0));
      if (k < LINKS - 1) map.set(first + k + 1, w);
    }
    return skinOf(map);
  };
  parts.hair = part(tris, at, n, px.obj.vt, skinBraid);
  return { braid: chain };
}

writeFileSync(path.join(OUT, 'humans.bin'), deflateRawSync(Buffer.concat(chunks), { level: 9 }));
writeFileSync(path.join(OUT, 'humans.json'), JSON.stringify(out));
writeFileSync(path.join(CACHE, 'textures.json'), JSON.stringify(textureJobs, null, 1));
console.log(`humans.bin: ${(size / 1024).toFixed(0)} KiB raw`);
