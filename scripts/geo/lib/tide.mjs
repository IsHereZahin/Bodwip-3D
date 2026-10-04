// Tidal harmonics shared by the fit (tide-fit.mjs) and the bake: constituent speeds, equilibrium arguments
// (Doodson/Schureman V0), nodal corrections (Foreman f and u), and a predictor.

/** Speeds, degrees per hour. */
export const FREQ = {
  Sa: 0.0410686, Ssa: 0.0821373, MSf: 1.0158958,
  Q1: 13.3986609, O1: 13.9430356, P1: 14.9589314, K1: 15.0410686,
  N2: 28.4397295, M2: 28.9841042, S2: 30.0, K2: 30.0821373,
  MN4: 57.4238337, M4: 57.9682084, MS4: 58.9841042, M6: 86.9523127,
};
export const NAMES = Object.keys(FREQ);
/** The long-period ones: seasonal and fortnightly, not damped by the gauge like the tide itself. */
export const LONG_PERIOD = new Set(['Sa', 'Ssa', 'MSf']);

export const RAD = Math.PI / 180;
export const mod360 = (a) => ((a % 360) + 360) % 360;

/** Mean longitudes of the moon (s), sun (h), lunar perigee (p) and the moon's ascending node (N), degrees. */
function astro(time) {
  const d = (time - Date.UTC(2000, 0, 1, 12)) / 86400000;
  return { s: mod360(218.3164 + 13.17639648 * d), h: mod360(280.4661 + 0.98564736 * d), p: mod360(83.3535 + 0.11140353 * d), N: mod360(125.0445 - 0.05295377 * d) };
}

/** Equilibrium argument V0 at `time` (ms, UTC). */
export function v0(name, time) {
  const { s, h, p } = astro(time);
  const t = new Date(time);
  const T = 180 + 15 * (t.getUTCHours() + t.getUTCMinutes() / 60);
  const V = {
    Sa: h, Ssa: 2 * h, MSf: 2 * s - 2 * h,
    Q1: T + h - 3 * s + p + 90, O1: T + h - 2 * s + 90, P1: T - h + 90, K1: T + h - 90,
    N2: 2 * T + 2 * h - 3 * s + p, M2: 2 * T + 2 * h - 2 * s, S2: 2 * T, K2: 2 * T + 2 * h,
  };
  V.M4 = 2 * V.M2;
  V.MS4 = V.M2 + V.S2;
  V.MN4 = V.M2 + V.N2;
  V.M6 = 3 * V.M2;
  return mod360(V[name]);
}

/** Nodal factor f and angle u (degrees) at `time`. */
export function nodal(name, time) {
  const N = astro(time).N * RAD;
  const c = Math.cos;
  const s = Math.sin;
  const fM2 = 1.0004 - 0.0373 * c(N) + 0.0002 * c(2 * N);
  const uM2 = -2.14 * s(N);
  const fK1 = 1.006 + 0.115 * c(N) - 0.0088 * c(2 * N) + 0.0006 * c(3 * N);
  const uK1 = -8.86 * s(N) + 0.68 * s(2 * N) - 0.07 * s(3 * N);
  const fO1 = 1.0089 + 0.1871 * c(N) - 0.0147 * c(2 * N) + 0.0014 * c(3 * N);
  const uO1 = 10.8 * s(N) - 1.34 * s(2 * N) + 0.19 * s(3 * N);
  const fK2 = 1.0241 + 0.2863 * c(N) + 0.0083 * c(2 * N) - 0.0015 * c(3 * N);
  const uK2 = -17.74 * s(N) + 0.68 * s(2 * N) - 0.04 * s(3 * N);
  const table = {
    M2: [fM2, uM2], N2: [fM2, uM2], S2: [1, 0], K2: [fK2, uK2],
    K1: [fK1, uK1], O1: [fO1, uO1], Q1: [fO1, uO1], P1: [1, 0],
    M4: [fM2 ** 2, 2 * uM2], MS4: [fM2, uM2], MN4: [fM2 ** 2, 2 * uM2], M6: [fM2 ** 3, 3 * uM2],
    Sa: [1, 0], Ssa: [1, 0], MSf: [fM2, -uM2],
  };
  return table[name];
}

/**
 * A predictor for the level about mean sea level (m) at a time (ms, UTC) from constants
 * `{ name: { H, G } }`. `scale` multiplies the tidal amplitudes (not the long-period ones): the gauge
 * records the tide ≈1.38 times too small (GEO_AUDIT.md §2.6). Arguments are taken at the start of each
 * year and nodal terms at its middle, as in the fit.
 */
export function predictor(constituents, scale = 1) {
  const years = new Map();
  const yearTerms = (y) => {
    if (!years.has(y)) {
      const t0 = Date.UTC(y, 0, 1);
      const tmid = Date.UTC(y, 6, 2);
      years.set(
        y,
        Object.entries(constituents).map(([name, { H, G }]) => {
          const [f, u] = nodal(name, tmid);
          const k = LONG_PERIOD.has(name) ? 1 : scale;
          return { w: FREQ[name], amp: f * H * k, phase: v0(name, t0) + u - G, t0 };
        }),
      );
    }
    return years.get(y);
  };
  return (time) => {
    let level = 0;
    for (const c of yearTerms(new Date(time).getUTCFullYear())) level += c.amp * Math.cos((c.phase + (c.w * (time - c.t0)) / 3600000) * RAD);
    return level;
  };
}
