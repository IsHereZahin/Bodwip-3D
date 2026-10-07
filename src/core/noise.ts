function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function blend(a: number, b: number, c: number, d: number, fx: number, fy: number): number {
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Smooth value noise in [0, 1]. */
export function valueNoise(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  return blend(
    hash(ix, iy, seed),
    hash(ix + 1, iy, seed),
    hash(ix, iy + 1, seed),
    hash(ix + 1, iy + 1, seed),
    x - ix,
    y - iy,
  );
}

/** Fractal value noise in [0, 1]. */
export function fbm(x: number, y: number, octaves = 4, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x, y, seed + i * 101);
    norm += amp;
    x = x * 2.03 + 17.1;
    y = y * 2.03 - 9.7;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Value noise that repeats every `period` cells, for textures that tile. */
export function periodicNoise(x: number, y: number, period: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const wrap = (v: number) => ((v % period) + period) % period;
  const x0 = wrap(ix);
  const x1 = wrap(ix + 1);
  const y0 = wrap(iy);
  const y1 = wrap(iy + 1);
  return blend(hash(x0, y0, seed), hash(x1, y0, seed), hash(x0, y1, seed), hash(x1, y1, seed), x - ix, y - iy);
}

/** fract(x), as GLSL has it. */
const fract = (x: number) => x - Math.floor(x);

/** The CPU twin of glsl.ts `hash12`: what a shader's hash gives at (x, y), for placing things where it paints them. */
export function glslHash12(x: number, y: number): number {
  let px = fract(x * 0.1031);
  let py = fract(y * 0.1031);
  let pz = fract(x * 0.1031);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d;
  py += d;
  pz += d;
  return fract((px + py) * pz);
}

/** The CPU twin of glsl.ts `vnoise`. */
export function glslNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  return blend(glslHash12(ix, iy), glslHash12(ix + 1, iy), glslHash12(ix, iy + 1), glslHash12(ix + 1, iy + 1), x - ix, y - iy);
}
