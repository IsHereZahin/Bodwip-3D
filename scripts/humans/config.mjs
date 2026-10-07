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
  'skins/young_asian_male/',
  'skins/young_african_male/',
  'skins/old_asian_male/',
  'skins/old_african_male/',
  'eyes/high-poly/',
  'eyes/materials/brown',
  'eyebrows/eyebrow001/',
  'eyelashes/eyelashes01/',
  'hair/short04/',
  'hair/short03/',
];

/** Both sides of a face's paired modifier (eyes, cheeks) at one weight. */
const both = (group, name, w) => ({ [`${group}/l-${name}`]: w, [`${group}/r-${name}`]: w });

/**
 * The characters. `macro`: MakeHuman's macro sliders (gender 0 female .. 1 male; age 0.5 is 25 years, 1 is 90;
 * muscle, weight and height 0.5 average); `mods`: MakeHuman's modelling targets (targets/<group>/<name>) and their
 * weights, the face and the build of one person rather than the average the macros give; `height`: metres, soles
 * to crown, the body scaled to it; `skin`: two of MakeHuman's skins (same layout) blended toward `tone` (sRGB),
 * and `stubble` darkening the beard; `wear`: what the clothes cover (build.mjs: hidden skin and the fitted
 * garments). The faces are generic, made from sliders, not anyone's likeness.
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
  // the young boatman the film follows, a fisherman's son of about twenty: lean and strong from the paddle and
  // the net, broad in the shoulders and narrow in the waist, a clean jaw and high cheekbones, a straight nose,
  // dark eyes under level brows, a little stubble, thick black hair worn short at the sides
  tarun: {
    macro: { gender: 1, age: 0.5, muscle: 0.66, weight: 0.3, height: 0.6, race: { caucasian: 0.5, asian: 0.24, african: 0.26 } },
    mods: {
      'head/head-age-decr': 0.45,
      'head/head-oval': 0.3,
      'head/head-scale-horiz-decr': 0.1,
      'chin/chin-prominent-incr': 0.3,
      'chin/chin-bones-incr': 0.4,
      'chin/chin-width-incr': 0.1,
      ...both('cheek', 'cheek-bones-incr', 0.3),
      ...both('cheek', 'cheek-volume-decr', 0.3),
      'nose/nose-scale-horiz-decr': 0.18,
      'nose/nose-point-width-decr': 0.25,
      'nose/nose-hump-decr': 0.25,
      'nose/nose-nostrils-width-decr': 0.2,
      'mouth/mouth-lowerlip-volume-incr': 0.15,
      'mouth/mouth-angles-up': 0.1,
      ...both('eyes', 'eye-bag-decr', 0.5),
      ...both('eyes', 'eye-scale-incr', 0.06),
      'eyebrows/eyebrows-trans-down': 0.15,
      'neck/neck-scale-horiz-incr': 0.15,
      'torso/torso-vshape-incr': 0.2,
      'torso/torso-muscle-pectoral-incr': 0.15,
      'torso/torso-muscle-dorsi-incr': 0.15,
    },
    height: 1.71,
    // a warm, healthy wheaten brown, sun-touched
    skin: { light: 'skins/young_asian_male/young_lightskinned_male_diffuse3.png', dark: 'skins/young_african_male/young_darkskinned_male_diffuse.png', tone: '#b68460', stubble: 0.28 },
    eyes: 'eyes/materials/brown_eye.png',
    brows: 'eyebrows/eyebrow001',
    lashes: 'eyelashes/eyelashes01',
    // worn a little long and loose, so the wind lifts it, held off his face by the headband
    hair: { proxy: 'hair/short03', tint: '#100b08', loose: true, tuck: 0.055 },
    wear: ['sando', 'lungi'],
  },
};
