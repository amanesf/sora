import './style.css';
import * as THREE from 'three';
import { createRenderer, watchResize } from './core/renderer';
import { createCamera, setCameraHorizon } from './core/camera';
import { visibleRect, applyToCamera } from './core/frame';
import { createSky, updateSky } from './scene/sky';
import { createCloudMaterials } from './scene/clouds';
import { createCloudField, NO_SHADOW_CAST_LAYER } from './scene/cloudField';
import { createControls } from './ui/controls';
import {
  CLOCK_END_HOUR,
  CLOCK_START_HOUR,
  cloudLightForDay,
  daylightAtHour,
} from './core/daylight';
import { createPostFx } from './core/postFx';
import { createCloudShadow } from './scene/cloudShadow';
import { createCloudLayer } from './scene/cloudLayer';
import { createCompose } from './core/compose';
import { CAMERA_HORIZON_FRACTION } from './scene/puddle';
import { createRipples } from './scene/ripples';

// `?fit=frame` gives the whole viewport to the picture and hides the title and
// console — the shape scripts/capture.js measures in (style.css). Applied
// before the renderer is created so the first size is already the right one.
if (new URLSearchParams(window.location.search).get('fit') === 'frame') {
  document.documentElement.classList.add('fit-frame');
}

const appHost = document.querySelector<HTMLDivElement>('#app')!;

const renderer = createRenderer(appHost);
// The canvas is a band inside the page now, not the whole window — its aspect
// comes from the stage element (style.css). watchResize below corrects this
// immediately anyway; the value here only has to be non-degenerate.
const camera = createCamera(Math.max(appHost.clientWidth, 1) / Math.max(appHost.clientHeight, 1));

const scene = new THREE.Scene();

const sky = createSky();
scene.add(sky.mesh);

const postFx = createPostFx(renderer, scene, camera);
const compose = createCompose();
const fitFrame = document.documentElement.classList.contains('fit-frame');
postFx.setRenderToScreen(fitFrame);

// The render resolution is fixed to the reference frame's own pixels, and the
// canvas is then scaled to whatever size the CSS gave it.
//
// This is not a performance choice, it is a correctness one. Every constant in
// core/postFx.ts and the passes it drives — the bloom radius, the Kuwahara
// kernel, the macro-contrast scale, the horizon haze texel — is expressed in
// *buffer pixels*, and every one of them was fitted against the reference at
// 1408x768. Sizing the buffer to the element instead meant those radii covered
// a different fraction of the picture on every screen: the phone's band is
// 515 CSS px wide, so at DPR 2 the same bloom radius spread over 2.7x more of
// the frame than it did when it was tuned, and the picture came out visibly
// softer than the measured one. Two screens showing the same simTime would not
// agree on the image.
//
// Pinning the buffer to the frame makes the app's output identical everywhere
// and identical to what scripts/capture.js measures, which is the only version
// of the picture that has ever been fitted to anything. On the target device it
// is also close to 1:1 in device pixels (448 CSS x DPR 3 = 1344 against 1408),
// so the downscale costs nothing visible.
const stageEl = document.querySelector<HTMLElement>('.stage');

watchResize(renderer, (cssWidth, cssHeight) => {
  // Two resolutions now, and keeping them apart is the point.
  //
  // The *canvas* is the whole page, so it is sized in device pixels like any
  // other canvas. The *picture* is not: it is rendered into core/postFx.ts's
  // buffer at exactly the sub-rect of the reference frame that fits the band,
  // which is the invariant every fitted constant in this project depends on
  // (see the note on buffer-pixel radii below). The canvas getting bigger or
  // smaller does not change how the picture is drawn, only how large it lands.
  // In measurement mode the composer writes straight to the canvas, so the
  // canvas has to be the frame, exactly as it was before any of this existed.
  const dpr = fitFrame ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  renderer.setSize(Math.round(cssWidth * dpr), Math.round(cssHeight * dpr), false);

  // The band the picture goes in. In measurement mode that is the whole canvas.
  const band = stageEl && !fitFrame
    ? stageEl.getBoundingClientRect()
    : { left: 0, top: 0, width: cssWidth, height: cssHeight } as DOMRect;

  // The plate and the 3D camera get the same sub-rect of the reference's
  // 1408x768 frame, so the painted window frames stay registered to the sky
  // whatever shape the band is (core/frame.ts).
  const rect = visibleRect(Math.max(band.width, 1) / Math.max(band.height, 1));
  const bufferWidth = Math.max(Math.round(rect.width), 1);
  const bufferHeight = Math.max(Math.round(rect.height), 1);
  postFx.setSize(bufferWidth, bufferHeight);
  applyToCamera(camera, rect);
  postFx.setFrameRect(rect);

  // Where that band sits on the canvas, in UV with y running up.
  compose.setLayout(
    new THREE.Vector4(
      band.left / cssWidth,
      1 - (band.top + band.height) / cssHeight,
      band.width / cssWidth,
      band.height / cssHeight,
    ),
  );
  compose.setOverlayEnabled(!fitFrame);
  compose.setAspect(cssWidth / Math.max(cssHeight, 1));
});

