import { Quaternion, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { G } from '../core/globals';
import { clamp, damp, lerp, smoothstep } from '../core/mathx';
import { CHARS, VILLAGES, VILLAGE_CENTERS, boatLane, charHeight, edgeHalfWidth, riverX, terrainHeight } from '../world/geography';
import { LIFT_NETS, liftNetCenter } from '../world/village';

/** The boat's frame at this instant: position, forward (downstream) and starboard, all horizontal. */
interface Frame {
  boat: Vector3;
  fwd: Vector3;
  side: Vector3;
}

interface Shot {
  caption: string;
  seconds: number;
  /** Picks the shot's subject when it starts; returning false skips the shot. */
  begin?(f: Frame): boolean;
  pose(u: number, f: Frame, pos: Vector3, look: Vector3): void;
}

const UP = new Vector3(0, 1, 0);
const CUT = 0.6;

/** Point at boat-relative offsets: `a` metres forward, `s` to starboard, `h` up. */
function rel(f: Frame, a: number, s: number, h: number, out: Vector3): Vector3 {
  return out.copy(f.boat).addScaledVector(f.fwd, a).addScaledVector(f.side, s).addScaledVector(UP, h);
}

/**
 * A film tour of the river, cut like a short documentary: an aerial establishing shot, the boatman,
 * the golden water, a village, the kash on a char, a lift net against the sun, and a pull-back.
 * Cuts dip through black, the frame is letterboxed, and each place is named in a caption.
 */
export class Director {
  active = false;
  /** 0..1 dip to black at the cuts. */
  fade = 0;
  /** 0..1, eased: how far the letterbox bars have closed. */
  letterbox = 0;
  caption = '';
  captionAlpha = 0;
  /** What the current shot looks at; the shadow map follows it. */
  readonly focus = new Vector3();

  private index = 0;
  private time = 0;
  private begun = -1;
  private blend = 1;
  private readonly shots: Shot[];
  private readonly fromPos = new Vector3();
  private readonly fromQuat = new Quaternion();
  private readonly pos = new Vector3();
  private readonly look = new Vector3();
  private readonly frame: Frame = { boat: new Vector3(), fwd: new Vector3(), side: new Vector3() };
  private readonly anchor = new Vector3();
  private readonly anchor2 = new Vector3();
  private readonly tmp = new Vector3();
  private anchorSide = 1;

  constructor() {
    const a = this.anchor;
    const b = this.anchor2;
    this.shots = [
      {
        caption: 'নদীমাতৃক বাংলা',
        seconds: 13,
        pose: (u, f, pos, look) => {
          rel(f, lerp(-70, -25, u), lerp(34, 12, u), lerp(85, 26, u), pos);
          rel(f, lerp(70, 150, u), 0, lerp(0, 6, u), look);
        },
      },
      {
        caption: 'মাঝি',
        seconds: 11,
        pose: (u, f, pos, look) => {
          rel(f, -8.5, lerp(3.2, -1.4, u), lerp(1.3, 1.9, u), pos);
          rel(f, -2.4, 0, 1.45, look).lerp(rel(f, 14, 0, 2, b), 0.25);
        },
      },
      {
        caption: 'সোনালি জল',
        seconds: 12,
        begin: (f) => {
          // stand on the side away from the sun, so the boat crosses its glitter path
          const sun = G.uSunDir.value;
          this.anchorSide = sun.x * f.side.x + sun.z * f.side.z > 0 ? -1 : 1;
          return true;
        },
        pose: (u, f, pos, look) => {
          rel(f, lerp(-12, 7, u), this.anchorSide * 17, 1.0, pos);
          rel(f, 2, 0, 1.2, look);
        },
      },
      {
        caption: 'নদীর পাড়ের গ্রাম',
        seconds: 12,
        begin: (f) => {
          let best = -1;
          VILLAGES.forEach((v, i) => {
            const ahead = f.boat.z - v.z;
            if (ahead > 60 && ahead < 800 && (best < 0 || v.z > VILLAGES[best].z)) best = i;
          });
          if (best < 0) return false;
          const v = VILLAGES[best];
          a.set(VILLAGE_CENTERS[best].x, 0, VILLAGE_CENTERS[best].z);
          a.y = terrainHeight(a.x, a.z) + 3;
          this.anchorSide = v.side;
          return true;
        },
        pose: (u, _f, pos, look) => {
          const z = a.z + lerp(45, 5, u);
          const x = riverX(z) + this.anchorSide * (edgeHalfWidth(z, this.anchorSide) - 30);
          pos.set(x, lerp(5.5, 4, u), z);
          look.copy(a);
        },
      },
      {
        caption: 'চরের কাশবন',
        seconds: 11,
        begin: (f) => {
          const c = CHARS.find((ch) => f.boat.z - (ch.z + ch.halfLen * 0.3) > 80 && f.boat.z - ch.z < 1000);
          if (!c) return false;
          // stand among the kash on the channel side of the char, looking back up the channel at the boat
          const z = c.z + c.halfLen * 0.3;
          const u = c.u - Math.sign(c.u) * c.halfWid * 0.3;
          a.set(riverX(z) + u, Math.max(charHeight(z, u), 0) + 1.1, z);
          b.set(riverX(z + 90) + boatLane(z + 90), 1.4, z + 90);
          return true;
        },
        pose: (u, f, pos, look) => {
          pos.copy(a).addScaledVector(f.fwd, lerp(0, 6, u));
          // the boat, when it is near; otherwise down the channel
          const d = f.boat.distanceTo(a);
          look.copy(b).lerp(rel(f, 0, 0, 1.2, this.tmp), smoothstep(260, 120, d));
        },
      },
      {
        caption: 'ভেসাল জাল',
        seconds: 10,
        begin: (f) => {
          const n = LIFT_NETS.find((ln) => f.boat.z - ln.z > -40 && f.boat.z - ln.z < 900);
          if (!n) return false;
          a.copy(liftNetCenter(n)).setY(3);
          // put the sun behind the net
          const sun = G.uSunDir.value;
          const l = Math.hypot(sun.x, sun.z) || 1;
          b.set(-sun.x / l, 0, -sun.z / l);
          if (terrainHeight(a.x + b.x * 26, a.z + b.z * 26) > 0) b.set(-n.side, 0, 0);
          return true;
        },
        pose: (u, _f, pos, look) => {
          pos.copy(a).addScaledVector(b, lerp(32, 22, u)).setY(lerp(1.6, 2.4, u));
          look.copy(a).setY(lerp(2.6, 3.2, u));
        },
      },
      {
        caption: '',
        seconds: 13,
        pose: (u, f, pos, look) => {
          rel(f, lerp(-14, -80, u), lerp(5, 28, u), lerp(3, 46, u), pos);
          rel(f, lerp(4, 70, u), 0, 2, look);
        },
      },
    ];
  }

  start(): void {
    this.active = true;
    this.index = 0;
    this.time = 0;
    this.begun = -1;
  }

  /** `immediate` hands the camera straight back instead of easing over. */
  stop(camera: PerspectiveCamera, immediate = false): void {
    if (!this.active) return;
    this.active = false;
    this.blend = immediate ? 1 : 0;
    if (immediate) this.captionAlpha = 0;
    this.fromPos.copy(camera.position);
    this.fromQuat.copy(camera.quaternion);
  }

  /** Runs after the rig has placed its own camera; overrides it while the tour plays. */
  update(dt: number, t: number, camera: PerspectiveCamera, boat: Vector3, heading: number): void {
    this.letterbox = damp(this.letterbox, this.active ? 1 : 0, 2.5, dt);
    if (!this.active) {
      this.fade = 0;
      this.captionAlpha = damp(this.captionAlpha, 0, 6, dt);
      // ease from the film's last frame back to the follow camera
      if (this.blend < 1) {
        this.blend = Math.min(1, this.blend + dt / 1.6);
        const k = smoothstep(0, 1, this.blend);
        const q = camera.quaternion.clone();
        camera.position.lerpVectors(this.fromPos, camera.position, k);
        camera.quaternion.slerpQuaternions(this.fromQuat, q, k);
        camera.updateMatrixWorld();
      }
      return;
    }

    const f = this.frame;
    f.boat.copy(boat);
    f.fwd.set(Math.sin(heading), 0, Math.cos(heading));
    f.side.set(Math.cos(heading), 0, -Math.sin(heading));

    let shot = this.shots[this.index];
    for (let guard = 0; this.begun !== this.index && guard < this.shots.length; guard++) {
      this.begun = this.index;
      if (!shot.begin || shot.begin(f)) break;
      this.next();
      shot = this.shots[this.index];
    }

    this.time += dt;
    const u = clamp(this.time / shot.seconds, 0, 1);
    const e = lerp(u, u * u * (3 - 2 * u), 0.55);
    shot.pose(e, f, this.pos, this.look);
    // faint hand-held drift; never inside the ground or the water
    this.pos.x += Math.sin(t * 0.37) * 0.06;
    this.pos.y += Math.sin(t * 0.53) * 0.04;
    this.pos.y = Math.max(this.pos.y, Math.max(terrainHeight(this.pos.x, this.pos.z), 0) + 0.7);
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
    camera.updateMatrixWorld();
    this.focus.copy(this.look);

    this.fade = clamp(Math.max(1 - this.time / CUT, (this.time - (shot.seconds - CUT)) / CUT), 0, 1);
    this.caption = shot.caption;
    this.captionAlpha = shot.caption ? clamp(Math.min((this.time - 0.9) / 0.8, (shot.seconds - 1.3 - this.time) / 0.8), 0, 1) : 0;
    if (this.time >= shot.seconds) this.next();
  }

  /** For stills: jump to a shot at a point within it. */
  cue(index: number, u: number): void {
    this.active = true;
    this.index = ((index % this.shots.length) + this.shots.length) % this.shots.length;
    this.begun = -1;
    this.time = this.shots[this.index].seconds * clamp(u, 0, 1);
  }

  private next(): void {
    this.index = (this.index + 1) % this.shots.length;
    this.time = 0;
  }
}
