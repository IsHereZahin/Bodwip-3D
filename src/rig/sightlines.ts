import type { Vector3 } from 'three';
import { smoothstep } from '../core/mathx';
import { BRIDGE, bridgeDeck, bridgeFrame, bridgeSoffit, grandGhat, inlandWaterAt, landUse, onRoad, terrainHeight, waterwayAt } from '../world/geography';
import type { Crown, Stem } from '../world/vegetation';
import type { HutPlan } from '../world/village';

// What stands between the eye and what it would see, for the camera that composes its own views (compose.ts) and
// for finding where along her way each sight is seen (showcase.ts): the ground (the hills, the banks, the levee),
// the trees' crowns, the houses and the old bridge, whose arch is open. It is asked thousands of times a second,
// so the ground and what covers it are kept on lattices as they are asked, and the crowns and the houses in a
// spatial hash.
//
// The landmarks' own buildings are not in it (but for the grand ghat): where the camera may stand over land is kept
// to open fields, or high over everything (`standsClear`).

/** Something standing on the ground, taken as a column up to its top: a tree's crown, a house. */
interface Mass {
  x: number;
  z: number;
  /** Its reach round its middle (m), its top over its middle, and how much lower its top is at its edge. */
  r: number;
  top: number;
  dome: number;
}

/** What a level look meets (`Sightlines.look`). */
export interface LookAlong {
  /** How far it goes before something stands in it (m). */
  depth: number;
  /** The share of the way there that is water, and open field. */
  water: number;
  field: number;
  /** What ends it (0..1): a hill or a line of trees some way off, not something close in front of the lens. */
  backdrop: number;
}

/** The spatial hash's cell (m), the lattice the ground is kept on and the coarser one for its cover (m): fine enough for what hides what. */
const CELL = 12;
const LATTICE = 2;
const COVER = 4;
/** The lattices' points kept before they are cleared (their memory stays small; the camera's ground refills at once). */
const MEMO = 250_000;
/** The grand ghat's pavilions over its bank (m). */
const PAVILION = 3.6;
/** A house's roof over its floor (m), and how much lower it is at its eaves. */
const ROOF = 4.6;
const EAVES = 1.8;
/** Over land that is not open field the camera stands this high over the ground at least (m): over the groves, whatever is not in the hash (the bushes, the bananas). */
const OVER_GROVES = 19;
/** And this far over the tops of what stands within `NEAR` m of it (m). */
const OVER_TOPS = 4;
const NEAR = 9;
/** How far out a look is told apart: water, field (m). */
const TOLD = 220;

const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
const WATER = 1;
const FIELD = 2;

/** Whether (x, z) is open field: no mound, grove, yard, way or bank on it. */
function openField(x: number, z: number): boolean {
  const u = landUse(x, z);
  return u.field > 0.75 && u.mound < 0.05;
}

export class Sightlines {
  private readonly cells = new Map<number, Mass[]>();
  private readonly ground = new Map<number, number>();
  /** What covers the ground on the coarser lattice: `WATER`, `FIELD` or 0. */
  private readonly cover = new Map<number, number>();

  constructor(crowns: readonly Crown[], stems: readonly Stem[], huts: readonly HutPlan[]) {
    // (a crown is a squashed sphere: its top stands about three-quarters of its reach over its middle)
    for (const c of crowns) this.add({ x: c.x, z: c.z, r: c.r * 0.92, top: c.y + c.r * 0.72, dome: c.r * 0.45 });
    // a palm or a bamboo clump as a column up to its fronds (its trunk is thin, but a camera among its fronds or with it across the lens is not wanted)
    for (const s of stems) this.add({ x: s.x, z: s.z, r: s.r * 0.85, top: s.top, dome: 2 });
    for (const h of huts) this.add({ x: h.x, z: h.z, r: Math.hypot(h.l, h.w) / 2, top: h.y + ROOF, dome: EAVES });
    // the zamindar's grand ghat: its walls and pavilions stand over the bank
    const gg = grandGhat();
    if (gg) this.add({ x: gg.round.x, z: gg.round.z, r: gg.round.r, top: terrainHeight(gg.site.x, gg.site.z) + PAVILION, dome: 1 });
  }

