import { Vector3 } from 'three';
import type { Mesh, Object3D } from 'three';

// Things too small to see far off are left undrawn beyond a distance, on top of the frustum culling: a tree
// 3 km away under the haze, or a salt bund a hand high a kilometre off, still costs its triangles and its
// pixels, and the island's forest and salt works run the whole length of the world. Each mesh is judged by
// its bounding sphere (instanced meshes come in slabs along the river, see instancing.ts), so whole slabs go.

interface Entry {
  mesh: Mesh;
  centre: Vector3;
  radius: number;
  far: number;
}

const entries: Entry[] = [];
/** Every distance scaled by this (the lower quality tier draws less far). */
let reach = 1;

export function setCullReach(k: number): void {
  reach = k;
}

/** Leaves every mesh under `root` undrawn while the camera is farther than `far` from its bounding sphere. */
export function cullBeyond(root: Object3D, far: number): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const im = mesh as Mesh & { boundingSphere?: { center: Vector3; radius: number } | null };
    const sphere = im.boundingSphere ?? (mesh.geometry.boundingSphere || (mesh.geometry.computeBoundingSphere(), mesh.geometry.boundingSphere));
    if (!sphere) return;
    entries.push({ mesh, centre: sphere.center.clone().applyMatrix4(mesh.matrixWorld), radius: sphere.radius, far });
  });
}

/**
 * Leaves the matrices under `group` as they stood while it is hidden. three's frame walk goes into every child
 * whatever its flags, remaking each one that remakes its own; something hidden and never posed while hidden (a
 * salt crew out of its work, the reapers out of season) has nothing under it that moves, and when it is shown the
 * walk takes it up whole (its own matrix remade forces its children's). Nothing posing it may read its world
 * matrices before the frame it is shown is drawn.
 */
export function holdWhileHidden(group: Object3D): void {
  const walk = group.updateMatrixWorld;
  group.updateMatrixWorld = function (this: Object3D, force?: boolean) {
    if (this.visible) walk.call(this, force);
  };
}

/** Call once a frame, before drawing, with the camera's position. */
export function updateCulling(eye: Vector3): void {
  for (const e of entries) e.mesh.visible = e.centre.distanceTo(eye) - e.radius < e.far * reach;
}
