import * as THREE from 'three';

export interface SkyHandle {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

/**
 * Atmosphere backdrop only — physically-based Rayleigh + Mie single scattering
 * (plan.md §3.1), fullscreen raymarch. Clouds used to be raymarched in this same
 * pass (see git history / scene/skyClouds.ts) but moved to real mesh instances in
 * scene/clouds.ts after reviewing amanesf/planet-canvas2's cloud system — this
 * file keeps only the sky.
 */

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform mat4 uCameraInverseProjection;
  uniform mat4 uCameraWorldMatrix;
  uniform vec3 uSunDirection;
  uniform float uDusk;

  const float PI = 3.14159265359;

  const float PLANET_RADIUS = 6371.0;
  const float ATMOS_RADIUS = 6471.0;
  const vec3 PLANET_CENTER = vec3(0.0, -PLANET_RADIUS, 0.0);
  const vec3 RAYLEIGH_COEFF = vec3(5.8e-3, 13.5e-3, 33.1e-3);
  const float RAYLEIGH_SCALE_HEIGHT = 8.0;
  // Turbidity. 9.0e-3 is a hazy-day aerosol load and it was measurably wrong
  // for this reference: it fills the lower sky with a neutral forward-scattered
  // glow, and the reference has no such glow — its sky is brightest around 15
  // degrees elevation and *falls* again toward the horizon, which is the
  // signature of a clean atmosphere. Solved against the reference's own
  // per-elevation profile (scripts/skymodel.js), 3.0e-3 — a clear maritime
  // summer value — sits within 0.2 RMSE of the unconstrained optimum while
  // keeping a real aerosol term for the sunset arc the same constants have to
  // serve later (plan.md §3.2).
  const float MIE_COEFF = 3.0e-3;
  const float MIE_EXT = MIE_COEFF * 1.11;
  const float MIE_SCALE_HEIGHT = 1.2;
  const float MIE_G = 0.76;
  // 11.0 -> 7.0. The render's zenith measured luminance 142.5 against the
  // reference's 107.6 — 35 levels too bright, and correspondingly washed out
  // (saturation 0.66 against 0.84, red/blue 0.34 against 0.16). The whole sky
  // was riding too high and the vivid deep blue the reference opens with was
  // simply not reachable by re-saturating an over-exposed integral.
  const float SUN_INTENSITY = 7.0;
  const float SKY_SATURATION = 1.65;
  const float CIRRUS_ALTITUDE = 9.0;
  const float CIRRUS_WIND_ANGLE = 0.26;
  // Whiter: sRGB(222,238,248) rather than (212,233,246).
  const vec3 CIRRUS_COLOR = vec3(0.4836, 1.3152, 2.8100);
  const float CIRRUS_STRENGTH = 0.13;
  // A pale neutral blue for the long-path sky near the horizon, and a second,
  // darker value reached at the horizon itself.
  //
  // A single flat haze colour cannot reproduce the reference's low sky: it
  // rises to a peak near 15 degrees (luminance 178.5) and falls again to 159.8
  // at the horizon, and a constant necessarily plateaus. Adding the floor
  // colour took the fit's RMSE from 6.4 to 3.1.
  const vec3 HORIZON_HAZE = vec3(0.12, 0.35, 0.80);
  const vec3 HORIZON_HAZE_FLOOR = vec3(0.07, 0.265, 0.55);
  const float HORIZON_HAZE_FLOOR_HI = 0.18;
  const float HORIZON_HAZE_STRENGTH = 0.94;
  const vec3 GROUND_TINT = vec3(0.0797, 0.1445, 0.2182);
  const float CAMERA_ALTITUDE_KM = 0.0017;

  // --- thin high cloud ---
  //
  // Subtracting a smooth gradient from the reference's clear sky leaves faint
  // streaks: strongly elongated, roughly 10:1, all tilted the same way (about
  // 15 degrees off horizontal, i.e. aligned to one upper-level wind), feathered
  // at their ends, and pale — sRGB(204,228,244) against a sky of (80,163,215),
  // covering about a quarter of the clear sky at a lift of a few luminance
  // levels or more. Nothing of the sort existed here, which is part of why the
  // upper sky read as an empty gradient.
  //
  // Placed on a real plane at altitude rather than drawn in screen space, so
  // the perspective compression toward the horizon comes out for free.
  float hash21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float vnoise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm2(vec2 p) {
    float a = 0.5, s = 0.0, n = 0.0;
    for (int i = 0; i < 5; i++) { s += a * vnoise2(p); n += a; p *= 2.07; a *= 0.5; }
    return s / n;
  }

