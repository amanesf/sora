import * as THREE from 'three';
import { fbm3 } from '../core/buildNoise';

/**
 * One "puff" of cloud: a noise-displaced sphere carrying a normalised local
 * height attribute. The technique is from amanesf/planet-canvas2's
 * src/clouds.ts (a prior project explicitly tuned for "新海誠的な" quality),
 * but the *shading* has since diverged from it: that project baked a
 * top-bright/underside-dark vertex-colour gradient and multiplied it by
 * standard PBR lighting, and measuring the result against the reference image
 * showed why that can't reach the target — see cloudRamp.ts. Multiplying an
 * albedo by a neutral N.L term slides toward grey, whereas the reference's
 * shadows get *bluer* as they get darker.
 *
 * So the gradient is no longer baked as colour. It is baked as a scalar
 * (aHeight, -1 at the underside to +1 at the crown) and becomes one input to
 * the shading term that indexes the measured colour ramp in clouds.ts. The
 * reason for baking it at all is unchanged: lighting every nodule as an
 * isolated ball makes a cluster read as "a heap of separately-lit spheres
 * with nothing darker where they meet", however lumpy the outline is.
 */
export function buildNoduleGeometry(seed: number, flatten: number): THREE.BufferGeometry {
  // Higher-poly than planet-canvas2's 12x5: that project viewed nodules from
  // orbital distance where a coarse silhouette was invisible; our camera sits
  // much closer (plan.md's fixed "bench" framing), so the same low-poly count
  // read as faceted rock rather than soft cauliflower. Three displacement
  // octaves — a coarse one for a few big lobes, and two finer ones riding on
  // top for the actual cauliflower bumpiness.
  const geometry = new THREE.SphereGeometry(1, 40, 22);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    if (v.length() < 1e-6) continue;
    // Signed, high-amplitude coarse displacement. The previous amplitudes
    // (0.26/0.11/0.045 on an unsigned FBM) left every nodule a very slightly
    // dented sphere, and a heap of slightly dented spheres reads as exactly
    // that — cauliflower balls. What breaks the read is *concavity*: the coarse
    // octave is now centred on zero and strong enough to pull parts of the
    // surface well inside the unit radius, so a nodule's own outline develops
    // dents and cusps rather than staying convex everywhere.
    const coarse = fbm3(v.x * 1.15, v.y * 1.15, v.z * 1.15, seed, 3) - 0.5;
    const mid = fbm3(v.x * 2.6, v.y * 2.6, v.z * 2.6, seed + 91.0, 3) - 0.5;
    const fine = fbm3(v.x * 5.3, v.y * 5.3, v.z * 5.3, seed + 613.0, 3) - 0.5;
    const micro = fbm3(v.x * 11.0, v.y * 11.0, v.z * 11.0, seed + 1277.0, 2) - 0.5;
    // Ridged on the mid octave: abs() folds the noise so its zero crossings
    // become creases instead of smooth passes, which is what puts the sharp
    // cusps between bumps that a plain FBM cannot produce.
    const ridge = 0.5 - Math.abs(mid) * 2.0;
    // Ridge and fine amplitudes raised (0.09/0.12 -> 0.14/0.15). Measuring the
    // silhouette as a radius-vs-angle signal and detrending it, the reference's
    // outline carries bumps of 35px mean radius at 11.9px depth; this render
    // was at 41px and 9.0px — both too coarse and too shallow, i.e. the
    // scallops are there but they are shallow scoops rather than the deep
    // cuts between lobes the reference has. The ridged octave is the one that
    // makes cusps rather than swells, so it takes the larger share.
    const r = 1 + coarse * 0.3 + ridge * 0.14 + fine * 0.15 + micro * 0.05;
    v.multiplyScalar(Math.max(r, 0.55));
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.scale(1, 0.88 * flatten, 1);
  geometry.computeVertexNormals();

  const halfHeight = 0.88 * flatten;
  const heights = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    heights[i] = THREE.MathUtils.clamp(position.getY(i) / halfHeight, -1, 1);
  }
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(heights, 1));
  return geometry;
}

// buildHaloGeometry() lived here: a deliberately smooth, low-displacement
// sphere for the translucent fringe shell, kept smooth so its boundary would
// blur rather than echo the core's faceted outline. That smoothness is exactly
// what made the shell read as a sphere once it started rendering — see
// cloudShader.ts for the full measurement and why the fringe was removed
// rather than reshaped.
