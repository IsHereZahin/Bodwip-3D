import { GRID_H, GRID_W, KIND, LAYERS, cellCentre, fcol, frow } from '../geo/data';

// Ways over the sea's water between two points, found on the map's cells: the ferries' routes, and later the
// viewer's own (GEOGRAPHY_PLAN.md §9). A* over the cells whose bed lies at most `maxBed` (m about MSL), so the
// way keeps to water deep enough at the tide it is meant for; diagonal steps allowed, a little extra cost
// near the shallows so it keeps off them; the cells' path is then pulled taut and thinned to a few points.

/** A binary heap of [cost, cell]. */
class Heap {
  private readonly cost: number[] = [];
  private readonly item: number[] = [];
  get size(): number {
    return this.item.length;
  }
  push(c: number, i: number): void {
    this.cost.push(c);
    this.item.push(i);
    let k = this.item.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.cost[p] <= this.cost[k]) break;
      [this.cost[p], this.cost[k]] = [this.cost[k], this.cost[p]];
      [this.item[p], this.item[k]] = [this.item[k], this.item[p]];
      k = p;
    }
  }
  pop(): number {
    const top = this.item[0];
    const lastC = this.cost.pop() as number;
    const lastI = this.item.pop() as number;
    if (this.item.length) {
      this.cost[0] = lastC;
      this.item[0] = lastI;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        const r = l + 1;
        let m = k;
        if (l < this.item.length && this.cost[l] < this.cost[m]) m = l;
        if (r < this.item.length && this.cost[r] < this.cost[m]) m = r;
        if (m === k) break;
        [this.cost[m], this.cost[k]] = [this.cost[k], this.cost[m]];
        [this.item[m], this.item[k]] = [this.item[k], this.item[m]];
        k = m;
      }
    }
    return top;
  }
}

/** Whether a cell is the sea's water with its bed at most `maxBed`. */
function navigable(i: number, maxBed: number): boolean {
  const k = LAYERS.kind[i] & 0x7f;
  return (k === KIND.sea || k === KIND.tidal) && LAYERS.terrain[i] / 10 <= maxBed;
}

/** The water joined to one cell at one bed limit; the last one found is kept, as routes often share it. */
let joined: { maxBed: number; cells: Uint8Array } | null = null;

/** The cells joined by navigable water to `from` (1 where joined), at beds up to `maxBed`. */
function joinedTo(from: number, maxBed: number): Uint8Array {
  if (joined && joined.maxBed === maxBed && joined.cells[from]) return joined.cells;
  const cells = new Uint8Array(GRID_W * GRID_H);
  const stack = new Int32Array(GRID_W * GRID_H);
  let n = 0;
  stack[n++] = from;
  cells[from] = 1;
  while (n) {
    const i = stack[--n];
    const c = i % GRID_W;
    for (let dr = -GRID_W; dr <= GRID_W; dr += GRID_W) {
      for (let dc = -1; dc <= 1; dc++) {
        if ((!dr && !dc) || (c === 0 && dc < 0) || (c === GRID_W - 1 && dc > 0)) continue;
        const j = i + dr + dc;
        if (j < 0 || j >= cells.length || cells[j] || !navigable(j, maxBed)) continue;
        cells[j] = 1;
        stack[n++] = j;
      }
    }
  }
  joined = { maxBed, cells };
  return cells;
}

/** The cell nearest (x, z) that is navigable (and among `within`, if given), looked for out to `reach` cells; −1 if none. */
function nearestNavigable(x: number, z: number, maxBed: number, reach = 40, within?: Uint8Array): number {
  const c0 = Math.round(fcol(x));
  const r0 = Math.round(frow(z));
  let best = -1;
  let bestD = Infinity;
  for (let dr = -reach; dr <= reach; dr++) {
    for (let dc = -reach; dc <= reach; dc++) {
      const c = c0 + dc;
      const r = r0 + dr;
      if (c < 0 || r < 0 || c >= GRID_W || r >= GRID_H) continue;
      const d = dc * dc + dr * dr;
      if (d < bestD && navigable(r * GRID_W + c, maxBed) && (!within || within[r * GRID_W + c])) {
        bestD = d;
        best = r * GRID_W + c;
      }
    }
  }
  return best;
}

