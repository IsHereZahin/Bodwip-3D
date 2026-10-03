import { HalfFloatType, Matrix4, PerspectiveCamera, Plane, Vector3, Vector4, WebGLRenderTarget } from 'three';
import { G } from '../core/globals';

/**
 * Mirror camera for the river surface (at the season's water level, G.uWaterLevel), as three's Reflector
 * does it: a reflected camera, a projective texture matrix, and an oblique near plane that clips the
 * riverbed away.
 */
export class PlanarReflection {
  readonly camera = new PerspectiveCamera();
  readonly textureMatrix = new Matrix4();
  readonly target: WebGLRenderTarget;
  private readonly plane = new Plane();
  private readonly clip = new Vector4();
  private readonly q = new Vector4();
  private readonly camPos = new Vector3();
  private readonly look = new Vector3();
  private readonly rot = new Matrix4();
  private readonly normal = new Vector3(0, 1, 0);
  private readonly origin = new Vector3();

  constructor(width: number, height: number) {
    this.target = new WebGLRenderTarget(width, height, { type: HalfFloatType, depthBuffer: true, stencilBuffer: false });
    this.target.texture.generateMipmaps = false;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }

  /** Returns false when the camera is at or below the surface (nothing to mirror). */
  update(camera: PerspectiveCamera): boolean {
    const level = G.uWaterLevel.value;
    this.origin.set(0, level, 0);
    const pos = this.camPos.setFromMatrixPosition(camera.matrixWorld);
    if (pos.y <= level + 0.02) return false;
    this.rot.extractRotation(camera.matrixWorld);
    this.look.set(0, 0, -1).applyMatrix4(this.rot).add(pos);
    const vc = this.camera;
    vc.position.set(pos.x, 2 * level - pos.y, pos.z);
    vc.up.set(0, 1, 0).applyMatrix4(this.rot).reflect(this.normal);
    vc.lookAt(this.look.x, 2 * level - this.look.y, this.look.z);
    vc.far = camera.far;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    // oblique near plane (Lengyel): everything under the water is clipped from the mirror image
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.origin).applyMatrix4(vc.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const e = vc.projectionMatrix.elements;
    this.q.set((Math.sign(this.clip.x) + e[8]) / e[0], (Math.sign(this.clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    e[2] = this.clip.x;
    e[6] = this.clip.y;
    e[10] = this.clip.z + 1;
    e[14] = this.clip.w;
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();
    return true;
  }
}
