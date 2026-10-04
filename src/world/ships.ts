import { BoxGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3, Vector4 } from 'three';
import { G } from '../core/globals';
import { Rng } from '../core/rng';
import { place } from '../geo/data';
import { MeshBuilder, rgb, scaleRgb, slab, strut, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { claddingTexture } from '../render/textures';
import { BEACON, Beacons, type Beacon } from './beacons';
import { PLANT } from './plantSite';
import { BERTHS, CHANNEL, ENTRANCE, TURN, berthPoint } from './portSite';
import { shipWakeHeight } from './wake';
import { hullWaves, type HullWaves } from './waves';

// The big ships of Matarbari (GEOGRAPHY_PLAN.md §8.6), at their real size:
// - a container ship (8,000 TEU class: 300 × 48 m, draught 14.5 m) that comes in from the anchorage along the
//   channel, is pushed alongside the container berth by two tugs, lies there working cargo, is pulled off and
//   goes out astern to beyond the entrance, turns there and sails; then, a while later, the next one is lying
//   at the anchorage (world/portSite.ts: no 500 m turning basin fits the 1:3 harbour);
// - a Kamsarmax bulk carrier (230 × 32 m) alongside the plant's coal berth under its unloaders, a general
//   cargo ship at the multipurpose berth, two ships waiting at anchor off the channel's sea end, swinging with
//   the tide, and the Summit FSRU (Sentinel-2 2026-02-26) moored off the island, weathervaning in the wind;
// - the two harbour tugs.
// They ride the shared waves (hullWaves: a big hull hardly moves), throw their own bow waves and Kelvin wakes
// on the water (wake.ts; the three nearest moving hulls), and show their navigation and deck lights at night.
// Speeds are real (a few knots in the channel); sizes from the design ships; liveries, the timetable and the
// anchorage are [মডেল]. Nothing here casts a shadow: they move, and the shadow map is not redrawn every frame.

type Kind = 'container' | 'bulk' | 'cargo' | 'tanker' | 'lng' | 'tug';

interface Spec {
  length: number;
  beam: number;
  /** Keel to deck (m), and how deep she floats now. */
  depth: number;
  draught: number;
  hull: RGB;
  deck: RGB;
  /** The deckhouse: its middle (m from midships, + toward the bow), its length, decks. */
  house: { at: number; length: number; decks: number; width: number };
  funnel: RGB;
}

const SPECS: Record<Kind, Spec> = {
  container: { length: 300, beam: 48, depth: 24.6, draught: 13.5, hull: rgb('#1d2c47'), deck: rgb('#5a5f58'), house: { at: -55, length: 16, decks: 8, width: 0.82 }, funnel: rgb('#d9dcdc') },
  bulk: { length: 229, beam: 32.3, depth: 20, draught: 12.5, hull: rgb('#232323'), deck: rgb('#7a3a2c'), house: { at: -100, length: 16, decks: 6, width: 0.9 }, funnel: rgb('#c4462d') },
  cargo: { length: 180, beam: 28, depth: 14.5, draught: 8.5, hull: rgb('#2d4a3a'), deck: rgb('#6b6b62'), house: { at: -76, length: 14, decks: 5, width: 0.9 }, funnel: rgb('#e0b52a') },
  tanker: { length: 250, beam: 44, depth: 21, draught: 9, hull: rgb('#7a2620'), deck: rgb('#6d7d5e'), house: { at: -108, length: 16, decks: 6, width: 0.85 }, funnel: rgb('#2d3b6b') },
  lng: { length: 294, beam: 46, depth: 26, draught: 11.5, hull: rgb('#3a4148'), deck: rgb('#8f9488'), house: { at: -125, length: 18, decks: 7, width: 0.85 }, funnel: rgb('#2a7fb8') },
  tug: { length: 32, beam: 12, depth: 5.6, draught: 4.6, hull: rgb('#b02b20'), deck: rgb('#5d5d58'), house: { at: 4, length: 9, decks: 2, width: 0.62 }, funnel: rgb('#e8e6de') },
};

const ANTIFOULING: RGB = rgb('#7d2b22');
const WHITE: RGB = rgb('#efefea');
const WINDOWS: RGB = rgb('#272c31');
const DARK: RGB = rgb('#3a3d40');
const CONTAINER_COLOURS = ['#1f5fa6', '#b52a20', '#d9b21f', '#1d7a3a', '#e66a1c', '#dcdcd8', '#5b6670', '#7a2f2a', '#2e3d6b', '#2d95c6'].map((c) => rgb(c));

// ---------- the hulls ----------

/** Half-beam at the deck and at the bottom along her (t from −1 at the stern to 1 at the stem), and where her keel lies. */
function lines(t: number, spec: Spec): { deck: number; bottom: number; keel: number; fullness: number } {
  const B = spec.beam / 2;
  const fine = spec.length < 60;
  const bowStart = fine ? 0.1 : 0.4;
  const sternStart = fine ? -0.5 : -0.62;
  let deck = B;
  if (t > bowStart) deck = B * Math.pow(Math.max(0, 1 - Math.pow((t - bowStart) / (1 - bowStart), 1.8)), 0.55);
  else if (t < sternStart) deck = B * (0.6 + 0.4 * (1 - Math.pow((sternStart - t) / (1 + sternStart), 2)));
  let bottom = B - Math.min(2.5, B * 0.15);
  if (t > bowStart - 0.2) bottom *= Math.max(0, 1 - (t - (bowStart - 0.2)) / (1 - bowStart + 0.1)) ** 1.2;
  else if (t < sternStart + 0.2) bottom *= Math.max(0, 1 - (sternStart + 0.2 - t) / 0.55) ** 1.5;
  // the bottom rises toward her stern (the run up to the transom) and a little at the forefoot
  const keel = t < -0.82 ? spec.draught * 0.55 * ((-0.82 - t) / 0.18) ** 1.5 : t > 0.96 ? spec.depth * 0.2 * ((t - 0.96) / 0.04) : 0;
  const fullness = t > bowStart || t < sternStart ? 1.4 : 3;
  return { deck, bottom, keel, fullness };
}

/** Her hull from keel to deck, the deck, the transom and a bulbous bow, in her frame (z toward the bow, y up from the keel). */
function buildHull(b: MeshBuilder, spec: Spec): void {
  const L = spec.length;
  const N = 40;
  const ROW = [0, 0.03, 0.1, 0.22, 0.4, 0.62, 0.82, 1];
  const grid: Vector3[][] = [];
  for (let i = 0; i <= N; i++) {
    // denser toward the ends, where the hull curves
    const u = i / N;
    const t = -1 + 2 * (0.5 - 0.5 * Math.cos(u * Math.PI));
    const l = lines(t, spec);
    const z = (t * L) / 2;
    const sheer = t > 0.6 ? ((t - 0.6) / 0.4) ** 2 * spec.depth * 0.12 : 0;
    const top = spec.depth + sheer;
    const ring: Vector3[] = [];
    // port side from the deck down to the keel, then starboard back up: local +x is port
    const side = (f: number, sign: number) => {
      const y = l.keel + (top - l.keel) * f;
      const w = l.bottom + (l.deck - l.bottom) * (1 - Math.pow(1 - f, l.fullness));
      return new Vector3(sign * w, y, z);
    };
    for (let j = ROW.length - 1; j >= 0; j--) ring.push(side(ROW[j], 1));
    for (let j = 1; j < ROW.length; j++) ring.push(side(ROW[j], -1));
    grid.push(ring);
  }
  const M = grid[0].length;
  const base = b.vertexCount;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j < M; j++) {
      const p = grid[i][j];
      const along = new Vector3().subVectors(grid[Math.min(N, i + 1)][j], grid[Math.max(0, i - 1)][j]);
      const around = new Vector3().subVectors(grid[i][Math.min(M - 1, j + 1)], grid[i][Math.max(0, j - 1)]);
      const n = new Vector3().crossVectors(along, around).normalize();
      // outward: away from her centre line
      if (n.x * p.x + n.y * (p.y - spec.depth * 0.5) < 0) n.negate();
      const wet = p.y < spec.draught + 0.3;
      const c = p.y < spec.draught - 0.6 ? ANTIFOULING : wet ? DARK : spec.hull;
      b.vertex(p, n, p.z / 3, p.y / 3, c);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M - 1; j++) {
      const a = base + i * M + j;
      const c = base + (i + 1) * M + j;
      b.quad(a, c, c + 1, a + 1);
    }
  }
  // the deck between her deck edges
  const up = new Vector3(0, 1, 0);
  const deck = b.vertexCount;
  for (let i = 0; i <= N; i++) {
    b.vertex(grid[i][0], up, 0, 0, spec.deck);
    b.vertex(grid[i][M - 1], up, 1, 0, spec.deck);
  }
  for (let i = 0; i < N; i++) {
    const a = deck + i * 2;
    b.quad(a, a + 1, a + 3, a + 2);
  }
  // the transom: a fan over her stern section
  const tr = b.vertexCount;
  const aft = new Vector3(0, 0, -1);
  const mid = new Vector3(0, (grid[0][0].y + grid[0][M >> 1].y) / 2, grid[0][0].z);
  b.vertex(mid, aft, 0, 0, spec.hull);
  for (let j = 0; j < M; j++) b.vertex(grid[0][j], aft, 0, 0, grid[0][j].y < spec.draught ? ANTIFOULING : spec.hull);
  for (let j = 0; j < M - 1; j++) b.tri(tr, tr + 2 + j, tr + 1 + j);
  // the bulbous bow, below the waterline at her forefoot
  if (L > 60) b.add(new SphereGeometry(1, 16, 10), new Matrix4().compose(new Vector3(0, spec.draught * 0.42, L / 2 - L * 0.025), new Quaternion(), new Vector3(spec.beam * 0.11, spec.draught * 0.32, L * 0.045)), ANTIFOULING);
}

