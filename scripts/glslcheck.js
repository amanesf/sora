#!/usr/bin/env node
/**
 * Compile every shader in app/src through a real GL compiler.
 *
 * Shaders live in template literals, so `tsc` and `vite build` both pass
 * cleanly on a fragment shader that cannot compile at all — and a post pass
 * whose program fails to link does not fail quietly, it fills the frame with
 * garbage. That is exactly how "雨にすると真っ白になる" happened: a rewrite
 * split the three rain sheets into separate mixes and left one reference to a
 * variable that no longer existed, the rain pass never compiled, and since
 * core/postFx.ts only enables that pass above rain 0 the frame was perfect
 * until the slider left zero.
 *
 * Nothing else in the toolchain would have caught it short of a capture, which
 * is twenty minutes under SwiftShader. This is about ten seconds.
 *
 *   node scripts/glslcheck.js                 # everything under app/src
 *   node scripts/glslcheck.js effects/rainShader.ts
 *
 * Exits non-zero if any shader fails, so it can gate a commit.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'app', 'src');

/** The built-ins three.js prepends to every ShaderMaterial. */
const THREE_VERTEX_PRELUDE = `
  uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix, viewMatrix;
  uniform mat3 normalMatrix;
  uniform vec3 cameraPosition;
  attribute vec3 position, normal;
  attribute vec2 uv;
  attribute mat4 instanceMatrix;  // injected for InstancedMesh (scene/clouds.ts)
`;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function extract(src) {
  const out = [];
  const re = /(vertexShader|fragmentShader)\s*:\s*(?:\/\*\s*glsl\s*\*\/\s*)?`([\s\S]*?)`\s*,\n/g;
  let m;
  while ((m = re.exec(src))) out.push({ kind: m[1], code: m[2] });
  return out;
}

(async () => {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((f) => path.resolve(ROOT, f)) : walk(ROOT);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');

  let checked = 0, failed = 0, skipped = 0;
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    for (const s of extract(fs.readFileSync(abs, 'utf8'))) {
      // Shaders assembled with ${...} interpolation are not valid GLSL as
      // written; checking them would mean reimplementing how they are built.
      // The standalone post passes — where this bug class bites — have none.
      if (s.code.includes('${')) { skipped++; console.log(`- ${rel} ${s.kind}: skipped (interpolated)`); continue; }
      checked++;
      const log = await page.evaluate(({ kind, code, prelude }) => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const sh = gl.createShader(kind === 'vertexShader' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
        gl.shaderSource(sh, 'precision highp float;\nprecision highp int;\n'
          + (kind === 'vertexShader' ? prelude : '') + code);
        gl.compileShader(sh);
        return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? '' : gl.getShaderInfoLog(sh);
      }, { ...s, prelude: THREE_VERTEX_PRELUDE });
      if (log) { failed++; console.log(`\n=== ${rel} ${s.kind} FAILED ===\n${log.trim()}\n`); }
      else console.log(`  ${rel} ${s.kind}: ok`);
    }
  }
  await browser.close();
  console.log(`\n${checked} compiled, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
})();
