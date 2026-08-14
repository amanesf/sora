#!/usr/bin/env node
/**
 * Measures the silhouette/shading properties this scene is being tuned against,
 * identically on the render and on the reference image, so the two numbers are
 * comparable. Everything here is a statistic over pixels — no eyeballing, per
 * plan.md §2.
 *
 * Usage: node scripts/measure.js <image.png> [more.png ...]
 *
 * Reported:
 *   lateral      mean luminance of the hero mass left of its centroid minus
 *                right of it. The reference is lit from the left and reads
 *                +9.8; a near-zero value means the key light has no lateral
 *                component that survives to screen.
 *   softFrac/med fraction of silhouette crossings whose 10-90% transition is
 *                >=6px, and the median crossing width in px. Fringe.
 *   rimFrac      fraction of near-contour pixels more than 50 above the local
 *                interior level. Rim light.
 *   scallop      mean angular period of the silhouette radius signal, expressed
 *                as an equivalent bump radius in px. Scalloping ("刻み").
 */
const sharp = require('sharp');

const SOFT_PX = 6;
const RIM_DELTA = 50;

async function load(file) {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/**
 * Cloud mask, from blueness (B-R): sky is strongly blue, cloud is near-neutral
 * even where it is shadowed. The split point is found by Otsu's method rather
 * than hardcoded, because the render and the reference sit at different overall
 * blue levels and any fixed threshold would be measuring two different things
 * in the two images.
 */
function cloudMask(img) {
  const { data, w, h, ch } = img;
  const n = w * h;
  const blueness = new Int16Array(n);
  const hist = new Float64Array(512);
  for (let p = 0; p < n; p++) {
    const i = p * ch;
    const v = data[i + 2] - data[i];
    blueness[p] = v;
    hist[v + 256]++;
  }
  let total = 0;
  let sum = 0;
  for (let k = 0; k < 512; k++) {
    total += hist[k];
    sum += k * hist[k];
  }
  let wB = 0;
  let sumB = 0;
  let bestVar = -1;
  let threshold = 0;
  for (let k = 0; k < 512; k++) {
    wB += hist[k];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += k * hist[k];
    const between = wB * wF * Math.pow(sumB / wB - (sum - sumB) / wF, 2);
    if (between > bestVar) {
      bestVar = between;
      threshold = k;
    }
  }
  const cut = threshold - 256;
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) mask[p] = blueness[p] <= cut ? 1 : 0;
  return mask;
}

/** Largest 4-connected component of the mask — the hero cumulonimbus. */
function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const stack = [];
  let best = null;
  let cur = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s] !== -1) continue;
    stack.push(s);
    label[s] = cur;
    const px = [];
    while (stack.length) {
      const p = stack.pop();
      px.push(p);
      const x = p % w;
      const y = (p / w) | 0;
      const nb = [];
      if (x > 0) nb.push(p - 1);
      if (x < w - 1) nb.push(p + 1);
      if (y > 0) nb.push(p - w);
      if (y < h - 1) nb.push(p + w);
      for (const n of nb) {
        if (mask[n] && label[n] === -1) {
          label[n] = cur;
          stack.push(n);
        }
      }
    }
    if (!best || px.length > best.length) best = px;
    cur++;
  }
  return best || [];
}

/**
 * Least-squares fit of luminance over the cloud pixels against screen x and y.
 * This is the honest "is there a key light at all" number: a mass lit from one
 * side carries a luminance ramp across itself, and the sign and size of the two
 * coefficients say which side and how strongly. Reported per 100px so the
 * values are readable at this image scale.
 */
function lightingGradient(img, comp) {
  const { data, w, ch } = img;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sl = 0;
  for (const p of comp) {
    sx += p % w;
    sy += (p / w) | 0;
    sl += lum(data, p * ch);
    n++;
  }
  const mx = sx / n;
  const my = sy / n;
  const ml = sl / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxl = 0;
  let syl = 0;
  for (const p of comp) {
    const dx = (p % w) - mx;
    const dy = ((p / w) | 0) - my;
    const dl = lum(data, p * ch) - ml;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
    sxl += dx * dl;
    syl += dy * dl;
  }
  const det = sxx * syy - sxy * sxy;
  const gx = (syy * sxl - sxy * syl) / det;
  const gy = (sxx * syl - sxy * sxl) / det;
  return { gx: gx * 100, gy: gy * 100 };
}