/** The deckhouse: decks of white with their windows, the bridge with its wings across her beam, the funnel and the radar mast. */
function buildHouse(b: MeshBuilder, spec: Spec, rng: Rng): { mast: Vector3; bridge: number } {
  const h = spec.house;
  const deckH = spec.length < 60 ? 2.6 : 2.85;
  const W = spec.beam * h.width;
  const y0 = spec.depth;
  for (let k = 0; k < h.decks; k++) {
    const y = y0 + k * deckH + deckH / 2;
    const narrow = 1 - k * 0.012;
    slab(b, 0, y, h.at, W * narrow, deckH, h.length * narrow, 0, WHITE);
    slab(b, 0, y + 0.35, h.at, W * narrow + 0.08, 0.9, h.length * narrow + 0.08, 0, WINDOWS);
  }
  const top = y0 + h.decks * deckH;
  // the bridge's wings out to her sides, its windows facing forward
  slab(b, 0, top - deckH / 2, h.at + h.length * 0.3, spec.beam * (spec.length < 60 ? 0.7 : 1), 0.5, 3, 0, WHITE);
  slab(b, 0, top + 0.6, h.at, W * 0.8, 1.2, h.length * 0.6, 0, WHITE);
  // the funnel behind it, in the line's colours
  const fz = h.at - h.length * 0.5 - (spec.length < 60 ? 2 : 7);
  const fh = spec.length < 60 ? 4 : 12;
  slab(b, 0, top - deckH + fh / 2, fz, W * 0.32, fh, spec.length < 60 ? 2.2 : 9, 0, spec.funnel);
  slab(b, 0, top - deckH + fh - 1, fz, W * 0.33, 2, spec.length < 60 ? 2.3 : 9.2, 0, scaleRgb(spec.funnel, rng.next() < 0.5 ? 0.5 : 1.3));
  slab(b, 0, top - deckH + fh + 0.2, fz, W * 0.24, 0.5, spec.length < 60 ? 1.6 : 6, 0, DARK);
  // the radar mast on the wheelhouse top
  const mastTop = top + (spec.length < 60 ? 6 : 10);
  strut(b, 0, top + 1.2, h.at, 0, mastTop, h.at, spec.length < 60 ? 0.3 : 0.6, WHITE);
  slab(b, 0, mastTop - 2, h.at, spec.length < 60 ? 2.6 : 6, 0.3, 0.4, 0, DARK);
  return { mast: new Vector3(0, mastTop, h.at), bridge: top };
}

