import { Vector3, type PerspectiveCamera } from 'three';
import { angleDelta, clamp, lerp, smoothstep } from '../core/mathx';
import type { SeasonState } from '../env/season';
import { BRIDGE, SANKO, bridgeFrame, corridorDistance, sankoFrame } from '../world/geography';
import { CORRIDOR } from '../render/glsl';
import type { LookAlong, Sightlines } from './sightlines';
import { ownReach, sightWorth, type Sight, type SightNow } from './showcase';

// The camera left to itself on the journey (the user's direction, 2026-10-07): it chooses where to stand and how
// to frame, as a cinematographer would, for the most beautiful view there is of where she is going: always from
// behind her or her quarter, looking on ahead past her (the user: never from in front looking back; only a rising
// or setting sun or moon turns it round, and that is the rig's watch). She is in the frame, but it is not her
// frame. When one of the village's sights comes by (showcase.ts) it stays about where it stood and turns to it for
// a few seconds, framing it with her, then turns back on ahead.
//
// Each choice is a shot in her own frame (round from her bow, out from her, over the water, and the side of the
// frame she stands in). Many are weighed against each other a little each frame
// (`BUDGET_MS`), each by what it would show: whether the sight is seen past the banks, the trees and the houses,
// how big it stands, from its front; her and her majhi in the frame on a third, the horizon high; the light raking
// across, the sun to one side and never in the middle of the frame; how deep the view runs, over the water, the
// fields, to a hill or a line of trees; and nothing close in front of the lens. Where it may stand: over the water
// clear of the crowns, low over open field, or high over the groves (sightlines.ts). It holds a shot a good while
// and leaves it only for a much better one, and moves between them on springs whose speed and acceleration are
// held (no start or stop shows), drawing in toward her where the banks close in.

/**
 * A shot: the camera `bearing` rad round from her bow (+ to her left), `dist` m out from her, `high` m over the
 * water; `third`: the side of the frame she stands in (−1 left, +1 right).
 */
export interface Shot {
  bearing: number;
  dist: number;
  high: number;
  third: number;
}

/** What the composer is given each frame. */
export interface Moment {
  /** Her place (its y her waterline) and course, and the water's level under her. */
  boat: Vector3;
  course: number;
  water: number;
  /** The sight whose stretch of her way she is in, and how much the camera is with it (0..1). */
  sight: Sight | null;
  share: number;
  /** Every sight, framed when in view. */
  sights: readonly Sight[];
  sun: Vector3;
  moon: Vector3;
  season: SeasonState;
}

/** A shot's score, and what it is made of (for the debug hooks). */
export interface Rated {
  shot: Shot;
  score: number;
  terms: Record<string, number>;
}

/**
 * The shots weighed: behind her and on her quarters (rad from her bow), and for a sight on her beam too; out from her
 * (m, on a landscape screen), over the water (m).
 */
const DEG = Math.PI / 180;
const BEHIND = [100, 120, 140, 160, 180, -160, -140, -120, -100].map((d) => d * DEG);
const BESIDE = [80, -80].map((d) => d * DEG);
const DISTS = [10, 17, 26];
const HIGHS = [2.4, 5, 9.5, 16, 23];
/**
 * How far round from her course the camera may look (rad): on her surroundings, ahead and a little aside (it gives
 * way between the two); turned to a sight, as far as her beam and a little past, never back.
 */
const LOOK_ON: readonly [number, number] = [1.05, 1.3];
const LOOK_ASIDE: readonly [number, number] = [1.65, 1.95];
/** Turned to a sight, what a shot is worth that keeps near the one she was seen from (`STAY`..1 of its score): it turns rather than moves. */
const STAY = 0.5;
/** Each frame's share of the weighing (ms), and the seconds between one weighing and the next. */
const BUDGET_MS = 1.1;
const REST = 1;
/**
 * An environment's shot is held this long at least (s), and left only for one this much better (share of its score);
 * held past `LONG` s, another angle on her (at least `ANOTHER` rad round) counts this much more (`FRESH`).
 */
