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
 * 0.56 rather than exactly 0.62 is the one small concession: the water images a
 * magnified band of sky, so a cloud that breaks a window's view in two closes a
 * puddle's completely, and the reference has open blue around its tower on
 * every side. It stays well above the tier's tower threshold, which is the
 * property that matters here.
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
export const CLOUD = 0.56;

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
 *
 * 0.62 rather than the 0.45 it started at: at 0.45 the rings were there in
 * motion and invisible in a still frame, which for a picture whose whole
 * subject is a surface being disturbed is the wrong side of the line to be on.
 * The reference holds about six ring systems wide enough to count the rings in,
 * and this is where a still frame holds about that many.
 *
 * It stays here while the rain is halved, and that is deliberate rather than an
 * oversight. This slider is an *intensity*, and both of the things it drives
 * read it twice: the rings get their rate and their height from it, the sparks
 * their count and their brightness. Taking it to 0.31 to halve the rain would
 * therefore also halve how tall a ring stands — and a ring at half height in
 * this water is not a quieter ring, it is no ring at all, which is the state
 * 0.45 was raised out of in the first place. So the halving is done where the
 * rain's *rate* is, in effects/puddleShader.ts's rainRings period and
 * effects/goldenLight.ts's uDensity, and this stays at the intensity the
 * reference has. Half as many drops, each one exactly as it was.
 */
export const DRIZZLE = 0.62;

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

/**
 * Which second the sky starts on.
 *
 * The window app started this at random, and there it was exactly right: that
 * app is a sky you watch for a while, and a different sky every visit is the
 * point. This app is a *picture* — one composition, one hour, one weather, and
 * a pool of water showing a magnified patch of sky about as wide as a single
 * cumulus. Which second the clock starts on therefore decides whether the first
 * thing anyone sees is a tower standing over open blue or a smear of low cloud
 * across one corner, and at random it is the second about as often as the first.
 * The front door should be the good one.
 *
 * Chosen from a measured shortlist rather than by hunting: scripts/audition.js
 * steps one browser through candidate seconds and reports, for each, how much
 * of the water is cloud, where the cloud's weight sits, and what share of it is
 * in a single mass. What it cannot do is pick — the run that produced this
 * value ranked a flat slab of overcast first, because "one mass, filling the
 * frame" is exactly what a wall is. So the numbers narrow fourteen candidates
 * to four and the choice among those four is made by looking, which is the
 * honest division of labour: a statistic can say which frames are *not* worth
 * looking at.
 *
 * 6300 is a cumulus across the upper water with deep blue under it and the far
 * lip clear — the reference's own composition, arrived at independently.
 *
 * `?t=` still overrides, which is what keeps every capture reproducible.
 */
export const OPENING_T = 6300;

/** 10x — sakura's default. A tower's ten-minute life in one minute, so the
 * sky is visibly happening while you watch it. */
export const SPEED = 10;

/**
 * 0.11 — barely any, which is what a puddle actually has.
 *
 * A dead-flat puddle is a mirror, and a mirror is a picture of the sky with
 * none of the water in it, so this is not zero. But it was 0.38, and combined
 * with wind trains an order of magnitude too long (effects/puddleShader.ts's
 * chop) it put a slow meandering distortion across the whole pool — the
 * reflection swimming about in snaking bands. The reference's water is very
 * nearly glass: what disturbs it is drops landing on it, one ring at a time,
 * and between the rings you can read the cloud's outline as clearly as if it
 * were the sky itself.
 */
export const WATER = 0.11;

/** 0.62 — how much light the surface's slopes throw back. The reference is
 * lit hard from a low sun and its water glitters accordingly, so this sits
 * above the middle of its axis. */
export const WEAVE = 0.62;

/**
 * The finishing grade, over the whole frame including the photograph
 * (effects/finalGrade.ts).
 *
 * Every other number in this file describes the scene. These two describe the
 * *print*, and they are the only place in the app where something is set
 * because of how it looks rather than because of what it measures — which is
 * what a grade is, and why it is one pass with two knobs at the very end
 * instead of a thumb on the scale of six fitted constants upstream.
 *
 * Modest on purpose. 1.16 and 1.10 are about a third of a stop of contrast and
 * a nudge of colour: enough that the blue in the water reads as blue and the
 * road keeps its warmth apart from it, and not so much that the illustration
 * stops looking like the illustration it is.
 */
export const FINAL_SATURATION = 1.16;
export const FINAL_CONTRAST = 1.10;

/** 60. Nobody is being asked to choose, so the app draws at the rate it was
 * built for and the capture harness can still say `?fps=30`. */
export const FRAME_RATE = 60;
