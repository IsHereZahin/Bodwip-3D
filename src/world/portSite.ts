import { smoothstep } from '../core/mathx';
import { LINES, place } from '../geo/data';
import { plain } from '../geo/project';

// Matarbari deep-sea port's plan and the ground it leaves (GEOGRAPHY_PLAN.md §8.6), apart from its meshes
// (world/port.ts) and its ships (world/ships.ts) so the ground, the roads and the planting can ask about it.
//
// What is there: the navigation channel (14.3 km, 350 m wide, dredged to CDL −16 m ≈ MSL −18 m: MSL = CDL +
// 2.13 m), the two breakwaters (OSM) and the coal berth's basin; D5 shows the port finished, so also the
// container berth (460 m) and the multipurpose berth (300 m) and the yard behind them.
//
// How it fits the 1:3 map: the breakwaters and the harbour's shores stand at their 1:3 places (the bake takes
// the reclaimed land and the dredged water from Sentinel-2, bake.mjs PORT_ZONE), so inside the harbour the
// channel takes the width the harbour leaves it; outside, at sea, it is its real 350 m. Its length is 1:3: from
// the entrance it runs out along the north breakwater's line (OSM has no sea end; the published length sets
// it). The berths lie along the harbour's shores, as long as the shores allow (the container berth holds one
// 300 m ship, the multipurpose berth one of 200 m: published 460 m and 300 m) [মডেল: the terminal's layout is
// not published]. A 500 m turning basin will not fit inside the 1:3 harbour, so ships turn outside the entrance and
// leave the berths astern with their tugs, as ships do in tight ports.

/** The dredged depth (m about MSL): CDL −16 m. */
export const DREDGED = -18.1;
/** The coal basin's depth (m), for ships of 14.5 m draught. */
const BASIN = -16.5;
/** The terminal's deck and yard (m about MSL): the quays' top. */
export const QUAY = 6;
/** How far the dredged bed's sides run out per metre of cut (m): its slopes. */
const SIDE = 5;

export interface ChannelPoint {
  x: number;
  z: number;
  /** Half its width there (m). */
  half: number;
}

/** The channel's middle inside the harbour, from the coal basin to the entrance [মডেল] (laid out on the plain 1:3 map). */
const INSIDE: readonly ChannelPoint[] = [
  { ...plain(3356, 6790), half: 45 },
  { ...plain(3500, 6728), half: 58 },
  { ...plain(3700, 6720), half: 62 },
  { ...plain(3870, 6610), half: 80 },
  { ...plain(4005, 6450), half: 85 },
];
/** Where in CHANNEL the entrance (between the breakwaters' heads) is; the points after it lie out at sea. */
export const ENTRANCE = INSIDE.length;

/** The channel's middle from the coal basin out to sea, with its half-width at each point. */
export const CHANNEL: readonly ChannelPoint[] = (() => {
  // the entrance: midway between the breakwaters' heads (OSM); the line out to sea: the north breakwater's
  const heads = breakwaterHeads();
  const entrance = { x: (heads.north.x + heads.south.x) / 2, z: (heads.north.z + heads.south.z) / 2 };
  const out = heads.axis;
  const at = (d: number) => ({ x: entrance.x + out.x * d, z: entrance.z + out.z * d });
  // 14.3 km on the ground is 4.77 km on the map; less the ≈0.9 km inside the harbour
  const seaward = 14300 / 3 - 900;
  // inside, between the north breakwater and the berths' pockets, it takes the room the 1:3 harbour leaves
  return [
    ...INSIDE,
    { ...entrance, half: 80 },
    { ...at(300), half: 175 },
    { ...at(seaward), half: 175 },
  ];
})();

/**
 * The breakwaters' heads (their seaward ends) and the north one's line out to sea (a unit vector). OSM draws
 * each breakwater as a closed outline a few metres wide: its head is its point farthest west (+x), and its line
 * the mean way from the outline's points on its straight run (80–650 m back) to the head.
 */
