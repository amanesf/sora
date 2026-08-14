#!/usr/bin/env node
/**
 * Photographs a footfall.
 *
 * scripts/capture.js freezes the scene with `?t=` so that two runs of the same
 * commit are byte-comparable, and that is exactly what makes it useless for
 * this: a ring's whole existence is `now − born`, so on a frozen clock every
 * ring is either unborn or infinitely old and the water is always flat. The one
 * thing in this app that cannot be measured on a still frame is the thing the
 * app is named after.
 *
 * So the ring is backdated instead. `__sora.press(u, v, age)` puts a ring on
 * the water that was born `age` seconds ago, which on a frozen clock is a ring
 * of an exactly known radius — the same trick `?t=` plays on the weather,
 * applied to the one part of the scene the weather's clock does not drive. The
 * result is as reproducible as scripts/capture.js's, and it can be measured.
 *
 * Usage: node scripts/press.js [outPath] [age] [u] [v]
 *   age  seconds the ring has been travelling when the frame is taken
 *   u, v the press point in the frame's own UV, origin bottom-left
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const OUT = process.argv[2] || '/tmp/press.png';
const AGE = Number(process.argv[3] || 1.2);
const U = Number(process.argv[4] || 0.5);
const V = Number(process.argv[5] || 0.35);
const WIDTH = Number(process.env.CAPTURE_W || 1408);
const HEIGHT = Number(process.env.CAPTURE_H || 768);
const PORT = 5198;

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

(async () => {
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
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-sandbox',
      ],
    });
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    // fit=frame, exactly as scripts/capture.js measures: the whole viewport is
    // the picture. The press does not go through the pointer here, so nothing
    // is lost by hiding the stage.
    await page.goto(`http://localhost:${PORT}/?fit=frame&t=0&cloud=0.62&rain=0`, { waitUntil: 'load' });
    await page.waitForTimeout(20000); // shader compilation under SwiftShader

    await page.evaluate(([u, v, age]) => window.__sora.press(u, v, age), [U, V, AGE]);
    await page.waitForTimeout(500);

    // Straight off the canvas from inside a frame callback, for the reason
    // scripts/capture.js does it: page.screenshot() times out at SwiftShader's
    // frame rate.
    const dataUrl = await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => {
        const canvas = document.querySelector('#app canvas');
        resolve(canvas.toDataURL('image/png'));
      });
    }));
    require('fs').writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`ring at (${U}, ${V}), ${AGE}s old -> ${OUT}`);
    await browser.close();
  } finally {
    try { process.kill(-vite.pid); } catch { /* already gone */ }
  }
})();
