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
     *
     * The two edges are set from the key that was actually painted, measured by
     * scripts/puddle.js: its body sits at 0.72 on this scale (sRGB 206,23,248
     * rather than a mathematical 255,0,255), so the upper edge has to be under
     * that or the water would key at less than full strength everywhere. What
     * lands *between* the edges is the third thing the mask carries and the
     * reason it is worth reading as a distance at all — the girl's clear
     * umbrella, painted over the paint at partial opacity. It keys partially,
     * so the live sky comes through it exactly as much as it comes through the
     * vinyl.
     */
    tMask: { value: null as THREE.Texture | null },
    /** 0 while the two assets have not arrived — see FALLBACK. */
    uHasAssets: { value: 0 },
    /** xy = uv origin, zw = uv size, of the visible sub-rect (core/frame.ts). */
    uPlateRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    /** Screen v of the water's vanishing line (scene/puddle.ts). */
    uHorizonV: { value: 0.82 },
    /** The band of the rendered frame the water images: x is what the far lip
     * reads, y what the viewer's feet read (scene/puddle.ts's WATER_SKY_V0/V1).
     * Not the whole frame — see there. */
    uSkyV: { value: new THREE.Vector2(0.06, 0.72) },
    /**
     * How much the reflection is magnified vertically, and therefore how much
     * the horizontal read has to be narrowed to match.
     *
     * The water covers 0.91 of the frame's height and reads a band 0.66 of the
     * render's height, so it magnifies what it reads by 1.38 — *vertically*.
     * Horizontally it was sampling one-for-one, so every cloud in the water came
     * out 38% taller than it was wide. That is what "the cloud looks stretched"
     * is, and it is an error rather than a look: a reflection is a projection of
     * a patch of sky, and a projection's magnification does not get to differ
     * between two axes of the same flat patch.
     *
     * So the horizontal read narrows by the same factor about the centre. The
     * water then images a *smaller* piece of sky than the whole frame — which is
     * correct, and is the same statement scene/puddle.ts's WATER_SKY_V0/V1 makes
     * about the vertical: this is a two-metre pool, not a planetarium.
     */
    uSkyUScale: { value: 1.383 },
    uAspect: { value: 1376 / 768 },
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
    /**
     * How much of the surface's displacement the *painted* reflections take.
     *
     * The wires, the pole, the reflected house and the girl are reflections in
     * the same water as the sky, and until this existed they were the only
     * things in the picture that a ripple went straight through. The water
     * moved the sky and left them standing — which is the sort of thing an eye
     * catches immediately without being able to name, because a surface that
     * disturbs one reflection and not another is not a surface.
     *
     * They are not keyed (they have to survive on top of the live reflection),
     * so the key cannot say where this applies. The mask's alpha does: the
     * puddle's filled outline, eroded and feathered, baked by scripts/puddle.js.
     * Inside it, the photograph is sampled at the displaced position — key and
     * all, so a wire and its own keyed-ness move together and it does not smear
     * against the water it is lying on.
     *
     * 0.26, not 1.0, and the difference is optics rather than taste.
     *
     * A tilted patch of water swings the reflected ray by twice its own slope,
     * and how far the *image* moves is that angle times the distance to what is
     * being reflected. The sky is at infinity, so it moves by the full amount.
     * The wires are perhaps eight metres up and the reflected house maybe
     * twenty, which is a small fraction of a cloud bank forty kilometres out.
     *
     * At 1.0 it showed: a ring crossing a wire displaced it by up to 25 screen
     * pixels, which on a line one pixel wide is not a bend, it is a break — the
     * wires came apart into disconnected segments and the pole's reflection
     * fragmented. Ratios this large are exactly why "apply the same
     * displacement to everything" is wrong even though the surface is the same
     * surface.
     *
     * 0.13, halved again, and the second halving is about her legs.
     *
     * At 0.26 the wires held and her shins did not: a ring crossing them bit
     * notches out of the outline several pixels deep, and on a limb about
     * twenty pixels wide a notch that size is not a ripple passing over a leg,
     * it is a leg that stops at the knee. The bound that matters is not how far
     * the painted layer moves but how fast the movement *changes* across it — a
     * warp stays a warp only while its gradient is small compared with the
     * narrowest thing being warped, and past that it stops bending an outline
     * and starts cutting it. Her shins are the narrowest thing in the puddle
     * after the wires, so they set the number, and the clamp below sets the
     * ceiling that a single loud ring cannot argue with.
     *
     * The sky keeps the full displacement, and the asymmetry is the point: a
     * reflected sky has no thin structure to cut, which is why water can fold
     * it as hard as it likes and still look like water.
     *
     * 0.45 on the coarse gradient, which is six times the displacement the
     * fine one was allowed and a gentler warp across her than that was. See the
     * slopeCoarse note in main(): the number that may not be large is the
     * gradient, not the amplitude, and low-passing the field is what buys the
     * amplitude back. 0.005 of the frame is about seven pixels of travel over a
     * field that varies across forty, so a shin bends and does not break.
     */
    uPhotoWarp: { value: 0.45 },
    /**
     * The water's palette, measured straight off the reference, and the one
     * part of this pass that is fitted rather than reasoned.
     *
     * Two rounds of this were spent on a per-channel power curve `k · c^γ`,
     * solved from a bright pair and a dark pair. It got the average right and
     * the picture wrong, and the band-by-band measurement (scripts/analyse.js)
     * says exactly why. Over the reference's keyed water, from the far lip down
     * to the viewer's feet, the open sky in it runs
     *
     *   (86,115,160) → (73,101,145) → (61,87,131) → (52,77,123) → (47,69,112)
     *   → (42,59,95) → (35,49,83)
     *
     * and the cloud in it stays between (171,171,168) and (190,182,169) for
     * five of those seven bands before falling away in the last two. That is a
     * *narrow* tonal range — about 50 levels of ramp on the blue — sitting under
     * a nearly flat cloud. The render's own sky, mapped into the same water,
     * ran (130,158,188) to (10,25,61): a range two and a half times as wide.
     *
     * No power curve can fix that, and it is worth being precise about why: γ>1
     * darkens the midtones and *widens* the range, γ<1 lifts them and widens it
     * the other way, and a gain moves both ends together. Range compression
     * with an independent target at each end is not a curve, it is an
     * interpolation — so this is one.
     *
     * The reflected sky is classified as cloud or open sky by its own
     * saturation (the render's sky sits at b−r ≈ 0.25, its cloud at ≈ 0.02,
     * and nothing lies between), and the result picks a colour off the ramp the
     * reference actually painted, at this pixel's depth into the water. The
     * live render then supplies the *detail* — every shape, every edge, every
     * ripple, and the tonal variation inside the cloud — as a luminance ratio
     * about its own class mean.
     *
     * What this does and does not decide is worth stating. It fixes the
     * palette: the water can only be the colours the reference's water is. It
     * decides nothing about where the cloud is, what shape it has, how it moves
     * or how the ripples cross it — all of that is the live scene, and none of
     * it is available to a painting.
     */
    /**
     * What the water does to the sky it reflects: one per-channel curve
     * `k · c^γ` in display space, and nothing else.
     *
     * There was a version of this that replaced the reflection's colours
     * outright — a palette measured off the reference, with the render supplying
     * only the shading. It matched every statistic it was fitted to and it
     * looked wrong: two anchors with a classifier between them posterises, and
     * the water came out as flat cutout cloud on flat blue. The mistake was
     * treating the parent project's colour as the thing to replace. Those
     * colours are not a default — cloudRamp.ts is a ramp *measured off an
     * illustration*, and the cloud shader, the daylight model and the post chain
     * were all fitted around it. It is the most carefully fitted thing here, and
     * a puddle is not a reason to throw it away.
     *
     * So the render keeps its own colour and its own modelling, and the water
     * only does what water does to what it reflects. Solved per channel against
     * the reference's keyed water, from a dark pair and a bright pair:
     *
     *              blue water              cloud in the water
     *   reference  ( 46,  72, 116)         (248, 238, 214)
     *   render     ( 80, 130, 166)         (219, 225, 228)
     *
     * The blue is less than half as bright as the sky that made it while the
     * cloud is brighter and warmer, which no exposure scale and no tint can do
     * at once — one darkens both ends, the other moves both hues the same way.
     * It takes a curve, and the physics agrees: the dark blue is sky radiance
     * attenuated by a few percent of Fresnel over near-black asphalt, the white
     * is a specular highlight of a source bright enough to survive that. The
     * midtones fall hard; the highlights hold.
     *
     * Iterated once against the curve's own output and composed, because bloom,
     * Kuwahara and macro-contrast all run before this and are not linear, so the
     * input moves a little when the curve moves. The second solve's exponents
     * were all within 10% of 1.
     */
    uWaterGamma: { value: new THREE.Vector3(1.631, 2.355, 2.122) },
    /**
     * The blue gain comes up from 0.985 to 1.10, and this is the third of the
     * three places the cloud was being made orange.
     *
     * The curve was solved from two colour pairs, and a two-point solve is only
     * as good as its anchors: the bright one was the reference's cloud at
     * (248,238,214), which is a *warm cream* because it is a cloud lit by a low
     * sun and painted by an illustrator. Fitting a per-channel gain to it puts
     * that warmth into the response of the water itself — so the water then
     * warms everything it reflects, at every brightness, whatever the sky above
     * it is doing. That is the wrong home for it. A cream cloud is a fact about
     * the light; taking blue out at the surface is a claim about the water.
     *
     * Raising it lands hardest where it should: the gain multiplies, and the
     * exponents mean the dark end is dominated by pow() while the bright end is
     * dominated by this, so the cloud whitens by much more than the deep water
     * shifts — and what the deep water does shift by, it shifts *bluer*, which
     * is the direction the reference's navy is anyway.
     */
    uWaterGain: { value: new THREE.Vector3(1.299, 1.228, 1.100) },
    uPalette: { value: 1 },
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
    uniform vec2 uSkyV;
    uniform float uSkyUScale;
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
    uniform float uPhotoWarp;
    uniform vec3 uWaterGamma;
    uniform vec3 uWaterGain;
    uniform float uPalette;
    varying vec2 vUv;

    const float RING_LIFE = ${RING_LIFE.toFixed(1)};
    /** Metres per second a ring travels outward. Real capillary-gravity rings on
     * a shallow puddle run about this. */
    const float RING_SPEED = 0.42;
    /**
     * Rings per metre in the wake, and how fast the wake dies behind the crest.
     *
     * 52 per metre is a ring every 2cm, which is what a drop actually makes.
     * These were 34 and 7 — a ring every 3cm with a wake half a metre long —
     * and at that scale the water stopped reading as a puddle: the rings were
     * as wide as the pool and swung the reflection around in great slow curves
     * rather than putting small ripples on it.
     */
    const float RING_FREQ = 52.0;
    const float RING_TAIL = 12.0;

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
      // Just under a metre per cell, and a period measured in seconds rather
      // than fractions of one. Both were three times denser and faster to begin
      // with, which produced a uniformly agitated surface — physically a
      // downpour, and nothing like the reference, which holds perhaps six
      // separate ring systems wide enough to count the rings in. What makes
      // that picture is not how much rain there is, it is that each strike is
      // *resolvable*: far apart, and still ringing seconds later.
      float cells = 1.25;
      vec2 c0 = floor(g * cells);
      // Doubled from mix(4.2, 1.4): half as many strikes per square metre per
      // second, and every one of them the ring it always was.
      //
      // The rate is the honest place to take rain out. The slider it runs on is
      // an intensity and moves the rings' height with their number, so turning
      // *that* down does not thin the rain, it fades it — and a ring visible
      // only while it is at its loudest is the failure this whole term was
      // built out of. Period rather than amplitude, so what changes is how
      // often the water is struck and nothing else: the same rings, standing in
      // the same water, with twice as much still surface between them.
      //
      // The rate stays here while the falling rain is quartered, and that is
      // deliberate. The drop layers and the sparks are rain *in the air*, and
      // asking for less of it is asking to see fewer streaks. The rings are
      // rain where it lands, and they are the thing the picture is about — the
      // reference holds about six ring systems wide enough to count the rings
      // in. Quartering these as well took them down to one or two, which is not
      // quieter rain, it is a pool nothing is falling into.
      float period = mix(8.4, 2.8, uRain);
      float sum = 0.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 c = c0 + vec2(float(i), float(j));
          vec2 r = hash22(c);
          vec2 centre = (c + 0.25 + r * 0.5) / cells;
          float age = mod(t + r.x * period * 6.0, period);
          float d = length(g - centre);
          float radius = age * RING_SPEED * 0.55;
          // Tight: a couple of rings at the crest and nothing behind them. A
          // wide wake here is what turned a scatter of drop strikes into one
          // continuously churning surface.
          // Shallower and finer, which is what a puddle's rings actually are.
          //
          // These were 44 rad/m with a 16/m envelope, and that is a ring
          // system for water with depth under it: a long wavelength, a tall
          // crest, and a swing of the reflection big enough to read as a wave
          // rather than as a ripple. A rain puddle is a centimetre or two deep.
          // Its rings are correspondingly short — capillary rather than gravity
          // waves — and they are *low*: a drop's energy spreads through a ring
          // that grows, so what stands on a puddle is a fine, tight, shallow
          // thing you read by the light on it, not by how far it moves the sky.
          //
          // Twice the spatial frequency, twice the envelope decay (so the crest
          // is a band half as wide), and the amplitude down with them below.
          float wave = sin((d - radius) * 88.0)
            * exp(-abs(d - radius) * 34.0)
            * exp(-age * 1.5);
          sum += wave;
        }
      }
      // 0.22 rather than 0.55. The displacement a rain ring is allowed is a
      // statement about the depth of the water it is standing in, and this is a
      // puddle. What it loses in swing it gets back as light — the crest term
      // and the glint both read the *slope*, and halving the wavelength while
      // taking the height down by 60% leaves the slope where it was.
      return sum * 0.22 * uRain;
    }

    /** Gradient noise on the ground plane, and the two reasons it is not the
     * obvious thing.
     *
     * The chop was three sine trains for a long time, and every version of it
     * striped the water — along the line of sight as vertical bars perspective
     * could not thin, across the view as horizontal ones. That is not a bearing
     * problem: a sine *is* a stripe, and there is no direction to point one that
     * stops it being one. So the trains went and noise came in.
     *
     * The first noise was **value** noise with a cubic fade, and it drew squares
     * — a grid of cells over the whole pool. Both halves of that are wrong here
     * and both matter, because of what this function is actually used for.
     *
     * *Value* noise stores one scalar per lattice point and interpolates it, so
     * its extrema all sit on the lattice: the field is a grid of bumps wearing a
     * smooth coat. Nobody sees that in the height — but nothing here reads the
     * height. The displacement, the crest term and the glint all read the
     * *gradient*, and differentiating a value-noise field puts the lattice
     * straight back on screen. Gradient noise is zero at every lattice point and
     * carries a random direction instead, so its features sit *between* the
     * lattice points and its derivative has no grid in it.
     *
     * And the fade has to be **quintic**, not smoothstep. Cubic smoothstep is
     * C1: its second derivative jumps at every cell boundary. The slope here is
     * a finite difference of the surface, so a jump in the second derivative is
     * a visible crease — a square grid of them. 6t^5-15t^4+10t^3 is C2, which is
     * the whole reason Perlin replaced his own cubic with it.
     */
    vec2 hash22s(vec2 p) {
      vec2 h = hash22(p) * 2.0 - 1.0;
      return normalize(h + sign(h) * 1e-4);
    }

    float gnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      float a = dot(hash22s(i), f);
      float b = dot(hash22s(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
      float c = dot(hash22s(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
      float d = dot(hash22s(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4;
    }

    /**
     * The wind chop: two and a half octaves of that noise, drifting downwind.
     *
     * 'fine' fades the shorter octaves out with distance and is not a taste
     * decision. In ground coordinates the chop has a fixed wavelength, so its
     * *screen* wavelength falls with distance and somewhere short of the
     * vanishing line it goes under a pixel — past which sampling it does not
     * draw small waves, it draws noise, and the reflected cloud is shredded
     * into grain exactly where it should be smoothest. A feature finer than the
     * sample has to fade to its own mean, which is what a mip level is and what
     * this is. Real distant water behaves the same way for the same reason: at
     * fifty metres a chopped surface is a sheen, not a texture.
     *
     * The whole field is advected rather than each octave being given its own
     * phase speed: wind chop is carried by the wind, so the pattern travels and
     * evolves, it does not stand still and pulse.
     */
    float chop(vec2 g, float t, float fine) {
      // Each octave is rotated as well as scaled, by an angle that is no simple
      // fraction of a turn. Stacked on the same axes, three octaves of any
      // lattice noise still share a lattice — the cells line up at every scale
      // and the sum has more grid in it than any one term does. Rotating breaks
      // the alignment, which is the cheapest way to make a sum of lattice noise
      // stop looking like a lattice.
      const mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
      vec2 drift = vec2(0.0, -t * 0.13);
      vec2 p = (g + drift) * 2.6;
      float h = gnoise(p) * 0.22;
      p = rot * p * 2.27 + 13.0;
      h += gnoise(p) * 0.12 * fine;
      p = rot * p * 2.12 + 41.0;
      h += gnoise(p) * 0.06 * fine * fine;
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

    /** The rendered sky, as this water's own colour at this depth. See the
     * palette uniforms above. */
    /** The rendered sky, as this water reflects it. See the curve above. */
    vec3 intoWater(vec3 rendered, float depth) {
      if (uPalette < 0.5) return rendered;
      vec3 wet = clamp(uWaterGain * pow(max(rendered, 0.0), uWaterGamma), 0.0, 1.4);
      // And further down toward the near lip, where the view is steepest and
      // the least is reflected. Linear in depth rather than another curve: the
      // response above is what the water does to a colour, this is only how
      // much of it comes back. It carries most of the picture's vertical
      // gradient — the reference's water has a median luminance of 77 against
      // the render's 104 before this reached 0.30 — and it is the honest place
      // for that gradient to live, because Fresnel really does fall away as the
      // view steepens.
      return wet * (1.0 - 0.30 * depth);
    }

    void main() {
      vec2 uv = vUv;
      vec2 refUv = uPlateRect.xy + uv * uPlateRect.zw;

      // What the mask says about this pixel, before anything has moved: how
      // much water there is (rgb, the magenta distance) and whether it is
      // inside the puddle's outline at all (alpha — see uPhotoWarp).
      vec4 mask = texture2D(tMask, refUv);
      float keyRaw;
      float interior;
      if (uHasAssets > 0.5) {
        keyRaw = smoothstep(0.30, 0.62, min(mask.r, mask.b) - mask.g);
        keyRaw = pow(keyRaw, 1.9);
        // The interior, with the encoder's floor taken back off: the asset
        // carries 1/255 where it means 0, so that no pixel of the key is fully
        // transparent and WebP cannot discard the key's own colour under it.
        // See scripts/puddle.js's puddleInterior.
        interior = clamp(mask.a * (255.0 / 254.0) - (1.0 / 254.0), 0.0, 1.0);
      } else {
        // FALLBACK: no photograph, no key. Everything below the vanishing line
        // is water, with the edge broken up so it is a puddle rather than a
        // horizon. The app is fully itself in this state apart from the street.
        float edge = uHorizonV - 0.035 + 0.02 * sin(uv.x * 9.0) + 0.012 * sin(uv.x * 23.0 + 1.7);
        keyRaw = smoothstep(edge + 0.012, edge - 0.012, uv.y);
        interior = keyRaw;
      }

      // Dry road, outside the puddle entirely: nothing here is a reflection and
      // nothing moves. This is most of the frame, and skipping it here is what
      // keeps the surface arithmetic off two thirds of the pixels.
      if (keyRaw < 0.002 && interior < 0.004) {
        vec3 dry = texture2D(tRef, refUv).rgb * uDayTint;
        if (uRainExposure < 1.0) {
          dry = pow(max(pow(max(dry, 0.0), vec3(2.2)) * uRainExposure, 0.0), vec3(1.0 / 2.2));
        }
        gl_FragColor = vec4(uHasAssets > 0.5 ? dry : uBedColour, 1.0);
        return;
      }

      // The wet ground around the pool.
      //
      // A puddle does not end at its water. The stone for a hand's width around
      // it is soaked, and soaked stone is darker and glossier than dry stone —
      // it is why a real puddle sits in a soft dark halo instead of looking cut
      // out of the road. The key ends at the waterline, so without this the
      // app's water met bone-dry asphalt along a line, which was the most
      // photographic-looking edge in the picture and the least true one.
      //
      // The interior field is the right shape for it and costs nothing extra:
      // it is the key blurred over 26px (scripts/puddle.js), so outside the
      // waterline it falls off over about the distance the ground stays wet.
      // This is that band, on the side the key says is not water.
      float wet = clamp(interior, 0.0, 1.0) * (1.0 - keyRaw);

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

      // The same surface read bluntly, for the things painted on it.
      //
      // This is what puts a ripple on the girl, and it exists because the sharp
      // slope above cannot. The bound on warping a painted reflection is not
      // how far it moves, it is how fast the movement *changes* across it: a
      // warp stays a warp while its gradient is small compared with the
      // narrowest thing being warped, and past that it stops bending an outline
      // and starts cutting it. Her shins are about twenty pixels. The slope
      // above is differenced over one texel, so it carries every wavelength the
      // surface has, including ones far shorter than that — which is why the
      // painted layer had to be held down to a fifth of a shin's width and the
      // ripple crossing her was, in the end, invisible.
      //
      // Differencing over 0.03 of the frame instead — about forty pixels — is a
      // low-pass on the displacement field. What comes back is only the part of
      // the surface that varies more slowly than she is wide: the chop's long
      // octave and the body of a ring, not the crest lines and not the rain's
      // fine rings. That field can be given six times the amplitude and still
      // have a gentler gradient across her than the old one did, so she visibly
      // rides the water and no edge in the photograph can be cut.
      //
      // Two more evaluations of surface(), which is the expensive function in
      // this pass. Paid rather than approximated: a coarse difference of the
      // real surface is guaranteed to agree with the fine one about where the
      // waves are, and anything cheaper is a second surface that can disagree
      // with the first about which way the water is tilted.
      float ec = 0.030;
      float hcx = surface(ground(uv + vec2(ec, 0.0)), t, fine);
      float hcy = surface(ground(uv + vec2(0.0, ec)), t, fine);
      vec2 slopeCoarse = vec2(hcx - h, hcy - h) / ec;

      // The displacement, and the two factors that shape it are opposites.
      //
      // (1 − depth) rises toward the far lip, because a slope of a given angle
      // swings the reflected ray through a much larger patch of *screen* at a
      // grazing angle than it does underfoot — the same reason a breath of wind
      // wrecks a distant reflection while the one at your feet stays legible.
      // 'fine' falls to zero there, because that is also where the waves doing
      // the swinging stop being resolvable. Their product peaks in the upper
      // third of the water and goes quietly to nothing at the lip, which is
      // where the reflected cloud has to be readable as cloud.
      //
      // The floor on the depth term is 0.45 rather than 0.25 because the near
      // water is where the viewer's own feet are, and therefore where every
      // pressed ring is born. At 0.25 a footfall underfoot moved the sky about
      // half as much as the same footfall thrown out toward the lip, which is
      // backwards as an experience whatever it is as optics.
      //
      // Clamped as well, because the far lip's ground coordinates run to
      // infinity and an unclamped slope there samples the whole sky at once.
      vec2 push = slope * 0.00075 * fine * (0.45 + 0.55 * (1.0 - depth));
      push = clamp(push, vec2(-0.018), vec2(0.018));

      // The painted layer rides the same surface (uPhotoWarp). Key and colour
      // are both read at the displaced position, so a wire and its own
      // keyed-ness travel together rather than the wire sliding out from under
      // the hole it is supposed to be filling.
      // Clamped in its own right, and not only scaled: 'push' is already
      // clamped, but at its ceiling it is still 25 screen pixels, and a
      // fraction of a large number is a large number wherever a ring happens to
      // be loud. Her shins are about twenty pixels across, so the painted layer
      // is allowed a fifth of that — enough that the water visibly runs over
      // her and not enough that any edge in the photograph can be cut through.
      vec2 photoPush = clamp(
        slopeCoarse * 0.00075 * fine * (0.45 + 0.55 * (1.0 - depth)) * uPhotoWarp,
        vec2(-0.0050), vec2(0.0050));
      vec2 warpedUv = refUv + photoPush * uPlateRect.zw * interior;
      float key = keyRaw;
      if (uHasAssets > 0.5 && interior > 0.004) {
        vec4 moved = texture2D(tMask, warpedUv);
        key = pow(smoothstep(0.30, 0.62, min(moved.r, moved.b) - moved.g), 1.9);
      }
      refUv = warpedUv;

      // The photograph, relit for the hour and dimmed by the rain exactly as the
      // window app's plate is: this street has no light of its own either.
      vec3 painted = texture2D(tRef, refUv).rgb * uDayTint;
      if (uRainExposure < 1.0) {
        painted = pow(max(pow(max(painted, 0.0), vec3(2.2)) * uRainExposure, 0.0), vec3(1.0 / 2.2));
      }
      if (uHasAssets < 0.5) painted = uBedColour;
      // Darker and a shade cooler, in linear light, so it reads as wet stone
      // rather than as a shadow with an edge.
      if (wet > 0.004) {
        vec3 lin = pow(max(painted, 0.0), vec3(2.2));
        lin *= mix(vec3(1.0), vec3(0.70, 0.74, 0.82), wet * 0.8);
        painted = pow(max(lin, 0.0), vec3(1.0 / 2.2));
      }
      // Darker and a touch cooler, in linear light, so it reads as wet rather
      // than as a shadow with a hard edge.
      if (wet > 0.004) {
        vec3 lin = pow(max(painted, 0.0), vec3(2.2));
        lin *= mix(vec3(1.0), vec3(0.66, 0.70, 0.78), wet * 0.85);
        painted = pow(max(lin, 0.0), vec3(1.0 / 2.2));
      }

      // Painted, and not water — but *inside the pool*, which is the case this
      // early-out used to get wrong and the whole of "the ripple goes behind
      // her".
      //
      // The girl, the umbrella's ribs, the wires, the pole and the reflected
      // house are all unkeyed by construction: they are things lying on the
      // water, and the key exists to let them survive on top of the live
      // reflection. So the key is 0 over every one of them, and this returned the
      // bare photograph before reaching a single line of surface light. Every
      // crest, every glint, every sheen was drawn on the water *around* her and
      // stopped dead at her outline — which does not read as a figure under a
      // rippling surface, it reads as a figure cut out and laid on one.
      //
      // The condition that actually means "nothing here is water" is the
      // interior, not the key. With it, an unkeyed pixel inside the pool falls
      // through to the bottom of the function, where mix(painted, water, key)
      // leaves it as the photograph — and then the surface goes over it, which
      // is what a surface does.
      if (key < 0.002 && interior < 0.004) {
        gl_FragColor = vec4(painted, 1.0);
        return;
      }

      // The mirror. The rendered frame is the reflected hemisphere already
      // (scene/puddle.ts aims the camera up), so this is a remap of the water's
      // depth onto the render's own horizon-to-zenith span, not a flip.
      vec2 skyUv = vec2(
        0.5 + (uv.x - 0.5) / uSkyUScale,
        mix(uSkyV.x, uSkyV.y, depth)) + push;
      skyUv = clamp(skyUv, vec2(0.001), vec2(0.999));
      vec3 sky = texture2D(tDiffuse, skyUv).rgb;
      sky = intoWater(sky, depth);

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
      vec3 n = normalize(vec3(-slope.x * 0.032, 1.0, -slope.y * 0.032));
      vec3 lightDir = normalize(vec3(-0.52, 0.62, -0.59));
      float aligned = max(dot(n, lightDir), 0.0);
      // Two lobes: the point itself, and a much broader glow around it.
      //
      // Everything in the post chain that would normally spread a highlight
      // runs *before* the water (core/postFx.ts), so the glitter is the one
      // bright thing in the frame with no bloom on it at all — pin-sharp
      // pinpricks, which is what a specular looks like in a render and never
      // what it looks like through an eye or a lens. Rather than bloom the
      // finished frame, which would also spread the photograph, the highlight
      // carries its own halo: the same dot product at a much lower exponent,
      // which is a wide soft lobe around exactly where the sharp one is.
      float spec = pow(aligned, 90.0) + 0.22 * pow(aligned, 9.0);
      // Broken up, so it reads as separate points of light rather than as a
      // varnish over the whole surface. The hash rides the ground plane, so the
      // grain gets finer with distance like everything else here.
      float grain = 0.55 + 0.45 * hash21(floor(g * 26.0) + floor(t * 9.0) * 0.017);
      // The wind's own patches of light.
      //
      // Still water does not glitter, which is right, and a puddle with a
      // breath of wind on it is not still — it catches the sun in *patches*
      // that travel, because a gust is a region of roughened surface crossing
      // the pool rather than a uniform increase in slope everywhere. The glint
      // above cannot produce that on its own: it reads the surface pointwise,
      // so at WATER = 0.11 the chop tilts the water by a fraction of a degree
      // and every point of it is equally dull.
      //
      // Two slow crossing trains, well below the chop's own frequencies, used
      // as a *gain* on the light rather than as height — nothing here displaces
      // the reflection, so the cloud in the water stays as readable as it was
      // and only the sparkle breathes over it. It rides the same ground plane,
      // so a patch shortens toward the far lip like everything else.
      float gust = 0.5 + 0.5 * sin(g.y * 1.9 - t * 0.55 + sin(g.x * 1.3 + t * 0.31) * 1.7);
      float breeze = 1.0 + 1.5 * uWind * gust * gust;
      float glint = spec * grain * fine * breeze * (0.35 + 1.65 * uWeave);
      // And the surface's own energy: a footfall's crest and a rain-struck
      // patch both carry more slope than flat water, so the light gathers where
      // something is happening to the water. 光を編む.
      glint *= 0.4 + 1.6 * min(abs(h), 1.0);

      // The crest line.
      //
      // Specular alone is not enough to make a ring visible, and the reason is
      // worth stating because it looked like a tuning problem for two rounds:
      // the ring's only mechanism is displacement, and displacing a *uniform*
      // area produces nothing at all. Over the reflected cloud a pressed ring
      // reads beautifully; over the reference's deep navy — which is most of
      // the water — it was invisible, because moving navy onto navy is a
      // no-op.
      //
      // A real ring is visible there for a reason this pass was missing. The
      // crest is a band of steeply tilted water, and tilted water stops
      // reflecting the patch of sky directly above it and starts reflecting a
      // brighter patch nearer the horizon — so the ring draws itself as a thin
      // bright line whatever it is crossing. That is what this term is: a
      // slope-magnitude highlight, tinted by the horizon rather than by the
      // sun, so it appears on every crest and not only on the ones that happen
      // to be aimed at the light.
      // The window this opens in is set by the *shallowest* ring that still has
      // to be seen, and that is now the rain's — the rings above lost 60% of
      // their height when they became puddle rings rather than lake rings
      // (rainRings). A threshold fitted to the old amplitude would have taken
      // them off the water altogether, which is the failure the shallowing was
      // careful to avoid: the height came down and the wavelength came down
      // with it precisely so the *slope* would survive, and this is the term
      // that reads it. So the window moves down to meet it.
      float steep = smoothstep(1.10, 4.20, length(slope) * fine);
      //
      // Averaged across the sky rather than read column by column, and that is
      // the vertical striping on the umbrella.
      //
      // This was one tap: texture2D(tDiffuse, vec2(skyUv.x, uSkyV.x)) — a
      // single *row* of the sky, at the horizon, sampled at this pixel's own x.
      // Every crest in the pool and every square millimetre of the canopy's
      // sheen was then tinted by whatever that one row happens to hold directly
      // above it, and that row is the busiest in the frame: cloud, gap, cloud,
      // gap. Painting a horizontal profile over a tall area is the definition
      // of a vertical stripe, and the canopy — which takes this over a wide,
      // otherwise featureless sheet — showed it most.
      //
      // Five taps spread across a fifth of the frame. What a tilted facet
      // actually reflects is not the sky directly above it: it is a patch near
      // the horizon whose position depends on which way the facet happens to be
      // tilted, and the facets point everywhere. The honest quantity is
      // therefore the horizon's *average* brightness over a broad span, which
      // is what this is, and it has no column structure left to print.
      vec3 horizonLight = vec3(0.0);
      for (int i = -2; i <= 2; i++) {
        float u = clamp(skyUv.x + float(i) * 0.05, 0.001, 0.999);
        horizonLight += texture2D(tDiffuse, vec2(u, uSkyV.x)).rgb;
      }
      horizonLight = intoWater(horizonLight * 0.2, 0.0);

      // The reflected content: sky where the water is keyed, photograph where
      // something is painted on it.
      vec3 colour = mix(painted, water, key);

      // ...and then the *surface*, over all of it.
      //
      // This is what puts the girl in the water rather than on top of it. Until
      // now the crest lines and the glitter were mixed into 'water' and then
      // masked by the key, so every painted reflection — her, the umbrella, the
      // wires, the house — was the one thing in the pool with no surface in
      // front of it: perfectly clean while the sky beside it rippled and
      // sparkled. That reads exactly as what it was, a cut-out laid on the
      // picture, and no amount of displacement fixes it, because displacement
      // moves what is *under* the surface and this is about what is on it.
      //
      // Weighted by the interior rather than the key, because a specular
      // highlight is a property of the water's surface and does not care what
      // that surface happens to be reflecting.
      //
      // 0.28 rather than 0.16, and the raise is the answer to two separate
      // complaints that turn out to be one term.
      //
      // A pressed ring was reading as a displacement and almost nothing else,
      // which over the reference's deep navy — most of the water — is very
      // little. The crest is what a ring looks like: a band of tilted water
      // reflecting a brighter patch nearer the horizon, and it is the reason a
      // real ring is visible on dark water at all. It was set low enough to be
      // a hint.
      //
      // And it is the *only* thing in this pass that puts a surface over the
      // girl. She is painted, not keyed, so the reflection under her is the
      // photograph; the displacement she is allowed is a fifth of a shin's
      // width by necessity (uPhotoWarp), which means a ripple crossing her can
      // never be seen by moving her. It can be seen by *lighting* her — a crest
      // passing over a reflection lies in front of it and throws the horizon
      // back whatever is underneath, which is why the water in front of a
      // reflected figure flashes and the figure does not tear. Weighted by the
      // interior rather than the key for exactly that reason.
      colour = mix(colour, horizonLight, steep * 0.28 * (0.4 + 0.6 * uWeave) * interior);

      // The umbrella's own sheen.
      //
      // Lowering the key's exponent makes the vinyl pass less of the live water,
      // and past a point that stops helping: the canopy is painted almost
      // colourless, so less water through it just means more nothing. What
      // makes a clear sheet read as a sheet is not its own colour, it is that
      // it *reflects* — two air-vinyl interfaces return a few percent of the sky
      // whatever is behind them, which is why a clear umbrella is visible at all
      // on a bright day.
      //
      // A partial key is exactly where the vinyl is: fully keyed is open water,
      // unkeyed is the ink of its ribs, and everything between is the canopy.
      // So this peaks in the middle of that range and is zero at both ends.
      float vinyl = key * (1.0 - key) * 4.0;
      colour = mix(colour, horizonLight, vinyl * vinyl * 0.20 * interior);
      colour += uSunTint * glint * 1.35 * interior;

      gl_FragColor = vec4(colour, 1.0);
    }
  `,
};
