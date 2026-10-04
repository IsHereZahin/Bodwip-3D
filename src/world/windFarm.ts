import { CylinderGeometry, Euler, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3 } from 'three';
import { NODES } from '../geo/data';
import { MeshBuilder, rgb, slab } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { windAt } from '../env/wind';
import { BEACON, type Beacon } from './beacons';
import { terrainHeight } from './geography';

// The wind turbines OpenStreetMap maps, at their real places and size (D1): the Cox's Bazar 60 MW wind farm at
// Khurushkul across the channel from Gorakghata (22 Envision EN-156/3.0 turbines on 110 m towers, 156 m
// rotors: the Financial Express and thewindpower.net; OSM's turbines there carry no rating, and these are
// taken to be them), and Kutubdia's old 1.5 MW turbine (its size [মডেল]). Each faces into the wind, its
// nacelle slowly yawing round as the wind shifts, and turns at a speed set by the wind at its hub: idling
// below cut-in, up to its rated speed. Red obstacle lights on the nacelles flash together at night.

interface Model {
  hub: number;
  radius: number;
  /** Rotor speed at and above its rated wind (rpm), and the winds (m/s) it cuts in and reaches it at. */
  rpm: number;
  cutIn: number;
  rated: number;
}

const EN156: Model = { hub: 110, radius: 78, rpm: 9.6, cutIn: 2.5, rated: 9.5 };
const SMALL: Model = { hub: 70, radius: 38, rpm: 17, cutIn: 3, rated: 12 };

/** The wind at a hub against the wind near the ground (the shear over ≈100 m of open ground). */
const SHEAR = 1.4;
/** How fast a nacelle yaws round (rad/s): a few degrees a second. */
const YAW_RATE = 0.04;

interface Turbine {
  x: number;
  y: number;
  z: number;
  model: Model;
  yaw: number;
  spin: number;
}

const WHITE = rgb('#eeefec');

/** One blade along +y from the hub: an airfoil's outline drawn in toward the tip, broadest a fifth of the way out. */
function blade(radius: number): MeshBuilder {
  const b = new MeshBuilder();
  const steps = 14;
  const rings: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = 2 + (radius - 2) * t;
    const chord = (t < 0.2 ? 2.6 + (t / 0.2) * 1.8 : 4.4 * (1 - (t - 0.2) / 0.8) + 0.6) * (radius / 78);
    const thick = chord * (0.32 - 0.22 * t);
    rings.push(b.vertexCount);
    // leading edge, top, trailing edge, bottom (the blade's chord across x, its thickness along z)
    const pts: [number, number][] = [
      [-chord * 0.3, 0],
      [0, thick / 2],
      [chord * 0.7, 0],
      [0, -thick / 2],
    ];
    for (const [x, z] of pts) b.vertex(new Vector3(x, r, z), new Vector3(Math.sign(x) * 0.3, 0, Math.sign(z)).normalize(), 0, t, WHITE);
  }
  for (let i = 0; i < steps; i++) {
    for (let k = 0; k < 4; k++) {
      const a = rings[i] + k;
      const c = rings[i + 1] + k;
      const an = rings[i] + ((k + 1) % 4);
      const cn = rings[i + 1] + ((k + 1) % 4);
      b.quad(a, an, cn, c);
    }
  }
  return b;
}

/** Three blades round the hub, in the rotor's plane (x, y), the hub's nose toward +z. */
function rotor(m: Model): MeshBuilder {
  const one = blade(m.radius).build();
  const b = new MeshBuilder();
  for (let k = 0; k < 3; k++) b.add(one, new Matrix4().makeRotationZ((k * Math.PI * 2) / 3), WHITE);
  b.add(new SphereGeometry(2.3, 14, 10), new Matrix4().makeScale(1, 1, 1.5), WHITE);
  return b;
}

/** The nacelle behind the hub, toward −z from the rotor's plane. */
function nacelle(): MeshBuilder {
  const b = new MeshBuilder();
  slab(b, 0, 0, -5.5, 4.2, 4.4, 11, 0, WHITE);
  slab(b, 0, 2.4, -8, 1.2, 0.5, 1.2, 0, rgb('#9a9c98'));
  return b;
}

const mat = new Matrix4();
const q = new Quaternion();
const e = new Euler();
const pos = new Vector3();
const ONE = new Vector3(1, 1, 1);
const wind = { x: 0, z: 0 };

