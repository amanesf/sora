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
     * The sun's elevation in degrees (core/daylight.ts), and what decides how
     * much of this pass there is at all.
     *
     * It was core/daylight.ts's `dusk` — 0 in full day, 1 with the sun on the
     * horizon — and that quietly switched the whole pass off. `dusk` is
     * `1 − smoothstep(elevation, 2°, 30°)`, so it is a measure of *sunset*, and
     * at this app's 16:48 the sun stands at about 28°: dusk 0.015. The shafts
     * were being drawn at a fiftieth of their strength and not one spark was
     * ever produced — every ray visible in the frame was painted into the
     * photograph.
     *
     * The physical claim was always about elevation and never about sunset: a
     * beam rakes when the sun is *low*, which starts happening long before it
     * sets. So the gate now reads the angle it was always about.
     */
    uElevationDeg: { value: 90 },
    uAspect: { value: 1376 / 768 },
    /**
     * What fraction of cells hold a drop at all, before the rain adds to it.
     *
     * The count kept being fixed by making each mark brighter, which is the
     * wrong knob twice over: it makes the field denser-looking as well as
     * louder, and it clips. This is the knob.
     *
     * It also has a floor that is not obvious. Cutting the count *and* the mark
     * size together at 0.055 took the rain back out of the picture entirely —
     * the two multiply, and a third as many marks at two thirds the size is a
     * ninth of the light. Density and size are one decision, not two.
     */
    uDensity: { value: 0.085 },
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
    uniform float uElevationDeg;
    uniform float uAspect;
    uniform float uDensity;
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
     * The count is the constraint that is easiest to lose, and it was lost
     * once: raising the brightness until the marks were unmistakable also
     * raised how many of them there were, and 1.58% of the frame at full
     * strength is not rain in sunlight, it is snow. Fewer and brighter is the
     * ratio the reference actually has — the marks are sparse and each one is
     * a highlight, so the fix for "I cannot see it" is the size of each mark,
     * never the number of them.
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
      vec2 base = vec2(p.x * uAspect, p.y) * scale;

      // Each column falls at its own rate.
      //
      // The grid was sheared by one global amount, so every drop in the frame
      // moved at exactly the same speed in exactly the same direction — which
      // is a *sheet*, not rain, and it is most of why the field read as regular
      // however much the positions inside each cell were jittered. Rain looks
      // random largely because it is at many distances at once, and drops at
      // different distances cross the frame at visibly different rates.
      //
      // Per column rather than per drop, because the shear has to be constant
      // along the fall or a drop would change speed as it crossed a cell
      // boundary. A column of sky at one distance is also the honest unit: it
      // is parallax, so neighbours down the same line share it.
      float column = floor(base.x);
      float pace = 0.55 + 1.15 * hash21(vec2(column, seed + 11.7));
      vec2 q = base - fall * uTime * speed * pace;
      vec2 cell = floor(q);
      vec2 f = fract(q);

      float sum = 0.0;
      // Three cells along the fall, so a spark is still drawn while it is
      // leaving its own cell.
      for (int j = -1; j <= 1; j++) {
        vec2 c = cell + vec2(0.0, float(j));
        vec2 r = vec2(hash21(c + seed), hash21(c + seed + 7.3));
        if (r.x > uDensity + 0.20 * uRain) continue;
        vec2 centre = vec2(r.y, hash21(c + seed + 3.1)) * 0.8 + 0.1;

        // Every drop a different size, and a wide range of them: a field of
        // marks that are all the same size is read as a pattern in about a
        // second, whatever their spacing. Squared, so most are small and a few
        // are much larger — which is what a depth distribution does to a field
        // of identical objects, and what the reference's own spread of mark
        // sizes looks like.
        float grade = hash21(c + seed + 23.9);
        float mySize = size * (0.45 + 1.30 * grade * grade);

        vec2 d = (f - centre - vec2(0.0, float(j))) / mySize;
        // Stretched along the fall. The measured marks are very nearly round
        // (median 2x2) and the first version took that literally, at which
        // point they read as dust hanging in the air rather than as rain: a
        // still frame cannot show that a dot is falling, and a short tail can.
        // Still far from a streak — this is a drop caught in a beam, not the
        // cool grey line effects/rainShader.ts draws.
        d.y *= 0.42;
        float r2 = dot(d, d);
        // A tight core inside a wide faint halo. The measurement says two
        // pixels across, so the halo is what gives a mark presence and the core
        // is what keeps it a point rather than a smudge.
        float core = exp(-r2 * 42.0);
        float halo = exp(-r2 * 4.5) * 0.22;
        // Twinkle: a falling drop turns, and its facet catches the sun for part
        // of the turn. Per-drop phase and per-drop rate, so they do not pulse
        // together and no two are alike for long.
        float turn = 0.30 + 0.70 * sin(uTime * (3.4 + 4.6 * r.y) + r.y * 40.0);
        // ...and a per-drop brightness on top, because a drop's facet either
        // points at the sun or does not, and most do not.
        float facet = 0.35 + 0.9 * grade;
        sum += (core + halo) * max(turn, 0.0) * facet;
      }
      return sum;
    }

    void main() {
      vec3 colour = texture2D(tDiffuse, vUv).rgb;
      // A low sun is the whole premise: at midday there is no rake and this
      // pass has nothing to say.
      // Full strength by 25° and gone by 55°: a late afternoon rakes, a midday
      // does not. See uElevationDeg for what this used to read, and why that
      // was a fiftieth of a pass.
      float low = 1.0 - smoothstep(25.0, 55.0, uElevationDeg);
      float amount = uAmount * low;
      if (amount < 0.004) {
        gl_FragColor = vec4(colour, 1.0);
        return;
      }

      // The colour of the light — and the first measurement of it was of the
      // wrong thing.
      //
      // Reading the painted marks' own peak colour gives sRGB(223, 209, 185),
      // normalised (1.00, 0.94, 0.83): nearly white. That is what a mark *ends
      // up* as, and this pass adds light rather than painting marks, so what it
      // needs is the light that was added — the difference between the two
      // versions of the reference, over the pixels the gold version brightened:
      //
      //   mean      (76, 63, 41)    normalised (1.00, 0.82, 0.54)
      //   strongest (252, 230, 146) normalised (1.00, 0.91, 0.58)
      //
      // Half as much blue as the finished mark has. The distinction is not
      // pedantic: an additive layer's colour is never the colour you measure in
      // the result, because the result is the layer *plus the scene under it*,
      // and adding a near-white at any strength that shows on a bright road
      // clips straight to white. Gold that cannot survive landing on something
      // bright is not gold.
      //
      // Carried halfway toward the hour's own sun colour rather than fixed, so
      // the light in the air and the light on the cloud cannot disagree, while
      // the measured value still dominates.
      vec3 measured = vec3(1.00, 0.82, 0.54);
      // 1.35, and the ceiling on it is clipping rather than taste: the light is
      // added, so a mark landing on the sunlit road at strength 1 has nowhere
      // above 1 to go and turns white — losing exactly the hue this whole
      // measurement was about. At this scale the strongest mark lands near 0.74
      // in red over a mid-tone, which stays gold.
      vec3 gold = mix(measured, measured * uSunTint, 0.5) * 1.35;

      float beam = shafts(vUv);

      vec3 lit = colour;
      lit += gold * beam * 0.13 * amount;

      if (uRain > 0.004) {
        // Three layers, because 763 marks with a median of 2px and a tail out
        // to flares is not one population: near and large, mid, and a fine dust
        // that is most of the count and almost none of the light.
        // The speeds are the difference between rain and dust, and they were
        // dust. Screen speed is speed/scale, so 0.11 at scale 9 is 1.2% of the
        // frame per second — a drop taking *eighty-two seconds* to cross the
        // picture. Real rain crosses a three-metre field of view in about six
        // tenths of one. Nothing about the marks' colour or size could make
        // that read as rain, because at that speed it is not falling, it is
        // drifting, and the eye knows the difference before it knows anything
        // else about them.
        //
        // Now: 1.2s, 0.9s and 0.7s across the frame, near to far — nearer drops
        // slower because they are, in fact, nearer, and parallax is the whole
        // reason there are three layers. Each column then varies that by ±50%
        // of its own (see sparks), so no two lines of rain keep pace.
        //
        // Not the 0.6s a real drop takes, and the overshoot is instructive: at
        // true rain speed with a shutter long enough to see them, each mark
        // becomes a long thin line and the frame reads as a scratched print —
        // which is the failure the parent project's own rain pass documents at
        // length. What has to read as falling is the *layer*, not each drop, so
        // the marks travel a visible fraction of the frame per second and stay
        // short enough to be drops.
        float near = sparks(vUv, 9.0, 7.6, 0.17, 0.0);
        float mid = sparks(vUv, 26.0, 29.0, 0.095, 31.7);
        float dust = sparks(vUv, 48.0, 69.0, 0.062, 77.1);
        float drops = near * 1.05 + mid * 1.25 + dust * 0.34;

        // Where the beam is, mostly. Not exclusively: some light is scattered
        // everywhere and the floor keeps a scatter of sparks across the whole
        // frame, rather than a hard edge where the shafts stop.
        float inBeam = 0.62 + 1.5 * beam;
        float strength = drops * inBeam * amount * (0.35 + 0.65 * uRain);

        // The core replaces; the halo adds. Measured, adding alone does not
        // produce gold and cannot: a mark over the navy water came out at
        // (1.00, 0.96, 0.94) against the reference's added light of
        // (1.00, 0.82, 0.54), because what the eye sees is the drop *plus the
        // water under it*, and enough blue under a warm light is a neutral.
        //
        // Which is also the physics. A drop catching the sun is not a haze over
        // the scene, it is a lens imaging a source about five orders of
        // magnitude brighter than a puddle — whatever was behind it does not
        // survive. So the bright part of a mark takes the light's own colour
        // outright, and only its glow is added to what is there.
        vec3 core = measured * 1.18;
        // Sharp rather than proportional: a mark either is the drop or is the
        // glow around it, and a linear ramp spends most of its range on marks
        // that are half water — which measured (1.00, 0.93, 0.86), still two
        // thirds of the way to neutral.
        lit = mix(lit, core, smoothstep(0.03, 0.22, strength) * 0.94);
        lit += gold * strength * 0.30;
      }

      gl_FragColor = vec4(lit, 1.0);
    }
  `,
};
