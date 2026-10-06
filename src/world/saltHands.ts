import { BoxGeometry, CylinderGeometry, Group, LatheGeometry, Mesh, MeshBasicMaterial, PlaneGeometry, Vector2, Vector3 } from 'three';
import type { BufferGeometry, MeshStandardMaterial } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { windAt } from '../env/wind';
import { softSpotTexture } from '../render/textures';
import { Boatman, type OarPose, type Outfit } from './boatman';
import type { HumanName } from './humanData';
import type { BodyDrive } from './paddle';

// The people at work on the salt farms (world/saltworks.ts sets them to their tasks, world/plan.ts SALT_FIELDS
// says who does what where). Each is the boatman's body (human.ts) on his own feet in his own clothes, at his
// own pace, so no two move alike: a man raking the crust that has formed on the black plastic toward his feet; a
// man carrying the raked salt in a basket on his head down the bunds to the heap, tipping it out and coming back
// with it empty in his hand; a man walking the bunds looking the beds over, crouching at each stop to feel the
// brine (or the rains' water) with his fingers; men dressing a bed's mud floor with the kodal (কোদাল), swung up
// over the shoulder and down into the mud and the mud drawn back; an older man on the bund watching them at it,
// his hands behind his back, now and then pointing; and in the rains, the gher's keeper throwing feed out over
// the flooded beds from a bowl.

const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);

/** A walk's length of one stride (two steps, m), the share of it each foot stands on the ground, and how high a foot is lifted as it swings through. */
const STRIDE = 1.3;
const STANCE = 0.58;
const LIFT = 0.085;

/** What a man drops on the water where his hand or what he throws meets it (world/ripples.ts Ripples.drop, world). */
export type Drop = (x: number, z: number, radius: number, strength: number) => void;

/** A man at work: his body, his soft shadow, and the frame he is posed in each frame. */
abstract class Hand {
  readonly group = new Group();
  protected readonly man: Boatman;
  protected readonly drive: BodyDrive = { twist: 0, bend: 0.1, lean: 0, crouch: 0.02, shift: 0 };
  protected readonly pose: OarPose = {
    holds: [
      { at: new Vector3(-0.2, 0.85, 0.05), thumb: new Vector3(0, 0, 1) },
      { at: new Vector3(0.2, 0.85, 0.05), thumb: new Vector3(0, 0, 1) },
    ],
  };
  /** His own pace: his work goes this much faster or slower than the next man's, and starts this far into it (s). */
  protected readonly pace: number;
  protected readonly offset: number;
  private readonly tilt = { rotX: 0, rotZ: 0 };
  private readonly wind = new Vector3();
  private readonly gravity = new Vector3(0, -9.81, 0);
  private readonly air = { x: 0, z: 0 };

  constructor(outfit: Outfit, who: HumanName, radii: readonly [number, number], pace: number, offset: number) {
    this.pace = pace;
    this.offset = offset;
    this.man = new Boatman(new Vector3(0, 0, 0), radii, outfit, who);
    const shadow = new Mesh(
      new PlaneGeometry(0.95, 0.75).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: softSpotTexture(), transparent: true, depthWrite: false, color: '#000000', opacity: 0.45 }),
    );
    shadow.position.set(0, 0.03, 0.08);
    this.group.add(this.man.group, shadow);
  }

  /** Moving things stay out of the shadow map (it is not redrawn every frame), and out of the mirror. */
  protected seal(): void {
    this.group.traverse((o) => {
      o.castShadow = false;
      o.layers.set(LAYER_NO_REFLECT);
    });
  }

  /** Sets his holds, his body's drive and his gait for `t` s into the work (his own clock). */
  protected abstract act(dt: number, t: number): void;
  /** Places what he holds once his body is posed. */
  protected after(): void {}

  update(dt: number, t: number): void {
    this.act(dt, t * this.pace + this.offset);
    const g = this.group;
    windAt(g.position.x, g.position.z, this.air);
    const c = Math.cos(g.rotation.y);
    const s = Math.sin(g.rotation.y);
    this.wind.set(this.air.x * c - this.air.z * s, 0, this.air.x * s + this.air.z * c);
    this.man.update(dt, t, this.drive, this.pose, this.tilt, this.wind, this.gravity);
    this.after();
  }
}

