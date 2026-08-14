import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Large-scale contrast boost.
 *
 * Decomposing the render and the reference by spatial scale showed the gap
 * sits entirely at the coarse end: the two match within a point or so in the
 * 2-16px bands, while the reference carries roughly twice the contrast at
 * 40-80px and several times more above that. A painter groups many lobes into
 * one large light mass and one large shadow mass; per-fragment shading, being
 * local by nature, produces no such grouping on its own.
 *
 * This pass amplifies whatever large-scale variation is present, by extracting
 * a band between two heavy blurs and adding it back. It is explicitly a
 * finishing step, not the mechanism: it can only scale up structure that the
 * scene already has, so it runs after the shading-side terms (the light-space
 * shadow map, the cluster-scale field and the directional wash) have put that
 * structure there. Pointed at the earlier render, which was essentially flat
 * above 40px, it amplified noise instead.
 *
 * Both blurs run on a 1/8-resolution buffer, which is what makes a band this
 * wide affordable: the kernel only has to reach a handful of texels to cover
 * tens of full-resolution pixels, and the detail it would otherwise alias
 * against has already been averaged away by the downsample.
 */

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const CopyShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: QUAD_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`,
};

const BlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDirection: { value: new THREE.Vector2(1, 0) },
    uScale: { value: 1 },
  },
  vertexShader: QUAD_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform vec2 uDirection;
    uniform float uScale;
    varying vec2 vUv;
    void main() {
      vec2 s = uTexel * uDirection * uScale;
      vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;
      sum += texture2D(tDiffuse, vUv + s * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv - s * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv + s * 3.2307692308) * 0.0702702703;
      sum += texture2D(tDiffuse, vUv - s * 3.2307692308) * 0.0702702703;
      gl_FragColor = sum;
    }`,
};

const CombineShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNear: { value: null },
    tFar: { value: null },
    uAmount: { value: 0.6 },
  },
  vertexShader: QUAD_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tNear;
    uniform sampler2D tFar;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      vec3 band = texture2D(tNear, vUv).rgb - texture2D(tFar, vUv).rgb;
      // Added, not multiplied: the aim is to widen the separation between the
      // large light mass and the large shadow mass, which is an offset in
      // value, not a change in local contrast.
      gl_FragColor = vec4(clamp(base + band * uAmount, 0.0, 1.0), 1.0);
    }`,
};

export class MacroContrastPass extends Pass {
  private small: THREE.WebGLRenderTarget;
  private ping: THREE.WebGLRenderTarget;
  private near: THREE.WebGLRenderTarget;
  private far: THREE.WebGLRenderTarget;
  private copyMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private combineMat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor(width: number, height: number) {
    super();
    const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat };
    const w = Math.max(1, Math.floor(width / 8));
    const h = Math.max(1, Math.floor(height / 8));
    this.small = new THREE.WebGLRenderTarget(w, h, opts);
    this.ping = new THREE.WebGLRenderTarget(w, h, opts);
    this.near = new THREE.WebGLRenderTarget(w, h, opts);
    this.far = new THREE.WebGLRenderTarget(w, h, opts);

    this.copyMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(BlurShader.uniforms),
      vertexShader: BlurShader.vertexShader, fragmentShader: BlurShader.fragmentShader,
    });
    this.combineMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CombineShader.uniforms),
      vertexShader: CombineShader.vertexShader, fragmentShader: CombineShader.fragmentShader,
    });
    this.quad = new FullScreenQuad(this.copyMat);
    this.setSize(width, height);
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.combineMat.uniforms;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / 8));
    const h = Math.max(1, Math.floor(height / 8));
    for (const rt of [this.small, this.ping, this.near, this.far]) rt.setSize(w, h);
    this.blurMat.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  private blur(
    renderer: THREE.WebGLRenderer,
    src: THREE.WebGLRenderTarget,
    tmp: THREE.WebGLRenderTarget,
    dst: THREE.WebGLRenderTarget,
    scale: number,
  ): void {
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.uScale.value = scale;

    this.blurMat.uniforms.tDiffuse.value = src.texture;
    this.blurMat.uniforms.uDirection.value.set(1, 0);
    renderer.setRenderTarget(tmp);
    this.quad.render(renderer);

    this.blurMat.uniforms.tDiffuse.value = tmp.texture;
    this.blurMat.uniforms.uDirection.value.set(0, 1);
    renderer.setRenderTarget(dst);
    this.quad.render(renderer);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.quad.material = this.copyMat;
    this.copyMat.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.small);
    this.quad.render(renderer);

    // ~32px full-resolution sigma, then ~72px on top of it: the band between
    // them is the 40-80px range the measurement says is missing.
    this.blur(renderer, this.small, this.ping, this.near, 2.0);
    this.blur(renderer, this.near, this.ping, this.far, 4.0);

    this.quad.material = this.combineMat;
    this.combineMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.combineMat.uniforms.tNear.value = this.near.texture;
    this.combineMat.uniforms.tFar.value = this.far.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  dispose(): void {
    for (const rt of [this.small, this.ping, this.near, this.far]) rt.dispose();
    this.copyMat.dispose(); this.blurMat.dispose(); this.combineMat.dispose(); this.quad.dispose();
  }
}
