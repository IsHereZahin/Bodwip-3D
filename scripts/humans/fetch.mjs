// Downloads what the people are built from into scripts/humans/cache/ (git-ignored): MakeHuman's base mesh, its
// default skeleton and skin weights, the macro targets for grown men and women (gender × age × muscle × weight,
// the three ethnic shapes, height), and from the system asset pack only the members the characters use (the pack
// is a 280 MB zip; its members are read by range requests). All of it is CC0 (config.mjs).
//
//   node scripts/humans/fetch.mjs [--force]

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { listZip, readZipMember } from '../geo/lib/zip.mjs';
import { ASSETS, MAKEHUMAN, PACK, PACK_FOLDERS, RAW } from './config.mjs';

const force = process.argv.includes('--force');

const files = ['3dobjs/base.obj', 'rigs/default.mhskel', 'rigs/default_weights.mhw'];
for (const g of ['female', 'male'])
  for (const a of ['young', 'old']) {
    for (const race of ['african', 'asian', 'caucasian']) files.push(`targets/macrodetails/${race}-${g}-${a}.target`);
    for (const m of ['min', 'average', 'max'])
      for (const w of ['min', 'average', 'max']) {
        files.push(`targets/macrodetails/universal-${g}-${a}-${m}muscle-${w}weight.target`);
        for (const h of ['min', 'max']) files.push(`targets/macrodetails/height/${g}-${a}-${m}muscle-${w}weight-${h}height.target`);
      }
  }

async function get(url, to) {
  if (existsSync(to) && !force) return false;
  mkdirSync(path.dirname(to), { recursive: true });
  const res = await fetch(url, { headers: { 'User-Agent': 'bangla-river-humans' } });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(to));
  return true;
}

let fresh = 0;
for (const f of files) if (await get(RAW + f, path.join(MAKEHUMAN, f))) fresh++;
console.log(`makehuman data: ${files.length} files (${fresh} downloaded)`);

const members = (await listZip(PACK)).filter((e) => !e.name.endsWith('/') && !e.name.endsWith('.thumb') && PACK_FOLDERS.some((f) => e.name.startsWith(f)));
let taken = 0;
for (const e of members) {
  const to = path.join(ASSETS, e.name);
  if (existsSync(to) && !force) continue;
  mkdirSync(path.dirname(to), { recursive: true });
  writeFileSync(to, await readZipMember(PACK, e));
  taken++;
}
console.log(`asset pack: ${members.length} members (${taken} downloaded)`);
