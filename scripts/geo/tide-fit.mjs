// Least-squares tidal harmonic analysis of the Cox's Bazar gauge (UHSLC hourly, UTC), one year at a time:
// amplitude and Greenwich phase lag of each constituent, nodal corrections taken at mid-year. No open
// table of the constants exists for Cox's Bazar (GEOGRAPHY_PLAN.md §3.6), so they are fitted here.
// Ported from the research session's harm.py, same conventions (Doodson/Schureman V0, Foreman f and u).
//
//   node scripts/geo/tide-fit.mjs 1983 1990 1995 …   fit these years, then their mean
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CACHE } from './config.mjs';

/** Speeds, degrees per hour. */
const FREQ = {
  Sa: 0.0410686, Ssa: 0.0821373, MSf: 1.0158958,
  Q1: 13.3986609, O1: 13.9430356, P1: 14.9589314, K1: 15.0410686,
  N2: 28.4397295, M2: 28.9841042, S2: 30.0, K2: 30.0821373,
  MN4: 57.4238337, M4: 57.9682084, MS4: 58.9841042, M6: 86.9523127,
};
const NAMES = Object.keys(FREQ);
const RAD = Math.PI / 180;
const mod360 = (a) => ((a % 360) + 360) % 360;

/** Mean longitudes of the moon (s), sun (h), lunar perigee (p) and the moon's ascending node (N), degrees. */
function astro(date) {
  const d = (date - Date.UTC(2000, 0, 1, 12)) / 86400000;
  return { s: mod360(218.3164 + 13.17639648 * d), h: mod360(280.4661 + 0.98564736 * d), p: mod360(83.3535 + 0.11140353 * d), N: mod360(125.0445 - 0.05295377 * d) };
}

/** Equilibrium argument V0 at `date` (UTC). */
function v0(name, date) {
  const { s, h, p } = astro(date);
  const t = new Date(date);
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

/** Nodal factor f and angle u (degrees) at `date`. */
function nodal(name, date) {
  const N = astro(date).N * RAD;
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

/** Gaussian elimination with partial pivoting (the normal equations are small). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    for (let r = i + 1; r < n; r++) {
      const f = M[r][i] / M[i][i];
      for (let k = i; k <= n; k++) M[r][k] -= f * M[i][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let k = i + 1; k < n; k++) sum -= M[i][k] * x[k];
    x[i] = sum / M[i][i];
  }
  return x;
}

function fitYear(rows, year) {
  const t0 = Date.UTC(year, 0, 1);
  const tmid = Date.UTC(year, 6, 2);
  const obs = rows.filter((r) => r.year === year).map((r) => ({ t: (r.time - t0) / 3600000, v: r.metres }));
  const nb = 1 + 2 * NAMES.length;
  const ATA = Array.from({ length: nb }, () => new Array(nb).fill(0));
  const ATb = new Array(nb).fill(0);
  const basis = (t) => [1, ...NAMES.flatMap((nm) => [Math.cos(FREQ[nm] * t * RAD), Math.sin(FREQ[nm] * t * RAD)])];
  for (const { t, v } of obs) {
    const x = basis(t);
    for (let i = 0; i < nb; i++) {
      ATb[i] += x[i] * v;
      for (let j = 0; j < nb; j++) ATA[i][j] += x[i] * x[j];
    }
  }
  const sol = solve(ATA, ATb);
  let ss = 0;
  for (const { t, v } of obs) {
    const x = basis(t);
    let pred = 0;
    for (let i = 0; i < nb; i++) pred += sol[i] * x[i];
    ss += (v - pred) ** 2;
  }
  const constituents = {};
  NAMES.forEach((nm, k) => {
    const a = sol[1 + 2 * k];
    const b = sol[2 + 2 * k];
    const [f, u] = nodal(nm, tmid);
    constituents[nm] = { H: Math.hypot(a, b) / f, G: mod360(v0(nm, t0) + u + Math.atan2(b, a) / RAD) };
  });
  return { year, n: obs.length, Z0: sol[0], rms: Math.sqrt(ss / obs.length), constituents };
}

const csv = await readFile(fileURLToPath(new URL('uhslc-coxs-bazar.csv', CACHE)), 'utf8');
const rows = [];
for (const line of csv.split('\n')) {
  const parts = line.trim().split(',');
  if (parts.length < 5) continue;
  const [y, mo, d, hr, v] = parts.map(Number);
  // −32767 marks a gap; anything outside the gauge's range is bad
  if (!(v > -1000 && v < 20000)) continue;
  rows.push({ year: y, time: Date.UTC(y, mo - 1, d, hr), metres: v / 1000 });
}

const years = process.argv.slice(2).map(Number).filter(Boolean);
const fits = years.map((y) => fitYear(rows, y)).filter((f) => f.n > 24 * 200);
for (const f of fits) {
  const show = ['M2', 'S2', 'N2', 'K2', 'K1', 'O1', 'M4'].map((nm) => `${nm} ${f.constituents[nm].H.toFixed(3)} m ${f.constituents[nm].G.toFixed(0)}°`).join('  ');
  console.log(`${f.year}: n=${f.n} rms=${f.rms.toFixed(3)} m  ${show}`);
}
if (fits.length) {
  // phases averaged as unit vectors, so 359° and 1° average to 0°
  const mean = {};
  for (const nm of NAMES) {
    const H = fits.reduce((a, f) => a + f.constituents[nm].H, 0) / fits.length;
    const x = fits.reduce((a, f) => a + Math.cos(f.constituents[nm].G * RAD), 0);
    const y = fits.reduce((a, f) => a + Math.sin(f.constituents[nm].G * RAD), 0);
    mean[nm] = { H: +H.toFixed(4), G: +mod360(Math.atan2(y, x) / RAD).toFixed(1) };
  }
  const out = { station: "Cox's Bazar (UHSLC h136a)", years: fits.map((f) => f.year), note: 'Greenwich phase lags, UTC; amplitudes as recorded by the gauge', constituents: mean };
  await writeFile(fileURLToPath(new URL('tide-coxs-bazar.json', CACHE)), JSON.stringify(out, null, 2));
  console.log('mean:', ['M2', 'S2', 'N2', 'K2', 'K1', 'O1', 'M4'].map((nm) => `${nm} ${mean[nm].H} m ${mean[nm].G}°`).join('  '));
}
