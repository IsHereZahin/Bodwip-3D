import { CircleGeometry, CylinderGeometry, DoubleSide, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, TorusGeometry, Vector2, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { khejurBarkTexture, khejurCutTexture } from '../render/textures';
import { terrainHeight } from './geography';
import { KHEJUR_PATH, KHEJUR_ROW } from './plan';

// The date palms (খেজুর) along the field path up from the first para, and the winter's sap (রস): each trunk
// zig-zags where it has been tapped from one side and then the other, winter after winter, its old leaf bases
// in a close diamond lattice; its crown of stiff grey-green fronds is cut back on the side the gachhi taps. In
// the cold months (late in the autumn to the end of the winter) the tapped trees have a fresh V shaved under the
// crown, a slip of bamboo driven in at its point, and a smoked clay pot (হাঁড়ি) tied under it, hung in the
// afternoon and filling through the night with the sap that drips from the spout, a drop at a time, each in its
// own time, taken down after sunrise. Near the camera the drops are seen forming, falling and ringing the sap in
// the pot. Out of season the trees stand with their scars.

const UP = new Vector3(0, 1, 0);
/** The tapping season: from this day of the year round to that one. */
const SEASON = { from: 325, to: 55 };
/** The pots are hung at this hour and taken down at that one. */
const HUNG = { from: 16.5, to: 8.75 };
/** The pot: its height and the radii of its lathe (m), and how far it hangs below the spout's tip. */
const POT = { height: 0.27, lip: 0.075, neck: 0.062, belly: 0.13 };
/** Near enough to see the drops (m). */
const DRIP_NEAR = 35;

/** A tapped tree: the spout's tip (world), the pot's mouth and its sap's floor and top, how it faces. */
interface Tap {
  tip: Vector3;
  mouth: Vector3;
  floor: number;
  out: Vector3;
  sap: Mesh;
  drop: Mesh;
  ring: Mesh;
  /** The drop now: when it began to form and how long it takes; when it fell, and where the ring is. */
  dropAt: number;
  dropFor: number;
  fallAt: number;
  ringAt: number;
}

/** The pot's profile (r, y from its foot). */
const potProfile = (): Vector2[] =>
  [
    [0.01, 0],
    [0.07, 0.008],
    [0.115, 0.05],
    [POT.belly, 0.11],
    [0.12, 0.17],
    [0.09, 0.22],
    [POT.neck, 0.245],
    [POT.lip, POT.height],
    [POT.lip - 0.008, POT.height + 0.004],
  ].map(([r, y]) => new Vector2(r, y));

/** The pot's inner radius at a height above its foot. */
function potInner(y: number): number {
  const p = potProfile();
  for (let i = 0; i + 1 < p.length; i++)
    if (y >= p[i].y && y <= p[i + 1].y) return (p[i].x + ((y - p[i].y) / (p[i + 1].y - p[i].y)) * (p[i + 1].x - p[i].x)) * 0.92;
  return POT.neck * 0.9;
}

/** A trunk's middle line and radius: a zig-zag of a year's tapping to each side, leaning a little. */
function trunkLine(rng: Rng, height: number, zig: Vector3): { pts: Vector3[]; radii: number[] } {
  const pts: Vector3[] = [];
  const radii: number[] = [];
  const lean = new Vector3(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize().multiplyScalar(rng.range(0.05, 0.25));
  const step = 0.42;
  const n = Math.ceil(height / step);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const side = i > 1 && i < n ? (i % 2 ? 1 : -1) * rng.range(0.03, 0.06) : 0;
    pts.push(new Vector3(0, t * height, 0).addScaledVector(lean, t * t).addScaledVector(zig, side));
    radii.push(0.17 + 0.05 * Math.exp(-t * 14) - 0.02 * t);
  }
  return { pts, radii };
}

/** A tube along a line, its triangles wound outward, textured round (u) and along (v, one repeat per `tile` m). */
function tube(b: MeshBuilder, pts: readonly Vector3[], radii: readonly number[], at: Matrix4, sides: number, tile: number, col: RGB): void {
  const start = b.vertexCount;
  let v = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) v += pts[i].distanceTo(pts[i - 1]) / tile;
    const d = new Vector3().subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize();
    const side = new Vector3().crossVectors(d, Math.abs(d.y) > 0.9 ? new Vector3(1, 0, 0) : UP).normalize();
    const fwd = new Vector3().crossVectors(side, d);
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const n = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(fwd, Math.sin(a));
      const p = pts[i].clone().addScaledVector(n, radii[i]).applyMatrix4(at);
      b.vertex(p, n.transformDirection(at), (k / sides) * 3, v, col);
    }
  }
  for (let i = 0; i + 1 < pts.length; i++)
    for (let k = 0; k < sides; k++) {
      const a = start + i * (sides + 1) + k;
      const c = a + sides + 1;
      b.quad(a, c, c + 1, a + 1);
    }
}

