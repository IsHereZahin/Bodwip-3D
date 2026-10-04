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

/** The cell nearest (x, z) that is navigable, looked for out to `reach` cells; −1 if none. */
function nearestNavigable(x: number, z: number, maxBed: number, reach = 40): number {
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
      if (d < bestD && navigable(r * GRID_W + c, maxBed)) {
        bestD = d;
        best = r * GRID_W + c;
      }
    }
  }
  return best;
}

/**
 * A way over the water from (ax, az) to (bx, bz), as world points: from the navigable water nearest the start
 * to that nearest the end (null if none joins them), keeping to beds at most `maxBed` (m about MSL).
 */
export function waterRoute(ax: number, az: number, bx: number, bz: number, maxBed = -1): { x: number; z: number }[] | null {
  // each end from the nearest deep water (a landing's own cell may be a pocket of the flats the tide leaves),
  // or failing that the nearest water deep enough
  const end = (x: number, z: number) => {
    const deep = nearestNavigable(x, z, maxBed - 1.5);
    return deep >= 0 ? deep : nearestNavigable(x, z, maxBed);
  };
  const from = end(ax, az);
  const to = end(bx, bz);
  if (from < 0 || to < 0) return null;
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
  const clear = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 5);
    for (let k = 1; k < n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n;
      const z = a.z + ((b.z - a.z) * k) / n;
      const c = Math.round(fcol(x));
      const r = Math.round(frow(z));
      if (c < 0 || r < 0 || c >= GRID_W || r >= GRID_H || !navigable(r * GRID_W + c, maxBed)) return false;
    }
    return true;
  };
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