/** What she carries on deck, by kind. */
function buildCargo(b: MeshBuilder, kind: Kind, spec: Spec, rng: Rng): void {
  const L = spec.length;
  const y0 = spec.depth;
  const houseFront = spec.house.at + spec.house.length / 2;
  const houseBack = spec.house.at - spec.house.length / 2;
  if (kind === 'container') {
    // 40-foot boxes in bays from her forecastle aft past the deckhouse, on their hatch covers
    const rows = Math.floor((spec.beam - 3) / 2.5);
    const box = new BoxGeometry(2.44, 2.59, 12.19);
    for (let z = L / 2 - 28; z > -L / 2 + 30; z -= 12.8) {
      if (z < houseFront + 7 && z > houseBack - 18) continue;
      const half = lines((z / L) * 2, spec).deck - 1.5;
      const hump = 1 - Math.abs(z / (L / 2)) * 0.6;
      for (let r = 0; r < rows; r++) {
        const x = (r - (rows - 1) / 2) * 2.5;
        if (Math.abs(x) > half) continue;
        const tiers = Math.max(1, Math.round(rng.range(2, 4) + hump * 2.5 - (Math.abs(x) > half - 3 ? 1.5 : 0)));
        for (let k = 0; k < tiers; k++) b.add(box, new Matrix4().makeTranslation(x, y0 + 1.6 + 1.3 + k * 2.6, z), rng.pick(CONTAINER_COLOURS));
      }
    }
  } else if (kind === 'bulk' || kind === 'cargo') {
    const n = kind === 'bulk' ? 7 : 4;
    const span = houseFront + 8;
    const len = (L / 2 - 20 - span) / n;
    for (let k = 0; k < n; k++) {
      const z = span + (k + 0.5) * len;
      slab(b, 0, y0 + 1, z, spec.beam * 0.62, 2, len * 0.72, 0, kind === 'bulk' ? rgb('#5f6b4e') : rgb('#3f5f78'));
    }
    if (kind === 'cargo') {
      // her own cranes between the hatches
      for (let k = 1; k < n; k += 2) {
        const z = span + k * len;
        strut(b, 0, y0, z, 0, y0 + 9, z, 1.6, rgb('#d8b62a'));
        strut(b, 0, y0 + 8, z, 6, y0 + 22, z + 10, 0.8, rgb('#d8b62a'));
      }
    }
  } else if (kind === 'tanker' || kind === 'lng') {
    // the trunk deck (on the LNG carrier) or the pipe rack and catwalk down her middle, the manifold amidships
    if (kind === 'lng') slab(b, 0, y0 + 1.8, (L / 2 - 20 + houseFront + 5) / 2, spec.beam * 0.72, 3.6, L / 2 - 25 - houseFront, 0, rgb('#c7c9c4'));
    strut(b, 0, y0 + (kind === 'lng' ? 4.2 : 1.5), L / 2 - 20, 0, y0 + (kind === 'lng' ? 4.2 : 1.5), houseFront + 4, 1.2, rgb('#9aa29a'));
    slab(b, 0, y0 + 2.5, 0, spec.beam * 0.9, 1.6, 4, 0, rgb('#8c7a4c'));
    if (kind === 'lng') {
      // the regasification plant forward
      for (let k = 0; k < 4; k++) slab(b, (k % 2 ? -1 : 1) * 8, y0 + 7, L / 2 - 45 - k * 9, 12, 8, 7, 0, rgb('#cfd2cc'));
      strut(b, 0, y0 + 4, L / 2 - 30, 0, y0 + 28, L / 2 - 30, 1, rgb('#9aa29a'));
    }
  } else {
    // a tug: the black rubber fender round her sheer, the towing winch aft, the push knees at her bow
    for (let z = -L / 2 + 2; z < L / 2 - 1; z += 2) {
      const w = lines((z / L) * 2, spec).deck;
      for (const sx of [-1, 1]) slab(b, sx * (w + 0.3), y0 - 0.4, z, 0.6, 0.9, 2.05, 0, DARK);
    }
    slab(b, 0, y0 + 0.8, -L / 2 + 7, 3, 1.6, 2.4, 0, rgb('#4f5a63'));
  }
  // the foremast on the forecastle
  strut(b, 0, y0, L / 2 - (L < 60 ? 6 : 14), 0, y0 + (L < 60 ? 7 : 16), L / 2 - (L < 60 ? 6 : 14), L < 60 ? 0.25 : 0.6, rgb('#d8d4c8'));
}

