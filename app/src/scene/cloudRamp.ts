import * as THREE from 'three';

/**
 * 雲の塗り — the shading ramp *measured out of the reference image*
 * (1786443741198.png), not chosen by hand.
 *
 * Method: sample every pixel inside three boxes that lie wholly within the
 * reference cumulonimbus silhouette, sort by luminance, and take the mean
 * colour of each of 32 equal-population buckets (trimming the top/bottom 2%
 * for stray sky pixels bleeding through gaps). Indexing by *population*
 * rather than by luminance means that feeding this ramp a uniformly
 * distributed shading term reproduces the reference's own tonal histogram,
 * which is the property that was measurably wrong before: the render's
 * histogram was bimodal (a light plateau and one dead-grey blob) where the
 * reference is a broad continuum from cerulean shadow to white.
 *
 * What the measurement showed, and why this replaces neutral Lambert shading
 * entirely: in the reference the hue is a *function of* the value. As it
 * darkens it also gets markedly bluer — B-R separation climbs 2 -> 150 from
 * the white crown down to the deepest crevice, bottoming out just above the
 * sky's own colour. Multiplying a white albedo by a neutral N.L term cannot
 * produce that; it can only slide toward grey/black, which is exactly what
 * the render was doing (B-R stuck at ~25 across its whole range). So the
 * shading term now indexes this ramp instead of scaling a brightness.
 *
 * Measured sRGB endpoints (every 4th entry):
 *   s=0.000  rgb( 65,163,215)
 *   s=0.129  rgb(116,180,221)
 *   s=0.258  rgb(133,193,228)
 *   s=0.387  rgb(150,202,232)
 *   s=0.516  rgb(178,215,238)
 *   s=0.645  rgb(198,226,244)
 *   s=0.774  rgb(219,237,247)
 *   s=0.903  rgb(240,248,252)
 *
 * Values below are stored *inverse-tonemapped* into linear HDR: the composer
 * applies ACES + sRGB encode once at the end (OutputPass), so pre-applying
 * the analytic inverse of three.js's ACESFilmicToneMapping at
 * toneMappingExposure=1.2 makes the pixels land back on the measured
 * sRGB above. Round-trip error is under 1/255. If the renderer's exposure or
 * tonemapping operator changes, this table must be regenerated.
 */
const RAMP_HDR = new Float32Array([
  0.02324, 0.24386, 0.62844,
  0.04154, 0.27655, 0.70173,
  0.06763, 0.28475, 0.66265,
  0.07522, 0.30039, 0.68326,
  0.07825, 0.31535, 0.72703,
  0.08312, 0.32973, 0.75764,
  0.08399, 0.34836, 0.81239,
  0.08971, 0.36884, 0.85272,
  0.09049, 0.38803, 0.90742,
  0.09794, 0.40149, 0.94144,
  0.10203, 0.41617, 0.98316,
  0.10944, 0.43083, 1.01324,
  0.11774, 0.45239, 1.05704,
  0.12617, 0.48203, 1.13366,
  0.14202, 0.51594, 1.20934,
  0.16583, 0.55669, 1.28781,
  0.18823, 0.60117, 1.38831,
  0.19984, 0.64705, 1.49702,
  0.21280, 0.69420, 1.65692,
  0.23744, 0.74670, 1.75218,
  0.26099, 0.80902, 1.90589,
  0.27990, 0.88467, 2.12235,
  0.34567, 0.97840, 2.20757,
  0.39201, 1.08103, 2.40167,
  0.42450, 1.24292, 2.65645,
  0.46590, 1.50236, 3.16683,
  0.48648, 1.94718, 4.22822,
  0.69581, 2.42817, 4.75194,
  1.01591, 2.78074, 5.02959,
  0.93525, 3.50030, 6.52579,
  1.32839, 5.35359, 8.15691,
  3.48410, 7.85025, 7.83363,
]);

export const CLOUD_RAMP_SIZE = 32;

/**
 * RGBA half-float texture, 32x1, for lookup by the shading term s in [0,1].
 *
 * Half float, NOT 32-bit float, and this is a correctness requirement rather
 * than a memory saving.
 *
 * This was FloatType with LinearFilter, and on a real phone it turned the
 * clouds black. In WebGL2 an RGBA32F texture is *not filterable* in core: a
 * LINEAR sampler on one requires the optional OES_texture_float_linear
 * extension, and where that extension is missing the texture is incomplete and
 * every texture2D() on it returns (0,0,0,1). SwiftShader — which is what
 * scripts/capture.js renders with — implements the extension, so every capture
 * ever taken of this project looked correct while Android showed solid black
 * cloud. Nothing in the measure loop could have caught it.
 *
 * The symptom was diagnostic once seen: the black masses kept *white crowns
 * and pale distant cloud*, because those two are the only paths in
 * cloudShader.ts that do not come from this texture — the highlight boost
 * mixes toward the uWhiteHDR uniform and aerial perspective mixes toward the
 * uHazeColor uniform.
 *
 * RGBA16F is filterable in core WebGL2 with no extension, so this cannot
 * happen again. The ramp's largest entry is 8.157, far inside half float's
 * range, and its precision there (~0.008) is negligible against a table whose
 * top step spans 3.48 -> 7.85.
 */
export function createCloudRampTexture(): THREE.DataTexture {
  const data = new Uint16Array(CLOUD_RAMP_SIZE * 4);
  for (let i = 0; i < CLOUD_RAMP_SIZE; i++) {
    data[i * 4 + 0] = THREE.DataUtils.toHalfFloat(RAMP_HDR[i * 3 + 0]);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(RAMP_HDR[i * 3 + 1]);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(RAMP_HDR[i * 3 + 2]);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(data, CLOUD_RAMP_SIZE, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  // Linear filtering across the ramp is what makes the tiers read as blended
  // plateaus ("にじむ") rather than hard cel bands.
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** CPU-side lookup of the same ramp, for things that need a single colour
 * from it (the translucent fringe material) rather than a per-fragment
 * texture fetch. s in [0,1]; returns the linear-HDR triple. */
export function sampleCloudRampHDR(s: number): THREE.Color {
  const x = Math.max(0, Math.min(1, s)) * (CLOUD_RAMP_SIZE - 1);
  const i = Math.min(Math.floor(x), CLOUD_RAMP_SIZE - 2);
  const f = x - i;
  return new THREE.Color(
    RAMP_HDR[i * 3 + 0] * (1 - f) + RAMP_HDR[(i + 1) * 3 + 0] * f,
    RAMP_HDR[i * 3 + 1] * (1 - f) + RAMP_HDR[(i + 1) * 3 + 1] * f,
    RAMP_HDR[i * 3 + 2] * (1 - f) + RAMP_HDR[(i + 1) * 3 + 2] * f,
  );
}
