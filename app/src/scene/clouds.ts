import * as THREE from 'three';
import { mulberry32 } from '../core/buildNoise';
import { buildNoduleGeometry } from './cloudNodule';
import { createCloudMaterials, type CloudMaterials } from './cloudShader';

export { createCloudMaterials };
export type { CloudMaterials };

/**
 * Mesh-instanced clouds — replaces the earlier fullscreen volumetric raymarch
 * for the clouds themselves (the atmosphere/sky in sky.ts is unchanged) after
 * examining amanesf/planet-canvas2's src/clouds.ts, a prior project's cloud
 * system explicitly tuned for "新海誠的な" quality. See cloudNodule.ts for the
 * core technique (baked vertical shading gradient instead of computed
 * self-shadow) and this file's onBeforeCompile hook for the rim/dusk terms
 * ported from that project's coreMaterial.
 */

interface PuffSpec {
  position: THREE.Vector3; // base (pre-wind) position, km
  scale: number;
  stretch: THREE.Vector3; // per-axis scale multiplier — non-uniform puffs, not just uniform balls
  rotationY: number;
  levelFrac: number; // 0 (base) .. 1 (top) — used to fade in with growth
  burial: number; // 0 (fully exposed) .. 1 (tucked in a crevice) — filled in after placement
  boilPhase: number; // where in its own convective cycle this lobe starts
  boilRate: number; // rad/s of simulated time
}

interface Nodule {
  base: THREE.Vector3;
  scale: number;
  stretch: THREE.Vector3;
  rotationY: number;
  levelFrac: number;
  burial: number;
  boilPhase: number;
  boilRate: number;
}

/**
 * What kind of shape a cluster is, beyond its radius profile.
 *
 * The tiers used to describe a cloud with nothing but a size and a profile
 * curve, so every cluster in a tier was the same shape drawn with a different
 * random seed — which is a weaker kind of variety than it sounds, because the
 * scatter statistics were identical and the eye reads statistics, not seeds.
 * These are the per-cluster degrees of freedom that actually change the
 * silhouette: how the mass is stretched on the ground, how far it leans
 * downwind, how coarse its lobes are, and how hard it boils.
 */
export interface ClusterShape {
  /** Horizontal anisotropy of the scatter, applied to puff *positions* rather
   * than their scales — a cloud drawn out along one axis, not a cloud made of
   * stretched balls. Real cumulus are rarely circular in plan. */
  spread: THREE.Vector2;
  /** Downwind lean, km of horizontal offset per unit of normalised height.
   * Wind speed increases with altitude, so any cloud deep enough to feel the
   * difference is sheared; an upright column is the special case, not the
   * rule, and a field of perfectly upright columns is a strong tell. */
  lean: THREE.Vector2;
  /** Multiplier on each puff's own random per-axis stretch. This is how a
   * fibrous high cloud is made out of the same scatter code as a cumulus:
   * stretch the lobes far along the wind and squash them flat. */
  puffStretch: THREE.Vector3;
  /** Ceiling on a single puff's size as a fraction of its level's radius, at
   * the *rim* of the mass — the lobes that make the silhouette. */
  grainCap: number;
  /** The same ceiling at the *core*. Larger, so the inside of the cloud is
   * built from big lobes that overlap into solid mass while the outside stays
   * finely scalloped. The gap between the two is the size hierarchy. */
  grainCapCore: number;
  /**
   * How far the per-level size hierarchy is stretched, when a tier is built
   * from more lobes than the fitted count — see scene/cloudField.ts's
   * radiusScale. 1 for every tier that is not scaled.
   *
   * `rankSize` below is 0.78^i over the level's lobes sorted outward, which is
   * a geometric size hierarchy: a few big lobes in the middle, smaller ones
   * further out. Written against the raw index it silently assumes the count it
   * was fitted at. Hand it 2.25x the lobes — which is exactly what a
   * similarity-scaled cluster needs, since lobes cover area — and the tail runs
   * to 0.78^33, six thousandths, so two thirds of the new lobes land on the
   * `radius * 0.08` floor instead. Every one of them then comes out the *same
   * size*, which is the popcorn failure this cap's own note describes, arriving
   * through the count rather than through the cap.
   *
   * Dividing the exponent by the count multiplier is the whole fix: the
   * hierarchy keeps its shape and its end points and is simply sampled more
   * finely, so a bigger cloud is the same cloud with more lobes in it rather
   * than the same few lobes plus a field of identical crumbs.
   */
  rankSpread: number;
  /** Mean number of satellite lobes riding each main puff. */
  satellites: number;
  /** Convective boil: how much of its own size a lobe swells and shrinks by
   * over its cycle (see update()). */
  boil: number;
  /** Seconds for one boil cycle, before per-puff jitter. */
  boilPeriod: number;
}