const HOLD = 14;
const BETTER = 0.12;
const LONG = 40;
const ANOTHER = 1;
const FRESH = 1.08;
/** A sight's shot is weighed again after this long (s), and left for one this much better; below `POOR` the sight is not shown from here (her surroundings are). */
const HOLD_SIGHT = 6;
const BETTER_SIGHT = 0.25;
const POOR = 0.5;
/** What standing over land rather than the water costs a shot (share of its score): the water is the journey's. */
const ASHORE = 0.85;
/** How far a look is followed out (m), how far in front of the lens a crown or a roof spoils the frame (m). */
const FAR = 420;
const NEAR_LENS = 26;
/** Her half-length (m); where her majhi's head is (m behind her middle, over the water). */
const BOAT_HALF = 4.5;
const MAJHI_BACK = 2.95;
const MAJHI_UP = 2.2;
/**
 * The springs' paces: round her (rad), out from her and up (m), drawn in toward her where the banks close in and
 * lifted over what it passes over (m), and turning to its framing (rad).
 */
const ARC: Pace = { omega: 0.7, speed: 0.16, accel: 0.05 };
/** Round her faster while it looks back the way she has come (as the opening flight hands it over, looking back at the sunrise): it comes round behind her sooner. */
const ARC_BACK: Pace = { omega: 0.9, speed: 0.32, accel: 0.1 };
const RUN: Pace = { omega: 0.7, speed: 2.6, accel: 0.8 };
const DRAW: Pace = { omega: 1.8, speed: 5, accel: 5 };
const LIFT: Pace = { omega: 3, speed: 4, accel: 8 };
const TURN: Pace = { omega: 1.3, speed: 0.35, accel: 0.4 };
/** Where her place in the frame (x, y in −1..1) and the sight's are set, and the horizon's height in it. */
const HER_Y = -0.36;
const SIGHT_Y = 0.1;
const HORIZON_Y = 1 / 3;
/** The frame's half-width (its tangent) the shots' distances are made for: a landscape screen's. */
const WIDE = 0.83;

/** How a spring moves: how fast it closes (rad/s), the most speed it gathers, and the most it speeds up or slows (per s). */
interface Pace {
  omega: number;
  speed: number;
  accel: number;
}

/**
 * A critically damped spring (no overshoot), its speed and its acceleration held to its pace: it sets off and comes
 * to rest gently however far it has to go (unheld, a long way started with a jolt).
 */
class Spring {
  x = 0;
  v = 0;
  set(x: number): void {
    this.x = x;
    this.v = 0;
  }
  to(target: number, pace: Pace, dt: number): number {
    const a = clamp(pace.omega * pace.omega * (target - this.x) - 2 * pace.omega * this.v, -pace.accel, pace.accel);
    this.v = clamp(this.v + a * dt, -pace.speed, pace.speed);
    this.x += this.v * dt;
    return this.x;
  }
  /** The same for an angle, the shorter way round. */
  turn(target: number, pace: Pace, dt: number): number {
    return this.to(this.x + angleDelta(this.x, target), pace, dt);
  }
}

/** Where a point falls in a frame: x, y in −1..1 across it, `ahead` false when it is behind the camera. */
interface OnScreen {
  x: number;
  y: number;
  ahead: boolean;
}

/** How well a point at (x, y) in the frame is inside it, with a margin. */
const inside = (p: OnScreen) => (p.ahead ? smoothstep(1.02, 0.82, Math.abs(p.x)) * smoothstep(1.02, 0.78, Math.abs(p.y)) : 0);
/** How near (x, y) is to where it was set. */
const placed = (p: OnScreen, tx: number, ty: number) => (p.ahead ? Math.exp(-((p.x - tx) ** 2 + (p.y - ty) ** 2) / 0.12) : 0);
/** How near `f` is to `best` (a share of the frame), in proportion; `under` and `over` how much it forgives either way. */
const sized = (f: number, best: number, under: number, over: number) => Math.exp(-((Math.log(Math.max(f, 1e-4) / best) / (f < best ? under : over)) ** 2));

