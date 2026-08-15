import * as THREE from 'three';

/**
 * The last thing that happens to the picture: saturation and contrast, over the
 * whole frame, photograph included.
 *
 * Everything else in this app is careful to touch only what it owns. The post
 * chain runs before the water so it cannot soften the illustration; the water
 * works strictly inside its key; the gold adds and never mixes. That
 * discipline is what keeps the street identical to the photograph — and it is
 * also why nothing in the app could answer "the whole thing is a bit flat",
 * because no pass was allowed to look at the whole thing.
 *
 * This one is. It is a grade, in the sense a colourist means: applied last,
 * uniformly, to a finished frame, with two knobs and no cleverness.
 *
 * Two notes on why it is *here* rather than folded into an existing pass:
 *
 *  - effects/gradeShader.ts runs early, on the linear HDR buffer, before the
 *    tonemap. That is the right place to shape a render and the wrong place to
 *    do this: it cannot see the photograph at all, since the water and the
 *    street are composited several passes later.
 *  - It has to come after effects/goldenLight.ts. The gold is light being
 *    added to the scene, and light that arrives after the grade is light the
 *    grade never saw — the sparks would sit on top at their own contrast,
 *    which is exactly how a lens flare pasted onto a graded plate looks.
 *
 * Saturation is measured in Rec. 709 luma so that pushing it moves colour
 * without moving brightness — the naive version (scaling the distance from grey
 * by channel) also lifts everything saturated, which on this picture means the
 * blue water rises against the grey road and the two stop belonging to the same
 * photograph.
 *
 * Identity at 1.0 / 1.0, and the pass disables itself there.
 */
export const FinalGradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 1 = as rendered. */
    uSaturation: { value: 1 },
    /** Contrast about mid grey, as a gamma-style pivot rather than a linear
     * gain: a gain clips both ends of a display-space frame, and this frame has
     * real information at both ends — the cloud's crown and the water under the
     * girl. */
    uContrast: { value: 1 },
    /** Where the contrast pivots. Mid grey in display space, which on this
     * picture sits between the wet road and the deep water. */
    uPivot: { value: 0.5 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uPivot;
    varying vec2 vUv;

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      // Contrast, about the pivot. Kept in display space because that is where
      // the eye's idea of "contrast" lives and where the picture is finished:
      // the same curve applied in linear light would crush the shadow end of
      // the water while barely touching the cloud.
      c = clamp((c - uPivot) * uContrast + uPivot, 0.0, 1.0);

      // Saturation about luma, so hue and brightness stay put.
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = clamp(mix(vec3(luma), c, uSaturation), 0.0, 1.0);

      gl_FragColor = vec4(c, 1.0);
    }
  `,
};
