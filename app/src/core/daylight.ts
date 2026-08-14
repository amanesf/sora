import * as THREE from 'three';
import { SUN_AZIMUTH_DEG } from './solarPosition';

/**
 * The time of day, as everything the rest of the scene needs to know about it:
 * where the sun is, and what colour its light and the sky's light have become.
 *
 * The sky itself does not need the colours — scene/sky.ts integrates real
 * atmospheric scattering, so pointing its sun at the horizon turns it orange on
 * its own. What does need them is everything that is *not* solved from physics:
 * the cloud ramp (measured off a midday reference image, cloudRamp.ts) and the
 * painted illustration (a midday painting). Both are fixed midday artefacts, so
 * a sunset has to be applied to them as an illuminant.
 *
 * Everything here is identity at noon by construction — `CLOCK_START_HOUR`
 * returns exactly white tints and the fitted 55° sun. That is not a convenience:
 * it is what keeps every measured statistic in this project valid, since the
 * measure loop captures at noon.
 */

/** The slider's ends: midday to just after the sun has gone. */
export const CLOCK_START_HOUR = 12;
export const CLOCK_END_HOUR = 19;

/**
 * Solar elevation against the clock.
 *
 * Not a straight line. The sun loses altitude slowly through the afternoon and
 * then falls off a cliff in the last hour, and a linear ramp gets that visibly
 * wrong — it would put the sky into sunset colours by mid-afternoon. The
 * keyframes are shaped so the interesting hour is the last one, which is also
 * where the slider should feel like it is doing the most.
 *
 * 12:00 is pinned at 55°, the elevation the reference image's key light was
 * measured at (core/solarPosition.ts). It must stay there.
 */
const CLOCK_KEYFRAMES: { hour: number; elevationDeg: number }[] = [
  { hour: 12, elevationDeg: 55 },
  { hour: 15, elevationDeg: 42 },
  { hour: 17, elevationDeg: 25 },
  { hour: 18, elevationDeg: 12 },
  { hour: 18.75, elevationDeg: 1 },
  { hour: 19, elevationDeg: -2.5 },
];

export function sunElevationAtHour(hour: number): number {
  const h = THREE.MathUtils.clamp(hour, CLOCK_START_HOUR, CLOCK_END_HOUR);
  for (let i = 0; i < CLOCK_KEYFRAMES.length - 1; i++) {
    const a = CLOCK_KEYFRAMES[i];
    const b = CLOCK_KEYFRAMES[i + 1];
    if (h >= a.hour && h <= b.hour) {
      return THREE.MathUtils.lerp(
        a.elevationDeg,
        b.elevationDeg,
        THREE.MathUtils.smoothstep(h, a.hour, b.hour),
      );
    }
  }
  return CLOCK_KEYFRAMES[CLOCK_KEYFRAMES.length - 1].elevationDeg;
}

/**
 * Where the sun is in bearing, as the afternoon goes on.
 *
 * It used to be fixed at 55 degrees, and that one number was quietly costing
 * the entire sunset. The frame is 81 degrees wide, so only +-40.5 degrees off
 * the view axis is ever on screen: at 55 the sun is off the right edge at every
 * hour, sky.ts's sun disc has never once been visible, and everything a sunset
 * is actually made of — the disc, the glare around it, cloud edges lit from
 * behind — was structurally unavailable. What was left was colour, which is why
 * it came out as "the midday picture, tinted".
 *
 * So the bearing swings toward the window as the sun drops, reaching 22 degrees
 * by seven o'clock — inside the frame, low and to the right. It stays exactly at
 * 55 at noon, which is the reference image's own measured key light, so nothing
 * fitted moves.
 *
 * Physically a real sun's azimuth does swing through the afternoon; it just
 * swings the other way in this hemisphere. This is the one place in the file
 * where the composition wins over the almanac, and it wins because the whole
 * scene is a fixed shot out of one window: the sun has to come to the window,
 * because the window cannot turn to the sun.
 */
export function sunAzimuthAtHour(hour: number): number {
  const t = THREE.MathUtils.smoothstep(
    THREE.MathUtils.clamp(hour, CLOCK_START_HOUR, CLOCK_END_HOUR),
    14,
    CLOCK_END_HOUR,
  );
  return THREE.MathUtils.lerp(SUN_AZIMUTH_DEG, 22, t);
}

