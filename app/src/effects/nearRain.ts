import * as THREE from 'three';

/**
 * The rain on *this* side of the picture — the drops that cross in front of the
 * eaves, the guardrail and the bench, rather than falling in the sky behind
 * them.
 *
 * This is the one pass in the chain that runs after effects/plateShader.ts, and
 * that ordering is the entire reason it exists as a separate pass rather than as
 * a few more lines in effects/rainShader.ts.
 *
 * The main rain pass is masked structurally: it runs immediately before the
 * plate, so the illustration is composited over it and rain survives only where
 * the painting is transparent. For scene 1 (窓辺) that is exactly right — there
 * is glass between the viewer and the weather. For scenes 2 and 3 it is a
 * structural falsehood, because 軒下 and バス停 are outdoors. Standing under a
 * shelter you are *inside* the rain: it crosses the foreground, in front of
 * everything, and the fact that it did not was visible as a hard silhouette
 * edge where every streak in the sky stopped dead against the painted geometry.
 * The picture read as a sheet of rain slipped in behind a paper cut-out, and no
 * tuning of the pass behind the plate could have fixed it, because the missing
 * rain was on the other side.
 *
 * The plate shader's docstring says nothing may run after it, and this does not
 * break that rule so much as fall outside it. What that rule protects the plate
 * from is the *filters* — Kuwahara, macro contrast, the grade — which exist to
 * push a 3D render toward illustration and would soften the girl's linework if
 * they were let near it. This pass filters nothing: it draws objects in front of
 * the painting, which is what an object in front of the painting looks like.
 *
 * Deliberately very sparse and very soft. Near rain in a photograph is not more
 * streaks, it is *fewer and much bigger* ones: a drop two metres from the lens
 * is far outside the depth of field, so it arrives as a pale, wide, barely-there
 * smear crossing the whole frame in a fraction of a second. Drawing near rain as
 * a lot of crisp lines is how a foreground rain layer turns into a scratched
 * print — the same failure the sky pass had, at ten times the size.
 *
 * Identity when uNearRain * uRain is zero, and core/postFx.ts disables it
 * outright there, so scene 1 and every dry frame are untouched.
 */
