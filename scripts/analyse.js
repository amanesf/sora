#!/usr/bin/env node
/**
 * What the reference's water actually is, band by band — and what the render
 * makes of the same pixels.
 *
 * The whole-water averages that fitted effects/puddleShader.ts's response curve
 * were true and not sufficient: two pictures can agree on their mean colour and
 * disagree about where the cloud is, how far up the water it reaches, and how
 * much of the frame it covers, which are the three things anyone actually looks
 * at. So this reports the water in horizontal bands from the far lip to the
 * viewer's feet, and per band:
 *
 *   cover   what fraction of the band is cloud rather than open sky
 *   cloud   the mean colour of that cloud
 *   sky     the mean colour of the open sky beside it
 *
 * Cloud and open sky are separated by saturation, not by brightness. In this
 * picture the sky is the most saturated thing in the frame (b − r ≈ 70) and the
 * cloud is very nearly neutral whatever its exposure, so a saturation test
 * splits them at both the sunlit crown and the shadowed base, where a luminance
 * threshold puts the crown with the sky and the base with the water.
 *
 * Usage: node scripts/analyse.js <render.png> [reference.png] [mask.png]
 */
const sharp = require('sharp');

const W = 1376;
const H = 768;
const BANDS = 8;

async function raw(file) {
  const { data } = await sharp(file)
    .removeAlpha()
    .resize(W, H, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

/** The shader's own key test (effects/puddleShader.ts's tMask). */
const keyness = (d, i) => Math.min(d[i], d[i + 2]) - d[i + 1];

/** Cloud or open sky. See the note above on why this is saturation. */
const isCloud = (d, i) => d[i + 2] - d[i] < 42
  // ...and bright enough to be cloud at all. Saturation alone calls the near
  // water's own darkness "cloud", because a very dark navy has little blue-red
  // separation left in it: at (35,49,83) the difference is 48, at (42,57,85) it
  // is 43. Both are water, not sky. This threshold is well under the reference's
  // dimmest real cloud (136,134,139) and well over its brightest near water.
  && (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) > 95;

function bandStats(data, mask, band) {
  const y0 = Math.round(band * H / BANDS);
  const y1 = Math.round((band + 1) * H / BANDS);
  let n = 0;
  const acc = { cloud: [0, 0, 0, 0], sky: [0, 0, 0, 0] };
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (keyness(mask, i) < 150) continue;
      n++;
      const bucket = isCloud(data, i) ? acc.cloud : acc.sky;
      bucket[0] += data[i];
      bucket[1] += data[i + 1];
      bucket[2] += data[i + 2];
      bucket[3]++;
    }
  }
  const mean = (b) => (b[3] ? [0, 1, 2].map((c) => Math.round(b[c] / b[3])) : null);
  return {
    rows: [y0, y1],
    water: n,
    cover: n ? acc.cloud[3] / n : 0,
    cloud: mean(acc.cloud),
    sky: mean(acc.sky),
  };
}

const show = (c) => (c ? c.map((v) => String(v).padStart(3)).join(',') : '  -,  -,  -');

async function main() {
  const [renderPath, refPath = '1786749714512.png', maskPath = '1786747444132.png'] =
    process.argv.slice(2);
  if (!renderPath) {
    console.error('usage: node scripts/analyse.js <render.png> [reference.png] [mask.png]');
    process.exit(2);
  }
  const [render, ref, mask] = await Promise.all([raw(renderPath), raw(refPath), raw(maskPath)]);

  console.log('band   rows        water    cover(ref/render)   cloud ref      cloud render   sky ref        sky render');
  let refCover = 0;
  let renderCover = 0;
  let water = 0;
  for (let b = 0; b < BANDS; b++) {
    const r = bandStats(ref, mask, b);
    const s = bandStats(render, mask, b);
    if (!r.water) continue;
    water += r.water;
    refCover += r.cover * r.water;
    renderCover += s.cover * r.water;
    console.log(
      `${String(b).padStart(2)}   ${String(r.rows[0]).padStart(3)}-${String(r.rows[1]).padStart(3)}`
      + `   ${String(r.water).padStart(6)}`
      + `   ${(100 * r.cover).toFixed(1).padStart(5)}% /${(100 * s.cover).toFixed(1).padStart(6)}%`
      + `   ${show(r.cloud)}   ${show(s.cloud)}   ${show(r.sky)}   ${show(s.sky)}`,
    );
  }
  console.log('');
  console.log(`whole water    cover  reference ${(100 * refCover / water).toFixed(1)}%`
    + `   render ${(100 * renderCover / water).toFixed(1)}%`);

  // Where the cloud's weight sits, as a fraction of the way down the water.
  // This is the number "the cloud is too low" is about: it is the first thing
  // that has to agree before any colour comparison means anything, because a
  // band of render cloud sitting over a band of reference sky compares two
  // different objects.
  const centroid = (data) => {
    let sum = 0;
    let weight = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        if (keyness(mask, i) < 150 || !isCloud(data, i)) continue;
        sum += y;
        weight++;
      }
    }
    return weight ? sum / weight : NaN;
  };
  const rc = centroid(ref);
  const sc = centroid(render);
  console.log(`cloud centroid row   reference ${rc.toFixed(0)}   render ${sc.toFixed(0)}`);

  // The umbrella: the one place the key is deliberately partial, and therefore
  // the one place its exact value decides how much picture survives.
  let partial = 0;
  let partialSum = 0;
  for (let i = 0; i < mask.length; i += 3) {
    const k = keyness(mask, i) / 255;
    if (k > 0.30 && k < 0.62) {
      partial++;
      partialSum += k;
    }
  }
  console.log(`partial key    ${partial} px, mean keyness ${(partialSum / Math.max(partial, 1)).toFixed(3)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