  vec2 raySphere(vec3 ro, vec3 rd, vec3 center, float radius) {
    vec3 oc = ro - center;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - radius * radius;
    float h = b * b - c;
    if (h < 0.0) return vec2(-1.0);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }

  vec2 atmosphereDensityAt(float height) {
    height = max(height, 0.0);
    return vec2(exp(-height / RAYLEIGH_SCALE_HEIGHT), exp(-height / MIE_SCALE_HEIGHT));
  }

  float phaseRayleigh(float mu) {
    return 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  }

  float phaseHG(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
  }

  const int PRIMARY_STEPS = 16;
  const int LIGHT_STEPS = 4;

  vec3 integrateAtmosphere(vec3 ro, vec3 rd, vec3 sunDir, float rayLength, out vec3 transmittance) {
    float mu = dot(rd, sunDir);
    float phaseR = phaseRayleigh(mu);
    float phaseM = phaseHG(mu, MIE_G);

    float stepSize = rayLength / float(PRIMARY_STEPS);
    vec3 totalRayleigh = vec3(0.0);
    vec3 totalMie = vec3(0.0);
    vec2 opticalDepth = vec2(0.0);

    for (int i = 0; i < PRIMARY_STEPS; i++) {
      vec3 samplePos = ro + rd * (stepSize * (float(i) + 0.5));
      float height = length(samplePos - PLANET_CENTER) - PLANET_RADIUS;
      vec2 density = atmosphereDensityAt(height) * stepSize;
      opticalDepth += density;

      vec2 lightHit = raySphere(samplePos, sunDir, PLANET_CENTER, ATMOS_RADIUS);
      float lightStepSize = max(lightHit.y, 0.0) / float(LIGHT_STEPS);
      vec2 lightOpticalDepth = vec2(0.0);
      bool blocked = false;
      for (int j = 0; j < LIGHT_STEPS; j++) {
        vec3 lightPos = samplePos + sunDir * (lightStepSize * (float(j) + 0.5));
        float lightHeight = length(lightPos - PLANET_CENTER) - PLANET_RADIUS;
        if (lightHeight < 0.0) { blocked = true; break; }
        lightOpticalDepth += atmosphereDensityAt(lightHeight) * lightStepSize;
      }

      if (!blocked) {
        vec3 tau = RAYLEIGH_COEFF * (opticalDepth.x + lightOpticalDepth.x)
                 + vec3(MIE_EXT) * (opticalDepth.y + lightOpticalDepth.y);
        vec3 attn = exp(-tau);
        totalRayleigh += density.x * attn;
        totalMie += density.y * attn;
      }
    }

    transmittance = exp(-(RAYLEIGH_COEFF * opticalDepth.x + vec3(MIE_EXT) * opticalDepth.y));
    vec3 singleScatter = SUN_INTENSITY * (totalRayleigh * RAYLEIGH_COEFF * phaseR + totalMie * MIE_COEFF * phaseM);

    vec3 lostEnergy = vec3(1.0) - transmittance;
    // 0.004 -> 0.010. With the primary integral turned down to match the
    // reference's zenith, this near-achromatic term is what refills the middle
    // elevations, where single scattering alone left the profile too dark.
    // The elevation falloff was 1.5*sunDir.y + 0.4, which still handed the sky
    // 46% of its midday multiple scattering with the sun two degrees above the
    // horizon — and since this term is what refills the middle elevations, the
    // whole sky stayed near midday brightness at dusk. Measured on the 18:36
    // frame, the sky's luminance ran 107 at 33 degrees elevation and 173 at 1
    // degree, against 115 and 181 at noon: the sun had all but set and the sky
    // had given up eight levels.
    //
    // Steepened so it actually goes out with the sun. Both curves saturate at
    // 1.0 above ~25 degrees of solar elevation, so the fitted midday sky (sun
    // at 55) is untouched — this only changes hours that had never been
    // measured against anything.
    vec3 multiScatterFudge = lostEnergy * SUN_INTENSITY * 0.010 * clamp(sunDir.y * 2.35 + 0.02, 0.015, 1.0);

    return singleScatter + multiScatterFudge;
  }

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 clip = vec4(ndc, -1.0, 1.0);
    vec4 viewSpace = uCameraInverseProjection * clip;
    viewSpace = vec4(viewSpace.xy, -1.0, 0.0);
    vec3 rd = normalize((uCameraWorldMatrix * viewSpace).xyz);
    vec3 ro = vec3(0.0, CAMERA_ALTITUDE_KM, 0.0);