export class Composer {
  /** The shot aimed for, and how long it has been. */
  private aim: Shot | null = null;
  private aimKey = '';
  private held = 0;
  private aimScore = 0;
  /** The springs: the shot as it is now, the distance it is drawn in to, and the framing. */
  private readonly bearing = new Spring();
  private readonly dist = new Spring();
  private readonly high = new Spring();
  private readonly yaw = new Spring();
  private readonly pitch = new Spring();
  private third = 1;
  private readonly drawn = new Spring();
  private readonly lift = new Spring();
  /** The weighing under way: its shots, how far through, the best so far, the aim's own score, what it is of. */
  private list: Shot[] = [];
  private next = 0;
  private best: Rated | null = null;
  private current = -1;
  private key = '';
  private subject: Sight | null = null;
  /** Sights found not to be shown well from her way here: her surroundings are shown instead, until her stretch with them ends. */
  private readonly poor = new Set<Sight>();
  /** How much the framing is with the sight (0 while it is not worth seeing now). */
  private share = 0;
  private rest = 0;
  private readonly lines: Sightlines;
  private readonly keepClear: (pos: Vector3) => void;
  private readonly camera: PerspectiveCamera;
  // scratch
  private readonly p = new Vector3();
  private readonly q = new Vector3();
  private readonly herMid = new Vector3();
  private readonly onA: OnScreen = { x: 0, y: 0, ahead: false };
  private readonly onB: OnScreen = { x: 0, y: 0, ahead: false };
  private readonly along: LookAlong = { depth: 0, water: 0, field: 0, backdrop: 0 };
  private readonly framing = { yaw: 0, pitch: 0 };
  /** The pace round her now, between `ARC` and `ARC_BACK`. */
  private readonly round: Pace = { ...ARC };
  /** The shot on her surroundings held as a sight came by: the camera turns to the sight from about there. */
  private before: Shot | null = null;
  private readonly now: SightNow = { season: null as unknown as SeasonState, night: 0 };

  /** `keepClear`: moves a camera place clear of the crossings (the rig's, for the follow camera too). */
  constructor(lines: Sightlines, camera: PerspectiveCamera, keepClear: (pos: Vector3) => void) {
    this.lines = lines;
    this.camera = camera;
    this.keepClear = keepClear;
  }

  /** The shot aimed for, its score, and what it is of (for the debug hooks). */
  get state(): { aim: Shot | null; score: number; subject: string } {
    return { aim: this.aim, score: this.aimScore, subject: this.aimKey };
  }

  /** Takes the camera from where it is now (the follow camera's pose), so the hand-over has no seam; a weighing starts at once. */
  takeFrom(camera: PerspectiveCamera, m: Moment): void {
    const dx = camera.position.x - m.boat.x;
    const dz = camera.position.z - m.boat.z;
    this.bearing.set(angleDelta(m.course, Math.atan2(dx, dz)));
    this.dist.set(Math.hypot(dx, dz));
    this.high.set(camera.position.y - m.water);
    this.drawn.set(this.dist.x);
    this.lift.set(0);
    camera.getWorldDirection(this.q);
    this.yaw.set(Math.atan2(this.q.x, this.q.z));
    this.pitch.set(Math.asin(clamp(this.q.y, -1, 1)));
    this.third = angleDelta(this.yaw.x, Math.atan2(-dx, -dz)) > 0 ? -1 : 1;
    this.aim = { bearing: this.bearing.x, dist: this.dist.x, high: this.high.x, third: this.third };
    this.aimKey = '';
    this.held = HOLD;
    this.list = [];
    this.rest = 0;
  }

  /**
   * One frame: weighs a little (unless `weigh` is false: the film has the camera), moves the camera toward its
   * shot, and puts its place in `pos` and what it looks at in `look`.
   */
  update(dt: number, m: Moment, pos: Vector3, look: Vector3, weigh = true): void {
    this.held += dt;
    if (weigh) this.think(dt, m, BUDGET_MS);
    this.pose(dt, m, pos, look);
  }

