import { BufferGeometry, Matrix4, SphereGeometry, Vector3 } from 'three';
import { MeshBuilder, type RGB } from '../render/builder';

// The boatman's limbs and hands as geometry. Limbs run along +y from their joint; a hand is built closed
// round a bar, in the bar's frame: the bar along x through the origin, the fingers wrapping it. Every
// surface here is wound outward, so the skin stays single-sided.

const WHITE: RGB = [1, 1, 1];
const KNUCKLE: RGB = [0.84, 0.82, 0.82];
const NAIL: RGB = [1.5, 1.32, 1.22];
/** The palms and the insides of the fingers are paler than the backs of the hands. */
const PALMAR: RGB = [1.32, 1.16, 1.08];

interface SweepRing {
  c: Vector3;
  /** The ring's two axes (perpendicular) and its half-widths along them. */
  x: Vector3;
  z: Vector3;
  rx: number;
  rz: number;
}

/** A tube through elliptical rings, wound outward whichever way its rings' axes turn. */
function sweep(b: MeshBuilder, rings: readonly SweepRing[], radial: number, color: (ring: number, a: number) => RGB): void {
  const along = new Vector3().subVectors(rings[1].c, rings[0].c);
  const turn = new Vector3().crossVectors(rings[0].x, rings[0].z).dot(along);
  const p = new Vector3();
  const n = new Vector3();
  const starts: number[] = [];
  rings.forEach((r, i) => {
    starts.push(b.vertexCount);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      p.copy(r.c).addScaledVector(r.x, cs * r.rx).addScaledVector(r.z, sn * r.rz);
      n.copy(r.x).multiplyScalar(cs / r.rx).addScaledVector(r.z, sn / r.rz).normalize();
      b.vertex(p, n, j / radial, i, color(i, a));
    }
  });
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = starts[i] + j;
      const c = starts[i + 1] + j;
      if (turn < 0) b.quad(a, c, c + 1, a + 1);
      else b.quad(a, a + 1, c + 1, c);
    }
  }
}

const unitSphere = new SphereGeometry(1, 10, 8);

/** An ellipsoid, its axes `basis`'s columns scaled by `radii`. */
function blob(b: MeshBuilder, at: Vector3, basis: Matrix4, radii: Vector3, color: RGB = WHITE): void {
  const m = new Matrix4().makeTranslation(at.x, at.y, at.z).multiply(basis).multiply(new Matrix4().makeScale(radii.x, radii.y, radii.z));
  b.add(unitSphere, m, color);
}

/** A round limb along +y from its joint, `length` long, with a muscle profile; `cap` rounds the joint end (a shoulder). */
export function limbGeometry(length: number, radii: readonly number[], cap = 0): BufferGeometry {
  const b = new MeshBuilder();
  const X = new Vector3(1, 0, 0);
  const Z = new Vector3(0, 0, 1);
  sweep(
    b,
    radii.map((r, i) => ({ c: new Vector3(0, (i / (radii.length - 1)) * length, 0), x: X, z: Z, rx: r, rz: r })),
    10,
    () => WHITE,
  );
  if (cap > 0) blob(b, new Vector3(0, cap * 0.45, 0), new Matrix4(), new Vector3(cap, cap * 1.2, cap * 0.95));
  return b.build();
}

/** A limb along +y whose rings are ellipses (`[y, rx, rz]`): a forearm, broad across the wrist. */
export function ellipticLimb(rings: readonly (readonly [number, number, number])[]): BufferGeometry {
  const b = new MeshBuilder();
  const X = new Vector3(1, 0, 0);
  const Z = new Vector3(0, 0, 1);
  sweep(
    b,
    rings.map(([y, rx, rz]) => ({ c: new Vector3(0, y, 0), x: X, z: Z, rx, rz })),
    12,
    () => WHITE,
  );
  return b.build();
}

