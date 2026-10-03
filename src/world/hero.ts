import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { BufferGeometry } from 'three';
import { MeshBuilder, rgb, taperedTube } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { checkTexture, plankTexture, weaveTexture } from '../render/textures';
import { HERO_HULL, buildHull, hullHalfWidthAt, hullStation, sheerLine } from './hull';

const Z_AXIS = new Vector3(0, 0, 1);
const Y_AXIS = new Vector3(0, 1, 0);
const sAt = (z: number) => z / HERO_HULL.len + 0.5;

/** Oar pivot on the starboard quarter, and the shaft's rest direction (handle → blade, into the water astern). */
const OAR_PIVOT = new Vector3(0.4, 0.98, -3.55);
const OAR_REST = new Vector3(0.45, -0.5, -1).normalize();
const OAR_INBOARD = 1.25;
const STROKE_SECONDS = 3.4;

function hullGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  buildHull(b, HERO_HULL, { tar: rgb('#2c2119'), top: rgb('#6a5440'), band: rgb('#2d4f7a') });
  const rail = rgb('#4a3a2a');
  for (const side of [-1, 1] as const) {
    const line = sheerLine(HERO_HULL, side);
    taperedTube(b, line, line.map(() => 0.035), 4, rail);
  }
  // floorboards just above the waterline, and a raised platform at the stern for the boatman
  const plank = rgb('#8a7458');
  const deck = (s0: number, s1: number, y: number) => {
    const start = b.vertexCount;
    const n = new Vector3(0, 1, 0);
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const s = s0 + ((s1 - s0) * i) / steps;
      const w = hullHalfWidthAt(HERO_HULL, s, y) * 0.96;
      const z = (s - 0.5) * HERO_HULL.len;
      b.vertex(new Vector3(-w, y, z), n, z * 0.6, 0, plank);
      b.vertex(new Vector3(w, y, z), n, z * 0.6, w * 1.4, plank);
    }
    for (let i = 0; i < steps; i++) b.quad(start + i * 2, start + i * 2 + 2, start + i * 2 + 3, start + i * 2 + 1);
  };
  deck(0.26, 0.86, 0.1);
  deck(0.08, 0.26, 0.3);
  for (const s of [0.3, 0.72]) {
    const w = hullHalfWidthAt(HERO_HULL, s, 0.42) * 2;
    b.add(new BoxGeometry(w, 0.05, 0.22), new Matrix4().makeTranslation(0, 0.42, (s - 0.5) * HERO_HULL.len), plank);
  }
  return b.build();
}

/** The chhoi: a woven bamboo half-barrel over the middle of the boat. */
function canopyGeometry(z0: number, z1: number): BufferGeometry {
  const b = new MeshBuilder();
  const Z = 8;
  const A = 16;
  for (let i = 0; i <= Z; i++) {
    const z = z0 + ((z1 - z0) * i) / Z;
    const s = sAt(z);
    const { sheer } = hullStation(HERO_HULL, s);
    const R = hullHalfWidthAt(HERO_HULL, s, sheer - 0.02) * 0.98;
    for (let j = 0; j <= A; j++) {
      const th = (j / A) * Math.PI;
      const n = new Vector3(Math.cos(th), Math.sin(th), 0);
      b.vertex(new Vector3(R * Math.cos(th), sheer + R * 0.95 * Math.sin(th), z), n, (th * R) / 0.45, z / 0.45);
    }
  }
  for (let i = 0; i < Z; i++) {
    for (let j = 0; j < A; j++) {
      const a = i * (A + 1) + j;
      b.quad(a, a + 1, a + A + 2, a + A + 1);
    }
  }
  return b.build();
}