// ---------- raking ----------

/** The raking: its period (s), how far ahead the board is drawn from and to (m), how high it is lifted to reach out again, the handle's length, and the hands' spacing on it. */
const RAKE = { period: 2.7, out: 1.85, in: 1.05, lift: 0.1, handle: 1.8, hands: 0.55, radius: 0.018 };
/** The share of a stroke spent drawing the board in along the ground (the rest lifts it and reaches out). */
const PULL = 0.62;

/** A man raking salt: on his feet in a crystallizer bed, drawing the rake's board (ফাউড়া) toward him through the crust. */
export class Raker extends Hand {
  private readonly board: Mesh;
  private readonly handle: Mesh;
  private readonly at = new Vector3();
  private readonly hand = new Vector3();
  private readonly dir = new Vector3();

  constructor(outfit: Outfit, who: HumanName, pace: number, offset: number, wood: MeshStandardMaterial, bamboo: MeshStandardMaterial) {
    super(outfit, who, [RAKE.radius, RAKE.radius], pace, offset);
    this.drive.twist = -0.15;
    this.board = new Mesh(new BoxGeometry(0.56, 0.11, 0.03).translate(0, 0.055, 0), wood);
    this.handle = new Mesh(new CylinderGeometry(RAKE.radius, RAKE.radius * 1.1, RAKE.handle, 6).translate(0, RAKE.handle / 2, 0), bamboo);
    this.group.add(this.board, this.handle);
    this.seal();
  }

  protected act(_dt: number, t: number): void {
    const cycle = t / RAKE.period;
    const phase = cycle - Math.floor(cycle);
    // each stroke a little to one side of the last, so the bed is raked across its width
    const sweep = 0.22 * Math.sin(Math.floor(cycle) * 1.7 + this.offset * 9);
    let reach: number;
    let lift: number;
    if (phase < PULL) {
      reach = RAKE.out + (RAKE.in - RAKE.out) * smoothstep(0, 1, phase / PULL);
      lift = 0;
    } else {
      const k = (phase - PULL) / (1 - PULL);
      reach = RAKE.in + (RAKE.out - RAKE.in) * smoothstep(0, 1, k);
      lift = RAKE.lift * Math.sin(Math.PI * k);
    }
    // how far out the board is (1 reaching, 0 drawn in): he bends and leans into the reach
    const f = (reach - RAKE.in) / (RAKE.out - RAKE.in);
    this.at.set(sweep, 0.02 + lift, reach);
    // his right hand by his right hip, coming in and up as the board comes to him
    this.hand.set(-0.24, 0.98 - 0.2 * f, 0.3 + 0.25 * f);
    this.dir.subVectors(this.hand, this.at);
    const along = Math.min(this.dir.length(), RAKE.handle - 0.08);
    this.dir.normalize();
    const [right, left] = this.pose.holds;
    right.at.copy(this.at).addScaledVector(this.dir, along);
    right.thumb.copy(this.dir);
    left.at.copy(right.at).addScaledVector(this.dir, -RAKE.hands);
    left.thumb.copy(this.dir);
    this.board.position.copy(this.at);
    this.handle.position.copy(this.at).addScaledVector(UP, 0.06);
    this.handle.quaternion.setFromUnitVectors(UP, this.dir);
    this.drive.bend = 0.3 + 0.32 * f;
    this.drive.crouch = 0.04 + 0.05 * f;
    this.drive.shift = -0.02 + 0.12 * f;
  }
}

// ---------- walking the bunds ----------

/** A round basket (টুকরি) of split bamboo, open at the top: its foot at the origin. */
export function basketGeometry(): BufferGeometry {
  return new LatheGeometry(
    [
      [0.0, 0.0],
      [0.15, 0.0],
      [0.2, 0.06],
      [0.25, 0.17],
      [0.265, 0.2],
      [0.25, 0.2],
      [0.23, 0.17],
      [0.18, 0.06],
      [0.0, 0.03],
    ].map(([r, y]) => new Vector2(r, y)),
    14,
  );
}

