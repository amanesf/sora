/**
 * The picture this app is: a rain puddle on asphalt, with the sky in it.
 *
 * The 窓辺 app (sakura) punched the sky out of an illustration and rendered the
 * real thing behind the hole. This one keeps that structure exactly — one
 * 1408x768 reference frame, a key that says which pixels are sky, a live
 * atmosphere behind it — and changes one thing: **the hole is not a window, it
 * is water.** Everything that follows is a consequence of that.
 *
 *  - The sky in a puddle is *inverted*. What is painted at the far lip of the
 *    water is the horizon, and what is painted at your feet is the zenith. So
 *    the camera is aimed almost straight up (`CAMERA_HORIZON_FRACTION` below)
 *    and the reflection is read bottom-up (effects/puddleShader.ts).
 *  - It is inverted *in perspective*, not merely flipped. The water is a ground
 *    plane, so a ripple ring on it is an ellipse that shortens toward the far
 *    lip, and a wavelet's screen wavelength falls with its distance. The shader
 *    does its wave maths on the ground plane and lets the projection do that
 *    (`GROUND_SCALE`), rather than drawing circles in screen space.
 *  - A window is still; water is not. The reflection is displaced by the
 *    surface slope, which is where the app's two verbs come from: **空を歩く**
 *    (press the water and the sky moves under your foot) and **光を編む** (the
 *    slopes catch the sun, and the glints thread along them).
 *
 * The reference photograph and its key are the two assets in `app/public`.
 * Neither is required to run: without them the app keys a puddle-shaped region
 * of its own (`effects/puddleShader.ts`'s fallback) so the water, the ripples
 * and the light all still work. See `scripts/puddle.js`.
 */

/** The reference frame everything is anchored to, as in core/frame.ts. */
export const PUDDLE_REF = 'ref.webp';
export const PUDDLE_MASK = 'mask.webp';

/**
 * Where the rendered horizon is put, as a fraction of frame height.
 *
 * Near the *bottom*, which is the opposite of every scene in the window app and
 * is the whole point. The picture we want out of the 3D scene is not a view of
 * the world, it is the hemisphere the water is imaging: sky from the horizon up
 * to about 49°, with no ground in it anywhere. Putting the horizon on the last
 * row of the frame gives the reflection exactly that and no more — one row of
 * below-horizon sky is kept deliberately, so the far lip of the puddle has a
 * horizon to dissolve into instead of ending on open blue.
 */
export const CAMERA_HORIZON_FRACTION = 0.98;

/**
 * Frame rows for the haze band (effects/horizonHaze.ts), in the *rendered*
 * frame — not in the photograph.
 *
 * In the window app these were read off the painting, because the painted sea
 * and the rendered sky had to meet. Here the rendered horizon is never seen
 * directly: it is seen in the water, at the far lip. So the band is hung from
 * the rendered horizon itself, keeping the window app's 123-row depth, and the
 * reflection carries it to wherever the water's far edge happens to be.
 */
export const HORIZON_ROW = 753;
export const HAZE_TOP_ROW = 630;

/**
 * The screen v at which the water's mirror runs out — the vanishing line of the
 * ground plane, one row above the far lip of the largest puddle in the frame.
 *
 * This is the reflection's anchor. A pixel at v is imaging an elevation that
 * goes to zero as v approaches this line and to the zenith as it falls away
 * from it, and the shader's ground-plane coordinates are 1/(uHorizonV - v).
 * Measured off the reference's key: the topmost keyed row is 148 of 768, so the
 * vanishing line is just above it.
 */
export const WATER_HORIZON_ROW = 138;

/**
 * How much ground plane one frame covers, in the shader's own units.
 *
 * Only two things read it — the wavelength of the wind chop and how fast a ring
 * travels — and both are quoted in metres-ish, so this is the number that says
 * what a metre is. 1.0 puts the near edge of the frame about a metre from the
 * eye, which is where you would be standing if you had just put a foot in it.
 */
export const GROUND_SCALE = 1.0;
