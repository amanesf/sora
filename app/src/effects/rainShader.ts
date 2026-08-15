import * as THREE from 'three';

/**
 * Rain, drawn over the rendered sky only.
 *
 * The masking is structural rather than written: this pass runs *immediately
 * before* effects/plateShader.ts, so the painted illustration — the room, the
 * window frames, the town, the girl — is composited on top of it afterwards.
 * The only pixels that survive are the ones the plate leaves transparent, which
 * are exactly the pixels where you are looking through the glass at the sky.
 * Rain therefore falls outside the window and nowhere else, with no mask to
 * keep in sync and no way for it to end up indoors.
 *
 * (The painted town along the bottom of the glass stays dry, which is the one
 * place this cheats. It is a narrow, busy strip and the alternative — keying
 * rain onto painted geometry — would mean inventing depth for an illustration.)
 *
 * Two things happen here, and the darkening matters more than the streaks:
 *
 *  - The light goes out of everything. Rain does not read as rain because you
 *    can see the drops; it reads as rain because the light goes. A frame full
 *    of streaks over a bright summer sky looks like a scratched film print.
 *  - Streaks. Deliberately sparse, fast and low-contrast: individually almost
 *    invisible, collectively a texture. Three layers at three depths, the near
 *    one faster, longer and more transparent, which is what gives the
 *    impression of falling *through* a volume rather than of a pattern sliding
 *    down the glass.
 *
 * **How the light is taken out is the whole picture, and the first version got
 * it wrong in a way no amount of streak-tuning could repair.** It mixed every
 * pixel 82% of the way to one constant colour, which is a description of fog on
 * the *lens*, not weather in the scene. Measured over the sky (plate.webp's
 * alpha as the mask, cloud=100%, 12:00) that collapsed the frame:
 *
 *     rain=0   luminance sd 48.2   p1-p99 169   local |grad| 6.87
 *     rain=1   luminance sd 11.8   p1-p99  47   local |grad| 1.60
 *
 * 48.2 x 0.18 = 8.7, so essentially the entire loss was the mix — and the three
 * streak sheets and the curtains together were adding back only about 3 levels
 * of spread. Everything expensive in this project (the measured colour ramp,
 * the self-shadowing, Kuwahara, the macro-contrast pass) was being averaged
 * away, and what was left was neither dark nor bright: one mid-value field.
 *
 * So the darkening is now an **exposure cut**, not a blend. Multiplying in
 * linear light scales the scene instead of replacing it, so every ratio in the
 * cloud modelling survives intact and the picture gets *darker* rather than
 * flatter. Only a small aerial-perspective term actually replaces colour, and
 * it varies with height because a rain sky does: the reference runs #11315b at
 * the top through #2c6e89 to #233a62 low down, and spending that on a single
 * constant threw away the strongest depth cue a sky has.
 *
 * Streak time is uRainTime, which is *not* the scene's simTime: see the uniform
 * below. `?t=` still fixes it, so scripts/capture.js stays reproducible.
 */