export const NearRainShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 0-1, the same slider the sky rain is on. */
    uRain: { value: 0 },
    /** Real seconds — the drops' own clock, shared with effects/rainShader.ts's
     * uRainTime for the reason documented there. */
    uRainTime: { value: 0 },
    uAspect: { value: 1 },
    /**
     * How open this scene's foreground is (scene/scenes.ts's foregroundRain).
     * Zero indoors, which is what keeps 窓辺 dry on the near side of its glass.
     */
    uNearRain: { value: 0 },
    /**
     * The ambient sky, in display-space sRGB as it appears *after* the rain
     * pass has darkened the frame — core/postFx.ts feeds this the same relit
     * horizon-band colour the haze uses, scaled by the rain's own exposure cut.
     *
     * A foreground drop needs it because a foreground drop is not a lens onto
     * what is behind it, which is what the sky pass's streaks are. It is two
     * metres from the eye and images most of the hemisphere, so what it carries
     * is the ambient light of the sky, and that is why a near drop is bright
     * against a dark eave and invisible against the sky itself.
     *
     * Sampling upward the way the sky pass does gives the opposite answer here,
     * and gives it silently: a drop crossing the shelter roof samples more
     * shelter roof, comes out exactly as dark as the roof, and disappears.
     * Measured over scene 3's roof strip, the first version changed 0.5% of the
     * pixels by at most 4 levels — the foreground rain was, in the only place it
     * exists to be seen, not there.
     */
    uSkyColor: { value: new THREE.Vector3(0.66, 0.78, 0.86) },
    /** Buffer size in pixels and the frame's exposure time, for the same reason
     * effects/rainShader.ts carries them: a motion-blurred streak's length is
     * how far the drop moved while the shutter was open, not a free number. */
    uFrameSize: { value: new THREE.Vector2(1408, 768) },
    uShutter: { value: 1 / 60 },
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
    uniform float uRain;
    uniform float uRainTime;
    uniform float uAspect;
    uniform float uNearRain;
    uniform vec3 uSkyColor;
    uniform vec2 uFrameSize;
    uniform float uShutter;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float vnoise2(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
        mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x),
        f.y);
    }

    // The same gust field the sky is on — see effects/rainShader.ts's gustAt.
    // Duplicated rather than shared because the two passes are separate
    // programs; the constants must be kept in step, and the reason they must is
    // that a squall crossing the sky while the foreground rain holds steady
    // would say plainly that the two are different weather.
    float gustAt(float x) {
      float swell = vnoise2(vec2(uRainTime * 0.055, 3.7));
      float front = vnoise2(vec2(x * 0.85 - uRainTime * 0.031, 11.0));
      return mix(0.60, 1.30, 0.42 * swell + 0.58 * front);
    }

    /**
     * One layer of very near, very defocused drops.
     *
     * At two to four metres the arithmetic in effects/rainShader.ts gives a
     * streak of 33-66px crossing the frame in 0.21-0.42s, and the two numbers
     * are the same fact stated twice: the frame's vertical extent at 3m is only
     * about 2.8m, so a drop falling at 9m/s is through it in a third of a
     * second, and 1/60 of that third of a second is the length of the mark.
     * The first version stated a 0.63s crossing and drew 93-252px streaks,
     * which is a drop moving at one speed smeared as though it moved at four
     * times that — the same contradiction the sky rain had, at four times the
     * size, and the reason the foreground read as a few long scratches.
     *
     * Width is the one place this departs from the sky layers. A drop this
     * close is far outside the depth of field, so its 1px of true width is
     * spread by defocus into something genuinely wide and correspondingly
     * faint. That is a real optical width rather than a fudge, and it is why
     * near rain in a photograph is a pale smear instead of a line.
     */
    float nearLayer(vec2 uv, float spacingPx, float cellPx, float crossSec,
                    float widthPx, float density, float seed) {
      float H = uFrameSize.y;
      vec2 px = vec2(uv.x * uFrameSize.x, (1.0 - uv.y) * H);
      // Leans harder than the sky rain: this is the rain blowing in past the
      // roofline, which is by definition the part with the wind in it.
      float gx = px.x + px.y * 0.24;

      float col = floor(gx / spacingPx);
      float colJit = hash12(vec2(col, seed));
      float fallPxPerSec = H / crossSec;
      // Wrapped before it is added, for the reason given in
      // effects/rainShader.ts: this layer is the fastest in the picture, so its
      // offset is the largest — over ten million pixels after a few hours of
      // uRainTime, where one float ulp is 2px and consecutive screen rows stop
      // being distinguishable.
      float scroll = mod(uRainTime * fallPxPerSec * (0.88 + colJit * 0.24), cellPx * 1024.0);
      float gy = px.y + scroll;

      float row = floor(gy / cellPx);
      float id = hash12(vec2(col, row + seed * 37.0));
      if (id > density) return 0.0;

      float r1 = fract(id * 17.0);
      float r2 = fract(id * 91.7);
      float r3 = fract(id * 233.1);

      float lenPx = max(fallPxPerSec * uShutter * (0.75 + r3 * 0.5), 3.0);
      float w = widthPx * (0.7 + r2 * 0.7);

      float fx = gx - (col + 0.15 + 0.7 * r1) * spacingPx;
      float fy = gy - row * cellPx;

      float across = exp(-(fx * fx) / (w * w));
      // No head and no tail — a defocused streak is all middle.
      float body = smoothstep(0.0, lenPx * 0.34, fy) * (1.0 - smoothstep(lenPx * 0.66, lenPx, fy));
      float energy = clamp(48.0 / lenPx, 0.5, 1.6);
      return across * body * energy * (0.35 + r1 * 0.9);
    }

    void main() {
      vec3 src = texture2D(tDiffuse, vUv).rgb;
      float amount = clamp(uRain, 0.0, 1.0) * clamp(uNearRain, 0.0, 1.0);
      if (amount < 0.002) {
        gl_FragColor = vec4(src, 1.0);
        return;
      }
      float rain = clamp(clamp(uRain, 0.0, 1.0) * gustAt(vUv.x), 0.0, 1.0);
      // Near rain is the last thing to arrive and the first to go: in a drizzle
      // nothing is blowing in past the roofline at all, and what you see in
      // front of you is only the sky's rain in the distance. So this ramps in
      // over the upper half of the slider rather than tracking it linearly.
      float heavy = smoothstep(0.28, 0.95, rain) * clamp(uNearRain, 0.0, 1.0);
      if (heavy < 0.002) {
        gl_FragColor = vec4(src, 1.0);
        return;
      }

      // The 3.5m band — 38px marks crossing in a third of a second, still
      // legible as individual streaks — and a second layer right on the lens at
      // under a metre, where defocus has spread the drop into a wide dim smear
      // that registers as a shimmer rather than as a mark.
      //
      // Many more of them than the first version, which put six or seven
      // streaks in the whole frame: at these lengths the marks are a quarter of
      // what they were, so the same amount of visible rain needs several times
      // as many.
      float near = nearLayer(vUv, 60.0, 110.0, 0.36, 1.3, mix(0.0, 0.60, heavy), 5.0);
      float veryNear = nearLayer(vUv, 220.0, 420.0, 0.16, 7.0, mix(0.0, 0.40, heavy), 61.0);

      // A drop is a lens, and at this range it is a lens onto the whole sky
      // rather than onto whatever it is passing in front of — see uSkyColor.
      // Mostly ambient, with a little of the local picture left in it so that a
      // streak crossing a bright patch still picks some of it up.
      vec3 gathered = texture2D(tDiffuse, vec2(vUv.x, min(vUv.y + 0.09, 1.0))).rgb;
      // Lifted toward white like the sky rain's marks — a near drop concentrates
      // the whole hemisphere and is the brightest thing crossing the frame.
      vec3 dropColor = mix(mix(gathered * 1.10, uSkyColor, 0.68), vec3(1.0), 0.42) + 0.02;

      vec3 color = src;
      color = mix(color, dropColor, clamp(near * 0.52 * heavy, 0.0, 1.0));
      // The lens-side smears are fainter still, and flatter: they are so far out
      // of focus that they carry almost no image, only a lift.
      color = mix(color, mix(dropColor, vec3(1.0), 0.25),
                  clamp(veryNear * 0.22 * heavy, 0.0, 1.0));

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};