    vec3 sunDir = normalize(uSunDirection);

    vec2 atmosHit = raySphere(ro, rd, PLANET_CENTER, ATMOS_RADIUS);
    vec2 groundHit = raySphere(ro, rd, PLANET_CENTER, PLANET_RADIUS);
    float rayLength = atmosHit.y;
    bool hitsGround = groundHit.x > 0.0;
    // Deliberately *not* shortened to the ground hit. Stopping the integral
    // at the planet surface is the physically correct thing to do, but just
    // below the horizon the ground distance collapses very fast, so the
    // atmospheric path — and with it the radiance — falls off a cliff over a
    // few pixels. That produced a black band hugging the horizon, darker than
    // the ground beneath it. Since the ground here is only a placeholder for a
    // foreground layer that will cover it (plan.md §5), the integral is left
    // at full atmospheric length so the value stays continuous across the
    // horizon, and the ground is applied purely as a tint below.

    vec3 skyTransmittance;
    vec3 skyColor = integrateAtmosphere(ro, rd, sunDir, max(rayLength, 0.001), skyTransmittance);

    float sunMu = dot(rd, sunDir);
    float sunDisc = smoothstep(0.9998, 0.99995, sunMu);
    skyColor += skyTransmittance * SUN_INTENSITY * sunDisc * 80.0;

    // Thin high cloud, blended in before the ground tint so it cannot appear
    // below the horizon.
    if (rd.y > 0.004) {
      float t = (CIRRUS_ALTITUDE - ro.y) / rd.y;
      if (t > 0.0 && t < 900.0) {
        vec3 hit = ro + rd * t;
        float ca = cos(CIRRUS_WIND_ANGLE), sa = sin(CIRRUS_WIND_ANGLE);
        vec2 q = vec2(hit.x * ca + hit.z * sa, -hit.x * sa + hit.z * ca);
        // 10:1 anisotropy: long across the wind direction, tight across it.
        float n = fbm2(vec2(q.x * 0.030, q.y * 0.155));
        // The ramp is compressed (was 0.66..0.94). The noise is roughly normal
        // about 0.5, so a ramp reaching to 0.94 was ~3.7 standard deviations
        // out: cover almost never approached 1, and the plane rendered as a
        // broad wash of *partial* cover instead of distinct streaks. That is
        // exactly why the high cloud read blue — at partial cover the blend
        // leaves the sky's own colour dominant, so the result is a blue veil
        // rather than white cirrus. Measured, this render covered 28.4% of its
        // clear sky at a lift of 4 or more against the reference's 11.7%, while
        // reaching a peak lift of only 36 against the reference's 53: too much
        // area, too little contrast. Raising the onset and shortening the ramp
        // moves both — fewer streaks, each of which actually reaches white.
        float cover = smoothstep(0.70, 0.82, n);
        // Fade out toward the horizon, where the plane is grazed and the
        // pattern would otherwise smear into an unbroken band, and fade in
        // over the first few degrees so nothing pops at the horizon line.
        // The horizon fade has to be generous: the plane is grazed there, so
        // a few degrees of view direction cover tens of kilometres of it and
        // any pattern stretches into unbroken bands across the frame.
        cover *= smoothstep(0.22, 0.48, rd.y);
        skyColor = mix(skyColor, CIRRUS_COLOR, cover * CIRRUS_STRENGTH);
      }
    }

