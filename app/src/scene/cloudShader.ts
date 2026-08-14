import * as THREE from 'three';
import { createCloudRampTexture } from './cloudRamp';
import { CLOUD_SHADOW_GLSL } from './cloudShadow';

/**
 * Unlit, ramp-indexed cloud shading.
 *
 * This deliberately bypasses PBR. Measuring the reference image against the
 * previous MeshStandardMaterial render showed three things that a lit
 * material structurally cannot fix by retuning:
 *
 *  - Hue is a function of value. The reference's blue/red separation climbs
 *    from 2 at the white crown to 150 in the deepest crevice; the lit render
 *    sat at ~25 across its entire range, because N.L darkening is achromatic.
 *  - The tonal histogram was bimodal (one bright plateau, one dead-grey blob
 *    at luminance ~100) where the reference is a broad continuum spanning
 *    130-255 with nothing below 130.
 *  - The render never reached white at all (peak luminance 227 against the
 *    reference's 4% of area at 250+).
 *
 * So brightness is not computed and then coloured. A scalar shading term s is
 * computed from form, and s *indexes the measured ramp* (cloudRamp.ts). The
 * ramp supplies both value and hue together, which is the only way to get
 * "darker therefore bluer" to hold everywhere by construction.
 */

/** Shared GLSL: cheap 3D value-noise FBM, used to break up the shading term.
 * This is the fix for the measured flatness — local gradient energy in the
 * render was 1.09 against the reference's 2.60, i.e. less than half the
 * surface detail, which reads as plastic smoothness. */
const NOISE_GLSL = /* glsl */ `
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
          mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
          mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5, s = 0.0, norm = 0.0;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); norm += a; p *= 2.03; a *= 0.5; }
    return s / norm;
  }
  // Brush tooth needs a *different* spectrum from fbm, not just a higher
  // frequency. At the standard gain of 0.5 an fbm's finest octave carries
  // about 3% of the total weight, so its output is dominated by its smoothest
  // component however high its base frequency is set — which is why using
  // fbm for surface detail measurably failed to raise the render's local
  // gradient energy at all. Two octaves at near-equal weight keeps the energy
  // where the eye reads texture.
  float tooth(vec3 p) {
    return vnoise(p) * 0.62 + vnoise(p * 2.17 + 11.3) * 0.38;
  }
`;

export interface CloudMaterials {
  core: THREE.ShaderMaterial;
}

/**
 * lightDirection is a deliberately *art-directed* key light, not the true
 * astronomical sun direction — per the Guilty Gear Xrd research (plan.md
 * discussion): professional cel-look 3D doesn't trust physically-correct
 * lighting for its shading reads either, artists bend it toward whatever
 * direction makes the form and rim read best.
 */