/** A finger's (or thumb's) phalanges through its joints, round in section, its pad side paler. */
function digit(b: MeshBuilder, joints: readonly Vector3[], radii: readonly number[], padSide: (i: number) => Vector3): void {
  const t = new Vector3();
  const rings: SweepRing[] = joints.map((c, i) => {
    t.subVectors(joints[Math.min(i + 1, joints.length - 1)], joints[Math.max(i - 1, 0)]).normalize();
    // one axis toward the pad, so the pale side stays on the inside of the grip
    const z = padSide(i).clone().addScaledVector(t, -padSide(i).dot(t)).normalize();
    const x = new Vector3().crossVectors(z, t).normalize();
    return { c, x, z, rx: radii[i], rz: radii[i] };
  });
  sweep(b, rings, 8, (_, a) => (Math.sin(a) > 0.35 ? PALMAR : WHITE));
  joints.forEach((c, i) => {
    if (i > 0) blob(b, c, new Matrix4(), new Vector3().setScalar(radii[i]));
  });
}

/** A nail on the back of a fingertip: `tip` the end of the digit, `out` its back, `along` the way it points. */
function nail(b: MeshBuilder, tip: Vector3, out: Vector3, along: Vector3, width: number): void {
  const z = out.clone().normalize();
  const y = along.clone().addScaledVector(z, -along.dot(z)).normalize();
  const x = new Vector3().crossVectors(y, z);
  const at = tip.clone().addScaledVector(z, width * 0.62).addScaledVector(y, -0.004);
  blob(b, at, new Matrix4().makeBasis(x, y, z), new Vector3(width * 0.6, 0.0078, 0.0022), NAIL);
}

/** A lean working hand (m): from the wrist joint to the knuckles, and each finger, index to little. */
const PALM_LENGTH = 0.095;
const KNUCKLE_Y = 0.01;
const FINGERS = [
  { x: 0.025, y: 0.0, r: 0.0098, len: [0.043, 0.026, 0.02] },
  { x: 0.0075, y: 0.004, r: 0.0102, len: [0.047, 0.029, 0.021] },
  { x: -0.0095, y: 0.001, r: 0.0097, len: [0.044, 0.027, 0.021] },
  { x: -0.0255, y: -0.008, r: 0.0088, len: [0.035, 0.02, 0.019] },
] as const;
/** The palm's rings, wrist to knuckles: [y, half-width, half-thickness, shift across]. */
const PALM: readonly (readonly [number, number, number, number])[] = [
  [KNUCKLE_Y - PALM_LENGTH, 0.027, 0.0185, -0.002],
  [-0.066, 0.035, 0.019, 0],
  [-0.04, 0.041, 0.0175, 0.001],
  [-0.014, 0.0435, 0.016, 0],
  [0.004, 0.042, 0.0142, -0.001],
  [0.014, 0.033, 0.0095, -0.001],
  [0.019, 0.017, 0.0045, -0.001],
];
/** In a power grip the bar crosses the palm on a slant, from the heel of the hand to the index knuckle. */
const GRIP_SLANT = 0.3;
/** ...and the wrist is cocked back a little. */
const WRIST_EXTENSION = 0.3;

export interface HandShape {
  geometry: BufferGeometry;
  /** The wrist joint, in the bar's frame. */
  wrist: Vector3;
  /** Which way the forearm runs into the wrist, in the bar's frame. */
  fore: Vector3;
  /** Across the knuckles, in the bar's frame: the wrist's broad axis. */
  across: Vector3;
}

/**
 * A hand closed round a bar of radius `R`. In its frame the bar runs along x through the origin; a right
 * hand has its thumb toward +x, its palm against the bar's −z side and its fingers curling over the top
 * (+y) and round the front. `mirror` makes it a left hand, thumb toward −x.
 */
