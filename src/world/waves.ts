import { G } from '../core/globals';
import { WIND_MS } from '../env/wind';
import { exposureAt } from './exposure';
import { terrainHeight } from './geography';

// The river's surface, one definition for everything that floats on it (the boats' buoyancy, the plants'
// bobbing, the nets) and, through the GLSL twins, for the water itself: its surface rises and falls with
// these waves near the camera and takes its slopes from them everywhere, so what floats moves with what
// the eye sees.
// The waves are the wind's, grown as a wind grows them over a broad river's fetch (fetch-limited, after
// the JONSWAP relations): a light air leaves the water glassy, a breeze raises wavelets of a few
// centimetres, a strong wind waves of a quarter of a metre and more, a kalboishakhi's squall half a metre
// crest to trough, and the stronger the wind the longer its waves (from about 3 m in a breeze to 9 m in a
// storm). Each wave length gets its share by a Pierson–Moskowitz spectrum around that peak, none steeper
// than water stands. Rain and gusts add a short chop on top, and a long, low cross swell (the wakes of
// boats long gone) keeps even still air from leaving the river dead flat. The sea state follows the
// weather at the water's pace: waves take a while to build and longer to die away.
// The waves run with the wind, whichever way it blows: there are four sets of them, one for each quarter
// of the compass, and each is as strong as the wind blows its way. When the wind backs or veers, the waves
// from its new quarter build as the old ones die down, as on real water (rather than the field turning).
// Heights are in metres.

const GRAVITY = 9.81;
/** The fetch the wind has over the channel to raise its waves (m): a long reach of a broad river. */
const FETCH = 5000;
/**
 * How much higher the wind's waves stand out on the open Bay than in the channel (its fetch there is tens of
 * kilometres: fetch-limited height grows as its square root) [মডেল: no fetch map yet].
 */
export const OPEN_SEA = 1.2;
/** No wave's greatest slope (a·k) goes past this: they break first. */
const STEEPEST = 0.15;
/** The four quarters the sets run toward (rad, in the wind's own sense: x = sin, z = cos). */
const QUARTERS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

type Kind = 'wind' | 'chop' | 'cross';
/** The nine wave shapes of a set, relative to the way the set runs: [kind, turn (rad), length (m), phase]. */
const SHAPES: readonly (readonly [Kind, number, number, number])[] = [
  ['wind', 0, 14.0, 0.0],
  ['wind', 0.3, 10.0, 1.7],
  ['wind', -0.4, 7.0, 4.1],
  ['wind', 0.55, 4.8, 2.6],
  ['wind', -0.65, 3.3, 5.3],
  ['wind', 0.2, 2.2, 0.9],
  ['chop', 1.05, 1.4, 3.3],
  ['chop', -1.25, 0.95, 5.9],
  ['cross', 1.9, 18.0, 2.2],
];
/** The cross swell's amplitude (m), whatever the weather. */
const CROSS = 0.011;
/** What a full downpour adds to the chop (m), by shape (the short wind waves and the chop). */
const RAIN_CHOP: Readonly<Record<number, number>> = { 5: 0.008, 6: 0.011, 7: 0.008 };

interface Wave {
  dx: number;
  dz: number;
  /** Wavenumber (rad/m), angular frequency from deep-water dispersion, and wavelength (m). */
  k: number;
  w: number;
  length: number;
  phase: number;
  /** Which of the nine wave shapes it is (its amplitude is amps[shape]), and which quarter's set it is in. */
  shape: number;
  set: number;
}

const WAVES: readonly Wave[] = QUARTERS.flatMap((quarter, set) =>
  SHAPES.map(([, turn, length, phase], shape) => {
    const angle = quarter + turn;
    const k = (Math.PI * 2) / length;
    // each set's waves start at their own places, so the four never look alike
    return { dx: Math.sin(angle), dz: Math.cos(angle), k, w: Math.sqrt(GRAVITY * k), length, phase: phase + set * 2.17, shape, set };
  }),
);

