import { BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, RingGeometry, ShaderMaterial, Vector2 } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { Rng } from '../core/rng';
import { CORRIDOR, GLSL_COMMON } from '../render/glsl';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { rockTexture } from '../render/textures';
import { PONDS, WATER_LEVEL, corridorDistance, onBridge, onLandmark, onRoad, pondReach, terrainHeight } from './geography';
import { CHANNELS } from './channels';
import { meshGround } from './terrain';
import { KHAL_ROCKS } from './plan';
import { KHAL, RIVER, SIDE_KHAL, type Waterway } from './waterways';
import { planGhats } from './village';

// Stones by the waters (the user's reference): now and then a few along the khals' and the river's banks, some
// half in the water at its edge, some up among the grass; and the khal's few rocks standing up out of its water
// (plan.ts KHAL_ROCKS), which the boat's way swerves round. Weathered grey-brown, mossy on top. They go through
// patchMaterial, so what is under the water is tinted by it.

/** A stone's place and size, for keeping the grass and the bushes off it. */
interface Stone {
  x: number;
  z: number;
  r: number;
}

/** How a rock is cut and coloured: its rings and segments round, a tint over its stone, how mossy its top. */
interface RockLook {
  rings: number;
  segs: number;
  tint: [number, number, number];
  moss: number;
}
const BOULDER: RockLook = { rings: 16, segs: 24, tint: [1, 1, 1], moss: 1 };
/** The kept pond's pebbles: few-sided (they are small), in the greys, browns and ochres of a pond's gravel, dulled by the silt and the algae on them. */
const PEBBLE_LOOKS: RockLook[] = [
  { rings: 6, segs: 9, tint: [0.62, 0.66, 0.64], moss: 0.6 },
  { rings: 6, segs: 9, tint: [0.72, 0.62, 0.5], moss: 0.6 },
  { rings: 6, segs: 9, tint: [0.8, 0.7, 0.52], moss: 0.5 },
  { rings: 6, segs: 9, tint: [0.48, 0.48, 0.44], moss: 0.7 },
  { rings: 6, segs: 9, tint: [0.85, 0.82, 0.74], moss: 0.5 },
];

/**
 * A rock 1 m in radius about its middle, its foot flattened at y −0.25 and its top about 0.6 up: a lump cut by a
 * few planes into the flat faces and edges a broken, weathered stone has, a little rough all over; mossy where it
 * faces the sky and darker at its foot (vertex colour over `rockTexture`).
 */
