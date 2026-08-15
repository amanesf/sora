#!/usr/bin/env node
/**
 * Auditions opening skies.
 *
 * The whole scene is a pure function of one number (main.ts's simTime), and the
 * app used to start that number at random — inherited from the window app,
 * where it was exactly right: that app is a sky you watch for a while, and a
 * different sky every visit is the point.
 *
 * This app is a *picture*. It has one composition, one hour, one weather, and
 * the water shows a magnified patch of sky about as wide as one cumulus. Which
 * second the clock starts on therefore decides whether the first thing anyone
 * sees is a tower standing in the middle of the pool or a smear of low cloud
 * across one corner — and at random, it is that second one about as often as
 * not. The front door should be the good one.
 *
 * So the second is chosen rather than drawn, and chosen by measurement rather
 * than by taste. Each candidate is scored on the three things that separate the
 * reference's water from a mediocre frame of the same scene:
 *
 *   cover     how much of the water is cloud (the reference: 35%)
 *   centroid  how far down the water the cloud's weight sits (row 371)
 *   massed    what share of that cloud is in its single largest piece —
 *             one tower rather than a scatter, which is the difference the
 *             other two cannot see
 *
 * One browser, stepped through the candidates with the capture hook, because
 * under SwiftShader almost all of a capture's cost is compiling this scene's
 * shaders and a sweep by page reload pays that once per frame.
 *
 * Usage: node scripts/audition.js [count] [step]
 *   count  how many seconds to try (default 12)
 *   step   simulated seconds between them (default 900 — a quarter hour, far
 *          enough apart that consecutive candidates are different weather)
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const COUNT = Number(process.argv[2] || 12);
const STEP = Number(process.argv[3] || 900);
const W = 1376;
const H = 768;
const PORT = 5197;
const OUT_DIR = process.env.AUDITION_DIR || '/tmp/audition';

const MASK = path.join(__dirname, '..', '1786747444132.png');

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in 60s')), 60000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Local:')) {
        clearTimeout(timer);
        setTimeout(resolve, 500);
      }
    });
    proc.stderr.on('data', (c) => process.stderr.write(c));
  });
}

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
const keyness = (d, i) => Math.min(d[i], d[i + 2]) - d[i + 1];
const isCloud = (d, i) => d[i + 2] - d[i] < 42 && lum(d, i) > 95;

/** cover, centroid and the largest connected mass's share, over the water. */
function score(frame, mask) {
  const n = W * H;
  const cloud = new Uint8Array(n);
  let water = 0;
  let cloudPx = 0;
  let rowSum = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (keyness(mask, i) < 150) continue;
      water++;
      if (!isCloud(frame, i)) continue;
      cloud[y * W + x] = 1;
      cloudPx++;
      rowSum += y;
    }
  }
  if (!cloudPx) return { cover: 0, centroid: NaN, massed: 0 };

  // The largest connected piece.
  const seen = new Uint8Array(n);
  let largest = 0;
  for (let start = 0; start < n; start++) {
    if (!cloud[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let size = 0;
    while (stack.length) {
      const p = stack.pop();
      size++;
      const x = p % W;
      const y = (p / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (cloud[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (size > largest) largest = size;
  }
  return { cover: cloudPx / water, centroid: rowSum / cloudPx, massed: largest / cloudPx };
}

/** Distance from the reference, lower is better. The weights say what matters:
 * one mass first, then where it sits, then how much of the water it fills. */
function penalty(s) {
  return 2.2 * (1 - s.massed)
    + Math.abs(s.centroid - 371) / 371
    + 1.4 * Math.abs(s.cover - 0.354);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mask = await sharp(MASK).removeAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer();
  const appDir = path.join(__dirname, '..', 'app');
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  try {
    await waitForServer(vite);
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
    });
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto(`http://localhost:${PORT}/?fit=frame&t=0`, { waitUntil: 'load' });
    await page.waitForTimeout(22000); // shader compilation

    const results = [];
    for (let k = 0; k < COUNT; k++) {
      const t = k * STEP;
      await page.evaluate((seconds) => window.__sora.set({ t: seconds }), t);
      // Long enough for the cloud shadow map to refill against the new field.
      await page.waitForTimeout(2600);
      const dataUrl = await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(document.querySelector('#app canvas').toDataURL('image/png'));
        });
      }));
      const png = Buffer.from(dataUrl.split(',')[1], 'base64');
      const file = path.join(OUT_DIR, `t${t}.png`);
      fs.writeFileSync(file, png);
      const frame = await sharp(png).removeAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer();
      const s = score(frame, mask);
      const p = penalty(s);
      results.push({ t, ...s, penalty: p, file });
      console.log(`t=${String(t).padStart(6)}  cover ${(100 * s.cover).toFixed(1).padStart(5)}%`
        + `  centroid ${s.centroid.toFixed(0).padStart(4)}`
        + `  massed ${(100 * s.massed).toFixed(1).padStart(5)}%`
        + `  penalty ${p.toFixed(3)}`);
    }
    results.sort((a, b) => a.penalty - b.penalty);
    console.log('');
    console.log('best:');
    for (const r of results.slice(0, 4)) {
      console.log(`  t=${r.t}   penalty ${r.penalty.toFixed(3)}   ${r.file}`);
    }
    await browser.close();
  } finally {
    try { process.kill(-vite.pid); } catch { /* already gone */ }
  }
})();