  /** Weighs every shot at once and stands at the best (for stills). */
  settle(m: Moment, pos: Vector3, look: Vector3): void {
    this.aim = null;
    // (twice: a sight not shown well from here gives way to her surroundings)
    for (let i = 0; i < 2 && !this.aim; i++) {
      this.list = [];
      this.rest = 0;
      this.think(0, m, Infinity);
    }
    const a = this.aim as Shot | null;
    if (!a) return;
    this.bearing.set(a.bearing);
    this.dist.set(a.dist);
    this.high.set(a.high);
    this.third = a.third;
    this.drawn.set(this.safeDist(m, a.bearing, a.dist, a.high));
    this.lift.set(0);
    this.place(m, a.bearing, this.drawn.x, a.high, this.p);
    this.frame(this.p, m, a.third, this.share, this.framing);
    this.yaw.set(this.framing.yaw);
    this.pitch.set(this.framing.pitch);
    this.pose(0, m, pos, look);
  }

  /** What the shot aimed for scores now, term by term (for the debug hooks). */
  explain(m: Moment): Rated | null {
    return this.aim ? this.rate(m, this.aim, this.subject, true) : null;
  }

  // ---- choosing ----

  /** Goes on with the weighing for `budget` ms; at its end, keeps to the shot aimed for or takes a better one. */
  private think(dt: number, m: Moment, budget: number): void {
    this.now.season = m.season;
    this.now.night = 1 - smoothstep(-0.12, 0.05, m.sun.y);
    if (!m.sight) this.poor.clear();
    const worthy = m.sight !== null && !this.poor.has(m.sight) && sightWorth(m.sight, this.now) > 0.35;
    this.share = worthy ? m.share : 0;
    const subject = worthy && m.share > 0.3 ? m.sight : null;
    const key = subject ? `${subject.name}@${Math.round(subject.s)}` : '';
    // a new subject is weighed at once
    if (key !== this.key) {
      // (a sight is turned to from the shot on her surroundings held as it came by)
      if (subject && !this.key) this.before = this.aim;
      this.key = key;
      this.subject = subject;
      this.list = [];
      this.rest = 0;
    }
    if (this.rest > 0) {
      this.rest -= dt;
      return;
    }
    if (this.list.length === 0) this.begin();
    const until = performance.now() + budget;
    while (this.next < this.list.length && performance.now() < until) {
      const shot = this.list[this.next];
      // (where the camera may not stand, neither side of the frame is weighed)
      const stands = this.canStand(this.place(m, shot.bearing, shot.dist, shot.high, this.p));
      for (const third of stands ? [-1, 1] : []) {
        shot.third = third;
        const r = this.rate(m, shot, this.subject, false, true);
        if (this.next === 0 && this.aim && third === this.aim.third) this.current = r.score;
        // a view held long gives way more easily to another angle on her
        const fresh = !this.subject && this.aim && this.held > LONG && Math.abs(angleDelta(shot.bearing, this.bearing.x)) > ANOTHER ? FRESH : 1;
        if (!this.best || r.score * fresh > this.best.score) this.best = { shot: { ...shot }, score: r.score * fresh, terms: {} };
      }
      this.next++;
    }
    if (this.next < this.list.length) return;
    this.decide();
    this.list = [];
    this.rest = REST;
  }

  /** A new weighing: the shot aimed for first (for its own score now), then the shots behind her and on her quarters (and her beam, for a sight). */
  private begin(): void {
    this.list = [];
    if (this.aim) this.list.push({ ...this.aim });
    // (on a narrow screen a little farther out, though not as far as the follow camera: she would be lost in its height)
    const narrow = narrowScale(this.camera) ** 0.6;
    for (const bearing of this.subject ? [...BEHIND, ...BESIDE] : BEHIND) {
      for (const dist of DISTS) for (const high of HIGHS) this.list.push({ bearing, dist: dist * narrow, high, third: 1 });
    }
    this.next = 0;
    this.best = null;
    this.current = this.aim ? -1 : -Infinity;
  }

  /** At a weighing's end: a new subject takes its best shot; otherwise the shot held stays unless a much better one is found. */
  private decide(): void {
    const best = this.best;
    if (!best || best.score <= 0) return;
    // a sight not shown well from anywhere near her here: her surroundings instead (weighed at once)
    if (this.subject && best.score < POOR) {
      this.poor.add(this.subject);
      return;
    }
    const fresh = this.aimKey !== this.key;
    const hold = this.key ? HOLD_SIGHT : HOLD;
    const better = this.key ? BETTER_SIGHT : BETTER;
    const lost = this.current <= 0.05;
    if (fresh || lost || !this.aim || (this.held > hold && best.score > this.current * (1 + better) + 0.01)) {
      this.aim = best.shot;
      this.aimKey = this.key;
      this.aimScore = best.score;
      this.held = 0;
    } else this.aimScore = this.current;
  }