    // Horizon haze.
    //
    // Left alone, the physics puts a strong yellow-brown band across the lower
    // sky: near the horizon the ray runs for hundreds of kilometres through
    // dense low air, and Rayleigh extinction scales as the inverse fourth
    // power of wavelength, so blue is stripped out of the transmitted light
    // long before red is. That is genuinely what a hazy horizon does, but the
    // reference does not read that way — its lower sky stays a pale blue-grey,
    // around sRGB(126,176,203) even at the very bottom of the frame — because
    // what fills that band there is scattered daylight off nearby haze and sea
    // rather than a hundred kilometres of reddened sky. Pulling the long-path
    // sky toward a pale neutral blue matches it, and keeps the frame in one
    // colour family instead of splitting it into a blue top and a brown bottom.
    // Confined to the band the reference actually desaturates in, and taken
    // nearly to full strength inside it.
    //
    // Two things went wrong on the first attempt. The blend started at the
    // horizon and reached a fifth of the way up the sky, so it drained colour
    // out of the whole lower half rather than just the haze band. And at 0.72
    // strength it did not actually reach its target: the mix happens in linear
    // HDR, where the low sky's own value is very large, so even 28% of it left
    // the result far brighter than intended — measured sRGB(191,218,233) at
    // the horizon against the reference's (106,167,208). Matching the
    // reference's profile instead: it holds a near-constant pale blue of about
    // (115,177,214) everywhere below roughly 13 degrees elevation, and is
    // untouched above ~20 degrees.
    float lowSky = 1.0 - smoothstep(0.17, 0.53, rd.y);
    vec3 hazeColor = mix(HORIZON_HAZE_FLOOR, HORIZON_HAZE, smoothstep(0.0, HORIZON_HAZE_FLOOR_HI, rd.y));
    skyColor = mix(skyColor, hazeColor, lowSky * HORIZON_HAZE_STRENGTH);

    if (hitsGround) {
      // Ground is out of scope here (a composited foreground layer covers it
      // later, plan.md §5), but a flat tint applied at full strength right up
      // to the horizon put a hard dark line across the frame that dominated
      // every test render. Fading it in with the downward view angle lets the
      // ground emerge out of the horizon haze instead, which is both what
      // aerial perspective actually does at that distance and far less
      // distracting while the sky is what is being judged.
      // NB smoothstep's edges must be given in increasing order — passing
      // them reversed is undefined in GLSL.
      float below = 1.0 - smoothstep(-0.07, 0.0, rd.y);
      // Tinted toward the same cool family as the cloud shadows rather than
      // the dark olive it used to be: a warm ground under a cool sky reads as
      // two unrelated pictures stacked, and the ground is meant to sit quietly
      // behind a foreground layer, not to introduce a second colour scheme.
      vec3 land = mix(skyColor, GROUND_TINT, 0.72);
      skyColor = mix(skyColor, land, below);
    }

    // Left in linear HDR, no manual tonemapping/gamma here — now that main.ts
    // runs an EffectComposer (core/postFx.ts), its OutputPass does both for
    // every pass's output uniformly (this shader's and the cloud materials'
    // alike). Doing it here too, on top of that, was fine back when this was
    // the only pass writing straight to the screen, but stacked with
    // OutputPass it would double-apply the sRGB curve and wash out shadows.
    // Art-directed saturation lift, applied at constant luminance.
    //
    // Measured against the reference image, the physical simulation above is
    // *correct* and still does not match it. Rayleigh scattering fixes the
    // zenith's red/blue ratio at coeff_R/coeff_B = 5.8/33.1 = 0.175 in linear
    // light, which after sRGB encoding lands at 0.47 — and that is precisely
    // what this shader renders. The reference's sky sits at 0.19 in sRGB,
    // i.e. about 0.03 in linear: roughly six times bluer than single-scattering
    // Rayleigh permits under any sun elevation or turbidity. Comparing the two
    // at matched screen heights, their luminances agree to within 2/255 while
    // their saturations differ by a factor of ~2, so the gap is purely a
    // saturation choice by the illustrator, not a physical parameter this
    // shader got wrong.
    //
    // Rather than distort the scattering constants (which would then be lying
    // about what they are, and would break the sunset arc the same constants
    // have to serve), the physics is left intact and the stylisation is a
    // separate, explicit, luminance-preserving step — the same stance taken
    // for the clouds, whose palette is likewise measured from the reference
    // rather than derived.
    // Faded out toward the horizon. Applied uniformly, the lift also
    // amplifies the warm low-altitude haze band into a hard yellow stripe,
    // which the reference does not have — there the haze desaturates to a
    // pale blue-white. That is the physically right behaviour too (the long
    // horizon path is aerosol-dominated, and aerosol scattering is
    // wavelength-neutral), so the stylisation has no business strengthening
    // it: the lift belongs to the clean Rayleigh zenith only.
    // Fade widened to 0.57 (was 0.28). Solved, not chosen: with the haze band
    // now reaching to 0.53, a saturation lift that was already at full strength
    // by 0.28 was re-saturating the pale haze it had just been blended with,
    // which is what kept the render's low sky at saturation 0.5-0.6 where the
    // reference sits at 0.44.
    float horizonFade = smoothstep(-0.02, 0.57, rd.y);
    float skyLuma = dot(skyColor, vec3(0.2126, 0.7152, 0.0722));
    skyColor = mix(vec3(skyLuma), skyColor, mix(1.0, SKY_SATURATION, horizonFade));

