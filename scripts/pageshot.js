#!/usr/bin/env node
/**
 * Screenshot of the whole *page*, not just the canvas.
 *
 * scripts/capture.js deliberately reads the canvas out with toDataURL, because
 * that is the only thing the measure loop cares about and because the
 * compositor path times out under SwiftShader. But the page around the canvas —
 * the title, the ambience gradient, the console — is real design work that
 * cannot be checked that way at all, and it is what the user actually sees on
 * their phone.
 *
 * So this one does take a real screenshot. It is slower and it is not
 * deterministic enough to measure anything with; use capture.js for numbers and
 * this for looking.
 *
 * Usage: node scripts/pageshot.js [outPath] [t] [extraQuery]
 *   CAPTURE_W / CAPTURE_H override the viewport (default: a portrait phone).
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const OUT = process.argv[2] || '/tmp/page.png';
const T = process.argv[3] || '0';
const EXTRA = process.argv[4] ? `&${process.argv[4]}` : '';
const WIDTH = Number(process.env.CAPTURE_W || 448);
const HEIGHT = Number(process.env.CAPTURE_H || 998);
const PORT = 5197;

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
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://localhost:${PORT}/?t=${T}${EXTRA}`, { waitUntil: 'networkidle' });
    // Let the scene draw before the compositor grabs the frame — the shadow map
    // is filled during the render loop, so an early grab shades against an
    // empty depth map (same reason capture.js waits 8 frames).
    await page.evaluate(
      () => new Promise((res) => {
        let n = 0;
        const tick = () => (++n < 10 ? requestAnimationFrame(tick) : res(null));
        requestAnimationFrame(tick);
      }),
      { timeout: 180000 },
    );
    await page.screenshot({ path: OUT, timeout: 180000 });
    await browser.close();
    if (errors.length) {
      console.error('page errors:\n' + errors.join('\n'));
      process.exitCode = 1;
    }
    console.log(`captured ${OUT} (${WIDTH}x${HEIGHT}, t=${T})`);
  } finally {
    try {
      process.kill(-vite.pid, 'SIGKILL');
    } catch {
      vite.kill('SIGKILL');
    }
  }
})();
