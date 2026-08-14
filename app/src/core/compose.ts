import * as THREE from 'three';

/**
 * The final blit, and the only thing that writes to the canvas.
 *
 * The canvas used to *be* the picture: it sat inside the stage element and CSS
 * scaled it into the band. That made everything below the picture someone
 * else's problem — a second canvas, updated from a CPU readback a few times a
 * second, which stuttered against a picture running at sixty and could not be
 * fixed by asking for the readback more often, because the readback is a GPU
 * stall and asking more often only stalls more.
 *
 * So the canvas now covers the whole page and sits behind the DOM, the picture
 * is rendered into a render target at exactly the reference frame's resolution
 * (which is the invariant everything in this project is fitted to), and this
 * pass draws that target into the band and the cloud silhouette across
 * everything below it. One frame, one draw, no readback, nothing to fall out of
 * step with anything else.
 *
 * The canvas is transparent outside what it draws, so the CSS ambience gradient
 * still shows through and the page design is unchanged.
 */
export interface Compose {
  /** The finished picture (core/postFx.ts's output target). */
  setPicture: (texture: THREE.Texture) => void;
  /** The clouds on their own, in the picture's frame (scene/cloudLayer.ts). */
  setClouds: (texture: THREE.Texture) => void;
  /** Where the picture goes, in canvas UV (origin bottom-left, y up). */
  setLayout: (rect: THREE.Vector4) => void;
  /** Measurement mode hands the whole canvas to the picture and draws nothing
   * else — see style.css's .fit-frame. */
  setOverlayEnabled: (enabled: boolean) => void;
  /** Canvas width / height, for the round parts of the background. */
  setAspect: (aspect: number) => void;
  render: (renderer: THREE.WebGLRenderer) => void;
  dispose: () => void;
}

export function createCompose(): Compose {
  const material = new THREE.ShaderMaterial({
    // Opaque. The canvas paints the page's own background rather than leaving
    // it to CSS behind a transparent canvas — see the fragment shader.
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uPicture: { value: null as THREE.Texture | null },
      uClouds: { value: null as THREE.Texture | null },
      /** xy = origin, zw = size, in canvas UV. */
      uPictureRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uOverlay: { value: 1 },
      uAspect: { value: 0.45 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uPicture;
      uniform sampler2D uClouds;
      uniform vec4 uPictureRect;
      uniform float uOverlay;
      uniform float uAspect;
      varying vec2 vUv;

      // The page's palette, in the same order style.css lists it. Duplicated
      // from there on purpose: the DOM above this canvas is still styled by
      // CSS, so both need the numbers, and one of the two has to be the copy.
      const vec3 INK = vec3(0.012, 0.020, 0.039);
      const vec3 INK_MID = vec3(0.020, 0.051, 0.094);
      const vec3 LIT = vec3(0.043, 0.125, 0.212);
      const vec3 SPILL = vec3(0.376, 0.698, 0.910);

      /**
       * The page's own light, drawn rather than left to a CSS gradient behind a
       * transparent canvas.
       *
       * Transparency was the first design and it failed on contact: the page
       * came out solid white outside the picture under two different alpha
       * configurations. Painting the background here removes the entire
       * question — there is no compositing left to get wrong, the canvas is
       * opaque, and the light on the page and the light in the picture are
       * finally produced by the same code.
       */
      vec3 pageColour(vec2 uv, float foot) {
        // Deep at the foot of the page, rising to a lit blue at the picture's
        // lower edge, and settling again above it.
        float below = smoothstep(foot - 0.30, foot - 0.02, uv.y);
        vec3 c = mix(INK, LIT, below);
        c = mix(c, INK_MID, smoothstep(foot, min(foot + 0.30, 1.0), uv.y));

        // The spill: the picture backlighting the page it sits on. Centred on
        // its lower edge, because a glow hidden behind the artwork lights
        // nothing — that was the first version's mistake and it left the whole
        // lower page flat black.
        vec2 d = (uv - vec2(0.5, foot)) * vec2(uAspect * 2.2, 5.4);
        c += SPILL * 0.30 * exp(-dot(d, d));

        // A vignette, so the page has corners.
        vec2 v = (uv - 0.5) * vec2(uAspect * 1.15, 1.0);
        c *= 1.0 - 0.55 * smoothstep(0.28, 0.72, length(v));
        return c;
      }

      void main() {
        vec2 p = (vUv - uPictureRect.xy) / uPictureRect.zw;
        if (p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0) {
          gl_FragColor = vec4(texture2D(uPicture, p).rgb, 1.0);
          return;
        }

        float foot = uPictureRect.y;
        vec3 colour = pageColour(vUv, foot);

        if (uOverlay > 0.5) {
          // The clouds again, hung directly under the picture at the picture's
          // own scale and horizontal position. Same x mapping, so each cloud
          // sits under the cloud it belongs to — which is what makes it read as
          // one composition rather than as decoration that happens to be
          // cloud-shaped.
          //
          // **Same y scale too, which it was not.** This used to be
          // (p.y + uReach) / uReach, i.e. the layer's whole height spread over
          // however much page happened to be left under the picture. The layer
          // is rendered with the *view* camera (scene/cloudLayer.ts), so it
          // frames the same 1.83:1 view the picture does and one picture-width
          // of it is exactly one picture-height tall — which makes the old
          // mapping's vertical stretch exactly uReach, about 2.2x on a phone.
          // The clouds under the console came out drawn upward like flames.
          //
          // p.y + 1.0 puts the layer's bottom edge one picture-height below the
          // picture's, at its own proportions. It covers very nearly the same
          // area as before, because the fade below already threw away the
          // bottom half of the stretched version.
          vec2 s = vec2(p.x, p.y + 1.0);
          if (s.x >= 0.0 && s.x <= 1.0 && s.y >= 0.0 && s.y <= 1.0) {
            // Fades in under the picture's edge and out toward the foot of the
            // page, so it has no boundary of its own anywhere.
            float fade = smoothstep(0.0, 0.16, 1.0 - s.y) * smoothstep(0.0, 0.55, s.y);

            // A faint field of sky under the whole thing, so the clouds are
            // over something rather than floating on the page — the same
            // relationship they have in the picture above.
            colour = mix(colour, colour + vec3(0.010, 0.030, 0.055), fade);

            // The real clouds, with their own shading — not a silhouette. The
            // layer is linear HDR (the cloud material is pre-tonemap), so it
            // has to be brought down the same way the picture is. Reinhard
            // rather than the picture's ACES: this is a quiet echo at a tenth
            // of the picture's strength, and the cheap curve is
            // indistinguishable at that weight.
            vec4 layer = texture2D(uClouds, s);
            vec3 cloud = layer.rgb / (layer.rgb + 1.0);

            // Deliberately very faint. It lies under the console — the sliders
            // are DOM on top of this canvas — so anything with real contrast
            // would be competing with the controls for the same pixels.
            colour = mix(colour, cloud, layer.a * fade * 0.16);
          }
        }

        gl_FragColor = vec4(colour, 1.0);
      }
    `,
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return {
    setPicture: (t) => { material.uniforms.uPicture.value = t; },
    setClouds: (t) => { material.uniforms.uClouds.value = t; },
    setLayout: (rect) => {
      material.uniforms.uPictureRect.value.copy(rect);
    },
    setOverlayEnabled: (enabled) => { material.uniforms.uOverlay.value = enabled ? 1 : 0; },
    setAspect: (aspect) => { material.uniforms.uAspect.value = aspect; },
    render: (renderer) => {
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(scene, camera);
    },
    dispose: () => { geometry.dispose(); material.dispose(); },
  };
}
