/**
 * Always-on finishing pass: saturation/contrast lift + a teal-shadow/warm-
 * highlight split tone (the "ティール&オレンジ" grading plan.md calls for) +
 * a gentle vignette, so the raster output reads as graded illustration rather
 * than raw untouched render.
 */
export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: 1 },
    uVignetteStrength: { value: 0.14 },
    uSaturation: { value: 1.0 },
    uContrast: { value: 1.0 },
    uSplitToneStrength: { value: 0.25 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAspect;
    uniform float uVignetteStrength;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uSplitToneStrength;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb;

      float luma = dot(color, vec3(0.299, 0.587, 0.114));
      vec3 shadowTint = mix(vec3(1.0), vec3(0.9, 0.98, 1.06), uSplitToneStrength);
      vec3 highlightTint = mix(vec3(1.0), vec3(1.07, 1.0, 0.9), uSplitToneStrength);
      color *= mix(shadowTint, highlightTint, smoothstep(0.15, 0.85, luma));

      float gray = dot(color, vec3(0.299, 0.587, 0.114));
      color = mix(vec3(gray), color, uSaturation);
      color = (color - 0.5) * uContrast + 0.5;

      float edgeDist = length((vUv - 0.5) * vec2(uAspect, 1.0));
      float vignette = smoothstep(0.35, 0.95, edgeDist) * uVignetteStrength;
      color *= (1.0 - vignette);

      // No clamp to 1.0 here: this pass runs *before* OutputPass's tonemapping,
      // so the buffer is still linear HDR (the cloud ramp peaks near 8). Clamping
      // here would flatten every highlight to white before ACES ever saw it.
      gl_FragColor = vec4(max(color, 0.0), texel.a);
    }`,
};