/**
 * The sea state now: the wind the waves have grown to (m/s, behind the wind itself), how much chop the
 * rain is throwing up (0..1), and what that makes of them: the significant height (m, the mean of the
 * highest third, crest to trough) and the length of the waves carrying most of it (m).
 */
export const sea = { wind: 2, chop: 0, height: 0, peak: 3 };
/** Each shape's amplitude now (m); mirrored in G.uWaveA/B/C for the shaders. */
const amps = new Float32Array(12);
/** How much of each quarter's set is running, by the wind's direction (Σ² = 1); mirrored in G.uWaveDir. */
const quarters = new Float32Array(4);

/** Seconds for waves to build up toward what the weather asks, and to die away. */
const BUILD = { wind: 18, chop: 5 };
const FADE = { wind: 40, chop: 12 };

/** Significant wave height (m) a wind of `u` m/s raises over the fetch; below about 1 m/s it raises none. */
const heightFor = (u: number) => 0.04 * u * Math.min(1, Math.max(0, (u - 0.8) / 3));
/** Length (m) of the waves at the peak of its spectrum. */
function peakFor(u: number): number {
  const v = Math.max(u, 1);
  const period = 0.286 * (v / GRAVITY) * Math.cbrt((GRAVITY * FETCH) / (v * v));
  return (GRAVITY * period * period) / (Math.PI * 2);
}

/**
 * Eases the sea toward what the weather asks: `wind` is its mean strength (G.uWind.z, squalls included),
 * `gusts` how gusty it is (G.uWind.w), `rain` how hard it rains (0..1); the waves run the way G.uWind.xy
 * blows. With `settle` it is there at once.
 */
export function updateSea(dt: number, wind: number, gusts: number, rain: number, settle = false): void {
  const ease = (now: number, want: number, build: number, fade: number) =>
    settle ? want : now + (want - now) * (1 - Math.exp(-dt / (want > now ? build : fade)));
  sea.wind = ease(sea.wind, wind * WIND_MS * (1 + 0.15 * gusts), BUILD.wind, FADE.wind);
  sea.chop = ease(sea.chop, rain * (0.6 + 0.4 * gusts), BUILD.chop, FADE.chop);
  sea.height = heightFor(sea.wind);
  sea.peak = peakFor(sea.wind);
  // the wind's waves: each length's share by the spectrum (amplitude ∝ length below the peak, so all
  // equally steep there; falling away fast for waves longer than this wind can build), scaled to the height
  let sum = 0;
  SHAPES.forEach(([kind, , length], i) => {
    const r = kind === 'cross' ? 0 : length * Math.exp(-0.625 * (length / sea.peak) ** 2);
    amps[i] = r;
    sum += r * r;
  });
  const scale = sum > 0 ? sea.height / (2 * Math.SQRT2 * Math.sqrt(sum)) : 0;
  SHAPES.forEach(([kind, , length], i) => {
    const a = kind === 'cross' ? CROSS : amps[i] * scale + (RAIN_CHOP[i] ?? 0) * sea.chop;
    // leveling off softly as it nears breaking steepness
    const cap = STEEPEST / ((Math.PI * 2) / length);
    amps[i] = cap * Math.tanh(a / cap);
  });
  // the sets running the wind's way, shared between the two quarters it blows between
  const toward = Math.atan2(G.uWind.value.x, G.uWind.value.y);
  let norm = 0;
  QUARTERS.forEach((q, i) => {
    const c = Math.max(0, Math.cos(toward - q));
    quarters[i] = c;
    norm += c * c;
  });
  for (let i = 0; i < 4; i++) quarters[i] /= Math.sqrt(norm) || 1;
  G.uWaveA.value.fromArray(amps, 0);
  G.uWaveB.value.fromArray(amps, 4);
  G.uWaveC.value.fromArray(amps, 8);
  G.uWaveDir.value.fromArray(quarters);
  G.uSea.value.set(sea.height, sea.peak);
}

/** Wave `v`'s amplitude now, in its set. */
const ampNow = (v: Wave) => amps[v.shape] * quarters[v.set];

