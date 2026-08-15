/**
 * The picture, as a set of numbers. There is no console.
 *
 * The window app this is built out of had six rows of controls, and every one
 * of them was an offer to look at a different picture than the one the app
 * opened on. That made sense there: it was a sky, and a sky is an axis. This
 * app is a *reproduction* — there is one photograph, taken at one hour, in one
 * weather, and the whole job is to put the live sky back into it convincingly.
 * Every slider on that is a way of making the reference wrong, so the values
 * are fixed here at what the reference is, and the one control left is the
 * water: you press it (main.ts).
 *
 * `?cloud=`, `?rain=`, `?hour=` and the rest still override these, because the
 * capture harness needs to ask for a named frame (scripts/capture.js) and the
 * address bar is where it asks. Nothing in the app's own UI writes them.
 */

/**
 * 0.62 — sakura's own default, restored, and the story of why it left is worth
 * keeping.
 *
 * A little under the tower tier's peak: towers always present, open blue still
 * between them (scene/cloudField.ts's coverage curves). It is what the
 * reference's water holds — one big cumulus over deep blue.
 *
 * It was taken down to 0.42 and then 0.35 to fix a measured excess of white in
 * the water (94,103 white pixels against the reference's 25,125), and that was
 * the wrong lever pulled for a real reading. Coverage is what decides whether
 * the field makes *towers* at all: under about 0.5 the tower tier thins out and
 * what is left is a scatter of low cumulus, so the water filled with small flat
 * cloud — which is exactly what "the clouds are too low" describes, and it was
 * this line that caused it.
 *
 * The white was never a coverage problem. It was the reflection imaging the
 * entire hemisphere inside the water's few hundred rows, which puts several
 * times as much sky per pixel as a window does. That is fixed where it belongs,
 * in the mapping (scene/puddle.ts's WATER_SKY_V0/V1), and this goes back to the
 * value the parent project fitted everything at.
 */
export const CLOUD = 0.62;

/**
 * 0.06 — very nearly sakura's dry default, and for a measured reason.
 *
 * This is the rain in the *sky*: the streaks the inherited rain passes draw,
 * the visibility they close, and the cloud floor they impose. The reference has
 * none of it. There is not one visible falling streak in that frame, the far
 * side of the street is perfectly sharp, and the sky in the water is open blue
 * with one tower in it.
 *
 * The floor is what forces the number this low rather than taste. main.ts's
 * rainCloudFloor ramps in over the first tenth of the slider and lands on 0.72
 * coverage, which is correct — rain falls out of a deck, and there is no such
 * thing as a downpour under four fair-weather cumulus. But it means that even a
 * modest 0.16 here asks for 0.76 coverage, and measured, that closed the water
 * over: the render put 70,346 white pixels in the puddle against the
 * reference's 30,477, and the deep blue the reference is mostly made of had
 * nowhere left to be. At 0.06 the floor asks for 0.48, which is under CLOUD, so
 * the sky is the one the reference has.
 *
 * The rings and the sparks do not come from here — see DRIZZLE.
 */
export const RAIN = 0.06;

/**
 * 0.45 — the rain that is only visible where it lands.
 *
 * The reference is a picture of rain that has *just* stopped, or nearly: half a
 * dozen ring systems stand on the water, the air is full of small lit specks,
 * and there is not a streak anywhere. Those are not contradictory observations
 * and this is the setting that holds them apart. RAIN above is the weather —
 * the deck, the visibility, the streaks. This is the drop count at the surface:
 * how often something strikes the water and rings it
 * (effects/puddleShader.ts's rainRings), and how many drops the low sun has to
 * light on the way down (effects/goldenLight.ts's sparks).
 *
 * Keeping them separate is what lets the picture have the reference's rings and
 * the reference's gold without the reference's sky having to close.
 */
export const DRIZZLE = 0.45;

/**
 * 16.8 — late afternoon, sun low and to the side.
 *
 * Read off the reference rather than chosen: the light rakes across the
 * asphalt at a shallow angle and throws long specular streaks toward the
 * viewer, the wet stone is lit warm while the sky in the water is still
 * saturated blue with white tops on the cloud. That combination is only
 * available for about an hour — the sun low enough to be gold and rake, the
 * sky not yet dimmed toward dusk. Later than this and core/daylight.ts starts
 * taking the blue out of the water, which the reference still has.
 */
export const HOUR = 16.8;

/** 10x — sakura's default. A tower's ten-minute life in one minute, so the
 * sky is visibly happening while you watch it. */
export const SPEED = 10;

/**
 * 0.38 — enough chop that the water is water.
 *
 * A dead-flat puddle is a mirror, and a mirror is a picture of the sky with
 * none of the water in it. The reference's own surface carries a visible
 * texture between its rings; this is that texture, and it is low enough that
 * the reflected cloud stays legible as cloud.
 */
export const WATER = 0.38;

/** 0.62 — how much light the surface's slopes throw back. The reference is
 * lit hard from a low sun and its water glitters accordingly, so this sits
 * above the middle of its axis. */
export const WEAVE = 0.62;

/** 60. Nobody is being asked to choose, so the app draws at the rate it was
 * built for and the capture harness can still say `?fps=30`. */
export const FRAME_RATE = 60;
