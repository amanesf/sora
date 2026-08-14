import * as THREE from 'three';

/**
 * The clouds on their own: shaded exactly as they are in the picture, with no
 * sky behind them and no illustration in front, kept on the GPU as a texture
 * with coverage in its alpha.
 *
 * core/compose.ts lays this faintly across the lower half of the page. It went
 * through two earlier forms, and the difference between them is the whole
 * lesson:
 *
 *  - First it was traced to contour lines on the CPU. readRenderTargetPixels
 *    asks the GPU to finish everything it has queued, which stalls the
 *    pipeline, so it could only be afforded a few times a second — and a
 *    drawing updating at 3Hz under a picture running at 60 does not look like a
 *    slow drawing, it looks like a broken one.
 *  - Then it was a flat white mask, filled as a soft shape. Perfectly smooth,
 *    but a silhouette is a different object from a cloud: it says where, not
 *    what.
 *
 * Now the same materials draw the same clouds, so the thing lying under the
 * picture *is* the sky above it, just quieter. It costs one extra pass at a
 * quarter resolution and nothing at all on the CPU.
 *
 * Rendered with the *view* camera, so it frames the sky the way the picture
 * does. It does not know about the plate: the painted window frames hide parts
 * of the sky in the picture and hide nothing here. That is deliberate — this is
 * the sky itself, not a tracing of the photograph, and cutting it at the
 * mullions would look broken rather than intentional.
 */
export interface CloudLayer {
  /** RGB is linear HDR (the cloud material is pre-tonemap — see cloudRamp.ts),
   * alpha is coverage. core/compose.ts tonemaps it. */
  texture: THREE.Texture;
  update: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    hidden: THREE.Object3D[],
  ) => void;
  dispose: () => void;
}

export function createCloudLayer(width: number, height: number): CloudLayer {
  // Half float, because the cloud material writes inverse-tonemapped linear HDR
  // and its white crown sits above 8. In an 8-bit target everything bright
  // clamps to the same white and the shading — the entire reason for drawing
  // the real clouds rather than a mask — is thrown away before it arrives.
  //
  // Small and linearly filtered on purpose: this is drawn many times its own
  // size, so the hardware's upscale is what softens it. There is no blur pass
  // anywhere; the filtering is the blur.
  const target = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: true,
  });
  target.texture.generateMipmaps = false;

  const update = (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    hidden: THREE.Object3D[],
  ) => {
    const restore = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;

    const prevTarget = renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();

    // No overrideMaterial: the clouds draw with their own shader, which is the
    // point. Cleared transparent, so alpha comes out as coverage for free —
    // the cloud material writes alpha 1 and nothing else writes at all.
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    hidden.forEach((o, i) => { o.visible = restore[i]; });
  };

  return {
    texture: target.texture,
    update,
    dispose: () => target.dispose(),
  };
}