/**
 * Surface height above the still water line at (x, z), time t; `shelter` scales the wind's waves for still
 * water (see SHELTERED). Out toward the Bay the wind's waves are higher (its fetch is longer) and the swell
 * comes in.
 */
export function waveHeight(x: number, z: number, t: number, shelter = 1): number {
  let h = 0;
  for (const v of WAVES) {
    const a = ampNow(v);
    if (a > 0) h += a * Math.sin(v.k * (v.dx * x + v.dz * z) - v.w * t + v.phase);
  }
  const open = exposureAt(x, z);
  h *= shelter * (1 + OPEN_SEA * open);
  if (open > 0.002) h += swellRaw(x, z, t) * swellFactor(x, z);
  return h;
}

/** Surface slope (dh/dx, dh/dz) at (x, z), time t, scaled as waveHeight. */
export function waveSlope(x: number, z: number, t: number, out: { x: number; z: number }, shelter = 1): { x: number; z: number } {
  out.x = 0;
  out.z = 0;
  for (const v of WAVES) {
    const a = ampNow(v);
    if (a <= 0) continue;
    const c = a * v.k * Math.cos(v.k * (v.dx * x + v.dz * z) - v.w * t + v.phase);
    out.x += c * v.dx;
    out.z += c * v.dz;
  }
  out.x *= shelter;
  out.z *= shelter;
  return out;
}

/** How a hull meets the waves: the mean height of the water over its waterline, and the water's slope along and across it. */
export interface HullWaves {
  heave: number;
  /** dh/d(along), toward the bow, and dh/d(across), toward +x of the hull. */
  along: number;
  across: number;
}

/** sin(x)/x, and the least-squares slope factor 3(sin x − x cos x)/x³ (both → 1 as x → 0). */
const sinc = (x: number) => (Math.abs(x) < 1e-4 ? 1 : Math.sin(x) / x);
const slopeFit = (x: number) => (Math.abs(x) < 1e-3 ? 1 - (x * x) / 10 : (3 * (Math.sin(x) - x * Math.cos(x))) / (x * x * x));

/**
 * The waves as a floating hull feels them: its waterline (`len` × `beam`, at (x, z), bow toward `heading`)
 * averages the water's height and fits its tilt, so waves much shorter than the hull largely cancel under
 * her and long ones lift and tilt her whole (exact, wave by wave, for a rectangular waterline).
 */
export function hullWaves(x: number, z: number, heading: number, len: number, beam: number, t: number, shelter: number, out: HullWaves): HullWaves {
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  out.heave = 0;
  out.along = 0;
  out.across = 0;
  for (const v of WAVES) {
    const amp = ampNow(v) * shelter;
    if (amp <= 0) continue;
    const a = v.k * (v.dx * fx + v.dz * fz);
    const b = v.k * (v.dx * fz - v.dz * fx);
    const phase = v.k * (v.dx * x + v.dz * z) - v.w * t + v.phase;
    const sa = sinc((a * len) / 2);
    const sb = sinc((b * beam) / 2);
    out.heave += amp * Math.sin(phase) * sa * sb;
    out.along += amp * a * Math.cos(phase) * slopeFit((a * len) / 2) * sb;
    out.across += amp * b * Math.cos(phase) * slopeFit((b * beam) / 2) * sa;
  }
  // out toward the Bay: the wind's waves higher, and the swell (long enough to lift and tilt any hull whole)
  const open = exposureAt(x, z);
  if (open > 0.002) {
    const k = 1 + OPEN_SEA * open;
    out.heave *= k;
    out.along *= k;
    out.across *= k;
    const s = swellFactor(x, z);
    if (s > 0) {
      out.heave += swellRaw(x, z, t) * s;
      SWELL_WAVES.forEach((v, i) => {
        const c = swellAmps[i] * s * v.k * Math.cos(v.k * (v.dx * x + v.dz * z) - v.w * t + v.phase);
        out.along += c * (v.dx * fx + v.dz * fz);
        out.across += c * (v.dx * fz - v.dz * fx);
      });
    }
  }
  return out;
}

