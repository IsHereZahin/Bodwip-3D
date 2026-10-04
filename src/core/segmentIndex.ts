// Straight segments filed in square cells, for asking which is nearest a point measured against its own
// half-width: the ground asks it about the khals and the roads at every vertex and every placement, so the
// lookup is one map read and a few distances.

export interface SegmentHit {
  /** Which segment (the order they were added in). */
  index: number;
  /** How far along it the nearest point lies (0..1), and how far from its middle line the point is. */
  t: number;
  d: number;
}

export class SegmentIndex {
  private readonly cell: number;
  private readonly grid = new Map<number, number[]>();
  /** Per segment: ax, az, bx, bz, half-width, and the margin beyond it that still counts. */
  private readonly ends: number[] = [];
  private readonly half: number[] = [];
  private readonly reach: number[] = [];
  private readonly hit: SegmentHit = { index: 0, t: 0, d: 0 };

  constructor(cell: number) {
    this.cell = cell;
  }

  private key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }

  /** Files a segment from (ax, az) to (bx, bz), `half` wide either side, found out to `half + margin`. */
  add(ax: number, az: number, bx: number, bz: number, half: number, margin: number): number {
    const index = this.half.length;
    this.ends.push(ax, az, bx, bz);
    this.half.push(half);
    this.reach.push(half + margin);
    const pad = half + margin;
    const i0 = Math.floor((Math.min(ax, bx) - pad) / this.cell);
    const i1 = Math.floor((Math.max(ax, bx) + pad) / this.cell);
    const j0 = Math.floor((Math.min(az, bz) - pad) / this.cell);
    const j1 = Math.floor((Math.max(az, bz) + pad) / this.cell);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(index);
      }
    }
    return index;
  }

  /**
   * The segment nearest (x, z) against its half-width (the smallest d − half), among those whose reach takes
   * in the point; null if none. The result is reused by the next call.
   */
  nearest(x: number, z: number): SegmentHit | null {
    const list = this.grid.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!list) return null;
    let best = Infinity;
    const e = this.ends;
    for (const n of list) {
      const ax = e[n * 4];
      const az = e[n * 4 + 1];
      const sx = e[n * 4 + 2] - ax;
      const sz = e[n * 4 + 3] - az;
      const len2 = sx * sx + sz * sz;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * sx + (z - az) * sz) / len2)) : 0;
      const d = Math.hypot(x - ax - sx * t, z - az - sz * t);
      if (d > this.reach[n] || d - this.half[n] >= best) continue;
      best = d - this.half[n];
      this.hit.index = n;
      this.hit.t = t;
      this.hit.d = d;
    }
    return best < Infinity ? this.hit : null;
  }
}