/** How far along the straight line from (ax, az) to (bx, bz) the water stays navigable, 0..1 (1: all the way). */
function waterAlong(ax: number, az: number, bx: number, bz: number, maxBed: number): number {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 5));
  for (let k = 1; k <= n; k++) {
    const c = Math.round(fcol(ax + ((bx - ax) * k) / n));
    const r = Math.round(frow(az + ((bz - az) * k) / n));
    if (c < 0 || r < 0 || c >= GRID_W || r >= GRID_H || !navigable(r * GRID_W + c, maxBed)) return (k - 1) / n;
  }
  return 1;
}

/** The point nearest (bx, bz) on the straight line from (ax, az) that navigable water reaches without a break. */
export function waterToward(ax: number, az: number, bx: number, bz: number, maxBed: number): { x: number; z: number } {
  const f = waterAlong(ax, az, bx, bz, maxBed);
  return { x: ax + (bx - ax) * f, z: az + (bz - az) * f };
}

/** How long a way is (m), from (ax, az) through `points`. */
export function routeLength(ax: number, az: number, points: readonly { x: number; z: number }[]): number {
  let length = 0;
  for (const p of points) {
    length += Math.hypot(p.x - ax, p.z - az);
    ax = p.x;
    az = p.z;
  }
  return length;
}

/**
 * A way over the water from (ax, az) to (bx, bz), as world points: from the navigable water nearest the start
 * to that nearest the end (null if none joins them), keeping to beds at most `maxBed` (m about MSL).
 */
export function waterRoute(ax: number, az: number, bx: number, bz: number, maxBed = -1): { x: number; z: number }[] | null {
  // each end from the nearest deep water (a landing's own cell may be a pocket of the flats the tide leaves),
  // or failing that the nearest water deep enough; the far end only from water joined to the near one, or a
  // deep pocket cut off by the flats at this tide would be chosen and no way found
  const end = (x: number, z: number, within?: Uint8Array) => {
    const deep = nearestNavigable(x, z, maxBed - 1.5, 40, within);
    return deep >= 0 ? deep : nearestNavigable(x, z, maxBed, 40, within);
  };
  const from = end(ax, az);
  if (from < 0) return null;
  const to = end(bx, bz, joinedTo(from, maxBed));
  if (to < 0) return null;
  const toC = to % GRID_W;
  const toR = Math.floor(to / GRID_W);
  const came = new Map<number, number>();
  const cost = new Map<number, number>([[from, 0]]);
  const open = new Heap();
  const h = (i: number) => Math.hypot((i % GRID_W) - toC, Math.floor(i / GRID_W) - toR);
  open.push(h(from), from);
  while (open.size) {
    const i = open.pop();
    if (i === to) break;
    const c = i % GRID_W;
    const r = Math.floor(i / GRID_W);
    const g = cost.get(i) as number;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= GRID_W || rr >= GRID_H) continue;
        const j = rr * GRID_W + cc;
        if (!navigable(j, maxBed)) continue;
        // a little dearer over the shallows, so the way keeps to the deeper water when it can
        const bed = LAYERS.terrain[j] / 10;
        const step = Math.hypot(dc, dr) * (1 + Math.max(0, bed - (maxBed - 3)) * 0.3);
        const ng = g + step;
        if (ng < (cost.get(j) ?? Infinity)) {
          cost.set(j, ng);
          came.set(j, i);
          open.push(ng + h(j), j);
        }
      }
    }
  }
  if (!came.has(to) && from !== to) return null;
  const cells: number[] = [to];
  for (let i = to; i !== from; ) {
    i = came.get(i) as number;
    cells.push(i);
  }
  cells.reverse();
  // pulled taut: from each kept point, on to the farthest cell still in a straight line over navigable water
  const points = cells.map((i) => cellCentre(i % GRID_W, Math.floor(i / GRID_W)));
  const clear = (a: { x: number; z: number }, b: { x: number; z: number }) => waterAlong(a.x, a.z, b.x, b.z, maxBed) === 1;
  const out = [points[0]];
  let k = 0;
  while (k < points.length - 1) {
    let next = k + 1;
    for (let m = points.length - 1; m > k + 1; m--) {
      if (clear(points[k], points[m])) {
        next = m;
        break;
      }
    }
    out.push(points[next]);
    k = next;
  }
  return out;
}