export function createCloudMaterials(lightDirection: THREE.Vector3): CloudMaterials {
  const ramp = createCloudRampTexture();

  const core = new THREE.ShaderMaterial({
    uniforms: {
      uRamp: { value: ramp },
      uLightDir: { value: lightDirection.clone().normalize() },
      // Weights sum to 1 so s stays in [0,1] before the modifier terms.
      // Light-facing dominates; the baked vertical gradient is the secondary
      // read that keeps undersides reading as underside even where they face
      // the key light.
      uWeightLight: { value: 0.6 },
      uWeightHeight: { value: 0.4 },
      // Multiple-scattering floor: the light term is remapped into
      // [uAmbient, 1] rather than being allowed to reach zero.
      //
      // This is what was missing once the key light was swung behind the cloud
      // to get lateral modelling. With the source beyond the mass, the whole
      // camera-facing hemisphere sits on the shadow side, so the light term
      // collapsed — and with it the entire shading term. Tracing the terms for
      // a typical visible fragment gave s ≈ 0.02 before the contrast stage,
      // where the design intends ≈ 0.5, and the measurement agrees: the
      // render's tower had 54.5% of its area below luminance 205 and a median
      // of 204, against the reference's 20.4% and 230. Inverting the ramp,
      // that median is s = 0.11 where the reference's is s = 0.69, and over a
      // quarter of the mass was pinned at s = 0 — which is the vivid blue at
      // the ramp's bottom entry showing through as "holes to the sky".
      //
      // A floor is the physically right correction rather than a bias hack: a
      // cumulus is optically thick and multiply-scattering, so its shadow side
      // is not dark but merely less bright. The reference bears that out — its
      // darkest tower pixel is 177 against a white of 255, a range of well
      // under a third.
      uAmbient: { value: 0.45 },
      // How far a puff nestled among neighbours is pushed down the ramp.
      // Was 0.20, for a measured target of "~48% of the reference's cloud
      // interior below luminance 205". That figure came from the *previous*
      // reference image (1786418841252.png, deleted on main); re-measured on
      // the current one (1786443741198.png) the same statistic is 20.4%, so
      // the old value was pushing the mass down to meet a target that no
      // longer exists.
      uOcclusion: { value: 0.12 },
      // にじみ: multi-scale noise on the shading term itself, so shadow
      // regions mottle and bleed into the lit areas instead of being clean
      // geometric bands.
      // 0.34 -> 0.28. The tower's total tonal spread overshot (sd 22.1 against
      // the reference's 18.7) while its *systematic* lateral gradient was still
      // short (gradX -6.7 against -10.0) — too much undirected mottle, too
      // little modelling. Trading noise for wash moves both the right way.
      uNoiseAmount: { value: 0.28 },
      uNoiseScale: { value: 2.1 },
      uDetailAmount: { value: 0.2 },
      uDetailScale: { value: 6.5 },
      // 多段階: soft posterisation. Plateaus at uTiers levels with smoothstep
      // transitions between them — the painted look of discrete shadow
      // regions with blended-but-defined boundaries, rather than either a
      // continuous ramp (too smooth) or hard cel bands (too graphic).
      uTiers: { value: 4.0 },
      uTierSoft: { value: 0.34 },
      uTierBleed: { value: 0.09 },
      uTierBleedScale: { value: 3.4 },
      uTierMix: { value: 0.7 },
      uTerminator: { value: 0.68 },
      uPerLobeTint: { value: 0.13 },
      uShadowMap: { value: null as THREE.Texture | null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uShadowTexel: { value: 1 / 256 },
      uShadowBias: { value: 0.006 },
      // Wide on purpose: a cloud shadow with a readable edge looks like a
      // solid object's shadow. The 5x5 taps are spread over ~40 texels so the
      // result is a soft partial occlusion at cloud-mass scale.
      uShadowRadius: { value: 1.6 },
      // 0.22 -> 0.15, same stale-target correction as uOcclusion above.
      uShadowStrength: { value: 0.15 },
      uMacroScale: { value: 0.16 },
      uMacroAmount: { value: 0.3 },
      // Now in cluster-local km (see the wash term in the fragment shader).
      // 0.22 puts the hero tower's 4.3km half-width at about 0.78 of the
      // clamp, so the mass uses most of the available ramp without flattening
      // against it, and the small cumulus scale down in proportion.
      // 0.22 -> 0.14 and 0.62 -> 0.34. At 0.22 the dot product saturated the
      // clamp over roughly a fifth of the tower, so across that fifth the wash
      // carried *no* gradient at all — the term was simultaneously too strong
      // (a flat -0.62 offset on the camera-facing side, which is the shadow
      // side now that the key light sits beyond the mass) and too weak (no
      // modelling where it clipped). Scaling so the tower's own extent stays
      // inside the clamp keeps the gradient linear across the whole mass.
      uWashScale: { value: 0.14 },
      // 0.34 -> 0.46. Cutting the wash to stop it clamping also cost the
      // lateral read it exists for: gradX fell from -6.9 to -5.5 against the
      // reference's -10.0. Half the reduction is given back, which the smaller
      // uWashScale keeps inside the clamp.
      uWashAmount: { value: 0.58 },
      uFieldCenter: { value: new THREE.Vector3(0, 4, -26) },
      uDetailFocus: { value: 0.76 },
      uHighlightKnee: { value: 0.82 },
      uHighlightGain: { value: 0.85 },
      // 12.0 tonemapped to 254.9, i.e. pure white, and mix() does not clamp,
      // so with a gain above 1 the blend overshot its target across a wide
      // band of s. The measured result was that the render's entire top 5%
      // was a flat (255,255,255) plateau, where the reference keeps gradation
      // all the way up — its top 1% is 254, its top 5% is 251, and only about
      // a tenth of a percent is truly pure white. 6.0 lands at ~253, so the
      // crown can still reach white where it clips but no longer arrives
      // there with a fifth of the cloud in tow.
      uWhiteHDR: { value: new THREE.Vector3(8.5, 8.5, 8.5) },
      // What distant cloud fades toward, in the same inverse-tonemapped linear
      // HDR space the ramp lives in.
      //
      // This was previously the mid-height *sky* colour, sRGB(81,159,199), and
      // that was the wrong target — it made distance darken cloud, when the
      // reference does the opposite. Measured band by band down the frame, the
      // reference's distant cloud gets *brighter* as it recedes (luminance 232
      // near, 244 in the middle distance, 243 far) and converges on roughly
      // sRGB(236,245,249); this render went 226 -> 229 -> 208, sinking instead
      // of dissolving. Physically that is airlight: the haze between viewer
      // and cloud is itself brightly lit, so what a distant object washes out
      // toward is the pale luminous haze, not the deeper blue of the zenith.
      // Re-measured on the current reference. The note above concluded that
      // distant cloud gets *brighter* as it recedes (232 -> 244 -> 243) and set
      // this to sRGB(234,244,249) accordingly. That reading came from the
      // previous reference image; on 1786443741198.png the low bank does the
      // opposite, falling steadily toward the horizon — cloud luminance by
      // elevation band runs 220.5 at 9.1 deg, 215.8 at 6.3, 202.7 at 3.5 and
      // 193.1 at 0.8. Against that, this render's bank measured 248.2 and
      // 248.6 in the last two bands: 45 and 55 levels too bright, and washed
      // to saturation 0.04 against the reference's 0.25-0.31. That is the
      // blown-out white ribbon across the bottom of the frame.
      //
      // Retargeted to sRGB(162,203,227), the reference's own most-distant
      // cloud colour. Still well above the sky it sits against (sRGB(109,170,
      // 209) at that elevation), so the bank stays cloud rather than dissolving
      // into the sky — it just stops being white.
      uHazeColor: { value: new THREE.Vector3(0.1733, 0.4668, 0.8792) },
      // Left at 12km / 0.033. Pushing the start out to 16km and steepening to
      // 0.055 was tried, to haze the near bank tier harder, and it backfired:
      // it also dropped the hero tower's own haze from 0.15 to 0.05, and both
      // the highlight boost (gated by 1-haze) and the bloom threshold key off
      // how bright the tower ends up, so the tower bloomed into a glare halo
      // over the sky. Measured, softFrac went 54.0% -> 84.4% and medEdge
      // 9px -> 16px, i.e. straight back to where the deleted fringe shell had
      // them, and the lateral read collapsed from 12.0 to 2.7. The bank has to
      // be brought down without touching the tower's distance term.
      // Start held at 12km; density 0.033 -> 0.060. Only the density moves,
      // deliberately: it is monotonic in the safe direction, adding haze to the
      // bank *and* to the tower, where the failed attempt above had removed it
      // from the tower and set off the glare. The rows the bank occupies turned
      // out to be the near tier at 26-42km, sitting at a haze of only 0.37-0.63
      // and therefore still nearly its own colour; at 0.060 that becomes
      // 0.57-0.84 and it can actually reach the haze target. The tower goes
      // from 0.15 to 0.26, which now *darkens* it slightly rather than bleaching
      // it, because the haze colour is no longer near-white.
      uHazeStart: { value: 12.0 },
      uHazeDensity: { value: 0.060 },
      uHazeMax: { value: 0.96 },
      // Cut hard from 0.45. With the lobe count raised to reference density,
      // nearly every pixel of the silhouette is near some lobe's grazing
      // angle, so a strong rim term stops being an edge accent and becomes a
      // flat brightness added to the whole cloud — the render went to 20% of
      // area at luminance 245+ against the reference's 11%, with only 5% left
      // below 205 against its 48%.
      // 1.5 -> 1.9. The rim is added to s and then clamped, so raising the
      // whole term (ambient floor + bias) left less headroom above it and the
      // accent stopped registering: rimFrac fell from 5.0% to 3.9% against the
      // reference's 5.3% without this term itself changing.
      // 1.9 -> 1.4: with uContrast at 1.80 the accent overshot, rimFrac 10.3%
      // against the reference's 5.3%.
      // 1.4 -> 1.0. rimFrac sat at 9.6% against the reference's 5.3%, and the
      // mean edge-minus-interior delta came out at +6.0 where the reference's
      // is -8.3 — this render's contour is systematically brighter than its
      // interior where the reference's is slightly darker. Part of that is now
      // the bloom, which is also what buys the correct medEdge, so the
      // shader-side accent gives way rather than the glare.
      uRimStrength: { value: 1.0 },
      // Contrast expansion applied to s before it indexes the ramp. Without
      // it the term is a sum of several roughly-uniform quantities, so it
      // piles up around 0.5 by the central limit theorem and the render comes
      // out of the ramp's midtones only — measured against the reference the
      // first version of this shader spanned luminance 174-235 where the
      // reference spans 148-252, and never produced a single white pixel
      // against the reference's 11% of area at 245+. Expanding around the
      // midpoint restores the tails at both ends.
      // 1.35 -> 1.80. With the multiple-scattering floor in place the median
      // landed on the reference (229 against 230) but the dark tail collapsed:
      // 5.7% of the mass below luminance 205 against the reference's 20.4%,
      // and 0.1% below 190 against its 4.6%. A floor lifts the whole term, so
      // the fix is spread rather than offset. Sized by inverting the ramp on
      // both quartiles at once — the reference's p25/p75 sit at s = 0.244 and
      // 0.87, the render's at 0.42 and 0.85, and the pair of equations gives
      // very nearly this contrast with the bias below.
      uContrast: { value: 1.70 },
      // Downward shift after the contrast expansion. Expanding around 0.5 is
      // symmetric, but the term's own mean sits above 0.5 (the rim and the
      // light-facing weight both push up), so without this the whole render
      // rides high: measured median luminance 217 against the reference's 207,
      // and only 33% of area below luminance 205 where the reference has 48%.
      // -0.13 -> -0.35 (the term is subtracted, so this *raises* s). Sized from
      // the ramp inversion rather than by eye: the reference tower's median
      // luminance of 230 corresponds to s = 0.688 and the render's 204 to
      // s = 0.11, and the ambient floor and the relaxed occlusion/shadow/wash
      // terms above account for about 0.35 of that 0.58 gap between them.
      uBias: { value: -0.38 },
      // Time of day, as an illuminant (core/daylight.ts). Both are exactly
      // white at noon, so the measured ramp is untouched there and every
      // statistic in this project still holds.
      //
      // Two of them, not one, because a cloud at sunset is not a cloud with an
      // orange filter over it: its crown is lit by a low red sun while its
      // underside is lit by the sky dome, which has gone blue-violet. Applying
      // one tint uniformly loses exactly the split that makes an evening cloud
      // read as evening.
      uSunTint: { value: new THREE.Vector3(1, 1, 1) },
      uSkyTint: { value: new THREE.Vector3(1, 1, 1) },
      // How far the clouds move off their measured midday colours. 0 at noon,
      // so the ramp — and every statistic fitted to it — is untouched there.
      uDayBlend: { value: 0 },
      // How closed the sky is, 0 until the cloud slider passes about three
      // quarters and 1 at the top.
      //
      // The measured ramp cannot express an overcast base, and that is not a
      // fault in it: it was sampled from a sunlit cumulus in the reference
      // image, so its dark end is the cerulean of sky showing through a gap,
      // not the grey of a cloud you cannot see the sun through. Asking it for
      // 曇天 gives a bright blue-white ceiling however much geometry is thrown
      // at it.
      //
      // A deck thick enough to close the sky is thick enough to stop the sun,
      // so its base is lit only by light that has been scattered many times on
      // its way through — which is darker than direct light, and *bluer*, not
      // greyer. Multiple scattering through a deep cloud is still Rayleigh-
      // and droplet-scattered daylight; it has lost the sun, not the sky.
      //
      // The first version desaturated toward grey and the result was lead. The
      // colour below is measured off a rain-sky reference
      // (Screenshot_20260813-053823.png, scripts/duskref.js): its dark cloud
      // sits around sRGB(26,58,88), which is this in the linear HDR the shader
      // works in, normalised to luminance 1 so it carries hue alone.
      uOvercast: { value: 0 },
      uOvercastTint: { value: new THREE.Vector3(0.466, 1.067, 1.910) },
      /**
       * How far the multiply-scattered floor above is taken down because the
       * deck is *raining*, 1 when it is dry.
       *
       * Overcast and raining are not the same cloud, and until this existed the
       * renderer treated them as the same cloud seen in less light. The 0.52
       * above is the base of a closed deck that is merely thick; a deck that is
       * precipitating is thick enough that the drops have grown large enough to
       * fall, which means far more optical depth and far more of the light
       * absorbed before it reaches the base. Measured on the frame at rain=0.5,
       * the deck's undersides were still coming out as a bright saturated blue
       * — they read as fair-weather cumulus shadow, which is exactly what they
       * were being shaded as, and no amount of exposure cutting downstream
       * distinguishes them, because an exposure cut takes the crown down with
       * the base and the whole point is that a rain deck's base falls further
       * than its top does.
       */
      uRainDim: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aHeight;
      attribute float aOcclusion;
      attribute float aSeed;
      attribute float aTint;
      attribute vec3 aClusterPos;
      varying vec3 vNormalW;
      varying vec3 vViewDirW;
      varying float vHeight;
      varying float vOcc;
      varying float vTint;
      varying vec3 vNoisePos;
      varying float vDist;
      varying vec3 vClusterPos;
      varying vec3 vWorldPos;

      void main() {
        vHeight = aHeight;
        vOcc = aOcclusion;
        vTint = aTint;
        // Noise is sampled in the nodule's own object space plus a per-
        // instance offset, NOT in world space: a world-space field would make
        // the surface texture stand still while the cloud drifts through it
        // on the wind, which reads as the cloud shimmering rather than moving.
        vNoisePos = position + vec3(aSeed, aSeed * 1.7, aSeed * 2.3);
        // Cluster-local coordinate for the cloud-scale field. The vertex's own
        // offset is added at full weight so the field is continuous across a
        // lobe rather than constant over each instance.
        vClusterPos = aClusterPos + position;

        vec4 instanced = instanceMatrix * vec4(position, 1.0);
        vec4 worldPos = modelMatrix * instanced;
        // Normal must go through the instance matrix too — the per-axis
        // stretch in the instance scale is non-uniform, so a normal that
        // skipped it would be wrong on every stretched puff.
        mat3 instNormal = mat3(instanceMatrix);
        vec3 n = normalize(instNormal * normal);
        vNormalW = normalize(mat3(modelMatrix) * n);
        vec3 toCam = cameraPosition - worldPos.xyz;
        vDist = length(toCam);
        vWorldPos = worldPos.xyz;
        vViewDirW = normalize(toCam);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uRamp;
      uniform vec3 uLightDir;
      uniform float uWeightLight;
      uniform float uWeightHeight;
      uniform float uAmbient;
      uniform float uOcclusion;
      uniform float uNoiseAmount;
      uniform float uNoiseScale;
      uniform float uDetailAmount;
      uniform float uDetailScale;
      uniform float uTiers;
      uniform float uTierSoft;
      uniform float uTierBleed;
      uniform float uTierBleedScale;
      uniform float uTierMix;
      uniform float uTerminator;
      uniform float uPerLobeTint;
      uniform sampler2D uShadowMap;
      uniform mat4 uShadowMatrix;
      uniform float uShadowTexel;
      uniform float uShadowBias;
      uniform float uShadowRadius;
      uniform float uShadowStrength;
      uniform float uMacroScale;
      uniform float uMacroAmount;
      uniform float uWashScale;
      uniform float uWashAmount;
      uniform vec3 uFieldCenter;
      uniform float uDetailFocus;
      uniform float uHighlightKnee;
      uniform float uHighlightGain;
      uniform vec3 uWhiteHDR;
      uniform vec3 uHazeColor;
      uniform float uHazeStart;
      uniform float uHazeDensity;
      uniform float uHazeMax;
      uniform float uRimStrength;
      uniform float uContrast;
      uniform float uBias;
      uniform vec3 uSunTint;
      uniform vec3 uSkyTint;
      uniform float uDayBlend;
      uniform float uOvercast;
      uniform vec3 uOvercastTint;
      uniform float uRainDim;

      varying vec3 vNormalW;
      varying vec3 vViewDirW;
      varying float vHeight;
      varying float vOcc;
      varying float vTint;
      varying vec3 vNoisePos;
      varying float vDist;
      varying vec3 vClusterPos;
      varying vec3 vWorldPos;

      ${NOISE_GLSL}
      ${CLOUD_SHADOW_GLSL}

      void main() {
        vec3 n = normalize(vNormalW);

        // Wrapped diffuse rather than clamped N.L: a cloud is a dense
        // scattering medium, so its terminator wraps well past 90 degrees
        // instead of falling to zero there. Clamped N.L is what put a hard
        // grey edge on every puff.
        float ndl = dot(n, normalize(uLightDir));
        float wrapped = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
        // Sharpened terminator. A soft wrapped-diffuse falloff shades a lobe
        // like a balloon, and when hundreds of lobes overlap the result is one
        // undifferentiated lump — which is exactly what the render was doing.
        // In the reference every lobe carries a bright cap that ends fairly
        // abruptly, and it is those many small hard light/shadow boundaries,
        // not any surface texture, that give the reference its detail. Mixing
        // in a smoothstep tightens each lobe's terminator so its outline reads
        // against whatever sits behind it.
        float lightTerm = mix(wrapped, smoothstep(0.32, 0.78, wrapped), uTerminator);
        // Multiple-scattering floor (see uAmbient). Remapping into
        // [uAmbient, 1] rather than adding a constant keeps the term's
        // gradient — the shape reads exactly as before, it simply no longer
        // bottoms out, which is what pinned a quarter of the mass to the
        // ramp's bottom entry once the key light moved behind the cloud.
        lightTerm = mix(uAmbient, 1.0, lightTerm);

        float heightTerm = vHeight * 0.5 + 0.5;

        float s = lightTerm * uWeightLight + heightTerm * uWeightHeight;

        // Detail budget. Measuring where contrast actually sits, the
        // reference spends 48% of its cloud area on *calm* surface (local
        // std below 6 in an 11x11 window) and only 17% on busy surface; this
        // render was the other way round at 27%/42%, and its 99th-percentile
        // gradient was 51 against the reference's 25 — i.e. busier AND
        // harder-edged everywhere at once. That is what reads as "not
        // painted": a painter blocks in large quiet masses and spends marks
        // only where the form turns. Detail is therefore concentrated into
        // the terminator band, peaking where the surface is half-lit and
        // falling away in both the fully-lit crown and the settled shadow.
        // This is also why the post-process filter could not fix the look —
        // a filter sees only the finished image and has no way to know which
        // regions deserved the marks.
        float detailGate = mix(1.0, 4.0 * lightTerm * (1.0 - lightTerm), uDetailFocus);

        // Broad noise: makes whole shadow regions grow and bleed irregularly
        // instead of following clean geometric bands ("にじむ").
        s += (fbm(vNoisePos * uNoiseScale) - 0.5) * uNoiseAmount * detailGate;

        s -= vOcc * uOcclusion;
        s += vTint * uPerLobeTint;

        // (A) Cloud self-shadow from the light-space depth map. See
        // cloudShadow.ts for why this is here rather than relying on the
        // per-puff optical depth above: the integral is buried inside the
        // cluster where nothing can see it, while a light-space depth test
        // varies across exactly the visible shell. This is the term that
        // actually groups lobes into large light and shadow masses.
        float lit = sampleCloudShadow(uShadowMap, uShadowMatrix, vWorldPos, uShadowTexel, uShadowBias, uShadowRadius);
        s -= (1.0 - lit) * uShadowStrength;

        // --- Cloud-scale value organisation ---
        //
        // Decomposing both images by spatial scale showed where the remaining
        // gap actually lives. In the 2-16px bands this render already matches
        // the reference (6.9/8.8 against 7.3/10.1), but in the 40-80px band it
        // carries 4.6 against the reference's 7.6, and across the whole frame
        // above 80px it is 4.2 against 20.9 — roughly five times less. The
        // reference groups many lobes into one large light mass and one large
        // shadow mass and lets the small detail ride on top; this render shaded
        // every lobe by the same local rule, so averaged over 80px it came out
        // flat everywhere. That is also why no post-process filter helped: a
        // kernel a few pixels wide cannot manufacture contrast at 80px.
        //
        // Per-fragment shading is inherently local — N.L, occlusion and the
        // ramp all are — so the large scale has to be introduced deliberately.
        // Two terms do it here, and the shadow map (uShadowMap, below) is the
        // third and most structural.
        //
        // (B) A low-frequency field in cluster-local space. Wavelength is on
        // the order of the cluster itself, so it lightens and darkens whole
        // regions of a cloud rather than individual lobes. Evaluated in
        // cluster space, not world space, so it travels with the cloud instead
        // of the cloud swimming through a fixed pattern.
        s += (fbm(vClusterPos * uMacroScale) - 0.5) * uMacroAmount;

        // (D) A single large directional wash along the key light — the broad
        // graded wash a background painter lays over the whole cloud before
        // any detail goes down. Crude on its own, but it guarantees a
        // large-scale gradient exists at all.
        // Measured against each cluster's *own* centre, not a single world
        // field centre. The world-centred version had to be kept tiny for a
        // reason that had nothing to do with the hero tower: the far bank sits
        // 90km out, so its dot product saturated the clamp and any usable
        // strength crushed the whole background. That forced a scale so small
        // that across the tower's own 4.3km radius the term moved the shading
        // by about 0.025 — around two levels of luminance. It was, in effect,
        // switched off exactly where it was supposed to be doing the work.
        //
        // Cluster-local coordinates decouple the two: distance from camera no
        // longer enters, so the strength can be set by how much gradient a
        // cloud mass should carry across itself, and it scales naturally with
        // mass size (a big tower has more depth for light to fall through than
        // a small cumulus, and now gets a correspondingly bigger ramp).
        float wash = clamp(dot(vClusterPos, normalize(uLightDir)) * uWashScale, -1.0, 1.0);
        s += wash * uWashAmount;

        // Rim. Sampling the reference along its own silhouette showed this was
        // gated backwards: the bright edge sits on the *shadow* side of the
        // contour (peak 204 against an interior of 179, a lift of +25), while
        // the lit side shows no lift at all — it is already bright there. This
        // was gating the rim to the lit hemisphere, adding brightness exactly
        // where the reference has none and leaving the shaded edges flat.
        //
        // It is also far more selective than a uniform outline. The median
        // lift along the reference's contour is only +5, but a quarter of it
        // carries more than +30 and an eighth more than +50 — strong accents
        // placed on some edges, nothing on most. A high Fresnel exponent
        // reproduces that: it confines the term to the most grazing pixels
        // instead of spreading a weak glow along the whole silhouette.
        float fres = pow(1.0 - clamp(dot(n, normalize(vViewDirW)), 0.0, 1.0), 4.0);
        s += fres * uRimStrength * (1.0 - smoothstep(0.45, 1.0, lightTerm));

        s = clamp((s - 0.5) * uContrast + 0.5 - uBias, 0.0, 1.0);

        // 多段階 — four shadow steps, applied to the low-frequency shading
        // only. The boundaries are deliberately *not* clean: a noise offset is
        // added to the tier coordinate before it is quantised, so each step
        // wanders rather than tracing a mathematical iso-line, and the
        // smoothstep across the step is wide. That is the にじみ — a bled,
        // irregular edge between shadow steps rather than a hard cel band or a
        // continuous ramp.
        float bleed = (fbm(vNoisePos * uTierBleedScale) - 0.5) * uTierBleed;
        float scaled = (s + bleed) * uTiers;
        float tiered = (floor(scaled) + smoothstep(0.5 - uTierSoft, 0.5 + uTierSoft, fract(scaled))) / uTiers;
        s = mix(s, tiered - bleed, uTierMix);

        // Brush tooth goes on *after* the posterisation, not before. Measured
        // the other way round: inside a plateau the smoothstep is flat at both
        // ends, so it erased most of the fine variation and the render's local
        // gradient energy fell below the un-posterised version. Blocking in
        // flat shapes first and texturing over them is also the order a
        // painter works in.
        s += (tooth(vNoisePos * uDetailScale) - 0.5) * uDetailAmount * detailGate;
        s = clamp(s, 0.0, 1.0);

        vec3 color = texture2D(uRamp, vec2(s, 0.5)).rgb;

        // Aerial perspective. In the reference the cloud's tonal range
        // collapses with height in frame — the spread between its 5th and
        // 95th luminance percentiles falls from 88 near the top to 38 in the
        // lower-middle bands, a 2.3x compression — because cloud that is
        // further away has more atmosphere in front of it, losing its shadows
        // and drifting toward the sky's own colour. This render applied none
        // of it: every cluster came out at full contrast whatever its
        // distance, which is why nothing settled into the background and the
        // lower cloud never dissolved into the sky.
        // Capped below 1: now that the haze target is a bright pale value
        // rather than the mid sky, letting it reach full strength bleaches the
        // far bank into featureless white slabs. The reference's most distant
        // cloud is bright (luminance ~243) but still carries its own modelling.
        float haze = clamp(1.0 - exp(-max(vDist - uHazeStart, 0.0) * uHazeDensity), 0.0, uHazeMax);

        // Highlight concentration, and a real white.
        //
        // Measured, the reference puts only 5.5% of its cloud area above
        // luminance 248 but takes it all the way to a true 255, with 79% of
        // that white massed into a handful of large blobs. This render had
        // twice the white area (11.1%) and never got past 253 — a sprinkle of
        // identical bright caps instead of a few decisive sunlit faces.
        //
        // 253 was not a tuning failure but a ceiling: the ramp is sampled from
        // the reference with the top 2% of pixels trimmed off (they are sky
        // bleeding through gaps), so its brightest entry is sRGB(251,254,254)
        // and nothing indexing it can ever be whiter than that. So the top of
        // the range is taken *past* the ramp, toward a value high enough to
        // clip white through the tonemapper.
        //
        // Gated by (1 - haze) as well as by a late smoothstep. Without the
        // haze gate the boost simply outranks the aerial perspective below —
        // a distant lobe pushed to 12.0 is still near-white after being mixed
        // 72% toward the sky colour, which is why the far bank kept coming out
        // as bright as the hero tower.
        // Gated by the *square* of the remaining transmittance, not by
        // (1 - haze) directly. The boost pushes toward 8.5 in linear HDR, which
        // is an enormous value next to the haze target's ~0.5, so even the 15%
        // that survived a haze of 0.85 still dominated the blend and kept the
        // far bank near white — the measured 218.9 against the reference's
        // 193.1 in the lowest band. Squaring takes that 15% to 2%, which is
        // what a sunlit crown seen through 50km of airlight should retain,
        // while the hero tower (haze 0.15) only goes from 85% to 72%.
        float hot = smoothstep(uHighlightKnee, 1.0, s);
        float clear = 1.0 - haze;
        color = mix(color, uWhiteHDR, clamp(hot * uHighlightGain, 0.0, 1.0) * clear * clear);

        color = mix(color, uHazeColor, haze);

        // Overcast: multiply-scattered light only. Applied before the hour,
        // because it is about how the light reaches the cloud and the hour is
        // about what colour that light is.
        //
        // Relit rather than desaturated — keep how bright the cloud is, take
        // the colour of the light that is actually reaching it. Desaturating
        // toward grey was the first attempt and produced exactly the lead sky
        // the reference does not have.
        float overcastLum = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color = mix(color, overcastLum * uOvercastTint * 0.52 * uRainDim, uOvercast);

        // Relight for the hour. Applied last, to everything — the white crown
        // and the hazed distance are as much a part of an evening as the ramp
        // is. s is the shading term, so the crown takes the sun's colour and
        // the crevices take the sky's.
        //
        // A blend toward the cloud's own *luminance* carrying the illuminant,
        // not a multiply. Multiplying was tried first and is wrong for a
        // measured ramp: the ramp already encodes a specific midday hue, so
        // multiplying a saturated evening light through it compounds two hues
        // instead of replacing one. What that produced at 18:36 was cloud in
        // vivid cerulean with pure yellow highlights — the ramp's blue shadow
        // end times a blue sky tint, and its white crown times a beam whose
        // blue channel had gone to zero. Relighting a surface means keeping how
        // bright it is and taking the light's colour, which is exactly this.
        vec3 illum = mix(uSkyTint, uSunTint, s);
        float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color = mix(color, lum * illum, uDayBlend);

        gl_FragColor = vec4(color, 1.0);
      }`,
  });

  // There is deliberately no translucent fringe shell any more.
  //
  // It was a second, 1.15x-scaled sphere per lobe whose alpha was a Fresnel
  // term, pow(1 - dot(N,V), k). On a sphere that term is *maximum exactly at
  // the shell's outer limb* and falls away inward, so the fringe's outermost
  // boundary was also its most opaque line. That is a hard-edged ring, which
  // is precisely what read as a transparent sphere drawn around every lobe —
  // the shape was inverted with respect to what a soft edge needs (a real
  // translucent shell's optical depth goes to zero at its limb, because the
  // chord through it does).
  //
  // Two further faults made it worse, and neither was fixable by retuning:
  //
  //  - No depth awareness. The shell drew wherever it passed the depth test,
  //    so a lobe near the front of the cluster laid its whole ring across the
  //    mass behind it, putting complete circles *inside* the silhouette where
  //    there is no cloud/sky boundary at all.
  //  - No aerial perspective, unlike the core. The far bank's cores correctly
  //    dissolve toward the haze colour with distance, but their shells kept
  //    full strength, so the shells outlived the cloud they belonged to and
  //    floated in clear sky as detached bubbles (visible top-right of frame).
  //
  // And the measurement says the outline needed *less* softening, not better
  // softening: 87.5% of this render's silhouette crossings were 6px or wider
  // against the reference's 56.6%, at a median 16px against its 9px. The
  // reference's contour is mostly crisp. Removing the shell therefore moves
  // the fringe statistics toward the target rather than away from it, which
  // is why the fix is a deletion rather than a rewrite.
  return { core };
}