function breakwaterHeads(): { north: { x: number; z: number }; south: { x: number; z: number }; axis: { x: number; z: number } } {
  const port = place('matarbari-port').world;
  const lines = LINES.filter((l) => l.k === 'structure' && l.t === 'breakwater' && Math.hypot(l.points[0] - port.x, l.points[1] - port.z) < 2500);
  if (lines.length < 2) throw new Error("geo/vectors.bin: the port's breakwaters are missing");
  // the longer is the north breakwater
  const len = (p: Float32Array) => {
    let s = 0;
    for (let k = 2; k < p.length; k += 2) s += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
    return s;
  };
  lines.sort((a, b) => len(b.points) - len(a.points));
  const head = (p: Float32Array) => {
    let best = 0;
    for (let k = 0; k < p.length; k += 2) if (p[k] > p[best]) best = k;
    return { x: p[best], z: p[best + 1] };
  };
  const n = head(lines[0].points);
  const s = head(lines[1].points);
  const p = lines[0].points;
  let ax = 0;
  let az = 0;
  for (let k = 0; k < p.length; k += 2) {
    const d = Math.hypot(n.x - p[k], n.z - p[k + 1]);
    if (d < 80 || d > 650) continue;
    ax += (n.x - p[k]) / d;
    az += (n.z - p[k + 1]) / d;
  }
  const l = Math.hypot(ax, az) || 1;
  return { north: n, south: s, axis: { x: ax / l, z: az / l } };
}

/**
 * A breakwater's middle line from its root to its head, from OSM's closed outline: the outline's two sides
 * from the head (its point farthest west) to the root (its point farthest from the head), each cut into
 * `n` equal lengths and averaged pair by pair. World x, z pairs.
 */