// ---------- the Bay's swell ----------
//
// Long waves raised by far-off weather over the Bay (GEOGRAPHY_PLAN.md §8.7: 64 % from the south, 14 % SSW,
// 13 % SSE, mostly 7–10 s), as high as the season has them (season.ts `swell`). Each point of the sea's water
// gets them as far as it is open to the Bay (world/exposure.ts); over the shallows they rise (Green's law,
// H ∝ d^−¼) until they break, a wave being no higher than 0.78 of the depth, and the surf foams there.

/** The three trains: the way each runs (rad, x = sin, z = cos: 0 toward the north), period (s), share of the height. */
const SWELL: readonly (readonly [number, number, number])[] = [
  [0, 8.5, 0.8],
  [-0.39, 7.5, 0.4],
  [0.39, 9.5, 0.4],
];
const SWELL_WAVES = SWELL.map(([toward, period], i) => {
  const w = (Math.PI * 2) / period;
  const k = (w * w) / GRAVITY;
  return { dx: Math.sin(toward), dz: Math.cos(toward), k, w, phase: 1.3 + i * 2.1 };
});
const SWELL_NORM = Math.hypot(...SWELL.map(([, , share]) => share));
/** Each train's amplitude now (m), and their sum. */
const swellAmps = new Float32Array(3);

/** Sets the swell's significant height (m) at the coast, outside the breakers. */
export function setSwell(height: number): void {
  let sum = 0;
  SWELL.forEach(([, , share], i) => {
    swellAmps[i] = (height / (2 * Math.SQRT2)) * (share / SWELL_NORM);
    sum += swellAmps[i];
  });
  G.uSwell.value.set(swellAmps[0], swellAmps[1], swellAmps[2], sum);
}

/** Depth (m) the swell's growth over the shallows is reckoned from. */
const SHOAL_REF = 10;

/**
 * How much of the swell stands at (x, z), as a share of the open Bay's: its exposure, raised over the
 * shallows, and no more than the depth lets a wave stand before it breaks. 0 on inland water and dry ground.
 */
export function swellFactor(x: number, z: number): number {
  const exposure = exposureAt(x, z);
  if (exposure < 0.002 || G.uSwell.value.w <= 0) return 0;
  const depth = G.uWaterLevel.value - terrainHeight(x, z);
  if (depth <= 0.05) return 0;
  const shoal = Math.min(1.6, Math.max(1, (SHOAL_REF / Math.max(depth, 0.5)) ** 0.25));
  return Math.min(exposure * shoal, (0.39 * depth) / G.uSwell.value.w);
}

/** The swell's height at (x, z), time t, before its factor there. */
function swellRaw(x: number, z: number, t: number): number {
  let h = 0;
  SWELL_WAVES.forEach((v, i) => (h += swellAmps[i] * Math.sin(v.k * (v.dx * x + v.dz * z) - v.w * t + v.phase)));
  return h;
}

/** GLSL: the swell's height and slope at p (before its factor there: swellFactor), and that factor from the water's exposure and depth. */
export function swellGlsl(): string {
  const terms = (body: (v: (typeof SWELL_WAVES)[number], i: number) => string) => SWELL_WAVES.map(body).join('\n');
  const phase = (v: (typeof SWELL_WAVES)[number]) => `${f(v.k)} * dot(p, vec2(${f(v.dx)}, ${f(v.dz)})) - ${f(v.w)} * uTime + ${f(v.phase)}`;
  return /* glsl */ `
float swellHeight(vec2 p) {
  float h = 0.0;
${terms((v, i) => `  h += uSwell.${'xyz'[i]} * sin(${phase(v)});`)}
  return h;
}
vec2 swellSlope(vec2 p) {
  vec2 s = vec2(0.0);
${terms((v, i) => `  s += uSwell.${'xyz'[i]} * ${f(v.k)} * cos(${phase(v)}) * vec2(${f(v.dx)}, ${f(v.dz)});`)}
  return s;
}
float swellFactor(float exposure, float depth) {
  if (exposure < 0.002 || uSwell.w <= 0.0 || depth <= 0.05) return 0.0;
  float shoal = clamp(pow(${SHOAL_REF.toFixed(1)} / max(depth, 0.5), 0.25), 1.0, 1.6);
  return min(exposure * shoal, 0.39 * depth / uSwell.w);
}
// how hard the swell is breaking at a point (0..1): as near as its uncapped height comes to the depth's limit
float swellBreaking(float exposure, float depth) {
  if (exposure < 0.002 || uSwell.w <= 0.0) return 0.0;
  float shoal = clamp(pow(${SHOAL_REF.toFixed(1)} / max(depth, 0.5), 0.25), 1.0, 1.6);
  return smoothstep(0.6, 1.05, exposure * shoal * uSwell.w / max(0.39 * depth, 1e-3));
}`;
}