function solveArm(shoulder: Vector3, target: Vector3, upper: number, lower: number, pole: Vector3, elbow: Vector3, hand: Vector3): void {
  const d = target.clone().sub(shoulder);
  let len = d.length();
  const reach = (upper + lower) * 0.999;
  if (len > reach) {
    d.multiplyScalar(reach / len);
    len = reach;
  }
  const dir = d.clone().normalize();
  hand.copy(shoulder).add(d);
  const x = (upper * upper - lower * lower + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(upper * upper - x * x, 0));
  const bend = pole.clone().sub(shoulder);
  bend.addScaledVector(dir, -bend.dot(dir)).normalize();
  elbow.copy(shoulder).addScaledVector(dir, x).addScaledVector(bend, h);
}

const tmpDir = new Vector3();

/** Lays a Y-aligned limb mesh (unit length) between two points. */
function limb(mesh: Mesh, a: Vector3, b: Vector3, baseLength: number): void {
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  tmpDir.copy(b).sub(a);
  const len = tmpDir.length();
  mesh.quaternion.setFromUnitVectors(Y_AXIS, tmpDir.normalize());
  mesh.scale.set(1, len / baseLength, 1);
}

export class HeroBoat {
  readonly group = new Group();
  readonly lantern: PointLight;
  /** 0..1 through one oar stroke. */
  stroke = 0;
  /** Fired once per stroke when the blade bites (for the splash sound). */
  onStroke: (() => void) | null = null;

  private readonly glass: MeshStandardMaterial;
  private readonly oar = new Group();
  private readonly man = new Group();
  private readonly torso = new Group();
  private readonly arms: { upper: Mesh; fore: Mesh; hand: Mesh; side: 1 | -1 }[] = [];
  private readonly lanternBase = new Vector3();
  private lastStroke = 0;

  constructor() {
    const g = this.group;
    g.name = 'hero-boat';
    const hullMat = patchMaterial(
      new MeshStandardMaterial({ map: plankTexture(51), vertexColors: true, roughness: 0.82, side: DoubleSide }),
      { grime: 0.25 },
    );
    g.add(new Mesh(hullGeometry(), hullMat));

    const cz0 = (0.38 - 0.5) * HERO_HULL.len;
    const cz1 = (0.66 - 0.5) * HERO_HULL.len;
    const weave = patchMaterial(new MeshStandardMaterial({ map: weaveTexture(52), roughness: 0.9, side: DoubleSide }), {
      translucency: 0.3,
    });
    g.add(new Mesh(canopyGeometry(cz0, cz1), weave));
    const ribMat = patchMaterial(new MeshStandardMaterial({ color: '#5a4630', roughness: 0.85 }), {});
    for (const z of [cz0, (cz0 + cz1) / 2, cz1]) {
      const s = sAt(z);
      const { sheer } = hullStation(HERO_HULL, s);
      const R = hullHalfWidthAt(HERO_HULL, s, sheer - 0.02) * 0.98;
      const rib = new Mesh(new TorusGeometry(R, 0.03, 5, 18, Math.PI), ribMat);
      rib.position.set(0, sheer, z);
      rib.scale.set(1, 0.95, 1);
      g.add(rib);
    }

    // cargo in the bow: jute sacks and a clay pot
    const jute = patchMaterial(new MeshStandardMaterial({ color: '#9c8656', roughness: 0.95 }), { grime: 0.4 });
    for (const [x, z, s] of [[-0.25, 2.1, 1], [0.22, 2.35, 0.9], [0, 2.75, 0.8]] as const) {
      const sack = new Mesh(new SphereGeometry(0.32, 10, 8), jute);
      sack.position.set(x, 0.3, z);
      sack.scale.set(s, 0.6 * s, 1.15 * s);
      g.add(sack);
    }
    const pot = new Mesh(
      new LatheGeometry([new Vector2(0.01, 0), new Vector2(0.14, 0.02), new Vector2(0.22, 0.16), new Vector2(0.17, 0.32), new Vector2(0.09, 0.38), new Vector2(0.11, 0.42)], 14),
      patchMaterial(new MeshStandardMaterial({ color: '#9a5a3a', roughness: 0.8 }), { grime: 0.3 }),
    );
    pot.position.set(0.3, 0.1, 1.75);
    g.add(pot);

    // hurricane lantern hung from the front arch of the chhoi
    const { sheer } = hullStation(HERO_HULL, sAt(cz1));
    const R = hullHalfWidthAt(HERO_HULL, sAt(cz1), sheer - 0.02) * 0.98;
    this.lanternBase.set(0, sheer + R * 0.95 - 0.32, cz1 + 0.14);
    const metal = new MeshStandardMaterial({ color: '#3a3630', roughness: 0.5, metalness: 0.6 });
    this.glass = new MeshStandardMaterial({ color: '#ffe2b0', emissive: new Color('#ffb257'), emissiveIntensity: 0, roughness: 0.15 });
    const lantern = new Group();
    lantern.position.copy(this.lanternBase);
    const base = new Mesh(new CylinderGeometry(0.07, 0.075, 0.05, 12), metal);
    const glass = new Mesh(new CylinderGeometry(0.055, 0.065, 0.13, 12), this.glass);
    glass.position.y = 0.09;
    const cap = new Mesh(new ConeGeometry(0.075, 0.07, 12), metal);
    cap.position.y = 0.19;
    const wire = new Mesh(new CylinderGeometry(0.004, 0.004, 0.14, 4), metal);
    wire.position.y = 0.29;
    lantern.add(base, glass, cap, wire);
    g.add(lantern);
    this.lantern = new PointLight('#ffb066', 0, 26, 2);
    this.lantern.position.copy(this.lanternBase).add(new Vector3(0, 0.1, 0.05));
    g.add(this.lantern);

    this.buildOar();
    this.buildBoatman();
  }

