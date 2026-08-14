#!/usr/bin/env node
/**
 * Per-elevation profile of sky and cloud, computed identically on the render
 * and on the reference (plan.md §2: no judging colour by eye).
 *
 * Both images are 1408x768 and share a composition — core/camera.ts derived
 * the camera pitch from the horizon position measured in the reference, so the
 * horizon lands on the same screen row in both and a given row means the same
 * elevation in both. That is what makes a row-by-row comparison legitimate
 * here; it would not be between two arbitrary images.
 *
 * Within each band, pixels are split into sky and cloud by blueness (B-R) with
 * an Otsu threshold computed over the whole region — the same rule measure.js
 * uses — because the render and the reference sit at different overall blue
 * levels and any fixed cut would be measuring two different things. Dark
 * pixels are dropped first: in the reference they are window frame, hills and
 * town, none of which is sky.
 *
 * Usage:
 *   node scripts/skyprofile.js <image.png> [x0 x1 y0 y1] [--bands N]
 */
const sharp = require('sharp');

const HORIZON_FRAC = 0.72; // core/camera.ts HORIZON_SCREEN_FRACTION
const FOV_V_DEG = 50; // core/camera.ts CAMERA_VERTICAL_FOV_DEG
const DARK_CUT = 90; // window frame / hills / town in the reference

/** Elevation of a screen row, from the same pinhole geometry camera.ts inverts. */
function elevationDeg(y, h) {
  const halfFov = (FOV_V_DEG / 2) * (Math.PI / 180);
  const pitch = Math.atan((HORIZON_FRAC - 0.5) * 2 * Math.tan(halfFov));
  const ndc = 1 - (2 * (y + 0.5)) / h;
  // Camera-space ray (0, ty, -1) rotated up by pitch; elevation is its angle
  // above the horizontal.
  const ty = ndc * Math.tan(halfFov);
  const dy = ty * Math.cos(pitch) + Math.sin(pitch);
  const dz = -(Math.cos(pitch) - ty * Math.sin(pitch));
  return (Math.atan2(dy, Math.hypot(dz, 0)) * 180) / Math.PI;
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const sat = (r, g, b) => {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx <= 0 ? 0 : (mx - mn) / mx;
};

(async () => {
  const file = process.argv[2];
  const argv = process.argv.slice(3);
  const bandsArg = argv.indexOf('--bands');
  const BANDS = bandsArg >= 0 ? +argv[bandsArg + 1] : 14;
  // Drop the flag *and its value* before reading the positional crop bounds —
  // leaving the value in made `rest` five long, which silently fell through to
  // the whole-frame default instead of the region asked for.
  const rest = argv.filter((a, i) => i !== bandsArg && i !== bandsArg + 1 && !a.startsWith('--'));

  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const [x0, x1, y0, y1] = rest.length === 4 ? rest.map(Number) : [0, W, 0, H];

  // Otsu on blueness over the whole region, sky vs cloud.
  const hist = new Float64Array(512);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * C;
      if (lum(data[i], data[i + 1], data[i + 2]) < DARK_CUT) continue;
      hist[data[i + 2] - data[i] + 256]++;
    }
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
  let thr = 0;
  for (let k = 0; k < 512; k++) {
    wB += hist[k];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += k * hist[k];
    const between = wB * wF * Math.pow(sumB / wB - (sum - sumB) / wF, 2);
    if (between > bestVar) {
      bestVar = between;
      thr = k;
    }
  }
  const cut = thr - 256;

  console.log(`${file}  region x[${x0},${x1}) y[${y0},${y1})  blueness cut=${cut}`);
  console.log(
    ['band'.padEnd(16), 'elev', 'skyN', 'sky RGB'.padEnd(15), 'lum', 'sat', 'R/B', '|', 'cloudN', 'cloud RGB'.padEnd(15), 'lum', 'sat'].join(
      '  ',
    ),
  );

  const step = (y1 - y0) / BANDS;
  for (let b = 0; b < BANDS; b++) {
    const ya = Math.round(y0 + b * step);
    const yb = Math.round(y0 + (b + 1) * step);
    const acc = { sky: [0, 0, 0, 0], cloud: [0, 0, 0, 0] };
    for (let y = ya; y < yb; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * C;
        const r = data[i];
        const g = data[i + 1];
        const bl = data[i + 2];
        if (lum(r, g, bl) < DARK_CUT) continue;
        const t = bl - r > cut ? acc.sky : acc.cloud;
        t[0] += r;
        t[1] += g;
        t[2] += bl;
        t[3]++;
      }
    }
    const fmt = (t) => {
      if (!t[3]) return ['0'.padStart(6), '-'.padEnd(15), '-'.padStart(5), '-'.padStart(4)];
      const r = t[0] / t[3];
      const g = t[1] / t[3];
      const bl = t[2] / t[3];
      return [
        String(t[3]).padStart(6),
        `${r.toFixed(0)},${g.toFixed(0)},${bl.toFixed(0)}`.padEnd(15),
        lum(r, g, bl).toFixed(1).padStart(5),
        sat(r, g, bl).toFixed(2).padStart(4),
      ];
    };
    const s = fmt(acc.sky);
    const c = fmt(acc.cloud);
    const rb = acc.sky[3] ? (acc.sky[0] / acc.sky[2]).toFixed(2) : '-';
    console.log(
      [
        `y${ya}-${yb}`.padEnd(16),
        elevationDeg((ya + yb) / 2, H).toFixed(1).padStart(5),
        s[0],
        s[1],
        s[2],
        s[3],
        rb.padStart(4),
        '|',
        c[0],
        c[1],
        c[2],
        c[3],
      ].join('  '),
    );
  }
})();
