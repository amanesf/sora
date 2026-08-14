import * as THREE from 'three';

/**
 * Thickens the air toward the sea horizon: the lowest clouds lose contrast,
 * dissolve toward the pale haze colour, and go soft-edged.
 *
 * The cloud shader's own aerial perspective already fades distant cloud toward
 * that colour — at 70km it is 96% hazed — but it only changes *colour*. The
 * silhouettes stay geometrically crisp, so the bank still met the painted sea
 * with a hard edge where the reference has a soft luminous band with no visible
 * boundary at all. Distance fog cannot produce that; it is the scattering of the
 * cloud's own edge through 60km of humid air, which spatially blurs it.
 *
 * So the blur radius and the fade both ramp in over the last stretch above the
 * horizon, and the target colour is measured off the reference's haze band
 * (170,215,232 at y≈585). Applied before the plate, so only the rendered sky is
 * touched — the painted sea and town below the horizon are never sampled.
 */
export const HorizonHazeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** Screen-space v (0 bottom, 1 top) where the haze starts and where it is at
     * full strength — derived from the visible frame rect, so cropping for a
     * phone's aspect keeps the band on the painted horizon. */
    uHazeV: { value: new THREE.Vector2(0.0, 0.25) },
    uHazeColor: { value: new THREE.Vector3(170 / 255, 215 / 255, 232 / 255) },
    uHazeStrength: { value: 0.72 },
    /** Blur radius at full haze, in pixels. */
    uBlurPx: { value: 3.5 },
    uTexel: { value: new THREE.Vector2(1 / 1408, 1 / 768) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uHazeV;
    uniform vec3 uHazeColor;
    uniform float uHazeStrength;
    uniform float uBlurPx;
    uniform vec2 uTexel;
    varying vec2 vUv;

    void main() {
      // uHazeV.y is the top of the band, uHazeV.x the horizon itself; v runs
      // upward, so the haze grows as v falls toward uHazeV.x.
      float t = 1.0 - smoothstep(uHazeV.x, uHazeV.y, vUv.y);
      // Squared, so the band is weighted into the last few degrees above the
      // horizon rather than washing the whole lower sky.
      t = t * t;

      vec3 color;
      if (t < 0.004) {
        color = texture2D(tDiffuse, vUv).rgb;
      } else {
        // Separable-ish 9 tap in a cross: enough to take the hard edge off a
        // cloud silhouette at this radius, and cheap enough to run every frame.
        vec2 r = uBlurPx * t * uTexel;
        vec3 sum = texture2D(tDiffuse, vUv).rgb * 2.0;
        sum += texture2D(tDiffuse, vUv + vec2(r.x, 0.0)).rgb;
        sum += texture2D(tDiffuse, vUv - vec2(r.x, 0.0)).rgb;
        sum += texture2D(tDiffuse, vUv + vec2(0.0, r.y)).rgb;
        sum += texture2D(tDiffuse, vUv - vec2(0.0, r.y)).rgb;
        sum += texture2D(tDiffuse, vUv + r * 0.7).rgb;
        sum += texture2D(tDiffuse, vUv - r * 0.7).rgb;
        sum += texture2D(tDiffuse, vUv + vec2(r.x, -r.y) * 0.7).rgb;
        sum += texture2D(tDiffuse, vUv + vec2(-r.x, r.y) * 0.7).rgb;
        color = sum / 10.0;
      }

      gl_FragColor = vec4(mix(color, uHazeColor, t * uHazeStrength), 1.0);
    }
  `,
};
