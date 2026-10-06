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

/** The side of the finer cells a query is answered in (m); each is made to divide the filing cell. */
const FINE = 4;

/**
 * A finer cell's candidates: only the segments that can be the nearest to some point in it, in the order of
 * the least `d − half` any point in it can have from them, so a query stops at the first that cannot win.
 */
interface FineCell {
  ids: Int32Array;
  least: Float64Array;
}

export class SegmentIndex {
  private readonly cell: number;
  /** How many finer cells span a filing cell, and their side. */
  private readonly split: number;
  private readonly fine: number;
  private readonly grid = new Map<number, number[]>();
  /**
   * The finer cells over the filed segments' reach, by row (undefined: not asked about yet; null: no segment
   * reaches into it). Each is built on first use; the table is laid out again after a segment is added.
   */
  private cells: (FineCell | null | undefined)[] | null = null;
  private i0 = 0;
  private j0 = 0;
  private cols = 0;
  private rows = 0;
  /** The filed segments' reach, in filing cells. */
  private readonly lo = [Infinity, Infinity];
  private readonly hi = [-Infinity, -Infinity];
  /** Per segment: ax, az, bx, bz, half-width, and the margin beyond it that still counts. */
  private readonly ends: number[] = [];
  private readonly half: number[] = [];
  private readonly reach: number[] = [];
  private readonly hit: SegmentHit = { index: 0, t: 0, d: 0 };

  constructor(cell: number) {
    this.cell = cell;
    this.split = Math.max(1, Math.round(cell / FINE));
    this.fine = cell / this.split;
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
    // (a finer cell already built may now have another candidate)
    this.cells = null;
    const pad = half + margin;
    const i0 = Math.floor((Math.min(ax, bx) - pad) / this.cell);
    const i1 = Math.floor((Math.max(ax, bx) + pad) / this.cell);
    const j0 = Math.floor((Math.min(az, bz) - pad) / this.cell);
    const j1 = Math.floor((Math.max(az, bz) + pad) / this.cell);
    this.lo[0] = Math.min(this.lo[0], i0);
    this.lo[1] = Math.min(this.lo[1], j0);
    this.hi[0] = Math.max(this.hi[0], i1);
    this.hi[1] = Math.max(this.hi[1], j1);
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

  /** The table of finer cells over the filing cells the segments reach. */
  private layOut(): void {
    const empty = this.lo[0] > this.hi[0];
    this.i0 = empty ? 0 : this.lo[0] * this.split;
    this.j0 = empty ? 0 : this.lo[1] * this.split;
    this.cols = empty ? 0 : (this.hi[0] - this.lo[0] + 1) * this.split;
    this.rows = empty ? 0 : (this.hi[1] - this.lo[1] + 1) * this.split;
    this.cells = new Array(this.cols * this.rows);
  }

  /** Distance from (x, z) to segment n's middle line, and how far along it the nearest point lies (in `hit`). */
  private measure(n: number, x: number, z: number, out: SegmentHit): void {
    const e = this.ends;
    const ax = e[n * 4];
    const az = e[n * 4 + 1];
    const sx = e[n * 4 + 2] - ax;
    const sz = e[n * 4 + 3] - az;
    const len2 = sx * sx + sz * sz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * sx + (z - az) * sz) / len2)) : 0;
    out.t = t;
    out.d = Math.hypot(x - ax - sx * t, z - az - sz * t);
  }

  /**
   * The finer cell (fi, fj)'s candidates, from its filing cell's list. Over the cell a segment's d lies within
   * r (half the cell's diagonal) of its d at the cell's middle. One reached from the whole cell bounds the best
   * `d − half` of every point in it; a segment whose least is above that bound can never be the nearest.
   */
  private build(fi: number, fj: number): FineCell | null {
    const list = this.grid.get(this.key(Math.floor(fi / this.split), Math.floor(fj / this.split)));
    if (!list) return null;
    const cx = (fi + 0.5) * this.fine;
    const cz = (fj + 0.5) * this.fine;
    const r = this.fine * Math.SQRT1_2;
    const probe: SegmentHit = { index: 0, t: 0, d: 0 };
    const kept: { n: number; least: number }[] = [];
    let bound = Infinity;
    for (const n of list) {
      this.measure(n, cx, cz, probe);
      if (probe.d - r > this.reach[n]) continue;
      if (probe.d + r <= this.reach[n]) bound = Math.min(bound, probe.d + r - this.half[n]);
      kept.push({ n, least: Math.max(probe.d - r, 0) - this.half[n] });
    }
    const cands = kept.filter((c) => c.least <= bound).sort((a, b) => a.least - b.least || a.n - b.n);
    if (cands.length === 0) return null;
    return { ids: Int32Array.from(cands, (c) => c.n), least: Float64Array.from(cands, (c) => c.least) };
  }

  /**
   * The segment nearest (x, z) against its half-width (the smallest d − half), among those whose reach takes
   * in the point; null if none. Of equals, the first added. The result is reused by the next call.
   */
  nearest(x: number, z: number): SegmentHit | null {
    if (!this.cells) this.layOut();
    const fi = Math.floor(x / this.fine) - this.i0;
    const fj = Math.floor(z / this.fine) - this.j0;
    if (fi < 0 || fj < 0 || fi >= this.cols || fj >= this.rows) return null;
    const at = fj * this.cols + fi;
    const cells = this.cells as (FineCell | null | undefined)[];
    let cell = cells[at];
    if (cell === undefined) cell = cells[at] = this.build(fi + this.i0, fj + this.j0);
    if (!cell) return null;
    let best = Infinity;
    let bestIndex = -1;
    let bestT = 0;
    let bestD = 0;
    const probe = this.hit;
    const { ids, least } = cell;
    for (let j = 0; j < ids.length; j++) {
      if (least[j] > best) break;
      const n = ids[j];
      this.measure(n, x, z, probe);
      if (probe.d > this.reach[n]) continue;
      const v = probe.d - this.half[n];
      if (v < best || (v === best && n < bestIndex)) {
        best = v;
        bestIndex = n;
        bestT = probe.t;
        bestD = probe.d;
      }
    }
    if (bestIndex < 0) return null;
    probe.index = bestIndex;
    probe.t = bestT;
    probe.d = bestD;
    return probe;
  }
}