// Art-directed key light for the clouds — deliberately *not* the true sun
// direction above. Per the Guilty Gear Xrd cel-shading research, professional
// stylized 3D lighting is chosen for how the form reads, not physical
// accuracy. The requested travel is "左手前から右奥方向へ": down and to the
// right, away from the viewer.
//
// The previous value (-0.55, 0.7, 0.55) took "手前" literally and put a third
// of the light vector straight down the camera axis, pointing the lit pole of
// every puff at the lens. That is the flat-light case: the whole visible
// hemisphere sits near the top of the shading curve and no terminator appears
// anywhere on screen. Measured, the reference tower's luminance falls 7.8 per
// 100px from left to right across the mass and its left half is 10.7 brighter
// than its right; this scene managed +0.3 and -1.2 — no lateral modelling at
// all. Nothing downstream could fix that, which is why the rim and the large
// shadow masses never appeared however hard they were pushed: there was no
// shadow side for them to live on.
//
// So the depth component is reversed and the vector swung to the side. Travel
// is still left→right and still downward — the read the direction was chosen
// for — but the source now sits beyond the cloud rather than beside the
// camera, so the near face is the shadow face. Values resolved by sweeping
// candidates through scripts/capture.js + scripts/measure.js and taking the
// one that lands on the reference's gradient, not by eye.
const LIGHT_QUERY = new URLSearchParams(window.location.search).get('light');
const CLOUD_LIGHT_DIR = LIGHT_QUERY
  ? new THREE.Vector3(...(LIGHT_QUERY.split(',').map(Number) as [number, number, number])).normalize()
  : new THREE.Vector3(-0.78, 0.45, -0.44).normalize();

// Live vectors, rewritten by applyControls whenever the clock slider moves.
// CLOUD_LIGHT_DIR above stays the *noon* value it was fitted as; cloudLight is
// what the scene is actually shaded with, and the two are equal at 12:00.
const sunDir = new THREE.Vector3();
let skyDusk = 0;
const cloudLight = CLOUD_LIGHT_DIR.clone();

// No THREE.Light in the scene any more: the cloud material is unlit and
// indexes a colour ramp measured out of the reference image (cloudRamp.ts),
// and sky.ts is its own atmospheric-scattering shader. Adding a
// DirectionalLight/HemisphereLight here would do nothing but cost uniforms.

const materials = createCloudMaterials(CLOUD_LIGHT_DIR);

// Light-space depth map for cloud self-shadowing.
//
// Deliberately tiny — 256 across a ~156km field, so one texel is about 0.6km
// and a single puff is under two texels. At 1024 it worked, but it resolved
// individual lobes: measured band energy rose in the 2-16px range and did not
// move at 40-80px at all, which is the opposite of what this term is for. A
// map too coarse to see one puff can only record where whole masses of cloud
// are, and that is exactly the scale of shadow that groups lobes into a light
// side and a shadow side.
const CLOUD_FIELD_CENTER = new THREE.Vector3(0, 5, -34);
const cloudShadow = createCloudShadow(CLOUD_LIGHT_DIR, CLOUD_FIELD_CENTER, 78, 256);
materials.core.uniforms.uShadowMap.value = cloudShadow.texture;
materials.core.uniforms.uShadowMatrix.value = cloudShadow.matrix;

