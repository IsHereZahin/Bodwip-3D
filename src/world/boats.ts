import { CapsuleGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, rgb } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { plankTexture, sailTexture } from '../render/textures';
import { G } from '../core/globals';
import { gustAt } from '../env/wind';
import { downstream, halfWidth, riverLane, riverX } from './geography';
import { buildHull, type HullShape } from './hull';

const CARGO_HULL: HullShape = { len: 11, beam: 1.05, keelMid: -0.4, keelRise: 1.0, sheerMid: 0.55, sheerRise: 1.3 };
const DINGHY_HULL: HullShape = { len: 6, beam: 0.62, keelMid: -0.2, keelRise: 0.6, sheerMid: 0.32, sheerRise: 0.7 };

/** A patchwork square sail, wider at the yard, bellied forward by the wind. */
function sailGeometry(width: number, height: number): BufferGeometry {
  const b = new MeshBuilder();
  const N = 8;
  const n = new Vector3(0, 0, 1);
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const u = i / N;
      const v = j / N;
      const w = width * (0.82 + 0.18 * v);
      const x = (u - 0.5) * w;
      const belly = 0.75 * Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.15 + 0.85 * v));
      b.vertex(new Vector3(x, v * height, belly), n, u, v);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * (N + 1) + j;
      b.quad(a, a + N + 1, a + N + 2, a + 1);
    }
  }
  return b.build();
}

function hullGeometry(shape: HullShape): BufferGeometry {
  const b = new MeshBuilder();
  buildHull(b, shape, { tar: rgb('#2a1f17'), top: rgb('#5c4a36') });
  return b.build();
}

interface Vessel {
  root: Group;
  /** Carries a sail (a cargo boat), so the wind heels it hard. */
  sail: boolean;
  z: number;
  lane: number;
  speed: number;
  phase: number;
}

/** Other boats on the river: cargo boats under sail and small fishing dinghies. They loop ahead of the hero. */
export class RiverTraffic {
  readonly group = new Group();
  private readonly vessels: Vessel[] = [];
  private readonly rng = new Rng(77);

  constructor() {
    this.group.name = 'traffic';
    const hullMat = patchMaterial(
      new MeshStandardMaterial({ map: plankTexture(61), vertexColors: true, roughness: 0.85, side: DoubleSide }),
      { grime: 0.3 },
    );
    const sailMat = patchMaterial(new MeshStandardMaterial({ map: sailTexture(62), roughness: 0.95, side: DoubleSide }), {
      translucency: 1.3,
    });
    const poleMat = patchMaterial(new MeshStandardMaterial({ color: '#6a5538', roughness: 0.85 }), { grime: 0.3 });
    const clothMat = patchMaterial(new MeshStandardMaterial({ color: '#c9c2b0', roughness: 0.9 }), {});
    const skinMat = patchMaterial(new MeshStandardMaterial({ color: '#8d5a3b', roughness: 0.65 }), {});

    const cargo = hullGeometry(CARGO_HULL);
    const dinghy = hullGeometry(DINGHY_HULL);
    const sail = sailGeometry(5.2, 6.2);
    const mast = new CylinderGeometry(0.06, 0.08, 8.2, 6);
    const yard = new CylinderGeometry(0.04, 0.04, 5.8, 5);
    const body = new CapsuleGeometry(0.16, 0.35, 3, 8);
    const head = new SphereGeometry(0.1, 8, 6);

    const figure = (parent: Group, x: number, y: number, z: number) => {
      const torso = new Mesh(body, clothMat);
      torso.position.set(x, y + 0.3, z);
      const h = new Mesh(head, skinMat);
      h.position.set(x, y + 0.72, z);
      parent.add(torso, h);
    };

    const make = (kind: 'cargo' | 'dinghy', speed: number, lane: number, z: number) => {
      const root = new Group();
      if (kind === 'cargo') {
        root.add(new Mesh(cargo, hullMat));
        const m = new Mesh(mast, poleMat);
        m.position.set(0, 4.3, 1.2);
        const yd = new Mesh(yard, poleMat);
        yd.rotation.z = Math.PI / 2;
        yd.position.set(0, 7.9, 1.25);
        const s = new Mesh(sail, sailMat);
        s.position.set(0, 1.6, 1.3);
        // sailing downstream the wind is behind; upstream they run before the monsoon wind too
        root.add(m, yd, s);
        figure(root, 0, 0.4, -4.2);
      } else {
        root.add(new Mesh(dinghy, hullMat));
        figure(root, 0, 0.15, -1.6);
        const pole = new Mesh(new CylinderGeometry(0.025, 0.03, 4.5, 5), poleMat);
        pole.position.set(0.5, 1.2, 1.2);
        pole.rotation.z = -0.7;
        root.add(pole);
      }
      root.traverse((o) => {
        if ((o as Mesh).isMesh) (o as Mesh).receiveShadow = true;
      });
      this.group.add(root);
      this.vessels.push({ root, sail: kind === 'cargo', z, lane, speed, phase: this.rng.range(0, 10) });
    };

    make('cargo', -1.3, 32, -500);
    make('cargo', 1.1, -30, -1100);
    make('cargo', -1.0, -34, -1700);
    make('cargo', 0.9, 28, -2300);
    make('dinghy', -0.25, 18, -350);
    make('dinghy', 0, -22, -900);
    make('dinghy', -0.2, 26, -1400);
  }

  update(dt: number, t: number, heroZ: number): void {
    for (const v of this.vessels) {
      v.z += v.speed * dt;
      // the camera looks downstream (−z): anything that slips behind it reappears far ahead in the haze
      if (v.z > heroZ + 240 || v.z < heroZ - 2200) v.z = heroZ - this.rng.range(900, 1700);
      const [dx, dz] = downstream(v.z);
      const heading = Math.atan2(dx, dz) + (v.speed > 0 ? Math.PI : 0);
      // their lanes beside the river's own, squeezed in where the river narrows
      const room = halfWidth(v.z) - 14;
      const x = riverX(v.z) + room * Math.tanh((riverLane(v.z) + v.lane) / room);
      // afloat on the season's water; the wind heels them over its gusts (a sail far more than a dinghy)
      const w = G.uWind.value;
      const across = w.x * Math.cos(heading) - w.y * Math.sin(heading);
      const heel = across * w.z * gustAt(x, v.z) * (v.sail ? 0.05 : 0.012);
      v.root.position.set(x, G.uWaterLevel.value + 0.04 * Math.sin(t * 1.1 + v.phase), v.z);
      v.root.rotation.set(0.015 * Math.sin(t * 0.9 + v.phase), heading, 0.025 * Math.sin(t * 0.7 + v.phase * 2) - heel, 'YXZ');
    }
  }
}
