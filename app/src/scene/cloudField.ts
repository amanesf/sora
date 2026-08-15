import * as THREE from 'three';
import { mulberry32 } from '../core/buildNoise';
import {
  createCloudCluster,
  defaultClusterShape,
  type CloudClusterHandle,
  type CloudMaterials,
  type ClusterShape,
} from './clouds';
import { CAMERA_VERTICAL_FOV_DEG } from '../core/camera';
import { FRAME_WIDTH, FRAME_HEIGHT } from '../core/frame';

/**
 * A sky that keeps happening, rather than a fixed arrangement of clouds that
 * sways in place.
 *
 * Clusters are born at the upwind edge of the scene, drift across on the real
 * wind, grow and decay on a thermal's life cycle, and are rebuilt with a new
 * seed once they leave — so the shapes never repeat, and the weather they are
 * born into decides what kind of cloud they are. Everything here is a pure
 * function of `simTime`: the same simulated second always produces the same
 * sky, whatever frame rate or playback speed got us there, which is what
 * scripts/capture.js's `?t=` depends on.
 */

/** Mid-latitude summer synoptic flow, low to mid levels. Every on-screen speed
 * in this file follows from this one number and the geometry — nothing is a
 * "looks about right" pixels-per-second. */
const WIND_SPEED_KM_S = 0.007; // 7 m/s

/** Render layer for clusters whose tier has castsShadow: false. The shadow
 * camera in scene/cloudShadow.ts stays on layer 0, so putting a cluster here
 * keeps it out of the depth pass while the main camera (which enables this
 * layer in main.ts) still draws it normally. */
export const NO_SHADOW_CAST_LAYER = 1;

/** Half-width of the visible sky at distance d, in km: the frame is
 * 2·atan(704/f) = 81.0° wide with f = (768/2)/tan(25°) = 823.5 px/rad. */
const HALF_FOV_TAN = Math.tan(
  Math.atan((FRAME_WIDTH / 2) / ((FRAME_HEIGHT / 2) / Math.tan(THREE.MathUtils.degToRad(CAMERA_VERTICAL_FOV_DEG / 2)))),
);

interface TierSpec {
  name: string;
  /** How many cluster slots this tier keeps alive at once. */
  count: number;
  /** Multiplier on WIND_SPEED_KM_S. Wind is not one number through the depth
   * of the troposphere: it increases steeply with height, and the high tiers
   * here sit near the jet. This is what makes the cirrus visibly overtake the
   * cumulus below it, which is the single most legible cue that the sky has
   * more than one layer in it. Defaults to 1. */
  windScale?: number;
  zNear: number;
  zSpan: number;
  baseAlt: number;
  topLo: number;
  topHi: number;
  radLo: number;
  radHi: number;
  levels: number;
  puffsPerLevel: number;
  /** Cluster radius, roughly, in km — how far past the frame edge a cluster has
   * to travel before it is fully gone. */
  margin: number;
  /**
   * How much bigger than the fitted arrangement this tier's clusters are, and
   * the *only* correct way to ask for that — see the note above TIERS.
   *
   * Read by buildSlot, which applies it to three things at once: the radius up
   * by S, the lobe count up by S squared, and the grain caps down by S. Anything
   * less than all three is not a bigger cloud, it is a differently-built one.
   * Defaults to 1.
   */
  radiusScale?: number;
  /** Coverage this tier contributes at a given weather value.
   * A clear day has scattered fair-weather cumulus and no towers at all; a
   * pre-rain sky is solid low deck. */
  coverageAt: (weather: number) => number;
  /** Whether this tier's clusters go into the light-space depth map
   * (scene/cloudShadow.ts). The high layers do not, and deliberately.
   *
   * A cirrus streak here is up to 40km across and sits above everything, so in
   * a 78km light-space map it would cover a large fraction of the frame and
   * push all of it down by uShadowStrength at once — a flat darkening of the
   * whole sky, which is the exact opposite of what that term exists for (it is
   * there to separate a cloud into a light mass and a shadow mass). Real
   * cirrus barely shadows anything anyway: it is optically thin, which is why
   * you can see the sun through it. */
  castsShadow?: boolean;
  /** Seconds of simulated time this tier looks *ahead* in the weather when
   * deciding whether a cluster exists. Zero for the low tiers.
   *
   * Weather arrives from the top down. The classic warm-front sequence is
   * cirrus first, then middle cloud thickening, then the low deck and rain —
   * high cloud is the part of an approaching system you can see while the air
   * around you is still fine. Sampling the weather at birthTime + lead is the
   * whole mechanism: the cirrus deck fills in during what still looks like a
   * clear afternoon, and by the time the low deck closes over, the cirrus has
   * already been solid for a while. Without it every layer thickened and
   * cleared in lockstep, which reads as one cloud amount applied to a stack of
   * layers rather than as weather moving through. */
  weatherLead?: number;
  /** Per-cluster shape, drawn fresh for every generation (see ClusterShape).
   * `rand` is the cluster's own stream and `weather` the sky it was born into.
   * A tier that leaves this out gets round, upright, cumulus-like masses. */
  shapeFor?: (rand: () => number, weather: number) => ClusterShape;
}