  /** Where the camera stands `dist` m out at `bearing` from her bow, `high` m over the water (into `out`). */
  private place(m: Moment, bearing: number, dist: number, high: number, out: Vector3): Vector3 {
    const a = m.course + bearing;
    return out.set(m.boat.x + Math.sin(a) * dist, m.water + high, m.boat.z + Math.cos(a) * dist);
  }

  /** Whether the camera may stand at `p`: within the land the village keeps, clear of the crossings, and where sightlines.ts allows. */
  private canStand(p: Vector3): boolean {
    if (corridorDistance(p.x, p.z) > CORRIDOR.camera) return false;
    const b = bridgeFrame(p.x, p.z);
    if (Math.abs(b.x) < BRIDGE.half + 3 && Math.abs(b.z) < BRIDGE.width / 2 + 4) return false;
    const s = sankoFrame(p.x, p.z);
    if (Math.abs(s.a) < SANKO.half + 2 && Math.abs(s.b) < 4) return false;
    return this.lines.standsClear(p.x, p.y, p.z);
  }

  /**
   * How good `shot` is now (0..1; < 0 where the camera may not stand, unless `stands` says it was asked), of
   * `subject` or of her surroundings; `terms` (`explain`) for the debug hooks.
   */
  private rate(m: Moment, shot: Shot, subject: Sight | null, explain: boolean, stands = false): Rated {
    const p = this.place(m, shot.bearing, shot.dist, shot.high, this.p);
    const terms: Record<string, number> = {};
    if (!stands && !this.canStand(p)) return { shot, score: -1, terms };
    const fov = (this.camera.fov * Math.PI) / 180;
    const tanV = Math.tan(fov / 2);
    const tanH = tanV * this.camera.aspect;
    const hfov = 2 * Math.atan(tanH);
    this.frame(p, m, shot.third, subject ? 1 : 0, this.framing);
    const { yaw, pitch } = this.framing;

    // her: seen, on her third, not too big nor lost in the frame, and her majhi in it too (a narrow screen's edge
    // cut him off the stern)
    const her = this.herMid.set(m.boat.x, m.water + 1.3, m.boat.z);
    const herD = p.distanceTo(her);
    this.project(p, yaw, pitch, her, tanH, tanV, this.onA);
    const herSize = (2 * Math.atan(BOAT_HALF / herD)) / hfov;
    const herBest = (subject ? 0.26 : 0.2) * narrowScale(this.camera) ** 0.8;
    let boat = this.lines.sees(p, her) * inside(this.onA) * (0.45 + 0.55 * placed(this.onA, shot.third / 3, HER_Y)) * sized(herSize, herBest, 0.6, 0.5);
    this.q.set(m.boat.x - Math.sin(m.course) * MAJHI_BACK, m.water + MAJHI_UP, m.boat.z - Math.cos(m.course) * MAJHI_BACK);
    boat *= 0.35 + 0.65 * inside(this.project(p, yaw, pitch, this.q, tanH, tanV, this.onB));

    // the light: raking across, the low sun or moon to one side of the frame, never in its middle
    const { light, glare } = this.light(p, yaw, pitch, m, tanH, tanV);

    // the view: how deep it runs and what it runs over, across the frame
    let content = 0;
    let near = 1;
    const fields = fieldWorth(m.season);
    for (const k of [-0.42, -0.14, 0.14, 0.42]) {
      const a = this.lines.look(p, yaw + k * hfov, FAR, this.along);
      content += (0.42 * smoothstep(12, 200, a.depth) + 0.22 * Math.min(1, a.water * 2) + 0.18 * a.field * fields + 0.18 * a.backdrop) / 4;
      near = Math.min(near, smoothstep(5, 14, a.depth));
    }
    content *= 0.5 + 0.5 * near;
    // nothing close in front of the lens: a crown or a roof in the frame's lower part, below the level looks
    const halfV = fov / 2;
    let clutter = this.lines.clutter(p, yaw, pitch - 0.75 * halfV, NEAR_LENS);
    for (const k of [-1, 1]) {
      clutter = Math.max(clutter, this.lines.clutter(p, yaw + k * 0.36 * hfov, pitch - 0.55 * halfV, NEAR_LENS), this.lines.clutter(p, yaw + k * 0.2 * hfov, pitch - 0.1 * halfV, NEAR_LENS));
    }
    // and she is in the frame or out of it, never cut by its edge
    const cut = this.onA.ahead ? smoothstep(0.7, 0.9, Math.abs(this.onA.x)) * (1 - smoothstep(1.15, 1.4, Math.abs(this.onA.x))) : 0;
    // and looking on ahead, never back the way she has come (aside only to a sight)
    const [from, to] = subject ? LOOK_ASIDE : LOOK_ON;
    const ahead = 1 - smoothstep(from, to, Math.abs(angleDelta(m.course, yaw)));
    const clear = (1 - 0.65 * clutter) * (1 - 0.6 * glare) * (1 - 0.4 * cut) * ahead * (this.lines.overWater(p.x, p.z) ? 1 : ASHORE);

    let score: number;
    if (subject) {
      // the sight: seen past what stands between, on its third, standing well in the frame, from its front
      const at = subject.at;
      const spare = ownReach(subject);
      const top = this.q.copy(at).setY(at.y + subject.size * 0.4);
      const seen = (this.lines.sees(p, at, spare) * 2 + this.lines.sees(p, top, spare)) / 3;
      this.project(p, yaw, pitch, at, tanH, tanV, this.onB);
      const d = Math.max(1, p.distanceTo(at));
      const size = (2 * Math.atan(subject.size / d)) / fov;
      const view = seen * inside(this.onB) * (0.5 + 0.5 * placed(this.onB, -shot.third / 3, SIGHT_Y)) * sized(size, 0.5, 0.7, 1.3);
      let front = 0.6;
      if (subject.front) {
        const fx = subject.front.x - at.x;
        const fz = subject.front.z - at.z;
        const c = ((p.x - at.x) * fx + (p.z - at.z) * fz) / (Math.hypot(p.x - at.x, p.z - at.z) * Math.hypot(fx, fz) || 1);
        front = ((1 + c) / 2) ** 1.5;
      }
      const height = 1 - 0.4 * smoothstep(12, 24, shot.high);
      // it turns to the sight from about where it stood, rather than moving off to it
      const b = this.before;
      const stay = b ? Math.exp(-((angleDelta(shot.bearing, b.bearing) / 0.6) ** 2) - ((shot.dist - b.dist) / 12) ** 2 - ((shot.high - b.high) / 6) ** 2) : 1;
      score = (0.4 * view + 0.1 * front + 0.16 * boat + 0.14 * light + 0.08 * content + 0.12 * height) * (0.35 + 0.65 * smoothstep(0.1, 0.4, seen)) * clear * (STAY + (1 - STAY) * stay);
      if (explain) Object.assign(terms, { seen, view, front, size, stay });
    } else {
      // her surroundings: the sights in view as well
      const height = (0.8 + 0.2 * smoothstep(2, 4, shot.high)) * (1 - 0.6 * smoothstep(5, 20, shot.high));
      const marks = this.marks(p, yaw, pitch, m, tanH, tanV, fov);
      score = (0.34 * content + 0.22 * boat + 0.18 * light + 0.14 * height + 0.12 * marks) * clear;
      if (explain) Object.assign(terms, { height, marks });
    }
    if (explain) Object.assign(terms, { boat, cut, light, glare, content, near, clutter, ahead, yaw, pitch });
    return { shot, score, terms };
  }

