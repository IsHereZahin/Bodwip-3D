import { BufferAttribute, BufferGeometry, Color, Matrix3, Matrix4, Vector3 } from 'three';

export type RGB = readonly [number, number, number];

const WHITE: RGB = [1, 1, 1];

/**
 * Accumulates position / normal / uv / colour / index data so that many procedural parts
 * (planks, poles, roofs, leaf cards) end up in one geometry and one draw call.
 */
export class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uvs: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vertex(p: Vector3, n: Vector3, u: number, v: number, c: RGB = WHITE): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uvs.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Appends another geometry, transformed, with a flat vertex colour, or (`'own'`) keeping the geometry's own vertex colours. */
  add(geometry: BufferGeometry, matrix: Matrix4, color: RGB | 'own' = WHITE): void {
    const p = geometry.getAttribute('position');
    const n = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const own = color === 'own' ? geometry.getAttribute('color') : undefined;
    const normalMatrix = new Matrix3().getNormalMatrix(matrix);
    const base = this.vertexCount;
    const v = new Vector3();
    const vn = new Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      if (n) vn.fromBufferAttribute(n, i).applyMatrix3(normalMatrix).normalize();
      else vn.set(0, 1, 0);
      const c: RGB = own ? [own.getX(i), own.getY(i), own.getZ(i)] : color === 'own' ? WHITE : color;
      this.vertex(v, vn, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0, c);
    }
    const index = geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    const count = this.vertexCount;
    g.setIndex(new BufferAttribute(count > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** sRGB hex → linear RGB triple (vertex colours are linear). */
export function rgb(hex: string, scale = 1): RGB {
  const c = new Color(hex);
  return [c.r * scale, c.g * scale, c.b * scale];
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function scaleRgb(a: RGB, s: number): RGB {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** A box (centre, size, yaw) whose faces carry texture coordinates in metres over `tile`, so plaster and tin keep their scale on every face. */
export function slab(b: MeshBuilder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, ry: number, c: RGB, tile = 3): void {
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  const P = (x: number, y: number, z: number) => new Vector3(cx + x * cos + z * sin, cy + y, cz - x * sin + z * cos);
  const N = (x: number, y: number, z: number) => new Vector3(x * cos + z * sin, y, -x * sin + z * cos);
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const face = (k: readonly (readonly [number, number, number])[], n: readonly [number, number, number], w: number, h: number) => {
    const nn = N(n[0], n[1], n[2]);
    const s = b.vertexCount;
    b.vertex(P(...k[0]), nn, 0, 0, c);
    b.vertex(P(...k[1]), nn, w / tile, 0, c);
    b.vertex(P(...k[2]), nn, w / tile, h / tile, c);
    b.vertex(P(...k[3]), nn, 0, h / tile, c);
    b.quad(s, s + 1, s + 2, s + 3);
  };
  face([[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], [0, 0, 1], sx, sy);
  face([[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], [0, 0, -1], sx, sy);
  face([[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], [1, 0, 0], sz, sy);
  face([[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], [-1, 0, 0], sz, sy);
  face([[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], [0, 1, 0], sx, sz);
  face([[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], [0, -1, 0], sx, sz);
}

const tmpT = new Vector3();
const tmpN = new Vector3();
const tmpB = new Vector3();
const tmpP = new Vector3();
const tmpV = new Vector3();

/**
 * A tube along `points` whose radius follows `radii` (trunks, culms, poles, gunwales).
 * `vRepeat` metres per texture repeat along the length.
 */
export function taperedTube(
  b: MeshBuilder,
  points: readonly Vector3[],
  radii: readonly number[],
  radial: number,
  color: RGB = WHITE,
  vRepeat = 1,
): void {
  const rings: number[] = [];
  let along = 0;
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    tmpT.subVectors(next, prev).normalize();
    const ref = Math.abs(tmpT.y) < 0.9 ? tmpV.set(0, 1, 0) : tmpV.set(1, 0, 0);
    tmpN.crossVectors(tmpT, ref).normalize();
    tmpB.crossVectors(tmpT, tmpN).normalize();
    if (i > 0) along += points[i].distanceTo(points[i - 1]);
    rings.push(b.vertexCount);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      const n = new Vector3().copy(tmpN).multiplyScalar(nx).addScaledVector(tmpB, ny);
      tmpP.copy(points[i]).addScaledVector(n, radii[i]);
      b.vertex(tmpP, n, j / radial, along / vRepeat, color);
    }
  }
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = rings[i] + j;
      const c = rings[i + 1] + j;
      b.quad(a, c, c + 1, a + 1);
    }
  }
}

/** A single double-sided card (quad) centred at `center`, spanned by `right` and `up` half-vectors. */
export function card(
  b: MeshBuilder,
  center: Vector3,
  right: Vector3,
  up: Vector3,
  normal: Vector3,
  color: RGB,
  bottomAnchored = false,
): void {
  const o = bottomAnchored ? tmpV.copy(center).add(up) : tmpV.copy(center);
  const p = new Vector3();
  const i0 = b.vertex(p.copy(o).sub(right).sub(up), normal, 0, 0, color);
  const i1 = b.vertex(p.copy(o).add(right).sub(up), normal, 1, 0, color);
  const i2 = b.vertex(p.copy(o).add(right).add(up), normal, 1, 1, color);
  const i3 = b.vertex(p.copy(o).sub(right).add(up), normal, 0, 1, color);
  b.quad(i0, i1, i2, i3);
}

/**
 * The tops of a crown made only of `card`s (four corners each, in order): in each `cell` m square seen from above,
 * the middle of its highest card, kept where that is in the crown's top `upper` share of its height and no
 * square beside it rises more than a square's width over it (on the crown's top, not its steep side). A card's
 * middle is in its leaves, where a bird sits on the crown; its corners are mostly air.
 */
export function crownTops(leaves: BufferGeometry, cell = 1, upper = 0.4): Vector3[] {
  const pos = leaves.getAttribute('position');
  const key = (i: number, j: number) => (i + 4096) * 8192 + j + 4096;
  const best = new Map<number, { p: Vector3; i: number; j: number }>();
  let lo = Infinity;
  let hi = -Infinity;
  for (let q = 0; q + 3 < pos.count; q += 4) {
    const x = (pos.getX(q) + pos.getX(q + 1) + pos.getX(q + 2) + pos.getX(q + 3)) / 4;
    const y = (pos.getY(q) + pos.getY(q + 1) + pos.getY(q + 2) + pos.getY(q + 3)) / 4;
    const z = (pos.getZ(q) + pos.getZ(q + 1) + pos.getZ(q + 2) + pos.getZ(q + 3)) / 4;
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
    const i = Math.floor(x / cell);
    const j = Math.floor(z / cell);
    const was = best.get(key(i, j));
    if (!was) best.set(key(i, j), { p: new Vector3(x, y, z), i, j });
    else if (y > was.p.y) was.p.set(x, y, z);
  }
  const floor = hi - (hi - lo) * upper;
  const tops: Vector3[] = [];
  for (const { p, i, j } of best.values()) {
    if (p.y < floor) continue;
    let open = true;
    for (let di = -1; di <= 1 && open; di++) {
      for (let dj = -1; dj <= 1 && open; dj++) open = (best.get(key(i + di, j + dj))?.p.y ?? -Infinity) - p.y <= cell;
    }
    if (open) tops.push(p);
  }
  return tops;
}