/**
 * The default shape draw for the convective (cumulus-like) tiers.
 *
 * Everything here is a range rather than a constant, because the thing being
 * fixed is that clusters within a tier were statistically identical. A new seed
 * only rearranges lobes inside the same envelope; it does not give you a cloud
 * that is long and low next to one that is compact and upright.
 */
function convectiveShape(rand: () => number, weather: number, sheared: boolean): ClusterShape {
  const shape = defaultClusterShape();
  // Plan-view anisotropy. Cumulus form on updrafts that are themselves drawn
  // out by the flow, so a cloud is typically longer along the wind than across
  // it; the ratio varies a lot, hence the range rather than a fixed factor.
  shape.spread.set(0.85 + rand() * 0.95, 0.72 + rand() * 0.55);
  // Shear. A deep cloud spans a range of altitudes and therefore a range of
  // wind speeds, so its top is displaced downwind of its base. Towers get the
  // strong version (they are 9km deep); shallow tiers get a token amount.
  const shearKm = sheared ? 0.5 + rand() * 1.9 : 0.1 + rand() * 0.5;
  shape.lean.set(shearKm, (rand() - 0.5) * shearKm * 0.5);
  shape.puffStretch.set(1, 0.92 + rand() * 0.22, 1);
  // How coarse this particular cloud's lobes are. 0.25 was the single fitted
  // value; it stays the centre of the range.
  shape.grainCap = 0.19 + rand() * 0.13;
  // The core ceiling is set as a multiple of the rim's, so a cloud that is
  // fine-grained at its edge is fine-grained throughout and a coarse one is
  // coarse throughout — the hierarchy varies per cloud, rather than every
  // cloud having the same big-core/small-rim ratio.
  shape.grainCapCore = shape.grainCap * (2.0 + rand() * 1.2);
  shape.satellites = 1.6 + rand() * 1.6;
  // A cloud in unstable, moist air boils harder than one in a settled sky.
  shape.boil = (0.07 + rand() * 0.09) * THREE.MathUtils.lerp(0.75, 1.25, weather);
  shape.boilPeriod = 150 + rand() * 170;
  return shape;
}

/**
 * Distances and sizes carried over from the fitted static arrangement: they were
 * solved band by band against the reference's per-elevation cloud coverage
 * (see handoff.md §1), so the summer-sky state of this field starts from a
 * distribution that is already measured rather than from a fresh guess.
 */
/**
 * Making a cloud bigger, properly — which is three changes, not one.
 *
 * "The clouds are not big enough" was answered wrongly twice, and both failures
 * are worth keeping because each one names a thing a radius secretly controls.
 *
 * **Radius alone (1.5x) made the grain coarse.** scene/clouds.ts sizes every
 * lobe as a fraction of its level's radius — `radius * 0.98 * ...`, capped at
 * `radius * grainCap` — so a cluster 1.5x wider is built from the *same number*
 * of lobes, each 1.5x bigger. The mass grew and its grain grew with it, and the
 * grain is the one measured thing here: the reference's silhouette bumps run
 * 35-41px and the caps were fitted against them. The result was bigger and no
 * longer a cumulus.
 *
 * **Count alone (+50% slots) made the silhouettes spiky.** Coverage is already
 * near 1.0 for the deck tiers at this weather, so extra slots did not add sky,
 * they added clusters packed close enough to intersect — and two overlapping
 * round silhouettes meet at a point.
 *
 * So the size is a similarity transform of the *whole construction*, and all
 * three parts of it move together:
 *
 *   radius        x S      the mass gets bigger
 *   grain caps    / S      so a lobe stays the size it was fitted at
 *   lobes/level   x S^2    so the density of lobes per unit area is unchanged
 *
 * The square is the part that is easy to miss and the part that does the work:
 * lobes cover area, area goes as the square of the radius, and holding the
 * count fixed while widening the mass thins it into lace. With all three, what
 * comes out is the same cloud photographed from closer — same texture, same
 * outline statistics, more of the frame.
 *
 * It costs what it says it costs. The tower tier goes from 15 lobes a level to
 * 34, over 22 levels, which is ~750 lobes a cluster against ~330. That is the
 * price of the request and it is why this is a per-tier field rather than a
 * global: the towers are the subject and pay it, the two deck tiers are 48
 * slots of backdrop and do not.
 */
const TOWER_SCALE = 1.5;

