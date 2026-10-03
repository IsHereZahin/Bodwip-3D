import { HERO_HULL, heroBeamAtWater } from './hull';

// The water the hero boat moves as she goes, one field for the water's surface (which rises and falls with
// it near the camera and takes its slopes from it) and for what floats near her:
// - pushed aside by her hull, the water heaps up at her bow and on both sides of it, is drawn down along her
//   middle, where it runs fastest past her, and rises again at her stern (as Bernoulli has it, the heights
//   going with the square of her speed: a strong stroke's surge lifts her bow wave at once);
// - from her bow the Kelvin wake spreads behind her: two arms of short diverging crests at 19.5° either side
//   of her track, and transverse waves between them, all standing still in her frame (the river runs
//   through them), their length set by her speed (λ = 2πv²/g);
// - the paddle's blade, while it pulls, heaps water up behind its face and draws it down in front.
// Heights are in metres, in her frame: q.x across her (to starboard), q.y along her (toward the bow).

const HALF = HERO_HULL.len * 0.4;
const BEAM = heroBeamAtWater(0.5);
const KELVIN = Math.tan((19.47 * Math.PI) / 180);
const GRAVITY = 9.81;

const sq = (x: number) => x * x;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Height of the boat's own waves (m) at `q` in her frame, going `speed` m/s through the water; no blade. */
export function wakeHeight(qx: number, qy: number, speed: number): number {
  const amp = 0.023 * speed * speed;
  if (amp < 1e-4) return 0;
  const ax = Math.abs(qx);
  const s = Math.min(1, Math.max(-1, qy / HALF));
  const hb = BEAM * Math.pow(Math.max(1 - s * s, 0), 0.4);
  const dd = Math.hypot(Math.max(ax - hb, 0), Math.max(Math.abs(qy) - HALF, 0));
  const press =
    Math.exp(-sq((qy - 0.8 * HALF) / 1.1)) - 0.55 * Math.exp(-sq((qy + 0.05 * HALF) / (0.45 * HALF))) + 0.4 * Math.exp(-sq((qy + 0.95 * HALF) / 1.3));
  let h = amp * press * Math.exp(-dd / 0.9);
  const d = 0.8 * HALF - qy;
  if (d > 0) {
    const lt = (Math.PI * 2 * speed * speed) / GRAVITY;
    const arm = BEAM * 0.9 + d * KELVIN;
    const e = (ax - arm) / (0.35 + d * 0.06);
    const decay = Math.exp(-d * 0.012) / (1 + d * 0.07);
    h += amp * 0.6 * Math.exp(-e * e) * decay * Math.cos((Math.PI * 2 * (d * 0.57 + ax * 0.82)) / (0.6 * lt));
    const inside = smooth(arm + 0.3, arm - 1.2, ax) * smooth(1.4 * HALF, 2 * HALF, d);
    h += amp * 0.3 * inside * decay * Math.cos((Math.PI * 2 * d) / lt);
  }
  return h;
}

/**
 * GLSL twin of wakeHeight, plus the blade: `boatWake(q, speed, oar, spacing)`, where `oar` is the blade in
 * her frame (x, z), how hard it pulls and how wet it is, and `spacing` how far apart the mesh's vertices
 * lie there (0 for the full detail): features too small for the mesh to draw fade out of its height.
 */
export function wakeGlsl(): string {
  const f = (n: number) => n.toFixed(4);
  return /* glsl */ `
float boatWake(vec2 q, float spd, vec4 oar, float spacing) {
  float amp = 0.023 * spd * spd;
  float ax = abs(q.x);
  float s = clamp(q.y / ${f(HALF)}, -1.0, 1.0);
  float hb = ${f(BEAM)} * pow(max(1.0 - s * s, 0.0), 0.4);
  float dd = length(vec2(max(ax - hb, 0.0), max(abs(q.y) - ${f(HALF)}, 0.0)));
  float yb = (q.y - ${f(0.8 * HALF)}) / 1.1;
  float ym = (q.y + ${f(0.05 * HALF)}) / ${f(0.45 * HALF)};
  float ys = (q.y + ${f(0.95 * HALF)}) / 1.3;
  float h = amp * (exp(-yb * yb) - 0.55 * exp(-ym * ym) + 0.4 * exp(-ys * ys)) * exp(-dd / 0.9);
  if (spacing > 0.0) h *= smoothstep(1.2, 0.5, spacing);
  float d = ${f(0.8 * HALF)} - q.y;
  if (d > 0.0 && amp > 1e-4) {
    float lt = 6.2832 * spd * spd / 9.81;
    float arm = ${f(BEAM * 0.9)} + d * ${f(KELVIN)};
    float e = (ax - arm) / (0.35 + d * 0.06);
    float decay = exp(-d * 0.012) / (1.0 + d * 0.07);
    float ld = 0.6 * lt;
    float arms = amp * 0.6 * exp(-e * e) * decay * cos(6.2832 * (d * 0.57 + ax * 0.82) / ld);
    float inside = smoothstep(arm + 0.3, arm - 1.2, ax) * smoothstep(${f(1.4 * HALF)}, ${f(2 * HALF)}, d);
    float across = amp * 0.3 * inside * decay * cos(6.2832 * d / lt);
    if (spacing > 0.0) {
      arms *= smoothstep(ld * 0.5, ld * 0.25, spacing);
      across *= smoothstep(lt * 0.5, lt * 0.25, spacing);
    }
    h += arms + across;
  }
  // the blade, while it pulls: water heaped behind its face (toward the stern), drawn down in front
  float push = oar.z * oar.w;
  if (push > 0.01) {
    vec2 ba = q - oar.xy + vec2(0.0, 0.22);
    vec2 bf = q - oar.xy - vec2(0.0, 0.14);
    float blade = 0.016 * push * (exp(-dot(ba, ba) * 14.0) - 0.8 * exp(-dot(bf, bf) * 20.0));
    if (spacing > 0.0) blade *= smoothstep(0.3, 0.12, spacing);
    h += blade;
  }
  return h;
}`;
}