export function breakwaterLine(outline: Float32Array, n = 48): Float32Array {
  const pts: { x: number; z: number }[] = [];
  for (let k = 0; k < outline.length; k += 2) {
    const p = { x: outline[k], z: outline[k + 1] };
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.01) pts.push(p);
  }
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 0.01) pts.pop();
  const m = pts.length;
  let h = 0;
  for (let i = 1; i < m; i++) if (pts[i].x > pts[h].x) h = i;
  let r = 0;
  for (let i = 1; i < m; i++) if (Math.hypot(pts[i].x - pts[h].x, pts[i].z - pts[h].z) > Math.hypot(pts[r].x - pts[h].x, pts[r].z - pts[h].z)) r = i;
  const side = (step: 1 | -1) => {
    const out = [pts[h]];
    for (let i = h; i !== r; ) {
      i = (i + step + m) % m;
      out.push(pts[i]);
    }
    return out;
  };
  const resample = (path: { x: number; z: number }[]) => {
    const L = [0];
    for (let i = 1; i < path.length; i++) L.push(L[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
    const total = L[L.length - 1] || 1;
    const out: { x: number; z: number }[] = [];
    let k = 1;
    for (let j = 0; j <= n; j++) {
      const s = (total * j) / n;
      while (k < path.length - 1 && L[k] < s) k++;
      const t = Math.max(0, Math.min(1, (s - L[k - 1]) / Math.max(1e-6, L[k] - L[k - 1])));
      out.push({ x: path[k - 1].x + (path[k].x - path[k - 1].x) * t, z: path[k - 1].z + (path[k].z - path[k - 1].z) * t });
    }
    return out;
  };
  const a = resample(side(1));
  const b = resample(side(-1));
  const line = new Float32Array((n + 1) * 2);
  // root first, head last
  for (let j = 0; j <= n; j++) {
    line[(n - j) * 2] = (a[j].x + b[j].x) / 2;
    line[(n - j) * 2 + 1] = (a[j].z + b[j].z) / 2;
  }
  return line;
}

/** The berths: each quay's face from `a` to `b` (the water on its left looking from a to b), its length. */
export const BERTHS = {
  /** The container berth off the spit's harbour shore (its face just seaward of the shore all along), facing west. */
  container: { a: plain(3956, 6209), b: plain(3890, 6534), depth: DREDGED },
  /** The multipurpose berth along the inner channel's south bank, facing north. */
  multipurpose: { a: plain(3640, 6663), b: plain(3420, 6663), depth: -16.5 },
} as const;
/** How far out from a berth's face its pocket is dredged (m): a ship's beam and a little. */
const POCKET = 50;

/** The coal basin by the plant's berth (dredged for its ships). */
const COAL_BASIN = { x0: 3300, x1: 3412, z0: 6650, z1: 6925 };

/** Where the ships turn, a little outside the entrance, and the anchorage at the channel's sea end. */
export const TURN = (() => {
  const e = CHANNEL[ENTRANCE];
  const s = CHANNEL[ENTRANCE + 1];
  const dx = s.x - e.x;
  const dz = s.z - e.z;
  const l = Math.hypot(dx, dz);
  return { x: e.x + (dx / l) * 700, z: e.z + (dz / l) * 700 };
})();

/** How far the terminal's raised ground reaches back from each face (m): the yard, and the strip behind the multipurpose berth. */
export const TERMINAL_DEPTH = { container: 165, multipurpose: 50 } as const;
const YARD_DEPTH = TERMINAL_DEPTH.container;
const STRIP_DEPTH = TERMINAL_DEPTH.multipurpose;

interface Quad {
  /** The face from a to b, and how far the ground behind it reaches (to the right looking from a to b). */
  a: { x: number; z: number };
  b: { x: number; z: number };
  depth: number;
}

const GROUNDS: readonly Quad[] = [
  { a: BERTHS.container.a, b: BERTHS.container.b, depth: YARD_DEPTH },
  { a: BERTHS.multipurpose.a, b: BERTHS.multipurpose.b, depth: STRIP_DEPTH },
];

/** (x, z) in a berth's frame: `t` along its face (0..length), `s` from the face toward its land (+) or water (−). */
function berthFrame(q: Quad, x: number, z: number): { t: number; s: number; length: number } {
  const dx = q.b.x - q.a.x;
  const dz = q.b.z - q.a.z;
  const length = Math.hypot(dx, dz);
  const ux = dx / length;
  const uz = dz / length;
  const px = x - q.a.x;
  const pz = z - q.a.z;
  // the land lies along (−uz, ux) from the face (x west, z north)
  return { t: px * ux + pz * uz, s: pz * ux - px * uz, length };
}

/** Distance from (x, z) to the channel's middle line, and its half-width there. */
function channelDistance(x: number, z: number): { d: number; half: number } {
  let best = Infinity;
  let half = 0;
  for (let k = 1; k < CHANNEL.length; k++) {
    const a = CHANNEL[k - 1];
    const b = CHANNEL[k];
    const sx = b.x - a.x;
    const sz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * sx + (z - a.z) * sz) / (sx * sx + sz * sz)));
    const d = Math.hypot(x - a.x - sx * t, z - a.z - sz * t);
    if (d < best) {
      best = d;
      half = a.half + (b.half - a.half) * t;
    }
  }
  return { d: best, half };
}

/** The port's bounds (the channel's sea end included), to skip the rest of the map quickly. */
const BOUNDS = (() => {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of CHANNEL) {
    x0 = Math.min(x0, p.x - p.half - 120);
    x1 = Math.max(x1, p.x + p.half + 120);
    z0 = Math.min(z0, p.z - p.half - 120);
    z1 = Math.max(z1, p.z + p.half + 120);
  }
  return { x0, x1, z0, z1 };
})();

/**
 * The ground at (x, z) given the map's `h`: the channel, the basins and the berths' pockets dredged out of the
 * sea's bed (only below the water: the cut never eats into the land, save at a quay's face); the terminal's
 * yard and strip raised to the quays' level.
 */
