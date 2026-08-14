import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GradeShader } from '../effects/gradeShader';
import { AnisotropicKuwaharaPass } from '../effects/anisotropicKuwahara';
import { MacroContrastPass } from '../effects/macroContrast';
import { PuddleShader } from '../effects/puddleShader';
import { RainShader } from '../effects/rainShader';
import { NearRainShader } from '../effects/nearRain';
import { relightForDay, type Daylight } from './daylight';
import { HorizonHazeShader } from '../effects/horizonHaze';
import { FRAME_WIDTH, FRAME_HEIGHT, type FrameRect } from './frame';
import {
  CAMERA_HORIZON_FRACTION,
  GROUND_SCALE,
  HAZE_TOP_ROW,
  HORIZON_ROW,
  PUDDLE_MASK,
  PUDDLE_REF,
  WATER_HORIZON_ROW,
} from '../scene/puddle';
import type { Ripples } from '../scene/ripples';

export interface PostFx {
  /** The finished picture. Nothing draws to the canvas any more — this goes to
   * core/compose.ts, which puts it where the layout says the picture is. */
  outputTexture: () => THREE.Texture;
  /**
   * Measurement mode renders straight to the canvas instead, skipping
   * core/compose.ts entirely.
   *
   * Not an optimisation — an exactness guarantee. Going through the compose
   * blit costs a texture sample, and sampling a texture at what should be
   * exactly its own texel centres still moved 0.03% of the frame's channels by
   * one level. That is invisible and it is also the end of "the noon frame is
   * byte-identical", which is the check that has caught three real regressions
   * in this project. The measure loop keeps the original path.
   */
  setRenderToScreen: (enabled: boolean) => void;
  setSize: (width: number, height: number) => void;
  /** Apply the hour to everything in the post chain that was authored for
   * midday: the painted plate, and the horizon haze band. */
  setDaylight: (day: Daylight) => void;
  /**
   * Rain, 0-1, and the clock the drops fall on.
   *
   * That clock is *not* simTime — see effects/rainShader.ts's uRainTime. It is
   * real seconds, pinned to `?t=` when the scene is frozen so captures still
   * reproduce.
   */
  setRain: (amount: number, rainTime: number, shutter: number) => void;
  /** The visible sub-rect of the reference's frame — drives both the plate's UVs
   * and where the horizon haze band sits (core/frame.ts). */
  setFrameRect: (rect: FrameRect) => void;
  /**
   * The water's own state, once a frame: its clock (real seconds, not simTime
   * — see effects/puddleShader.ts's uTime), how hard the wind is working the
   * surface, and how much light the slopes are allowed to throw.
   */
  setWater: (water: { time: number; wind: number; weave: number }) => void;
  /** The pressed rings (scene/ripples.ts). Handed over once at startup; the
   * pass reads the same Vector4s the ripple table writes into. */
  setRipples: (ripples: Ripples) => void;
  /** Resolves when the photograph and its key have finished loading — or when
   * it is settled that they are not coming. */
  assetsReady: () => Promise<void>;
  render: () => void;
}

/** Soft bloom (the cloud rim-light/highlights bleeding into the sky, the
 * "glowing" quality reference-image cumulus has) + a light finishing grade.
 *
 * The grade is deliberately near-identity for the clouds now: its old
 * saturation/contrast/split-tone lift existed to push an untinted PBR render
 * toward illustration, but the reference image is *already* a graded frame
 * and its grade is baked into the measured colour ramp the clouds sample.
 * Running the old grade on top of that double-grades them. */