  private buildOar(): void {
    const wood = patchMaterial(new MeshStandardMaterial({ color: '#6b5236', roughness: 0.8 }), { grime: 0.3 });
    const length = OAR_INBOARD + 3.1;
    const shaft = new Mesh(new CylinderGeometry(0.03, 0.035, length, 6), wood);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = length / 2 - OAR_INBOARD;
    const blade = new Mesh(new BoxGeometry(0.03, 0.26, 0.85), wood);
    blade.position.z = length - OAR_INBOARD - 0.35;
    this.oar.add(shaft, blade);
    this.oar.position.copy(OAR_PIVOT);
    this.group.add(this.oar);
  }

  private buildBoatman(): void {
    const skin = patchMaterial(new MeshStandardMaterial({ color: '#5e3c28', roughness: 0.62 }), { translucency: 0.25 });
    const lungi = patchMaterial(new MeshStandardMaterial({ map: checkTexture('#2c4a86', '#e8e2d2', '#16244a'), roughness: 0.9, side: DoubleSide }), {});
    const vest = patchMaterial(new MeshStandardMaterial({ color: '#d4ccba', roughness: 0.9 }), { grime: 0.2 });
    const gamchha = patchMaterial(new MeshStandardMaterial({ map: checkTexture('#a8342a', '#efe6d6', '#5a1410'), roughness: 0.9 }), {});
    const m = this.man;
    m.position.set(-0.08, 0.32, -2.95);

    for (const x of [-0.1, 0.1]) {
      const shin = new Mesh(new CylinderGeometry(0.05, 0.042, 0.46, 7), skin);
      shin.position.set(x, 0.23, 0);
      const foot = new Mesh(new BoxGeometry(0.09, 0.05, 0.22), skin);
      foot.position.set(x, 0.025, 0.05);
      m.add(shin, foot);
    }
    const wrap = new Mesh(new CylinderGeometry(0.17, 0.22, 0.62, 14, 1, true), lungi);
    wrap.position.y = 0.72;
    m.add(wrap);

    // the torso pivots at the hips so the whole upper body can lean into the stroke
    this.torso.position.y = 1.0;
    const chest = new Mesh(new CapsuleGeometry(0.15, 0.28, 4, 10), vest);
    chest.position.y = 0.24;
    chest.scale.set(1.15, 1, 0.8);
    const neck = new Mesh(new CylinderGeometry(0.045, 0.05, 0.1, 7), skin);
    neck.position.y = 0.52;
    const head = new Mesh(new SphereGeometry(0.105, 12, 10), skin);
    head.position.y = 0.66;
    head.scale.set(0.92, 1.05, 1);
    const turban = new Mesh(new TorusGeometry(0.095, 0.035, 6, 16), gamchha);
    turban.position.y = 0.72;
    turban.rotation.x = Math.PI / 2;
    this.torso.add(chest, neck, head, turban);
    m.add(this.torso);

    for (const side of [-1, 1] as const) {
      const upper = new Mesh(new CapsuleGeometry(0.042, 0.22, 3, 7), skin);
      const fore = new Mesh(new CapsuleGeometry(0.038, 0.2, 3, 7), skin);
      const hand = new Mesh(new SphereGeometry(0.045, 7, 5), skin);
      m.add(upper, fore, hand);
      this.arms.push({ upper, fore, hand, side });
    }
    this.group.add(m);
  }