  /** How much of the village's sights a frame holds: the nearer few in it, seen, by what each is worth (0..1). */
  private marks(p: Vector3, yaw: number, pitch: number, m: Moment, tanH: number, tanV: number, fov: number): number {
    let sum = 0;
    let looked = 0;
    for (const s of m.sights) {
      if (looked >= 3) break;
      const d = p.distanceTo(s.at);
      if (d > 260 || d < 8) continue;
      this.project(p, yaw, pitch, s.at, tanH, tanV, this.onB);
      const k = inside(this.onB);
      if (k < 0.2) continue;
      looked++;
      const size = (2 * Math.atan(s.size / d)) / fov;
      sum += (s.rank / 10) * sightWorth(s, this.now) * k * sized(size, 0.35, 1.2, 1.5) * this.lines.sees(p, s.at, ownReach(s));
    }
    return Math.min(1, sum);
  }

  /**
   * The light for a frame (`light`, 0..1): raking across it, the low sun or moon glowing at one side of the frame;
   * and `glare` (0..1), how near the middle of the frame the sun or the moon stands (never dead ahead).
   */
  private light(p: Vector3, yaw: number, pitch: number, m: Moment, tanH: number, tanV: number): { light: number; glare: number } {
    const body = m.sun.y > -0.04 ? m.sun : m.moon.y > 0.04 ? m.moon : null;
    if (!body) return { light: 0.5, glare: 0 };
    const low = 1 - smoothstep(0.1, 0.6, Math.asin(clamp(body.y, -1, 1)));
    const off = Math.abs(angleDelta(yaw, Math.atan2(body.x, body.z)));
    // where it stands in the frame, if it is in it
    const s = this.project(p, yaw, pitch, this.q.copy(body).multiplyScalar(1000).add(p), tanH, tanV, this.onB);
    const seen = inside(s);
    const glare = seen * (1 - smoothstep(0.3, 0.7, Math.abs(s.x)));
    const edge = seen * smoothstep(0.45, 0.8, Math.abs(s.x));
    const behind = smoothstep(2.5, 3.1, off);
    const light = clamp(0.5 + 0.3 * Math.sin(off) ** 2 + 0.35 * low * edge - 0.6 * glare - 0.15 * behind, 0, 1);
    return { light, glare };
  }

