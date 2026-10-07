// Least-squares tidal harmonic analysis of the Cox's Bazar gauge (UHSLC hourly, UTC), one year at a time:
// amplitude and Greenwich phase lag of each constituent, nodal corrections taken at mid-year. No open
// table of the constants exists for Cox's Bazar (GEOGRAPHY_PLAN.md §3.6), so they are fitted here.
// Ported from the research session's harm.py; the conventions (Doodson/Schureman V0, Foreman f and u) are in lib/tide.mjs.
//
//   node scripts/geo/tide-fit.mjs 1983 1990 1995 …   fit these years, then their mean
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CACHE } from './config.mjs';
import { FREQ, NAMES, RAD, mod360, nodal, v0 } from './lib/tide.mjs';

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