// Console starting values. The URL wins over the defaults so scripts/capture.js
// can measure a named sky (`?cloud=0.62&rain=0&hour=12`) rather than whatever
// the sliders were last left on — the same reason `?t=` exists. Omitting them
// all gives exactly the noon, dry, reference-fitted frame every statistic in
// this project was measured against.
const query = new URLSearchParams(window.location.search);
const numeric = (key: string): number | undefined => {
  const raw = query.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};
const initial = {
  cloud: numeric('cloud'),
  rain: numeric('rain'),
  hour: numeric('hour'),
  speed: numeric('speed'),
  water: numeric('water'),
  weave: numeric('weave'),
  // `?fps=30` / `?fps=60`. Unlike the others this one is also remembered
  // between visits — see ui/controls.ts — and the URL wins over what was
  // remembered, so a link can still name the frame rate it wants.
  fps: numeric('fps'),
};

const cloudField = createCloudField(scene, materials, CLOUD_LIGHT_DIR, initial.cloud ?? 0.62);

// The high tiers (cirrus, altocumulus) live on their own layer so the shadow
// camera — which stays on layer 0 — never sees them. The view camera has to be
// told to see both. See cloudField.ts's `castsShadow` for why they are excluded
// from the depth pass rather than simply given a weak shadow.
camera.layers.enable(NO_SHADOW_CAST_LAYER);

// The sky is a fullscreen quad that ignores the camera, so it would otherwise
// fill the light-space depth map entirely — and, for the same reason, the
// cloud mask.
const hiddenDuringShadowPass: THREE.Object3D[] = [sky.mesh];

// The clouds on their own, for the echo under the picture (core/compose.ts).
// It never leaves the GPU. The size is a fragment-cost choice only — the pass
// draws the same geometry whatever its resolution — so it is set by how much
// upscale the echo can take before it looks blocky rather than soft, not by
// how much it costs.
const cloudLayer = fitFrame ? null : createCloudLayer(512, 280);
if (cloudLayer) compose.setClouds(cloudLayer.texture);

// The camera is aimed once, and never again.
//
// It looks nearly straight up (scene/puddle.ts's CAMERA_HORIZON_FRACTION), which
// is the single structural difference between this app and the window app it is
// built out of. The rendered frame is not a view of anything: it is the
// hemisphere the puddle is imaging, horizon on the last row and 49° of sky above
// it, and effects/puddleShader.ts reads it back from the water's vanishing line
// downward. There are no scenes to swap between, so there is nothing here that
// has to happen more than once — the resize handler re-applies the frame rect
// through the same pitch.
setCameraHorizon(camera, CAMERA_HORIZON_FRACTION);

/**
 * How many rendered frames it takes before the picture is the picture.
 *
 * The cloud shadow map is filled during the render loop, so frame 0 is shaded
 * against an empty depth map and comes out flat — this is the same reason
 * scripts/capture.js waits before reading the canvas.
 */
const SETTLE_FRAMES = 3;

/** Resolves after `count` frames of the render loop have actually been drawn. */
function drawnFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let seen = 0;
    const tick = () => {
      if (++seen >= count) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const controls = createControls(initial);

/**
 * The rings, and the two verbs.
 *
 * 空を歩く is this: a press puts a ring on the water, the ring's slope displaces
 * the reflection, and the sky moves under your foot. Nothing is drawn at the
 * point of contact — there is no splash sprite and no particle — because the
 * only thing that should happen when you touch a mirror is that what it is
 * reflecting moves.
 *
 * Pointer events rather than clicks, so a finger, a pen and a mouse are all the
 * same gesture, and `pointermove` while held keeps ringing the water so walking
 * across it is a drag. The rate limit is not a debounce: a footfall is an event
 * with a size, and eight of them inside one frame is not a heavier footfall, it
 * is eight rings born at the same radius that sum into one loud ring and read as
 * a bug.
 */
const ripples = createRipples();
postFx.setRipples(ripples);

/** Minimum seconds between rings while a pointer is held down. */
const STEP_INTERVAL = 0.16;
let lastStep = -1;

/**
 * Page pixels -> the picture's own UV.
 *
 * The picture is a band inside the page (core/compose.ts), so a press has to be
 * put through the same rect the compose pass uses, and then through the frame
 * crop — a phone that has lost columns off the sides must still ring the water
 * under the finger rather than a fixed distance from the frame's edge.
 */
function pointerToPicture(event: PointerEvent): { u: number; v: number } | null {
  const band = stageEl?.getBoundingClientRect();
  if (!band || band.width <= 0 || band.height <= 0) return null;
  const u = (event.clientX - band.left) / band.width;
  const v = 1 - (event.clientY - band.top) / band.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v };
}

