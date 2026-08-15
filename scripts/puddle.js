#!/usr/bin/env node
/**
 * Builds the app's two assets out of the reference photograph and its key.
 *
 * Usage:
 *   node scripts/puddle.js <reference.png> <mask.png>
 *
 * The reference is the picture; the mask is the same picture with the water
 * painted over in flat magenta. Both are written into app/public at the frame
 * every constant in this project is expressed in (1376x768), and the second one
 * is measured on the way through, because two of the numbers in
 * app/src/scene/puddle.ts are properties of the key rather than choices:
 *
 *   - `WATER_HORIZON_ROW`, the vanishing line of the water's plane, which is
 *     one row above the topmost keyed pixel.
 *   - and whether the key is a key at all — the report prints what fraction of
 *     the frame it covers and how much of it is *partly* magenta, which is the
 *     number that says whether the paint was laid down flat or feathered.
 *
 * Why the key is a separate image rather than an alpha channel, which is what
 * the window app used (its scripts/plate.js flood-filled the sky to transparent
 * and shipped one RGBA plate):
 *
 * There, everything in front of the sky was opaque and everything behind it was
 * gone, so one image could carry both. Here the things lying *on* the water —
 * the power lines, the pole, the reflected house, the girl herself — have to
 * survive on top of the live reflection, which means the pass needs the
 * photograph's colour and its keyed-ness at the same pixel. That is two
 * channels' worth of independent information per pixel and it does not fit in
 * one RGBA image. It also means the key can be painted by hand in any editor,
 * over the picture, with the wires simply left alone — which is how the input
 * to this script was made.
 *
 * Nothing here is required to run the app. With neither asset present the water
 * keys a puddle shape of its own (effects/puddleShader.ts's FALLBACK) and every
 * other part of the picture — the sky, the clouds, the ripples, the light — is
 * exactly what it will be once the photograph arrives.
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const FRAME_WIDTH = 1376;
const FRAME_HEIGHT = 768;

/** The same test the shader runs, on the CPU: how magenta is this pixel.
 * See effects/puddleShader.ts's tMask. */
function keyness(r, g, b) {
  return Math.min(r, b) - g;
}

