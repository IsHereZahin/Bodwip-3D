// What the people are built from and who they are. Everything comes from MakeHuman (makehumancommunity.org),
// released CC0 in 2020: the base mesh, its targets, the default skeleton and weights, and the system asset pack
// (skins, eyes, eyebrows, eyelashes, hair). `fetch.mjs` downloads these into cache/ (git-ignored), `build.mjs`
// fits the characters and writes public/humans/, `textures.py` prepares their textures.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(ROOT, 'cache');
export const MAKEHUMAN = path.join(CACHE, 'makehuman');
export const ASSETS = path.join(CACHE, 'assets');
export const OUT = path.join(ROOT, '..', '..', 'public', 'humans');

export const RAW = 'https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data/';
export const PACK = 'https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip';

/** The asset pack's folders the characters use (taken out of the remote zip one member at a time). */
export const PACK_FOLDERS = [
  'skins/middleage_asian_male/',
  'skins/middleage_african_male/',
  'skins/old_asian_male/',
  'skins/old_african_male/',
  'skins/young_asian_female/',
  'skins/young_african_female/',
  'eyes/high-poly/',
  'eyes/materials/brown',
  'eyebrows/eyebrow001/',
  'eyebrows/eyebrow010/',
  'eyelashes/eyelashes01/',
  'eyelashes/eyelashes02/',
  'hair/short04/',
  'hair/short02/',
  'hair/braid01/',
];

/** A South Asian face from MakeHuman's three ethnic shapes [মডেল]. */
const BENGALI = { caucasian: 0.56, asian: 0.24, african: 0.2 };

/**
 * The characters. `macro`: MakeHuman's macro sliders (gender 0 female .. 1 male; age 0.5 is 25 years, 1 is 90;
 * muscle, weight and height 0.5 average); `height`: metres, soles to crown, the body scaled to it; `skin`: two
 * of MakeHuman's skins (same layout) blended toward `tone` (sRGB), and `stubble` darkening the beard; `wear`:
 * what the clothes cover (build.mjs: hidden skin and the fitted garments).
 */
export const CHARACTERS = {
  // the hero's majhi: a lean, sun-browned man in his forties
  majhi: {
    macro: { gender: 1, age: 0.7, muscle: 0.5, weight: 0.22, height: 0.45, race: { caucasian: 0.52, asian: 0.2, african: 0.28 } },
    height: 1.64,
    skin: { light: 'skins/middleage_asian_male/middleage_lightskinned_male_diffuse2.png', dark: 'skins/middleage_african_male/middleage_darkskinned_male_diffuse.png', tone: '#8a5a3c', stubble: 0.85 },
    eyes: 'eyes/materials/brown_eye.png',
    brows: 'eyebrows/eyebrow001',
    lashes: 'eyelashes/eyelashes01',
    hair: { proxy: 'hair/short04', tint: '#15100c' },
    wear: ['sando', 'lungi'],
  },
  // the girl on the bridge: a slight young woman
  meye: {
    macro: { gender: 0, age: 0.5, muscle: 0.42, weight: 0.4, height: 0.4, race: BENGALI },
    height: 1.53,
    skin: { light: 'skins/young_asian_female/young_lightskinned_female_diffuse3.png', dark: 'skins/young_african_female/young_darkskinned_female_diffuse.png', tone: '#a06a48', stubble: 0 },
    eyes: 'eyes/materials/brown_eye.png',
    brows: 'eyebrows/eyebrow010',
    lashes: 'eyelashes/eyelashes02',
    hair: { proxy: 'hair/braid01', tint: '#120d0a', braid: true },
    wear: ['kameez', 'salwar'],
  },
};
