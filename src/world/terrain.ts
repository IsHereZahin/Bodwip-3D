import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { mixRgb, rgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import type { GroundSet } from '../render/surfaces';
import {
  WORLD_U,
  WORLD_Z0,
  WORLD_Z1,
  bilMarsh,
  charHeight,
  coastal,
  edgeHalfWidth,
  landLevel,
  riverX,
  saltPan,
  terrainHeight,
  villageDistance,
  wetlandMarsh,
} from './geography';

const Z_STEP = 5;
const CHUNKS = 8;

const COLORS = {
  bedDeep: rgb('#2a241a'),
  wetMud: rgb('#3d3226'),
  dryMud: rgb('#6e5c45'),
  sandWet: rgb('#8a7759'),
  sand: rgb('#c4b08c'),
  grassA: rgb('#4a6427'),
  grassB: rgb('#647b33'),
  grassDry: rgb('#857e48'),
  dust: rgb('#7d6849'),
  /** The coastal flats: grey, salty clay with a thin, wiry grass. */
  saltClay: rgb('#8a8170'),
  coastGrass: rgb('#6d7442'),
};

/**
 * Columns are laid out across the river from its centre line, so the grid is dense where
 * the banks and khals are (and follows them round every bend), still fine over the bil behind
 * the left bank, and coarse out in the fields.
 */
function columnOffsets(): number[] {
  const near: number[] = [];
  for (let u = -460; u < -240; u += 4) near.push(u);
  for (let u = -240; u <= 260; u += 3) near.push(u);
  // the estuary's right bank, where the river is widest
  for (let u = 264; u <= 420; u += 4) near.push(u);
  const far = (from: number, step: number): number[] => {
    const out: number[] = [];
    let u = from;
    let d = step;
    while (u < WORLD_U) {
      d *= 1.09;
      u = Math.min(u + d, WORLD_U);
      out.push(u);
    }
    return out;
  };
  const left = far(-near[0], 4).map((v) => -v).reverse();
  return [...left, ...near, ...far(near[near.length - 1], 3)];
}

/**
 * What covers the ground at a point: the painted colour, the field zone (paddy plots as 0..1, salt pans as
 * 0..−1), and the weights of the photo layers (grass, dirt, sand, and whether pebbles may gather here; mud
 * takes whatever is left).
 * The terrain mesh and the near-field grass both read it, so grass grows where the ground is grassy.
 */
export interface Cover {
  color: RGB;
  zone: number;
  grass: number;
  dirt: number;
  sand: number;
  pebbles: number;
}

function cover(x: number, z: number, u: number, h: number): Cover {
  const ch = charHeight(z, u);
  if (ch >= h - 0.02 && ch > -1.5) {
    const color =
      h < -0.1
        ? mixRgb(COLORS.bedDeep, COLORS.sandWet, smoothstep(-1.8, -0.1, h))
        : mixRgb(COLORS.sandWet, COLORS.sand, smoothstep(0.0, 0.55, h));
    return { color, zone: 0, grass: 0, dirt: 0, sand: 1, pebbles: 0 };
  }
  const side = u >= 0 ? 1 : -1;
  const inland = Math.abs(u) - edgeHalfWidth(z, side);
  if (h < -0.15) {
    const color = mixRgb(COLORS.bedDeep, COLORS.wetMud, smoothstep(-4, -0.15, h));
    // gravel only along the river; khals and the bil keep a soft muddy bed
    return { color, zone: 0, grass: 0, dirt: 0, sand: 0, pebbles: h > -1.3 && inland < 6 ? 1 : 0 };
  }

  const land = landLevel(x, z);
  // the low rims of the bil and the small wetlands are wet meadow, grassy almost down to the water
  const marsh = Math.max(bilMarsh(z, u), wetlandMarsh(x, z));
  const top = Math.max(smoothstep(land - 0.8, land - 0.1, h), marsh * smoothstep(-0.02, 0.2, h));
  const mud = mixRgb(COLORS.wetMud, COLORS.dryMud, smoothstep(-0.1, 1.0, h));
  let ground = mixRgb(COLORS.grassA, COLORS.grassB, fbm(x * 0.012, z * 0.012, 3, 21));
  // on the coast the grass is thin and the clay grey with salt
  const coast = coastal(z);
  if (coast > 0) ground = mixRgb(ground, mixRgb(COLORS.coastGrass, COLORS.saltClay, smoothstep(0.4, 0.7, fbm(x * 0.02, z * 0.02, 2, 63))), coast * 0.8);
  const dry = smoothstep(0.6, 0.8, fbm(x * 0.004, z * 0.004, 2, 33));
  ground = mixRgb(ground, COLORS.grassDry, dry);
  const vd = villageDistance(x, z);
  const yard = smoothstep(1.0, 0.35, vd);
  ground = mixRgb(ground, COLORS.dust, yard * 0.6);
  const fields = smoothstep(0.3, 0.42, fbm(x * 0.0025 + 5, z * 0.0025, 2, 44));
  // paddy inland; on the coast, salt pans
  const salt = top * saltPan(x, z);
  const paddy = top * smoothstep(38, 75, inland) * smoothstep(1.25, 1.9, vd) * fields * (1 - coast);
  const zone = salt > 0.01 ? -salt : paddy;
  // trodden earth round the houses, and bare patches where the grass has dried out; the pans are bare clay
  const dirt = Math.min(1, yard * 0.9 + dry * 0.35 + 0.25 * smoothstep(0.62, 0.78, fbm(x * 0.05, z * 0.05, 2, 71)) + salt + coast * 0.25);
  // pebbles only along the river; the ponds keep muddy banks
  const pebbles = (1 - top) * smoothstep(30, 14, inland);
  return { color: mixRgb(mud, ground, top), zone, grass: top * (1 - dirt), dirt: top * dirt, sand: 0, pebbles };
}

/** Ground cover at a point of the world (see `Cover`), with the terrain height there. */
export function groundAt(x: number, z: number): Cover & { h: number } {
  const h = terrainHeight(x, z);
  return { ...cover(x, z, x - riverX(z), h), h };
}

/**
 * Height and cover inside a square (`size` m from (x0, z0)), interpolated from a lattice `step` m apart: the
 * full lookups are costly, and things built near the camera chunk by chunk (the meadow, the crops) need
 * thousands of them.
 */
export function groundLattice(x0: number, z0: number, size: number, step: number): (x: number, z: number) => Cover & { h: number } {
  const n = Math.round(size / step) + 1;
  const pts: (Cover & { h: number })[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push(groundAt(x0 + i * step, z0 + j * step));
  const lerpCover = (a: Cover & { h: number }, b: Cover & { h: number }, t: number) => ({
    color: a.color,
    h: a.h + (b.h - a.h) * t,
    zone: a.zone + (b.zone - a.zone) * t,
    grass: a.grass + (b.grass - a.grass) * t,
    dirt: a.dirt + (b.dirt - a.dirt) * t,
    sand: a.sand + (b.sand - a.sand) * t,
    pebbles: a.pebbles + (b.pebbles - a.pebbles) * t,
  });
  return (x, z) => {
    const fx = Math.min(Math.max((x - x0) / step, 0), n - 1.001);
    const fz = Math.min(Math.max((z - z0) / step, 0), n - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a = lerpCover(pts[j * n + i], pts[j * n + i + 1], tx);
    const b = lerpCover(pts[(j + 1) * n + i], pts[(j + 1) * n + i + 1], tx);
    return lerpCover(a, b, tz);
  };
}

/** `ground`: the photo layers; without them the terrain keeps its painted colours. */
export function buildTerrain(ground: GroundSet | null): Group {
  const cols = columnOffsets();
  const C = cols.length;
  const R = Math.ceil((WORLD_Z0 - WORLD_Z1) / Z_STEP) + 1;
  const pos = new Float32Array(R * C * 3);
  const col = new Float32Array(R * C * 3);
  const zone = new Float32Array(R * C);
  const splat = new Float32Array(R * C * 4);

  for (let r = 0; r < R; r++) {
    const z = Math.max(WORLD_Z0 - r * Z_STEP, WORLD_Z1);
    const cx = riverX(z);
    for (let c = 0; c < C; c++) {
      const u = cols[c];
      const x = cx + u;
      const h = terrainHeight(x, z);
      const i = r * C + c;
      pos[i * 3] = x;
      pos[i * 3 + 1] = h;
      pos[i * 3 + 2] = z;
      const vc = cover(x, z, u, h);
      col[i * 3] = vc.color[0];
      col[i * 3 + 1] = vc.color[1];
      col[i * 3 + 2] = vc.color[2];
      zone[i] = vc.zone;
      splat.set([vc.grass, vc.dirt, vc.sand, vc.pebbles], i * 4);
    }
  }

  // normals from the whole grid, so chunk seams light identically
  const nrm = new Float32Array(R * C * 3);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const l = (r * C + Math.max(c - 1, 0)) * 3;
      const rt = (r * C + Math.min(c + 1, C - 1)) * 3;
      const up = (Math.max(r - 1, 0) * C + c) * 3;
      const dn = (Math.min(r + 1, R - 1) * C + c) * 3;
      const ax = pos[rt] - pos[l];
      const ay = pos[rt + 1] - pos[l + 1];
      const az = pos[rt + 2] - pos[l + 2];
      const bx = pos[dn] - pos[up];
      const by = pos[dn + 1] - pos[up + 1];
      const bz = pos[dn + 2] - pos[up + 2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (r * C + c) * 3;
      nrm[i] = nx;
      nrm[i + 1] = ny;
      nrm[i + 2] = nz;
    }
  }

  const material = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 }), {
    terrain: true,
    splat: ground ?? undefined,
  });
  const group = new Group();
  group.name = 'terrain';
  const rowsPer = Math.ceil((R - 1) / CHUNKS);
  for (let r0 = 0; r0 < R - 1; r0 += rowsPer) {
    const r1 = Math.min(R - 1, r0 + rowsPer);
    const rows = r1 - r0 + 1;
    const from = r0 * C;
    const to = (r1 + 1) * C;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos.slice(from * 3, to * 3), 3));
    g.setAttribute('normal', new BufferAttribute(nrm.slice(from * 3, to * 3), 3));
    g.setAttribute('color', new BufferAttribute(col.slice(from * 3, to * 3), 3));
    g.setAttribute('aZone', new BufferAttribute(zone.slice(from, to), 1));
    g.setAttribute('aSplat', new BufferAttribute(splat.slice(from * 4, to * 4), 4));
    const idx = new Uint32Array((rows - 1) * (C - 1) * 6);
    let k = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < C - 1; c++) {
        const a = r * C + c;
        const b = a + 1;
        const d = a + C;
        const e = d + 1;
        idx[k++] = a;
        idx[k++] = b;
        idx[k++] = d;
        idx[k++] = b;
        idx[k++] = e;
        idx[k++] = d;
      }
    }
    g.setIndex(new BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const mesh = new Mesh(g, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