/**
 * A man walking a way along the bunds (`path`, world points on their crowns, there and back): a carrier with
 * a basket of salt on his head out to the heap and back with it empty in his hand, stopping to tip it out at one
 * end and to have it filled at the other; or a man looking the beds over, stopping at each point of his way to
 * crouch and feel the water with his fingers, now and then a longer look round.
 */
export class Walker extends Hand {
  private readonly path: Vector3[];
  private readonly at: number[] = [];
  private readonly stopList: number[];
  private readonly length: number;
  private readonly carry: boolean;
  private readonly drop: Drop | null;
  private readonly basket: Mesh | null = null;
  private readonly salt: Mesh | null = null;
  private readonly seat = new Vector3();
  /** Where he is along his way (m), which way he goes, how fast, and what he is doing. */
  private s = 0;
  private dir = 1;
  private speed = 0;
  private state: 'walk' | 'stop' | 'turn' = 'walk';
  private timer = 0;
  /** How long this stop is (s). */
  private stopFor = 0;
  private stopAt = 0;
  private stops = 0;
  private heading = 0;
  private turnFrom = 0;
  private walking = 0;
  private stride = 0;
  private crouch = 0;
  private reachDown = 0;
  private full = true;
  private touched = false;
  private readonly gait = { feet: [new Vector3(), new Vector3()] as [Vector3, Vector3], pitch: [0, 0] as [number, number], hips: new Vector3(), look: new Vector3() as Vector3 | null };
  private readonly v = new Vector3();
  private readonly w = new Vector3();

  /** `path`: his way, point by point (world); `stops`: how far along it (m) a looker stops (a carrier stops at its ends). */
  constructor(outfit: Outfit, who: HumanName, path: readonly Vector3[], stops: readonly number[], carry: boolean, pace: number, offset: number, drop: Drop | null, weave: MeshStandardMaterial | null, saltMat: MeshStandardMaterial | null) {
    super(outfit, who, [0.02, 0.02], pace, offset);
    this.path = path.map((p) => p.clone());
    let total = 0;
    this.at.push(0);
    for (let i = 1; i < this.path.length; i++) this.at.push((total += this.path[i].distanceTo(this.path[i - 1])));
    this.length = total;
    this.stopList = [...stops];
    this.carry = carry;
    this.drop = drop;
    if (carry && weave && saltMat) {
      this.basket = new Mesh(basketGeometry(), weave);
      this.salt = new Mesh(new CylinderGeometry(0.2, 0.24, 0.09, 12).translate(0, 0.19, 0), saltMat);
      this.basket.add(this.salt);
      this.group.add(this.basket);
    }
    this.man.gait = this.gait;
    this.seat.set(...(this.man.body.data.crown as [number, number, number])).add(this.v.set(0, 0.02, -0.01));
    // he sets out from somewhere along his way already, not all from its start
    this.s = (offset * 7.3) % Math.max(this.length, 1);
    this.stopAt = this.nextStop();
    this.heading = this.headingAt(this.s);
    this.seal();
  }

  /** The point of his way `s` m along it, and the way it runs there. */
  private pointAt(s: number, out: Vector3): Vector3 {
    let i = 1;
    while (i < this.at.length - 1 && this.at[i] < s) i++;
    const a = this.path[i - 1];
    const b = this.path[i];
    const span = this.at[i] - this.at[i - 1] || 1;
    return out.lerpVectors(a, b, Math.min(1, Math.max(0, (s - this.at[i - 1]) / span)));
  }

  private headingAt(s: number): number {
    let i = 1;
    while (i < this.at.length - 1 && this.at[i] <= s) i++;
    const a = this.path[i - 1];
    const b = this.path[i];
    const h = Math.atan2(b.x - a.x, b.z - a.z);
    return this.dir > 0 ? h : h + Math.PI;
  }