export class WindFarm {
  readonly group = new Group();
  readonly lights: Beacon[] = [];
  private readonly turbines: Turbine[] = [];
  private readonly rotors = new Map<Model, { mesh: InstancedMesh; items: Turbine[] }>();
  private readonly nacelles = new Map<Model, { mesh: InstancedMesh; items: Turbine[] }>();

  constructor() {
    this.group.name = 'wind-farm';
    for (const n of NODES) {
      if (n.t !== 'wind_turbine') continue;
      const model = n.mw !== undefined && n.mw < 2.5 ? SMALL : EN156;
      // facing the season's wind from the start, each its own way round
      this.turbines.push({ x: n.x, y: terrainHeight(n.x, n.z), z: n.z, model, yaw: 0, spin: (n.x * 7.3 + n.z * 3.1) % (Math.PI * 2) });
    }
    if (!this.turbines.length) return;
    const material = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 }), { grime: 0.08 });
    for (const model of [EN156, SMALL]) {
      const items = this.turbines.filter((t) => t.model === model);
      if (!items.length) continue;
      // the tower: a steel tube drawn in toward the top, on its concrete foundation
      const tower = new MeshBuilder();
      const r0 = model === EN156 ? 2.9 : 1.9;
      tower.add(new CylinderGeometry(r0 * 0.55, r0, model.hub, 20, 1, true), new Matrix4().makeTranslation(0, model.hub / 2, 0), WHITE);
      tower.add(new CylinderGeometry(r0 + 4, r0 + 4.5, 1, 20), new Matrix4().makeTranslation(0, 0.3, 0), rgb('#a8a49c'));
      const towers = new InstancedMesh(tower.build(), material, items.length);
      items.forEach((t, i) => towers.setMatrixAt(i, mat.makeTranslation(t.x, t.y, t.z)));
      towers.castShadow = true;
      towers.receiveShadow = true;
      towers.computeBoundingSphere();
      this.group.add(towers);
      // the moving parts: never in the shadow map, which is not redrawn as they turn
      const rot = new InstancedMesh(rotor(model).build(), material, items.length);
      const nac = new InstancedMesh(nacelle().build(), material, items.length);
      for (const m of [rot, nac]) {
        m.receiveShadow = true;
        m.frustumCulled = false;
        this.group.add(m);
      }
      this.rotors.set(model, { mesh: rot, items });
      this.nacelles.set(model, { mesh: nac, items });
      for (const t of items) this.lights.push({ x: t.x, y: t.y + model.hub + 2.8, z: t.z, kind: BEACON.flashing });
    }
    this.update(0, true);
  }

  /** Yaw each nacelle toward the wind and turn its rotor; `settle` faces them straight into it. */
  update(dt: number, settle = false): void {
    for (const t of this.turbines) {
      windAt(t.x, t.z, wind);
      const speed = Math.hypot(wind.x, wind.z) * SHEAR;
      // the rotor faces up wind: its nose (+z) toward where the wind comes from
      const want = Math.atan2(-wind.x, -wind.z);
      let d = want - t.yaw;
      d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
      t.yaw += settle ? d : Math.max(-YAW_RATE * dt, Math.min(YAW_RATE * dt, d));
      const m = t.model;
      const rpm = speed < m.cutIn ? 0.4 : m.rpm * Math.min(1, 0.35 + (0.65 * (speed - m.cutIn)) / (m.rated - m.cutIn));
      t.spin = (t.spin + ((rpm * Math.PI * 2) / 60) * dt) % (Math.PI * 2);
    }
    for (const [model, { mesh, items }] of this.nacelles) {
      items.forEach((t, i) => {
        q.setFromEuler(e.set(0, t.yaw, 0));
        mesh.setMatrixAt(i, mat.compose(pos.set(t.x, t.y + model.hub, t.z), q, ONE));
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const [model, { mesh, items }] of this.rotors) {
      items.forEach((t, i) => {
        // the rotor's plane a little ahead of the tower, tilted back a few degrees as real rotors are
        q.setFromEuler(e.set(-0.08, t.yaw, t.spin, 'YXZ'));
        const fx = Math.sin(t.yaw) * 4.5;
        const fz = Math.cos(t.yaw) * 4.5;
        mesh.setMatrixAt(i, mat.compose(pos.set(t.x + fx, t.y + model.hub, t.z + fz), q, ONE));
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