/** Still water (khals, the bil, the slack by the banks) is sheltered: its waves are this share of the river's. */
export const SHELTERED = 0.35;

const f = (n: number) => n.toFixed(5);
const phaseOf = (v: Wave) => `${f(v.k)} * dot(p, vec2(${f(v.dx)}, ${f(v.dz)})) - ${f(v.w)} * uTime + ${f(v.phase)}`;
/** A shape's amplitude uniform, and a quarter's weight. */
const ampOf = (shape: number) => `uWave${'ABC'[shape >> 2]}.${'xyzw'[shape & 3]}`;
const quarterOf = (set: number) => `uWaveDir.${'xyzw'[set]}`;

/**
 * One quarter's set of terms, skipped when the wind does not blow that way (a branch on a uniform, so
 * cheap). `lod` fades each wave out where the mesh's vertices (`spacing` apart) are too far apart to draw it.
 */
function sets(term: (v: Wave) => string, into: string, lod = false): string {
  return QUARTERS.map((_, set) => {
    const terms = WAVES.filter((v) => v.set === set)
      .map((v) => {
        const fade = lod ? ` * smoothstep(${f(v.length / 3)}, ${f(v.length / 6)}, spacing)` : '';
        return `    ${into} += q * ${ampOf(v.shape)}${fade} * ${term(v)};`;
      })
      .join('\n');
    return `  if (${quarterOf(set)} > 0.0) {\n    float q = ${quarterOf(set)};\n${terms}\n  }`;
  }).join('\n');
}

/** GLSL twin of waveHeight (without the shelter, which the caller applies), using uTime and uWaveA/B/C/Dir. */
export function waveHeightGlsl(): string {
  return /* glsl */ `
float waveHeight(vec2 p) {
  float h = 0.0;
${sets((v) => `sin(${phaseOf(v)})`, 'h')}
  return h;
}`;
}

/**
 * waveHeight for a mesh whose vertices lie `spacing` metres apart there: each wave too short for the mesh
 * to draw fades out (its slope still shades the surface), so the surface never shimmers as the mesh moves.
 */
export function waveHeightLodGlsl(): string {
  return /* glsl */ `
float waveHeightLod(vec2 p, float spacing) {
  float h = 0.0;
${sets((v) => `sin(${phaseOf(v)})`, 'h', true)}
  return h;
}`;
}

/**
 * waveSlope as a pixel sees it: each wave faded out where the pixel's footprint on the water (`spacing`, m)
 * is too coarse to show it, or the short ones alias into rings round the eye far off.
 */
export function waveSlopeLodGlsl(): string {
  return /* glsl */ `
vec2 waveSlopeLod(vec2 p, float spacing) {
  vec2 s = vec2(0.0);
${sets((v) => `vec2(${f(v.dx)}, ${f(v.dz)}) * (${f(v.k)} * cos(${phaseOf(v)}))`, 's', true)}
  return s;
}`;
}

/** GLSL twin of waveSlope (without the shelter), using uTime and uWaveA/B/C/Dir. */
export function waveSlopeGlsl(): string {
  return /* glsl */ `
vec2 waveSlope(vec2 p) {
  vec2 s = vec2(0.0);
${sets((v) => `vec2(${f(v.dx)}, ${f(v.dz)}) * (${f(v.k)} * cos(${phaseOf(v)}))`, 's')}
  return s;
}`;
}
