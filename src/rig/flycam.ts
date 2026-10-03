import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { angleDelta, clamp, damp } from '../core/mathx';
import { G } from '../core/globals';
import { WORLD_Z0, WORLD_Z1, riverX, terrainHeight } from '../world/geography';

/** How far the free camera may roam: across the river from its centre line, along it, and up. */
const REACH = 900;
const Z_MAX = WORLD_Z0 - 60;
const Z_MIN = WORLD_Z1 + 260;
const CEILING = 140;
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

  /** Takes over from wherever the camera is now. */
  startFrom(camera: PerspectiveCamera): void {
    this.pos.copy(camera.position);
    camera.getWorldDirection(this.fwd);
    this.yaw = this.yawT = Math.atan2(this.fwd.x, this.fwd.z);
    this.pitch = this.pitchT = Math.asin(clamp(this.fwd.y, -1, 1));
    this.vel.set(0, 0, 0);
    this.push = 0;
  }

  /** Puts the camera at a point looking along `yaw` (radians, 0 = +z) and `pitch`; for stills. */
  place(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.pos.set(x, y, z);
    this.yaw = this.yawT = yaw;
    this.pitch = this.pitchT = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.vel.set(0, 0, 0);
    this.push = 0;
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
    const ground = Math.max(terrainHeight(this.pos.x, this.pos.z), G.uWaterLevel.value);
    const speed = SPEED * (1 + (this.pos.y - ground) / 25) * (has('ShiftLeft') || has('ShiftRight') ? 4 : 1);
    this.want.copy(this.fwd).multiplyScalar(ahead).addScaledVector(this.right, side);
    if (this.want.lengthSq() > 1) this.want.normalize();
    this.want.multiplyScalar(speed);
    this.want.y += lift * speed * 0.7;
    const k = 1 - Math.exp(-dt * 6);
    this.vel.lerp(this.want, k);
    const step = this.push * k;
    this.push -= step;
    this.pos.addScaledVector(this.vel, dt).addScaledVector(this.fwd, step);

    // stay inside the world, above the ground and the water
    this.pos.z = clamp(this.pos.z, Z_MIN, Z_MAX);
    const cx = riverX(this.pos.z);
    this.pos.x = clamp(this.pos.x, cx - REACH, cx + REACH);
    const floor = Math.max(terrainHeight(this.pos.x, this.pos.z), G.uWaterLevel.value) + CLEARANCE;
    this.pos.y = clamp(this.pos.y, floor, CEILING);

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
