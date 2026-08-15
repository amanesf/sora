import * as THREE from 'three';

/**
 * The app is the reference illustration with its sky punched out
 * (`scripts/plate.js`), so everything is anchored to that image's frame: 1408x768,
 * the camera solved in `core/camera.ts`, and the plate's pixels. The window the
 * app renders into is the `.stage` band of the page, and the target device is
 * now a Pixel 10 Pro held *upright*: the picture is a landscape band across the
 * upper part of a portrait page, sized in CSS to the reference's own 1.792 aspect
 * (bled 10% off the left edge and 5% off the right), so on the phone this
 * function is asked for the whole frame and crops nothing. The crop rules below
 * are what keeps every other shape honest — a desktop window, or a screen short
 * enough that `--stage-max-height` clamps the band, hands the stage a wider
 * aspect, and that has to cost frame rather than stretch it.
 *
 * (Previously the canvas was the whole window on a phone held sideways, a
 * 998x448 viewport whose 2.23 aspect always cropped.)
 *
 * So the plate is never stretched. A sub-rectangle of the 1376x768 frame is
 * chosen to match the viewport's aspect, and *both* the 3D camera (via
 * setViewOffset, which renders exactly a sub-rect of a larger frame) and the
 * plate quad (via UVs) are given that same rectangle. Stretching either one
 * independently would slide the painted window frames off the rendered sky.
 */
export const FRAME_WIDTH = 1376;
export const FRAME_HEIGHT = 768;
const FRAME_ASPECT = FRAME_WIDTH / FRAME_HEIGHT;

/** Where the vertical crop is taken from. The hero cumulonimbus crown sits at
 * y≈77 in the reference and the room's floor fills the bottom, so a wider-than-
 * frame stage gives up floor before it gives up sky: 30% of the lost height
 * off the top, 70% off the bottom. On the portrait phone nothing is lost (the
 * stage is cut to 1.833 exactly); this governs the clamped and desktop cases. */
const TOP_CROP_SHARE = 0.3;

export interface FrameRect {
  /** Sub-rect of the 1376x768 frame that is visible, in frame pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export function visibleRect(viewportAspect: number): FrameRect {
  if (viewportAspect >= FRAME_ASPECT) {
    // Viewport is wider than the plate: full width, crop height.
    const height = FRAME_WIDTH / viewportAspect;
    return { x: 0, y: (FRAME_HEIGHT - height) * TOP_CROP_SHARE, width: FRAME_WIDTH, height };
  }
  // Taller than the plate (desktop windows, portrait): full height, crop width,
  // centred — the composition is horizontally symmetric about nothing in
  // particular, but the girl is left of centre and the tower right of it, so
  // centring loses the least of either.
  const width = FRAME_HEIGHT * viewportAspect;
  return { x: (FRAME_WIDTH - width) / 2, y: 0, width, height: FRAME_HEIGHT };
}

/** Point the camera at the same sub-rect. setViewOffset keeps the full-frame
 * projection and renders a window into it, which is exactly what is needed: the
 * field of view per pixel stays as camera.ts solved it, so cropping never
 * changes the scale of the clouds relative to the plate. */
export function applyToCamera(camera: THREE.PerspectiveCamera, rect: FrameRect): void {
  camera.aspect = rect.width / rect.height;
  camera.setViewOffset(FRAME_WIDTH, FRAME_HEIGHT, rect.x, rect.y, rect.width, rect.height);
  camera.updateProjectionMatrix();
}

/** The same rect as UVs into the plate texture (origin bottom-left). */
export function toUvRect(rect: FrameRect): THREE.Vector4 {
  return new THREE.Vector4(
    rect.x / FRAME_WIDTH,
    1 - (rect.y + rect.height) / FRAME_HEIGHT,
    rect.width / FRAME_WIDTH,
    rect.height / FRAME_HEIGHT,
  );
}

/**
 * The sub-rect of the frame the *water* images, and what the camera should
 * render instead of the whole view.
 *
 * The water reads a band of the render and magnifies it (scene/puddle.ts's
 * WATER_SKY_V0/V1). Until this existed, that band was a *crop of a finished
 * frame*: the sky was drawn across the whole buffer, the water sampled 44% of
 * its height and 48% of its width, and blew that up 2.07x. Two things followed,
 * and both of them were costing the picture more than any constant in it.
 *
 * **Resolution.** The sky the viewer actually looks at was being drawn at
 * 663x338 and stretched over 1376x701. Three quarters of the buffer's pixels
 * were spent on sky the water never shows.
 *
 * **Scale.** Every constant in core/postFx.ts — the bloom radius, the Kuwahara
 * kernel, the macro-contrast scale — is expressed in buffer pixels and was
 * fitted to be seen 1:1. Magnifying the buffer 2.07x afterwards means all of
 * them are seen at twice the size they were fitted at. That is precisely why
 * the reflected cloud reads as a soft blob: its painterly filtering is running
 * at double scale, and its veiling glare is twice as wide as the value that was
 * measured against the reference.
 *
 * Rendering the band directly fixes both at once and costs nothing — it is the
 * same buffer, the same geometry, a tighter frustum. The filters land at their
 * fitted size again, and the water samples something like 1:1.
 *
 * The band's aspect is the *water's* aspect by construction, which is the same
 * isotropy condition effects/puddleShader.ts's uSkyUScale used to enforce by
 * narrowing the horizontal read: a reflection is a projection of a flat patch
 * of sky, and a projection does not magnify one axis more than the other.
 */
export function waterBandRect(
  rect: FrameRect,
  /** Screen v of the water's vanishing line, within `rect`. */
  horizonV: number,
  /** The band of the old full-frame render the water read, as v. */
  skyV0: number,
  skyV1: number,
): FrameRect {
  const span = Math.max(skyV1 - skyV0, 1e-3);
  const height = span * rect.height;
  // Width from the water's own aspect: the water covers the full width of the
  // frame and `horizonV` of its height, so this is what keeps the magnification
  // equal on both axes.
  const width = rect.width * span / Math.max(horizonV, 1e-3);
  return {
    x: rect.x + (rect.width - width) / 2,
    // v runs up, rows run down: the top of the band is the *higher* v.
    y: rect.y + (1 - skyV1) * rect.height,
    width,
    height,
  };
}
