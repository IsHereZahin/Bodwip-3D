// The river's surface: a few long, low waves running with the wind, and a slower cross swell (the
// wakes of boats long gone). One definition drives the boat's buoyancy, the floating plants' bobbing
// and the water shader's slopes, so what floats moves with what the eye sees. Heights are in metres
// and scale with the wind's strength (G.uWind.z).

const WIND_ANGLE = Math.atan2(0.55, -0.83);
const GRAVITY = 9.81;

interface Wave {
  dx: number;
  dz: number;
  /** Wavenumber (rad/m) and angular frequency, from deep-water dispersion. */
  k: number;
  w: number;
  amp: number;
  phase: number;
}

function wave(angle: number, length: number, amp: number, phase: number): Wave {
  const k = (Math.PI * 2) / length;
  return { dx: Math.sin(angle), dz: Math.cos(angle), k, w: Math.sqrt(GRAVITY * k), amp, phase };
}

const WAVES: readonly Wave[] = [
  wave(WIND_ANGLE, 9.0, 0.022, 0.0),
  wave(WIND_ANGLE + 0.5, 5.3, 0.014, 1.7),
  wave(WIND_ANGLE - 0.6, 3.1, 0.008, 4.1),
  wave(WIND_ANGLE + 1.9, 14.0, 0.018, 2.6),
  wave(WIND_ANGLE - 0.25, 1.7, 0.004, 5.3),
];

/** Surface height above the still water line at (x, z), time t. */
export function waveHeight(x: number, z: number, t: number, strength: number): number {
  let h = 0;
  for (const v of WAVES) h += v.amp * Math.sin(v.k * (v.dx * x + v.dz * z) - v.w * t + v.phase);
  return h * strength;
}

/** Surface slope (dh/dx, dh/dz) at (x, z), time t. */
export function waveSlope(x: number, z: number, t: number, strength: number, out: { x: number; z: number }): { x: number; z: number } {
  out.x = 0;
  out.z = 0;
  for (const v of WAVES) {
    const c = v.amp * v.k * Math.cos(v.k * (v.dx * x + v.dz * z) - v.w * t + v.phase);
    out.x += c * v.dx;
    out.z += c * v.dz;
  }
  out.x *= strength;
  out.z *= strength;
  return out;
}

/** GLSL twin of waveHeight, using the shared uTime and uWind.z. */
export function waveHeightGlsl(): string {
  const f = (n: number) => n.toFixed(5);
  const terms = WAVES.map(
    (v) => `  h += ${f(v.amp)} * sin(${f(v.k)} * dot(p, vec2(${f(v.dx)}, ${f(v.dz)})) - ${f(v.w)} * uTime + ${f(v.phase)});`,
  ).join('\n');
  return /* glsl */ `
float waveHeight(vec2 p) {
  float h = 0.0;
${terms}
  return h * uWind.z;
}`;
}

/** Still water (khals, the bil, the slack by the banks) is sheltered: its waves are this share of the river's. */
export const SHELTERED = 0.35;

/** GLSL twin of waveSlope, using the shared uTime and uWind.z. */
export function waveSlopeGlsl(): string {
  const f = (n: number) => n.toFixed(5);
  const terms = WAVES.map(
    (v) =>
      `  s += vec2(${f(v.dx)}, ${f(v.dz)}) * (${f(v.amp * v.k)} * cos(${f(v.k)} * dot(p, vec2(${f(v.dx)}, ${f(v.dz)})) - ${f(v.w)} * uTime + ${f(v.phase)}));`,
  ).join('\n');
  return /* glsl */ `
vec2 waveSlope(vec2 p) {
  vec2 s = vec2(0.0);
${terms}
  return s * uWind.z;
}`;
}