const TIERS: TierSpec[] = [
  {
    name: 'tower',
    count: 4,
    zNear: 15,
    zSpan: 6,
    baseAlt: 1.4,
    topLo: 8.4,
    topHi: 10.4,
    radLo: 2.0,
    radHi: 2.7,
    levels: 22,
    puffsPerLevel: 15,
    margin: 6,
    // The tier that pays for the size, because it is the one the picture is
    // about. 1.5 puts a mature tower at 3.0-4.05km across against 8.4-10.4km
    // tall — still better than two to one in height, so it is a tower and not a
    // heap, and now wide enough to be the subject of a puddle that images a
    // magnified band of sky.
    radiusScale: TOWER_SCALE,
    // The headline cloud, and what sets where the slider's landmarks fall:
    // towers come in over 0.45-0.72 and are at full strength by ~0.7. Above
    // 0.85 they give way again — a cumulonimbus does not stand out against a
    // raining sky, by then it has merged into the deck.
    // Brought down from smoothstep(w, 0.45, 0.72), and this is the difference
    // between a sky that *can* make a 入道雲 and one that has one.
    //
    // CLOUD sits at 0.56 — deliberately, it is what the reference's water holds
    // — and against the old edges that landed the tower coverage at 0.29. Over
    // four stratified slots that is one tower, somewhere in a 78km scene, seen
    // through a puddle that images a band a few degrees tall. Most openings had
    // no tower in the water at all, which is the real reason the sky read as
    // "small cloud" whatever the radii said.
    //
    // 0.42-0.66 puts it at 0.73, so three of the four slots carry a tower and
    // one is always somewhere worth looking. The far edge comes down with it so
    // the top of the slider still gives them up to the deck — a cumulonimbus
    // does not stand out against a raining sky, by then it has merged into it.
    coverageAt: (w) =>
      THREE.MathUtils.smoothstep(w, 0.42, 0.66) * (1 - 0.55 * THREE.MathUtils.smoothstep(w, 0.85, 1)),
    shapeFor: (rand, w) => convectiveShape(rand, w, true),
  },
  {
    name: 'cumulus',
    count: 10,
    zNear: 6,
    zSpan: 10,
    baseAlt: 1.4,
    topLo: 2.0,
    topHi: 2.9,
    radLo: 0.7,
    radHi: 1.25,
    levels: 4,
    puffsPerLevel: 6,
    margin: 2,
    // Fair-weather cumulus need *some* instability to exist at all, so they
    // start at 0.12 rather than being what an empty sky is full of. As the sky
    // closes over they are absorbed into the deck rather than surviving under
    // it.
    coverageAt: (w) =>
      THREE.MathUtils.smoothstep(w, 0.12, 0.4) * (1 - 0.8 * THREE.MathUtils.smoothstep(w, 0.6, 0.95)),
    shapeFor: (rand, w) => convectiveShape(rand, w, false),
  },
  {
    name: 'deck-near',
    count: 26,
    zNear: 17,
    zSpan: 7,
    baseAlt: 2.3,
    topLo: 5.6,
    topHi: 7.9,
    radLo: 3.0,
    radHi: 5.5,
    levels: 3,
    puffsPerLevel: 8,
    margin: 6,
    // Solid from the summer sky upward. A cumulonimbus does not stand in clear
    // air: it grows out of a low deck, and in the reference the bands below the
    // tower measure 65-79% covered while the tower's own bands measure 25-31%.
    // Anything less than full coverage here left the lower sky too open, which
    // is the one place the eye reads "this is not the reference".
    coverageAt: (w) => THREE.MathUtils.smoothstep(w, 0.3, 0.8),
    shapeFor: (rand, w) => convectiveShape(rand, w, true),
  },
  {
    name: 'deck-mid',
    count: 22,
    zNear: 30,
    zSpan: 11,
    baseAlt: 2.2,
    topLo: 5.0,
    topHi: 8.2,
    radLo: 4.0,
    radHi: 7.5,
    levels: 3,
    puffsPerLevel: 8,
    margin: 8,
    coverageAt: (w) => THREE.MathUtils.smoothstep(w, 0.25, 0.75),
    shapeFor: (rand, w) => convectiveShape(rand, w, true),
  },
  {
    name: 'bank-far',
    count: 15,
    zNear: 55,
    zSpan: 21,
    baseAlt: 1.6,
    topLo: 2.6,
    topHi: 4.4,
    radLo: 5.0,
    radHi: 9.0,
    levels: 3,
    puffsPerLevel: 8,
    margin: 10,
    // The first cloud you get and the last one you lose. Full strength by 0.10,
    // which is what makes the bottom of the slider read as "cloud, but all of
    // it far away" rather than as an empty sky, then easing back at the rain
    // end where the near deck is in front of it anyway.
    //
    // Its floor is 0, not the 0.62 it used to have. A permanently occupied
    // horizon is right for a sky that is always some kind of weather, and wrong
    // for a slider whose zero has to mean no cloud at all.
    coverageAt: (w) =>
      THREE.MathUtils.smoothstep(w, 0.0, 0.10) * (1 - 0.35 * THREE.MathUtils.smoothstep(w, 0.6, 1)),
    shapeFor: (rand, w) => convectiveShape(rand, w, false),
  },
  // --- The high layers ---
  //
  // Everything above was one weather system's worth of convection: all of it
  // low or middle cloud, all of it on the same 7 m/s wind, all of it the same
  // cauliflower. A real sky is layered, and the layers do not agree — they sit
  // at different heights, they are made of different stuff (water droplets
  // below, ice crystals above), and crucially they move at different speeds,
  // because wind roughly triples between the cloud base and the tropopause.
  // That disagreement is what makes a sky read as deep rather than as a
  // painted backdrop, and it is the cheapest realism available here: these two
  // tiers together add ~28 clusters of a few dozen lobes each, against the
  // tower tier's ~1150 lobes per cluster.
  //
  // They are built out of the same scatter code as the cumulus, not a separate
  // system. What makes them look like ice cloud instead is the ClusterShape:
  // one level instead of twenty, lobes stretched far along the wind and
  // squashed flat, and almost no boil (ice cloud does not convect).
  {
    name: 'altocumulus',
    count: 16,
    // 4.6-5.9km, above the cumulus tops and below the anvils. At 22-36km out
    // that puts it just above mid-frame — the band of small regular lumps
    // ("羊雲") that sits between the low deck and the high cirrus.
    zNear: 22,
    zSpan: 14,
    baseAlt: 4.6,
    topLo: 5.3,
    topHi: 6.0,
    radLo: 2.5,
    radHi: 5.0,
    levels: 1,
    puffsPerLevel: 18,
    margin: 8,
    // Mid-level wind, a little over twice the surface flow.
    windScale: 2.2,
    castsShadow: false,
    // Middle of the sequence: about 25 minutes of simulated lead at 1x.
    weatherLead: 1500,
    // Middle cloud is the middle of the sequence that precedes rain (cirrus,
    // then altocumulus/altostratus, then the low deck), so it thickens as the
    // weather closes in and is patchy but present on a fair day.
    coverageAt: (w) =>
      THREE.MathUtils.smoothstep(w, 0.05, 0.3) * (1 - 0.6 * THREE.MathUtils.smoothstep(w, 0.6, 1)),
    shapeFor: (rand) => {
      const shape = defaultClusterShape();
      shape.spread.set(1.6 + rand() * 1.0, 0.6 + rand() * 0.4);
      shape.lean.set(0, 0); // one level: nothing to shear
      // Flattened, but still lumpy — altocumulus is granular, not fibrous.
      shape.puffStretch.set(1.05 + rand() * 0.35, 0.34 + rand() * 0.16, 1.0);
      // Small cap relative to the patch radius: a patch is made of many little
      // cells of similar size, which is exactly the regularity that reads as
      // "mackerel sky" rather than as cumulus.
      shape.grainCap = 0.12 + rand() * 0.06;
      // Altocumulus really is made of same-sized cells, so barely any hierarchy.
      shape.grainCapCore = shape.grainCap * (1.3 + rand() * 0.4);
      shape.satellites = 0.8 + rand() * 0.8;
      shape.boil = 0.03 + rand() * 0.03;
      shape.boilPeriod = 320 + rand() * 260;
      return shape;
    },
  },
  {
    name: 'cirrus',
    count: 12,
    // 9-11km — the tropopause, level with and above the tower anvils. Far
    // enough out (24-46km) that the aerial-perspective term in cloudShader.ts
    // pales them toward the haze colour, which is what high thin ice cloud
    // looks like: bright but low in contrast, never the hard white of a
    // sunlit cumulus crown.
    zNear: 24,
    zSpan: 22,
    baseAlt: 9.0,
    topLo: 9.8,
    topHi: 11.0,
    radLo: 4.0,
    radHi: 9.0,
    levels: 1,
    puffsPerLevel: 14,
    margin: 12,
    // Near the jet. This is the tier the eye catches moving against the rest.
    windScale: 4.2,
    castsShadow: false,
    // Furthest ahead — the first sign of a change. The oscillator's shortest term
    // has a period of 930s, so a lead of 3600s is a substantial fraction of a
    // full swing rather than a token offset.
    weatherLead: 3600,
    // Present on the clearest days (a blue sky with cirrus is the classic fair
    // summer sky) and the first thing to thicken when a front approaches.
    // Peaks early and then *withdraws*: cirrus does not go anywhere when the
    // weather closes in, it simply stops being visible behind the lower cloud.
    // That decline is much of why raising the slider reads as "the cloud is
    // coming closer" rather than "more cloud is being added".
    coverageAt: (w) =>
      THREE.MathUtils.smoothstep(w, 0.02, 0.15) * (1 - 0.75 * THREE.MathUtils.smoothstep(w, 0.45, 0.9)),
    shapeFor: (rand) => {
      const shape = defaultClusterShape();
      // Drawn out hard along the wind and pinched across it: a streak, not a
      // patch. This one number is most of what makes it read as cirrus.
      shape.spread.set(2.6 + rand() * 2.2, 0.3 + rand() * 0.25);
      shape.lean.set(0, 0);
      // And the lobes themselves are filaments — the fallstreak fibres.
      shape.puffStretch.set(2.2 + rand() * 1.4, 0.15 + rand() * 0.12, 0.7 + rand() * 0.3);
      // Coarse relative to the streak: few long fibres, not many small grains.
      shape.grainCap = 0.4 + rand() * 0.25;
      // A fibre has no interior to fill.
      shape.grainCapCore = shape.grainCap;
      shape.satellites = 0.4 + rand() * 0.7;
      // Ice cloud does not convect — it is sheared and it falls. Practically
      // no boil, and what there is happens slowly.
      shape.boil = 0.015 + rand() * 0.02;
      shape.boilPeriod = 600 + rand() * 400;
      return shape;
    },
  },
  {
    /**
     * The ceiling. Only exists at the top of the cloud slider, and it is the
     * tier that makes 100% read as 曇天 rather than as a lot of cumulus.
     *
     * Everything else in this file sits 15-90km away, because that is where
     * cloud you are *looking at* lives. An overcast deck is not something you
     * look at, it is something you are underneath: to cover the top of a frame
     * that reaches 36 degrees of elevation, cloud at 1.5km has to be about 2km
     * away, not 20. That geometry is the whole reason widening and lowering the
     * existing deck tiers could not close the sky on its own — a 1.3km-high
     * sheet 20km out subtends four degrees and sits on the horizon, however
     * wide it is made.
     *
     * So this is its own tier with its own distances, which also keeps the
     * crossing arithmetic honest: tierSpan is derived from zNear, and moving an
     * existing tier's clusters closer without moving its span would have left
     * them off-screen for most of their lives.
     *
     * Twenty smallish clusters rather than a few large ones, and five levels
     * deep rather than two. The first attempt used six-kilometre masses four
     * kilometres away, and one of them covered the entire frame: the sky was
     * certainly closed, but by a single smooth slab with one enormous diagonal
     * edge across it. An overcast ceiling is ragged and continuous, which takes
     * many overlapping masses, and it is *grey*, which takes depth — the lobes
     * on the underside have to be buried under several levels of cloud before
     * the baked optical-depth term has anything to darken them with.
     *
     * NOTE: appended at the end of TIERS on purpose. Slot ids are handed out in
     * array order and seed every cluster's random stream, so inserting a tier
     * in the middle silently reshuffles every tier after it — which it did,
     * and which made a noon capture that should have been untouched differ from
     * its predecessor across 17% of its pixels.
     */
    name: 'overcast',
    count: 20,
    zNear: 4.5,
    zSpan: 12,
    baseAlt: 1.0,
    topLo: 2.6,
    topHi: 3.8,
    radLo: 2.0,
    radHi: 3.8,
    levels: 5,
    puffsPerLevel: 12,
    margin: 6,
    // Nothing at all until the slider's last quarter, then everything.
    coverageAt: (w) => THREE.MathUtils.smoothstep(w, 0.72, 0.97),
    shapeFor: (rand) => {
      const shape = defaultClusterShape();
      // Drawn out flat in both directions — this is a sheet, not a heap.
      shape.spread.set(1.5 + rand() * 0.8, 1.2 + rand() * 0.7);
      shape.lean.set(0.2 + rand() * 0.4, 0);
      shape.puffStretch.set(1.15 + rand() * 0.3, 0.5 + rand() * 0.18, 1.15 + rand() * 0.3);
      // Coarse and heavily overlapped: an overcast base is a continuous
      // ragged ceiling, not a crowd of separate lobes with sky between them.
      shape.grainCap = 0.17 + rand() * 0.09;
      shape.grainCapCore = 0.5 + rand() * 0.18;
      shape.satellites = 1.8 + rand() * 1.0;
      shape.boil = 0.03 + rand() * 0.03;
      shape.boilPeriod = 260 + rand() * 200;
      return shape;
    },
  },
];