/** Unit vector toward the sun. */
export function sunDirectionAtElevation(elevationDeg: number, azimuthDeg = SUN_AZIMUTH_DEG): THREE.Vector3 {
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  const cosEl = Math.cos(elevation);
  return new THREE.Vector3(
    Math.sin(azimuth) * cosEl,
    Math.sin(elevation),
    -Math.cos(azimuth) * cosEl,
  ).normalize();
}

/*
 * The Rayleigh-extinction derivation that used to live here is gone.
 *
 * It computed the direct beam's colour from Kasten-Young air mass and the
 * standard zenith optical depths, which is correct physics and was still the
 * wrong tool: it describes the light arriving at a cloud, not the colour a
 * painted evening cloud is, and every attempt to use it needed a desaturation
 * factor tuned by eye on top — at which point the physics was decoration on a
 * guess. The dusk colours are measured off a reference now (see
 * daylightAtHour), which is what the rest of this project does.
 */

export interface Daylight {
  elevationDeg: number;
  sunDir: THREE.Vector3;
  /** Colour of the light falling on the *lit* side of a cloud. Luminance-
   * normalised and then scaled by how much light is left, so it carries hue and
   * brightness but not the ramp's own colour. */
  sunTint: THREE.Color;
  /** The same for the *shadow* side, which is lit by the sky dome rather than
   * the sun. Separating the two is what makes an evening cloud read as an
   * evening cloud instead of a cloud with an orange filter over it. */
  skyTint: THREE.Color;
  /** How far to move the clouds from their measured midday colours toward
   * those illuminants. 0 at noon. See cloudShader.ts for why this is a blend
   * toward a relit colour rather than a multiply. */
  blend: number;
  /** 0 in full day, 1 once the sun is on the horizon. The single "how late is
   * it" number the rest of the scene keys off. */
  dusk: number;
  /** Multiplier for the painted plate, which is a midday painting. */
  plateTint: THREE.Color;
}

const white = () => new THREE.Color(1, 1, 1);

const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);
const luminance = (c: THREE.Color) => c.r * LUMA.x + c.g * LUMA.y + c.b * LUMA.z;

/** Scale a colour so its luminance is exactly 1, leaving only its hue. How
 * bright the light is then becomes a separate, deliberate decision instead of
 * falling out of the extinction maths — the raw transmittance at the horizon is
 * near zero and would simply render everything black. */
function normaliseLuminance(c: THREE.Color): void {
  c.multiplyScalar(1 / Math.max(luminance(c), 1e-6));
}

export function daylightAtHour(hour: number): Daylight {
  const elevationDeg = sunElevationAtHour(hour);
  const sunDir = sunDirectionAtElevation(elevationDeg, sunAzimuthAtHour(hour));

  // The colours of dusk, measured rather than derived.
  //
  // They used to come out of Rayleigh extinction along the beam's air mass,
  // which is the right physics and the wrong answer: it describes the light
  // arriving at a cloud, not the colour a painted evening cloud actually is,
  // and the version tuned by eye on top of it came out a pale rose.
  //
  // These are sampled from the evening reference the user supplied
  // (Screenshot_20260813-045658.png) with scripts/duskref.js, which ranks its
  // cloud pixels by luminance the same way scene/cloudRamp.ts ranks the midday
  // reference's. Converted to linear HDR (scripts/hdr.js) and normalised to
  // luminance 1, so each carries hue alone and how bright it gets stays a
  // separate decision:
  //
  //   percentile   measured sRGB    R/B    linear chroma
  //    10%        117, 84,115      1.02    1.43, 0.83, 1.39   violet
  //    75%        254,133,112      2.27    3.40, 0.36, 0.30   orange
  //    98%        253,245,124      2.04    1.57, 0.93, 0.00   yellow-white
  //
  // The shadow end is taken straight from the 10%. The lit end is pulled back
  // from the raw 3.40, 0.36, 0.30 — that is what the inverse tonemap demands to
  // *land* on that orange, and used as an illuminant it drives the whole cloud
  // to a single near-monochrome red. The reference's cloud is not one colour:
  // it bows from violet through orange to yellow-white, and a bow is not
  // something two endpoints can interpolate. Reproducing it properly needs a
  // second measured ramp for the evening, the way cloudRamp.ts is one for
  // midday. **That is the next step here, and these two values are the
  // stand-in until it exists.**
  const DUSK_LIT = new THREE.Color(2.10, 0.72, 0.35);
  const DUSK_SHADOW = new THREE.Color(1.43, 0.83, 1.39);

  const dusk = 1 - THREE.MathUtils.smoothstep(elevationDeg, 2, 30);

  // How much light is left. Held flat through the afternoon and dropped over
  // the last few degrees, which is where the change actually happens.
  const sunUp = THREE.MathUtils.smoothstep(elevationDeg, -2.5, 9);
  const lit = THREE.MathUtils.lerp(0.24, 1, sunUp);

  const sunTint = white().lerp(DUSK_LIT, dusk);
  normaliseLuminance(sunTint);
  sunTint.multiplyScalar(lit);

  // The shading side is lit by the sky dome, not the sun, and it darkens
  // further than the lit side does — but it stays luminous. In the reference
  // those faces sit at luminance 93-129 against a lit 157-238, which is a
  // ratio, not a collapse.
  const skyTint = white().lerp(DUSK_SHADOW, dusk);
  normaliseLuminance(skyTint);
  skyTint.multiplyScalar(THREE.MathUtils.lerp(1, 0.5, dusk));

  // Nothing happens at all until the sun is low enough for it to. Above 30
  // degrees the measured midday ramp is simply correct.
  const blend = 0.94 * dusk;

  // The illustration is one painting made at midday, so it cannot relight
  // itself. Tinting it is the only way the room can belong to the same evening
  // as the sky behind it — without this, the window turns orange and the girl
  // stays lit for noon, which reads as a compositing error rather than a time
  // of day. Kept weaker than the cloud tint: an interior loses the sun earlier
  // and more evenly than a cloud top does, and pushing a painted midday scene
  // too far just looks like a colour cast.
  const plateTint = white()
    .lerp(new THREE.Color(1.0, 0.82, 0.72), dusk * 0.75)
    .multiplyScalar(THREE.MathUtils.lerp(1, 0.42, dusk));

  return { elevationDeg, sunDir, sunTint, skyTint, blend, dusk, plateTint };
}