function rockShape(seed: number, look: RockLook = BOULDER): BufferGeometry {
  const { rings, segs, tint } = look;
  const rng = new Rng(seed);
  // the cutting planes: their normals (most of them across or up, so it rests on its foot with a flat top or two) and how far out
  // a few gentle cuts: a water-worn stone keeps its faces but its edges are rounded off
  const planes = Array.from({ length: 5 }, () => {
    const a = rng.range(0, Math.PI * 2);
    const up = rng.range(-0.1, 0.9);
    const h = Math.sqrt(1 - up * up);
    return { x: Math.cos(a) * h, y: up, z: Math.sin(a) * h, d: rng.range(0.8, 0.95) };
  });
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const at = (nx: number, ny: number, nz: number, u: number, v: number) => {
    let k = 1 + 0.28 * (fbm(nx * 1.1 + seed, ny * 1.1 + nz * 0.8, 3, seed) - 0.5);
    for (const p of planes) {
      const d = nx * p.x + ny * p.y + nz * p.z;
      // a soft cut: the radius eases down toward the plane rather than meeting it at an edge
      if (d > 0.05) k = Math.min(k, k * 0.35 + 0.65 * (p.d / d));
    }
    k += 0.035 * (fbm(nx * 7 + seed, nz * 7 - ny * 3, 2, seed + 11) - 0.5);
    const x = nx * k;
    let y = ny * k * 0.55;
    const z = nz * k * 0.85;
    // the foot settles flat into the ground
    if (y < -0.25) y = -0.25 + (y + 0.25) * 0.2;
    // moss in patches over the top and on the sides that face the sky; grey stone between and below
    const moss = look.moss * Math.max(0, Math.min(1, (ny - 0.15) * 2)) * Math.max(0, Math.min(1, (fbm(nx * 2.2 + seed, nz * 2.2 + ny, 3, seed + 3) - 0.4) * 3.5));
    const shade = 0.8 + 0.4 * Math.min(1, (y + 0.25) / 0.55);
    pos.push(x, y, z);
    // projected mostly from above (the moss and the lichen read from where they are seen), a little from the side
    uv.push(x * 1.3 + z * 0.35 + u * 0, z * 1.3 - y * 0.8 + v * 0);
    col.push(shade * (1 - moss * 0.45) * tint[0], shade * (1 - moss * 0.12) * tint[1], shade * (1 - moss * 0.62) * tint[2]);
  };
  // rings from the top to the bottom, each with a duplicate at the seam so the texture wraps cleanly
  for (let j = 0; j <= rings; j++) {
    const t = (j / rings) * Math.PI;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      at(Math.sin(t) * Math.cos(a), Math.cos(t), Math.sin(t) * Math.sin(a), (i / segs) * 3, (j / rings) * 1.6);
    }
  }
  const index: number[] = [];
  const row = segs + 1;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      index.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(index);
  g.computeVertexNormals();
  // the seam's two columns, and the poles' rings, share one normal
  const n = g.getAttribute('normal') as BufferAttribute;
  const share = (list: number[]) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const v of list) (x += n.getX(v)), (y += n.getY(v)), (z += n.getZ(v));
    const l = Math.hypot(x, y, z) || 1;
    for (const v of list) n.setXYZ(v, x / l, y / l, z / l);
  };
  for (let j = 0; j <= rings; j++) share([j * row, j * row + segs]);
  share(Array.from({ length: row }, (_, i) => i));
  share(Array.from({ length: row }, (_, i) => rings * row + i));
  return g;
}

/** Height of the unit rock from its foot to its top. */
const ROCK_HEIGHT = 0.87;
/** The rock shapes. */
const SHAPES = 5;

/** The khal's rocks in the world: from its middle `c` m to the left, as the boat's way reckons it; and their tops' height (m). */
export function khalRocks(): { x: number; z: number; r: number; top: number }[] {
  return KHAL_ROCKS.map((k) => {
    const p = KHAL.at(k.s);
    return { x: p.x + Math.cos(p.heading) * k.c, z: p.z - Math.sin(p.heading) * k.c, r: k.r, top: WATER_LEVEL + 0.45 + 0.2 * k.r };
  });
}

/** The season's rise of the water, lowest and highest (m, env/season.ts `water`): a stone the water stands round in any season has its foam. */
const RISE = { low: -0.45, high: 0.85 };

