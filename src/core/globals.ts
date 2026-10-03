import { Color, Vector3, Vector4 } from 'three';

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
  /** xy: wind direction, z: strength. */
  uWind: { value: new Vector4(0.55, -0.83, 1, 0) },
};

/** Drawn by the main camera only: never seen in the mirror pass. */
export const LAYER_WATER = 1;
export const LAYER_NO_REFLECT = 2;