/**
 * How the sky changes its mind, as a number in [0,1]. Three sine terms with
 * periods that share no common multiple (≈3.2h, ≈7.5h, ≈1.6h), so the sequence
 * never repeats and yet is a pure function of the clock — no accumulated state
 * to desynchronise a capture. At 30x those periods are 6.4, 15 and 3.2 minutes,
 * which is roughly how fast a real afternoon changes its mind.
 *
 * This is the raw oscillator. What it means as *weather* depends on the preset
 * the console has selected, which maps it into a window (scene/skyPresets.ts):
 * the same wobble becomes "a summer afternoon building towers" or "a fair day
 * with high cloud" depending on where that window sits.
 */
export function weatherOscillation(simTime: number): number {
  const h =
    0.55 * Math.sin(simTime / 1830) +
    0.30 * Math.sin(simTime / 4270 + 1.7) +
    0.15 * Math.sin(simTime / 930 + 4.1);
  return THREE.MathUtils.clamp(0.5 + 0.5 * h, 0, 1);
}

/** Simplified thermal-rise growth curve (plan.md §3.3): height ~ sqrt(t) while
 * rising, a hold at maturity, then decay. */
function towerGrowth(tau: number): number {
  const riseEnd = 0.35;
  const holdEnd = 0.75;
  if (tau < riseEnd) return Math.sqrt(tau / riseEnd);
  if (tau < holdEnd) return 1.0;
  return 1.0 - THREE.MathUtils.smoothstep((tau - holdEnd) / (1.0 - holdEnd), 0.0, 1.0);
}

