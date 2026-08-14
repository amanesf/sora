import * as THREE from 'three';

/**
 * Fixed "window frame" camera: never pans/orbits/zooms, matching the composition
 * this sky is built for (a background layer behind a separately-authored bench+girl
 * foreground, per plan.md §1). Only the sun's elevation animates.
 *
 * HORIZON_SCREEN_FRACTION (0=top, 1=bottom) is chosen at 0.72 — inside the lower-third
 * band plan.md §1 calls for, and close to the horizon position measured in the
 * reference image (distant hills sit at ≈0.72–0.75 of frame height in
 * 1786418841252.png). CAMERA_PITCH_DEG is *derived* from that target via exact
 * pinhole-camera projection (see solveHorizonPitchDeg), not chosen by eye: for a
 * zero-roll camera the elevation-0 plane (the horizon) projects to a screen row at
 * frac = 0.5 + 0.5·tan(pitch)/tan(fovV/2), independent of horizontal position, so
 * inverting that equation gives the exact pitch for any target row.
 */
export const CAMERA_VERTICAL_FOV_DEG = 50;
const HORIZON_SCREEN_FRACTION = 0.72;

function solveHorizonPitchDeg(horizonFraction: number, verticalFovDeg: number): number {
  const halfFovRad = THREE.MathUtils.degToRad(verticalFovDeg / 2);
  const targetTanPitch = (horizonFraction - 0.5) * 2 * Math.tan(halfFovRad);
  return THREE.MathUtils.radToDeg(Math.atan(targetTanPitch));
}

export const CAMERA_PITCH_DEG = solveHorizonPitchDeg(HORIZON_SCREEN_FRACTION, CAMERA_VERTICAL_FOV_DEG);

/**
 * Re-aim the camera so the horizon lands at `fraction` of the frame height.
 *
 * The same solve as above, applied after construction. A second illustration
 * (scene/scenes.ts) paints its horizon in a different place, and the rendered
 * sky has to agree with the painting it is seen through — a camera left at
 * scene 1's pitch puts its horizon 128px above scene 2's painted sea, which
 * shows as a band of below-horizon sky standing above the water.
 *
 * Only the pitch moves. The field of view is untouched, so the clouds keep the
 * angular size every constant in this project was fitted to.
 */
export function setCameraHorizon(camera: THREE.PerspectiveCamera, fraction: number): void {
  camera.rotation.x = THREE.MathUtils.degToRad(
    solveHorizonPitchDeg(fraction, CAMERA_VERTICAL_FOV_DEG),
  );
  camera.updateMatrixWorld(true);
}

/** Eye-level height in kilometers (the sky/cloud shader's world unit — see skyClouds.ts). */
export const CAMERA_ALTITUDE_KM = 0.0017;

export function createCamera(aspect: number): THREE.PerspectiveCamera {
  // Far plane 400km, not 50. The distant cloud tiers that give the lower sky
  // its depth sit 50-95km out, and at 50 they were simply clipped away — the
  // far bank rendered as nothing at all. Depth precision is not a concern
  // here: nothing in this scene relies on fine depth sorting (the clouds are
  // instanced meshes at wildly different distances and the sky is a
  // fullscreen pass), so the near plane can stay tight without banding.
  const camera = new THREE.PerspectiveCamera(CAMERA_VERTICAL_FOV_DEG, aspect, 0.01, 400);
  camera.position.set(0, 0, 0);
  camera.rotation.order = 'YXZ';
  camera.rotation.x = THREE.MathUtils.degToRad(CAMERA_PITCH_DEG);
  camera.rotation.y = 0;
  camera.updateMatrixWorld(true);
  return camera;
}
