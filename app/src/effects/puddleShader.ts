import * as THREE from 'three';
import { MAX_RINGS, RING_LIFE } from '../scene/ripples';

/**
 * The water: the last pass, and the one this app is.
 *
 * It stands where effects/plateShader.ts stands in the window app — dead last,
 * after OutputPass, Kuwahara and macro-contrast, compositing a photograph over
 * the rendered sky in display space — and for the same reason. Those filters
 * exist to push a 3D render toward illustration, and the photograph is already
 * an image; running them over it would only soften it. Everything the water
 * does happens *inside the key*, so the asphalt, the pole, the wires and the
 * girl are passed through untouched, bit for bit.
 *
 * What is different is what fills the key. A window is a hole with sky behind
 * it, so the plate shader's whole job was one `mix`. Water is a mirror lying on
 * the ground, and a mirror lying on the ground has four properties the hole did
 * not:
 *
 * **1. It is upside down.** The far lip of the puddle images the horizon and
 * your own feet image the zenith. The 3D camera is aimed nearly straight up
 * (scene/puddle.ts) so the render *is* the reflected hemisphere, and the
 * mapping below reads it from the vanishing line downward.
 *
 * **2. It is in perspective.** The reflection is not a flip — a flip would put
 * the horizon a fixed number of rows from the lip everywhere and make a ripple
 * ring a circle. The water is a ground plane, so the shader converts every
 * pixel to plane coordinates (`ground()`, z ∝ 1/(vanishing line − v)) and does
 * all of its wave arithmetic there. Rings come back as ellipses that shorten
 * toward the lip and chop comes back finer with distance, because that is what
 * the projection does to them, not because either was drawn that way.
 *
 * **3. It moves.** The surface has a slope, and a sloped mirror looks somewhere
 * slightly different: the reflection is displaced along the gradient of the
 * height field. This is the only mechanism in the pass. The rings a footfall
 * makes and the rings the rain makes are the same term with different lifetimes
 * — nothing is drawn *on* the water, the sky in it is simply moved.
 *
 * **4. It catches the sun.** Those same slopes turn a smooth mirror into a
 * thousand small ones, most pointing nowhere and a few pointing at the sun.
 * That is the glitter (`glint`), and it is derived from the gradient the
 * displacement already needed rather than added as a texture, so a still puddle
 * has none, a footfall throws a burst of it, and rain fills the whole surface
 * with it. 光を編む.
 *
 * Both assets are optional. With no photograph and no key the pass keys its own
 * puddle across the bottom of the frame (`FALLBACK` below), so the water, the
 * ripples and the light are all still there to look at — the photograph is what
 * makes it *that* street, not what makes it work.
 */