export function portGround(x: number, z: number, h: number): number {
  if (x < BOUNDS.x0 || x > BOUNDS.x1 || z < BOUNDS.z0 || z > BOUNDS.z1) return h;
  // the terminal's ground, up to its quays' face (a vertical wall drawn by port.ts) and down to the land behind
  for (const q of GROUNDS) {
    const f = berthFrame(q, x, z);
    if (f.t < -1.5 || f.t > f.length + 1.5 || f.s < -2 || f.s > q.depth + 14) continue;
    // square at its ends (port.ts walls them), easing down to the land behind
    const along = smoothstep(-1.5, 0, f.t) * smoothstep(f.length + 1.5, f.length, f.t);
    const inland = smoothstep(q.depth + 14, q.depth, f.s);
    const k = along * inland * smoothstep(-2, 0, f.s);
    if (k > 0) return h + (Math.max(h, QUAY) - h) * k;
  }
  // dredged only out of the sea's bed, easing in across the shore so no cliff stands above the water there
  const wet = smoothstep(0.5, -1, h);
  if (wet <= 0) return h;
  let bed = h;
  const c = channelDistance(x, z);
  if (c.d < c.half + 60) bed = Math.min(bed, DREDGED + Math.max(0, c.d - c.half) / SIDE);
  // the berths' pockets off their faces
  for (const [q, depth] of [
    [GROUNDS[0], BERTHS.container.depth],
    [GROUNDS[1], BERTHS.multipurpose.depth],
  ] as const) {
    const f = berthFrame(q, x, z);
    if (f.t < 0 || f.t > f.length || f.s > 0) continue;
    bed = Math.min(bed, depth + Math.max(0, -f.s - POCKET) / SIDE);
  }
  if (x > COAL_BASIN.x0 - 40 && x < COAL_BASIN.x1 + 40 && z > COAL_BASIN.z0 - 40 && z < COAL_BASIN.z1 + 40) {
    const out = Math.max(COAL_BASIN.x0 - x, x - COAL_BASIN.x1, COAL_BASIN.z0 - z, z - COAL_BASIN.z1, 0);
    bed = Math.min(bed, BASIN + out / SIDE);
  }
  return h + (bed - h) * wet;
}

/** How the terminal covers (x, z): its paved yard and quays (0..1). */
export function portCover(x: number, z: number): number {
  if (x < BOUNDS.x0 || x > BOUNDS.x1 || z < BOUNDS.z0 || z > BOUNDS.z1) return 0;
  let paved = 0;
  for (const q of GROUNDS) {
    const f = berthFrame(q, x, z);
    paved = Math.max(paved, smoothstep(-4, 2, f.t) * smoothstep(f.length + 4, f.length - 2, f.t) * smoothstep(-1, 1, f.s) * smoothstep(q.depth + 6, q.depth, f.s));
  }
  return paved;
}

/** True on the terminal's ground or the harbour's dredged banks (and `margin` m round): no huts, trees or grass there. */
export function onPort(x: number, z: number, margin = 0): boolean {
  if (x < BOUNDS.x0 - margin || x > BOUNDS.x1 + margin || z < BOUNDS.z0 - margin || z > BOUNDS.z1 + margin) return false;
  for (const q of GROUNDS) {
    const f = berthFrame(q, x, z);
    if (f.t > -margin - 2 && f.t < f.length + margin + 2 && f.s > -margin - 2 && f.s < q.depth + 14 + margin) return true;
  }
  // the banks the channel is cut into inside the harbour, where its slopes come up to the land
  const c = channelDistance(x, z);
  return c.d < c.half + 30 + margin && z > CHANNEL[ENTRANCE].z;
}

/** A point of a berth's frame in the world: `t` along its face, `s` toward its land. */
export function berthPoint(name: keyof typeof BERTHS, t: number, s: number): { x: number; z: number; heading: number } {
  const q = BERTHS[name];
  const dx = q.b.x - q.a.x;
  const dz = q.b.z - q.a.z;
  const l = Math.hypot(dx, dz);
  const ux = dx / l;
  const uz = dz / l;
  return { x: q.a.x + ux * t - uz * s, z: q.a.z + uz * t + ux * s, heading: Math.atan2(ux, uz) };
}