export function defaultClusterShape(): ClusterShape {
  return {
    spread: new THREE.Vector2(1, 1),
    lean: new THREE.Vector2(0, 0),
    puffStretch: new THREE.Vector3(1, 1, 1),
    grainCap: 0.25,
    grainCapCore: 0.55,
    rankSpread: 1,
    satellites: 2.3,
    boil: 0.1,
    boilPeriod: 210,
  };
}

export interface CloudClusterHandle {
  group: THREE.Group;
  /**
   * `growth` fades levels in from the base up (a tower building). `bulk` scales
   * every lobe at once (the whole mass swelling and dissolving). They are
   * separate because they are separate things: a cumulus that grew upward but
   * never got any wider was the old behaviour, and it is why the clouds read as
   * rigid props sliding across the sky rather than as clouds.
   */
  update: (elapsed: number, growth: number, windOffset: THREE.Vector2, bulk?: number) => void;
  /** Clusters are now built and thrown away as clouds blow through the scene
   * (scene/cloudField.ts), so the per-cluster geometry clone has to be released
   * — it holds its own instance attribute buffers on the GPU. */
  dispose: () => void;
}

/**
 * Scatters puffs across `levels` height bands from baseAlt to topAlt, each
 * band an inward-biased disc scatter (closer to the band's own centre = bigger
 * puff) — the vertical extension of buildCloudCluster's 2D disc scatter in
 * planet-canvas2. `radiusProfile(t)` (t=0 base..1 top) sets how wide each
 * band's scatter disc is, so a single call can build either a squat cumulus
 * (few levels, roughly constant radius) or a towering cumulonimbus (many
 * levels, bulging in the upper-middle per real cumulonimbus proportions).
 */
// Non-uniform per-axis scale — a puff that's stretched on x/z or squashed on
// y reads as an irregular lump rather than a perfect ball, cheaply (no extra
// geometry, just an anisotropic instance-matrix scale).
function randomStretch(rand: () => number, shape: ClusterShape): THREE.Vector3 {
  // y range tightened (was 0.7-1.3). Combined with the nodule mesh's own
  // vertical squash, the wider range made puffs read as separate flat
  // lozenges stacked in a pile rather than lobes of one mass.
  return new THREE.Vector3(
    (0.72 + rand() * 0.7) * shape.puffStretch.x,
    (0.85 + rand() * 0.4) * shape.puffStretch.y,
    (0.72 + rand() * 0.7) * shape.puffStretch.z,
  );
}

