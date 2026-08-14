#!/usr/bin/env node
/**
 * Builds the app's two assets out of the reference photograph and its key.
 *
 * Usage:
 *   node scripts/puddle.js <reference.png> <mask.png>
 *
 * The reference is the picture; the mask is the same picture with the water
 * painted over in flat magenta. Both are written into app/public at the frame
 * every constant in this project is expressed in (1408x768), and the second one
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

const FRAME_WIDTH = 1408;
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

  const outDir = path.join(__dirname, '..', 'app', 'public');
  fs.mkdirSync(outDir, { recursive: true });

  // `fill`, deliberately, and the report below is what makes that safe: both
  // images have to land on exactly the same grid as each other and as the
  // frame, because the key is looked up at the photograph's own UV. A `cover`
  // that cropped one of them by a row would misregister the two for good.
  const fit = { width: FRAME_WIDTH, height: FRAME_HEIGHT, fit: 'fill' };

  for (const [src, name] of [[refPath, 'ref.webp'], [maskPath, 'mask.webp']]) {
    const meta = await sharp(src).metadata();
    if (meta.width !== FRAME_WIDTH || meta.height !== FRAME_HEIGHT) {
      console.log(`${path.basename(src)}: ${meta.width}x${meta.height} -> ${FRAME_WIDTH}x${FRAME_HEIGHT}`);
    }
    await sharp(src)
      .resize(fit)
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
  const { data } = await sharp(maskPath)
    .resize(fit)
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