  setShadows(cast: boolean): void {
    this.group.traverse((o) => {
      if ((o as Mesh).isMesh) {
        const mesh = o as Mesh;
        mesh.castShadow = cast;
        mesh.receiveShadow = true;
      }
    });
  }

  update(t: number, lamp: number): void {
    this.stroke = (t / STROKE_SECONDS) % 1;
    const ph = this.stroke * Math.PI * 2;
    if (this.stroke < this.lastStroke && this.onStroke) this.onStroke();
    this.lastStroke = this.stroke;

    // the blade sweeps side to side astern; the handle swings the opposite way at the boatman's chest
    const sweep = 0.32 * Math.sin(ph);
    const dir = OAR_REST.clone().applyAxisAngle(Y_AXIS, sweep);
    dir.y -= 0.05 * Math.cos(ph);
    dir.normalize();
    this.oar.quaternion.setFromUnitVectors(Z_AXIS, dir);
    const handle = OAR_PIVOT.clone().addScaledVector(dir, -OAR_INBOARD);
    const grip2 = handle.clone().addScaledVector(dir, 0.32);

    // body follows the handle: face it, lean into the push, shift weight from foot to foot
    const m = this.man;
    m.position.x = -0.08 + (handle.x + 0.075) * 0.35;
    m.rotation.y = Math.atan2(handle.x - m.position.x, handle.z - m.position.z) * 0.6;
    this.torso.rotation.z = -sweep * 0.3;
    this.torso.rotation.x = 0.12 + 0.07 * Math.sin(ph + Math.PI / 2);
    m.updateMatrix();
    this.torso.updateMatrix();

    const toMan = new Matrix4().copy(m.matrix).invert();
    const hl = handle.clone().applyMatrix4(toMan);
    const h2 = grip2.clone().applyMatrix4(toMan);
    const torsoM = this.torso.matrix;
    const elbow = new Vector3();
    const hand = new Vector3();
    for (const arm of this.arms) {
      const shoulder = new Vector3(arm.side * 0.19, 0.42, 0).applyMatrix4(torsoM);
      const pole = shoulder.clone().add(new Vector3(arm.side * 0.4, -0.5, -0.15));
      solveArm(shoulder, arm.side > 0 ? hl : h2, 0.29, 0.27, pole, elbow, hand);
      limb(arm.upper, shoulder, elbow, 0.22 + 0.084);
      limb(arm.fore, elbow, hand, 0.2 + 0.076);
      arm.hand.position.copy(hand);
    }

    const flicker = 0.9 + 0.06 * Math.sin(t * 13.1) + 0.04 * Math.sin(t * 29.7 + 1.3);
    this.glass.emissiveIntensity = lamp * 3.2 * flicker;
    // intensity only: switching the light off would change the light count and recompile every material
    this.lantern.intensity = lamp * 5.5 * flicker;
  }
}
