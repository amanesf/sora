/**
 * The picture this app is: a rain puddle on asphalt, with the sky in it.
 *
 * The 窓辺 app (sakura) punched the sky out of an illustration and rendered the
 * real thing behind the hole. This one keeps that structure exactly — one
 * 1376x768 reference frame, a key that says which pixels are sky, a live
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
 * The sun's bearing, mirrored about the view axis.
 *
 * core/daylight.ts swings the sun toward the right of frame as the afternoon
 * goes on, and it does that for a stated reason: the window app is a fixed shot
 * out of one window, so the sun has to come to the window because the window
 * cannot turn to the sun. There is no window here. The water images the whole
 * hemisphere, the reference's light comes in over the viewer's *left* shoulder
 * and rakes away across the road, and at the inherited bearing the sun's glow
 * landed in the lower right of the reflection — which is the near water, the
 * part the reference keeps at its deepest navy, and a place the sun cannot be
 * without standing in front of the viewer and behind the water at once.
 * Measured, it put 69,699 white pixels in the puddle against the reference's
 * 25,125.
 *
 * The obvious fix — turn the camera around — does not work, and the way it
 * fails is worth recording: the cloud field is built around a centre 34km in
 * front of the camera (main.ts's CLOUD_FIELD_CENTER), so at 180° of yaw the
 * water reflected a completely cloudless sky. The field is a composition, not
 * an atmosphere; you cannot walk around it.
 *
 * So the sun moves instead of the camera. Mirroring the azimuth keeps its
 * elevation, its colour and every hour-driven constant exactly as fitted, moves
 * the glow to the far lip on the left where the reference is warm, and lands it
 * on the same side as the art-directed cloud key light (main.ts's
 * CLOUD_LIGHT_DIR, which has always come from the left) — so for the first time
 * in either app the sky's own sun and the light the clouds are shaded by agree
 * about where the light is coming from.
 */
export const MIRROR_SUN_AZIMUTH = true;

/**
 * The horizon haze band is gone, and it is worth recording why rather than
 * leaving a reader to wonder where it went.
 *
 * effects/horizonHaze.ts dissolves the last few degrees of sky above the
 * horizon into airlight, which is what made the window app's sea meet its sky
 * without a seam. This app's camera renders only the band of sky the water
 * images (core/frame.ts's waterBandRect), and that band starts about 20° up.
 * The horizon is not in the frame at all, so there is nothing for the haze to
 * dissolve — core/postFx.ts disables the pass rather than running it over a
 * band it cannot reach.
 */

/**
 * The screen v at which the water's mirror runs out — the vanishing line of the
 * ground plane, one row above the far lip of the largest puddle in the frame.
 *
 * This is the reflection's anchor. A pixel at v is imaging an elevation that
 * goes to zero as v approaches this line and to the zenith as it falls away
 * from it, and the shader's ground-plane coordinates are 1/(uHorizonV - v).
 * Measured off the reference's key by scripts/puddle.js: the topmost keyed row
 * is 77 of 768 — the sliver of water behind the reflected house — so the line
 * sits ten rows above that. It must not land *inside* the water, because the
 * shader divides by the distance from it.
 */
export const WATER_HORIZON_ROW = 67;

/**
 * How much ground plane one frame covers, in the shader's own units.
 *
 * Only two things read it — the wavelength of the wind chop and how fast a ring
 * travels — and both are quoted in metres-ish, so this is the number that says
 * what a metre is. 1.0 puts the near edge of the frame about a metre from the
 * eye, which is where you would be standing if you had just put a foot in it.
 */
export const GROUND_SCALE = 1.0;

/**
 * The band of sky the water images, as two rows of the rendered frame: the far
 * lip reads from the first, the viewer's feet from the second.
 *
 * The first version mapped the water onto the *whole* render — horizon to the
 * top of frame — on the reasoning that a puddle images the whole hemisphere.
 * That reasoning is right about the world and wrong about this picture, and
 * measuring it against the reference says so twice over.
 *
 * Measured over the reference's own keyed water, in eight bands from the far
 * lip down, the open sky in it runs (86,115,160) at the top to (35,49,83) at
 * the viewer's feet. The render mapped over the full hemisphere ran (130,158,188)
 * to (10,25,61): far too bright at the lip, far too dark underfoot — a gradient
 * roughly twice as steep as the picture's at both ends. That is not a colour
 * error, it is a geometry one. The whole hemisphere crammed into 650 rows puts
 * the bright horizon haze in the first inch of water and the near-black zenith
 * in the last, and no curve applied afterwards can undo a compression.
 *
 * The reference's water is a *shallow* pool seen from standing height, a couple
 * of metres across. The steepest thing in it is maybe 50° up, not 90°, and its
 * far lip is a metre or two away rather than at infinity — so it images a band
 * out of the low and middle sky, magnified, which is also why one cumulus fills
 * it. These two rows are that band.
 *
 * The band is also what sets the reflection's *magnification*, and therefore
 * how much of the water a cloud fills. Measured against the reference's own
 * cloud cover over the keyed water (35.4%), a band of 0.66 gave 17.9% — the
 * right sky at the wrong scale, a scatter of small cumulus where the reference
 * has one tower filling the pool. Narrowing it magnifies what the water reads
 * without touching what the sky is, which is the honest lever: it says the pool
 * is smaller and nearer, not that the weather is different.
 *
 * Whatever this band is, effects/puddleShader.ts's uSkyUScale narrows the
 * horizontal read to match it, so magnifying stays magnifying and does not
 * become stretching.
 */
export const WATER_SKY_V0 = 0.30;
export const WATER_SKY_V1 = 0.74;
