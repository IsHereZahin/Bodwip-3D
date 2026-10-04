import { BoxGeometry, CapsuleGeometry, CylinderGeometry, DoubleSide, Group, Matrix4, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import { G } from '../core/globals';
import { place } from '../geo/data';
import { MeshBuilder, rgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { plankTexture } from '../render/textures';
import { GORAKGHATA, terrainHeight } from './geography';
import { buildHull, type HullShape } from './hull';
import { waterRoute } from './navigation';
import { hullWaves, type HullWaves } from './waves';

// The ferries between Gorakghata and Cox's Bazar's Kastura ghat (GEOGRAPHY_PLAN.md §8.1): speedboats, 15–20
// minutes across, and the slower wooden trawlers, 40–50 minutes, back and forth all day. On the 1:3 map the way
// is a third as long, so at their real speeds they cross in a third of the time. They keep to water deep
// enough at low tide (world/navigation.ts); at low water the jetty's head stands over the mud and they wait
// out in the channel where the water still floats them (the Daily Star, 2010). Speeds and the time they lie
// at each end are [মডেল].

/** Bed (m about MSL) the ferries' way keeps to: afloat but at the lowest tides (when they wait for the water). */
const ROUTE_BED = -1.5;
/** Water (m) a ferry needs under her to come in to a landing. */
const DRAFT = 0.9;

type Kind = 'speedboat' | 'trawler';
const SPEED: Record<Kind, number> = { speedboat: 12, trawler: 4.5 };
/** Seconds lying at each end, loading. */
const DWELL: Record<Kind, number> = { speedboat: 70, trawler: 120 };

const SPEEDBOAT_HULL: HullShape = { len: 8.5, beam: 1.15, keelMid: -0.35, keelRise: 0.5, sheerMid: 0.55, sheerRise: 0.45 };
const TRAWLER_HULL: HullShape = { len: 13, beam: 1.9, keelMid: -0.8, keelRise: 1.3, sheerMid: 0.9, sheerRise: 1.5 };

interface Ferry {
  kind: Kind;
  root: Group;
  hull: HullShape;
  /** Where she is along the route (m from Gorakghata's end), and which way she goes (+1 out, −1 back). */
  s: number;
  dir: 1 | -1;
  /** Seconds left lying at a landing. */
  wait: number;
  speed: number;
  ride: Float32Array;
}

const RIDE = { heave: [1.0, 0.4], pitch: [0.8, 0.35], roll: [0.6, 0.25] } as const;

export class Ferries {
  readonly group = new Group();
  private readonly route: { x: number; z: number }[];
  private readonly lengths: number[] = [0];
  private readonly ferries: Ferry[] = [];
  private readonly waves: HullWaves = { heave: 0, along: 0, across: 0 };
  /** Where each end's landing is, at the water's level it was last worked out for (it moves with the tide). */
  private readonly landings = { level: Number.NaN, out: 0, back: 0 };

  constructor() {
    this.group.name = 'ferries';
    const j = GORAKGHATA.jetty;
    const ghat = place('kastura-ghat').world;
    this.route = [{ x: j.toX, z: j.toZ }, ...(waterRoute(j.toX, j.toZ, ghat.x, ghat.z, ROUTE_BED) ?? []), { x: ghat.x, z: ghat.z }];
    for (let k = 1; k < this.route.length; k++) this.lengths.push(this.lengths[k - 1] + Math.hypot(this.route[k].x - this.route[k - 1].x, this.route[k].z - this.route[k - 1].z));
    const total = this.lengths[this.lengths.length - 1];

    const hullMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), { grime: 0.2 });
    const woodMat = patchMaterial(new MeshStandardMaterial({ map: plankTexture(91), vertexColors: true, roughness: 0.85, side: DoubleSide }), { grime: 0.35 });
    const canopyMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: DoubleSide }), { translucency: 0.4 });
    const clothMat = patchMaterial(new MeshStandardMaterial({ color: '#c9c2b0', roughness: 0.9 }), {});
    const skinMat = patchMaterial(new MeshStandardMaterial({ color: '#8d5a3b', roughness: 0.65 }), {});
    const body = new CapsuleGeometry(0.17, 0.32, 3, 8);
    const head = new SphereGeometry(0.1, 8, 6);
    const person = (parent: Group, x: number, y: number, z: number) => {
      const t = new Mesh(body, clothMat);
      t.position.set(x, y + 0.3, z);
      const h = new Mesh(head, skinMat);
      h.position.set(x, y + 0.7, z);
      parent.add(t, h);
    };

    const speedboat = () => {
      const root = new Group();
      const b = new MeshBuilder();
      buildHull(b, SPEEDBOAT_HULL, { tar: rgb('#e8e6e0'), top: rgb('#f4f2ec') });
      root.add(new Mesh(b.build(), hullMat));
      // a stripe of colour along her, a blue canopy over the benches, the outboard at her stern
      const c = new MeshBuilder();
      const canopy: RGB = rgb('#2f5f9a');
      c.add(new BoxGeometry(2.0, 0.05, 4.2), new Matrix4(), canopy);
      const canopyMesh = new Mesh(c.build(), canopyMat);
      canopyMesh.position.set(0, 1.55, -0.2);
      root.add(canopyMesh);
      for (const [x, z] of [
        [-0.95, 1.8],
        [0.95, 1.8],
        [-0.95, -2.2],
        [0.95, -2.2],
      ]) {
        const post = new Mesh(new CylinderGeometry(0.025, 0.025, 1.2, 5), clothMat);
        post.position.set(x, 0.95, z);
        root.add(post);
      }
      const motor = new Mesh(new BoxGeometry(0.35, 0.6, 0.4), new MeshStandardMaterial({ color: '#202224', roughness: 0.4 }));
      motor.position.set(0, 0.55, -4.35);
      root.add(motor);
      for (let k = 0; k < 8; k++) person(root, k % 2 ? 0.45 : -0.45, 0.35, 1.4 - Math.floor(k / 2) * 0.95);
      return root;
    };
    const trawler = () => {
      const root = new Group();
      const b = new MeshBuilder();
      buildHull(b, TRAWLER_HULL, { tar: rgb('#2a2018'), top: rgb('#7a3a2a') });
      root.add(new Mesh(b.build(), woodMat));
      // the wheelhouse aft, painted; a flag
      const w = new MeshBuilder();
      w.add(new BoxGeometry(2.2, 1.8, 2.6), new Matrix4(), rgb('#3b6e8f'));
      const house = new Mesh(w.build(), canopyMat);
      house.position.set(0, 1.7, -3.2);
      root.add(house);
      const roof = new Mesh(new BoxGeometry(2.6, 0.1, 3.0), canopyMat);
      roof.position.set(0, 2.65, -3.2);
      root.add(roof);
      for (let k = 0; k < 10; k++) person(root, k % 2 ? 0.6 : -0.6, 0.75, 4.2 - Math.floor(k / 2) * 1.1);
      return root;
    };

    const add = (kind: Kind, s: number, dir: 1 | -1) => {
      const root = kind === 'speedboat' ? speedboat() : trawler();
      root.traverse((o) => {
        if ((o as Mesh).isMesh) (o as Mesh).receiveShadow = true;
      });
      this.group.add(root);
      this.ferries.push({ kind, root, hull: kind === 'speedboat' ? SPEEDBOAT_HULL : TRAWLER_HULL, s, dir, wait: 0, speed: 0, ride: new Float32Array(6) });
    };
    add('speedboat', total * 0.2, 1);
    add('speedboat', total * 0.65, -1);
    add('trawler', total * 0.45, 1);
  }

  /** The route's point `s` m along it, and its heading there. */
  private at(s: number): { x: number; z: number; heading: number } {
    const L = this.lengths;
    const r = this.route;
    let k = 1;
    while (k < L.length - 1 && L[k] < s) k++;
    const t = (s - L[k - 1]) / Math.max(1e-6, L[k] - L[k - 1]);
    const a = r[k - 1];
    const b = r[k];
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading: Math.atan2(b.x - a.x, b.z - a.z) };
  }

  /** How far along the route toward its end `dir` she can come in now, worked out again as the tide moves. */
  private landing(dir: 1 | -1): number {
    const l = this.landings;
    if (!(Math.abs(G.uWaterLevel.value - l.level) < 0.05)) {
      l.level = G.uWaterLevel.value;
      l.out = this.reach(1);
      l.back = this.reach(-1);
    }
    return dir > 0 ? l.out : l.back;
  }

  /** The last point toward the route's end `dir` with water enough under her. */
  private reach(dir: 1 | -1): number {
    const total = this.lengths[this.lengths.length - 1];
    const level = G.uWaterLevel.value;
    // walk in from the open water toward that end until the bed comes up
    let s = total * 0.5;
    const step = 5;
    for (;;) {
      const next = s + dir * step;
      if (next < 0 || next > total) return Math.max(0, Math.min(total, next));
      const p = this.at(next);
      if (level - terrainHeight(p.x, p.z) < DRAFT) return s;
      s = next;
    }
  }

  /** Where each ferry is (for the debug readout): kind, place, how far along, and whether she lies at a landing. */
  get state(): { kind: Kind; x: number; z: number; s: number; waiting: boolean }[] {
    return this.ferries.map((f) => ({ kind: f.kind, x: Math.round(f.root.position.x), z: Math.round(f.root.position.z), s: Math.round(f.s), waiting: f.wait > 0 }));
  }

  /** The route's length (m) and its points, for the debug readout. */
  get way(): { length: number; points: number } {
    return { length: Math.round(this.lengths[this.lengths.length - 1]), points: this.route.length };
  }

  update(dt: number, t: number): void {
    const h = Math.min(dt, 1 / 20);
    for (const f of this.ferries) {
      const want = SPEED[f.kind];
      if (f.wait > 0) {
        f.wait -= dt;
        f.speed = 0;
        if (f.wait <= 0) f.dir = f.dir > 0 ? -1 : 1;
      } else {
        const end = this.landing(f.dir);
        const left = (end - f.s) * f.dir;
        // slowing as she comes in, and lying there once in
        f.speed += (Math.min(want, Math.max(0.6, left * 0.25)) - f.speed) * Math.min(1, h * 0.8);
        f.s += f.dir * f.speed * dt;
        if (left <= 1) {
          f.s = end;
          f.wait = DWELL[f.kind];
        }
      }
      const p = this.at(f.s);
      const heading = p.heading + (f.dir < 0 ? Math.PI : 0);
      const waves = hullWaves(p.x, p.z, heading, f.hull.len * 0.8, f.hull.beam * 1.7, t, 1, this.waves);
      const r = f.ride;
      const follow = (i: number, target: number, [fr, zeta]: readonly [number, number]) => {
        const wn = fr * Math.PI * 2;
        r[i + 1] += (wn * wn * (target - r[i]) - 2 * zeta * wn * r[i + 1]) * h;
        r[i] += r[i + 1] * h;
      };
      // a speedboat at speed rides up on her hull, bow high
      const planing = f.kind === 'speedboat' ? Math.min(1, f.speed / 8) : 0;
      follow(0, waves.heave + planing * 0.15, RIDE.heave);
      follow(2, -waves.along - planing * 0.07, RIDE.pitch);
      follow(4, waves.across, RIDE.roll);
      f.root.position.set(p.x, G.uWaterLevel.value + r[0], p.z);
      f.root.rotation.set(r[2], heading, r[4], 'YXZ');
    }
  }
}