async function main() {
  const [refPath, maskPath] = process.argv.slice(2);
  if (!refPath || !maskPath) {
    console.error('usage: node scripts/puddle.js <reference.png> <mask.png>');
    process.exit(2);
  }
  for (const file of [refPath, maskPath]) {
    if (!fs.existsSync(file)) {
      console.error(`no such file: ${file}`);
      process.exit(2);
    }
  }

  /**
   * Marks painted *on* the water that the live water has to be allowed to take
   * back, filled into the key as more water.
   *
   * There is one: a decorative four-point sparkle at (1320, 708), sitting in
   * open water below the umbrella. Everything else drawn over the puddle in
   * this frame is an object — wires, the pole, the reflected house, the girl —
   * and belongs on top of a live reflection. A drawn sparkle is not an object,
   * it is a *rendering of light on water*, which is precisely the thing this
   * app now produces for itself. Left in the key it would sit there
   * motionless while the water under it moved, which reads as a smudge on the
   * lens rather than as light.
   *
   * Patched here rather than by hand in the image, so the assets stay a pure
   * function of the two inputs and this decision stays legible.
   */
  const RETOUCH = [{ cx: 1320, cy: 708, rx: 26, ry: 24 }];

  const outDir = path.join(__dirname, '..', 'app', 'public');
  fs.mkdirSync(outDir, { recursive: true });

  // `fill`, deliberately, and the report below is what makes that safe: both
  // images have to land on exactly the same grid as each other and as the
  // frame, because the key is looked up at the photograph's own UV. A `cover`
  // that cropped one of them by a row would misregister the two for good.
  const fit = { width: FRAME_WIDTH, height: FRAME_HEIGHT, fit: 'fill' };

  // The key's own paint colour, measured off the input rather than assumed:
  // this frame's is sRGB(206, 23, 248), not a mathematical magenta, and the
  // patches have to be the same colour as what is already there or they would
  // key at a different strength (effects/puddleShader.ts reads a distance, not
  // an equality).
  const PAINT = { r: 206, g: 23, b: 248 };
  const retouchSvg = Buffer.from(
    `<svg width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" xmlns="http://www.w3.org/2000/svg">`
    + RETOUCH.map((e) => `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" `
      + `fill="rgb(${PAINT.r},${PAINT.g},${PAINT.b})"/>`).join('')
    + '</svg>',
  );

  /** Separable box blur over a float field, used by both masks below. */
  function boxBlur(field, radius) {
    const n = FRAME_WIDTH * FRAME_HEIGHT;
    let src = field;
    for (const horizontal of [true, false]) {
      const out = new Float32Array(n);
      for (let y = 0; y < FRAME_HEIGHT; y++) {
        for (let x = 0; x < FRAME_WIDTH; x++) {
          let sum = 0;
          let count = 0;
          for (let k = -radius; k <= radius; k++) {
            const sx = horizontal ? x + k : x;
            const sy = horizontal ? y : y + k;
            if (sx < 0 || sy < 0 || sx >= FRAME_WIDTH || sy >= FRAME_HEIGHT) continue;
            sum += src[sy * FRAME_WIDTH + sx];
            count++;
          }
          out[y * FRAME_WIDTH + x] = sum / count;
        }
      }
      src = out;
    }
    return src;
  }

  /**
   * The puddle's *interior*: everywhere the water is locally in charge,
   * including the things painted on top of it.
   *
   * The key says "this pixel is water". That is what the reflection needs and
   * it is not what the *displacement* needs, and the difference is the last
   * large falsehood in the picture: the wires, the pole, the reflected house
   * and the girl are all reflections lying on the same surface as the sky, so
   * when a ring crosses them they must bend with it — but they are not keyed,
   * because they have to survive on top of the live reflection.
   *
   * The first version of this filled the key's holes: anything not keyed and
   * not reachable from the frame's border without crossing water. That is the
   * textbook answer and it quietly failed on the one region that matters, the
   * girl — her legs run off the top of the frame and her umbrella reaches the
   * right edge, so the flood found its way in and called her background.
   *
   * "Locally surrounded by water" has no such hole. Blur the key and ask
   * whether water dominates the neighbourhood: inside the pool that is 1
   * whatever is drawn on top, on the road it is 0, and at the rim it falls off
   * over the blur's own radius — which is also the feather the displacement
   * needs, since the water meets the asphalt at an edge that must not move.
   *
   * Carried in the key image's alpha, so it costs no extra request and cannot
   * be separated from the key it belongs to.
   */
  function puddleInterior(data) {
    const n = FRAME_WIDTH * FRAME_HEIGHT;
    const water = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      water[i] = keyness(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) > 0.35 * 255 ? 255 : 0;
    }
    const near = boxBlur(water, 26);
    const alpha = Buffer.alloc(n);
    let inside = 0;
    for (let i = 0; i < n; i++) {
      // 0 where less than a third of the neighbourhood is water, 1 by two
      // thirds. Wide, because it is doing the feathering as well.
      const t = Math.max(0, Math.min(1, (near[i] / 255 - 0.34) / 0.30));
      const v = Math.round(255 * t * t * (3 - 2 * t));
      alpha[i] = v;
      if (v > 128) inside++;
    }
    console.log(`interior       ${(100 * inside / n).toFixed(1)}% of the frame carries displacement`);
    return alpha;
  }

  /**
   * The girl, as two measured ellipses.
   *
   * She is the subject of the picture and she is also the darkest large thing
   * in it — a reflection, in water, of someone standing against the light. An
   * illustration can carry that; a screen in daylight cannot, and she was
   * disappearing into the navy.
   *
   * Two attempts to find her automatically are worth recording, because both
   * failed for the same reason and it is a useful one. Inside the puddle,
   * everything not keyed is something painted on top of the water, so "large
   * non-keyed island in the right of the frame" ought to be exactly her. Filling
   * the key's holes to find those islands leaks: her legs run off the top of the
   * frame and her umbrella reaches its right edge, so the flood gets in and
   * calls her background. Asking instead whether water dominates the
   * neighbourhood works at her outline and fails in her middle — a 53px window
   * placed inside a 120px-wide figure sees no water at all. A region test cannot
   * find a large object *by* its surroundings.
   *
   * So she is measured, like HORIZON_ROW and every other constant here that
   * describes this particular frame: her reflection with its umbrella, and her
   * legs and shoes above the water's far lip. Weighted by how *un*-keyed each
   * pixel is, so the water inside the ellipses is left exactly alone and only
   * what is drawn on it lifts.
   *
   * Which works for one of the two and not for the other, and the difference is
   * what the key is. Over the puddle, an ellipse is allowed to be crude because
   * the key is doing the real cutting underneath it: everything the ellipse
   * catches that is not her is water, and water is exactly what `1 - water`
   * removes. Above the far lip there is no key — her legs stand on road, which
   * is painted by nobody — so nothing removes the road, and the ellipse grades
   * every asphalt pixel it covers. It showed up the moment the grade got strong
   * enough to see: a bright oval of road around her feet, a disc with her legs
   * inside it. The street is the one thing in this app that is supposed to be
   * the photograph and nothing else.
   *
   * The discriminator that works up there is colour, and it works because of
   * what is up there: wet asphalt reflecting a blue sky, and a girl made of
   * skin and leather. Warmth (r - b) over that ellipse is two populations with
   * a floor between them — the road piles up around -30 and everything of hers
   * is above 0 — so the second ellipse asks for warmth as well as position.
   * This is the region test that the two failures above were reaching for, and
   * the reason it lands is that it is not a region test: it asks what a pixel
   * *is*, not what its neighbours are.
   *
   * Two ellipses were also one short, and both of the ones there were had been
   * drawn to hug her. Hugging left her cut in two places at once:
   *
   *  - Her legs run off the top of the frame and the ellipse did not. Its soft
   *    edge crossed her shins in the frame's last rows, so the grade faded out
   *    along them — which on a figure whose legs leave the picture reads
   *    exactly as legs that stop.
   *  - Between the two was a gap of about a hundred rows, from the waterline
   *    down to where the lower one began, and her reflected legs run through
   *    it: graded legs above, ungraded band, graded skirt below.
   *
   * The one that reaches the top of the frame has to be the warm one, because
   * above the waterline the key is not protecting anything. The gap wants the
   * opposite: her legs in the water are a reflection in blue water and their
   * warmth is a median of -5, nothing a colour cut can find, so it has to be a
   * shape and the key has to do the cutting. Widening the lower ellipse to
   * reach up there is what does not work — it is 168px wide because her
   * umbrella is, and at that width it arrives over the bed of pebbles to her
   * right, which is not keyed either and came out visibly lifted. So the gap
   * gets its own ellipse, narrow enough to pass between her legs and those
   * stones: 30px of clearance, which is what the frame offers.
   */
  const CHARACTER = [
    // The reflection: skirt, blouse, arm, head, and the umbrella under her.
    // Cut by the key underneath, so it only has to contain her.
    { cx: 1180, cy: 520, rx: 168, ry: 232 },
    // Her legs in the water, from the near edge down to the skirt: the span
    // between the other two. Narrow, to clear the pebbles at x 1276.
    { cx: 1200, cy: 235, rx: 75, ry: 90 },
    // Her legs and shoes, on the wet road above the far lip, running off the
    // top of the frame. Nothing is keyed up here, so this one carries its own
    // cut: warm is her, cool is the road.
    { cx: 1230, cy: 10, rx: 130, ry: 230, warmOnly: true },
  ];

  /**
   * Where warmth stops being road and starts being her, in r - b. The floor
   * between the two populations in this frame is wide — the road's warm tail
   * ends around -5 and her shadowed skin begins around +10 — so the edges sit
   * on either side of it rather than at a single threshold.
   */
  const CHARACTER_WARM = [0, 24];

  /**
   * How far the warm cut is grown before it is used, in pixels.
   *
   * She is drawn with an ink outline and the ink is neither warm nor cool, so
   * the cut lands *inside* her own line and leaves it at the photograph's
   * exposure — which on a figure this size is not a subtle artefact, it is a
   * grey seam around a graded shoe. Grown by a little more than the line is
   * wide, the outline comes with her. It also puts a few pixels of road inside
   * the cut, which is the trade and the right side of it: a lift that follows
   * her silhouette reads as light behind her, and one that follows an ellipse
   * reads as a lens smudge.
   */
  const CHARACTER_INK = 4;

  /** Largest value within `radius`, on the same field type as boxBlur. */
  function dilate(field, radius) {
    const out = new Float32Array(FRAME_WIDTH * FRAME_HEIGHT);
    for (let y = 0; y < FRAME_HEIGHT; y++) {
      for (let x = 0; x < FRAME_WIDTH; x++) {
        let max = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy > radius * radius) continue;
            const sx = x + dx;
            const sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= FRAME_WIDTH || sy >= FRAME_HEIGHT) continue;
            max = Math.max(max, field[sy * FRAME_WIDTH + sx]);
          }
        }
        out[y * FRAME_WIDTH + x] = max;
      }
    }
    return out;
  }

  function characterMask(maskData, refData) {
    const n = FRAME_WIDTH * FRAME_HEIGHT;
    // Two fields rather than one, because the warm cut has to be grown by the
    // ink's width and the keyed one must not be — growing that one would push
    // the grade out over the water at her silhouette, where the key is the
    // whole point.
    const keyed = new Float32Array(n);
    const warm = new Float32Array(n);
    for (let y = 0; y < FRAME_HEIGHT; y++) {
      for (let x = 0; x < FRAME_WIDTH; x++) {
        for (const e of CHARACTER) {
          const d = ((x - e.cx) / e.rx) ** 2 + ((y - e.cy) / e.ry) ** 2;
          // Soft to the ellipse's edge, so the lift has no boundary of its own.
          const inside = Math.max(0, Math.min(1, (1.0 - d) / 0.35));
          if (inside <= 0) continue;
          const i = (y * FRAME_WIDTH + x) * 3;
          if (!e.warmOnly) {
            keyed[y * FRAME_WIDTH + x] = Math.max(keyed[y * FRAME_WIDTH + x], inside);
            continue;
          }
          const t = Math.max(0, Math.min(1,
            (refData[i] - refData[i + 2] - CHARACTER_WARM[0])
            / (CHARACTER_WARM[1] - CHARACTER_WARM[0])));
          warm[y * FRAME_WIDTH + x] = Math.max(
            warm[y * FRAME_WIDTH + x], inside * t * t * (3 - 2 * t),
          );
        }
      }
    }

    const grown = dilate(warm, CHARACTER_INK);
    const chosen = new Float32Array(n);
    let px = 0;
    for (let i = 0; i < n; i++) {
      const inside = Math.max(keyed[i], grown[i]);
      if (inside <= 0) continue;
      // Only what is drawn: the more water a pixel is, the less it lifts.
      const water = Math.max(0, Math.min(1,
        (keyness(maskData[i * 3], maskData[i * 3 + 1], maskData[i * 3 + 2]) / 255 - 0.30) / 0.32));
      const w = inside * (1 - water);
      chosen[i] = w * 255;
      if (w > 0.5) px++;
    }
    // Feathered, so the lift arrives without an edge.
    const field = boxBlur(chosen, 4);
    console.log(`character      ${px} px graded`);
    return field;
  }

  /**
   * How much brighter she is made: a linear-light gain, so it is a change of
   * exposure on her and not a contrast curve.
   *
   * A full stop of it. 1.22 was the first value — about a quarter of a stop, on
   * the reasoning that she is backlit and ought to read as a silhouette — and
   * on a screen she stayed inside the navy. The reasoning was right about the
   * illustration and wrong about the medium: a painting is looked at in a
   * gallery's light and this is looked at on a phone, outdoors, next to a
   * highlight of 250. Against that, a subject at 40 is not a silhouette, it is
   * absent.
   *
   * The aim is still that she reads as backlit — her face and the fold of her
   * skirt legible, the light still coming from behind her — not that she is lit
   * from the front. In linear light, so it is an exposure on her rather than a
   * contrast curve, which is what keeps her own modelling intact while it
   * moves.
   *
   * The exposure was right and it was not enough, and the measurement says
   * exactly why. Over her pixels, before and after:
   *
   *                 5th / median / 95th        chroma
   *   photograph      31 /  68 / 110  (79)      0.284
   *   lifted          42 /  93 / 151  (109)     0.284
   *   the cloud       64 /  91 / 205  (141)     0.385
   *
   * A gain moves a subject; it cannot make one. It carried her median to 93,
   * which is the cloud's own median — so she now sits at the brightness of the
   * brightest thing in the frame while spanning three quarters of its range and
   * none of its colour. That is the description of a grey card. The skirt is
   * the tell: navy serge at 68 became grey at 93, because there was nothing in
   * a gain to keep its shadow dark while its lit edge rose.
   *
   * So the same three things a colourist would reach for, in the order they are
   * always reached for, and all in linear light — and, the part that took two
   * more passes to get right, actually separate from each other. Exposure
   * scales, contrast shapes tone, chroma moves colour, and each is allowed to
   * do only its own job: see CHARACTER_CHROMA for what happens when the middle
   * one is quietly doing the third one's as well.
   *
   * The three values below were first set to land her at the cloud's own range
   * — 145 against 142 — on the reasoning that matching it was the target. It
   * was not; it was the floor. Matched, she was no longer flat and she was
   * still the quieter of the two, because the cloud is also the brightest thing
   * in the frame and a subject that merely ties the backdrop loses. Where they
   * sit now is a stop past that, and the stop after that one is not available:
   * her 99th percentile is at 252 and the blouse stops having folds at 255,
   * which is the same disappearance as the grey skirt, arrived at from above.
   */
  const CHARACTER_LIFT = 2.30;
  /**
   * Contrast, about her own middle rather than the frame's. Pivoting on mid
   * grey would simply be a second exposure on her, since all of her is below
   * it; pivoting on her median darkens the serge and the hair and opens the
   * blouse and the rim on her legs, which is what "she is flat" actually means.
   *
   * At 1.50 her range is 173 against the cloud's 141 — wider than the thing she
   * is standing next to, which is the right way round for a subject and is only
   * affordable because the curve is a power about a pivot rather than a gain:
   * the shadow end compresses as it darkens instead of clipping, so the serge
   * goes to 29 rather than to nothing.
   *
   * It was 1.60 while the curve ran on the channels separately, and the drop to
   * 1.50 is not a retreat: on luminance the same number moves more, because
   * none of it is being spent spreading the channels apart. 1.60 here reaches
   * 254 at her 99th percentile against 252, which is the blouse beginning to
   * go.
   */
  const CHARACTER_CONTRAST = 1.50;
  /**
   * Chroma about luma, so it moves colour without moving the brightness the
   * two constants above just settled. She is not a grey subject — the serge is
   * blue, the ribbon is blue, the skin is warm — and the gain preserved the
   * *ratios* between her channels, which is precisely why it could not restore
   * what a dark subject loses: chroma read at a distance is a distance, and
   * hers was small because she was dark.
   *
   * The smallest of the three moves, and it used to be smaller still on paper
   * and enormous in fact. The contrast above ran on the channels separately,
   * and a power curve applied per channel spreads them apart: a channel over
   * the pivot grows while one under it shrinks, which is the definition of
   * saturating. So a nominal 1.40 arrived as very nearly a doubling — the
   * serge went 0.42 -> 0.71, the shoes 0.19 -> 0.42 — and the picture read as
   * sunburnt, because the effect is largest exactly where a channel is
   * furthest from the others, which on a figure is her skin and her leather.
   *
   * Measured at the time and misread: the swatch table said the hues had barely
   * moved, 223 -> 222 on the serge, and hue holding is what "no colour cast"
   * looks like, so the number was taken as a clean bill. Saturation was in the
   * same table, doubled, and it is the one that makes a colour look wrong when
   * the hue is right. What "unnatural, red?" describes is not a hue at all.
   *
   * With the curve on luminance the two are separate again and this constant is
   * the only thing moving colour, so it says what it does: 1.25, against her
   * own photographed chroma, taking the serge to 0.48 and her skin to 0.18.
   */
  const CHARACTER_CHROMA = 1.25;
  /**
   * Where the contrast pivots: her median in the photograph, 68 of 255,
   * measured over the same weighted pixels the grade is applied to and carried
   * through the exposure with it. Written as a constant like every other number
   * here that is a property of this frame rather than a choice.
   */
  const CHARACTER_PIVOT = Math.pow(68 / 255, 2.2);

  // The key first: the interior and the character both come out of it, and the
  // photograph's grade depends on the second. The character also needs the
  // photograph itself — above the far lip it is the colour, not the key, that
  // says which pixels are hers.
  const maskRaw = await sharp(maskPath)
    .resize(fit)
    .composite([{ input: retouchSvg, top: 0, left: 0 }])
    .removeAlpha()
    .raw()
    .toBuffer();
  const refRaw = await sharp(refPath).resize(fit).removeAlpha().raw().toBuffer();
  const interiorAlpha = puddleInterior(maskRaw);
  const character = characterMask(maskRaw, refRaw);

  for (const [src, name] of [[refPath, 'ref.webp'], [maskPath, 'mask.webp']]) {
    const meta = await sharp(src).metadata();
    if (meta.width !== FRAME_WIDTH || meta.height !== FRAME_HEIGHT) {
      console.log(`${path.basename(src)}: ${meta.width}x${meta.height} -> ${FRAME_WIDTH}x${FRAME_HEIGHT}`);
    }
    let resized = sharp(src).resize(fit);
    if (name === 'mask.webp') {
      resized = sharp(maskRaw, {
        raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 3 },
      }).joinChannel(interiorAlpha, {
        raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 1 },
      });
    } else {
      // The character's grade: exposure, contrast, chroma, in linear light.
      //
      // The mask used to be folded into the exposure itself (a gain of
      // `1 + (LIFT - 1) * w`), which was exact for one operation and does not
      // generalise — a weighted contrast is not a contrast at a weighted
      // exponent. So she is graded in full and then mixed back by the mask,
      // which is the same thing at w = 1 and w = 0 and the honest thing
      // between: at the feathered rim she is a blend of graded and un-graded
      // rather than the result of a weaker curve.
      const rgb = Buffer.from(refRaw);
      const pivot = CHARACTER_PIVOT * CHARACTER_LIFT;
      for (let i = 0; i < FRAME_WIDTH * FRAME_HEIGHT; i++) {
        const w = character[i] / 255;
        if (w < 0.004) continue;
        const lit = [0, 1, 2].map(
          (c) => Math.pow(rgb[i * 3 + c] / 255, 2.2) * CHARACTER_LIFT,
        );
        // The contrast runs on luminance and returns a single factor that all
        // three channels are scaled by, which is what makes it a contrast:
        // scaling a colour leaves its ratios, and so its hue and its
        // saturation, exactly where they were. Running the curve on the
        // channels separately instead — the first version of this — is a
        // saturation control wearing a contrast's name. See CHARACTER_CHROMA.
        const luma = 0.2126 * lit[0] + 0.7152 * lit[1] + 0.0722 * lit[2];
        const toned = pivot * Math.pow(Math.max(luma, 1e-6) / pivot, CHARACTER_CONTRAST);
        const tone = toned / Math.max(luma, 1e-6);
        for (let c = 0; c < 3; c++) {
          // Clamped before the encode, not after: a negative channel is what a
          // chroma gain produces at the gamut's edge and it is not a colour.
          const saturated = Math.min(1, Math.max(0, toned + (lit[c] * tone - toned) * CHARACTER_CHROMA));
          const graded = Math.pow(saturated, 1 / 2.2);
          const v = rgb[i * 3 + c] / 255;
          rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(255 * (v + (graded - v) * w))));
        }
      }
      resized = sharp(rgb, {
        raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 3 },
      });
    }
    await resized
      // Near-lossless for the key: its whole content is a flat colour and the
      // hard boundaries between that colour and the wires drawn over it, which
      // is precisely what a lossy codec spends its budget destroying. The
      // photograph is an ordinary photograph and takes ordinary quality.
      .webp(name === 'mask.webp' ? { nearLossless: true, quality: 100 } : { quality: 92 })
      .toFile(path.join(outDir, name));
    const bytes = fs.statSync(path.join(outDir, name)).size;
    console.log(`app/public/${name}  ${(bytes / 1024).toFixed(1)} KB`);
  }

  /**
   * Measure her, in the file that shipped.
   *
   * The three constants above are answers to a comparison — her tonal range and
   * her chroma against the cloud she is standing next to — and a comparison
   * that is only made once is a comparison nobody can check. Printed here, in
   * the same units the constants were fitted in, so the next change to any of
   * them starts from the frame's own numbers rather than from this paragraph.
   *
   * The cloud in the photograph, not the rendered one, deliberately: the live
   * sky moves and the light on it is chosen per visit, so the only stable thing
   * to hold her against is the painting the illustrator balanced her against.
   */
  {
    const ref = await sharp(path.join(outDir, 'ref.webp')).removeAlpha().raw().toBuffer();
    /** A patch of the reflected cumulus, clear of the girl and the wires. */
    const CLOUD = { x0: 430, x1: 700, y0: 330, y1: 560 };
    const region = (pick) => {
      const luma = [];
      const chroma = [];
      for (let y = 0; y < FRAME_HEIGHT; y++) {
        for (let x = 0; x < FRAME_WIDTH; x++) {
          if (!pick(x, y)) continue;
          const i = (y * FRAME_WIDTH + x) * 3;
          const r = ref[i] / 255;
          const g = ref[i + 1] / 255;
          const b = ref[i + 2] / 255;
          luma.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
          const max = Math.max(r, g, b);
          chroma.push(max <= 0 ? 0 : (max - Math.min(r, g, b)) / max);
        }
      }
      luma.sort((a, b) => a - b);
      const at = (p) => Math.round(255 * luma[Math.floor(p * (luma.length - 1))]);
      const mean = chroma.reduce((s, v) => s + v, 0) / chroma.length;
      const [lo, mid, hi] = [at(0.05), at(0.5), at(0.95)];
      return `${String(lo).padStart(3)} /${String(mid).padStart(4)} /${String(hi).padStart(4)}`
        + `  (${String(hi - lo).padStart(3)})   ${mean.toFixed(3)}`;
    };
    console.log('');
    console.log('                5th / median / 95th  (range)  chroma');
    console.log(`  girl        ${region((x, y) => character[y * FRAME_WIDTH + x] / 255 > 0.6)}`);
    console.log(`  cloud       ${region((x, y) => x > CLOUD.x0 && x < CLOUD.x1 && y > CLOUD.y0 && y < CLOUD.y1)}`);
  }

  // Measure the key.
  const { data } = await sharp(path.join(outDir, 'mask.webp'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let keyed = 0;
  let partial = 0;
  let topRow = FRAME_HEIGHT;
  let bottomRow = -1;
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const i = (y * FRAME_WIDTH + x) * 3;
      const k = keyness(data[i], data[i + 1], data[i + 2]) / 255;
      if (k <= 0.35) continue;
      keyed++;
      // Between the shader's two smoothstep edges: neither paint nor picture.
      if (k < 0.72) partial++;
      if (y < topRow) topRow = y;
      if (y > bottomRow) bottomRow = y;
    }
  }

  const total = FRAME_WIDTH * FRAME_HEIGHT;
  console.log('');
  console.log(`keyed          ${(100 * keyed / total).toFixed(1)}% of the frame`);
  console.log(`partial        ${(100 * partial / Math.max(keyed, 1)).toFixed(1)}% of the key sits between the shader's edges`);
  if (bottomRow < 0) {
    console.log('no keyed pixels at all — is the water painted magenta (255,0,255)?');
    return;
  }
  console.log(`keyed rows     ${topRow}..${bottomRow} of ${FRAME_HEIGHT}`);
  console.log('');
  console.log(`=> app/src/scene/puddle.ts: WATER_HORIZON_ROW = ${Math.max(topRow - 10, 0)}`);
  console.log('   (the vanishing line sits just above the far lip; the shader');
  console.log('    divides by the distance from it, so it must not land inside');
  console.log('    the water — ten rows of clearance is what that costs.)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