export const RainShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 0 = dry (the pass is skipped entirely at 0, see core/postFx.ts). */
    uRain: { value: 0 },
    /**
     * The clock the *drops* fall on, in seconds — deliberately not simTime.
     *
     * Everything else in this scene is a pure function of simTime, which the
     * speed slider runs at 1-30x so that a tower's ten-minute life can be
     * watched in under a minute. Rain cannot share that clock. What the slider
     * is speeding up is the weather *changing*, and a raindrop is not weather
     * changing — it is an object falling at its own terminal velocity, which
     * does not care how fast you are watching the sky evolve. Driven off
     * simTime the drops ran at 10x by default and 30x at the top, which is not
     * "fast rain", it is a different phenomenon.
     *
     * core/main.ts advances this in real seconds and pins it to `?t=` when the
     * scene is frozen, so scripts/capture.js still gets the same frame twice.
     */
    uRainTime: { value: 0 },
    uAspect: { value: 1 },
    /**
     * Screen v of the painted horizon, from the same per-scene measurement that
     * hangs the horizon haze band (core/postFx.ts's applyFrame).
     *
     * Rain needs it because rain has depth and the frame's depth axis is the
     * distance from this line. Everything the streaks do about perspective —
     * how long they are, how tightly packed, which way they lean — is measured
     * from here, so the three scenes get it right despite their horizons
     * sitting 155 frame rows apart.
     */
    uHorizonV: { value: 0.23 },
    /**
     * The render buffer's size in pixels, so the drops can be specified in the
     * units they are actually made of.
     *
     * The old sheets stated their geometry in fractions of a cell, which is a
     * unit with no relation to anything physical, and that is how the streaks
     * ended up 5-18 times longer than the distance the drop they represent
     * moves in a frame. Length, width and spacing are all in pixels now, and
     * every one of them is derived rather than dialled.
     */
    uFrameSize: { value: new THREE.Vector2(1408, 768) },
    /**
     * The exposure time of one frame, in seconds — 1/60 or 1/30, whichever the
     * frame-rate control is on (ui/controls.ts).
     *
     * This is the single number that was missing, and everything wrong with the
     * streaks followed from its absence. A motion-blurred streak's length is not
     * a free parameter: it is exactly how far the object travelled while the
     * shutter was open. Stating a fall speed and a length independently — which
     * is what the sheets did — describes an object moving at one speed and
     * smeared as though it moved at another, and the eye reads the contradiction
     * immediately, because the mark it is being shown does not move anything
     * like as far per frame as its own length.
     *
     * Measured on the old version: 1/60 s apart, only 0.59% of the frame's
     * pixels changed, and the change was confined to 7-30px at the ends of each
     * streak. A long bar sliding along its own axis changes nothing except its
     * two tips, so the rain was, frame to frame, almost entirely stationary.
     *
     * Carrying it as a uniform also gets the frame rate right for free: at 30fps
     * the shutter is twice as long, so the streaks are twice as long, which is
     * what a camera does.
     */
    uShutter: { value: 1 / 30 },
    /**
     * The ambient sky — the light a drop is actually sitting in, in the same
     * display space this pass works in and already scaled for the rain's own
     * exposure cut (core/postFx.ts feeds the same value to effects/nearRain.ts).
     *
     * Sampling the buffer a few percent above each drop, which is what this did
     * on its own, answers a different question: it finds the local sky, and
     * under a storm deck the local sky is the same murk the drop is being drawn
     * against, so the drop comes out exactly the colour of its background and
     * vanishes. Measured on the first build of the new layers, the mid streaks
     * were invisible in the open sky for precisely this reason — the frame
     * showed only the far points, and the rain read as dust on the lens.
     *
     * A drop images most of the hemisphere, not the patch directly above it, so
     * the honest quantity is the ambient: dominated by the brightest parts of
     * the sky wherever the drop happens to be. That is also why real rain is
     * visible at all against a dark sky.
     */
    uSkyColor: { value: new THREE.Vector3(0.66, 0.78, 0.86) },
    /**
     * What the rain's aerial perspective washes toward, in display-space sRGB —
     * this pass runs after OutputPass, on tonemapped pixels.
     *
     * Measured across a rain-sky reference (Screenshot_20260813-053823.png,
     * scripts/duskref.js) the sky runs #11315b at the top through #2c6e89 in
     * the middle to #233a62 low down — luminance 45-98 and **saturation
     * 0.64-0.86**. A rained-out sky is not desaturated, it is dark and deeply
     * blue. Grey is what you get by assuming "no sun" means "no colour", and it
     * is the difference between weather and a dead monitor.
     *
     * All three bands are here now. The first version measured all three and
     * then used only the middle one, which pinned the whole sky to one value
     * and cost it the top-to-bottom gradient — measured, the twelve elevation
     * bands over the window went from 163/147/163/149/129/134/134/124/164/189
     * dry to 96/94/96/94/91/94/96/98/108/108 in the rain. That is not a sky in
     * bad weather, that is a wall.
     */
    uRainColor: { value: new THREE.Vector3(0.173, 0.431, 0.537) },
    /** #11315b, the top band — the deck's own base, seen nearly overhead. */
    uRainHigh: { value: new THREE.Vector3(0.067, 0.192, 0.357) },
    /** #233a62, low down, where the long sight lines run out into the murk. */
    uRainLow: { value: new THREE.Vector3(0.137, 0.227, 0.384) },
    /**
     * Linear-light exposure at full rain. 0.32 is about a stop and a half down,
     * which lands the sky's mean luminance near 86 against the reference's
     * 45-98 band — where the old constant-mix left it at 96.7 *and* flat.
     */
    uExposure: { value: 0.32 },
    /**
     * A little contrast back on top of the exposure cut, about the darkened
     * mid. A storm sky is not a low-contrast subject: the base of the deck and
     * the breaks in it are further apart than a fair-weather sky's cloud and
     * blue, not closer. Small, because the exposure cut has already done the
     * work the old blend was destroying.
     */
    uContrast: { value: 1.15 },
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
    uniform float uRain;
    uniform float uRainTime;
    uniform float uAspect;
    uniform float uHorizonV;
    uniform vec2 uFrameSize;
    uniform float uShutter;
    uniform vec3 uSkyColor;
    uniform vec3 uRainColor;
    uniform vec3 uRainHigh;
    uniform vec3 uRainLow;
    uniform float uExposure;
    uniform float uContrast;
    varying vec2 vUv;

    // Smooth 2D value noise, for the curtains below.
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float vnoise2(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
        mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x),
        f.y);
    }

    /**
     * Where this pixel sits on the frame's depth axis: 0 at the horizon, 1 for
     * the near rain high in frame.
     *
     * The old pass had no such notion. Every streak in it was the same length,
     * the same width and the same distance apart whether it was drawn a degree
     * above the sea or straight overhead, which is a description of a texture
     * pasted on the glass rather than of a volume of falling water. A volume of
     * rain seen from inside it is the most strongly perspective-distorted thing
     * in any weather photograph: the drops near the horizon are kilometres away
     * and subtend almost nothing, so they crowd into a fine dense grain, while
     * the ones overhead are tens of metres away and cross the whole frame.
     *
     * Not linear in v, because depth is not linear in v — it goes as roughly
     * 1/(v - horizon) for a level rain volume. smoothstep over the first 0.62
     * of the frame above the horizon is a cheap stand-in with the right shape:
     * nearly all of the change happens in the band just above the horizon,
     * which is exactly where nearly all of the distance is.
     */
    float perspAt(float v) {
      return mix(0.16, 1.0, smoothstep(uHorizonV, uHorizonV + 0.62, v));
    }

    /**
     * How hard it is raining *right now, right here* — the gust structure.
     *
     * uRain is a slider position, and until this existed the slider position was
     * also the instantaneous intensity: the rain fell at precisely the same rate
     * for as long as you watched it. That is the single most reliable tell that
     * a rain effect is a shader rather than weather, and no amount of per-drop
     * variation addresses it, because the thing that is constant is not any
     * drop, it is the *field*.
     *
     * Real rain is gusty at two scales at once, and both are here:
     *
     *  - A slow global swell, tens of seconds long: the whole sky leans into it
     *    and eases off. This is what makes the light breathe.
     *  - A front crossing the frame, sampled in (x - ct): a band of harder rain
     *    travelling with the wind, so the left of the picture gets it before the
     *    right does. This is the one that reads as *weather passing through*
     *    rather than as an intensity knob being turned.
     *
     * A pure function of uRainTime and x, so ?t= still pins it and
     * scripts/capture.js still gets the same frame twice. The mean is held near
     * 0.95 rather than 1.0 so that the top of the slider can still gust *up*:
     * a squall that only ever subtracts reads as the effect faltering.
     */
    float gustAt(float x) {
      float swell = vnoise2(vec2(uRainTime * 0.055, 3.7));
      float front = vnoise2(vec2(x * 0.85 - uRainTime * 0.031, 11.0));
      // The front is the larger of the two: it is the one carrying the
      // structure, and the swell only modulates it.
      return mix(0.60, 1.30, 0.42 * swell + 0.58 * front);
    }

    /**
     * How much cloud is overhead of this pixel — read back off the picture
     * itself, a few sample steps up the frame.
     *
     * Rain falls out of cloud bases. The curtains below were built from noise in
     * screen space and hung wherever that noise happened to be strong, so they
     * appeared under open blue as readily as under the deck, and drifted at a
     * rate unrelated to the clouds they were supposedly falling from. That is
     * the specific reason they read as smears on the picture rather than as
     * shafts in the sky: a shaft whose top does not meet a cloud has no cause.
     *
     * This is deliberately not a mask rendered from the cloud field. The buffer
     * at this point already *is* the sky with the clouds in it, and cloud is
     * separable from sky in it by inspection: cloud is bright and weakly
     * saturated, the sky behind it is deeper and strongly blue. Four taps up the
     * column is a coarse instrument, but it is coarse in the right direction —
     * a curtain is a kilometres-wide object and does not need to know which lobe
     * it came from.
     *
     * It does over-report in the last few degrees above the horizon, where
     * effects/horizonHaze.ts has already washed everything toward a pale band
     * that measures as cloud. That is a real limitation and it is benign: the
     * horizon is where distant rain belongs anyway.
     */
    // Cloud or sky, from one pixel: cloud is bright and weakly saturated, the
    // sky behind it is deeper and strongly blue.
    float cloudiness(vec3 c) {
      float mx = max(max(c.r, c.g), c.b);
      float mn = min(min(c.r, c.g), c.b);
      float sat = (mx - mn) / max(mx, 1e-4);
      return smoothstep(0.30, 0.62, mx) * smoothstep(0.58, 0.24, sat);
    }

    float cloudAbove(vec2 uv) {
      float sum = 0.0;
      for (int i = 1; i <= 4; i++) {
        sum += cloudiness(texture2D(tDiffuse, vec2(uv.x, min(uv.y + float(i) * 0.05, 0.998))).rgb);
      }
      return sum * 0.25;
    }

    /**
     * Rain seen from a distance: 雨脚, the pale curtains that hang out of a
     * cloud base and drift with it.
     *
     * Individual streaks are the wrong model for anything more than a few
     * hundred metres away. Past that you cannot resolve a drop, and what you
     * actually see is a translucent grey-white veil — the aggregate of a great
     * many of them scattering light back at you. Drawing only streaks is why
     * the first version read as rain on the glass with a clear view behind it,
     * rather than as weather filling the distance.
     *
     * Built from noise stretched hard along y so it forms vertical shafts, at
     * two scales, drifting downward slowly (a curtain falls far more slowly
     * than a drop does, because it is a shape rather than an object).
     */
    float curtain(vec2 uv) {
      // Drifts sideways as well as down now. A shaft hangs from a cloud and
      // goes where the cloud goes, so it crosses the frame with the wind; the
      // old version only slid downward, which is a waterfall, not weather.
      float drift = uRainTime * 0.014;
      vec2 p = vec2(uv.x * 3.2 - drift, uv.y * 0.55 - uRainTime * 0.02);
      float v = vnoise2(p) * 0.55 + vnoise2(p * 2.4 + 11.0) * 0.3 + vnoise2(p * 5.1 + 31.0) * 0.15;
      // Fine vertical striation riding on top, so a shaft has fall lines in it.
      v += (vnoise2(vec2(uv.x * 46.0 - drift * 14.0, uv.y * 2.2 - uRainTime * 0.05)) - 0.5) * 0.16;
      return v;
    }

    /**
     * The showers as *cells* rather than as one continuous veil.
     *
     * Rain is not evenly spread across a sky even in a downpour — it comes in
     * patches kilometres wide, so at any moment part of the view is under a
     * heavy shaft and part of it is merely wet. Drawing one uniform veil across
     * the whole frame is what made the far rain read as a filter layer: a filter
     * is the only thing in nature that is equally strong everywhere.
     *
     * Very low frequency (about two cells across the frame) and drifting with
     * the same wind as the curtains above, so a cell arrives, crosses and
     * leaves. The floor is 0.35 rather than 0 because the gaps between showers
     * in heavy rain are gaps in the *heaviness*, not in the rain.
     */
    float showerCell(vec2 uv) {
      float n = vnoise2(vec2(uv.x * 1.9 - uRainTime * 0.024, uv.y * 0.8 + 5.0));
      return mix(0.35, 1.35, n);
    }

    /**
     * One layer of the rain, at one distance.
     *
     * The frame is cut into cells; each cell holds at most one drop, its column
     * offset and fall phase hashed from the cell so the pattern never tiles
     * visibly. That much survives from the old sheets. Everything else about a
     * drop is now *derived from where it is*, and that is the whole rewrite.
     *
     * **The geometry, in the units it is actually made of.** The camera is 50
     * degrees vertical over 768 buffer rows, so one pixel is 0.065 degrees. A
     * drop falls at about 9 m/s, so in a 1/60 s exposure it travels 0.15 m,
     * which subtends 132/d pixels at d metres. A 2 mm drop is 1.76/d pixels
     * wide. That gives, for the three distances this draws:
     *
     *     d = 3.5m   streak 38px   width 0.50px   crosses the frame in 0.36s
     *     d = 12m    streak 11px   width 0.15px   crosses in 1.24s
     *     d = 40m    streak  3px   width 0.04px   crosses in 4.1s
     *
     * Three things fall straight out of that table, and all three were wrong
     * before:
     *
     *  - **Rain is mostly not lines.** At any distance past about ten metres a
     *    drop is a point, not a streak. The far layer here is drawn by the same
     *    function as the near one and comes out as a field of points purely
     *    because it is slow — no separate code path, and no decision to make.
     *  - **Drops are thinner than a pixel.** Nothing can be drawn thinner than
     *    one, so the width is held near 1px and the drop's real sub-pixel width
     *    is paid back as transparency instead. A 3px-wide opaque mark is not a
     *    raindrop at any distance; it is a scratch.
     *  - **Short means bright.** The same drop's light spread over a tenth of
     *    the path is ten times the brightness per pixel, so shortening the
     *    streaks and brightening them is one change, not two. (Lengthening them
     *    and brightening them, which is what tuning by eye tends toward, is not
     *    physical at all.)
     *
     * **The angle is one angle.** The old version rolled a random lean per
     * column, on the reasoning that rain is thousands of independent objects
     * that agree about nothing. They agree about this: they are all in the same
     * wind. Independently tilted marks are a description of scratches — damage
     * arrives one stroke at a time — and the only thing that should bend a
     * streak away from the wind is perspective, which is the radial term below.
     *
     * Returns ink in x and sparkle in y; see the sparkle note further down.
     */
    vec2 dropLayer(vec2 uv, float spacingPx, float cellPx, float crossSec,
                   float widthPx, float density, float seed) {
      // Distance still compresses everything toward the horizon, on top of the
      // layer's own nominal distance: the volume runs away from the viewer, so
      // the same layer is further off low in the frame than it is overhead.
      //
      // **What perspective may not touch is the cell grid, and that is not a
      // style rule, it is arithmetic.** The fall offset is uRainTime times a
      // speed, which reaches millions of pixels; the cell index is that divided
      // by the cell height. Differentiate it: a cell height that varies with
      // screen position moves the index by (offset / cell^2) per pixel, which at
      // these magnitudes is *tens of cells per pixel*. Every pixel then lands in
      // a different randomly-seeded cell and the layer degenerates into white
      // noise — which is exactly what happened. The field came out as
      // single-pixel speckle, no streak could form at any length, and the
      // lengths were retuned three times chasing something that was never about
      // length.
      //
      // So the grid is fixed per layer, and perspective is applied to the things
      // computed *inside* a cell: how long the mark is, how wide, and how likely
      // the cell is to hold one at all.
      float persp = perspAt(uv.y);
      float sp = spacingPx;
      float cp = cellPx;

      // Pixels, with y running *down* — the direction the drops go, which makes
      // every expression below read the way the phenomenon does.
      float H = uFrameSize.y;
      vec2 px = vec2(uv.x * uFrameSize.x, (1.0 - uv.y) * H);

      // One wind for the whole field, and the perspective convergence on top of
      // it: a bundle of parallel lines converges on a vanishing point, so a
      // streak left of it leans right and one right of it leans left.
      float radial = clamp((uv.x - 0.60) / max(uv.y - uHorizonV + 0.28, 0.12), -1.5, 1.5);
      float lean = 0.15 + radial * 0.10;
      float gx = px.x + px.y * lean;

      float col = floor(gx / sp);
      float colJit = hash12(vec2(col, seed));
      // The fall speed, in pixels per second, is the layer's whole identity.
      float fallPxPerSec = H / crossSec;
      // Wrapped to a large multiple of the cell before it is added.
      //
      // Unwrapped this reaches 1.3e7 px after a few hours of uRainTime, and a
      // float has 24 bits: at that magnitude one ulp is 2px, so a row of the
      // screen and the row below it can land on the same value and the drops
      // quantise into bands. Wrapping keeps the number under about fifty
      // thousand, where an ulp is a two-hundredth of a pixel, and costs nothing
      // — the pattern repeats after 1024 cells, which no one will ever see.
      float scroll = mod(uRainTime * fallPxPerSec * (0.88 + colJit * 0.24), cp * 1024.0);
      float gy = px.y + scroll;

      float row = floor(gy / cp);
      float id = hash12(vec2(col, row + seed * 37.0));
      if (id > density) return vec2(0.0);

      float r1 = fract(id * 17.0);
      float r2 = fract(id * 91.7);
      float r3 = fract(id * 233.1);

      // The one derived quantity that matters: how far this drop moved while
      // the shutter was open. Floored at 1.2px because a mark cannot be drawn
      // shorter than a pixel and a point is what the far layer wants anyway.
      // Shorter and thinner with distance, which is where the perspective went
      // once the grid stopped being allowed to carry it.
      float lenPx = max(fallPxPerSec * uShutter * (0.75 + r3 * 0.5) * mix(0.35, 1.0, persp), 1.2);
      float w = widthPx * (0.8 + r2 * 0.45) * mix(0.65, 1.0, persp);

      float fx = gx - (float(col) + 0.18 + 0.64 * r1) * sp;
      float fy = gy - float(row) * cp;

      float across = exp(-(fx * fx) / (w * w));
      // Along the streak: a body of near-constant brightness with both ends
      // soft, not the comet the old version drew. Motion blur lays the same
      // energy down at every point of the path; only the head carries the
      // drop's own glint, and that is the small boost below rather than a
      // brightness ramp down the whole length.
      float body = smoothstep(0.0, lenPx * 0.30, fy) * (1.0 - smoothstep(lenPx * 0.75, lenPx, fy));
      float head = smoothstep(lenPx * 0.45, lenPx * 0.95, fy);

      // Hand-drawn irregularity, and the reason it is needed here specifically.
      // Kuwahara and the macro-contrast pass run *before* this one, so every
      // other element in the frame has been pushed toward paint by the time the
      // rain arrives — and then the rain lands on top of it as mathematically
      // perfect geometry. A clean analytic line over a filtered painterly sky
      // reads as a different medium laid on the picture, which is a large part
      // of what "pasted on" means. Breaking the streak along its length is both
      // the cheap fix for that and a real thing drops do: they rotate and
      // oscillate as they fall, so they scintillate rather than holding one
      // steady brightness.
      // Sampled in *cell-local* coordinates, and that detail is the whole
      // difference between a streak and a dotted line.
      //
      // Written against gy, this reads the noise at a coordinate of several
      // hundred thousand, where a float's fract() has about five bits left. The
      // noise stops being smooth and becomes pixel-frequency hash, so instead of
      // varying gently along a streak it chopped every one of them into
      // one-pixel fragments — and the frame filled with tens of thousands of
      // single-pixel specks that no amount of retuning the lengths could fix,
      // because the lengths were never the problem. Measured before the fix:
      // 10,600 marks above 15 levels of contrast, of which 84 were longer than
      // 12px. The streaks were all there in the arithmetic and none of them
      // survived to the screen.
      //
      // fy runs 0 to the cell height and id is the drop's own hash, so this
      // stays in the low tens and the noise stays smooth.
      //
      // ...and sampled at a frequency the *streak* sets, which is the part that
      // was still wrong and is what the dotted-line rain was.
      //
      // fy * 0.35 is a frequency in pixels, and a mark's length is not. The
      // near layer's cell is 150px, so the noise ran through 52 units along it
      // — one period every three pixels of an 82px streak. That is not
      // scintillation along a drop, it is a dashed line, and it landed hardest
      // on exactly the long marks that are supposed to read as motion. The mid
      // layer was the same: a 31px mark chopped at a period of three.
      //
      // Two periods per streak, whatever the streak is: fy runs 0 to the cell
      // height, the mark occupies lenPx of that, so dividing by the length
      // makes the irregularity a property of the drop rather than of the grid
      // it happens to be drawn on. Long streaks now vary gently along
      // themselves and points are still points.
      float broken = 0.62 + 0.38 * vnoise2(vec2(col * 3.7 + seed, fy * (2.0 / lenPx) + id * 57.0));

      // Energy: the same drop, smeared further, is fainter per pixel — so a
      // streak that rolled long comes out dimmer than one that rolled short.
      //
      // Measured against *this layer's* own mean length, which matters more
      // than it looks. Written against a fixed reference instead, the term
      // stops describing the spread within a layer and starts describing the
      // difference between layers, in the wrong direction: the far points are a
      // twentieth the length of the near streaks, so they came out at the
      // clamp's ceiling while the near ones sat near its floor, and a layer at
      // 40m ended up drawn brighter per mark than one at 3.5m. On screen that
      // was a field of bright grain with the streaks lost inside it. How bright
      // a layer is as a whole is a question about its distance, and distance is
      // the per-layer gain in main, not this.
      float energy = clamp((fallPxPerSec * uShutter) / lenPx, 0.6, 1.6);
      float ink = across * body * broken * energy * (0.35 + r1 * 0.8) * (0.72 + 0.55 * head);

      // Sparkle.
      //
      // A raindrop is a ball lens, and a ball lens has a caustic: when the
      // geometry lines up, a disproportionate share of the light it has
      // gathered leaves along one direction at once. If that direction happens
      // to be the eye, the drop flashes. This is the actual mechanism behind
      // rain glittering against a dark background, and it is intermittent by
      // nature — a drop rotates and oscillates as it falls, so it passes
      // through the alignment rather than sitting in it.
      //
      // Per drop, so every pixel of one streak flashes together, and raised to
      // a high power so that the flash is brief and most drops are dark most of
      // the time. The halo is a very wide, very faint second gaussian: the bloom
      // pass sits eight passes upstream and can never see the rain, so a glint
      // that should bleed has to bring its own bleed with it.
      float flash = pow(0.5 + 0.5 * sin(6.2831853 * (uRainTime * (0.55 + r2 * 1.3) + id * 11.0)), 14.0);
      float halo = exp(-(fx * fx) / (w * w * 45.0));
      // A few drops flash far harder than the rest.
      //
      // Whether a drop's caustic reaches the eye is a matter of its axis
      // happening to line up, so the distribution is not "every drop glints a
      // little" — it is "almost none of them, and the ones that do are briefly
      // the brightest thing in the frame". A fourth power puts about one drop in
      // twenty at more than half strength and one in a few hundred at full,
      // which is what makes the rain *twinkle* rather than shimmer uniformly.
      float rare = 0.30 + 6.0 * pow(r1, 4.0);
      float sparkle = (across * 0.72 + halo * 0.28) * body * (0.35 + 0.65 * head) * flash * rare;

      return vec2(ink, sparkle);
    }

    // The rain sky's own colour at this height. v is screen v, so 1 is the top
    // of the frame. Three measured bands rather than one, piecewise about the
    // middle — see uRainColor.
    vec3 rainSky(float v) {
      return v < 0.5
        ? mix(uRainLow, uRainColor, smoothstep(0.0, 0.5, v))
        : mix(uRainColor, uRainHigh, smoothstep(0.5, 1.0, v));
    }

    // sRGB <-> linear, closely enough. The buffer is display-space by this
    // point (OutputPass ran several passes ago), and an exposure applied to
    // display-space numbers is not an exposure — it is a contrast curve that
    // happens to darken. The gamma round trip is two pow()s and it is the
    // difference between "the sun went behind the deck" and "someone turned the
    // brightness down".
    vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
    vec3 toDisplay(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

    /**
     * What the rain does to any colour in the scene.
     *
     * Two separate things, and keeping them separate is the entire fix:
     *
     *  - **Less light.** An exposure cut in linear light. This is a *scale*, so
     *    it preserves every ratio in the picture: the cloud's crown stays the
     *    same amount brighter than its shadow, the modelling survives, and the
     *    frame gets darker instead of flatter. The old version had no term of
     *    this kind at all.
     *  - **Rain in the way.** Aerial perspective — the water between you and
     *    the subject, which genuinely does replace the subject's colour with
     *    its own. This is the only term allowed to blend, and it is small:
     *    0.30 at the top of the slider against the old 0.82.
     *
     * Then a little contrast about the darkened mid, because the exposure cut
     * compresses the display-space spread along with everything else.
     */
    vec3 weather(vec3 c, float rain, float heavy, float v, float open) {
      vec3 lit = toDisplay(toLinear(c) * mix(1.0, uExposure, rain));
      // The veil is aerial perspective, so it belongs to *distance* — and the
      // one depth cue this pass can read straight out of the picture is whether
      // it is looking at a cloud or through a gap between them. A gap is the
      // longest sight line in the frame by a wide margin: the cloud base is a
      // kilometre or two up, and the sky behind it is not anywhere.
      //
      // Applying one veil to both was visible and specific. At rain=0.5 the deck
      // closed correctly, and the blue showing between its slabs stayed a bright
      // summer blue, because 19% of the way to the rain colour is nothing at all
      // when the starting point is a clear-day zenith. You cannot see blue sky
      // through rain — the gaps are exactly where the murk should be complete —
      // so the open sky takes roughly three times the veil the cloud faces do,
      // and the modelling on the cloud itself is left alone, which is what the
      // exposure-cut rewrite was for in the first place.
      float veil = rain * (0.16 + 0.14 * heavy) * mix(1.0, 3.2, open);
      veil = clamp(veil, 0.0, 0.92);
      vec3 washed = mix(lit, rainSky(v) * mix(1.0, 0.88, heavy), veil);
      // Pivot is the exposed mid rather than 0.5: expanding a dark image about
      // mid-grey would just crush it back toward black.
      float pivot = pow(uExposure, 1.0 / 2.2) * 0.55;
      return pivot + (washed - pivot) * mix(1.0, uContrast, rain);
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      // The slider is the *mean* intensity now, not the instantaneous one: what
      // actually falls is the slider modulated by the gust field, so the weather
      // swells and eases and a front crosses the frame. See gustAt.
      //
      // Only the gust reaches the exposure, not the shower cells below. A gust
      // covers the sky and legitimately takes the light down with it — that is
      // most of what a squall looks like from indoors — whereas letting a
      // two-cells-wide noise drive the exposure would put soft dark blotches
      // across the picture, which is a bruise, not weather.
      float rain = clamp(uRain, 0.0, 1.0) * gustAt(vUv.x);
      rain = clamp(rain, 0.0, 1.0);
      // How hard it is raining in this part of the sky specifically.
      float cell = showerCell(vUv);
      // Everything about heavy rain — how fat the drops are, how many, how hard
      // the light goes — is driven off this rather than off rain directly, so
      // the bottom of the slider stays a drizzle and the top is a different
      // kind of weather rather than the same one turned up.
      // Retuned from smoothstep(0.3, 1.0). Everything that makes rain look like
      // rain rather than like a dimmer switch — the drop size, the count, the
      // near sheet existing at all, the curtains — hangs off this, and starting
      // it at 0.3 and never reaching 1 meant the middle of the slider produced a
      // drizzle and only the last few percent produced weather. Measured at
      // rain=0.5 the old curve gave heavy=0.16, i.e. the near sheet was still
      // switched off entirely at half a downpour.
      float heavy = smoothstep(0.12, 0.85, rain);

      // The light going out. A downpour is genuinely dark: the deck overhead is
      // thick enough to be its own night, and the rain between you and anything
      // else scatters what little is left.
      // How much of this pixel is open sky rather than cloud face — see weather.
      float open = 1.0 - cloudiness(src.rgb);
      vec3 color = weather(src.rgb, rain, heavy, vUv.y, open);

      // The curtains go in first, behind the streaks: they are the far rain,
      // and the streaks are the near rain in front of them. Strongest low in
      // the frame, where the long sight lines are — a shaft two kilometres out
      // is seen against the sky near the horizon, not overhead.
      //
      // The colour is relative to the sky at that height rather than a constant
      // that happened to be brighter than everything else. A curtain is lit by
      // the same light as the deck it hangs from, so it is *slightly* brighter
      // than the sky behind it and no more; the old absolute value came out
      // well above the washed frame everywhere and read as smears on the glass
      // rather than as rain in the distance. Weight halved to match.
      // Distance, from the frame's own depth axis rather than from raw screen
      // height: a curtain two kilometres out is seen against the sky near the
      // horizon, and where that horizon is differs by 155 frame rows between the
      // three scenes.
      float far = 1.0 - perspAt(vUv.y);
      // And the shafts hang from cloud bases, not from wherever the noise
      // happened to be strong. cloudAbove reads the actual sky above this pixel,
      // so a curtain cannot appear under open blue any more — which also means
      // the far rain now thickens on its own as the deck closes, without the
      // rain slider having to say so twice.
      float base = smoothstep(0.20, 0.75, cloudAbove(vUv));
      float veil = smoothstep(0.42, 0.86, curtain(vUv))
        * mix(0.25, 1.0, far) * base * clamp(cell, 0.0, 1.2);
      // Lifted toward white for the same reason the drops are: a curtain is a
      // great many drops scattering light back at you, so it is the palest thing
      // in a rain sky, not merely a brighter version of the sky's own colour.
      vec3 curtainColor = mix(rainSky(vUv.y) * 1.5, vec3(1.0), 0.22) + 0.03;
      color = mix(color, curtainColor, veil * heavy * 0.40);

      // Three layers, named by the distance they are at rather than by how
      // they should look — see dropLayer for the arithmetic that turns a
      // distance into a spacing, a crossing time and therefore a length.
      //
      //   far   40m   crosses in 4.1s    6px marks, i.e. points
      //   mid    8m   crosses in 0.83s  31px marks
      //   near   3m   crosses in 0.31s  82px marks
      //
      // Each mark is twice the distance its drop moves between frames at 60fps
      // and exactly that distance at 30 — see main.ts on the shutter.
      //
      // The counts are an order of magnitude up on the old sheets: roughly
      // 2500 points, 300 short streaks and 25 long ones, against about 200
      // marks in total before. That costs nothing measurable — a layer is a
      // hash test per pixel whatever its density, so the number of drops is
      // free and only the aesthetics limit it. What limits it is that past
      // about 6% coverage the marks merge into a veil, which is the curtains'
      // job and not this one, and that a density much past 0.6 starts to fill
      // every cell and show the lattice.
      // The far layer is a *grain*, and getting its count down is most of what
      // took this from "noise on the lens" to rain. It was first built at 0.42
      // density and measured 16,700 one-pixel marks against 150 streaks — a
      // hundred to one, so the only thing on screen was a field of specks, and
      // the streaks the eye needed in order to read a direction were lost
      // inside it. Points are the right model at 40m; there simply must not be
      // very many of them, and the far rain has the curtains to carry it.
      //
      // The middle layer is the one that has to be seen, so it moved from 12m
      // in to 8m — a 31px mark instead of a 20px one — and its count went up
      // rather than down. A short mark leaning with the wind is the smallest
      // thing that still says which way the weather is going.
      // Thinner and far more numerous than the first pass at this. Widths are
      // down to 0.85-1.05px, which is about as thin as anything can be drawn and
      // still be drawn — and much closer to the truth than the 1.1-1.35 they
      // replace, since the drops these stand for are between 0.04 and 0.5 of a
      // pixel wide. The spacing came down with them, roughly halved in every
      // layer, because thinning a mark without adding marks only removes rain.
      // The count is free: a layer is one hash test per pixel whatever its
      // density (see the note above on what actually limits it).
      // Quartered, in the density and nowhere else.
      //
      // The density is the fraction of cells that hold a drop at all, so
      // dividing it divides the *number* of drops and changes nothing about any
      // of them: the marks that are left are the same length, the same width,
      // the same brightness and the same lean as before, with four times as
      // much empty sky between them. Every other lever here would have made
      // less rain by making worse rain — thinning the marks takes them under a
      // pixel, dimming them takes them under the sky they are drawn against,
      // and widening the spacing moves the grid the fall offset is indexed
      // against, which is the one thing in this function that may not move
      // (see the note at the top of it).
      vec2 farD = dropLayer(vUv, 5.0, 16.0, 4.1, 0.85, mix(0.015, 0.033, heavy), 1.0);
      vec2 midD = dropLayer(vUv, 9.0, 34.0, 0.83, 0.95, mix(0.035, 0.105, heavy), 7.0);
      vec2 nearD = dropLayer(vUv, 46.0, 150.0, 0.31, 1.05, mix(0.0, 0.095, heavy), 23.0);

      // The bottom of the slider is a drizzle you can barely see: the marks
      // fade in over the first third of it rather than appearing at full
      // strength the moment the slider leaves zero.
      float visible = smoothstep(0.03, 0.35, rain);

      // A raindrop is a lens, not a mark.
      //
      // A drop has no colour of its own: it gathers the sky from above and
      // behind it and squeezes it toward the eye, so a streak is always a
      // compressed, slightly brightened image of what is *around* it. That is
      // why rain nearly vanishes against a bright sky and stands out against a
      // dark hillside, and why it can never look pasted on.
      //
      // Three taps rather than one, and the *brightest* of them rather than the
      // nearest. A drop images most of the hemisphere, so what it finds is the
      // brightest thing up there — the break in the deck, not the particular
      // patch of murk five percent of a frame above it. Taking the maximum is
      // also where a good deal of the glitter comes from: drops crossing in
      // front of a dark part of the sky still carry the light of the bright
      // part, which is exactly the contrast that makes rain visible at all.
      //
      // Weathered exactly like everything else before it is used, or every drop
      // would show a clear-weather sky against a scene that has just been taken
      // down two stops.
      vec3 up1 = texture2D(tDiffuse, vec2(vUv.x, min(vUv.y + 0.05, 1.0))).rgb;
      vec3 up2 = texture2D(tDiffuse, vec2(vUv.x + 0.03, min(vUv.y + 0.13, 1.0))).rgb;
      vec3 up3 = texture2D(tDiffuse, vec2(vUv.x - 0.03, min(vUv.y + 0.22, 1.0))).rgb;
      vec3 gathered = weather(max(max(up1, up2), up3), rain, heavy, vUv.y, open);

      // Grey through white, by depth rather than at random.
      //
      // A distant drop is seen through tens of metres of the same rain that is
      // dimming everything else, so it arrives grey; a near one has almost
      // nothing in front of it and shows the sky's own brightness. Tying the
      // spread to the three layers rather than rolling it per drop gets the
      // depth cue for free and gets it right — the pale marks sit behind the
      // bright ones instead of being scattered through each other.
      // Half the local sky, half the ambient — see uSkyColor. The local half is
      // what keeps a drop from looking pasted on (it still dims where the sky
      // behind it dims); the ambient half is what keeps it from disappearing
      // into a murk that is uniformly as dark as the drop.
      vec3 lit = mix(gathered, uSkyColor * 1.25, 0.55);
      // Depth greys a drop out — but toward the *murk*, not toward luminance.
      //
      // Mixing toward vec3(grey) is the obvious way to say "the far drops are
      // washed out" and it is wrong in a way that is invisible in the code and
      // glaring on screen: a desaturated dot on a deep blue field does not read
      // as a pale blue dot, it reads as a warm one, because the eye judges it
      // against the blue around it. Two thousand of them turned the far layer
      // into a field of orange specks — sensor noise, or stars, but not rain.
      // The physical statement wanted here is that a distant drop is seen
      // through more of the same rain that is dimming everything else, and what
      // that rain's colour *is* is the murk, so that is what to converge on.
      // ...and then taken toward white, by depth.
      //
      // Physically a drop carries the sky's colour, which is what the terms
      // above compute, and a strictly correct rain against this sky would be a
      // slightly paler blue. It reads as too little. What a drop actually does
      // is *concentrate* the hemisphere into a line, and a concentration of
      // light desaturates as it climbs toward the top of the range — the same
      // reason a specular highlight goes white while the surface under it keeps
      // its hue. So the marks are lifted toward white, and by more the nearer
      // they are, since a near drop is delivering the most light.
      //
      // This is also how rain has always been painted, and the picture it is
      // being drawn into is a painting.
      vec3 farColor = mix(mix(lit, uSkyColor * 1.10, 0.45), vec3(1.0), 0.30);
      vec3 midColor = mix(lit * 1.20, vec3(1.0), 0.45);
      vec3 nearColor = mix(lit * 1.30, vec3(1.0), 0.55) + 0.04;

      // The shower cells reach the marks as well as the curtains: the near rain
      // is the same rain, so when a cell passes it is heavier here and lighter
      // there rather than uniformly heavier everywhere.
      float strength = mix(0.55, 1.0, heavy) * visible * clamp(cell, 0.25, 1.25);
      // The per-layer gains are where distance lives: a drop at 40m delivers a
      // small fraction of the light of one at 3.5m, so the far field is a faint
      // grain, the middle layer carries the read, and the near streaks are the
      // brightest marks in the frame and the rarest.
      color = mix(color, farColor, clamp(farD.x * 0.40 * strength, 0.0, 1.0));
      color = mix(color, midColor, clamp(midD.x * mix(1.30, 2.10, heavy) * strength, 0.0, 1.0));
      color = mix(color, nearColor, clamp(nearD.x * 1.90 * heavy * strength, 0.0, 1.0));

      // The glints go on top, and they are *added* rather than mixed.
      //
      // A mix says "this much of the pixel is drop instead of sky", which is
      // the right model for a drop's body — it is an object occupying area. A
      // caustic is not an object, it is light arriving, and light arriving adds.
      // Mixing it in would also cap it at the drop's own colour, when the whole
      // point of a glint is that for one frame it is brighter than anything
      // around it.
      //
      // Weighted toward the far layer, which is where the glitter belongs: a
      // point is all head and no tail, and there are two and a half thousand of
      // them. Kept small in absolute terms because they are additive and the
      // frame under them has deliberately just been taken down a stop and a
      // half — a little goes a long way against a storm sky, and too much turns
      // rain into fireflies.
      // A caustic is close to white — it is the sky's light concentrated, not
      // tinted — so this one may lift toward neutral. It is a handful of pixels
      // for a couple of frames, which is the one place a neutral highlight does
      // not turn the field warm.
      // Near white, and brighter than it was by a factor of three.
      //
      // A caustic is the sky's light concentrated rather than tinted, so it may
      // go neutral where the drop's body may not; and it is the one part of the
      // rain that is *supposed* to outshine its surroundings for a moment. The
      // first version weighted it at a sixth of this and put the weight on the
      // far layer, which is backwards — a point has no head to glint from and
      // there are thousands of them, so all that produced was a faint overall
      // shimmer. The weight belongs on the mid and near layers, where a mark has
      // a head, and it belongs high enough to actually flash.
      vec3 glint = mix(lit * 1.15 + 0.10, vec3(1.0), 0.45);
      float sparkle = farD.y * 0.55 + midD.y * 0.85 + nearD.y * 0.60;
      color += glint * sparkle * strength * mix(0.35, 1.0, heavy);

      gl_FragColor = vec4(color, src.a);
    }
  `,
};