export const PuddleShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** The reference photograph, full frame. */
    tRef: { value: null as THREE.Texture | null },
    /**
     * The key: the same photograph with the water painted out in magenta.
     *
     * Magenta rather than white, and read as a *colour distance* rather than a
     * threshold, because the things lying on top of the water in the reference
     * — the power lines, the pole, the reflected house, the girl — are drawn
     * over the paint and have to survive. A luminance key cannot tell a dark
     * wire on magenta from a dark wire on sky. Anything that is not magenta is
     * not water, whatever its brightness, so the wires come back for free and
     * at their own antialiased edges rather than as a hand-cut polygon.
     */
    tMask: { value: null as THREE.Texture | null },
    /** 0 while the two assets have not arrived — see FALLBACK. */
    uHasAssets: { value: 0 },
    /** xy = uv origin, zw = uv size, of the visible sub-rect (core/frame.ts). */
    uPlateRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    /** Screen v of the water's vanishing line (scene/puddle.ts). */
    uHorizonV: { value: 0.82 },
    /** Screen v the *rendered* horizon sits at, i.e. where the reflection's
     * far end reads from. */
    uSkyHorizonV: { value: 0.02 },
    uAspect: { value: 1408 / 768 },
    uGroundScale: { value: 1 },
    /** The water's own clock, in real seconds — a ripple is not weather, so it
     * does not run on the speed slider. Same reasoning as the rain's clock in
     * effects/rainShader.ts. */
    uTime: { value: 0 },
    /** How hard the surface is displaced, 0-1 (the WATER slider). */
    uWind: { value: 0.5 },
    /** 0-1, the same slider the sky rain is on: rain on water is rings. */
    uRain: { value: 0 },
    /** How much glitter the slopes throw (the LIGHT slider). */
    uWeave: { value: 0.5 },
    /** xy = ring uv, z = birth time on uTime's clock, w = strength. */
    uRings: {
      value: Array.from({ length: MAX_RINGS }, () => new THREE.Vector4(0, 0, -1e4, 0)),
    },
    uRingCount: { value: 0 },
    /** Colour of the light the glints are made of — the sun's own tint at this
     * hour (core/daylight.ts), so an evening puddle glitters gold. */
    uSunTint: { value: new THREE.Vector3(1, 1, 1) },
    /** Illuminant for the photograph, which was taken once and cannot relight
     * itself. White at noon, exactly as in the window app's plate. */
    uDayTint: { value: new THREE.Vector3(1, 1, 1) },
    /** Linear-light exposure for the photograph when it rains, 1 when dry. */
    uRainExposure: { value: 1 },
    /**
     * What the water is over: wet asphalt, in display sRGB.
     *
     * Never seen on its own. A mirror at a grazing angle is very nearly total,
     * so the far half of the puddle is pure sky; it is only underfoot, where you
     * are looking almost straight down into it, that any of the road comes
     * through. Measured off the reference's own asphalt in shadow.
     */
    uBedColour: { value: new THREE.Vector3(0.075, 0.086, 0.106) },
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
    uniform sampler2D tRef;
    uniform sampler2D tMask;
    uniform float uHasAssets;
    uniform vec4 uPlateRect;
    uniform float uHorizonV;
    uniform float uSkyHorizonV;
    uniform float uAspect;
    uniform float uGroundScale;
    uniform float uTime;
    uniform float uWind;
    uniform float uRain;
    uniform float uWeave;
    uniform vec4 uRings[${MAX_RINGS}];
    uniform int uRingCount;
    uniform vec3 uSunTint;
    uniform vec3 uDayTint;
    uniform float uRainExposure;
    uniform vec3 uBedColour;
    varying vec2 vUv;

    const float RING_LIFE = ${RING_LIFE.toFixed(1)};
    /** Metres per second a ring travels outward. Real capillary-gravity rings
     * on a shallow puddle run about this; it is also, conveniently, slow enough
     * to watch and fast enough to have left by the time you press again. */
    const float RING_SPEED = 0.62;
    /** Rings per metre in the wake, and how fast the wake dies behind the
     * crest. Together these are what makes a footfall read as three or four
     * rings rather than as one expanding line. */
    const float RING_FREQ = 34.0;
    const float RING_TAIL = 7.0;

    /**
     * Screen point -> the ground plane the water lies in.
     *
     * z is the distance out along the plane, x the offset across it, both in
     * the shader's rough metres (uGroundScale). The 1/(vanishing − v) is
     * ordinary perspective inverted: a plane's projection compresses distance
     * toward its vanishing line, so undoing that is a reciprocal, and every
     * wave written in these coordinates gets the compression back for free
     * when it lands on screen.
     *
     * Clamped a little below the line rather than at it, because at the line
     * itself z is infinite and every wave term collapses into aliasing.
     */
    vec2 ground(vec2 uv) {
      float dy = max(uHorizonV - uv.y, 0.0035);
      float z = uGroundScale / dy;
      return vec2((uv.x - 0.5) * uAspect * z, z);
    }

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    vec2 hash22(vec2 p) {
      return vec2(hash21(p), hash21(p + 19.19));
    }

    /**
     * The rain's rings.
     *
     * Procedural and anonymous, unlike the pressed ones: a cell grid on the
     * ground plane, one drop per cell per period, the period falling as the
     * rain rises so a downpour is a surface with no flat water left in it. The
     * cells are in *ground* coordinates, so the density on screen thins toward
     * the far lip exactly as it should — a fixed screen-space grid was the
     * first version and it put as many rings on the two metres by the far lip
     * as on the whole foreground.
     *
     * Costs nine cells per height sample, so it is gated off entirely while it
     * is dry, which is the frame every other statistic here was measured on.
     */
    float rainRings(vec2 g, float t) {
      if (uRain < 0.004) return 0.0;
      float cells = 1.7;
      vec2 c0 = floor(g * cells);
      float period = mix(2.2, 0.42, uRain);
      float sum = 0.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 c = c0 + vec2(float(i), float(j));
          vec2 r = hash22(c);
          vec2 centre = (c + 0.25 + r * 0.5) / cells;
          float age = mod(t + r.x * period * 6.0, period);
          float d = length(g - centre);
          float radius = age * RING_SPEED * 0.8;
          float wave = sin((d - radius) * 26.0)
            * exp(-abs(d - radius) * 9.0)
            * exp(-age * 2.4);
          sum += wave;
        }
      }
      return sum * 0.22 * uRain;
    }

    /** The wind chop: three crossing trains, none of them commensurate, so the
     * surface never repeats inside the time anyone watches it.
     *
     * 'fine' fades the two short trains out with distance and is not a taste
     * decision. In ground coordinates the chop has a fixed wavelength, so its
     * *screen* wavelength falls with distance and somewhere short of the
     * vanishing line it goes under a pixel — past which sampling it does not
     * draw small waves, it draws noise, and the reflected cloud is shredded
     * into grain exactly where it should be smoothest. A feature finer than the
     * sample has to fade to its own mean, which is what a mip level is and what
     * this is. Real distant water behaves the same way for the same reason: at
     * fifty metres a chopped surface is a sheen, not a texture.
     */
    float chop(vec2 g, float t, float fine) {
      float h = sin(g.y * 2.9 + g.x * 0.7 + t * 1.5) * 0.55;
      h += sin(g.y * 5.3 - g.x * 2.1 - t * 2.2) * 0.30 * fine;
      h += sin(g.x * 8.7 + g.y * 1.7 + t * 3.3) * 0.15 * fine * fine;
      return h;
    }

    /** The whole surface, as one height. Everything that ever moves the sky in
     * this app is a term of this function. */
    float surface(vec2 g, float t, float fine) {
      float h = chop(g, t, fine) * uWind;
      h += rainRings(g, t);
      for (int i = 0; i < ${MAX_RINGS}; i++) {
        if (i >= uRingCount) break;
        vec4 ring = uRings[i];
        if (ring.w <= 0.0) continue;
        float age = t - ring.z;
        if (age < 0.0 || age > RING_LIFE) continue;
        float d = length(g - ground(ring.xy));
        float radius = age * RING_SPEED;
        // Ahead of the crest there is nothing yet — a ring that rang inside its
        // own radius before it arrived was the first version's tell, and it made
        // every footfall look like a stone already in the water.
        float wake = exp(-max(d - radius, 0.0) * 40.0) * exp(-max(radius - d, 0.0) * RING_TAIL);
        h += sin((d - radius) * RING_FREQ) * wake * exp(-age) * ring.w * 0.9;
      }
      return h;
    }

    void main() {
      vec2 uv = vUv;
      vec2 refUv = uPlateRect.xy + uv * uPlateRect.zw;

      // The key. Magenta distance, not luminance — see tMask above. The photo's
      // own paint is (1,0,1), so "both ends up, the middle down" isolates it
      // from every grey and every sky blue in the frame, and the wires drawn
      // over it come back at their own soft edges.
      float key;
      if (uHasAssets > 0.5) {
        vec3 m = texture2D(tMask, refUv).rgb;
        key = smoothstep(0.35, 0.72, min(m.r, m.b) - m.g);
      } else {
        // FALLBACK: no photograph, no key. Everything below the vanishing line
        // is water, with the edge broken up so it is a puddle rather than a
        // horizon. The app is fully itself in this state apart from the street.
        float edge = uHorizonV - 0.035 + 0.02 * sin(uv.x * 9.0) + 0.012 * sin(uv.x * 23.0 + 1.7);
        key = smoothstep(edge + 0.012, edge - 0.012, uv.y);
      }

      // The photograph, relit for the hour and dimmed by the rain exactly as the
      // window app's plate is: this street has no light of its own either.
      vec3 painted = texture2D(tRef, refUv).rgb * uDayTint;
      if (uRainExposure < 1.0) {
        painted = pow(max(pow(max(painted, 0.0), vec3(2.2)) * uRainExposure, 0.0), vec3(1.0 / 2.2));
      }
      if (uHasAssets < 0.5) painted = uBedColour;

      if (key < 0.002) {
        gl_FragColor = vec4(painted, 1.0);
        return;
      }

      // How far down into the water this pixel is looking: 0 at the vanishing
      // line, 1 at the viewer's feet. This is the reflection's only coordinate,
      // and it is also what says how much detail the surface may carry here.
      float depth = clamp((uHorizonV - uv.y) / max(uHorizonV, 0.001), 0.0, 1.0);

      // The surface, and its slope. Forward differences over one texel of uv
      // rather than an analytic derivative: the height is a sum of a dozen
      // terms including a nine-cell loop, and differencing it costs two more
      // evaluations against differentiating it by hand costing every term
      // twice and going stale the first time one of them changes.
      float t = uTime;
      vec2 g = ground(uv);
      // How much of the surface's detail this row can carry, from the same
      // reasoning as chop()'s: 0 at the vanishing line, 1 once a wavelength is
      // several pixels across. The three samples share one value on purpose —
      // they are a derivative, and a derivative taken across a changing filter
      // width measures the filter rather than the surface.
      float fine = smoothstep(0.0, 0.30, depth);
      float h = surface(g, t, fine);
      float e = 0.0016;
      float hx = surface(ground(uv + vec2(e, 0.0)), t, fine);
      float hy = surface(ground(uv + vec2(0.0, e)), t, fine);
      vec2 slope = vec2(hx - h, hy - h) / e;

      // The displacement, and the two factors that shape it are opposites.
      //
      // (1 − depth) rises toward the far lip, because a slope of a given angle
      // swings the reflected ray through a much larger patch of *screen* at a
      // grazing angle than it does underfoot — the same reason a breath of wind
      // wrecks a distant reflection while the one at your feet stays legible.
      // 'fine' falls to zero there, because that is also where the waves doing
      // the swinging stop being resolvable. Their product peaks in the upper
      // third of the water and goes quietly to nothing at the lip, which is
      // where the reflected cloud has to be readable as cloud — the first
      // version had only the first factor and shredded it.
      //
      // Clamped as well, because the far lip's ground coordinates run to
      // infinity and an unclamped slope there samples the whole sky at once.
      vec2 push = slope * 0.0013 * fine * (0.25 + 0.75 * (1.0 - depth));
      push = clamp(push, vec2(-0.035), vec2(0.035));

      // The mirror. The rendered frame is the reflected hemisphere already
      // (scene/puddle.ts aims the camera up), so this is a remap of the water's
      // depth onto the render's own horizon-to-zenith span, not a flip.
      vec2 skyUv = vec2(uv.x, mix(uSkyHorizonV, 1.0, depth)) + push;
      skyUv = clamp(skyUv, vec2(0.001), vec2(0.999));
      vec3 sky = texture2D(tDiffuse, skyUv).rgb;

      // Fresnel, the honest way round: grazing is a total mirror, straight down
      // is not. Only the last stretch underfoot lets any road through, which is
      // why the reference's puddle is the most saturated blue in its frame.
      float mirror = mix(1.0, 0.72, smoothstep(0.35, 1.0, depth));
      vec3 water = mix(uBedColour, sky, mirror);

      // The glitter. A slope pointing at the sun returns it; the surface normal
      // is (−slope, 1) and the light is a fixed high bearing, so this is one
      // dot product over the gradient the displacement already computed. It
      // costs nothing extra and it cannot disagree with the ripples, because it
      // *is* the ripples.
      vec3 n = normalize(vec3(-slope.x * 0.012, 1.0, -slope.y * 0.012));
      vec3 lightDir = normalize(vec3(-0.42, 0.68, -0.60));
      float spec = pow(max(dot(n, lightDir), 0.0), 220.0);
      // Broken up, so it reads as separate points of light rather than as a
      // varnish over the whole surface. The hash rides the ground plane, so the
      // grain gets finer with distance like everything else here.
      float grain = 0.55 + 0.45 * hash21(floor(g * 26.0) + floor(t * 9.0) * 0.017);
      float glint = spec * grain * fine * (0.35 + 1.65 * uWeave);
      // And the surface's own energy: a footfall's crest and a rain-struck
      // patch both carry more slope than flat water, so the light gathers where
      // something is happening to the water. 光を編む.
      glint *= 0.4 + 1.6 * min(abs(h), 1.0);

      water += uSunTint * glint * 0.9;

      gl_FragColor = vec4(mix(painted, water, key), 1.0);
    }
  `,
};