function buildPuffCluster(
  seed: number,
  centerXZ: THREE.Vector2,
  baseAlt: number,
  topAlt: number,
  levels: number,
  radiusProfile: (t: number) => number,
  puffsPerLevel: number,
  lightDir: THREE.Vector3,
  shape: ClusterShape,
): PuffSpec[] {
  const rand = mulberry32(seed >>> 0);
  const boilBase = (Math.PI * 2) / Math.max(shape.boilPeriod, 1);
  const puffs: PuffSpec[] = [];
  const heightSpan = Math.max(topAlt - baseAlt, 0.001);
  // Fixed vertical step between levels, independent of radiusProfile — where
  // the profile pinches in (near the base and top), puffs shrink with it, and
  // a shrunk puff no longer reaches far enough to overlap its neighbouring
  // level, opening a visible gap band. This was reading as a tiered "wedding
  // cake" instead of one continuous tower. minPuffScale (below) and a bigger
  // vertical jitter fix it directly rather than fighting the profile shape.
  const levelSpacing = levels > 1 ? heightSpan / (levels - 1) : heightSpan;

  for (let l = 0; l < levels; l++) {
    const t = levels === 1 ? 0.35 : l / (levels - 1);
    const levelAlt = baseAlt + t * heightSpan;
    const radius = radiusProfile(t);

    const count = puffsPerLevel + Math.floor(rand() * 2);
    // Hierarchical clumping, not a uniform disc scatter. A uniform scatter
    // spreads puffs evenly, and evenly-spread same-ish spheres read as
    // broccoli — a regular bobbly crust with sky showing between the bobbles.
    // Real cumulus (and the reference) is lumpy at two scales: a handful of
    // big structural masses per level, each carrying its own crowd of smaller
    // lobes. Scattering around a few clump centres instead reproduces that,
    // and the irregular gaps between clumps are what stop the outline reading
    // as a circle of beads.
    const clumpCount = 2 + Math.floor(rand() * 3);
    const clumps: { x: number; z: number; spread: number; weight: number }[] = [];
    for (let k = 0; k < clumpCount; k++) {
      const ca = rand() * Math.PI * 2;
      // Reach out to nearly the full band radius (was 0.75). Clump centres
      // clustered near the axis left the outer part of every band thinly
      // populated, so the mass came out narrower than its own radius profile
      // and the tower read as a column whatever that profile said.
      const cr = Math.pow(rand(), 0.5) * radius * 0.95;
      clumps.push({
        x: Math.cos(ca) * cr,
        z: Math.sin(ca) * cr,
        spread: radius * (0.22 + rand() * 0.3),
        // Uneven weights so one clump dominates the level rather than all
        // clumps coming out the same size — the "big lobe with satellites"
        // hierarchy rather than several equal blobs.
        weight: 0.35 + rand() * 1.3,
      });
    }
    const totalWeight = clumps.reduce((acc, c) => acc + c.weight, 0);

    const centers: { x: number; z: number; clumpWeight: number }[] = [];
    for (let i = 0; i < count; i++) {
      // Pick a clump proportionally to its weight, then scatter tightly
      // around it.
      let pick = rand() * totalWeight;
      let clump = clumps[clumps.length - 1];
      for (const c of clumps) {
        pick -= c.weight;
        if (pick <= 0) { clump = c; break; }
      }
      const a = rand() * Math.PI * 2;
      const r = Math.pow(rand(), 0.5) * clump.spread;
      centers.push({ x: clump.x + Math.cos(a) * r, z: clump.z + Math.sin(a) * r, clumpWeight: clump.weight });
    }
    centers[0].x *= 0.25;
    centers[0].z *= 0.25;
    centers.sort((a, b) => a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z));

    centers.forEach((c, i) => {
      const dist = Math.sqrt(c.x * c.x + c.z * c.z) / Math.max(radius, 1e-4);
      const rankSize = Math.pow(0.78, i / Math.max(shape.rankSpread, 1e-3));
      const bulk = 1 - dist * 0.55;
      // Wide size variety ("サイズもバラバラに") instead of the previous
      // narrow 0.8-2.2 band: mostly small/medium grains with occasional
      // larger ones. Capped at 2.0 (was an unbounded pow(rand,2.2)*3.2 tail
      // that could spike a single puff to ~3.6x — one puff that large
      // swallows an entire level's worth of neighbours into one smooth
      // sphere, which is the opposite of "小さく複雑な塊".
      const grain = (0.45 + Math.pow(rand(), 2.2) * 1.55) * (0.6 + c.clumpWeight * 0.5);
      // 0.62→0.82: the reference has essentially no sky visible between
      // lobes within the body of the cloud — puffs need to overlap generously,
      // not just touch, or gaps show through as translucent halo instead of
      // solid mass.
      const puffScaleRaw = radius * 0.98 * rankSize * bulk * grain * (0.6 + rand() * 0.7);
      // Hard cap relative to the level radius: no single puff should be able
      // to outgrow the band it's scattered in, whatever grain rolled.
      // Cap tightened 0.95 -> 0.5 of the level radius. Comparing crops of the
      // render and the reference side by side showed the detail gap is
      // geometric, not textural: the reference's cloud is built from many
      // small lobes whose lit rims read as hard edges against the lobes
      // behind, while the render was a handful of large lobes with soft
      // gradients between them. No amount of shading noise produces edges —
      // only more, smaller silhouettes do.
      // 0.31 -> 0.25 of the level radius. Same measurement as the nodule
      // displacement above: the silhouette's bumps come out at 41px mean
      // radius against the reference's 35px, and a bump on the outline *is* a
      // puff seen edge-on, so the only way to shrink one is to shrink the
      // other.
      // ...but the cap is not uniform across the mass any more, and that is
      // the point.
      //
      // A single cap applied everywhere is what destroys the size hierarchy:
      // whatever `grain` rolls, every lobe that reaches the ceiling comes out
      // at exactly the same size, so the cloud ends up built from one size of
      // ball. That is both halves of the complaint at once. Same-size balls
      // packed together read as popcorn, and — because the gaps between equal
      // spheres are also all the same and none of them is plugged by anything
      // bigger — the sky shows through the middle of the mass. Measured, 0.2%
      // of cloud pixels sat 55-97 luminance below the cloud around them, and
      // sampling one gave rgb(99,174,220) against a neighbouring lobe at pure
      // white: a hole to the sky reading as a black blotch.
      //
      // A real cumulus is not uniform in this way. Its outside is scalloped
      // into small lobes, which is what the earlier 0.25 cap was fitted to
      // (the silhouette's bumps measured 41px mean radius against the
      // reference's 35px), while its inside is solid — you do not see through
      // the body of a cumulus. So the ceiling now depends on where the lobe
      // sits: generous in the core, tight at the rim. The interior gets lobes
      // big enough to plug each other's gaps, the silhouette keeps its fine
      // scalloping, and the range between them *is* the size hierarchy that
      // was missing.
      const rim = THREE.MathUtils.smoothstep(dist, 0.35, 0.95);
      const cap = radius * THREE.MathUtils.lerp(shape.grainCapCore, shape.grainCap, rim);
      const puffScale = Math.min(puffScaleRaw, cap);
      // Guarantee vertical reach across at least ~70% of a level step, and
      // scatter within a wider vertical band (was radius*0.18, tiny compared
      // to levelSpacing once profile-shrunk) — puffs from adjacent levels now
      // interleave instead of sitting in strict horizontal bands.
      const scale = Math.max(puffScale, radius * 0.08, levelSpacing * 0.36);
      const yJitter = (rand() - 0.5) * levelSpacing * 1.1;
      // Anisotropy and shear are applied here, to the scattered *offset* from
      // the cluster axis, so they change the shape of the mass without
      // touching any of the size statistics the lobes were tuned to.
      const position = new THREE.Vector3(
        centerXZ.x + c.x * shape.spread.x + shape.lean.x * t,
        levelAlt + yJitter,
        centerXZ.y + c.z * shape.spread.y + shape.lean.y * t,
      );
      const stretch = randomStretch(rand, shape);
      puffs.push({
        position,
        scale,
        stretch,
        rotationY: rand() * Math.PI * 2,
        levelFrac: t,
        burial: 0,
        boilPhase: rand() * Math.PI * 2,
        // Small lobes turn over faster than large ones — convective overturning
        // time goes with the size of the cell — so the rate is scaled by how
        // big this puff came out relative to its level.
        boilRate: boilBase * (0.6 + rand() * 0.8) * (1 + 0.9 * (1 - Math.min(scale / Math.max(radius * shape.grainCap, 1e-4), 1))),
      });

      // A tier of small satellite puffs riding on each main puff — "小さく
      //複雑な塊" (reference-image analysis: the silhouette is a hierarchy of
      // round scallops at 2-3 size scales, large lobes rimmed with medium
      // ones), not texture or a single size of ball. At least one guaranteed
      // (was 0-2, i.e. often none at all — undercounted against a reference
      // that has zero "plain, unscalloped" puffs).
      // Fewer, and held close. Blurring both images at sigma 80 showed the
      // reference carries five times more contrast at that scale than this
      // render did, and a large part of that gap is compositional rather than
      // tonal: the reference's cloud masses and its areas of sky are each
      // large and unbroken, while this cloud was fringed with a spray of
      // detached specks that punched sky through the mass and cloud through
      // the sky, so both averaged out to the same mid value at large scale.
      const parent = puffs[puffs.length - 1];
      const satelliteCount = Math.round(shape.satellites * (0.5 + rand()));
      for (let s = 0; s < satelliteCount; s++) {
        const sa = rand() * Math.PI * 2;
        const sr = parent.scale * (0.2 + rand() * 0.3);
        const satPos = position.clone().add(
          new THREE.Vector3(Math.cos(sa) * sr, (rand() - 0.5) * sr * 0.6, Math.sin(sa) * sr),
        );
        puffs.push({
          position: satPos,
          scale: parent.scale * (0.3 + rand() * 0.42),
          stretch: randomStretch(rand, shape),
          rotationY: rand() * Math.PI * 2,
          levelFrac: t,
          burial: 0,
          boilPhase: rand() * Math.PI * 2,
          boilRate: boilBase * (1.3 + rand() * 1.2),
        });
      }
    });
  }

  // Self-shadowing, baked per-instance rather than computed from real-time
  // per-pixel neighbour lookups (this is mesh instancing, not a raymarched
  // field — no shading-time access to "what's nearby").
  //
  // The main term is a genuine optical depth toward the light: from each
  // puff's centre, shoot a ray along the light direction and accumulate the
  // chord it cuts through every other puff's sphere, then convert to a
  // transmittance by Beer-Lambert. This replaces an earlier heuristic that
  // only scored *local* neighbour overlap, which could not produce what the
  // measurement said was missing — the reference's deepest shadows reach
  // luminance 148 and a blue/red separation of 149, where the heuristic
  // version bottomed out at 173/100. Local overlap is bounded by how many
  // neighbours touch one puff, so it cannot distinguish "on the shaded side
  // of the cloud" from "buried one lobe deep"; only integrating along the
  // light ray gives the large contiguous dark regions that produce the deep
  // end of the reference's tonal range.
  const L = lightDir.clone().normalize();
  const oc = new THREE.Vector3();
  for (const puff of puffs) {
    let tau = 0;
    let localOverlap = 0;
    for (const other of puffs) {
      if (other === puff) continue;
      oc.copy(other.position).sub(puff.position);
      const along = oc.dot(L);
      const distSq = oc.lengthSq();

      if (along > 0) {
        // Ray-sphere: perpendicular miss distance from the light ray to this
        // occluder's centre.
        const perpSq = distSq - along * along;
        const rSq = other.scale * other.scale;
        if (perpSq < rSq) {
          // Chord length normalised by the occluder's own radius, so a big
          // and a small puff contribute in proportion to how much of the ray
          // they actually fill rather than to their absolute size. The
          // exponential falloff with distance softens shadows cast from far
          // up-light, standing in for the penumbra of an extended source.
          const chord = 2 * Math.sqrt(rSq - perpSq);
          tau += (chord / other.scale) * Math.exp(-along * 0.12);
        }
      }

      // Secondary, undirected term: plain crevice ambient occlusion, kept
      // because a puff wedged among neighbours is darker even on its lit side.
      const d = Math.sqrt(distSq);
      const combined = puff.scale + other.scale;
      if (d < combined && d > 1e-6) localOverlap += (combined - d) / puff.scale;
    }

    const cast = 1 - Math.exp(-tau * 0.105);
    const packed = 1 - Math.exp(-localOverlap * 0.09);
    puff.burial = THREE.MathUtils.clamp(cast * 0.74 + packed * 0.26, 0, 1);
  }

  return puffs;
}

