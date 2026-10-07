import { Euler, Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferAttribute, BufferGeometry, Material } from 'three';

/**
 * Sends the first `count` instances of these attributes (an instanced mesh's matrices, colours, …) up to the GPU,
 * and nothing past them: flagged whole, three sends every slot (the fallen petals' 26000 matrices, ≈2 MB, for a
 * handful in use). Nothing goes up while there are none: none is drawn.
 */
export function sendFirst(count: number, ...attributes: (BufferAttribute | null)[]): void {
  if (count <= 0) return;
  for (const a of attributes) {
    if (!a) continue;
    a.clearUpdateRanges();
    a.addUpdateRange(0, count * a.itemSize);
    a.needsUpdate = true;
  }
}

export interface Placement {
  x: number;
  y: number;
  z: number;
  /** Yaw. */
  ry: number;
  /** Uniform scale; `sy` multiplies the height on top of it. */
  s: number;
  sy?: number;
  /** Lean (radians) about x and z. */
  tx?: number;
  tz?: number;
}

export interface InstanceOptions {
  /** Instances are split into slabs this long along z and this wide across x, so slabs off-screen (or far off, see cull.ts) are left undrawn. */
  chunk?: number;
  across?: number;
  cast?: boolean;
  receive?: boolean;
  layer?: number;
}

export function instanced(
  geometry: BufferGeometry,
  material: Material,
  items: readonly Placement[],
  options: InstanceOptions = {},
): Group {
  const group = new Group();
  const chunk = options.chunk ?? 600;
  const across = options.across ?? 1300;
  const buckets = new Map<number, Placement[]>();
  for (const p of items) {
    const k = Math.floor(p.z / chunk) * 64 + Math.floor(p.x / across);
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(p);
  }
  const m = new Matrix4();
  const q = new Quaternion();
  const e = new Euler();
  const pos = new Vector3();
  const scl = new Vector3();
  for (const list of buckets.values()) {
    const mesh = new InstancedMesh(geometry, material, list.length);
    list.forEach((p, i) => {
      e.set(p.tx ?? 0, p.ry, p.tz ?? 0, 'YXZ');
      q.setFromEuler(e);
      m.compose(pos.set(p.x, p.y, p.z), q, scl.set(p.s, p.s * (p.sy ?? 1), p.s));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = options.cast ?? false;
    mesh.receiveShadow = options.receive ?? true;
    if (options.layer !== undefined) mesh.layers.set(options.layer);
    group.add(mesh);
  }
  return group;
}
