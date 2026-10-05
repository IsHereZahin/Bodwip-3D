// Reading MakeHuman's data (all CC0): the base mesh, its targets, the default skeleton and its weights, and the
// proxies fitted to it (eyes, eyebrows, eyelashes, hair). Units are MakeHuman's decimetres until `build.mjs`
// turns them into metres; y is up and the body faces +z, as the scene's people do.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** An OBJ: positions (flat xyz), texture coordinates (flat uv), and faces as corner lists with their group. */
export function readObj(file) {
  const v = [];
  const vt = [];
  const faces = [];
  let group = '';
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') v.push(+t[1], +t[2], +t[3]);
    else if (t[0] === 'vt') vt.push(+t[1], +t[2]);
    else if (t[0] === 'g') group = t[1] ?? '';
    else if (t[0] === 'f') {
      const corners = t.slice(1).map((c) => {
        const [a, b] = c.split('/');
        return { v: +a - 1, t: b ? +b - 1 : -1 };
      });
      faces.push({ group, corners });
    }
  }
  return { v: Float64Array.from(v), vt: Float64Array.from(vt), faces };
}

/** A target: vertex indices and their offsets. */
export function readTarget(file) {
  const index = [];
  const delta = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line[0] === '#') continue;
    const t = line.trim().split(/\s+/);
    if (t.length < 4) continue;
    index.push(+t[0]);
    delta.push(+t[1], +t[2], +t[3]);
  }
  return { index: Int32Array.from(index), delta: Float64Array.from(delta) };
}

export function applyTarget(v, target, weight) {
  if (!weight) return;
  const { index, delta } = target;
  for (let i = 0; i < index.length; i++) {
    const k = index[i] * 3;
    v[k] += delta[i * 3] * weight;
    v[k + 1] += delta[i * 3 + 1] * weight;
    v[k + 2] += delta[i * 3 + 2] * weight;
  }
}

/** Weights of a value's three levels (min, average, max), as MakeHuman's macro modifiers share them out. */
function levels(x) {
  return x < 0.5 ? { min: 1 - x / 0.5, average: x / 0.5, max: 0 } : { min: 0, average: 1 - (x - 0.5) / 0.5, max: (x - 0.5) / 0.5 };
}

/**
 * MakeHuman's macro targets for a grown body, weighted as its macro modifiers weigh them: `gender` (0 female .. 1
 * male), `age` (0.5 is 25 years, 1 is 90), `muscle` and `weight` (0.5 average), `height` (0.5 average) and the
 * three ethnic shares (summing to 1). Returns [file, weight] pairs, relative to `dir` (targets/macrodetails).
 */
export function macroTargets(m) {
  const genders = { female: 1 - m.gender, male: m.gender };
  const ages = { young: 1 - (m.age - 0.5) / 0.5, old: (m.age - 0.5) / 0.5 };
  const muscle = levels(m.muscle);
  const weight = levels(m.weight);
  const heights = { min: Math.max(0, (0.5 - m.height) * 2), max: Math.max(0, (m.height - 0.5) * 2) };
  const out = [];
  for (const [g, wg] of Object.entries(genders))
    for (const [a, wa] of Object.entries(ages)) {
      if (wg * wa <= 0) continue;
      for (const [race, wr] of Object.entries(m.race)) if (wr > 0) out.push([`${race}-${g}-${a}.target`, wg * wa * wr]);
      for (const [mu, wm] of Object.entries(muscle))
        for (const [we, ww] of Object.entries(weight)) {
          const w = wg * wa * wm * ww;
          if (w <= 0) continue;
          out.push([`universal-${g}-${a}-${mu}muscle-${we}weight.target`, w]);
          for (const [h, wh] of Object.entries(heights)) if (wh > 0) out.push([`height/${g}-${a}-${mu}muscle-${we}weight-${h}height.target`, w * wh]);
        }
    }
  return out;
}

/** The skeleton: bones (name → head and tail joint names, parent) and each joint's vertices (its helper cube). */
export function readSkeleton(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  return { bones: s.bones, joints: s.joints, planes: s.planes };
}

/** A joint's position: the middle of its helper vertices. */
export function jointAt(v, verts) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const i of verts) {
    x += v[i * 3];
    y += v[i * 3 + 1];
    z += v[i * 3 + 2];
  }
  return [x / verts.length, y / verts.length, z / verts.length];
}

/** The skin weights: bone → [[vertex, weight], ...]. */
export function readWeights(file) {
  return JSON.parse(readFileSync(file, 'utf8')).weights;
}

/**
 * A proxy (.mhclo / .proxy): its OBJ, and for each of its vertices the base mesh's vertices it follows, their
 * weights and an offset (scaled by the body's size along each axis, as MakeHuman fits it).
 */
export function readProxy(file) {
  const dir = path.dirname(file);
  const refs = [];
  const scales = {};
  let obj = '';
  let material = '';
  let inVerts = false;
  const deleteVerts = [];
  let inDelete = false;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const t = line.split(/\s+/);
    if (/^\d/.test(t[0])) {
      if (inDelete) {
        for (const tok of t) {
          if (tok.includes('-')) {
            const [a, b] = tok.split('-').map(Number);
            for (let i = a; i <= b; i++) deleteVerts.push(i);
          } else deleteVerts.push(+tok);
        }
        continue;
      }
      if (!inVerts) continue;
      if (t.length === 1) refs.push({ v: [+t[0], +t[0], +t[0]], w: [1, 0, 0], d: [0, 0, 0] });
      else refs.push({ v: [+t[0], +t[1], +t[2]], w: [+t[3], +t[4], +t[5]], d: [+t[6], +t[7], +t[8]] });
      continue;
    }
    inDelete = false;
    if (t[0] === 'verts') inVerts = true;
    else if (t[0] === 'delete_verts') inDelete = true;
    else if (t[0] === 'obj_file') obj = path.join(dir, t[1]);
    else if (t[0] === 'material') material = path.join(dir, t[1]);
    else if (t[0].endsWith('_scale')) scales[t[0][0]] = { a: +t[1], b: +t[2], d: +t[3] };
    else if (inVerts) inVerts = false;
  }
  return { refs, scales, obj: readObj(obj), material, deleteVerts };
}

/** A proxy's vertices on the (morphed) base mesh `v`. */
export function fitProxy(proxy, v) {
  const scale = [0, 1, 2].map((axis) => {
    const s = proxy.scales['xyz'[axis]];
    return s ? Math.abs(v[s.a * 3 + axis] - v[s.b * 3 + axis]) / s.d : 1;
  });
  const out = new Float64Array(proxy.refs.length * 3);
  proxy.refs.forEach((r, i) => {
    for (let axis = 0; axis < 3; axis++) {
      let p = 0;
      for (let k = 0; k < 3; k++) p += r.w[k] * v[r.v[k] * 3 + axis];
      out[i * 3 + axis] = p + r.d[axis] * scale[axis];
    }
  });
  return out;
}

/** A material file's settings (key → rest of the line). */
export function readMaterial(file) {
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const i = line.indexOf(' ');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