/** Her lights in her own frame: masthead (white), sidelights (red to port, green to starboard), stern, deck lights. */
function shipLights(spec: Spec, mast: Vector3, bridge: number): { p: Vector3; kind: Beacon['kind'] }[] {
  const L = spec.length;
  const fore = new Vector3(0, spec.depth + (L < 60 ? 7.4 : 16.5), L / 2 - (L < 60 ? 6 : 14));
  const out: { p: Vector3; kind: Beacon['kind'] }[] = [
    { p: fore, kind: BEACON.white },
    { p: mast.clone().setY(mast.y + 0.5), kind: BEACON.white },
    { p: new Vector3(spec.beam / 2 + 0.3, bridge - 1, spec.house.at + spec.house.length * 0.3), kind: BEACON.red },
    { p: new Vector3(-spec.beam / 2 - 0.3, bridge - 1, spec.house.at + spec.house.length * 0.3), kind: BEACON.green },
    { p: new Vector3(0, spec.depth + 3, -L / 2 + 1), kind: BEACON.white },
  ];
  if (L > 60) for (let z = -L / 2 + 30; z < L / 2 - 25; z += 50) out.push({ p: new Vector3((z % 100) > 0 ? 6 : -6, spec.depth + 6, z), kind: BEACON.sodium });
  return out;
}

// ---------- a ship ----------

const RIDE_TUG = { heave: [0.6, 0.35], pitch: [0.5, 0.3], roll: [0.4, 0.2] } as const;
const RIDE_SHIP = { heave: [0.12, 0.5], pitch: [0.1, 0.5], roll: [0.06, 0.25] } as const;

class Ship {
  readonly root = new Group();
  readonly kind: Kind;
  readonly spec: Spec;
  x: number;
  z: number;
  heading: number;
  /** Speed through the water along her heading (m/s): negative going astern. */
  speed = 0;
  /** Her lights in her own frame. */
  readonly lights: { p: Vector3; kind: Beacon['kind'] }[];
  private readonly ride = new Float32Array(6);
  private readonly waves: HullWaves = { heave: 0, along: 0, across: 0 };

  constructor(kind: Kind, mesh: Mesh, lights: { p: Vector3; kind: Beacon['kind'] }[], x: number, z: number, heading: number) {
    this.kind = kind;
    this.spec = SPECS[kind];
    this.lights = lights;
    this.root.add(mesh);
    this.x = x;
    this.z = z;
    this.heading = heading;
  }

  /** She floats on the shared waves where she lies; a big hull barely moves. */
  float(dt: number, t: number): void {
    const s = this.spec;
    const w = hullWaves(this.x, this.z, this.heading, s.length * 0.85, s.beam * 0.9, t, 1, this.waves);
    const r = this.ride;
    const h = Math.min(dt, 1 / 20);
    const tune = s.length < 60 ? RIDE_TUG : RIDE_SHIP;
    const follow = (i: number, target: number, [fr, zeta]: readonly [number, number]) => {
      const wn = fr * Math.PI * 2;
      r[i + 1] += (wn * wn * (target - r[i]) - 2 * zeta * wn * r[i + 1]) * h;
      r[i] += r[i + 1] * h;
    };
    follow(0, w.heave, tune.heave);
    follow(2, -w.along, tune.pitch);
    follow(4, w.across, tune.roll);
    this.root.position.set(this.x, G.uWaterLevel.value - s.draught + r[0], this.z);
    this.root.rotation.set(r[2], this.heading, r[4], 'YXZ');
  }
}