/** Spread of tone within the cloud — a flat mass and a modelled one differ here. */
function stddev(img, comp) {
  const { data, ch } = img;
  let s = 0;
  let s2 = 0;
  for (const p of comp) {
    const l = lum(data, p * ch);
    s += l;
    s2 += l * l;
  }
  const m = s / comp.length;
  return Math.sqrt(s2 / comp.length - m * m);
}

function lateralAsymmetry(img, comp) {
  const { data, w, ch } = img;
  let cx = 0;
  for (const p of comp) cx += p % w;
  cx /= comp.length;
  let ls = 0;
  let ln = 0;
  let rs = 0;
  let rn = 0;
  for (const p of comp) {
    const l = lum(data, p * ch);
    if (p % w < cx) {
      ls += l;
      ln++;
    } else {
      rs += l;
      rn++;
    }
  }
  return { lateral: ls / ln - rs / rn, cx, area: comp.length };
}

/**
 * Horizontal scanlines through the hero mass; at each left/right silhouette
 * crossing, the 10-90% luminance transition width.
 */
function fringe(img, comp) {
  const { data, w, h, ch } = img;
  const rows = new Map();
  for (const p of comp) {
    const y = (p / w) | 0;
    const x = p % w;
    const r = rows.get(y) || [w, -1];
    if (x < r[0]) r[0] = x;
    if (x > r[1]) r[1] = x;
    rows.set(y, r);
  }
  const widths = [];
  for (const [y, [x0, x1]] of rows) {
    if (x1 - x0 < 20) continue;
    for (const [edge, dir] of [
      [x0, -1],
      [x1, 1],
    ]) {
      // Sample outward into sky and inward into cloud, then find how far apart
      // the 10% and 90% levels of that span sit.
      const span = 24;
      const prof = [];
      for (let k = -span; k <= span; k++) {
        const x = edge + dir * k;
        if (x < 0 || x >= w || y < 0 || y >= h) {
          prof.length = 0;
          break;
        }
        prof.push(lum(data, (y * w + x) * ch));
      }
      if (!prof.length) continue;
      const outer = prof[0];
      const inner = prof[prof.length - 1];
      if (Math.abs(inner - outer) < 20) continue;
      const lo = outer + (inner - outer) * 0.1;
      const hi = outer + (inner - outer) * 0.9;
      let iLo = -1;
      let iHi = -1;
      for (let k = 0; k < prof.length; k++) {
        const passedLo = inner > outer ? prof[k] >= lo : prof[k] <= lo;
        const passedHi = inner > outer ? prof[k] >= hi : prof[k] <= hi;
        if (iLo < 0 && passedLo) iLo = k;
        if (iLo >= 0 && passedHi) {
          iHi = k;
          break;
        }
      }
      if (iLo >= 0 && iHi > iLo) widths.push(iHi - iLo);
    }
  }
  widths.sort((a, b) => a - b);
  const median = widths.length ? widths[widths.length >> 1] : NaN;
  const softFrac = widths.length ? widths.filter((x) => x >= SOFT_PX).length / widths.length : NaN;
  return { softFrac, median, n: widths.length };
}

/**
 * Rim: for each mask pixel within 6px of the silhouette, compare it to the
 * interior level 18px further in along the same inward direction.
 */