function step(event: PointerEvent, force = false): void {
  if (!force && rainTime - lastStep < STEP_INTERVAL) return;
  const point = pointerToPicture(event);
  if (!point) return;
  lastStep = rainTime;
  // Softer for a drag than for the first contact: walking through water is a
  // series of smaller disturbances than standing down into it once.
  ripples.press(point.u, point.v, force ? 1 : 0.55);
}

if (stageEl) {
  // The stage is a spacer with nothing in it (index.html), so it has to be told
  // to accept pointers at all; the canvas underneath is aria-hidden and covers
  // the whole page, which would otherwise make "where the picture is" and
  // "where a press lands" two different rectangles.
  stageEl.style.touchAction = 'none';
  stageEl.addEventListener('pointerdown', (event) => {
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    // The hint has been read by definition once this has happened, and it does
    // not come back (style.css).
    stageEl.classList.add('is-touched');
    step(event, true);
  });
  stageEl.addEventListener('pointermove', (event) => {
    if (event.buttons === 0) return;
    step(event);
  });
}

// Everything the console drives, applied once per frame rather than on change
// events: three of the four sliders feed values that also have to be re-derived
// when simTime moves anyway, and a single place that reads them cannot drift
// out of step with itself.
let appliedCloud = -1;
let appliedHour = Number.NaN;
let appliedRain = -1;

/**
 * The cloud the rain brings with it.
 *
 * Until this existed the two sliders were independent, which allowed
 * `cloud=0.2, rain=1.0`: a downpour out of four fair-weather cumulus with open
 * blue between them. That is not a tuning fault, it is a missing causal link —
 * rain falls out of cloud, so a sky that is raining is a sky that is at least
 * mostly closed, and there is no setting of the cloud slider that should be
 * able to say otherwise while the rain slider is up.
 *
 * A floor rather than an override: the cloud slider still chooses everything
 * above it, so "raining under a completely closed deck" and "raining under a
 * broken one" are both still reachable. Only the physically impossible corner is
 * removed.
 *
 * The floor ramps in over the first tenth of the rain slider instead of
 * appearing at the first touch, and lands directly on 0.72 — cloudField.ts's own
 * overcast threshold, where the tiers stop making individual clouds and start
 * making a ceiling — rising to 0.96 at a full downpour.
 *
 * 0.72 and not something gentler because there is no such thing as light rain
 * out of a half-empty sky. Rain of any kind means a deck: the first version of
 * this floor landed at 0.52 and measured 145 mean luminance at rain=0.5 against
 * a dry 172, which is to say the picture at half rain was a summer afternoon
 * with a few streaks on it. The exposure cut cannot fix that on its own, because
 * what makes a rainy sky rainy is not that the sun is dimmer, it is that there
 * is no blue left between the clouds.
 *
 * Exactly zero at rain=0, which is what keeps the dry frame the one every
 * statistic in this project was measured against.
 */
function rainCloudFloor(rain: number): number {
  if (rain <= 0) return 0;
  return THREE.MathUtils.smoothstep(rain, 0.0, 0.10) * (0.72 + 0.24 * Math.min(rain, 1));
}

/**
 * What the rain does to how far you can see, as seen by the *clouds*.
 *
 * The rain pass darkens the frame and washes it toward a rain-sky colour by
 * screen height, and neither of those is distance: the near tower and the bank
 * forty kilometres behind it were washed by exactly the same amount, so the
 * depth ordering the cloud shader's aerial perspective is built to produce
 * survived the storm completely intact. A storm's most conspicuous property is
 * that it destroys that ordering — visibility falls from tens of kilometres to
 * two or three, and the far bank stops being a separate object.
 *
 * The cloud material already has the right machinery for this: it fogs each
 * fragment by its own distance from the camera (scene/cloudShader.ts's haze
 * term). So the rain does not need a new mechanism, only to move that one's
 * three constants — start the fog nearer, thicken it, and retarget it from the
 * pale luminous airlight of a clear midday to the murk.
 *
 * The murk value is sRGB(96,150,186) put through scripts/hdr.js into the
 * pre-tonemap linear HDR the cloud shader works in. It is lighter than the final
 * picture wants because effects/rainShader.ts's exposure cut runs afterwards and
 * takes it down about another 40%.
 */
