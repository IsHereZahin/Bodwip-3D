import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { angleDelta, clamp, damp } from '../core/mathx';
import { CORRIDOR } from '../render/glsl';
import { WORLD_X0, WORLD_X1, WORLD_Z0, WORLD_Z1, corridorDistance, terrainHeight, waterLevelAt } from '../world/geography';

/**
 * How far the free camera may roam: over the khal and its village, well inside the world's edges (so they stay
 * beyond the haze), and no higher than a tall tree's crown and a little more: this is a river to be looked at
 * from near it, not a map.
 */
const EDGE = 220;
const CEILING = 90;
/** Metres kept above the ground and the water. */
const CLEARANCE = 1.6;
/** Metres per second near the ground; faster higher up, and four times faster with Shift. */
const SPEED = 9;
const PITCH_LIMIT = 1.3;

/**
 * A free camera that leaves the boat: drag or ←/→ to turn, WASD or ↑/↓ to move, Q/E to sink and rise.
 * It glides through trees and huts but never under the ground or the water or out of the world.
 */
export class FlyCam {
  private readonly pos = new Vector3();
  private readonly vel = new Vector3();
  private readonly want = new Vector3();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly look = new Vector3();
  private yaw = 0;
  private pitch = 0;
  private yawT = 0;
  private pitchT = 0;
  /** Metres still to travel from wheel or pinch nudges. */
  private push = 0;
  /** A still placed by hand (the debug views) is not held inside the viewer's bounds. */
  private still = false;

  /** Takes over from wherever the camera is now. */
  startFrom(camera: PerspectiveCamera): void {
    this.pos.copy(camera.position);
    camera.getWorldDirection(this.fwd);
    this.yaw = this.yawT = Math.atan2(this.fwd.x, this.fwd.z);
    this.pitch = this.pitchT = Math.asin(clamp(this.fwd.y, -1, 1));
    this.vel.set(0, 0, 0);
    this.push = 0;
    this.still = false;
  }

  /** Puts the camera at a point looking along `yaw` (radians, 0 = +z) and `pitch`; for stills. */
  place(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.pos.set(x, y, z);
    this.yaw = this.yawT = yaw;
    this.pitch = this.pitchT = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.vel.set(0, 0, 0);
    this.push = 0;
    this.still = true;
  }

  /** Drag deltas in pixels; the view follows the hand, like turning a photo sphere. */
  drag(dx: number, dy: number): void {
    this.yawT += dx * 0.0035;
    this.pitchT = clamp(this.pitchT + dy * 0.0035, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Moves along the view by `metres` (wheel and pinch). */
  nudge(metres: number): void {
    this.push = clamp(this.push + metres, -120, 120);
  }

  /**
   * `keys` holds the pressed key codes. `watch`, when set, is a direction the camera turns toward
   * (a rising moon, say) at `turnRate`.
   */
  update(dt: number, keys: ReadonlySet<string>, camera: PerspectiveCamera, watch: Vector3 | null, turnRate: number): void {
    const has = (code: string) => keys.has(code);
    if (has('ArrowLeft')) this.yawT += dt * 1.3;
    if (has('ArrowRight')) this.yawT -= dt * 1.3;
    if (watch) {
      this.yawT += angleDelta(this.yawT, Math.atan2(watch.x, watch.z)) * (1 - Math.exp(-dt * turnRate));
      this.pitchT = damp(this.pitchT, clamp(Math.asin(watch.y) * 0.8, -0.05, 0.6), turnRate, dt);
    }
    this.yaw = damp(this.yaw, this.yawT, 10, dt);
    this.pitch = damp(this.pitch, this.pitchT, 10, dt);

    const cp = Math.cos(this.pitch);
    this.fwd.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this.right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));

    const ahead = Number(has('KeyW') || has('ArrowUp')) - Number(has('KeyS') || has('ArrowDown'));
    const side = Number(has('KeyD')) - Number(has('KeyA'));
    const lift = Number(has('KeyE') || has('PageUp')) - Number(has('KeyQ') || has('PageDown'));
    const ground = Math.max(terrainHeight(this.pos.x, this.pos.z), waterLevelAt(this.pos.x, this.pos.z));
    const speed = SPEED * (1 + (this.pos.y - ground) / 25) * (has('ShiftLeft') || has('ShiftRight') ? 4 : 1);
    this.want.copy(this.fwd).multiplyScalar(ahead).addScaledVector(this.right, side);
    if (this.want.lengthSq() > 1) this.want.normalize();
    this.want.multiplyScalar(speed);
    this.want.y += lift * speed * 0.7;
    const k = 1 - Math.exp(-dt * 6);
    this.vel.lerp(this.want, k);
    const step = this.push * k;
    this.push -= step;
    const fromX = this.pos.x;
    const fromZ = this.pos.z;
    this.pos.addScaledVector(this.vel, dt).addScaledVector(this.fwd, step);
    // never out over the land beyond the village: a move that would take it farther out slides along the
    // limit, or stops (placed outside, it may still come back in)
    const limit = CORRIDOR.camera;
    const outNow = corridorDistance(this.pos.x, this.pos.z);
    if (outNow > limit && outNow > corridorDistance(fromX, fromZ)) {
      if (corridorDistance(this.pos.x, fromZ) <= limit) this.pos.z = fromZ;
      else if (corridorDistance(fromX, this.pos.z) <= limit) this.pos.x = fromX;
      else {
        this.pos.x = fromX;
        this.pos.z = fromZ;
      }
      this.vel.x *= 0.5;
      this.vel.z *= 0.5;
    }

    // stay inside the world, above the ground and the water
    if (ahead || side || lift || step) this.still = false;
    const floor = Math.max(terrainHeight(this.pos.x, this.pos.z), waterLevelAt(this.pos.x, this.pos.z)) + CLEARANCE;
    if (this.still) this.pos.y = Math.max(this.pos.y, floor);
    else {
      this.pos.z = clamp(this.pos.z, WORLD_Z1 + EDGE, WORLD_Z0 - EDGE);
      this.pos.x = clamp(this.pos.x, WORLD_X0 + EDGE, WORLD_X1 - EDGE);
      this.pos.y = clamp(this.pos.y, floor, floor + CEILING);
    }

    camera.position.copy(this.pos);
    camera.lookAt(this.look.copy(this.pos).add(this.fwd));
    camera.updateMatrixWorld();
  }

  /** Where the camera looks, on the ground some way ahead; the shadow map follows it. */
  focus(out: Vector3): Vector3 {
    return out.set(this.pos.x + Math.sin(this.yaw) * 60, 0, this.pos.z + Math.cos(this.yaw) * 60);
  }

  /** The camera's position and horizontal heading, for things placed around the viewer. */
  get position(): Vector3 {
    return this.pos;
  }

  get heading(): number {
    return this.yaw;
  }
}