export function handGeometry(R: number, mirror: boolean): HandShape {
  const b = new MeshBuilder();
  // the hand's own frame (long axis +y, palm toward +z) lies on the bar at the grip's slant
  const slant = new Matrix4().makeRotationZ(-GRIP_SLANT);
  const toBar = (x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(slant);
  const handX = toBar(1, 0, 0);
  const Z = new Vector3(0, 0, 1);

  // the palm, its face flat against the bar; paler on the palm side
  sweep(
    b,
    PALM.map(([y, hw, ht, xs]) => ({ c: toBar(xs, y, -R - ht), x: handX, z: Z, rx: hw, rz: ht })),
    14,
    (_, a) => (Math.sin(a) > 0.4 ? PALMAR : WHITE),
  );
  // heel of the hand (little-finger side), and the wrist where the forearm meets it
  blob(b, toBar(-0.025, -0.048, -R - 0.013), slant, new Vector3(0.015, 0.03, 0.0125));
  const wrist = toBar(0, KNUCKLE_Y - PALM_LENGTH, -R - 0.019);
  blob(b, wrist, slant, new Vector3(0.029, 0.024, 0.0205));

  // fingers: each phalanx a chord of the circle round the bar that the finger's centre line follows
  const knuckleZ = -R - 0.0142;
  const around = (x: number, rho: number, phi: number) => new Vector3(x, rho * Math.sin(phi), -rho * Math.cos(phi));
  const outward = (p: Vector3) => new Vector3(0, p.y, p.z).normalize();
  for (const f of FINGERS) {
    const k = toBar(f.x, KNUCKLE_Y + f.y, knuckleZ);
    const rho = R + f.r * 0.95;
    const dK = Math.hypot(k.y, k.z);
    const [l1, l2, l3] = f.len;
    let phi = Math.atan2(k.y, -k.z) + Math.acos(Math.max(-1, Math.min(1, (dK * dK + rho * rho - l1 * l1) / (2 * dK * rho))));
    const joints = [k, around(k.x, rho, phi)];
    for (const l of [l2, l3]) {
      phi += 2 * Math.asin(Math.min(1, l / (2 * rho)));
      joints.push(around(k.x, rho, phi));
    }
    // the pad of each phalanx faces the bar
    digit(b, joints, [f.r * 1.02, f.r * 0.95, f.r * 0.88, f.r * 0.8], (i) => outward(joints[i]).negate());
    // the knuckle stands proud on the back of the fist
    blob(b, k.clone().add(new Vector3(0, 0, -0.005)), slant, new Vector3(f.r * 1.15, f.r * 1.1, f.r * 1.1), KNUCKLE);
    const tip = joints[3];
    nail(b, tip, outward(tip), new Vector3().subVectors(tip, joints[2]), f.r * 1.6);
  }

  // thumb: from its root by the wrist, round the near side of the bar and across its front
  const rhoT = R + 0.0105;
  const cmc = toBar(0.017, -0.068, -R - 0.016);
  const mcp = around(0.04, R + 0.017, -1.15);
  let phiT = -1.15 - 0.032 / rhoT;
  const ip = around(0.028, rhoT, phiT);
  phiT -= 0.027 / rhoT;
  const thumbTip = around(0.015, rhoT, phiT);
  const thumb = [cmc, mcp, ip, thumbTip];
  digit(b, thumb, [0.0175, 0.0125, 0.0108, 0.0095], (i) => (i === 0 ? Z.clone() : outward(thumb[i]).negate()));
  blob(b, cmc, slant, new Vector3(0.017, 0.022, 0.015));
  nail(b, thumbTip, outward(thumbTip), new Vector3().subVectors(thumbTip, ip), 0.017);

  const geometry = b.build();
  const fore = new Vector3(0, Math.cos(WRIST_EXTENSION), Math.sin(WRIST_EXTENSION)).applyMatrix4(slant);
  const across = handX.clone();
  if (mirror) {
    geometry.scale(-1, 1, 1);
    // mirroring turns every face inside out: wind them back
    const index = geometry.getIndex();
    if (index) {
      const ids = index.array;
      for (let i = 0; i < ids.length; i += 3) {
        const t = ids[i + 1];
        ids[i + 1] = ids[i + 2];
        ids[i + 2] = t;
      }
      index.needsUpdate = true;
    }
    for (const v of [wrist, fore, across]) v.x = -v.x;
  }
  return { geometry, wrist, fore, across };
}
