#!/usr/bin/env node
/**
 * Crop helper for the measure loop. The reference is an illustration with a
 * girl and window frames in it, so every statistic has to be taken from a
 * hand-chosen region inside the glass rather than from the whole frame; and
 * measure.js works on the largest connected cloud mass, so the hero tower has
 * to be isolated from the low bank before it is measured.
 *
 * Usage: node scripts/crop.js <in.png> <out.png> <left> <top> <w> <h>
 */
const sharp = require('sharp');
const [, , src, out, l, t, w, h] = process.argv;
sharp(src)
  .extract({ left: +l, top: +t, width: +w, height: +h })
  .toFile(out)
  .then(() => console.log(`${out} <- ${src} [${l},${t} ${w}x${h}]`));