/**
 * A date palm's frond: a stiff rachis arching out from the crown, its leaflets in pairs folded up in a V, short
 * and spiny near its foot, grey-green; old ones lower and browner. Built at `base` toward azimuth `az`.
 */
function frond(b: MeshBuilder, rng: Rng, base: Vector3, az: number, elev: number, len: number, col: RGB): void {
  const dir = new Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
  const across = new Vector3(-Math.sin(az), 0, Math.cos(az));
  const at = (t: number) => base.clone().addScaledVector(dir, len * t).add(new Vector3(0, -0.22 * len * t * t, 0));
  const SEG = 8;
  // the rachis
  for (let i = 0; i < SEG; i++) {
    const p = at(i / SEG);
    const q = at((i + 1) / SEG);
    const w0 = 0.022 * (1 - i / SEG) + 0.006;
    const w1 = 0.022 * (1 - (i + 1) / SEG) + 0.006;
    const n = new Vector3().subVectors(q, p).cross(across).normalize();
    if (n.y < 0) n.negate();
    const s = b.vertex(p.clone().addScaledVector(across, -w0), n, 0, 0, scaleRgb(col, 0.8));
    b.vertex(p.clone().addScaledVector(across, w0), n, 1, 0, scaleRgb(col, 0.8));
    b.vertex(q.clone().addScaledVector(across, w1), n, 1, 1, scaleRgb(col, 0.8));
    b.vertex(q.clone().addScaledVector(across, -w1), n, 0, 1, scaleRgb(col, 0.8));
    b.quad(s, s + 1, s + 2, s + 3);
  }
  // the leaflets: close along it, two to a side at each step in different planes (one raised, one level), as a
  // date palm's stand every way along the rib and make its frond a full, stiff plume; short and spiny at its
  // foot, longest a third of the way out, shortening to the tip
  for (let t = 0.1; t < 0.98; t += rng.range(0.026, 0.036)) {
    const p = at(t);
    const tangent = new Vector3().subVectors(at(Math.min(1, t + 0.02)), at(t - 0.02)).normalize();
    const full = t < 0.2 ? 0.16 : 0.6 * (1 - 0.6 * Math.max(0, t - 0.3));
    for (const s of [-1, 1])
      for (const lift of [0.75, 0.15]) {
        const l = full * rng.range(0.8, 1.1);
        const out = across.clone().multiplyScalar(s).addScaledVector(tangent, 0.6).addScaledVector(UP, lift + rng.range(-0.15, 0.15)).normalize();
        const tip = p.clone().addScaledVector(out, l).addScaledVector(UP, -0.04 * l);
        const w = new Vector3().crossVectors(out, tangent).normalize().multiplyScalar(0.022);
        const n = new Vector3().crossVectors(tangent, out).normalize();
        if (n.y < 0) n.negate();
        const c = scaleRgb(col, rng.range(0.88, 1.1));
        const a = b.vertex(p.clone().sub(w), n, 0, 0, c);
        b.vertex(p.clone().add(w), n, 1, 0, c);
        b.vertex(tip.clone().addScaledVector(w, 0.15), n, 1, 1, c);
        b.vertex(tip.clone().addScaledVector(w, -0.15), n, 0, 1, c);
        b.quad(a, a + 1, a + 2, a + 3);
      }
  }
}

export class Khejur {
  readonly group = new Group();
  /** The tree the film's shot climbs: its foot, its tapping cut, its pot's mouth, the way its cut faces (world). */
  readonly hero = { foot: new Vector3(), cut: new Vector3(), mouth: new Vector3(), out: new Vector3() };
  private readonly taps: Tap[] = [];
  private readonly tapping = new Group();
  private readonly pots = new Group();
  /** For the film's shot: when the watching began (s), to fill the pot a little as it is watched. */
  private watchFrom = -1;
  private readonly rng = new Rng(4521);
  private readonly tmp = new Vector3();