const DRY_HAZE_START = materials.core.uniforms.uHazeStart.value as number;
const DRY_HAZE_DENSITY = materials.core.uniforms.uHazeDensity.value as number;
const DRY_HAZE_COLOR = (materials.core.uniforms.uHazeColor.value as THREE.Vector3).clone();
const RAIN_HAZE_COLOR = new THREE.Vector3(0.0810, 0.2052, 0.3612);

function applyRainVisibility(rain: number): void {
  const t = THREE.MathUtils.clamp(rain, 0, 1);
  materials.core.uniforms.uHazeStart.value = THREE.MathUtils.lerp(DRY_HAZE_START, 5.5, t);
  materials.core.uniforms.uHazeDensity.value = THREE.MathUtils.lerp(DRY_HAZE_DENSITY, 0.150, t);
  (materials.core.uniforms.uHazeColor.value as THREE.Vector3)
    .copy(DRY_HAZE_COLOR)
    .lerp(RAIN_HAZE_COLOR, t);
  // And the deck's own base goes down with it: a raining cloud is not a thick
  // cloud in less light, it is a thicker cloud (scene/cloudShader.ts's uRainDim).
  materials.core.uniforms.uRainDim.value = THREE.MathUtils.lerp(1.0, 0.52, t);
}

function applyControls(rainTime: number): void {
  const rain = controls.rainAmount();
  if (rain !== appliedRain) {
    appliedRain = rain;
    applyRainVisibility(rain);
  }

  // The cloud the slider asks for, or the cloud the rain requires, whichever is
  // more. Rounded to the slider's own step so that dragging the rain slider does
  // not rebuild the entire cloud field on every intermediate value.
  const cloud = Math.round(
    Math.max(controls.cloudAmount(), rainCloudFloor(rain)) * 100,
  ) / 100;
  if (cloud !== appliedCloud) {
    appliedCloud = cloud;
    cloudField.setCloudAmount(cloud);
    // Same threshold as the overcast tier in cloudField.ts: past three quarters
    // the sky stops being a collection of clouds and becomes a ceiling, and the
    // light under a ceiling is different light.
    materials.core.uniforms.uOvercast.value = THREE.MathUtils.smoothstep(cloud, 0.72, 1.0);
  }

  const hour = THREE.MathUtils.clamp(controls.hour(), CLOCK_START_HOUR, CLOCK_END_HOUR);
  if (hour !== appliedHour) {
    appliedHour = hour;
    const daylight = daylightAtHour(hour);
    sunDir.copy(daylight.sunDir);
    // The cloud key light keeps its fitted bearing and only loses elevation —
    // see core/daylight.ts for why it is not simply swung onto the sun.
    cloudLight.copy(cloudLightForDay(CLOUD_LIGHT_DIR, daylight));
    materials.core.uniforms.uLightDir.value.copy(cloudLight);
    materials.core.uniforms.uSunTint.value.set(
      daylight.sunTint.r, daylight.sunTint.g, daylight.sunTint.b,
    );
    materials.core.uniforms.uSkyTint.value.set(
      daylight.skyTint.r, daylight.skyTint.g, daylight.skyTint.b,
    );
    materials.core.uniforms.uDayBlend.value = daylight.blend;
    cloudShadow.setLightDirection(cloudLight);
    postFx.setDaylight(daylight);
    skyDusk = daylight.dusk;
  }

  // The exposure time the streaks are drawn for.
  //
  // Not simply 1/fps, and the difference is deliberate. A single-frame photo at
  // 1/60 s is the physically exact answer, but the eye is not a 60fps camera: it
  // integrates over something nearer 1/30 s, which is why rain looks streakier
  // to a person standing in it than it does in a still frame, and why it has
  // always been *drawn* streakier than a photograph justifies.
  //
  // Held at 1/30 s at either frame rate, so at 30fps a mark is exactly the
  // distance the drop moves between frames and at 60fps it is twice that. Two
  // to one is the ratio that still reads as motion — it was fifteen to one
  // before this, which is a mark that barely moves at all and is why the rain
  // looked like scratches. Faster than the eye and it stops being visible;
  // slower and it stops moving.
  postFx.setRain(rain, rainTime, Math.max(1 / controls.frameRate(), 1 / 30));

  // The water. On the *real* clock, not simTime, for the same reason the drops
  // are: how fast a ring crosses a puddle is not a statement about how fast the
  // weather is changing, and at the speed slider's default 10x a footfall's
  // rings crossed the frame before the foot had finished landing.
  postFx.setWater({
    time: rainTime,
    wind: controls.waterAmount(),
    weave: controls.weaveAmount(),
  });
}

