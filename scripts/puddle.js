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
   */
  const CHARACTER = [
    // The reflection: skirt, blouse, arm, head, and the umbrella under her.
    { cx: 1180, cy: 520, rx: 168, ry: 232 },
    // Her legs and shoes, on the wet road above the far lip.
    { cx: 1230, cy: 85, rx: 78, ry: 104 },
  ];

  function characterMask(maskData) {
    const n = FRAME_WIDTH * FRAME_HEIGHT;
    const chosen = new Float32Array(n);
    let px = 0;
    for (let y = 0; y < FRAME_HEIGHT; y++) {
      for (let x = 0; x < FRAME_WIDTH; x++) {
        let inside = 0;
        for (const e of CHARACTER) {
          const d = ((x - e.cx) / e.rx) ** 2 + ((y - e.cy) / e.ry) ** 2;
          // Soft to the ellipse's edge, so the lift has no boundary of its own.
          inside = Math.max(inside, Math.max(0, Math.min(1, (1.0 - d) / 0.35)));
        }
        if (inside <= 0) continue;
        const i = (y * FRAME_WIDTH + x) * 3;
        // Only what is drawn: the more water a pixel is, the less it lifts.
        const water = Math.max(0, Math.min(1,
          (keyness(maskData[i], maskData[i + 1], maskData[i + 2]) / 255 - 0.30) / 0.32));
        const w = inside * (1 - water);
        chosen[y * FRAME_WIDTH + x] = w * 255;
        if (w > 0.5) px++;
      }
    }
    // Feathered, so the lift arrives without an edge.
    const field = boxBlur(chosen, 4);
    console.log(`character      ${px} px lifted`);
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
   */
  const CHARACTER_LIFT = 2.05;

  // The key first: the interior and the character both come out of it, and the
  // photograph's lift depends on the second.
  const maskRaw = await sharp(maskPath)
    .resize(fit)
    .composite([{ input: retouchSvg, top: 0, left: 0 }])
    .removeAlpha()
    .raw()
    .toBuffer();
  const interiorAlpha = puddleInterior(maskRaw);
  const character = characterMask(maskRaw);

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
      // The character's lift, in linear light so it is an exposure on her
      // rather than a curve.
      const rgb = await resized.removeAlpha().raw().toBuffer();
      for (let i = 0; i < FRAME_WIDTH * FRAME_HEIGHT; i++) {
        const w = character[i] / 255;
        if (w < 0.004) continue;
        const gain = 1 + (CHARACTER_LIFT - 1) * w;
        for (let c = 0; c < 3; c++) {
          const v = rgb[i * 3 + c] / 255;
          const lit = Math.pow(Math.pow(v, 2.2) * gain, 1 / 2.2);
          rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(lit * 255)));
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