/**
 * How big the whole mass is, across its life — as distinct from towerGrowth
 * above, which only decides how far up the cloud has been built.
 *
 * These were the same thing before, and that was the bug behind "雲は流れる
 * だけでサイズが変わらない": a cluster's lobes were laid out at build time and
 * then never resized, so once its levels had faded in the cloud was a rigid
 * object being translated. Real cumulus do the opposite of holding still —
 * they are a balance between condensation feeding them and entrainment eating
 * them, and they visibly build, peak and dissolve over their crossing.
 *
 * Asymmetric on purpose: a cloud builds faster than it dies. The curve starts
 * well below 1 rather than at 0 because a cluster is born a full `margin`
 * outside the frame, so the earliest part of its life is never seen; starting
 * at zero would just waste the visible portion on something already grown.
 */
function cloudBulk(tau: number): number {
  const peak = 0.42;
  if (tau < peak) return THREE.MathUtils.lerp(0.55, 1.0, THREE.MathUtils.smoothstep(tau / peak, 0, 1));
  // Slight overshoot at maturity, then a long decay — the mass spreads and
  // thins rather than switching off.
  const decay = (tau - peak) / (1 - peak);
  return THREE.MathUtils.lerp(1.0, 0.5, decay * decay);
}

/** Deterministic [0,1) from a slot and a generation index. */
function hash01(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** How far a cluster of this tier travels between being born off one edge and
 * being retired past the other. Fixed per tier rather than per cluster: it has
 * to be known *before* the slot is built, since it is what decides which
 * generation the clock is in, and a per-cluster span would make that circular. */
function tierSpan(tier: TierSpec): number {
  return 2 * (tier.zNear + tier.zSpan / 2) * HALF_FOV_TAN + 2 * tier.margin;
}

interface Slot {
  tier: TierSpec;
  id: number;
  /** Index within the tier, for the stratified coverage draw below. */
  index: number;
  /** Where in its crossing this slot starts, so the tier's clusters are spread
   * out along the wind rather than arriving in a line. */
  phase: number;
  generation: number;
  handle: CloudClusterHandle | null;
  z: number;
  active: boolean;
  /** The cluster's rough radius in km, kept so the field can answer how much of
   * it stands between the camera and the sun — see sunOcclusion. */
  radius: number;
}

export interface CloudField {
  /**
   * How much cloud stands between the camera and a direction, 0 (clear) to 1
   * (the sun is behind a tower).
   *
   * The reason this exists is that the light in this picture had no cause. The
   * shafts across the road and the sparks in the air (effects/goldenLight.ts)
   * held exactly the same strength whatever the sky was doing, so a cumulus
   * could drift straight across the sun and nothing on the ground would notice
   * — which is the one thing everybody has actually watched happen.
   *
   * Answered from the clusters themselves rather than by rendering anything:
   * each is a mass of known radius at a known place, so the fraction of the
   * sun's disc it covers is a comparison of two angles, and the field's total
   * is the usual product of what each one lets through. About thirty clusters
   * of arithmetic, once a frame.
   */
  sunOcclusion: (direction: THREE.Vector3) => number;
  /** How much cloud, 0 (none) to 1 (raining). Every cluster is rebuilt on the
   * next update so the change is immediate: a slot normally only re-rolls its
   * coverage when it finishes a crossing, which at 1x is up to 102 minutes
   * away, and a slider that takes an hour to take effect is not a slider. */
  setCloudAmount: (amount: number) => void;
  update: (simTime: number) => void;
  /** Live counts, for the perf overlay. */
  stats: () => { clusters: number; rebuilds: number };
}

export function createCloudField(
  scene: THREE.Scene,
  materials: CloudMaterials,
  lightDir: THREE.Vector3,
  initialAmount: number,
): CloudField {
  let cloudAmount = THREE.MathUtils.clamp(initialAmount, 0, 1);

  /**
   * The weather a tier sees: the slider, plus a small residual wobble.
   *
   * The slider *is* the weather axis, so tiers are read at the value the user
   * set. The wobble exists so a sky held at one setting still breathes rather
   * than freezing into a fixed cloud amount — and it is scaled *by* the setting
   * so that zero stays exactly zero. A "no cloud" position that still produced
   * the occasional cloud would be a broken slider.
   */
  const weatherAt = (simTime: number) => {
    const wobble = 0.06 * cloudAmount * (2 * weatherOscillation(simTime) - 1);
    return THREE.MathUtils.clamp(cloudAmount + wobble, 0, 1);
  };
  const slots: Slot[] = [];
  let id = 0;
  for (const tier of TIERS) {
    for (let i = 0; i < tier.count; i++) {
      slots.push({
        tier,
        id: id++,
        index: i,
        phase: hash01(i * 13.7 + tier.zNear, 7.3),
        generation: Number.NaN,
        handle: null,
        radius: 0,
        z: 0,
        active: false,
      });
    }
  }

  let rebuilds = 0;

  function buildSlot(slot: Slot, generation: number, birthTime: number): void {
    slot.handle?.dispose();
    slot.handle = null;
    rebuilds++;

    const rand = mulberry32(((slot.id * 7919 + generation * 104729) >>> 0) || 1);
    const tier = slot.tier;
    const weather = weatherAt(birthTime);
    // What this tier's *coverage* responds to, which for the high layers is
    // the weather still on its way (see TierSpec.weatherLead). Shape and
    // altitude keep using `weather`, the sky the cloud is actually born into.
    const coverageWeather = tier.weatherLead ? weatherAt(birthTime + tier.weatherLead) : weather;

    // Whether this generation exists at all is how cloud cover changes: a slot
    // that fails the coverage test simply stays empty until its next crossing.
    // Cover therefore changes at the pace clouds actually arrive and leave,
    // instead of clouds fading out where they float.
    //
    // Stratified rather than an independent coin flip per slot. With only four
    // tower slots, independent draws left the sky with no cumulonimbus at all
    // for whole crossings — measured, the first 40 minutes of simulated time had
    // none despite coverage standing at 1.0 — because each slot rolled its own
    // luck. Spreading the draws over the unit interval makes the count of active
    // slots track the coverage exactly instead of on average.
    const stratum = (slot.index + hash01(slot.id * 3.1, generation)) / tier.count;
    slot.active = stratum < tier.coverageAt(coverageWeather);
    slot.z = -(tier.zNear + rand() * tier.zSpan);
    slot.generation = generation;
    if (!slot.active) return;

    /**
     * How far into overcast this cloud was born. 0 for anything below about
     * three quarters of the slider; 1 at the top.
     *
     * The coverage curves alone cannot produce a 曇天. They decide *how many*
     * clusters exist, and by 0.8 the deck tiers are already at 1.0 — every slot
     * filled — so the top fifth of the slider had nothing left to say. What was
     * still wrong at that point is geometric: the deck was a scattering of
     * separate 5km masses with 4-6km of vertical development, sitting 2.3km up.
     * That is a field of big cumulus seen from below, not a closed sky.
     *
     * An overcast deck is the opposite shape — low, flat, and continuous. So
     * the top of the slider stops adding clouds and starts changing what a
     * cloud *is*: wider, so neighbours merge into a sheet; lower, so it sits on
     * top of you; and much shallower, so it reads as a ceiling rather than as
     * heaped-up towers.
     */
    const overcast = THREE.MathUtils.smoothstep(weather, 0.72, 1.0);
    const isDeck = tier.name === 'deck-near' || tier.name === 'deck-mid';

    // Wide enough to overlap its neighbours rather than stand next to them.
    // This is what closes the sky: coverage 1.0 with 5km masses still leaves
    // blue between them, and no number of extra slots fixes that as reliably as
    // making each one bigger does.
    const sizeScale = tier.radiusScale ?? 1;
    const radius = (tier.radLo + rand() * (tier.radHi - tier.radLo)) *
      (isDeck ? THREE.MathUtils.lerp(1, 1.8, overcast) : 1) * sizeScale;
    // A pre-rain sky is lower and flatter; a clear one is shallow fair-weather
    // cumulus. Both come out of the same tier by moving base and top, not by
    // swapping in different-looking clouds.
    // ...but only for the convective tiers. A cumulus base is the lifting
    // condensation level, which really does drop as the air gets more humid;
    // the altocumulus and cirrus layers are set by temperature aloft and the
    // tropopause and do not follow the surface at all. Letting the same rule
    // apply to them dropped the cirrus deck from 9km to 5km on a humid day,
    // where it would be sitting inside the middle cloud.
    const altitudeFollowsWeather = tier.baseAlt < 4;
    const baseAlt = (altitudeFollowsWeather
      ? tier.baseAlt * THREE.MathUtils.lerp(1.15, 0.55, weather)
      : tier.baseAlt) * (isDeck ? THREE.MathUtils.lerp(1, 0.62, overcast) : 1);
    const rawTop = baseAlt + (tier.topLo + rand() * (tier.topHi - tier.topLo) - tier.baseAlt) *
      (altitudeFollowsWeather ? THREE.MathUtils.lerp(0.8, 1.15, weather) : 1);
    // Flattened into a ceiling. A stratocumulus deck is on the order of a
    // kilometre thick over hundreds of kilometres across; keeping the 4-6km of
    // vertical development the fair-weather deck has is what kept the top of
    // the slider looking like heaped cumulus rather than like a closed sky.
    //
    // Guarded on `overcast` and not merely blended by it, because the extra
    // rand() draw is itself observable. JavaScript evaluates both arguments of
    // a lerp, so writing this as lerp(rawTop, base + rand(), overcast) pulled a
    // number out of the cluster's random stream even when overcast was 0 —
    // shifting every later draw (level count, lobe count, profile jitter, the
    // whole ClusterShape) for both deck tiers. The result was a midday sky that
    // had no business changing and changed across 16% of its pixels. In a
    // system whose entire reproducibility rests on seeded streams, where a
    // rand() is *called* is as much a part of the contract as what is done
    // with it.
    const top = isDeck && overcast > 0
      ? THREE.MathUtils.lerp(rawTop, baseAlt + 1.6 + rand() * 0.9, overcast)
      : rawTop;

    // Count jitter, so two clusters of the same tier are not built from the
    // same number of parts. Small, but it is the difference between "the same
    // cloud reseeded" and "a different cloud".
    const levels = Math.max(1, Math.round(tier.levels * (0.8 + rand() * 0.45)));
    // More lobes per level under overcast, because the mass is much wider now
    // and the same count spread over it would thin out into a lace. Density is
    // also how the underside gets dark: a thicker, better-packed deck shadows
    // itself, which is the Beer-Lambert route to a grey sky rather than
    // painting one (image-sky-plan.md §3).
    // ...and the square of the size scale on top, which is what keeps a bigger
    // cloud from thinning into lace: lobes cover area, and area goes as the
    // square of the radius.
    const puffsPerLevel = Math.max(
      3,
      Math.round(tier.puffsPerLevel * (0.82 + rand() * 0.4) * (isDeck ? 1 + 0.9 * overcast : 1)
        * sizeScale * sizeScale),
    );

    // The profile constants are the reference fit, but jittered per cluster.
    // Fixed constants meant every tower in the sky had its shoulder at exactly
    // the same fraction of its height and drew in over exactly the same top
    // 12% — the same outline at different sizes. The jitter is kept modest
    // (roughly ±0.08 on the knees) so the tier still averages to the fitted
    // shape; it is the *spread* around it that was missing, not the centre.
    const j = () => (rand() - 0.5) * 2;
    const profile =
      tier.name === 'tower'
        ? (() => {
            // Fitted band by band against the reference (see handoff.md §1):
            // widest at the shoulder, columnar above it, drawing in only over
            // the top ~12%. How high the shoulder sits and how hard the anvil
            // flares are the two things that most distinguish one
            // cumulonimbus from another.
            const shoulder = 0.45 + j() * 0.09;
            const waist = 0.6 + j() * 0.1;
            const capIn = 0.78 + j() * 0.14;
            const capStart = 0.88 + j() * 0.05;
            return (t: number) =>
              radius * (waist + (1 - waist) * THREE.MathUtils.smoothstep(t, shoulder, shoulder + 0.27)) *
              (1 - capIn * THREE.MathUtils.smoothstep(t, capStart, 1.0));
          })()
        : tier.name === 'cumulus'
          ? (() => {
              const floorFrac = 0.7 + j() * 0.14;
              // Where along the height the cloud is widest. sin() peaks dead
              // centre; real cumulus are usually widest below the middle.
              const skew = 0.4 + rand() * 0.25;
              return (t: number) =>
                radius *
                THREE.MathUtils.lerp(
                  floorFrac,
                  1.0,
                  Math.sin(Math.pow(t, Math.log(0.5) / Math.log(skew)) * Math.PI),
                );
            })()
          : (() => {
              const topFrac = 0.4 + j() * 0.18;
              const falloff = 1.4 + rand() * 1.4;
              return (t: number) => radius * THREE.MathUtils.lerp(1.0, topFrac, Math.pow(t, falloff));
            })();

    // The grain caps come down by the same factor the radius went up, so a lobe
    // keeps the size it was fitted at. They are fractions *of the radius*, which
    // is precisely why they have to move when it does.
    const shape = tier.shapeFor?.(rand, weather) ?? defaultClusterShape();
    if (sizeScale !== 1) {
      shape.grainCap /= sizeScale;
      shape.grainCapCore /= sizeScale;
      // ...and the size hierarchy is stretched over the longer list of lobes,
      // which is the fourth thing a radius secretly controls. See
      // ClusterShape.rankSpread: without it the extra lobes all land on the
      // minimum size and the mass comes out as popcorn.
      shape.rankSpread = sizeScale * sizeScale;
    }

    const handle = createCloudCluster(
      slot.id * 31.7 + generation * 5.9,
      new THREE.Vector2(0, slot.z),
      baseAlt,
      top,
      levels,
      profile,
      puffsPerLevel,
      materials,
      lightDir,
      shape,
    );
    if (tier.castsShadow === false) {
      handle.group.traverse((o) => o.layers.set(NO_SHADOW_CAST_LAYER));
    }
    scene.add(handle.group);
    slot.handle = handle;
    slot.radius = radius;
  }

  const wind = new THREE.Vector2();

  function update(simTime: number): void {
    for (const slot of slots) {
      const span = tierSpan(slot.tier);
      const speed = WIND_SPEED_KM_S * (slot.tier.windScale ?? 1);
      const travel = speed * simTime + slot.phase * span;
      const generation = Math.floor(travel / span);
      if (generation !== slot.generation) {
        const birthTime = (generation * span - slot.phase * span) / speed;
        buildSlot(slot, generation, birthTime);
      }
      if (!slot.active || !slot.handle) continue;

      const local = travel - generation * span;
      const tau = THREE.MathUtils.clamp(local / span, 0, 1);
      // Life cycle and crossing are the same clock. A crossing takes 69 minutes
      // at the tower's distance on a 7 m/s wind, and a cumulonimbus lives 30-60
      // minutes, so a cloud that is born as it enters has genuinely finished by
      // the time it leaves — it does not need a separate lifetime to look right.
      wind.set(local - span / 2, 0);
      slot.handle.update(simTime, towerGrowth(tau), wind, cloudBulk(tau));
    }
  }

  function setCloudAmount(amount: number): void {
    const next = THREE.MathUtils.clamp(amount, 0, 1);
    if (next === cloudAmount) return;
    cloudAmount = next;
    // NaN never equals the generation computed in update(), so every slot
    // rebuilds on the next frame — which is also what releases the old
    // clusters' GPU buffers, since buildSlot disposes before it rebuilds.
    for (const slot of slots) slot.generation = Number.NaN;
  }

  /** See the interface. Transmission through each cluster, multiplied. */
  const sunOcclusion = (direction: THREE.Vector3): number => {
    const dir = direction.clone().normalize();
    let through = 1;
    for (const slot of slots) {
      if (!slot.active || !slot.handle) continue;
      const centre = slot.handle.group.position;
      const distance = centre.length();
      if (distance < 1e-3) continue;
      // Only what is on the sun's side of the sky: a cluster behind the camera
      // covers nothing, and the dot product is the cheapest way to say so.
      const along = centre.dot(dir) / distance;
      if (along <= 0) continue;
      // Angular radius of the mass, against the angle it sits off the sun.
      const angularRadius = Math.atan2(slot.radius, distance);
      const offAxis = Math.acos(Math.min(along, 1));
      if (offAxis >= angularRadius) continue;
      // Soft-edged rather than a disc: a cloud has no rim, and a hard test
      // makes the light switch rather than dim.
      const covered = 1 - offAxis / angularRadius;
      through *= 1 - covered * covered * 0.92;
    }
    return 1 - through;
  };

  return {
    update,
    setCloudAmount,
    sunOcclusion,
    stats: () => ({ clusters: slots.filter((s) => s.active).length, rebuilds }),
  };
}