// Simulated seconds. Every cluster's position, age and weather is a pure
// function of this one number (scene/cloudField.ts), which is what lets
// scripts/capture.js freeze the scene with ?t= and get the same frame every
// time no matter what speed the slider was left at.
// A different sky every time the app is opened.
//
// The whole scene is a pure function of simTime, so this needs no extra seed
// and no extra state: starting the clock at a random point simply lands in a
// different part of a sequence that never repeats. Every cluster is at a
// different stage of a different crossing, built from a different generation
// index, so the arrangement, the shapes and the phases are all new.
//
// The range is about 55 hours of simulated time — some 33 tower crossings —
// which is far more than enough to decorrelate from the last visit while
// staying well inside the precision where the boil phases stay smooth.
//
// `?t=` still wins, which is what keeps scripts/capture.js reproducible: a
// measurement asks for a specific second and gets that second.
const frozen = query.get('t');
let frozenTime: number | null = frozen !== null ? Number(frozen) : null;
let simTime = frozenTime ?? Math.random() * 200000;

// The drops' own clock, in *real* seconds — see effects/rainShader.ts.
//
// The speed slider exists so that a cloud tower's ten-minute life can be
// watched in under a minute, and that is a statement about how fast the
// weather changes. A raindrop's fall speed is not a property of the weather
// changing, so it does not belong on that clock: at the default 10x the drops
// were falling ten times too fast for their own size, and at 30x they were a
// different phenomenon altogether.
//
// Frozen with `?t=` like everything else, so scripts/capture.js still gets the
// same frame twice.
let rainTime = frozenTime ?? 0;
const clock = new THREE.Clock();

// When the next frame is due, for the frame rate cap below.
let nextDraw = 0;

function renderLoop(now: number) {
  requestAnimationFrame(renderLoop);

  // The frame rate cap (ui/controls.ts). Skipping happens *before* the clock is
  // read, which is the whole trick: THREE.Clock only advances when it is asked
  // to, so a skipped tick folds into the next frame's dt and the sky drifts and
  // the rain falls at exactly the same rate at 30 as at 60. Capping the frame
  // rate slows the drawing down, never the weather.
  //
  // A due *time* carried forward, rather than "has an interval passed since the
  // last draw". The naive version cannot hit its target on any display, because
  // rAF only offers ticks at the refresh interval and the elapsed time is
  // almost never exactly the budget: measured against synthetic tick trains,
  // "30" came out at 24.6fps on a 60Hz display and "60" at 43.6fps, and adding
  // slack to fix those two left a 144Hz display at 48fps. Advancing the due
  // time by exactly one interval lets the error cancel instead of accumulating,
  // and lands on 30.0 and 60.0 at 60, 90, 120 and 144Hz alike.
  //
  // The resync is what stops that from running away when a frame costs more
  // than its budget: without it the due time falls permanently behind and every
  // tick draws, which is the one case where a frame rate cap must not add work.
  //
  // Never in measurement mode: scripts/capture.js counts rAF ticks to know when
  // the scene has settled, and a skipped tick is not a rendered frame. The cap
  // cannot change what a frame contains — simTime is frozen under `?t=` — but
  // it could change how many warmup frames the harness actually got, and the
  // measure loop is not the place to introduce that question.
  if (!fitFrame) {
    if (now < nextDraw) return;
    const interval = 1000 / controls.frameRate();
    nextDraw += interval;
    if (nextDraw < now) nextDraw = now + interval;
  }

  const dt = clock.getDelta();
  if (frozenTime === null) {
    simTime += dt * controls.timeScale();
    rainTime += dt;
  } else {
    simTime = frozenTime;
    rainTime = frozenTime;
  }

  applyControls(rainTime);
  // Before the pass reads them: a ring that expired this frame must not be
  // looped over by the shader on the frame it expired.
  ripples.update(rainTime);
  updateSky(sky, camera, sunDir, skyDusk);
  cloudField.update(simTime);

  // After the clusters have moved, before anything is shaded with it.
  cloudShadow.update(renderer, scene, hiddenDuringShadowPass);

  postFx.render();
  if (fitFrame) return;
  // Asked for every frame, never cached: EffectComposer ping-pongs between two
  // render targets, so *which* one holds the finished picture depends on how
  // many passes ran — and the rain pass enables and disables itself. A texture
  // grabbed once at startup is right only half the time.
  compose.setPicture(postFx.outputTexture());
  cloudLayer?.update(renderer, scene, camera, hiddenDuringShadowPass);
  compose.render(renderer);
}

