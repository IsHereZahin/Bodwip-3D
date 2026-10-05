import { Color, Vector2, Vector3, Vector4 } from 'three';
import type { Texture } from 'three';

/**
 * Uniforms every scene shader shares. Materials hold references to these objects, so a single
 * write per frame moves the light, haze, wind and clock of the whole world together.
 */
export const G = {
  uTime: { value: 0 },
  /** Camera of the pass being drawn (the mirrored camera during the reflection pass). */
  uCamPos: { value: new Vector3() },
  uReflPass: { value: 0 },
  /** The real sun, which may be below the horizon. */
  uSunDir: { value: new Vector3(0, 0.2, -1).normalize() },
  uSunColor: { value: new Color() },
  /** Whichever of sun or moon is lighting the scene. */
  uKeyDir: { value: new Vector3(0, 1, 0) },
  uKeyColor: { value: new Color() },
  /** Sun-side glow of the horizon, which outlives the sun at dusk. */
  uGlow: { value: new Color() },
  uFogColor: { value: new Color() },
  uFogDensity: { value: 0.0011 },
  uFogFalloff: { value: 0.06 },
  uMist: { value: 0.004 },
  uNight: { value: 0 },
  /** Light scattered back by the silty water body; anything far enough under the surface takes this colour. */
  uWaterBody: { value: new Color() },
  /** xy: the way the wind blows toward, z: its strength (1 ≈ 4 m/s), w: how gusty (see env/wind.ts). */
  uWind: { value: new Vector4(0.97, 0.24, 1, 0.5) },
  /** x: phase of the gust fronts rolling downwind; y: how far they roll in a second (m), for the plants that answer them late. */
  uGust: { value: new Vector2(0, 0) },
  /** Each wave's amplitude now (world/waves.ts): the swell and the chop the wind and the rain have raised. */
  uWaveA: { value: new Vector4() },
  uWaveB: { value: new Vector4() },
  uWaveC: { value: new Vector4() },
  /** How much of each quarter's wave set is running (x toward +z, y +x, z −z, w −x): the waves run with the wind. */
  uWaveDir: { value: new Vector4(0, 0, 1, 0) },
  /** The Bay's swell (world/waves.ts): its three trains' amplitudes (m), and w their sum (a crest's height). */
  uSwell: { value: new Vector4() },
  /** The sea state: x its significant wave height (m), y the length of its main waves (m). */
  uSea: { value: new Vector2(0, 3) },
  /** The sea's surface (m about mean sea level). This world has no sea: main.ts holds it at the khal's level, for what still reads it. */
  uWaterLevel: { value: 0 },
  /** The last high water's level (m): the flats below it are still wet. Held at the khal's level too. */
  uTideHigh: { value: 0 },
  /**
   * Which water stands where, over the map (world/water.ts levelTexture): r inland water's level, g the sea's
   * cells, b inland water's; and where the map lies (`uLevelMap`: its west and north edges, 1 / its extent).
   */
  tLevel: { value: null as Texture | null },
  uLevelMap: { value: new Vector4() },
  /**
   * How far each place lies from the land the village keeps to (world/corridor.ts: the boat's way and the bil),
   * and where that map lies (`uCorridorMap`: its west and north edges, 1 / its extent): the haze thickens past it.
   */
  tCorridor: { value: null as Texture | null },
  uCorridorMap: { value: new Vector4() },
  /**
   * The plane the mirror pass reflects about (m): the level of the water nearest the eye, the sea's or a
   * pond's, the bil's or the khal's (world/water.ts mirrorLevelAt); water at other levels shows the sky.
   */
  uMirrorLevel: { value: 0 },
  /** The khal's current against its mean (world/khal.ts KHAL_CURRENT): the season's runoff (main.ts). */
  uFlowScale: { value: 1 },
  /**
   * The season's rise of the waters above their mean level (m, env/season.ts `water`): the river, the khals and
   * the bil rise and fall by all of it, the ponds by `POND_RISE` (geography.ts waterLevelAt, GLSL waterLevels).
   */
  uWaterRise: { value: 0 },
  /** The season on the land: x leafiness, y dryness, z share of trees in flower, w kash in plume. */
  uSeasonA: { value: new Vector4(0.95, 0.1, 0, 1) },
  /** x lilies in flower, y water standing in the paddy plots, z wet soil, w salt pans at work. */
  uSeasonB: { value: new Vector4(0.9, 0.45, 0.55, 0.2) },
  /** Shares of paddy plots: x seedlings, y green, z golden, w mustard in flower (the rest stubble). */
  uCrops: { value: new Vector4(0.1, 0.85, 0, 0) },
  /** How wet everything is from rain (0..1), and how hard it is raining now. */
  uWet: { value: 0 },
  uRain: { value: 0 },
  /** 0..1: how far the sky has closed over with rain cloud (no sun glitter, soft light). */
  uOvercast: { value: 0 },
  /** How much cloud lies on the hills (0..1): winter's mornings and evenings most, some in the rains (main.ts). */
  uHillCloud: { value: 0 },
  /** A lightning strike's light (world/lightning.ts): xyz the way to where it lights the cloud from within, w how bright now. */
  uLightning: { value: new Vector4(0, 1, 0, 0) },
};

/** Drawn by the main camera only: never seen in the mirror pass. */
export const LAYER_WATER = 1;
export const LAYER_NO_REFLECT = 2;