  // ---- framing ----

  /**
   * The look from `p` that frames her and the sight (with weight `share`) as the rule of thirds would: her on the
   * `third` side, low; the sight on the other, a little over the middle; the horizon a third from the top.
   */
  private frame(p: Vector3, m: Moment, third: number, share: number, out: { yaw: number; pitch: number }): void {
    const fov = (this.camera.fov * Math.PI) / 180;
    const tanV = Math.tan(fov / 2);
    const tanH = tanV * this.camera.aspect;
    const her = this.herMid.set(m.boat.x, m.water + 1.3, m.boat.z);
    // each subject's own yaw and pitch for its place in the frame, weighed together
    const herYaw = Math.atan2(her.x - p.x, her.z - p.z) + Math.atan((third / 3) * tanH);
    const herPitch = Math.atan2(her.y - p.y, Math.hypot(her.x - p.x, her.z - p.z)) - Math.atan(HER_Y * tanV);
    let yaw = herYaw;
    let pitch = herPitch;
    const horizon = -Math.atan(HORIZON_Y * tanV);
    const sight = m.sight;
    if (sight && share > 0) {
      const at = sight.at;
      const sYaw = Math.atan2(at.x - p.x, at.z - p.z) + Math.atan((-third / 3) * tanH);
      // (a sight falling behind her is let go: the camera never turns back for it)
      const w = 2.2 * share * (1 - smoothstep(LOOK_ASIDE[0], LOOK_ASIDE[1], Math.abs(angleDelta(m.course, sYaw))));
      const sPitch = Math.atan2(at.y - p.y, Math.hypot(at.x - p.x, at.z - p.z)) - Math.atan(SIGHT_Y * tanV);
      yaw = herYaw + (angleDelta(herYaw, sYaw) * w) / (1 + w);
      pitch = (herPitch + sPitch * w + horizon * 1.2) / (2.2 + w);
    } else pitch = (herPitch + horizon * 1.2) / 2.2;
    out.yaw = yaw;
    out.pitch = clamp(pitch, -0.6, 0.15);
  }

