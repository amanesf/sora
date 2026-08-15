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
    /**
     * Exposure, in stops-worth of linear gain, applied before everything else
     * in this pass.
     *
     * The picture is a late-afternoon street and it was reading dark — not dark
     * in the way a low sun is dark, which is a warm light raking across a
     * mostly shadowed frame, but dark in the way an under-exposed photograph
     * is: the whole range sitting low with nothing near the top of it.
     *
     * A gain in *linear* light rather than a lift in display space, and the
     * difference is the whole reason it is a separate uniform instead of a
     * nudge to the contrast pivot. A display-space lift is an addition: it
     * moves black off black and washes the picture out, which on a frame whose
     * subject is deep navy water is the one thing that cannot happen. A linear
     * gain is what opening the aperture does — it scales every ratio in the
     * frame, so the water stays as much darker than the cloud as it was and
     * simply arrives with more light in it.
     *
     * It runs first, so the contrast below pivots on the brightened mid rather
     * than dragging the picture back down about the old one.
     */
    uExposure: { value: 1 },
    /**
     * The white point of the shoulder above, in linear light: the value that
     * maps exactly to 1.0, and therefore the brightest thing the frame is
     * allowed to still distinguish.
     *
     * Set from what the exposure does to the top of the range. The picture
     * arrives display-referred with its cloud crown near 1.0 linear, so a gain
     * of E puts the top near E — a white point a little above that leaves the
     * whole picture inside the shoulder's invertible range, with the very
     * brightest specular allowed to reach white and nothing else forced there.
     */
    uWhite: { value: 1.9 },
    /**
     * The split: what colour the highlights lean, and what colour the shadows
     * lean, in that order.
     *
     * This picture has exactly one light in it and it is warm, and one large
     * dark and it is water. Photographically that is the split-tone case: the
     * lit half of the frame belongs to the sun and the unlit half belongs to
     * the sky, and letting the two ends of the tonal range carry different
     * colour is what separates them without touching their brightness.
     *
     * It is also the difference between "saturated" and "coloured". The
     * saturation knob above scales everything away from grey, so it makes the
     * gold more gold *and* the navy more navy along whatever hue each already
     * has; this decides what those hues are. Small values — a couple of percent
     * — because the two halves are already the right colours and this is a lean,
     * not a tint.
     */
    uSplitWarm: { value: new THREE.Vector3(1.035, 1.005, 0.968) },
    uSplitCool: { value: new THREE.Vector3(0.972, 0.994, 1.042) },
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
    uniform float uExposure;
    uniform float uWhite;
    uniform vec3 uSplitWarm;
    uniform vec3 uSplitCool;
    varying vec2 vUv;

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      // Exposure, in linear light — see uExposure. A round trip through gamma
      // for two pow()s, which is what makes this an exposure rather than a
      // brightness slider: the picture gets more light in it instead of being
      // shifted up the range.
      if (uExposure != 1.0) {
        vec3 lin = pow(max(c, 0.0), vec3(2.2)) * uExposure;
        // A shoulder, not a clamp.
        //
        // The frame arriving here is already display-referred and tone-mapped:
        // its brightest cloud sits near 1.0 because that is where a tonemap put
        // it. Multiplying by 1.55 takes everything above about 0.85 past the
        // ceiling, and a ceiling does not compress, it *deletes* — the cloud's
        // crown, its lit shoulder and the sky behind it all become the same
        // white, and the modelling that the shadow pass, the ramp and the
        // macro-contrast spent the whole chain building is gone in one multiply.
        // Measured at 1.55 with a hard clamp, 23% of the frame had a channel at
        // or above 252.
        //
        // Reinhard with a white point: identity in the shadows and the mid to
        // within a percent or so, bending over only where the clamp used to be,
        // and everything below the white point still reaches a distinct value.
        // The cloud gets brighter *and* keeps its shape, which is the thing the
        // exposure was raised for in the first place.
        // On luminance, with all three channels scaled by the one factor —
        // not per channel, which is what made the bright cloud go muddy.
        //
        // Run channel by channel, a shoulder compresses each one by a different
        // amount, and how different depends on how far apart they are. In the
        // deep shadows nothing happens. In a *bright warm* pixel — a sunlit
        // cloud face, red high and blue lower — red sits further into the bend
        // than blue does, so red is pulled down harder and the colour walks
        // toward neutral as it brightens. That is a desaturation that gets
        // stronger the brighter the subject, applied to a frame whose brightest
        // subject is the thing everyone is looking at, and it is why only some
        // of the cloud looked dirty: only the parts far enough into the
        // shoulder for the channels to separate.
        //
        // A tone curve is supposed to answer "how much light is here", which is
        // one question with one answer. So it runs on luminance and returns a
        // single factor that all three channels are scaled by — and scaling a
        // colour leaves its ratios, and therefore its hue and its saturation,
        // exactly where they were. Same argument as CHARACTER_CONTRAST in
        // scripts/puddle.js, which had to learn it too.
        float w = uWhite;
        float lum = max(dot(lin, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
        float toned = lum * (1.0 + lum / (w * w)) / (1.0 + lum);
        c = pow(max(lin * (toned / lum), 0.0), vec3(1.0 / 2.2));
      }

      // Contrast, about the pivot. Kept in display space because that is where
      // the eye's idea of "contrast" lives and where the picture is finished:
      // the same curve applied in linear light would crush the shadow end of
      // the water while barely touching the cloud.
      c = clamp((c - uPivot) * uContrast + uPivot, 0.0, 1.0);

      // Saturation about luma, so hue and brightness stay put.
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = clamp(mix(vec3(luma), c, uSaturation), 0.0, 1.0);

      // The split, weighted by where each pixel sits in the range. Smoothstep
      // rather than luma itself, so the middle of the picture — the mid-tone
      // water, which is most of it — is left almost alone and only the two ends
      // lean.
      float lit = smoothstep(0.42, 0.92, luma);
      float dark = 1.0 - smoothstep(0.06, 0.46, luma);
      c = clamp(c * mix(vec3(1.0), uSplitWarm, lit) * mix(vec3(1.0), uSplitCool, dark), 0.0, 1.0);

      gl_FragColor = vec4(c, 1.0);
    }
  `,
};