/** Where every stone lies and each placement, worked out once. */
const PLAN = (() => {
  const rng = new Rng(311);
  const ghats = planGhats();
  const stones: Stone[] = [];
  const items: Placement[][] = Array.from({ length: SHAPES }, () => []);
  /**
   * The stones the water may stand round in some season, for the foam at their waterline: where each lies, its
   * origin's height, its height scale and size (its width at the waterline is the foam's to work out), and the
   * ground under it.
   */
  const rings: { x: number; z: number; y: number; h: number; s: number; ground: number }[] = [];
  const put = (x: number, y: number, z: number, s: number, sy = 1) => {
    items[rng.int(0, SHAPES - 1)].push({ x, y, z, ry: rng.range(0, Math.PI * 2), s, sy, tx: rng.range(-0.12, 0.12), tz: rng.range(-0.12, 0.12) });
    stones.push({ x, z, r: s * 1.05 });
    const foot = y - 0.25 * s * sy;
    const top = y + (ROCK_HEIGHT - 0.25) * s * sy;
    const ground = terrainHeight(x, z);
    if (foot < WATER_LEVEL + RISE.high && top > WATER_LEVEL + RISE.low && ground < WATER_LEVEL + RISE.high) rings.push({ x, z, y, h: s * sy, s, ground });
  };
  const clear = (x: number, z: number) =>
    !onRoad(x, z, 0.6) && !onBridge(x, z, 2) && !onLandmark(x, z, 2) && corridorDistance(x, z) < CORRIDOR.crops && !ghats.some((g) => Math.hypot(g.x - x, g.z - z) < 7);

  // the khal's rocks, standing on its bed and up out of the water, a few smaller ones about each away from the boat's way
  khalRocks().forEach((k, n) => {
    const bed = terrainHeight(k.x, k.z);
    // a broad boulder standing up out of the water, as a rock in a stream does; what is under the water is
    // lost in the murk, and a second, broader stone under it stands on the bed
    const top = k.top;
    const s = k.r * 1.25;
    const sy = 1.15;
    put(k.x, top - (ROCK_HEIGHT - 0.25) * s * sy, k.z, s, sy);
    put(k.x + 0.3, bed + 0.25 * s * 1.4, k.z - 0.2, s * 1.4, 1);
    const p = KHAL.at(KHAL_ROCKS[n].s);
    const away = Math.sign(KHAL_ROCKS[n].c);
    for (let i = 0; i < 3; i++) {
      const along = rng.range(-2.2, 2.2);
      const out = away * (k.r + rng.range(0.3, 1.4));
      const x = k.x + Math.sin(p.heading) * along + Math.cos(p.heading) * out;
      const z = k.z + Math.cos(p.heading) * along - Math.sin(p.heading) * out;
      const r = rng.range(0.25, 0.5);
      const b = terrainHeight(x, z);
      const t = WATER_LEVEL + rng.range(-0.15, 0.12);
      const ys = Math.max(1, (t - b) / (ROCK_HEIGHT * r));
      put(x, b + 0.25 * r * ys, z, r, ys);
    }
  });

  // the hill stream's rocks: boulders at the lip of each ledge its water falls off, one or two in its bed below,
  // and stones along its gully's sides
  for (const c of CHANNELS) {
    if (c.ledge <= 0) continue;
    const h = c.pts.map(([x, z]) => terrainHeight(x, z));
    for (let i = 1; i + 1 < c.pts.length; i++) {
      const [x, z] = c.pts[i];
      const [nx, nz] = c.pts[i + 1];
      const l = Math.hypot(nx - x, nz - z) || 1;
      const ax = -(nz - z) / l;
      const az = (nx - x) / l;
      if (h[i] - h[i + 1] > 0.35) {
        for (const side of [-1, 1]) {
          const out = side * (c.width / 2 - rng.range(0.1, 0.35));
          const r = rng.range(0.35, 0.6);
          const px = x + ax * out;
          const pz = z + az * out;
          put(px, Math.max(terrainHeight(px, pz), meshGround(px, pz)) + 0.05 * r, pz, r, rng.range(0.9, 1.3));
        }
        if (rng.next() < 0.6) {
          const out = rng.range(-0.3, 0.3);
          const px = nx + ax * out + (nx - x) * 0.6;
          const pz = nz + az * out + (nz - z) * 0.6;
          put(px, Math.max(terrainHeight(px, pz), meshGround(px, pz)) + 0.02, pz, rng.range(0.18, 0.32), 0.8);
        }
      } else if (rng.next() < 0.3) {
        const side = rng.sign();
        const out = side * (c.width / 2 + rng.range(-0.1, 0.6));
        const px = x + ax * out;
        const pz = z + az * out;
        const r = rng.range(0.2, 0.45);
        put(px, Math.max(terrainHeight(px, pz), meshGround(px, pz)) + 0.08 * r, pz, r, rng.range(0.8, 1.1));
      }
    }
  }

  // along the banks: every so often one to three stones, half of them at the water's edge, half up in the grass
  const banks: [Waterway, number, number][] = [
    [KHAL, 5, 1],
    [SIDE_KHAL, 3, 0.8],
    [RIVER, 7, 0.55],
  ];
  for (const [way, bank, often] of banks) {
    for (const side of [-1, 1] as const) {
      for (let s = rng.range(5, 25); s < way.length; s += rng.range(10, 34) / often) {
        const edge = rng.next() < 0.55;
        const out = way.half(s) + (edge ? rng.range(-0.6, 2.2) : bank + rng.range(0.6, 6));
        const c = way.beside(s, side, out);
        if (!clear(c.x, c.z)) continue;
        const n = rng.next() < 0.45 ? 1 : rng.next() < 0.6 ? 2 : 3;
        for (let i = 0; i < n; i++) {
          const x = c.x + rng.range(-0.9, 0.9);
          const z = c.z + rng.range(-0.9, 0.9);
          if (stones.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 0.3)) continue;
          const big = rng.next() < 0.12;
          const r = big ? rng.range(0.55, 0.85) : edge ? rng.range(0.28, 0.55) : rng.range(0.2, 0.42);
          put(x, terrainHeight(x, z) + 0.1 * r, z, r, rng.range(0.8, 1.15));
        }
      }
    }
  }

  // filed in 6 m cells for `nearStone`
  const cells = new Map<number, Stone[]>();
  for (const st of stones) {
    const k = Math.floor(st.x / 6) * 4096 + Math.floor(st.z / 6);
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(st);
  }
  return { items, cells, rings };
})();