// ---------- the voyage of the container ship ----------

type Phase = 'anchored' | 'inbound' | 'berthing' | 'alongside' | 'unberthing' | 'astern' | 'turning' | 'outbound' | 'away';

/** Seconds each waiting phase lasts (real time, as everything that moves here). */
const LINGER: Partial<Record<Phase, number>> = { anchored: 900, alongside: 1800, away: 600 };
/** Seconds to come alongside or get off, and to turn round outside the entrance. */
const BERTHING = 360;
const TURNING = 300;

/** A path of points with its lengths. */
class Path {
  readonly lengths: number[] = [0];
  readonly points: { x: number; z: number }[];
  constructor(points: { x: number; z: number }[]) {
    this.points = points;
    for (let k = 1; k < points.length; k++) this.lengths.push(this.lengths[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z));
  }
  get length(): number {
    return this.lengths[this.lengths.length - 1];
  }
  /** The point `s` m along it and the way it runs there (a heading), smoothed over the corners. */
  at(s: number): { x: number; z: number; heading: number } {
    const p = this.raw(s);
    // the heading over the next and the last 60 m, so she rounds a corner rather than pivoting on it
    const a = this.raw(Math.max(0, s - 60));
    const b = this.raw(Math.min(this.length, s + 60));
    return { x: p.x, z: p.z, heading: Math.atan2(b.x - a.x, b.z - a.z) };
  }
  private raw(s: number): { x: number; z: number } {
    const L = this.lengths;
    let k = 1;
    while (k < L.length - 1 && L[k] < s) k++;
    const t = Math.max(0, Math.min(1, (s - L[k - 1]) / Math.max(1e-6, L[k] - L[k - 1])));
    const a = this.points[k - 1];
    const b = this.points[k];
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }
}

const angleTo = (from: number, to: number) => {
  let d = to - from;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  return d;
};

// ---------- the fleet ----------

/** The moving hulls whose waves the water and the floating things feel this frame: x, z, heading, speed; half-length, half-beam. */
const WAKES: { x: number; z: number; heading: number; speed: number; half: number; beam: number }[] = [];

/** The ships' own waves at (x, z) (m), for things that float (drift.ts). */
export function shipWaves(x: number, z: number): number {
  let h = 0;
  for (const w of WAKES) {
    const dx = x - w.x;
    const dz = z - w.z;
    if (Math.abs(dx) + Math.abs(dz) > 1800) continue;
    const c = Math.cos(w.heading);
    const s = Math.sin(w.heading);
    h += shipWakeHeight(dx * c - dz * s, dx * s + dz * c, w.speed, w.half, w.beam);
  }
  return h;
}

export class Ships {
  readonly group = new Group();
  /** For the water: the three nearest moving hulls (x, z, heading, speed) and their (half-length, half-beam). */
  readonly wakes = [new Vector4(), new Vector4(), new Vector4()];
  readonly wakeSizes = [new Vector4(), new Vector4(), new Vector4()];
  private readonly ships: Ship[] = [];
  private readonly lights: Beacons;
  private readonly lightIndex: number[] = [];
  private readonly container: Ship;
  private readonly tugs: Ship[] = [];
  private readonly tugHome: { x: number; z: number; heading: number }[];
  private readonly anchored: { ship: Ship; x: number; z: number }[] = [];
  private readonly fsru: Ship | null;
  private phase: Phase = 'inbound';
  private clock = 0;
  private s = 0;
  private readonly inbound: Path;
  private readonly astern: Path;
  private readonly outbound: Path;
  private readonly berthed: { x: number; z: number; heading: number };
  private readonly anchorage: { x: number; z: number };
  private readonly tmp = new Vector3();

