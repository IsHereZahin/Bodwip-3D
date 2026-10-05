import { BoxGeometry, ConeGeometry, CylinderGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, TorusGeometry, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { windAt } from '../env/wind';
import { MeshBuilder, rgb, scaleRgb } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { softSpotTexture } from '../render/textures';
import { Boatman, type Outfit, type OarPose } from './boatman';
import { journeyAt, terrainHeight } from './geography';
import type { BodyDrive } from './paddle';

// The aman harvest in Hemanta: on the edge of a field of ripe rice by the boat's way (the film's, rig/tour.ts
// cropField), two men bent to it with sickles (কাস্তে), as the paddy is still cut by hand: each reaches into
// the stalks and takes a handful in his left hand, draws the sickle through below it, and straightens a little
// with the cut bunch; the sheaves (আঁটি) they have tied lie on the bund behind them, and some stand in a stook.
// They are the boatman's body (human.ts) in their own clothes; they are there only while the rice stands ripe.

/** One cut: reaching into the stalks, the sickle drawn through, the bunch drawn back (s). */
const CUT = 2.6;
const OUTFITS: readonly Outfit[] = [
  { lungi: ['#6a4a2a', '#d2c4a0', '#33220f'], vest: '#d8d0bc', gamchha: ['#2d5a8a', '#e8e2d2', '#16244a'], seed: 101 },
  { lungi: ['#2f5a3a', '#cfc6a8', '#173a1f'], vest: '#c8bfa8', gamchha: ['#a8342a', '#efe6d6', '#5a1410'], seed: 103 },
];
const UP = new Vector3(0, 1, 0);
const STRAW = rgb('#b8954a');
const HEADS = rgb('#c9a24a');

/** A sheaf: a bundle of cut stalks tied at its waist, the heads fanned at one end; lying along +z, its butt at the origin. */
function sheaf(b: MeshBuilder, at: Matrix4, rng: Rng): void {
  const len = rng.range(0.75, 0.95);
  const shade = rng.range(0.85, 1.08);
  // the stalks, cut square at the butt
  b.add(new CylinderGeometry(0.07, 0.06, len * 0.62, 7).rotateX(Math.PI / 2).translate(0, 0.07, len * 0.31), at, scaleRgb(STRAW, shade));
  // the heads: tufts of ripe grain splaying from the top, each drooping a little
  const tuft = new ConeGeometry(0.035, len * 0.42, 5).rotateX(-Math.PI / 2);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const spread = rng.range(0.25, 0.45);
    const m = new Matrix4().compose(
      new Vector3(Math.cos(a) * 0.04, 0.07 + Math.sin(a) * 0.04, len * 0.62 + len * 0.18),
      new Quaternion().setFromAxisAngle(new Vector3(-Math.sin(a), Math.cos(a), 0), spread).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.12)),
      new Vector3(1, 1, 1),
    );
    b.add(tuft, at.clone().multiply(m), scaleRgb(HEADS, shade * rng.range(0.9, 1.08)));
  }
  b.add(new TorusGeometry(0.068, 0.012, 4, 10).translate(0, 0.07, len * 0.42), at, rgb('#6b5226'));
}

/** A man cutting rice: his body on its feet at the edge of the crop, his sickle, the bunch in his left hand. */
class Reaper {
  readonly group = new Group();
  private readonly man: Boatman;
  private readonly sickle: Group;
  private readonly bunch: Mesh;
  private readonly drive: BodyDrive = { twist: 0, bend: 0.9, lean: 0, crouch: 0.12, shift: 0.06 };
  private readonly pose: OarPose = {
    holds: [
      { at: new Vector3(), thumb: new Vector3(0, 0, 1) },
      { at: new Vector3(), thumb: new Vector3(0, 1, 0) },
    ],
  };
  private readonly tilt = { rotX: 0, rotZ: 0 };
  private readonly wind = new Vector3();
  private readonly gravity = new Vector3(0, -9.81, 0);
  private readonly air = { x: 0, z: 0 };
  private readonly offset: number;