  /** The next place along his way he stops at: the far end; a looker stops at every point of it as well. */
  private nextStop(): number {
    if (this.carry) return this.dir > 0 ? this.length : 0;
    const ahead = this.dir > 0 ? this.stopList.filter((a) => a > this.s + 0.2) : this.stopList.filter((a) => a < this.s - 0.2).reverse();
    return ahead.length ? ahead[0] : this.dir > 0 ? this.length : 0;
  }

  protected act(dt: number, t: number): void {
    const atEnd = (this.dir > 0 && this.stopAt >= this.length - 0.01) || (this.dir < 0 && this.stopAt <= 0.01);
    if (this.state === 'walk') {
      const left = Math.abs(this.stopAt - this.s);
      // a slow walk on the narrow crowns, the carrier slower under his load; easing to a stop
      const pace = (this.carry ? (this.full ? 0.72 : 0.92) : 0.82) * Math.min(1, left / 0.9 + 0.15);
      this.speed += (pace - this.speed) * (1 - Math.exp(-dt / 0.45));
      this.s += this.dir * this.speed * dt;
      if ((this.dir > 0 && this.s >= this.stopAt) || (this.dir < 0 && this.s <= this.stopAt)) {
        this.s = this.stopAt;
        this.state = 'stop';
        this.stops++;
        // at each stop his own while: a looker crouches a few seconds (longer every third), the carrier tips out or is loaded
        this.timer = this.stopFor = this.carry ? (atEnd ? 3.2 : 1.6) : this.stops % 3 === 0 ? 7.5 : 4.2 + 1.3 * Math.sin(this.stops * 2.1 + this.offset);
        this.touched = false;
      }
    } else if (this.state === 'stop') {
      this.speed *= Math.exp(-dt / 0.2);
      this.timer -= dt;
      if (this.timer <= 0) {
        if (atEnd) {
          this.state = 'turn';
          this.timer = 1.5;
          this.turnFrom = this.heading;
          this.dir = -this.dir;
          if (this.carry) this.full = this.dir > 0;
        } else this.state = 'walk';
        this.stopAt = this.nextStop();
      }
    } else {
      this.timer -= dt;
      if (this.timer <= 0) this.state = 'walk';
    }

    // where he is, and which way he faces: round about at the end of his way, stepping as he turns
    const g = this.group;
    this.pointAt(this.s, this.v);
    g.position.copy(this.v);
    const want = this.headingAt(this.s);
    if (this.state === 'turn') {
      const k = smoothstep(1.5, 0, this.timer);
      let d = want - this.turnFrom;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading = this.turnFrom + d * k;
    } else {
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * (1 - Math.exp(-dt / 0.35));
    }
    g.rotation.y = this.heading;

    // the gait: a stride's phase as he goes (in place, short steps, as he turns)
    const stepping = this.state === 'walk' ? this.speed / 0.8 : this.state === 'turn' ? 0.45 : 0;
    this.walking += (Math.min(1, stepping) - this.walking) * (1 - Math.exp(-dt / 0.25));
    this.stride += (this.state === 'turn' ? 0.35 : this.speed) * dt / STRIDE + (this.state === 'turn' ? dt * 0.9 : 0);
    const reach = this.state === 'turn' ? 0.12 : STRIDE * STANCE;
    const w = this.walking;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const p = (((this.stride + i * 0.5) % 1) + 1) % 1;
      let z: number;
      let y = 0;
      let pitch = 0;
      if (p < STANCE) {
        z = reach / 2 - (p / STANCE) * reach;
        pitch = 0.35 * smoothstep(STANCE * 0.7, STANCE, p);
      } else {
        const k = (p - STANCE) / (1 - STANCE);
        z = -reach / 2 + reach * smoothstep(0, 1, k);
        y = LIFT * Math.sin(Math.PI * k);
        pitch = -0.2 * smoothstep(0.7, 1, k) + 0.3 * (1 - smoothstep(0, 0.3, k));
      }
      // standing, his feet come together under him, a little apart and turned out
      this.gait.feet[i].set(side * (0.1 + 0.03 * (1 - w)), y * w, z * w + (1 - w) * (i === 0 ? 0.05 : -0.04));
      this.gait.pitch[i] = pitch * w;
    }
    const phase = this.stride * Math.PI * 2;
    this.gait.hips.set(0.022 * Math.sin(phase) * w, -0.022 * (0.5 - 0.5 * Math.cos(phase * 2)) * w, 0);