  /** Where `q` falls in the frame of a camera at `p` looking along `yaw`, `pitch` (into `out`). */
  private project(p: Vector3, yaw: number, pitch: number, q: Vector3, tanH: number, tanV: number, out: OnScreen): OnScreen {
    const vx = q.x - p.x;
    const vy = q.y - p.y;
    const vz = q.z - p.z;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    const z = vx * sy * cp + vy * sp + vz * cy * cp;
    out.ahead = z > 0.5;
    if (!out.ahead) return out;
    // right: (−cos yaw, 0, sin yaw); up: right × forward
    out.x = (-vx * cy + vz * sy) / (z * tanH);
    out.y = (-vx * sy * sp + vy * cp - vz * cy * sp) / (z * tanV);
    return out;
  }

  // ---- moving ----

  /** How far out (m, up to `dist`) the camera may stand at `bearing`, `high`: drawn in toward her where the banks close in. */
  private safeDist(m: Moment, bearing: number, dist: number, high: number): number {
    for (let r = dist; r > 4; r -= 1) if (this.canStand(this.place(m, bearing, r, high, this.q))) return r;
    return 4;
  }

  /** Moves the camera on its springs toward the shot aimed for, and frames from where it is. */
  private pose(dt: number, m: Moment, pos: Vector3, look: Vector3): void {
    const a = this.aim;
    if (a) {
      // (eased from the one pace to the other as it comes round, so its speed is never cut short)
      const back = smoothstep(LOOK_ON[0], LOOK_ASIDE[0], Math.abs(angleDelta(m.course, this.yaw.x)));
      this.round.omega = lerp(ARC.omega, ARC_BACK.omega, back);
      this.round.speed = lerp(ARC.speed, ARC_BACK.speed, back);
      this.round.accel = lerp(ARC.accel, ARC_BACK.accel, back);
      this.bearing.turn(a.bearing, this.round, dt);
      this.dist.to(a.dist, RUN, dt);
      this.high.to(a.high, RUN, dt);
      this.third = a.third;
    }
    // drawn in where the bank closes in, let out again as it opens
    const safe = this.safeDist(m, this.bearing.x, this.dist.x, this.high.x);
    if (dt > 0) this.drawn.to(safe, DRAW, dt);
    else this.drawn.set(safe);
    this.place(m, this.bearing.x, Math.min(this.drawn.x, this.dist.x), this.high.x, pos);
    // over the ground, the water and the crowns under it, lifted smoothly
    const floor = Math.max(this.lines.top(pos.x, pos.z) + 1.5, this.lines.groundAt(pos.x, pos.z) + 1.2, m.water + 1.1);
    if (dt > 0) this.lift.to(Math.max(0, floor - pos.y), LIFT, dt);
    else this.lift.set(Math.max(0, floor - pos.y));
    pos.y += this.lift.x;
    this.keepClear(pos);
    // framed from where it is now
    this.frame(pos, m, this.third, this.share, this.framing);
    if (dt > 0) {
      this.yaw.turn(this.framing.yaw, TURN, dt);
      this.pitch.to(this.framing.pitch, TURN, dt);
    }
    const cp = Math.cos(this.pitch.x);
    look.set(pos.x + Math.sin(this.yaw.x) * cp * 30, pos.y + Math.sin(this.pitch.x) * 30, pos.z + Math.cos(this.yaw.x) * cp * 30);
  }
}

/**
 * How much farther from her the camera stands on a screen narrower than a landscape one (a phone held upright), so
 * she and her majhi stay in it: the user saw the boat on a phone and not the majhi at her stern.
 */
export function narrowScale(camera: PerspectiveCamera): number {
  const tanH = Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
  // (just far enough out to keep him in: the user found the first, farther, too far on a phone)
  return clamp((WIDE / tanH) ** 0.3, 1, 1.4);
}

/** What the fields are worth seeing this season (0..1): golden paddy and mustard most, green paddy and flooded seedlings well, stubble least. */
function fieldWorth(s: SeasonState): number {
  const [seedlings, green, golden, mustard] = s.crops;
  return clamp(0.25 + 0.75 * (0.55 * seedlings + 0.85 * green + golden + mustard), 0, 1);
}
