import * as THREE from 'three';

/**
 * Sun elevation as a function of a single time parameter t∈[0,1] spanning the
 * requested arc: 日中(day) → 夕焼け(sunset) → 日没後の薄暮(dusk). Three keyframes,
 * smoothly interpolated (smoothstep-weighted piecewise), so the whole curve is a
 * pure function of t — no per-frame hand-tuning. Azimuth is held fixed: the camera
 * composition never yaws, only the sun's elevation changes, matching a single fixed
 * shot watching one afternoon pass.
 *
 * t=0 elevation (55°) is chosen to match the key-light angle measured in the
 * reference image (1786418841252.png): the cumulonimbus is lit from upper-right
 * with a hard, high-sun shadow terminator on its lower-left flank, consistent with
 * a sun well above 45° elevation rather than near-horizon lighting.
 */
interface SolarKeyframe {
  t: number;
  elevationDeg: number;
}

const KEYFRAMES: SolarKeyframe[] = [
  { t: 0.0, elevationDeg: 55 },
  { t: 0.6, elevationDeg: 4 },
  { t: 1.0, elevationDeg: -8 },
];

export const SUN_AZIMUTH_DEG = 55;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function sunElevationDeg(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    const a = KEYFRAMES[i];
    const b = KEYFRAMES[i + 1];
    if (clamped >= a.t && clamped <= b.t) {
      const local = smoothstep(a.t, b.t, clamped);
      return a.elevationDeg + (b.elevationDeg - a.elevationDeg) * local;
    }
  }
  return KEYFRAMES[KEYFRAMES.length - 1].elevationDeg;
}

/** Unit direction vector pointing *toward* the sun, world space (Y up). */
export function sunDirection(t: number): THREE.Vector3 {
  const elevation = THREE.MathUtils.degToRad(sunElevationDeg(t));
  const azimuth = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
  const cosEl = Math.cos(elevation);
  return new THREE.Vector3(
    Math.sin(azimuth) * cosEl,
    Math.sin(elevation),
    -Math.cos(azimuth) * cosEl,
  ).normalize();
}
