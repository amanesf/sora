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

  /**
   * The puddle's *interior*: everything inside its outline, including the
   * things painted on top of the water.
   *
   * The key says "this pixel is water". That is what the reflection needs and
   * it is not what the *displacement* needs, and the difference is the last
   * large falsehood in the picture. The wires, the pole, the reflected house
   * and the girl are all reflections lying on the same surface as the sky, so
   * when a ring crosses them they must bend with it — but they are not keyed,
   * because they have to survive on top of the live reflection. Until this
   * existed the water moved the sky and left every painted reflection standing
   * perfectly still, which is exactly the sort of thing an eye notices without
   * being able to say why.
   *
   * So: fill the key's holes. Anything not keyed and not reachable from the
   * frame's border without crossing water is inside the puddle — which is a
   * flood fill of the *background*, and it needs no hand-drawn outline. Then
   * erode and blur it, because the puddle's own rim must not move: the water
   * meets the asphalt at a fixed edge, and displacement has to fade out before
   * it gets there.
   *
   * Carried in the key image's alpha, so it costs no extra request and cannot
   * be separated from the key it belongs to. The colour channels are untouched,
   * which is what keeps effects/puddleShader.ts's magenta distance reading
   * exactly what it read before.
   */
  function puddleInterior(data) {
    const n = FRAME_WIDTH * FRAME_HEIGHT;
    const water = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (keyness(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) > 0.35 * 255) water[i] = 1;
    }
    // Flood the background: non-water, reachable from the border.
    const outside = new Uint8Array(n);
    const stack = [];
    for (let x = 0; x < FRAME_WIDTH; x++) {
      for (const y of [0, FRAME_HEIGHT - 1]) {
        const p = y * FRAME_WIDTH + x;
        if (!water[p] && !outside[p]) { outside[p] = 1; stack.push(p); }
      }
    }
    for (let y = 0; y < FRAME_HEIGHT; y++) {
      for (const x of [0, FRAME_WIDTH - 1]) {
        const p = y * FRAME_WIDTH + x;
        if (!water[p] && !outside[p]) { outside[p] = 1; stack.push(p); }
      }
    }
    while (stack.length) {
      const p = stack.pop();
      const x = p % FRAME_WIDTH;
      const y = (p / FRAME_WIDTH) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= FRAME_WIDTH || ny >= FRAME_HEIGHT) continue;
        const q = ny * FRAME_WIDTH + nx;
        if (water[q] || outside[q]) continue;
        outside[q] = 1;
        stack.push(q);
      }
    }
    // Inside = water, or a hole the background could not reach.
    let inside = new Uint8Array(n);
    for (let i = 0; i < n; i++) inside[i] = outside[i] ? 0 : 1;

    // Pull the edge in, so the rim itself never moves.
    const ERODE = 7;
    for (let pass = 0; pass < ERODE; pass++) {
      const next = new Uint8Array(n);
      for (let y = 1; y < FRAME_HEIGHT - 1; y++) {
        for (let x = 1; x < FRAME_WIDTH - 1; x++) {
          const p = y * FRAME_WIDTH + x;
          if (!inside[p]) continue;
          if (inside[p - 1] && inside[p + 1] && inside[p - FRAME_WIDTH] && inside[p + FRAME_WIDTH]) {
            next[p] = 1;
          }
        }
      }
      inside = next;
    }

    // ...and feather what is left, so the displacement arrives gradually rather
    // than switching on at a line of its own.
    const RADIUS = 11;
    let field = Float32Array.from(inside, (v) => v * 255);
    for (const horizontal of [true, false]) {
      const out = new Float32Array(n);
      for (let y = 0; y < FRAME_HEIGHT; y++) {
        for (let x = 0; x < FRAME_WIDTH; x++) {
          let sum = 0;
          let count = 0;
          for (let k = -RADIUS; k <= RADIUS; k++) {
            const sx = horizontal ? x + k : x;
            const sy = horizontal ? y : y + k;
            if (sx < 0 || sy < 0 || sx >= FRAME_WIDTH || sy >= FRAME_HEIGHT) continue;
            sum += field[sy * FRAME_WIDTH + sx];
            count++;
          }
          out[y * FRAME_WIDTH + x] = sum / count;
        }
      }
      field = out;
    }
    const alpha = Buffer.alloc(n);
    for (let i = 0; i < n; i++) alpha[i] = Math.max(0, Math.min(255, Math.round(field[i])));
    let interiorPx = 0;
    for (let i = 0; i < n; i++) if (alpha[i] > 128) interiorPx++;
    console.log(`interior       ${(100 * interiorPx / n).toFixed(1)}% of the frame carries displacement`);
    return alpha;
  }

  for (const [src, name] of [[refPath, 'ref.webp'], [maskPath, 'mask.webp']]) {
    const meta = await sharp(src).metadata();
    if (meta.width !== FRAME_WIDTH || meta.height !== FRAME_HEIGHT) {
      console.log(`${path.basename(src)}: ${meta.width}x${meta.height} -> ${FRAME_WIDTH}x${FRAME_HEIGHT}`);
    }
    let resized = sharp(src).resize(fit);
    if (name === 'mask.webp') {
      // The retouch first, so the interior is computed from the key the app
      // will actually read.
      const patched = await resized
        .composite([{ input: retouchSvg, top: 0, left: 0 }])
        .removeAlpha()
        .raw()
        .toBuffer();
      resized = sharp(patched, {
        raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 3 },
      }).joinChannel(puddleInterior(patched), {
        raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 1 },
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