export function createPostFx(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): PostFx {
  const composer = new EffectComposer(renderer);
  // The last pass leaves its result in the composer's own buffer instead of on
  // the canvas: the canvas is the whole page now and the picture is only one
  // band of it (core/compose.ts).
  composer.renderToScreen = false;
  composer.addPass(new RenderPass(scene, camera));

  // Threshold raised 0.86 -> 7.0 and strength cut 0.45 -> 0.07. The cloud
  // material now emits the reference's measured colours *inverse-tonemapped*
  // into linear HDR (cloudRamp.ts), which puts its white crown at ~8.2 and
  // even its deepest shadow at ~0.02-0.5 — against the old 0.86 threshold the
  // entire cloud, shadows included, would have been treated as a bloom
  // source and the measured tonal separation immediately washed back out.
  // 7.0 sits just under the ramp's top entry (8.16), so only the genuinely
  // sunlit crown blooms rather than every lit lobe cap.
  // Strength 0.045 -> 0.12, radius 0.65 -> 0.80.
  //
  // This is now also what supplies the silhouette's soft edge, which the
  // deleted fringe shell used to fake. Removing that shell took the render from
  // far too soft to far too crisp — 87.5% of contour crossings 6px or wider,
  // then 33.2%, against the reference's 56.6%, at a median of 16px then 2px
  // against its 9px. Veiling glare around a bright cloud is a real optical
  // effect and, unlike a geometric shell, it is depth-correct by construction
  // and applies only where the cloud is actually bright — which matches the
  // reference, whose soft edges are about half its contour rather than all of
  // it. The threshold stays at 8.2 so only the genuinely sunlit crown blooms.
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(FRAME_WIDTH, FRAME_HEIGHT), 0.12, 0.80, 8.2);
  composer.addPass(bloomPass);

  const gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);

  composer.addPass(new OutputPass());

  // Kuwahara runs *after* OutputPass, i.e. on tonemapped display-space sRGB
  // rather than on the linear HDR buffer. Its quadrant variance test is a
  // perceptual judgement ("which side of this pixel is the flatter region"),
  // and in linear HDR that test is dominated entirely by the few brightest
  // pixels — the cloud crown sits near 8.0 while its shadows sit below 0.5,
  // so almost every window would pick the same quadrant and the filter would
  // smear rather than form painterly regions.
  const kuwaharaPass = new AnisotropicKuwaharaPass(FRAME_WIDTH, FRAME_HEIGHT);
  composer.addPass(kuwaharaPass);

  // Last, after the painterly filter: this widens the separation between the
  // large light and shadow masses, and running it before Kuwahara would just
  // hand that filter a wider range to average back down.
  const macroPass = new MacroContrastPass(FRAME_WIDTH, FRAME_HEIGHT);
  composer.addPass(macroPass);

  // Before the water, so it works on the rendered sky only.
  const horizonPass = new ShaderPass(HorizonHazeShader);
  composer.addPass(horizonPass);

  // Rain goes immediately before the water, so what it draws is the rain
  // *inside the reflection* — the sky's own falling rain, seen in the puddle
  // along with the cloud it fell out of. The rain on this side of the surface
  // is a separate pass after the water (nearRainPass below), which is the only
  // way round that makes sense once the picture is a mirror rather than a
  // window. See effects/rainShader.ts.
  const rainPass = new ShaderPass(RainShader);
  rainPass.enabled = false; // nothing to do while it is dry
  composer.addPass(rainPass);

  // The water goes on last — see effects/puddleShader.ts for why nothing may
  // run after it.
  //
  // Two textures, both optional. `uHasAssets` stays 0 until *both* have arrived,
  // because a photograph without its key is a still street with no water in it
  // and a key without its photograph keys nothing: either one alone is a worse
  // picture than the fallback puddle the shader draws when it has neither.
  const loader = new THREE.TextureLoader();
  /**
   * Loads an asset and reports when it has settled, either way.
   *
   * Resolved rather than rejected on error, and the app is designed around that
   * resolution being a real answer: a missing photograph is a supported state
   * (scripts/puddle.js has not been run yet), not a broken build, so the boot
   * gate must not hang on it and the water must not wait for it.
   */
  let assetsLoaded = 0;
  const settleAsset = (): void => {
    if (++assetsLoaded < 2) return;
    // Both textures exist as objects from the first frame; this is the moment
    // they contain the photograph.
    puddlePass.uniforms.uHasAssets.value = missingAsset ? 0 : 1;
  };
  let missingAsset = false;
  const assetPromises: Promise<void>[] = [];
  const loadAsset = (url: string): THREE.Texture => {
    let settle: () => void = () => {};
    assetPromises.push(new Promise<void>((resolve) => { settle = resolve; }));
    const texture = loader.load(
      url,
      () => { settleAsset(); settle(); },
      undefined,
      () => { missingAsset = true; settleAsset(); settle(); },
    );
    // The buffer at this point is already display-space sRGB (OutputPass ran
    // several passes ago), so the photograph must be sampled raw. Tagging it
    // SRGBColorSpace would have the sampler linearise it into a buffer that is
    // not linear, washing it out.
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  };

  const puddlePass = new ShaderPass(PuddleShader);
  composer.addPass(puddlePass);
  puddlePass.uniforms.tRef.value = loadAsset(PUDDLE_REF);
  // The key is read as a colour distance and its magenta must not be blended
  // with the wires drawn over it, so it is sampled without filtering — a
  // linear tap across that boundary invents intermediate colours that are
  // neither the paint nor the wire, and they key as a soft ghost either side of
  // every line.
  const maskTexture = loadAsset(PUDDLE_MASK);
  maskTexture.minFilter = THREE.NearestFilter;
  maskTexture.magFilter = THREE.NearestFilter;
  puddlePass.uniforms.tMask.value = maskTexture;
  puddlePass.uniforms.uGroundScale.value = GROUND_SCALE;

  // ...and then the rain that is in front of the picture. See effects/nearRain.ts
  // for why this is allowed to run after the water when nothing else is.
  //
  // This scene is outdoors and there is no shelter anywhere in it: the viewer is
  // standing over the puddle with the rain on their neck, so unlike any scene in
  // the window app the foreground column is the *full* one. Without it, every
  // streak in the reflection would stop dead at the water's edge and the picture
  // would read as a photograph with a sheet of rain slipped in behind it.
  const NEAR_RAIN = 1.0;
  const nearRainPass = new ShaderPass(NearRainShader);
  nearRainPass.enabled = false;
  composer.addPass(nearRainPass);

  const setSize = (width: number, height: number) => {
    composer.setSize(width, height);
    kuwaharaPass.setSize(width, height);
    macroPass.setSize(width, height);
    bloomPass.setSize(width, height);
    gradePass.uniforms.uAspect.value = width / height;
    horizonPass.uniforms.uTexel.value.set(1 / width, 1 / height);
    rainPass.uniforms.uAspect.value = width / height;
    nearRainPass.uniforms.uAspect.value = width / height;
    // The drops are specified in pixels, so they have to be told what a pixel
    // is — see effects/rainShader.ts's uFrameSize.
    (rainPass.uniforms.uFrameSize.value as THREE.Vector2).set(width, height);
    (nearRainPass.uniforms.uFrameSize.value as THREE.Vector2).set(width, height);
  };

  // The haze band's midday colour, kept so the hour can be applied to it
  // without accumulating.
  const baseHazeColor = new THREE.Color().fromArray(
    horizonPass.uniforms.uHazeColor.value.toArray(),
  );

  /**
   * The haze band's rain target, in display-space sRGB.
   *
   * The dry band is a pale luminous blue-white — aerosol lit by a midday sun,
   * which is what makes the sea horizon dissolve into light. A rain horizon
   * dissolves too, but into the opposite thing: a dark blue-grey murk with no
   * light in it at all. Keeping the pale value and merely turning the strength
   * up would have put a bright band along the bottom of a storm sky, which is
   * where the eye then goes.
   *
   * Deliberately lighter than the murk should finally read, because
   * effects/rainShader.ts runs *after* this and takes the whole frame down by
   * its exposure cut: at full rain that is 0.32 in linear light, about 0.60 in
   * display, which lands this near sRGB(76,100,118).
   */
  const rainHazeColor = new THREE.Color(126 / 255, 166 / 255, 196 / 255);
  const DRY_HAZE_STRENGTH = horizonPass.uniforms.uHazeStrength.value as number;
  const DRY_HAZE_BLUR = horizonPass.uniforms.uBlurPx.value as number;

  // The last values each of the two axes asked for, because the haze band takes
  // both and they arrive from different callers on different frames.
  let hazeDay: Daylight | null = null;
  let hazeRain = 0;

  /**
   * The horizon band, as a function of the hour *and* the weather.
   *
   * The rain half of this is the second half of taking the light out of the
   * picture, and it is the half that carries distance. An exposure cut says the
   * sun has gone; it says nothing about how far you can see, and in rain how far
   * you can see is the first thing to change — a horizon visible for fifty
   * kilometres on a clear day closes to two or three, so the sea horizon, the
   * distant banks and the far cloud stop existing as separate things and become
   * one soft wall. Until this existed the frame's most distant edge stayed as
   * crisp in a downpour as at noon, which is why the storm read as a dark filter
   * over a clear day rather than as bad visibility.
   *
   * Both the fade and the blur radius go up, because both are what visibility
   * is: the colour converges on the airlight, and the object's edge is scattered
   * out by the water between. The blur more than doubles, which sounds
   * extravagant and is not — it is 8px on a 1408px frame, i.e. half a degree.
   */
  const applyHaze = () => {
    if (!hazeDay) return;
    const day = hazeDay;
    const rain = Math.min(Math.max(hazeRain, 0), 1);
    // Both ends of the blend take the hour first, so an evening downpour hazes
    // toward an evening murk rather than toward a midday one.
    const dry = relightForDay(baseHazeColor, day, 0.65);
    if (rain <= 0) {
      horizonPass.uniforms.uHazeColor.value.set(dry.r, dry.g, dry.b);
      horizonPass.uniforms.uHazeStrength.value = DRY_HAZE_STRENGTH;
      horizonPass.uniforms.uBlurPx.value = DRY_HAZE_BLUR;
      return;
    }
    const wet = relightForDay(rainHazeColor, day, 0.65);
    horizonPass.uniforms.uHazeColor.value.set(
      THREE.MathUtils.lerp(dry.r, wet.r, rain),
      THREE.MathUtils.lerp(dry.g, wet.g, rain),
      THREE.MathUtils.lerp(dry.b, wet.b, rain),
    );
    horizonPass.uniforms.uHazeStrength.value = THREE.MathUtils.lerp(DRY_HAZE_STRENGTH, 0.97, rain);
    horizonPass.uniforms.uBlurPx.value = THREE.MathUtils.lerp(DRY_HAZE_BLUR, 8.0, rain);
  };

  /**
   * The ambient sky the foreground drops carry (effects/nearRain.ts's
   * uSkyColor).
   *
   * The haze band's own colour is the right quantity — it is the airlight, i.e.
   * exactly the light a drop two metres from the eye is sitting in, and it has
   * already been relit for the hour and the weather by applyHaze. It only has to
   * be taken down by the rain pass's exposure cut first, because the near-rain
   * pass runs *after* that cut and the band's colour is stated before it.
   */
  const applyNearRainSky = () => {
    const rain = Math.min(Math.max(hazeRain, 0), 1);
    const exposure = rainPass.uniforms.uExposure.value as number;
    // In display space, which is where both of these colours live.
    const dim = THREE.MathUtils.lerp(1, Math.pow(exposure, 1 / 2.2), rain);
    const haze = horizonPass.uniforms.uHazeColor.value as THREE.Vector3;
    (nearRainPass.uniforms.uSkyColor.value as THREE.Vector3).copy(haze).multiplyScalar(dim);
    // The sky rain wants the same quantity, for the same reason: a drop images
    // the hemisphere, not the patch of murk immediately above it.
    (rainPass.uniforms.uSkyColor.value as THREE.Vector3).copy(haze).multiplyScalar(dim);
  };

  const setDaylight = (day: Daylight) => {
    const plate = day.plateTint;
    puddlePass.uniforms.uDayTint.value.set(plate.r, plate.g, plate.b);
    // The glints are made of the sun's own light, so they turn gold with it
    // rather than staying white over an evening sky.
    const sun = day.sunTint;
    puddlePass.uniforms.uSunTint.value.set(sun.r, sun.g, sun.b);

    hazeDay = day;
    // The band that fills the bottom of the sky was a fixed pale midday blue
    // applied at 0.72 strength, so it pinned the lower sky bright and blue at
    // every hour — measured, the 18:36 sky was still at luminance 173 near the
    // horizon against midday's 181, i.e. it had barely dimmed at all while the
    // sun was setting. It is horizon haze: aerosol lit by whatever light is
    // around, so it has to take the hour like everything else. Weighted toward
    // the lit illuminant because the low sky along a long horizon path is lit
    // mostly by the direct beam.
    applyHaze();
  };

  const setRain = (amount: number, rainTime: number, shutter: number) => {
    // How long the frame's shutter is open, which is the whole of what sets a
    // streak's length (effects/rainShader.ts's uShutter). At 30fps the marks
    // are twice as long, exactly as a camera's would be.
    rainPass.uniforms.uShutter.value = shutter;
    nearRainPass.uniforms.uShutter.value = shutter;
    rainPass.enabled = amount > 0.001;
    rainPass.uniforms.uRain.value = amount;
    rainPass.uniforms.uRainTime.value = rainTime;
    // The street loses the light along with the sky, and by the same amount,
    // because it is lit *by* it — see effects/puddleShader.ts. Read
    // off the rain pass's own uniform rather than repeating the number here:
    // the two being equal is the physical claim, so they should not be able to
    // drift apart.
    const skyExposure = rainPass.uniforms.uExposure.value as number;
    puddlePass.uniforms.uRainExposure.value = 1 + (skyExposure - 1) * Math.min(Math.max(amount, 0), 1);

    // Visibility closes with the rain — see applyHaze.
    hazeRain = amount;
    applyHaze();
    applyNearRainSky();

    // And the rain on this side of the picture (effects/nearRain.ts).
    nearRainPass.uniforms.uRain.value = amount;
    nearRainPass.uniforms.uRainTime.value = rainTime;
    nearRainPass.enabled = amount > 0.001;
    // The same slider rings the water: rain on a puddle is rings, and they are
    // the same term as a footfall's with a shorter life
    // (effects/puddleShader.ts's rainRings).
    puddlePass.uniforms.uRain.value = amount;
  };

  // The last rect, so the water and the haze band can be re-derived from it
  // without waiting for a resize.
  let frameRect: FrameRect = { x: 0, y: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT };

  const applyFrame = () => {
    // Frame rows -> screen v, remembering v runs bottom-up.
    const rowToV = (row: number) => 1 - (row - frameRect.y) / frameRect.height;

    puddlePass.uniforms.uPlateRect.value.set(
      frameRect.x / FRAME_WIDTH,
      1 - (frameRect.y + frameRect.height) / FRAME_HEIGHT,
      frameRect.width / FRAME_WIDTH,
      frameRect.height / FRAME_HEIGHT,
    );
    puddlePass.uniforms.uAspect.value = frameRect.width / frameRect.height;
    // The water's vanishing line, and where in the render the reflection's far
    // end is read from. Both are frame rows put through the same crop, so a
    // phone that loses columns off the sides still images the same hemisphere.
    puddlePass.uniforms.uHorizonV.value = rowToV(WATER_HORIZON_ROW);
    puddlePass.uniforms.uSkyHorizonV.value = 1 - CAMERA_HORIZON_FRACTION;

    const horizonV = rowToV(HORIZON_ROW);
    horizonPass.uniforms.uHazeV.value.set(horizonV, rowToV(HAZE_TOP_ROW));
    // The rain's depth axis is measured from the same line: see the rain pass's
    // uHorizonV.
    rainPass.uniforms.uHorizonV.value = horizonV;
    nearRainPass.uniforms.uNearRain.value = NEAR_RAIN;
  };

  const setFrameRect = (rect: FrameRect) => {
    frameRect = rect;
    applyFrame();
  };

  const setWater = (water: { time: number; wind: number; weave: number }) => {
    puddlePass.uniforms.uTime.value = water.time;
    puddlePass.uniforms.uWind.value = water.wind;
    puddlePass.uniforms.uWeave.value = water.weave;
  };

  const setRipples = (ripples: Ripples) => {
    // The same Vector4 objects the table writes into, not copies: the ripple
    // table is the authority on where the rings are and there is no frame on
    // which the two should be allowed to disagree.
    puddlePass.uniforms.uRings.value = ripples.rings;
    puddlePass.uniforms.uRingCount = ripples.count;
  };

  /** Resolves once the photograph and its key have both settled. */
  const assetsReady = (): Promise<void> => Promise.all(assetPromises).then(() => {});

  applyFrame();

  return {
    outputTexture: () => composer.readBuffer.texture,
    setRenderToScreen: (enabled: boolean) => { composer.renderToScreen = enabled; },
    setSize,
    setFrameRect,
    setWater,
    setRipples,
    assetsReady,
    setDaylight,
    setRain,
    render: () => composer.render(),
  };
}
