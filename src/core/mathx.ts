export const DEG = Math.PI / 180;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach of `current` toward `target`. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Linear interpolation in a table of values at even steps from `f` = 0 to 1, clamped (a body's measured sections). */
export function tableAt(table: readonly number[], f: number): number {
  const x = Math.min(table.length - 1.0001, Math.max(0, f * (table.length - 1)));
  const k = Math.floor(x);
  return table[k] + (table[k + 1] - table[k]) * (x - k);
}

/** Shortest signed difference between two angles (radians). */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