/** The water's lace round a stone: a flat ring at the surface, foam flecks drawn round it and drifting. */
const FOAM_VERT = /* glsl */ `
${GLSL_COMMON}
// the stone's origin's height, its height scale, its size, the ground under it
attribute vec4 aRock;
varying vec2 vLocal;
varying vec3 vWorld;
varying float vShow;
void main() {
  float level = ${WATER_LEVEL.toFixed(2)} + uWaterRise;
  float foot = aRock.x - 0.25 * aRock.y;
  float top = aRock.x + ${(ROCK_HEIGHT - 0.25).toFixed(3)} * aRock.y;
  // only while the water stands round it: over its foot and the ground under it, and below its top
  vShow = smoothstep(foot, foot + 0.06, level) * smoothstep(aRock.w, aRock.w + 0.06, level) * (1.0 - smoothstep(top - 0.12, top - 0.04, level));
  // its width where the water meets it: the shape is roundest at its middle, narrowing toward the top
  float up = max(0.0, (level - aRock.x) / (0.55 * aRock.y));
  float r = aRock.z * sqrt(max(0.15, 1.0 - up * up)) * 0.84;
  vLocal = position.xz;
  vec4 w = modelMatrix * instanceMatrix * vec4(position.x * r, 0.0, position.z * r, 1.0);
  w.y = level + 0.02;
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FOAM_FRAG = /* glsl */ `
${GLSL_COMMON}
varying vec2 vLocal;
varying vec3 vWorld;
varying float vShow;
void main() {
  if (vShow < 0.01) discard;
  // against the stone a thin broken line of froth, flecks of it drifting off a little way; the inner part of the
  // ring is under the stone, which hides it
  float r = length(vLocal);
  float a = atan(vLocal.y, vLocal.x);
  float n = vnoise(vec2(a * 5.0 + vWorld.x, r * 9.0 - uTime * 0.5) + vWorld.xz * 0.4);
  float line = (1.0 - smoothstep(1.0, 1.12, r)) * smoothstep(0.35, 0.65, n);
  float flecks = (1.0 - smoothstep(1.05, 1.4, r)) * smoothstep(0.72, 0.9, vnoise(vec2(a * 9.0, r * 14.0 - uTime * 0.8) + 3.7));
  float alpha = clamp(line * 0.4 + flecks * 0.3, 0.0, 1.0) * vShow;
  vec3 col = (uFogColor * 0.6 + uKeyColor * max(uKeyDir.y, 0.0) * 0.5 + 0.12) * vec3(0.95, 0.97, 1.0);
  gl_FragColor = vec4(applyAtmosphere(col, vWorld), alpha);
}`;

/** Whether (x, z) is on a stone (within `margin` m of its edge): the grass and the bushes keep off. */
export function nearStone(x: number, z: number, margin: number): boolean {
  const ci = Math.floor(x / 6);
  const cj = Math.floor(z / 6);
  for (let i = ci - 1; i <= ci + 1; i++) {
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (const st of PLAN.cells.get(i * 4096 + j) ?? []) if (Math.hypot(st.x - x, st.z - z) < st.r + margin) return true;
    }
  }
  return false;
}

/**
 * The kept pond's (the mosque's) pebbles and small stones on its bed: thickest along its shallow edge, where the
 * water laps them, a few over its deeper bed; lying in drifts, as the water leaves them, never in rows or rings;
 * off its ghat.
 */
function pondPebbles(): Placement[][] {
  const rng = new Rng(523);
  const items: Placement[][] = PEBBLE_LOOKS.map(() => []);
  for (const pond of PONDS) {
    if (!pond.kept) continue;
    const reach = Math.max(pond.hu, pond.hv) + 3;
    for (let gz = -reach; gz < reach; gz += 0.45) {
      for (let gx = -reach; gx < reach; gx += 0.45) {
        const x = pond.x + gx + rng.range(-0.2, 0.2);
        const z = pond.z + gz + rng.range(-0.2, 0.2);
        if (pondReach(pond, x, z) > 1.15) continue;
        const depth = pond.level - meshGround(x, z);
        // from a little up the wet bank down to the shallows' foot, and thinly over the deeper bed
        const shore = smoothstep(-0.2, -0.05, depth) * (1 - smoothstep(0.45, 0.8, depth));
        const drift = fbm(x * 0.32 + 17, z * 0.32 - 5, 3, 29);
        const chance = shore * smoothstep(0.38, 0.62, drift) * 0.9 + (depth > 0 ? (1 - shore) * smoothstep(0.58, 0.8, drift) * 0.18 : 0);
        if (rng.next() > chance || onLandmark(x, z, 0.3)) continue;
        for (let i = rng.int(1, 3); i > 0; i--) {
          const px = x + rng.range(-0.22, 0.22);
          const pz = z + rng.range(-0.22, 0.22);
          const s = rng.next() < 0.07 ? rng.range(0.16, 0.3) : rng.range(0.035, 0.11);
          const sy = rng.range(0.55, 0.95);
          // bedded a little into the mud
          items[rng.int(0, items.length - 1)].push({ x: px, y: meshGround(px, pz) + 0.1 * s * sy, z: pz, ry: rng.range(0, Math.PI * 2), s, sy, tx: rng.range(-0.15, 0.15), tz: rng.range(-0.15, 0.15) });
        }
      }
    }
  }
  return items;
}

/** The stones, and apart (they are small: main.ts culls them near) the kept pond's pebbles. */
export function buildStones(): { group: Group; pebbles: Group } {
  const group = new Group();
  group.name = 'stones';
  const tex = rockTexture(41);
  const material = patchMaterial(
    new MeshStandardMaterial({ map: tex.map, normalMap: tex.normal, normalScale: new Vector2(0.8, 0.8), vertexColors: true, roughness: 0.88 }),
    { grime: 0.25, wetline: true },
  );
  PLAN.items.forEach((list, i) => {
    if (list.length) group.add(instanced(rockShape(17 + i * 13), material, list, { cast: true, receive: true }));
  });
  const pebbles = new Group();
  pebbles.name = 'pebbles';
  pondPebbles().forEach((list, i) => {
    if (list.length) pebbles.add(instanced(rockShape(61 + i * 7, PEBBLE_LOOKS[i]), material, list, { receive: true, layer: LAYER_NO_REFLECT }));
  });
  group.add(pebbles);
  // the foam round those standing in the water
  if (PLAN.rings.length) {
    const ring = new RingGeometry(0.75, 1.45, 48, 2).rotateX(-Math.PI / 2);
    const foam = new InstancedMesh(
      ring,
      new ShaderMaterial({ uniforms: { ...G }, vertexShader: FOAM_VERT, fragmentShader: FOAM_FRAG, transparent: true, depthWrite: false }),
      PLAN.rings.length,
    );
    const m = new Matrix4();
    const rocks = new Float32Array(PLAN.rings.length * 4);
    PLAN.rings.forEach((r, i) => {
      foam.setMatrixAt(i, m.makeTranslation(r.x, 0, r.z));
      rocks.set([r.y, r.h, r.s, r.ground], i * 4);
    });
    ring.setAttribute('aRock', new InstancedBufferAttribute(rocks, 4));
    // laid at the water's level in its shader, wherever that stands this season
    foam.frustumCulled = false;
    foam.layers.set(LAYER_NO_REFLECT);
    foam.renderOrder = 2;
    foam.name = 'stone-foam';
    group.add(foam);
  }
  return { group, pebbles };
}