    // --- Dusk ---------------------------------------------------------
    //
    // Everything above is fitted, at RMSE 3.1, against a *midday* reference.
    // The moment the sun drops it is extrapolating, and measuring what it
    // extrapolated to showed how far off it was: at 18:36 the rendered sky
    // still ran luminance 107 at the top of the frame and 173 near the horizon,
    // against 181 at noon. The sun had all but set and the sky had given up
    // eight levels.
    //
    // So dusk gets its own target, measured off an evening reference the user
    // supplied (Screenshot_20260813-045658.png; scripts/duskref.js does the
    // measuring). The numbers below are that image's own sky, sampled in twelve
    // bands from the top of the frame down, converted from sRGB into the linear
    // HDR this shader works in (scripts/hdr.js) and normalised to luminance 1
    // so they carry hue only:
    //
    //   band          measured sRGB   luminance  linear chroma
    //   top            15, 43, 57         38     0.43, 1.11, 1.58   deep teal
    //   upper          34, 92,125         82     0.35, 1.11, 1.84   blue
    //   lower         101,105,149        107     0.89, 0.95, 1.83   blue-violet
    //   horizon       123, 65, 79         78     1.95, 0.72, 0.95   dusty rose
    //
    // The top being *teal* rather than blue is the thing this was most wrong
    // about, and it is not an artistic liberty: at that hour the light reaching
    // the upper sky has crossed enough ozone for the Chappuis band to take a
    // bite out of the orange, which is what turns a twilight zenith green-blue.
    // This shader has no ozone term, so the colour is supplied directly.
    //
    // Gated by uDusk, which is 0 in full day — the midday fit is untouched.
    if (uDusk > 0.001) {
      vec3 chroma = vec3(1.954, 0.722, 0.948);
      chroma = mix(chroma, vec3(0.889, 0.949, 1.830), smoothstep(-0.02, 0.11, rd.y));
      chroma = mix(chroma, vec3(0.351, 1.108, 1.842), smoothstep(0.11, 0.30, rd.y));
      chroma = mix(chroma, vec3(0.428, 1.111, 1.583), smoothstep(0.30, 0.55, rd.y));

      // Warm again toward the sun itself, which the elevation ramp alone cannot
      // know about — the reference's glow is around the sun, not merely low.
      float toSun = max(dot(rd, sunDir), 0.0);
      chroma = mix(chroma, vec3(1.954, 0.722, 0.948), pow(toSun, 6.0) * 0.8);

      // And far darker. The reference's sky runs luminance 38 at the top and
      // 78-107 low down, roughly a third of what this shader was producing.
      float duskLuma = dot(skyColor, vec3(0.2126, 0.7152, 0.0722));
      skyColor = mix(skyColor, chroma * duskLuma * 0.42, uDusk);
    }

    gl_FragColor = vec4(max(skyColor, 0.0), 1.0);
  }
`;

export function createSky(): SkyHandle {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCameraInverseProjection: { value: new THREE.Matrix4() },
      uCameraWorldMatrix: { value: new THREE.Matrix4() },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uDusk: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, material };
}

export function updateSky(
  handle: SkyHandle,
  camera: THREE.PerspectiveCamera,
  sunDir: THREE.Vector3,
  dusk = 0,
): void {
  handle.material.uniforms.uDusk.value = dusk;
  handle.material.uniforms.uCameraInverseProjection.value.copy(camera.projectionMatrixInverse);
  handle.material.uniforms.uCameraWorldMatrix.value.copy(camera.matrixWorld);
  handle.material.uniforms.uSunDirection.value.copy(sunDir);
}