    // at a stop a looker crouches to the water at his side and feels it, then rises
    const stopped = this.state === 'stop' && !this.carry;
    const down = stopped ? smoothstep(0, 0.9, this.timerElapsed()) * smoothstep(0, 1.1, this.timer) : 0;
    this.crouch += (down - this.crouch) * (1 - Math.exp(-dt / 0.3));
    this.reachDown = this.crouch;
    this.drive.crouch = 0.02 + 0.36 * this.crouch;
    this.drive.bend = 0.12 + 0.55 * this.crouch + (this.carry && this.full ? -0.06 : 0);
    this.drive.twist = 0.1 * this.crouch;
    const [right, left] = this.pose.holds;
    // arms swinging easy as he walks, each against its foot
    const swing = Math.sin(phase) * 0.16 * w;
    right.at.set(-0.21, 0.84, 0.04 - swing);
    left.at.set(0.21, 0.84, 0.04 + swing);
    right.thumb.copy(FORWARD);
    left.thumb.copy(FORWARD);
    // his right hand down to the water beside his feet, fingers in it
    if (this.reachDown > 0.01) {
      right.at.lerp(this.v.set(-0.3, 0.12, 0.42), this.reachDown);
      left.at.lerp(this.v.set(0.16, 0.62, 0.3), this.reachDown);
      if (!this.touched && this.reachDown > 0.85 && this.drop) {
        this.touched = true;
        this.w.set(-0.3, 0, 0.45).applyAxisAngle(UP, this.heading).add(g.position);
        this.drop(this.w.x, this.w.z, 0.18, 0.5);
      }
    }
    // the carrier: the basket on his head, steadied with his right hand; empty, hung from it at his side
    if (this.carry) {
      const loading = this.state === 'stop' ? smoothstep(0, 0.6, this.timerElapsed()) * smoothstep(0, 0.6, this.timer) : 0;
      if (this.full) right.at.set(-0.2, 1.62 - 0.55 * loading, 0.05 + 0.3 * loading);
      else right.at.set(-0.27, 0.78 + 0.6 * loading, 0.06 + 0.25 * loading);
      right.thumb.copy(this.full ? UP : FORWARD);
      if (loading > 0.05) left.at.lerp(this.v.set(0.2, 1.1, 0.4), loading);
    }
    // where he looks: ahead along the bund, down to the water when he crouches, round about now and then
    const look = this.gait.look!;
    if (this.crouch > 0.2) look.set(-0.4, 0, 0.9);
    else look.set(Math.sin(t * 0.21 + this.offset) * 2.5 * (this.state === 'stop' ? 1 : 0.3), 0.5, 7);
  }

  /** How long he has been at this stop (s). */
  private timerElapsed(): number {
    return Math.max(0, this.stopFor - this.timer);
  }

  protected after(): void {
    if (!this.basket || !this.salt) return;
    const body = this.man.body;
    const [right] = this.pose.holds;
    if (this.full && !(this.state === 'stop' && this.timerElapsed() > 0.3)) {
      body.onHead(this.seat, this.basket.position);
      this.basket.quaternion.copy(body.headQ);
    } else {
      this.basket.position.copy(right.at).add(this.v.set(-0.05, -0.2, 0));
      this.basket.quaternion.setFromAxisAngle(FORWARD, 0.25);
    }
    this.salt.visible = this.full;
  }
}

// ---------- dressing a bed with the kodal ----------