  constructor() {
    this.group.name = 'khejur';
    const rng = new Rng(4519);
    const bark = khejurBarkTexture(4520);
    bark.map.repeat.set(1, 1);
    const trunkMat = patchMaterial(new MeshStandardMaterial({ map: bark.map, normalMap: bark.normal, normalScale: new Vector2(1.2, 1.2), vertexColors: true, roughness: 0.95 }), { grime: 0.25 });
    const leafMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: DoubleSide }), { wind: 0.05, windHeight: 2.2, translucency: 0.45, foliage: true, seasonal: 'leaf' });
    const cutMat = patchMaterial(new MeshStandardMaterial({ map: khejurCutTexture(), alphaTest: 0.5, roughness: 0.6, side: DoubleSide }), {});
    const clay = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), { grime: 0.3 });
    const cane = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), {});
    const sapMat = patchMaterial(new MeshStandardMaterial({ color: '#cdb478', roughness: 0.12, metalness: 0, transparent: true, opacity: 0.88 }), {});
    const dropMat = new MeshStandardMaterial({ color: '#e8d9a8', roughness: 0.05, transparent: true, opacity: 0.85 });
    const ringMat = new MeshStandardMaterial({ color: '#f2e6c4', roughness: 0.1, transparent: true, opacity: 0.6 });

    const trunks = new MeshBuilder();
    const tapB = new MeshBuilder();
    const potB = new MeshBuilder();
    const cutB = new MeshBuilder();
    // the path's length, for the row along it
    const seg: number[] = [0];
    for (let i = 1; i < KHEJUR_PATH.length; i++) seg.push(seg[i - 1] + Math.hypot(KHEJUR_PATH[i][0] - KHEJUR_PATH[i - 1][0], KHEJUR_PATH[i][1] - KHEJUR_PATH[i - 1][1]));
    const total = seg[seg.length - 1];
    const along = (d: number) => {
      let i = 1;
      while (i < seg.length - 1 && seg[i] < d) i++;
      const f = (d - seg[i - 1]) / (seg[i] - seg[i - 1]);
      const [ax, az] = KHEJUR_PATH[i - 1];
      const [bx, bz] = KHEJUR_PATH[i];
      const len = Math.hypot(bx - ax, bz - az);
      return { x: ax + (bx - ax) * f, z: az + (bz - az) * f, dx: (bx - ax) / len, dz: (bz - az) / len };
    };
    const { side, from, to, count } = KHEJUR_ROW;
    for (let k = 0; k < count; k++) {
      const d = total * (from + ((to - from) * k) / (count - 1)) + rng.range(-2, 2);
      const p = along(d);
      // east of the path: its right going north is −x... the side away from the para's houses
      const x = p.x + p.dz * side + rng.range(-0.3, 0.3);
      const z = p.z - p.dx * side + rng.range(-0.3, 0.3);
      const y = terrainHeight(x, z) - 0.05;
      const height = rng.range(5.4, 7.2);
      // the tapping faces east this winter (toward the morning, where the gachhi stands), give or take
      const out = new Vector3(-1, 0, rng.range(-0.45, 0.25)).normalize();
      const zig = new Vector3().crossVectors(UP, out).normalize();
      const { pts, radii } = trunkLine(rng, height, zig);
      const at = new Matrix4().makeTranslation(x, y, z);
      tube(trunks, pts, radii, at, 10, 0.45, scaleRgb(rgb('#ffffff'), rng.range(0.85, 1.05)));
      // a few roots spreading at its foot
      for (let r = 0; r < 6; r++) {
        const a = rng.range(0, Math.PI * 2);
        tube(trunks, [new Vector3(0, 0.25, 0), new Vector3(Math.cos(a) * 0.32, 0.02, Math.sin(a) * 0.32)], [0.05, 0.02], at, 5, 0.45, rgb('#8a7a66'));
      }
      const top = pts[pts.length - 1].clone().applyMatrix4(at);
      const radiusTop = radii[radii.length - 1];
      const tapped = k !== 1 && k !== 5;
      // the crown: its own object about the crown's foot, so the wind bends the fronds from there
      const crown = new MeshBuilder();
      const n = rng.int(34, 40);
      const outAz = Math.atan2(out.z, out.x);
      for (let i = 0; i < n; i++) {
        const az = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
        // the tapped side cut back: only stubs there
        const cleared = tapped && Math.abs(Math.atan2(Math.sin(az - outAz), Math.cos(az - outAz))) < 0.95;
        const old = i % 6 === 0;
        const elev = cleared ? rng.range(0.6, 1.2) : old ? rng.range(-0.6, -0.2) : rng.range(-0.05, 1.25);
        const len = cleared ? rng.range(0.25, 0.45) : rng.range(2.4, 3.3);
        const col = old ? rgb('#8f8457') : rgb(rng.next() < 0.5 ? '#667f58' : '#748c62');
        frond(crown, rng, new Vector3(0, 0, 0), az, elev, len, col);
      }
      const crownMesh = new Mesh(crown.build(), leafMat);
      crownMesh.position.copy(top);
      crownMesh.castShadow = true;
      this.group.add(crownMesh);
      if (!tapped) continue;

      // the tapping: the V shaved under the crown on its eastern face, the spout at its point, the pot under it
      const outW = out.clone();
      const cutTop = top.clone().addScaledVector(UP, -0.06);
      // (standing a little proud of the trunk's line, which its zig-zag carries in and out)
      const cutMid = cutTop.clone().addScaledVector(UP, -0.19).addScaledVector(outW, radiusTop + 0.05);
      const across = new Vector3().crossVectors(UP, outW).normalize();
      {
        const w = 0.17;
        const h = 0.2;
        const s = cutB.vertex(cutMid.clone().addScaledVector(across, -w).addScaledVector(UP, h).addScaledVector(outW, -0.02), outW, 0, 1);
        cutB.vertex(cutMid.clone().addScaledVector(across, w).addScaledVector(UP, h).addScaledVector(outW, -0.02), outW, 1, 1);
        cutB.vertex(cutMid.clone().addScaledVector(across, w).addScaledVector(UP, -h), outW, 1, 0);
        cutB.vertex(cutMid.clone().addScaledVector(across, -w).addScaledVector(UP, -h), outW, 0, 0);
        cutB.quad(s, s + 1, s + 2, s + 3);
      }
      const spoutFoot = cutMid.clone().addScaledVector(UP, -0.15);
      const spoutDir = outW.clone().addScaledVector(UP, -0.35).normalize();
      const tip = spoutFoot.clone().addScaledVector(spoutDir, 0.2);
      tapB.add(
        new CylinderGeometry(0.008, 0.01, 0.2, 6).translate(0, 0.1, 0),
        new Matrix4().compose(spoutFoot, new Quaternion().setFromUnitVectors(UP, spoutDir), new Vector3(1, 1, 1)),
        rgb('#b49a62'),
      );
      // the pot, tipped toward the trunk so its mouth is under the spout, smoked dark about its neck
      const potFoot = tip.clone().addScaledVector(UP, -0.05 - POT.height).addScaledVector(outW, -0.03);
      const tilt = new Quaternion().setFromAxisAngle(across, -0.18);
      // terracotta, smoked dark from the shoulder up (the pots are smoked so the sap keeps)
      const lathe = new LatheGeometry(potProfile(), 18);
      const pos = lathe.getAttribute('position');
      const nrm = lathe.getAttribute('normal');
      const place = new Matrix4().compose(potFoot, tilt, new Vector3(1, 1, 1));
      const first = potB.vertexCount;
      for (let i = 0; i < pos.count; i++) {
        const smoke = Math.min(1, Math.max(0, pos.getY(i) / POT.height - 0.3) / 0.45);
        const c: RGB = [0.34 - 0.27 * smoke, 0.17 - 0.12 * smoke, 0.1 - 0.06 * smoke];
        potB.vertex(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(place), new Vector3().fromBufferAttribute(nrm, i).transformDirection(place), 0, 0, c);
      }
      const idx = lathe.getIndex();
      if (idx) for (let i = 0; i + 2 < idx.count; i += 3) potB.tri(first + idx.getX(i), first + idx.getX(i + 1), first + idx.getX(i + 2));
      // tied to the trunk by a rope round it and one to the pot's neck
      const ringY = potFoot.y + POT.height * 0.9;
      const trunkAt = new Vector3(top.x, ringY, top.z);
      tapB.add(new TorusGeometry(radiusTop + 0.012, 0.006, 4, 16).rotateX(Math.PI / 2), new Matrix4().makeTranslation(trunkAt.x, trunkAt.y, trunkAt.z), rgb('#9a8456'));
      const neck = potFoot.clone().addScaledVector(UP, POT.height * 0.9);
      const rope = new Vector3().subVectors(neck, trunkAt.clone().addScaledVector(outW, radiusTop));
      tapB.add(
        new CylinderGeometry(0.005, 0.005, rope.length(), 4).translate(0, rope.length() / 2, 0),
        new Matrix4().compose(trunkAt.clone().addScaledVector(outW, radiusTop), new Quaternion().setFromUnitVectors(UP, rope.clone().normalize()), new Vector3(1, 1, 1)),
        rgb('#9a8456'),
      );
      // the sap in it, its drop and its ring (moved each frame)
      const mouth = potFoot.clone().addScaledVector(UP, POT.height);
      const sap = new Mesh(new CircleGeometry(1, 20).rotateX(-Math.PI / 2), sapMat);
      const drop = new Mesh(new SphereGeometry(0.0065, 8, 6), dropMat);
      const ring = new Mesh(new TorusGeometry(1, 0.06, 4, 20).rotateX(Math.PI / 2), ringMat);
      for (const m of [sap, drop, ring]) {
        m.visible = false;
        this.pots.add(m);
      }
      sap.position.copy(potFoot);
      this.taps.push({ tip, mouth, floor: potFoot.y, out: outW, sap, drop, ring, dropAt: 0, dropFor: 1.5, fallAt: -1, ringAt: -10 });
      if (k === 3) {
        this.hero.foot.set(x, y, z);
        this.hero.cut.copy(cutMid);
        this.hero.mouth.copy(mouth);
        this.hero.out.copy(outW);
      }
    }
    const trunkMesh = new Mesh(trunks.build(), trunkMat);
    trunkMesh.castShadow = true;
    trunkMesh.receiveShadow = true;
    this.group.add(trunkMesh);
    this.tapping.add(new Mesh(cutB.build(), cutMat), new Mesh(tapB.build(), cane));
    this.pots.add(new Mesh(potB.build(), clay));
    this.tapping.add(this.pots);
    this.group.add(this.tapping);
    this.group.traverse((o) => o.layers.set(LAYER_NO_REFLECT));
  }

  /** The film's shot of the sap begins: the pot fills a little as it is watched. */
  cue(t: number): void {
    this.watchFrom = t;
  }

  /**
   * `day`: the day of the year; `hour`: the local hour: the tapping's season and the pots' hours; `eye`: the
   * camera, near which the drops are seen.
   */
  update(t: number, eye: Vector3, day: number, hour: number): void {
    const inSeason = day >= SEASON.from || day <= SEASON.to;
    this.tapping.visible = inSeason;
    // the pots hang from the afternoon till after sunrise, filling through the night
    const hung = hour >= HUNG.from || hour <= HUNG.to;
    this.pots.visible = inSeason && hung;
    if (!this.pots.visible) return;
    const night = ((hour - HUNG.from + 24) % 24) / ((HUNG.to - HUNG.from + 24) % 24);
    const watched = this.watchFrom >= 0 ? Math.min(0.08, (t - this.watchFrom) * 0.005) : 0;
    const fill = Math.min(0.82, 0.12 + 0.62 * night + watched);
    for (const tap of this.taps) {
      // the sap: its top as full as the night has made it
      const h = POT.height * fill;
      const r = potInner(h);
      tap.sap.visible = true;
      tap.sap.position.set(tap.mouth.x, tap.floor + h, tap.mouth.z);
      tap.sap.scale.set(r, 1, r);
      const near = this.tmp.subVectors(tap.tip, eye).length() < DRIP_NEAR;
      tap.drop.visible = near;
      tap.ring.visible = false;
      if (!near) continue;
      // a drop swells at the spout's tip, lets go, falls into the pot and rings its sap; then the next, unevenly
      const level = tap.floor + h;
      if (tap.fallAt < 0) {
        const k = (t - tap.dropAt) / tap.dropFor;
        if (k >= 1) tap.fallAt = t;
        tap.drop.position.copy(tap.tip).addScaledVector(UP, -0.006 * Math.min(1, k));
        tap.drop.scale.setScalar(0.3 + 0.7 * Math.min(1, Math.max(0, k)));
        tap.drop.scale.y *= 1 + 0.4 * Math.max(0, k - 0.7);
      } else {
        const s = t - tap.fallAt;
        const y = tap.tip.y - 0.006 - 4.9 * s * s;
        tap.drop.position.set(tap.tip.x, y, tap.tip.z);
        tap.drop.scale.set(0.9, 1.3, 0.9);
        if (y <= level) {
          tap.ringAt = t;
          tap.fallAt = -1;
          tap.dropAt = t;
          tap.dropFor = this.rng.range(0.9, 2.6);
        }
      }
      const age = t - tap.ringAt;
      if (age < 0.7) {
        tap.ring.visible = true;
        tap.ring.position.set(tap.tip.x, level + 0.002, tap.tip.z);
        const rr = Math.min(potInner(h) * 0.95, 0.01 + age * 0.12);
        tap.ring.scale.set(rr, 0.04, rr);
        (tap.ring.material as MeshStandardMaterial).opacity = 0.55 * (1 - age / 0.7);
      }
    }
  }
}