  constructor(outfit: Outfit, offset: number, straw: MeshStandardMaterial, iron: MeshStandardMaterial, wood: MeshStandardMaterial) {
    this.offset = offset;
    this.man = new Boatman(new Vector3(0, 0, 0), [0.016, 0.03], outfit);
    // the sickle: a short wooden handle and its thin crescent blade
    this.sickle = new Group();
    this.sickle.add(new Mesh(new CylinderGeometry(0.016, 0.018, 0.12, 6).translate(0, 0, 0), wood));
    const blade = new MeshBuilder();
    for (let k = 0; k < 7; k++) {
      const a = (k / 6) * Math.PI * 0.85;
      blade.add(new BoxGeometry(0.05, 0.004, 0.012), new Matrix4().compose(new Vector3(Math.sin(a) * 0.12, 0.06 + (1 - Math.cos(a)) * 0.12 - 0.02, 0), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -a), new Vector3(1, 1, 1)), rgb('#5a5a58'));
    }
    this.sickle.add(new Mesh(blade.build(), iron));
    // the cut bunch in his left hand
    this.bunch = new Mesh(new CylinderGeometry(0.05, 0.035, 0.55, 6, 1, true).translate(0, 0.1, 0), straw);
    const shadow = new Mesh(
      new PlaneGeometry(1.0, 0.9).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: softSpotTexture(), transparent: true, depthWrite: false, color: '#000000', opacity: 0.45 }),
    );
    shadow.position.set(0, 0.03, 0.2);
    this.group.add(this.man.group, this.sickle, this.bunch, shadow);
    this.group.traverse((o) => {
      o.castShadow = false;
      o.layers.set(LAYER_NO_REFLECT);
    });
  }

  update(dt: number, t: number): void {
    const f = ((t / CUT + this.offset) % 1 + 1) % 1;
    const reach = smoothstep(0, 0.35, f) * (1 - smoothstep(0.5, 0.9, f));
    const cut = smoothstep(0.35, 0.5, f);
    const back = smoothstep(0.5, 0.9, f);
    const [right, left] = this.pose.holds;
    // the left hand into the stalks and back with the bunch
    left.at.set(0.12, 0.72 - 0.3 * reach + 0.04 * back, 0.32 + 0.3 * reach);
    // the sickle ready under it, drawn through across, back to his side
    const sweep = cut * (1 - back);
    right.at.set(-0.2 + 0.36 * sweep + 0.06 * reach, 0.7 - 0.28 * reach - 0.04 * sweep, 0.34 + 0.24 * Math.max(reach, sweep));
    right.thumb.set(0.3 * (1 - sweep), 0.2, 1).normalize();
    this.drive.bend = 0.75 + 0.28 * Math.max(reach, sweep);
    this.drive.crouch = 0.1 + 0.05 * reach;
    this.drive.twist = -0.12 + 0.18 * sweep;
    const g = this.group;
    windAt(g.position.x, g.position.z, this.air);
    const c = Math.cos(g.rotation.y);
    const s = Math.sin(g.rotation.y);
    this.wind.set(this.air.x * c - this.air.z * s, 0, this.air.x * s + this.air.z * c);
    this.man.update(dt, t, this.drive, this.pose, this.tilt, this.wind, this.gravity);
    this.sickle.position.copy(right.at);
    this.sickle.quaternion.setFromUnitVectors(UP, right.thumb);
    this.bunch.position.copy(left.at);
    this.bunch.visible = f > 0.42;
    this.bunch.rotation.set(0.3 * back, 0, 0);
  }
}

/** The reapers and their sheaves on the edge of a field by the boat's way: `s` along it, `side`, the field beginning `edge` m out. */
export class Harvest {
  readonly group = new Group();
  private readonly reapers: Reaper[] = [];
  private readonly at: Vector3;

  constructor(field: { s: number; side: 1 | -1; edge: number }) {
    this.group.name = 'harvest';
    const rng = new Rng(707);
    const straw = patchMaterial(new MeshStandardMaterial({ color: '#c09a4e', roughness: 0.9 }), { grime: 0.2 });
    const iron = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.5 }), {});
    const wood = patchMaterial(new MeshStandardMaterial({ color: '#6b5236', roughness: 0.85 }), { grime: 0.3 });
    const sheaves = new MeshBuilder();
    const p = journeyAt(field.s);
    const nx = Math.cos(p.heading) * field.side;
    const nz = -Math.sin(p.heading) * field.side;
    const ax = Math.sin(p.heading);
    const az = Math.cos(p.heading);
    this.at = new Vector3(p.x + nx * field.edge, 0, p.z + nz * field.edge);
    // two men a few steps apart along the field's edge, ahead of the camera's own place on it, facing into the rice
    [5, 10.5].forEach((along, i) => {
      const x = this.at.x + ax * along + nx * 1.2;
      const z = this.at.z + az * along + nz * 1.2;
      const r = new Reaper(OUTFITS[i % OUTFITS.length], i * 0.43, straw, iron, wood);
      r.group.position.set(x, terrainHeight(x, z), z);
      r.group.rotation.y = Math.atan2(nx, nz) + (i ? -0.25 : 0.2);
      this.group.add(r.group);
      this.reapers.push(r);
      // the sheaves he has tied, lying behind him on the bund
      for (let k = 0; k < 6; k++) {
        const sx = x - nx * rng.range(1.2, 3.2) + ax * rng.range(-2, 2);
        const sz = z - nz * rng.range(1.2, 3.2) + az * rng.range(-2, 2);
        sheaf(sheaves, new Matrix4().compose(new Vector3(sx, terrainHeight(sx, sz), sz), new Quaternion().setFromAxisAngle(UP, rng.range(0, Math.PI * 2)), new Vector3(1, 1, 1)), rng);
      }
    });
    // a stook: sheaves stood together, heads up
    const sx = this.at.x + ax * 16 - nx * 1.5;
    const sz = this.at.z + az * 16 - nz * 1.5;
    const sy = terrainHeight(sx, sz);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const m = new Matrix4().compose(
        new Vector3(sx + Math.cos(a) * 0.32, sy, sz + Math.sin(a) * 0.32),
        new Quaternion().setFromAxisAngle(UP, -a + Math.PI / 2).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2 + 0.3)),
        new Vector3(1, 1, 1),
      );
      sheaf(sheaves, m, rng);
    }
    const sheafMesh = new Mesh(sheaves.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), { grime: 0.25 }));
    sheafMesh.castShadow = true;
    sheafMesh.receiveShadow = true;
    this.group.add(sheafMesh);
    this.group.visible = false;
  }

  /** `ripe`: the season's share of ripe fields (env/season.ts crops[2]); they are out only while it stands. */
  update(dt: number, t: number, eye: Vector3, ripe: number): void {
    this.group.visible = ripe > 0.35;
    if (!this.group.visible || Math.hypot(eye.x - this.at.x, eye.z - this.at.z) > 250) return;
    for (const r of this.reapers) r.update(dt, t);
  }
}