/** The kodal: its handle's length and its blade, and a stroke's length (s) and parts. */
const KODAL = { handle: 1.0, period: 2.5 };
/** The stroke: the right hand (on the handle's end) and the way the handle points from it, raised, struck into the mud, and drawing the mud back. */
const KEYS = {
  raise: { hand: new Vector3(-0.08, 1.25, 0.15), dir: new Vector3(0, 0.72, -0.69).normalize() },
  strike: { hand: new Vector3(-0.06, 0.8, 0.32), dir: new Vector3(0, -0.76, 0.65).normalize() },
  pull: { hand: new Vector3(-0.12, 0.9, 0.08), dir: new Vector3(0, -0.86, 0.51).normalize() },
};

/** A man dressing a bed's mud floor with the kodal: swung up over his shoulder, down into the mud ahead, the mud drawn back toward him. */
export class Spader extends Hand {
  private readonly tool = new Group();
  private readonly hand = new Vector3();
  private readonly dir = new Vector3();

  constructor(outfit: Outfit, who: HumanName, pace: number, offset: number, wood: MeshStandardMaterial, iron: MeshStandardMaterial) {
    super(outfit, who, [0.02, 0.02], pace, offset);
    this.tool.add(new Mesh(new CylinderGeometry(0.019, 0.021, KODAL.handle, 6).translate(0, KODAL.handle / 2, 0), wood));
    // the blade, square to the handle at its end, its edge toward the ground when struck
    this.tool.add(new Mesh(new BoxGeometry(0.22, 0.012, 0.2).translate(0, KODAL.handle - 0.01, 0.09), iron));
    this.group.add(this.tool);
    this.drive.shift = 0.02;
    this.seal();
  }

  protected act(_dt: number, t: number): void {
    const cycle = t / KODAL.period;
    const f = cycle - Math.floor(cycle);
    // up (0–0.38), the blow (0.38–0.5), the draw (0.5–0.82), and a breath before the next
    const up = smoothstep(0.0, 0.38, f) * (1 - smoothstep(0.38, 0.5, f));
    const blow = smoothstep(0.38, 0.5, f) * (1 - smoothstep(0.5, 0.82, f));
    const draw = smoothstep(0.5, 0.82, f) * (1 - smoothstep(0.85, 1, f));
    const rest = 1 - up - blow - draw;
    const { raise, strike, pull } = KEYS;
    this.hand
      .set(0, 0, 0)
      .addScaledVector(raise.hand, up)
      .addScaledVector(strike.hand, blow)
      .addScaledVector(pull.hand, draw)
      .addScaledVector(strike.hand, rest);
    this.dir
      .set(0, 0, 0)
      .addScaledVector(raise.dir, up)
      .addScaledVector(strike.dir, blow)
      .addScaledVector(pull.dir, draw)
      .addScaledVector(strike.dir, rest)
      .normalize();
    // each blow a little to one side of the last
    this.hand.x += 0.08 * Math.sin(Math.floor(cycle) * 2.3 + this.offset * 5);
    const [right, left] = this.pose.holds;
    right.at.copy(this.hand);
    right.thumb.copy(this.dir);
    left.at.copy(this.hand).addScaledVector(this.dir, 0.42);
    left.thumb.copy(this.dir);
    this.tool.position.copy(this.hand).addScaledVector(this.dir, -0.08);
    this.tool.quaternion.setFromUnitVectors(UP, this.dir);
    this.drive.bend = 0.3 + 0.55 * (blow + draw * 0.8 + rest * 0.6);
    this.drive.crouch = 0.04 + 0.1 * (blow + draw);
    this.drive.twist = -0.12 * up;
  }
}

// ---------- watching, and feeding the gher ----------

/** A man on a bund watching the others at work, his hands behind his back, weight from foot to foot, pointing now and then. */
export class Watcher extends Hand {
  private readonly look: Vector3;
  private readonly pointAt = new Vector3(-0.32, 1.3, 0.48);
  private readonly gait = { feet: [new Vector3(-0.12, 0, 0.04), new Vector3(0.12, 0, -0.03)] as [Vector3, Vector3], pitch: [0, 0] as [number, number], hips: new Vector3(), look: new Vector3() as Vector3 | null };

