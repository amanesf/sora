#!/usr/bin/env node
/**
 * Cumulative tonal distribution of the cloud mass, computed identically on the
 * render and on the reference.
 *
 * measure.js reports the *spread* of tone (sd) but not where the mass sits, and
 * that turned out to be the larger error: the render matched the reference's sd
 * closely while carrying more than half its area below luminance 205 against
 * the reference's fifth. Several of cloudShader.ts's constants had also been
 * fitted to this statistic taken from the *previous* reference image
 * (1786418841252.png, since deleted), so it is worth being able to re-check it
 * cheaply against the current one.
 *
 * Cloud is separated from sky by blueness (B-R), as in measure.js — over a crop
 * that is mostly cloud a fixed cut is stable enough and keeps the two images
 * comparable without Otsu drifting between them.
 *
 * Usage: node scripts/tonedist.js <ref-crop.png> <render-crop.png> [...]
 */
const sharp = require('sharp');

const BLUE_CUT = 90; // B-R above this is sky, not cloud
const LEVELS = [190, 205, 220, 240];
const WHITE = 248;

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const sat = (r, g, b) => {
  const M = Math.max(r, g, b);
  return M ? (M - Math.min(r, g, b)) / M : 0;
};

(async () => {
  for (const file of process.argv.slice(2)) {
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: W, height: H, channels: C } = info;
    const px = [];
    let satSum = 0;
    for (let p = 0; p < W * H; p++) {
      const i = p * C;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (b - r > BLUE_CUT) continue;
      px.push(lum(r, g, b));
      satSum += sat(r, g, b);
    }
    if (px.length < 500) {
      console.log(`${file}: no cloud found`);
      continue;
    }
    px.sort((a, b) => a - b);
    const pct = (t) => ((100 * px.filter((v) => v < t).length) / px.length).toFixed(1) + '%';
    const q = (f) => px[Math.floor(px.length * f)].toFixed(0);
    console.log(
      [
        file.split('/').pop().padEnd(22),
        `n=${px.length}`.padEnd(10),
        `p25=${q(0.25)}`,
        `p50=${q(0.5)}`,
        `p75=${q(0.75)}`,
        ...LEVELS.map((t) => `<${t}=${pct(t)}`),
        `>=${WHITE}=${((100 * px.filter((v) => v >= WHITE).length) / px.length).toFixed(1)}%`,
        `sat=${(satSum / px.length).toFixed(2)}`,
      ].join('  '),
    );
  }
})();