/**
 * Capture hook.
 *
 * scripts/shoot.js drives this to photograph several settings from one page
 * load. That is not a convenience: under SwiftShader almost all of a capture's
 * cost is starting a browser and compiling this scene's shaders, so a sweep
 * done by reloading the page pays that once per frame. Retargeting in place
 * pays it once for the whole sweep, which took a four-frame set from about
 * fifteen minutes to about four.
 *
 * Everything it can set is something the URL can already set, so it grants the
 * harness no reach the address bar does not have.
 */
(window as unknown as { __sora?: unknown }).__sora = {
  /**
   * A ring, at a stated *age*.
   *
   * The pointer cannot be used for this. A ring's whole existence is
   * `now − born`, so on the frozen clock `?t=` gives the harness every ring is
   * either unborn or infinitely old, and the one thing in this app that a still
   * frame cannot show is the thing the app is named after. Backdating the birth
   * puts a ring of a known radius on a frozen frame, which makes a footfall as
   * reproducible as the weather is — see scripts/press.js.
   */
  press(u: number, v: number, age = 0, strength = 1) {
    ripples.press(u, v, strength);
    // The slot the press just took is the one with the newest birth time.
    let newest = 0;
    for (let i = 1; i < ripples.rings.length; i++) {
      if (ripples.rings[i].z > ripples.rings[newest].z) newest = i;
    }
    ripples.rings[newest].z -= age;
    ripples.update(rainTime);
  },
  set(params: { t?: number; cloud?: number; rain?: number; hour?: number }) {
    if (params.t !== undefined) {
      frozenTime = params.t;
      simTime = params.t;
      rainTime = params.t;
    }
    for (const key of ['cloud', 'rain', 'hour'] as const) {
      const value = params[key];
      if (value !== undefined) controls.setValue(key, value);
    }
  },
};

// rAF supplies the timestamp on every subsequent call; the first one is made by
// hand, so it gets the same clock's reading rather than a bare 0 — which would
// otherwise sit a whole page-lifetime behind performance.now() and make the cap
// pass trivially on the first frame.
renderLoop(performance.now());

/**
 * The boot gate: nothing is shown until there is something worth showing.
 *
 * index.html puts the curtain up before the first paint (it has to be done
 * there — this module is deferred, so anything it does happens after the
 * browser has already painted once). This takes it down, and only once all
 * three of the things that arrive separately have arrived:
 *
 *  - the photograph and its key have settled, either by arriving or by being
 *    established as absent (core/postFx.ts's assetsReady — a missing photograph
 *    is a supported state, so the curtain must not hang on one),
 *  - the render loop has drawn enough frames for the cloud shadow map to be
 *    filled, so the sky is modelled rather than flat,
 *  - and any web fonts have settled, so the title does not reflow into place
 *    a moment after the picture appears.
 *
 * Never in measurement mode: scripts/capture.js reads the canvas directly and
 * the stylesheet opts that mode out of the curtain entirely, but there is no
 * reason to make the harness wait on a font either.
 */
if (!fitFrame) {
  const fontsReady = (document as Document & { fonts?: { ready: Promise<unknown> } })
    .fonts?.ready ?? Promise.resolve();
  void Promise.all([
    postFx.assetsReady(),
    drawnFrames(SETTLE_FRAMES),
    fontsReady,
  ]).then(() => {
    document.documentElement.classList.remove('is-booting');
  });
}