  /** `look`: what he watches (his frame). */
  constructor(outfit: Outfit, who: HumanName, look: Vector3, pace: number, offset: number) {
    super(outfit, who, [0.02, 0.02], pace, offset);
    this.look = look.clone();
    this.man.gait = this.gait;
    this.seal();
  }

  protected act(_dt: number, t: number): void {
    // his weight going slowly over from one foot to the other
    const shift = Math.sin(t * 0.31);
    this.gait.hips.set(0.035 * shift, -0.01 * Math.abs(shift), 0);
    // every so often he points out something in the bed, then his hand goes back behind him
    const cycle = t / 11;
    const f = cycle - Math.floor(cycle);
    const point = smoothstep(0.55, 0.62, f) * (1 - smoothstep(0.8, 0.88, f));
    const [right, left] = this.pose.holds;
    right.at.set(-0.06, 0.98, -0.19).lerp(this.pointAt, point);
    right.thumb.set(0, 1, 0);
    left.at.set(0.05, 0.97, -0.2);
    left.thumb.set(0, 1, 0);
    this.gait.look!.copy(this.look).add(this.gait.hips).setX(this.look.x + 0.4 * Math.sin(t * 0.13));
    this.drive.bend = 0.05 + 0.12 * point;
    this.drive.twist = 0.12 * point;
  }
}

/** The gher's keeper on a bund in the rains, throwing feed out over the flooded beds from the bowl in his left hand. */
export class Feeder extends Hand {
  private readonly bowl: Mesh;
  private readonly drop: Drop;
  private lastCycle = -1;
  private readonly v = new Vector3();

  constructor(outfit: Outfit, who: HumanName, pace: number, offset: number, drop: Drop, clay: MeshStandardMaterial) {
    super(outfit, who, [0.02, 0.05], pace, offset);
    this.drop = drop;
    this.bowl = new Mesh(new LatheGeometry([new Vector2(0, 0), new Vector2(0.09, 0.01), new Vector2(0.13, 0.07), new Vector2(0.12, 0.075)], 12), clay);
    this.group.add(this.bowl);
    this.seal();
  }

  protected act(_dt: number, t: number): void {
    const period = 4.6;
    const cycle = t / period;
    const n = Math.floor(cycle);
    const f = cycle - n;
    // a handful from the bowl (0–0.3), the arm back (0.3–0.55), the throw (0.55–0.68), and down again
    const dip = smoothstep(0.05, 0.25, f) * (1 - smoothstep(0.25, 0.4, f));
    const back = smoothstep(0.3, 0.55, f) * (1 - smoothstep(0.55, 0.64, f));
    const out = smoothstep(0.55, 0.68, f) * (1 - smoothstep(0.75, 0.98, f));
    const [right, left] = this.pose.holds;
    left.at.set(0.1, 0.96, 0.3);
    left.thumb.set(0, 1, 0);
    right.at.set(-0.22, 0.86, 0.12);
    right.at.lerp(this.v.set(0.05, 1.0, 0.33), dip);
    right.at.lerp(this.v.set(-0.36, 1.18, -0.12), back);
    right.at.lerp(this.v.set(-0.08, 1.42, 0.62), out);
    right.thumb.copy(FORWARD);
    this.drive.twist = 0.25 * back - 0.2 * out;
    this.drive.bend = 0.1 + 0.08 * dip;
    // the feed scatters over the water a few metres out as it leaves his hand
    if (f > 0.66 && this.lastCycle !== n) {
      this.lastCycle = n;
      const g = this.group;
      for (let k = 0; k < 5; k++) {
        const a = g.rotation.y + (Math.sin(n * 3.1 + k * 1.7) * 0.5);
        const r = 3 + 2.5 * (0.5 + 0.5 * Math.sin(n * 1.3 + k * 2.9));
        this.drop(g.position.x + Math.sin(a) * r, g.position.z + Math.cos(a) * r, 0.12, 0.35);
      }
    }
  }

  protected after(): void {
    this.bowl.position.copy(this.pose.holds[1].at).add(this.v.set(0, 0.03, 0));
  }
}