// Base meshes are shared across clusters (they are the expensive part), so the
// number of them is the hard limit on how many *distinct* lobe shapes the sky
// can contain. Five was low enough to see: a cluster carries hundreds of lobes,
// so each base mesh appeared dozens of times within one cloud, and repeated
// silhouettes at that density read as a pattern however the instances are
// scaled and rotated. Twelve costs twelve 40x22 spheres of memory — nothing —
// and cuts the repeat rate per cluster by the same factor.
const NODULE_VARIANTS = 12;
const coreGeometryCache = new Map<number, THREE.BufferGeometry>();
function coreGeometryFor(variant: number): THREE.BufferGeometry {
  let g = coreGeometryCache.get(variant);
  if (!g) {
    g = buildNoduleGeometry(variant * 97.3 + 11, 1);
    coreGeometryCache.set(variant, g);
  }
  return g;
}

export function createCloudCluster(
  seed: number,
  centerXZ: THREE.Vector2,
  baseAlt: number,
  topAlt: number,
  levels: number,
  radiusProfile: (t: number) => number,
  puffsPerLevel: number,
  materials: CloudMaterials,
  lightDir: THREE.Vector3,
  shape: ClusterShape = defaultClusterShape(),
): CloudClusterHandle {
  const specs = buildPuffCluster(
    seed,
    centerXZ,
    baseAlt,
    topAlt,
    levels,
    radiusProfile,
    puffsPerLevel,
    lightDir,
    shape,
  );
  const nodules: Nodule[] = specs.map((s) => ({
    base: s.position,
    scale: s.scale,
    stretch: s.stretch,
    rotationY: s.rotationY,
    levelFrac: s.levelFrac,
    burial: s.burial,
    boilPhase: s.boilPhase,
    boilRate: s.boilRate,
  }));

  const group = new THREE.Group();
  // Cloned per cluster because the per-instance attributes below live on the
  // geometry: the displaced base mesh is cached and shared (it is the
  // expensive part), but each cluster needs its own attribute buffers or
  // clusters would overwrite each other's occlusion values.
  const coreGeom = coreGeometryFor(Math.abs(Math.floor(seed)) % NODULE_VARIANTS).clone();

  const coreMesh = new THREE.InstancedMesh(coreGeom, materials.core, nodules.length);
  group.add(coreMesh);

  // Per-instance inputs to the shading term (see cloudShader.ts): how deeply
  // this puff sits in another puff's shadow, and a stable random offset so
  // neighbouring puffs don't sample identical noise and reveal that they are
  // all the same five base meshes.
  const occlusions = new Float32Array(nodules.length);
  const seeds = new Float32Array(nodules.length);
  const tints = new Float32Array(nodules.length);
  // Position relative to the cluster centre, fixed at build time. This is the
  // coordinate the cloud-scale shading field is evaluated in: using the live
  // world position instead would leave the macro pattern standing still in
  // space while the cloud drifts through it on the wind.
  const clusterPos = new Float32Array(nodules.length * 3);
  for (let i = 0; i < nodules.length; i++) {
    occlusions[i] = nodules[i].burial;
    const h = (nodules[i].base.x * 12.9898 + nodules[i].base.z * 78.233 + nodules[i].base.y * 37.719) % 17.0;
    seeds[i] = h;
    // A per-lobe tonal offset. Every lobe is one of the same handful of base
    // meshes lit by the same light, so each small one ends up with an
    // identically bright cap and a crowd of them reads as popcorn — a texture
    // of repeated identical highlights rather than a cloud. Nudging each
    // lobe's whole shading term up or down a little breaks the repetition
    // without disturbing the measured tonal distribution, since the offsets
    // are symmetric about zero.
    tints[i] = ((((h * 7.13) % 1.0) + 1.0) % 1.0) - 0.5;
    clusterPos[i * 3 + 0] = nodules[i].base.x - centerXZ.x;
    clusterPos[i * 3 + 1] = nodules[i].base.y - (baseAlt + topAlt) * 0.5;
    clusterPos[i * 3 + 2] = nodules[i].base.z - centerXZ.y;
  }
  coreGeom.setAttribute('aOcclusion', new THREE.InstancedBufferAttribute(occlusions, 1));
  coreGeom.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  coreGeom.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 1));
  coreGeom.setAttribute('aClusterPos', new THREE.InstancedBufferAttribute(clusterPos, 3));

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  function update(elapsed: number, growth: number, windOffset: THREE.Vector2, bulk = 1): void {
    for (let i = 0; i < nodules.length; i++) {
      const n = nodules[i];
      // Growth fades a level in (and slightly up) rather than popping —
      // levels above the current growth fraction shrink toward zero.
      const growthVisibility = THREE.MathUtils.smoothstep(growth, n.levelFrac - 0.12, n.levelFrac + 0.02);

      // Convective boil. A cumulus is not a solid that translates: it is a
      // standing pattern in rising air, and its individual turrets visibly
      // swell and collapse on a timescale of a minute or two while the cloud
      // as a whole drifts. Each lobe therefore breathes on its own phase and
      // its own rate, which is also what stops a translating cluster reading
      // as one rigid object — nothing in the mass moves quite in step.
      //
      // Deliberately a function of `elapsed` (= simTime) and per-puff
      // constants only, with no accumulated state, so the whole field stays
      // the pure function of simTime that scripts/capture.js's `?t=` needs.
      const cycle = elapsed * n.boilRate + n.boilPhase;
      const breathe = 1 + shape.boil * Math.sin(cycle);
      // A little vertical drift with it. Scaling alone leaves each lobe pinned
      // to a fixed centre, which still reads as a fixed structure pulsing;
      // letting the crown of the cycle sit slightly higher gives the mass the
      // slow roll of air actually going up through it.
      const lift = shape.boil * n.scale * 0.35 * Math.sin(cycle * 0.5 + n.boilPhase);

      // `bulk` is a *similarity* transform on the cluster: positions scale
      // with it as well as sizes, so the whole mass grows and shrinks while
      // staying the same shape.
      //
      // Scaling only the sizes — which is what this did at first — pulls the
      // lobes apart as the cloud dissolves, and the gaps that opens go all the
      // way through to the sky. Measured on the frame this produced, 0.2% of
      // cloud pixels sat 55-97 luminance below the cloud around them, and
      // sampling one gave rgb(99,174,220) with a neighbouring lobe at pure
      // white: sky seen through a hole in the middle of a cloud, reading as a
      // black blotch. Under a similarity transform the overlap between any two
      // lobes is invariant, so no bulk value can open a gap that was not there
      // at full size — and the per-instance `burial` baked in buildPuffCluster,
      // which was computed from the full-size geometry, stays correct too.
      //
      // Scaled about the cluster's *base*, not its centre: a cloud's base is
      // its condensation level and does not move, so a shrinking cloud settles
      // downward from the top rather than rising off its own base.
      p.set(
        centerXZ.x + (n.base.x - centerXZ.x) * bulk + windOffset.x,
        baseAlt + (n.base.y - baseAlt) * bulk + lift,
        centerXZ.y + (n.base.z - centerXZ.y) * bulk + windOffset.y,
      );
      q.setFromAxisAngle(up, n.rotationY);

      const coreScale = n.scale * bulk * breathe * Math.max(growthVisibility, 0.0001);
      s.set(coreScale * n.stretch.x, coreScale * n.stretch.y, coreScale * n.stretch.z);
      m.compose(p, q, s);
      coreMesh.setMatrixAt(i, m);
    }
    coreMesh.instanceMatrix.needsUpdate = true;
  }

  update(0, 1, new THREE.Vector2(0, 0));

  function dispose(): void {
    coreMesh.dispose();
    coreGeom.dispose();
    group.clear();
  }

  return { group, update, dispose };
}
