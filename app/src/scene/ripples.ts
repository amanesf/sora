import * as THREE from 'three';

/**
 * The rings the *user* makes — 空を歩く.
 *
 * The rain's own rings are procedural and live entirely in the shader
 * (effects/puddleShader.ts): there are hundreds of them a second, they are all
 * alike, and none of them has to be remembered. A footstep is the opposite of
 * that on every count. There are a handful, each has a birthplace and a moment,
 * and the whole reason the app has a pointer at all is that *this particular*
 * ring came from *that* press. So these are held on the CPU and handed to the
 * shader as a small fixed-size table.
 *
 * Fixed-size because a uniform array is: `MAX_RINGS` is the number the fragment
 * shader loops over on every pixel, so it is a fragment-cost decision rather
 * than a capacity one. Eight is about a second and a half of ordinary tapping
 * before the oldest ring is recycled, and a ring that old has decayed to
 * nothing anyway (`RING_LIFE`).
 *
 * The table is kept sorted by nothing at all — a new ring overwrites whichever
 * slot is deadest, which is the oldest by construction because they all decay
 * on the same clock.
 */
export const MAX_RINGS = 8;

/** How long a ring stays worth drawing, in seconds. Its amplitude is
 * `exp(-age * RING_DECAY)`, so this is where that has fallen to about 2%. */
export const RING_LIFE = 4.0;
const RING_DECAY = 1.0;

export interface Ripples {
  /**
   * A ring, at a point in the picture.
   *
   * `u`/`v` are in the picture's own UV (origin bottom-left), not in canvas or
   * page pixels — main.ts converts a pointer event once, so the water never has
   * to know where on the page it is being drawn.
   *
   * `strength` is 1 for a footfall. Anything smaller is the same event seen
   * from further off; the drop-splash rings a heavy rain throws are not made
   * here at all.
   */
  press: (u: number, v: number, strength?: number) => void;
  /** Advance the table's clock and refresh the uniforms. */
  update: (time: number) => void;
  /** xy = uv of the ring, z = the time it was born, w = its strength. */
  readonly rings: THREE.Vector4[];
  /** How many slots are worth looping over this frame — the shader breaks out
   * early rather than evaluating eight dead rings on every pixel. */
  readonly count: { value: number };
}

export function createRipples(): Ripples {
  const rings: THREE.Vector4[] = Array.from(
    { length: MAX_RINGS },
    // w = 0 is "this slot is empty"; the birth time is far in the past so a
    // slot that has never been used is also the first one recycled.
    () => new THREE.Vector4(0, 0, -1e4, 0),
  );
  const count = { value: 0 };
  let now = 0;

  const press = (u: number, v: number, strength = 1): void => {
    // The deadest slot: the one whose ring was born longest ago. Not "the first
    // empty one" — after the first eight presses there are no empty ones, and
    // the correct thing to lose is always the faintest ring on screen.
    let oldest = 0;
    for (let i = 1; i < MAX_RINGS; i++) {
      if (rings[i].z < rings[oldest].z) oldest = i;
    }
    rings[oldest].set(u, v, now, Math.max(strength, 0));
  };

  const update = (time: number): void => {
    now = time;
    // The high-water mark of slots that still have amplitude in them. The shader
    // loops `i < uRingCount`, so a page nobody has touched costs the water
    // nothing at all.
    let live = 0;
    for (let i = 0; i < MAX_RINGS; i++) {
      if (rings[i].w > 0 && time - rings[i].z < RING_LIFE) live = i + 1;
      else rings[i].w = 0;
    }
    count.value = live;
  };

  return { press, update, rings, count };
}

/** The same decay the shader applies, for anything on the CPU that needs to
 * know how alive a ring is (the light motes a footfall throws). */
export function ringAmplitude(age: number): number {
  return age < 0 || age > RING_LIFE ? 0 : Math.exp(-age * RING_DECAY);
}
