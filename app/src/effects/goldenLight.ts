import * as THREE from 'three';

/**
 * The gold: the low sun's shafts across the frame, and the rain it is lighting.
 *
 * The reference is a sunshower — it is still raining, and the sun is under the
 * cloud rather than behind it — and that one fact is responsible for most of
 * what the picture looks like. Light comes in almost flat from the upper left,
 * rakes across the wet road as broad soft shafts, and lights the falling drops
 * *from the side*, which is what turns them from grey scratches into hundreds
 * of small warm sparks hanging in the air. None of that is available from the
 * passes this app inherited: effects/rainShader.ts and effects/nearRain.ts both
 * draw rain as a cool sky-coloured streak, because they were written for rain
 * under an overcast, where there is no beam to catch.
 *
 * This pass is fitted rather than invented, and it could be, because the
 * reference exists in two versions — one with the gold painted on and one
 * without. Subtracting them isolates exactly the layer to be reproduced, and
 * `sparks` below quotes what that measures.
 *
 * Runs dead last, after the water and after the near rain, and adds rather than
 * mixes. Identity at uAmount = 0.
 */
export const GoldenLightShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** Real seconds — the drops' clock, shared with the rain passes. */
    uTime: { value: 0 },
    /** Master, 0-1. Scales the whole pass, so the beam can be taken out of the
     * picture in one place. */
    uAmount: { value: 1 },
    /** How much rain there is to light (scene/settings.ts's DRIZZLE). The
     * sparks are drops; the shafts stay whatever the weather, because a beam
     * through clear air is still a beam. */
    uRain: { value: 0 },
    /** The sun's colour at this hour, luminance-normalised (core/daylight.ts). */
    uSunTint: { value: new THREE.Vector3(1, 1, 1) },
    /**
     * 0 in full day, 1 with the sun on the horizon.
     *
     * Drives how much of this there is at all, not what colour it is. A beam
     * only rakes when the sun is low: at noon it comes down the vertical and
     * there is no long slanted throw across the ground to see, so the whole
     * pass fades out toward midday rather than pasting an evening over it.
     */
    uDusk: { value: 0 },
    uAspect: { value: 1376 / 768 },
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
    uniform float uTime;
    uniform float uAmount;
    uniform float uRain;
    uniform vec3 uSunTint;
    uniform float uDusk;
    uniform float uAspect;
    varying vec2 vUv;

    /**
     * Where the light comes from, in screen terms: off the top-left corner, and
     * the bearing everything parallel travels along.
     *
     * Fixed rather than derived from the true sun direction, deliberately. The
     * sun in this scene is a 3D vector aimed at a cloud field; the water is a
     * photograph of a street whose own light is already painted into it, rays
     * and all. Projecting the first onto the second would put these shafts at
     * an angle the painting contradicts. The picture says where its light comes
     * from, and this agrees with the picture.
     */
    const vec2 SOURCE = vec2(-0.18, 1.22);
    const vec2 BEARING = vec2(0.52, -0.855);

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    /**
     * The shafts.
     *
     * Coordinates are rotated onto the beam: 'along' runs down the bearing,
     * 'across' perpendicular to it, and every term is a function of 'across'
     * alone, which is what makes the bands parallel and unfanned. Three
     * incommensurate sine trains rather than one, so the spacing never reads as
     * a pattern, and a slow drift so the light breathes the way light through a
     * moving cloud edge does.
     */
    float shafts(vec2 p) {
      vec2 d = p - SOURCE;
      float across = d.x * BEARING.y - d.y * BEARING.x;
      float along = dot(d, BEARING);

      float bands = 0.55 + 0.45 * sin(across * 15.0 + uTime * 0.05);
      bands *= 0.62 + 0.38 * sin(across * 37.0 - uTime * 0.08);
      bands *= 0.70 + 0.30 * sin(across * 6.3 + 1.7);
      // Squared: the gaps between shafts have to be nearly empty, or the whole
      // frame simply lifts and the effect is a fog rather than a beam.
      bands *= bands;

      // The throw. Bright where the light enters and gone well before the far
      // side, which is what keeps the composition's weight in the upper left
      // where the reference has it. The first value here reached the lower
      // right corner and put a warm wash over the part of the water the
      // reference keeps at its deepest navy.
      float throwFade = exp(-max(along, 0.0) * 2.05);
      throwFade *= smoothstep(0.0, 0.25, along);
      return bands * throwFade;
    }

    /**
     * The lit rain — measured, not invented.
     *
     * The reference exists in two versions, one with this layer painted on and
     * one without, so the layer can be subtracted out and counted. Keeping only
     * the pixels the gold version added *warmly*:
     *
     *   763 separate marks, 1.58% of the frame
     *   median mark 2x2 px, upper decile 6x5, with a tail out to larger flares
     *   peak colour sRGB(223, 209, 185) — warm off-white, not orange
     *   85% of them are not over the water; they are in the air over the road
     *   twice as many in the left half of the frame as in the right
     *
     * Every one of those is a constraint here. The marks are *small* — two
     * pixels, not the comfortable eight a procedural sparkle wants to be — and
     * there are many of them, and they are barely tinted: what makes them read
     * as gold is a warm off-white core against a blue-grey scene, not
     * saturation. The left-hand bias is not composition either, it is the beam:
     * a drop is visible only where the light is, so the same throw that shapes
     * the shafts decides where sparks exist at all.
     */
    float sparks(vec2 p, float scale, float speed, float size, float seed) {
      // Fall direction: mostly down, leaned along the beam.
      vec2 fall = normalize(vec2(0.16, -1.0));
      vec2 q = vec2(p.x * uAspect, p.y) * scale;
      // Shear the grid so the cells travel with the drops rather than the drops
      // crossing cell boundaries, which would make them blink at the seams.
      q -= fall * uTime * speed;
      vec2 cell = floor(q);
      vec2 f = fract(q);

      float sum = 0.0;
      // Three cells along the fall, so a spark is still drawn while it is
      // leaving its own cell.
      for (int j = -1; j <= 1; j++) {
        vec2 c = cell + vec2(0.0, float(j));
        vec2 r = vec2(hash21(c + seed), hash21(c + seed + 7.3));
        if (r.x > 0.16 + 0.62 * uRain) continue;
        vec2 centre = vec2(r.y, hash21(c + seed + 3.1)) * 0.8 + 0.1;
        vec2 d = (f - centre - vec2(0.0, float(j))) / size;
        // Stretched along the fall, but only gently: the measured marks are
        // very nearly round (median 2x2), because a drop that small at this
        // shutter is a dot with a hint of a tail, not a line.
        d.y *= 0.62;
        float r2 = dot(d, d);
        // A tight core inside a wide faint halo. The measurement says two
        // pixels across, so the halo is what gives a mark presence and the core
        // is what keeps it a point rather than a smudge.
        float core = exp(-r2 * 42.0);
        float halo = exp(-r2 * 4.5) * 0.22;
        // Twinkle: a falling drop turns, and its facet catches the sun for part
        // of the turn. Per-drop phase, so they do not pulse together.
        float turn = 0.35 + 0.65 * sin(uTime * 5.2 + r.y * 40.0);
        sum += (core + halo) * max(turn, 0.0);
      }
      return sum;
    }

    void main() {
      vec3 colour = texture2D(tDiffuse, vUv).rgb;
      // A low sun is the whole premise: at midday there is no rake and this
      // pass has nothing to say.
      float low = smoothstep(0.15, 0.75, uDusk);
      float amount = uAmount * low;
      if (amount < 0.004) {
        gl_FragColor = vec4(colour, 1.0);
        return;
      }

      // The colour of the light, measured off the painted layer's own peaks:
      // sRGB(223, 209, 185). Warm off-white, and deliberately not the saturated
      // orange "golden rain" sounds like — against this scene's blue-grey the
      // reference's marks read as gold at that saturation, and anything
      // stronger reads as sparks off a firework.
      //
      // Carried halfway toward the hour's own sun colour rather than fixed, so
      // the light in the air and the light on the cloud cannot disagree, while
      // the measured value still dominates.
      vec3 measured = vec3(0.875, 0.820, 0.725);
      vec3 gold = mix(measured, measured * uSunTint, 0.5) * 1.9;

      float beam = shafts(vUv);

      vec3 lit = colour;
      lit += gold * beam * 0.13 * amount;

      if (uRain > 0.004) {
        // Three layers, because 763 marks with a median of 2px and a tail out
        // to flares is not one population: near and large, mid, and a fine dust
        // that is most of the count and almost none of the light.
        float near = sparks(vUv, 9.0, 0.11, 0.26, 0.0);
        float mid = sparks(vUv, 26.0, 0.24, 0.15, 31.7);
        float dust = sparks(vUv, 48.0, 0.40, 0.10, 77.1);
        float drops = near * 0.13 + mid * 0.22 + dust * 0.15;

        // Where the beam is, mostly. Not exclusively: some light is scattered
        // everywhere and the floor keeps a scatter of sparks across the whole
        // frame, rather than a hard edge where the shafts stop.
        float inBeam = 0.28 + 1.5 * beam;
        lit += gold * drops * inBeam * amount * (0.35 + 0.65 * uRain);
      }

      gl_FragColor = vec4(lit, 1.0);
    }
  `,
};
