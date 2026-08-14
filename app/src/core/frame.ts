import * as THREE from 'three';

/**
 * The app is the reference illustration with its sky punched out
 * (`scripts/plate.js`), so everything is anchored to that image's frame: 1408x768,
 * the camera solved in `core/camera.ts`, and the plate's pixels. The window the
 * app renders into is the `.stage` band of the page, and the target device is
 * now a Pixel 10 Pro held *upright*: the picture is a landscape band across the
 * upper part of a portrait page, sized in CSS to the plate's own 1.833 aspect
 * (bled 10% off the left edge and 5% off the right), so on the phone this
 * function is asked for the whole frame and crops nothing. The crop rules below
 * are what keeps every other shape honest — a desktop window, or a screen short
 * enough that `--stage-max-height` clamps the band, hands the stage a wider
 * aspect, and that has to cost frame rather than stretch it.
 *
 * (Previously the canvas was the whole window on a phone held sideways, a
 * 998x448 viewport whose 2.23 aspect always cropped.)
 *
 * So the plate is never stretched. A sub-rectangle of the 1408x768 frame is
 * chosen to match the viewport's aspect, and *both* the 3D camera (via
 * setViewOffset, which renders exactly a sub-rect of a larger frame) and the
 * plate quad (via UVs) are given that same rectangle. Stretching either one
 * independently would slide the painted window frames off the rendered sky.
 */
export const FRAME_WIDTH = 1408;
export const FRAME_HEIGHT = 768;
const FRAME_ASPECT = FRAME_WIDTH / FRAME_HEIGHT;

/** Where the vertical crop is taken from. The hero cumulonimbus crown sits at
 * y≈77 in the reference and the room's floor fills the bottom, so a wider-than-
 * frame stage gives up floor before it gives up sky: 30% of the lost height
 * off the top, 70% off the bottom. On the portrait phone nothing is lost (the
 * stage is cut to 1.833 exactly); this governs the clamped and desktop cases. */
const TOP_CROP_SHARE = 0.3;

export interface FrameRect {
  /** Sub-rect of the 1408x768 frame that is visible, in frame pixels. */
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