  private add(m: Mass): void {
    const i0 = Math.floor((m.x - m.r) / CELL);
    const i1 = Math.floor((m.x + m.r) / CELL);
    const j0 = Math.floor((m.z - m.r) / CELL);
    const j1 = Math.floor((m.z + m.r) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(m);
      }
    }
  }

  /** The ground's height near (x, z), from the lattice. */
  groundAt(x: number, z: number): number {
    const i = Math.round(x / LATTICE);
    const j = Math.round(z / LATTICE);
    const k = key(i, j);
    let h = this.ground.get(k);
    if (h === undefined) {
      if (this.ground.size > MEMO) this.ground.clear();
      h = terrainHeight(i * LATTICE, j * LATTICE);
      this.ground.set(k, h);
    }
    return h;
  }

  /** What covers the ground near (x, z): water (the river, a khal, the bil, a pond, a salt farm's pans), open field, or something else. */
  private coverAt(x: number, z: number): number {
    const i = Math.round(x / COVER);
    const j = Math.round(z / COVER);
    const k = key(i, j);
    let c = this.cover.get(k);
    if (c === undefined) {
      if (this.cover.size > MEMO) this.cover.clear();
      const cx = i * COVER;
      const cz = j * COVER;
      c = inlandWaterAt(cx, cz) ? WATER : openField(cx, cz) ? FIELD : 0;
      this.cover.set(k, c);
    }
    return c;
  }

  /** How high what stands at (x, z) reaches: the ground, or a crown or a roof over it. */
  top(x: number, z: number): number {
    let h = this.groundAt(x, z);
    const list = this.cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (list) {
      for (const m of list) {
        const d2 = ((x - m.x) ** 2 + (z - m.z) ** 2) / (m.r * m.r);
        if (d2 < 1) h = Math.max(h, m.top - m.dome * d2);
      }
    }
    return h;
  }

  /**
   * How far (m) the point (x, y, z) is over what stands there (negative: inside it). The old bridge stands from the
   * water to its parapets' tops, its arch open under its soffit.
   */
  gap(x: number, y: number, z: number): number {
    let g = y - this.top(x, z);
    const f = bridgeFrame(x, z);
    if (Math.abs(f.x) < BRIDGE.half && Math.abs(f.z) < BRIDGE.width / 2 + BRIDGE.parapet) {
      const over = y - (BRIDGE.water + bridgeDeck(f.x) + BRIDGE.parapetHeight);
      const under = BRIDGE.water + bridgeSoffit(f.x) - 0.3 - y;
      g = Math.min(g, Math.max(over, under));
    }
    return g;
  }

  /**
   * How clearly (0..1) `to` is seen from `from`: the least gap along the line between them, softened. The last
   * `spare` m before `to` are its own ground (a landmark's mound, a banyan's own crown) and are not counted.
   */
  sees(from: Vector3, to: Vector3, spare = 0): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    const end = (d - spare) / d;
    // (from 1.5 m out: whatever the camera stands just over is not in its view)
    const start = 1.5 / d;
    if (end <= start) return 1;
    const n = Math.max(4, Math.min(40, Math.ceil((d * (end - start)) / 5)));
    let least = Infinity;
    for (let i = 0; i < n && least > -1.5; i++) {
      const t = start + ((i + 0.5) / n) * (end - start);
      least = Math.min(least, this.gap(from.x + dx * t, from.y + dy * t, from.z + dz * t));
    }
    return smoothstep(-1.2, 0.6, least);
  }

  /** What a level look from `from` along `heading` meets, out to `far` m (into `out`). */
  look(from: Vector3, heading: number, far: number, out: LookAlong): LookAlong {
    const sx = Math.sin(heading);
    const sz = Math.cos(heading);
    let water = 0;
    let field = 0;
    let n = 0;
    out.depth = far;
    out.backdrop = 0;
    // out in steps that lengthen with the distance, as the eye makes out less of what is far
    for (let d = 4; d < far; d *= 1.28) {
      const x = from.x + sx * d;
      const z = from.z + sz * d;
      if (this.gap(x, from.y, z) < 0) {
        out.depth = d;
        // a hill (the ground itself over the eye) or a grove's crowns, some way off: the frame's back
        if (this.groundAt(x, z) > from.y) out.backdrop = smoothstep(25, 70, d);
        else out.backdrop = 0.6 * smoothstep(30, 70, d) * (1 - smoothstep(260, 420, d));
        break;
      }
      if (d < TOLD) {
        n++;
        const c = this.coverAt(x, z);
        if (c === WATER) water++;
        else if (c === FIELD && d > 24) field++;
      }
    }
    out.water = n ? water / n : 0;
    out.field = n ? field / n : 0;
    return out;
  }

  /**
   * How close in front of the lens a look from `from` along `heading`, `pitch` (down negative) meets a crown or a
   * roof before it meets the ground (0: nothing within `reach` m; 1: right at the lens).
   */
  clutter(from: Vector3, heading: number, pitch: number, reach: number): number {
    const c = Math.cos(pitch);
    const dx = Math.sin(heading) * c;
    const dy = Math.sin(pitch);
    const dz = Math.cos(heading) * c;
    for (let t = 2; t < reach; t += 1.5) {
      const x = from.x + dx * t;
      const y = from.y + dy * t;
      const z = from.z + dz * t;
      if (y < this.groundAt(x, z)) return 0;
      if (y < this.top(x, z)) return 1 - smoothstep(reach * 0.35, reach, t);
    }
    return 0;
  }

  /** Whether (x, z) is over the water, or close over a waterway's bank. */
  overWater(x: number, z: number): boolean {
    const w = waterwayAt(x, z);
    return inlandWaterAt(x, z) || (w !== null && w.d < w.half + 1.5);
  }

  /**
   * Whether the camera may stand at (x, y, z): over the water (clear of the crowns leaning out over it), low over
   * open field clear of everything, or elsewhere high over the groves.
   */
  standsClear(x: number, y: number, z: number): boolean {
    if (this.overWater(x, z)) return this.gap(x, y, z) > 1.8;
    const ground = this.groundAt(x, z);
    let tops = this.top(x, z);
    for (let a = 0; a < 6; a++) tops = Math.max(tops, this.top(x + Math.sin(a * 1.047) * NEAR, z + Math.cos(a * 1.047) * NEAR));
    if (tops < ground + 0.6 && openField(x, z) && !onRoad(x, z, 8)) return y > ground + 1.8;
    return y > Math.max(ground + OVER_GROVES, tops + OVER_TOPS);
  }
}