  constructor() {
    this.group.name = 'ships';
    const rng = new Rng(907);
    const material = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 }), { grime: 0.25 });
    const boxes = patchMaterial(new MeshStandardMaterial({ map: claddingTexture(908), vertexColors: true, roughness: 0.6, metalness: 0.2 }), { grime: 0.2 });
    const make = (kind: Kind, x: number, z: number, heading: number) => {
      const spec = SPECS[kind];
      const b = new MeshBuilder();
      buildHull(b, spec);
      const house = buildHouse(b, spec, rng);
      const cargo = new MeshBuilder();
      buildCargo(kind === 'container' ? cargo : b, kind, spec, rng);
      const mesh = new Mesh(b.build(), material);
      mesh.receiveShadow = true;
      const ship = new Ship(kind, mesh, shipLights(spec, house.mast, house.bridge), x, z, heading);
      if (cargo.vertexCount) {
        const c = new Mesh(cargo.build(), boxes);
        c.receiveShadow = true;
        ship.root.add(c);
      }
      ship.root.name = `ship-${kind}`;
      this.group.add(ship.root);
      this.ships.push(ship);
      return ship;
    };

    // the channel's sea end, its line out to sea, and the anchorage off it
    const end = CHANNEL[CHANNEL.length - 1];
    const prev = CHANNEL[CHANNEL.length - 2];
    const ol = Math.hypot(end.x - prev.x, end.z - prev.z);
    const out = { x: (end.x - prev.x) / ol, z: (end.z - prev.z) / ol };
    const side = { x: out.z, z: -out.x };
    this.anchorage = { x: end.x - side.x * 650 - out.x * 200, z: end.z - side.z * 650 - out.z * 200 };

    // the container ship's ways: in from the anchorage to abeam her berth; off it astern to beyond the
    // entrance; out from there to the sea
    const spec = SPECS.container;
    const berthLength = Math.hypot(BERTHS.container.b.x - BERTHS.container.a.x, BERTHS.container.b.z - BERTHS.container.a.z);
    const alongside = berthPoint('container', berthLength / 2, -(spec.beam / 2 + 1));
    this.berthed = alongside;
    const abeam = berthPoint('container', berthLength / 2, -130);
    const channelIn = CHANNEL.slice(ENTRANCE).reverse();
    this.inbound = new Path([this.anchorage, ...channelIn, abeam]);
    this.astern = new Path([abeam, CHANNEL[ENTRANCE], TURN]);
    this.outbound = new Path([TURN, CHANNEL[ENTRANCE + 1], end, { x: end.x + out.x * 900, z: end.z + out.z * 900 }]);
    this.container = make('container', this.anchorage.x, this.anchorage.z, 0);
    // she is on her way in when the world opens, a little over a kilometre outside the entrance
    this.phase = 'inbound';
    this.s = Math.max(0, this.inbound.lengths[this.inbound.points.length - 2] - 1300);

    // the coal carrier under the unloaders, bow north, her side to the berth's face
    const berth = PLANT.berth;
    make('bulk', berth.x1 + SPECS.bulk.beam / 2 + 1.5, (PLANT.cranes[0]?.z ?? 6720) + 50, 0);
    // a general cargo ship at the multipurpose berth
    const mp = Math.hypot(BERTHS.multipurpose.b.x - BERTHS.multipurpose.a.x, BERTHS.multipurpose.b.z - BERTHS.multipurpose.a.z);
    const cargoAt = berthPoint('multipurpose', mp / 2, -(SPECS.cargo.beam / 2 + 1));
    make('cargo', cargoAt.x, cargoAt.z, cargoAt.heading);
    // two waiting at anchor, inshore of the channel's sea end
    for (const [o, a, kind] of [
      [500, 300, 'bulk'],
      [900, -400, 'tanker'],
    ] as const) {
      const x = end.x + side.x * o + out.x * a;
      const z = end.z + side.z * o + out.z * a;
      this.anchored.push({ ship: make(kind, x, z, 0), x, z });
    }
    // the FSRU where Sentinel-2 saw her
    const fsru = place('summit-fsru').world;
    this.fsru = make('lng', fsru.x, fsru.z, 0);
    // the tugs, at their station in the inner channel
    this.tugHome = [
      { x: 3560, z: 6772, heading: -Math.PI / 2 },
      { x: 3610, z: 6772, heading: -Math.PI / 2 },
    ];
    for (const h of this.tugHome) this.tugs.push(make('tug', h.x, h.z, h.heading));

    const all: Beacon[] = [];
    for (const ship of this.ships) {
      for (const l of ship.lights) {
        this.lightIndex.push(all.length);
        all.push({ x: 0, y: 0, z: 0, kind: l.kind });
      }
    }
    this.lights = new Beacons(all);
    this.group.add(this.lights.points);
    this.settle();
  }

  setPixelRatio(pr: number): void {
    this.lights.setPixelRatio(pr);
  }

  /** Where the container ship is, for the debug readout. */
  get state(): { phase: Phase; x: number; z: number; heading: number; speed: number; along: number } {
    const c = this.container;
    return { phase: this.phase, x: Math.round(c.x), z: Math.round(c.z), heading: Math.round(c.heading * 100) / 100, speed: Math.round(c.speed * 10) / 10, along: Math.round(this.s) };
  }

  /** The container ship, for a camera to follow. */
  get focus(): { x: number; z: number; heading: number; length: number } {
    const c = this.container;
    return { x: c.x, z: c.z, heading: c.heading, length: c.spec.length };
  }

  /** For checking her round: put her at the start of `phase` (`along` m into it, or that share of a timed one). */
  jump(phase: Phase, along = 0): void {
    const order: Phase[] = ['anchored', 'inbound', 'berthing', 'alongside', 'unberthing', 'astern', 'turning', 'outbound', 'away'];
    if (!order.includes(phase)) return;
    this.phase = phase;
    this.clock = 0;
    this.s = 0;
    const c = this.container;
    if (phase === 'anchored') {
      c.x = this.anchorage.x;
      c.z = this.anchorage.z;
    }
    if (phase === 'inbound' || phase === 'astern' || phase === 'outbound') this.s = along;
    if (phase === 'berthing' || phase === 'unberthing') this.clock = BERTHING * Math.min(1, along);
    if (phase === 'turning') this.clock = TURNING * Math.min(1, along);
    c.speed = 0;
    // she takes up her pose for it at once
    this.voyage(0);
    if (phase === 'inbound') this.pose(this.inbound.at(this.s), 0, true);
    if (phase === 'astern') {
      const p = this.astern.at(this.s);
      this.pose({ x: p.x, z: p.z, heading: p.heading + Math.PI }, 0, true);
    }
    if (phase === 'outbound') this.pose(this.outbound.at(this.s), 0, true);
    this.settle();
  }

  /** Puts everything where it lies now without easing (stills, a fresh start). */
  settle(): void {
    this.update(0, 0, null, true);
  }

  update(dt: number, t: number, eye: Vector3 | null, settle = false): void {
    this.voyage(dt);
    this.assist(dt, settle);
    // the ships at anchor lie head to the tide, the FSRU head to the wind
    const flow = G.uFlowScale.value;
    for (const a of this.anchored) {
      const end = CHANNEL[CHANNEL.length - 1];
      const prev = CHANNEL[CHANNEL.length - 2];
      const seaward = Math.atan2(end.x - prev.x, end.z - prev.z);
      const want = flow >= 0 ? seaward + Math.PI : seaward;
      a.ship.heading += settle ? angleTo(a.ship.heading, want) : Math.max(-0.002 * dt, Math.min(0.002 * dt, angleTo(a.ship.heading, want)));
    }
    if (this.fsru) {
      const w = G.uWind.value;
      const want = Math.atan2(-w.x, -w.y);
      this.fsru.heading += settle ? angleTo(this.fsru.heading, want) : Math.max(-0.001 * dt, Math.min(0.001 * dt, angleTo(this.fsru.heading, want)));
    }
    for (const ship of this.ships) ship.float(settle ? 1 / 20 : dt, t);
    this.wakesFor(eye);
    // the lights follow their hulls
    let k = 0;
    for (const ship of this.ships) {
      ship.root.updateMatrixWorld();
      for (const l of ship.lights) {
        this.tmp.copy(l.p).applyMatrix4(ship.root.matrixWorld);
        this.lights.move(this.lightIndex[k++], this.tmp.x, this.tmp.y, this.tmp.z);
      }
    }
    this.lights.commit();
  }

  /** The container ship's round: in, alongside, off, out astern, round, away, and the next one at anchor. */
  private voyage(dt: number): void {
    const c = this.container;
    this.clock += dt;
    const linger = LINGER[this.phase];
    if (linger !== undefined && this.clock >= linger) this.next();
    switch (this.phase) {
      case 'anchored': {
        c.speed = 0;
        break;
      }
      case 'inbound': {
        const left = this.inbound.length - this.s;
        // full ahead to the channel, slow ahead inside the breakwaters, dead slow coming up to her berth
        const want = Math.min(4, Math.max(0.4, left / 260));
        c.speed += (want - c.speed) * Math.min(1, dt * 0.05);
        this.s += c.speed * dt;
        this.pose(this.inbound.at(this.s), dt, false);
        if (left <= 2) this.next();
        break;
      }
      case 'berthing':
      case 'unberthing': {
        // pushed (or pulled) sideways by the tugs between abeam the berth and alongside it, turning to its line
        const k = Math.min(1, this.clock / BERTHING);
        const e = k * k * (3 - 2 * k);
        const from = this.phase === 'berthing' ? this.inbound.at(this.inbound.length) : this.berthed;
        const to = this.phase === 'berthing' ? this.berthed : this.inbound.at(this.inbound.length);
        c.x = from.x + (to.x - from.x) * e;
        c.z = from.z + (to.z - from.z) * e;
        c.heading = from.heading + angleTo(from.heading, to.heading) * e;
        c.speed = 0;
        if (k >= 1) this.next();
        break;
      }
      case 'alongside': {
        c.x = this.berthed.x;
        c.z = this.berthed.z;
        c.heading = this.berthed.heading;
        c.speed = 0;
        break;
      }
      case 'astern': {
        const left = this.astern.length - this.s;
        const want = -Math.min(1.4, Math.max(0.3, left / 200));
        c.speed += (want - c.speed) * Math.min(1, dt * 0.05);
        this.s -= c.speed * dt;
        // going astern she keeps her bow toward the harbour
        const p = this.astern.at(this.s);
        this.pose({ x: p.x, z: p.z, heading: p.heading + Math.PI }, dt, false);
        if (left <= 2) this.next();
        break;
      }
      case 'turning': {
        c.x = TURN.x;
        c.z = TURN.z;
        const k = Math.min(1, this.clock / TURNING);
        const from = this.astern.at(this.astern.length).heading + Math.PI;
        const to = this.outbound.at(0).heading;
        c.heading = from + angleTo(from, to) * (k * k * (3 - 2 * k));
        c.speed = 0;
        if (k >= 1) this.next();
        break;
      }
      case 'outbound': {
        const want = Math.min(4.5, 1 + this.s / 150);
        c.speed += (want - c.speed) * Math.min(1, dt * 0.05);
        this.s += c.speed * dt;
        this.pose(this.outbound.at(this.s), dt, false);
        if (this.s >= this.outbound.length) this.next();
        break;
      }
      case 'away':
        c.speed = 0;
        break;
    }
    c.root.visible = this.phase !== 'away';
  }

  /** On to the next phase of her round, from its start. */
  private next(): void {
    const order: Phase[] = ['anchored', 'inbound', 'berthing', 'alongside', 'unberthing', 'astern', 'turning', 'outbound', 'away'];
    this.phase = order[(order.indexOf(this.phase) + 1) % order.length];
    this.clock = 0;
    this.s = 0;
    const c = this.container;
    if (this.phase === 'anchored') {
      // the next ship, lying at the anchorage
      c.x = this.anchorage.x;
      c.z = this.anchorage.z;
      c.speed = 0;
    }
  }

  /** Steer her toward a point of her way: a big ship's heading changes slowly. */
  private pose(p: { x: number; z: number; heading: number }, dt: number, snap: boolean): void {
    const c = this.container;
    c.x = p.x;
    c.z = p.z;
    const turn = angleTo(c.heading, p.heading);
    c.heading += snap || dt === 0 ? turn : Math.max(-0.012 * dt, Math.min(0.012 * dt, turn));
  }

  /** The tugs: at their station, or pushing the container ship while she berths, gets off, goes astern and turns. */
  private assist(dt: number, settle: boolean): void {
    const c = this.container;
    const near = this.phase === 'inbound' ? this.inbound.length - this.s < 700 : ['berthing', 'unberthing', 'astern', 'turning'].includes(this.phase);
    this.tugs.forEach((tug, i) => {
      let tx: number;
      let tz: number;
      let th: number;
      if (near) {
        // on her port side (away from the berth), one forward and one aft, their bows against her
        const along = (i === 0 ? 1 : -1) * (c.spec.length / 2 - 45);
        const off = c.spec.beam / 2 + tug.spec.length / 2 + 1;
        const fx = Math.sin(c.heading);
        const fz = Math.cos(c.heading);
        // her port side: +x of her frame, (cos h, −sin h) in the world
        tx = c.x + fx * along + Math.cos(c.heading) * off;
        tz = c.z + fz * along - Math.sin(c.heading) * off;
        th = c.heading - Math.PI / 2;
      } else {
        const h = this.tugHome[i];
        tx = h.x;
        tz = h.z;
        th = h.heading;
      }
      const dx = tx - tug.x;
      const dz = tz - tug.z;
      const d = Math.hypot(dx, dz);
      if (settle || dt === 0) {
        tug.x = tx;
        tug.z = tz;
        tug.heading = th;
        tug.speed = 0;
        return;
      }
      // under way to her place at up to 6 m/s, slowing as she nears it; then holding it, bow to the ship
      const want = Math.min(6, d * 0.12);
      tug.speed += (want - tug.speed) * Math.min(1, dt * 0.5);
      if (d > 1) {
        tug.x += (dx / d) * Math.min(d, tug.speed * dt);
        tug.z += (dz / d) * Math.min(d, tug.speed * dt);
      }
      const face = d > 25 ? Math.atan2(dx, dz) : th;
      tug.heading += Math.max(-0.25 * dt, Math.min(0.25 * dt, angleTo(tug.heading, face)));
    });
  }

  /** The three moving hulls nearest the eye make their waves on the water. */
  private wakesFor(eye: Vector3 | null): void {
    WAKES.length = 0;
    for (const ship of this.ships) {
      if (Math.abs(ship.speed) < 0.2 || !ship.root.visible) continue;
      // going astern, her waves spread ahead of her bow: her frame turned round
      const astern = ship.speed < 0;
      WAKES.push({ x: ship.x, z: ship.z, heading: ship.heading + (astern ? Math.PI : 0), speed: Math.abs(ship.speed), half: ship.spec.length * 0.42, beam: ship.spec.beam * 0.5 });
    }
    if (eye) WAKES.sort((a, b) => Math.hypot(a.x - eye.x, a.z - eye.z) - Math.hypot(b.x - eye.x, b.z - eye.z));
    WAKES.length = Math.min(WAKES.length, 3);
    for (let i = 0; i < 3; i++) {
      const w = WAKES[i];
      if (w) {
        this.wakes[i].set(w.x, w.z, w.heading, w.speed);
        this.wakeSizes[i].set(w.half, w.beam, 0, 0);
      } else {
        this.wakes[i].set(0, 0, 0, 0);
        this.wakeSizes[i].set(0, 0, 0, 0);
      }
    }
  }
}

