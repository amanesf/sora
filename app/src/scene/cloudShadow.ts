import * as THREE from 'three';

/**
 * Cloud self-shadowing from a light-space depth map.
 *
 * This exists because of a specific measured failure. The cloud shader already
 * computes an occlusion term by integrating optical depth along the light ray
 * through the cluster's puffs, and that term is correct — but it produces
 * almost no *visible* large-scale structure, for a reason that is obvious in
 * hindsight: only the cluster's outer shell is ever on screen, and every puff
 * on the outer shell has roughly the same small optical depth. The variation
 * the integral captures is all buried inside the cloud where nothing can see
 * it.
 *
 * A depth map from the light's point of view has the opposite property. It
 * answers "is this visible surface behind another part of the cloud, as seen
 * from the sun", which varies exactly where it needs to — across the visible
 * shell, at the scale of whole cloud masses. That is the missing 40-80px and
 * >80px contrast: the upper tower casting across the lower body, one bank
 * shadowing the next.
 *
 * The map is deliberately sampled with a wide, many-tap PCF. Cloud shadows are
 * not meant to have a readable edge here; what is wanted is a soft partial
 * occlusion that groups lobes into large light and shadow masses.
 */
export interface CloudShadow {
  texture: THREE.Texture;
  /** World space -> light clip space. Feed to the cloud material.
   * Mutated in place by setLightDirection, so the material's uniform keeps
   * pointing at the same object. */
  matrix: THREE.Matrix4;
  /** Re-aim the light camera. The key light is no longer fixed — it flattens
   * onto the horizon as the sun sets (core/daylight.ts) — and a depth map still
   * rendered from the noon direction would put every cloud's shadow on the
   * wrong side of it at dusk. */
  setLightDirection: (direction: THREE.Vector3) => void;
  update: (renderer: THREE.WebGLRenderer, scene: THREE.Scene, hidden: THREE.Object3D[]) => void;
  dispose: () => void;
}

/** GLSL for sampling the map. three.js's own packing constants, so the
 * unpacking matches MeshDepthMaterial's RGBADepthPacking exactly. */
export const CLOUD_SHADOW_GLSL = /* glsl */ `
  const float ShadowUnpackDownscale = 255.0 / 256.0;
  const vec3 ShadowPackFactors = vec3(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0);
  float unpackShadowDepth(const in vec4 v) {
    return dot(v, ShadowUnpackDownscale / vec4(ShadowPackFactors, 1.0));
  }

  float sampleCloudShadow(sampler2D shadowMap, mat4 shadowMatrix, vec3 worldPos, float texel, float bias, float radius) {
    vec4 lp = shadowMatrix * vec4(worldPos, 1.0);
    vec3 sc = lp.xyz / lp.w * 0.5 + 0.5;
    // Outside the map is lit, not shadowed — otherwise everything beyond the
    // map's coverage would slam to full shadow at its border.
    if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;

    float lit = 0.0;
    float step = texel * radius;
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        vec2 off = vec2(float(x), float(y)) * step;
        float d = unpackShadowDepth(texture2D(shadowMap, sc.xy + off));
        lit += (sc.z - bias) <= d ? 1.0 : 0.0;
      }
    }
    return lit / 25.0;
  }
`;

export function createCloudShadow(
  lightDirection: THREE.Vector3,
  fieldCenter: THREE.Vector3,
  fieldRadius: number,
  size = 1024,
): CloudShadow {
  const target = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  target.texture.generateMipmaps = false;

  const camera = new THREE.OrthographicCamera(
    -fieldRadius, fieldRadius, fieldRadius, -fieldRadius,
    0.1, fieldRadius * 4,
  );

  const matrix = new THREE.Matrix4();

  const setLightDirection = (direction: THREE.Vector3) => {
    camera.position.copy(direction).normalize().multiplyScalar(fieldRadius * 2).add(fieldCenter);
    camera.lookAt(fieldCenter);
    camera.updateMatrixWorld(true);
    matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  };
  setLightDirection(lightDirection);

  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

  const update = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, hidden: THREE.Object3D[]) => {
    const restore = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = depthMaterial;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(scene, camera);
    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevTarget);

    hidden.forEach((o, i) => { o.visible = restore[i]; });
  };

  return {
    texture: target.texture,
    matrix,
    setLightDirection,
    update,
    dispose: () => { target.dispose(); depthMaterial.dispose(); },
  };
}