function rim(img, comp, w, h) {
  const { data, ch } = img;
  const set = new Set(comp);
  let hits = 0;
  let total = 0;
  let sumDelta = 0;
  for (const p of comp) {
    const x = p % w;
    const y = (p / w) | 0;
    // inward direction: away from the nearest outside pixel among 4 dirs
    let dx = 0;
    let dy = 0;
    if (!set.has(p - 1)) dx += 1;
    if (!set.has(p + 1)) dx -= 1;
    if (!set.has(p - w)) dy += 1;
    if (!set.has(p + w)) dy -= 1;
    if (dx === 0 && dy === 0) continue;
    const ix = x + dx * 18;
    const iy = y + dy * 18;
    if (ix < 0 || ix >= w || iy < 0 || iy >= h) continue;
    const interior = lum(data, (iy * w + ix) * ch);
    const edgeL = lum(data, p * ch);
    total++;
    sumDelta += edgeL - interior;
    if (edgeL - interior > RIM_DELTA) hits++;
  }
  return { rimFrac: hits / total, rimMeanDelta: sumDelta / total, n: total };
}

/** Silhouette radius signal vs angle from the centroid; mean bump size. */
function scallop(img, comp, w) {
  let cx = 0;
  let cy = 0;
  for (const p of comp) {
    cx += p % w;
    cy += (p / w) | 0;
  }
  cx /= comp.length;
  cy /= comp.length;
  const BINS = 720;
  const rad = new Float64Array(BINS);
  for (const p of comp) {
    const x = p % w;
    const y = (p / w) | 0;
    const a = Math.atan2(y - cy, x - cx);
    const bin = Math.min(BINS - 1, Math.floor(((a + Math.PI) / (2 * Math.PI)) * BINS));
    const r = Math.hypot(x - cx, y - cy);
    if (r > rad[bin]) rad[bin] = r;
  }
  // Detrend with a wide moving average, then count sign changes of the
  // residual: two sign changes per bump.
  const K = 45;
  const resid = new Float64Array(BINS);
  let meanR = 0;
  for (let i = 0; i < BINS; i++) {
    let s = 0;
    let n = 0;
    for (let k = -K; k <= K; k++) {
      const j = (i + k + BINS) % BINS;
      if (rad[j] > 0) {
        s += rad[j];
        n++;
      }
    }
    resid[i] = rad[i] > 0 ? rad[i] - s / n : 0;
    meanR += rad[i];
  }
  meanR /= BINS;
  let crossings = 0;
  for (let i = 1; i < BINS; i++) if (resid[i - 1] * resid[i] < 0) crossings++;
  const bumps = Math.max(1, crossings / 2);
  // Arc length of one bump at the mean radius = a bump's diameter; halve it.
  const bumpRadiusPx = (Math.PI * meanR) / bumps;
  let amp = 0;
  for (let i = 0; i < BINS; i++) amp += Math.abs(resid[i]);
  return { bumpRadiusPx, bumpDepthPx: amp / BINS, bumps };
}

(async () => {
  for (const file of process.argv.slice(2)) {
    const img = await load(file);
    const mask = cloudMask(img);
    const comp = largestComponent(mask, img.w, img.h);
    if (comp.length < 500) {
      console.log(`${file}: no cloud mass found (${comp.length}px)`);
      continue;
    }
    const a = lateralAsymmetry(img, comp);
    const g = lightingGradient(img, comp);
    const f = fringe(img, comp);
    const r = rim(img, comp, img.w, img.h);
    const s = scallop(img, comp, img.w);
    console.log(
      [
        file.split('/').pop().padEnd(22),
        `area=${a.area}`,
        `lateral=${a.lateral.toFixed(1)}`,
        `gradX=${g.gx.toFixed(1)}`,
        `gradY=${g.gy.toFixed(1)}`,
        `sd=${stddev(img, comp).toFixed(1)}`,
        `softFrac=${(f.softFrac * 100).toFixed(1)}%`,
        `medEdge=${f.median}px`,
        `rimFrac=${(r.rimFrac * 100).toFixed(1)}%`,
        `rimMean=${r.rimMeanDelta.toFixed(1)}`,
        `bumpR=${s.bumpRadiusPx.toFixed(1)}px`,
        `bumpDepth=${s.bumpDepthPx.toFixed(1)}px`,
      ].join('  '),
    );
  }
})();
