import * as THREE from 'three';

export function createRenderer(canvasHost: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // the sky is one fullscreen raymarch shader; MSAA on a single triangle buys nothing
    powerPreference: 'high-performance',
    // Opaque, and it covers the whole page. Two attempts at a transparent
    // canvas over the CSS ambience gradient — one with straight alpha, one with
    // premultiplied — both came out solid white everywhere the canvas drew
    // nothing. core/compose.ts paints the page's background itself instead,
    // which is not a workaround so much as the simpler design: there is no
    // compositing left to get wrong, and the light on the page and the light in
    // the picture come out of the same shader.
  });
  renderer.setClearColor(0x03050a, 1);
  // Pixel ratio is deliberately 1 and the drawing buffer is sized by main.ts
  // to the reference frame's own pixels, not to the element's CSS size times
  // the device's DPR. See main.ts for why the render resolution is fixed.
  renderer.setPixelRatio(1);
  // core/postFx.ts's OutputPass is what actually applies tonemapping/colorspace
  // now (both sky.ts and the cloud MeshStandardMaterials output linear HDR) —
  // these renderer-level settings matter only in that they're what OutputPass
  // reads.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  canvasHost.appendChild(renderer.domElement);
  return renderer;
}

/**
 * Reports the canvas host's CSS size, and nothing else — sizing the drawing
 * buffer is main.ts's job, because the buffer is not the CSS size.
 *
 * The canvas no longer fills the window. In the portrait layout it is one band
 * of a page that also carries a title and the console (style.css), so what has
 * to be watched is the *host element*, whose size the CSS derives from the
 * viewport width plus the deliberate left/right bleed rather than from
 * window.innerHeight. Watching `resize` alone would miss the cases that
 * actually move this box (safe-area changes, the console growing as controls
 * are added to it), so a ResizeObserver on the host is the signal.
 */
export function watchResize(
  renderer: THREE.WebGLRenderer,
  onResize: (cssWidth: number, cssHeight: number) => void,
): () => void {
  const host = renderer.domElement.parentElement ?? document.body;
  let lastW = -1;
  let lastH = -1;
  const handler = () => {
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    if (width === lastW && height === lastH) return;
    lastW = width;
    lastH = height;
    onResize(width, height);
  };
  const observer = new ResizeObserver(handler);
  observer.observe(host);
  window.addEventListener('resize', handler);
  handler();
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', handler);
  };
}