/**
 * The cloud key light for an hour.
 *
 * Two things happen to it, in this order.
 *
 * First the elevation is driven down in proportion to the sun's, keeping the
 * fitted bearing: that alone turns overhead light into raking light across the
 * cloud tops, and it is exactly the art-directed vector at noon.
 *
 * Then, as dusk comes on, it is swung toward the sun itself. This was
 * deliberately *not* done while the sun was off-frame — a key light that
 * disagrees with an invisible sun costs nothing, and the fitted bearing was
 * worth more. Now that the sun comes into frame in the evening
 * (sunAzimuthAtHour), a cloud lit from the left with the sun visible on the
 * right is simply wrong, and the disagreement is the first thing the eye finds.
 *
 * The interpolation is safe here even though main.ts documents a flat-light
 * disaster from pointing the key light down the camera axis: both vectors point
 * *away* from the camera (the fitted one has z = -0.44, the evening sun about
 * -0.93), so the path between them stays beyond the cloud. It passes through
 * "directly behind", which is backlight — the thing an evening sky is for.
 */
export function cloudLightForDay(base: THREE.Vector3, day: Daylight): THREE.Vector3 {
  const horizontal = Math.hypot(base.x, base.z);
  if (horizontal < 1e-6) return base.clone();
  const baseElevation = Math.atan2(base.y, horizontal);
  const noonElevation = THREE.MathUtils.degToRad(sunElevationAtHour(CLOCK_START_HOUR));
  const sunElevation = THREE.MathUtils.degToRad(day.elevationDeg);
  const elevation = baseElevation * (sunElevation / noonElevation);
  const cos = Math.cos(elevation);
  const flattened = new THREE.Vector3(
    (base.x / horizontal) * cos,
    Math.sin(elevation),
    (base.z / horizontal) * cos,
  ).normalize();
  return flattened.lerp(day.sunDir, day.dusk).normalize();
}

/**
 * Relight a colour that was chosen for midday.
 *
 * The same operation the cloud shader performs per fragment — keep how bright
 * the thing is, take the hour's colour — but on the CPU, for the handful of
 * fixed constants that live outside the cloud material. `lit` picks where
 * between the shadow and the lit illuminant the surface sits.
 *
 * At noon `blend` is 0 and this returns the colour unchanged.
 */
export function relightForDay(base: THREE.Color, day: Daylight, lit: number): THREE.Color {
  const illum = day.skyTint.clone().lerp(day.sunTint, lit);
  const lum = luminance(base);
  return base.clone().lerp(new THREE.Color(lum * illum.r, lum * illum.g, lum * illum.b), day.blend);
}

export function formatClock(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
