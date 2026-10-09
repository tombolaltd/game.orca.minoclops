// PARITY CONTRACT: this file must be byte-identical content (modulo imports)
// to its twin — editor `src/services/three/shadowQuality.ts` and runtime
// `templates/arcade-base-game-template/game/src/core/services/orca/scene-3d-shadows.ts`.
// If you change one, change both.
//
// 3D shadow quality: the tier table, and applying a tier to a three.js
// renderer, its directional / point lights and directional shadow cameras, so
// the editor preview and the game cast the same shadows.
//
// Pure module with NO imports: the THREE namespace is passed in, because the
// game compiles with TypeScript 4.9 and cannot type three, and the editor
// confines its three imports to `src/services/three/`.

export const SHADOW_QUALITIES = ['off', 'low', 'medium', 'high', 'ultra'] as const;

export type ShadowQuality = typeof SHADOW_QUALITIES[number];

export const DEFAULT_SHADOW_QUALITY: ShadowQuality = 'medium';

export interface ShadowQualityParams {
    /** False only for 'off'; the pass itself also needs something that casts. */
    enabled: boolean;
    /** Square map edge in texels, clamped to the GPU; 0 when off. */
    mapSize: number;
    /** PCF blur radius; 0 when off. */
    radius: number;
    directionalBias: number;
    pointBias: number;
    normalBias: number;
}

export interface ApplyShadowQualityOptions {
    /** Whether anything casts. Default: some mesh in the scene has `castShadow`. */
    anyCaster?: boolean;
    /** The lights to drive. Default: every directional / point light in the scene. */
    lights?: ArrayLike<ShadowThree>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ShadowThree = any;

// three r186 removed PCFSoftShadowMap (it warns and falls back to PCF), so the
// soft tiers widen PCF's Vogel-disk `radius` instead.
const SHADOW_TIERS: { [K in Exclude<ShadowQuality, 'off'>]: { mapSize: number; radius: number } } = {
    low: { mapSize: 512, radius: 1 },
    medium: { mapSize: 1024, radius: 1 },
    high: { mapSize: 2048, radius: 3 },
    ultra: { mapSize: 4096, radius: 4 },
};

export const SHADOW_DIRECTIONAL_BIAS = -0.0005;
export const SHADOW_POINT_BIAS = -0.002;
export const SHADOW_NORMAL_BIAS = 0.02;
/** Directional shadow extent (around the origin) when there is no geometry to fit. */
export const SHADOW_FALLBACK_RADIUS = 10;
const SHADOW_MIN_RADIUS = 0.5;
const SHADOW_FIT_MARGIN = 1.05;

/** Total: anything that is not a known tier (case-insensitive) is 'medium'. */
export function normalizeShadowQuality(raw: unknown): ShadowQuality {
    if (typeof raw !== 'string') return DEFAULT_SHADOW_QUALITY;
    const value = raw.trim().toLowerCase();
    for (let i = 0; i < SHADOW_QUALITIES.length; i++) {
        if (SHADOW_QUALITIES[i] === value) return SHADOW_QUALITIES[i];
    }
    return DEFAULT_SHADOW_QUALITY;
}

export function shadowQualityParams(quality: ShadowQuality, maxTextureSize?: number): ShadowQualityParams {
    const tier = normalizeShadowQuality(quality);
    const biases = {
        directionalBias: SHADOW_DIRECTIONAL_BIAS,
        pointBias: SHADOW_POINT_BIAS,
        normalBias: SHADOW_NORMAL_BIAS,
    };
    if (tier === 'off') return { enabled: false, mapSize: 0, radius: 0, ...biases };
    const preset = SHADOW_TIERS[tier];
    const cap = typeof maxTextureSize === 'number' && Number.isFinite(maxTextureSize) && maxTextureSize > 0
        ? maxTextureSize
        : preset.mapSize;
    return { enabled: true, mapSize: Math.min(preset.mapSize, cap), radius: preset.radius, ...biases };
}

function isShadowLight(object: ShadowThree): boolean {
    return !!object && (object.isDirectionalLight === true || object.isPointLight === true);
}

/** Drop a light's shadow render target so three regenerates it at the new `mapSize`. */
function disposeShadowMap(shadow: ShadowThree): void {
    if (!shadow || !shadow.map) return;
    if (shadow.map.depthTexture) shadow.map.depthTexture.dispose();
    shadow.map.dispose();
    shadow.map = null;
}

function sceneHasShadowCaster(scene: ShadowThree): boolean {
    let found = false;
    scene.traverse((object: ShadowThree) => {
        if (object.isMesh === true && object.castShadow === true) found = true;
    });
    return found;
}

/**
 * Apply `quality` to the renderer's shadow map and each light. The pass runs
 * only when the tier is not 'off' AND something casts; 'off' also frees every
 * shadow map. `castShadow` on the lights is derived here — authored data is
 * never consulted. `changedMaterials` is true when the shadow-map state flipped
 * and every material in `scene` was flagged for recompilation.
 */
export function applyShadowQuality(
    THREE: ShadowThree,
    renderer: ShadowThree,
    scene: ShadowThree,
    quality: ShadowQuality,
    opts?: ApplyShadowQualityOptions,
): { changedMaterials: boolean } {
    if (!THREE || !renderer || !scene) return { changedMaterials: false };
    const capabilities = renderer.capabilities;
    const params = shadowQualityParams(quality, capabilities ? capabilities.maxTextureSize : undefined);
    const anyCaster = opts && typeof opts.anyCaster === 'boolean' ? opts.anyCaster : sceneHasShadowCaster(scene);
    const enabled = params.enabled && anyCaster;

    const lights: ShadowThree[] = [];
    if (opts && opts.lights) {
        for (let i = 0; i < opts.lights.length; i++) if (isShadowLight(opts.lights[i])) lights.push(opts.lights[i]);
    } else {
        scene.traverse((object: ShadowThree) => {
            if (isShadowLight(object)) lights.push(object);
        });
    }

    for (const light of lights) {
        light.castShadow = enabled;
        const shadow = light.shadow;
        if (!shadow) continue;
        if (!params.enabled) {
            disposeShadowMap(shadow);
            continue;
        }
        if (shadow.mapSize.x !== params.mapSize || shadow.mapSize.y !== params.mapSize) {
            shadow.mapSize.set(params.mapSize, params.mapSize);
            disposeShadowMap(shadow);
        }
        shadow.radius = params.radius;
        shadow.bias = light.isPointLight === true ? params.pointBias : params.directionalBias;
        shadow.normalBias = params.normalBias;
    }

    const shadowMap = renderer.shadowMap;
    const type = typeof THREE.PCFShadowMap === 'number' ? THREE.PCFShadowMap : shadowMap.type;
    if (shadowMap.enabled === enabled && shadowMap.type === type) return { changedMaterials: false };
    shadowMap.enabled = enabled;
    shadowMap.type = type;
    // Compiled programs bake the shadow-map state.
    scene.traverse((object: ShadowThree) => {
        const material = object.material;
        const materials = Array.isArray(material) ? material : material ? [material] : [];
        for (const m of materials) m.needsUpdate = true;
    });
    return { changedMaterials: true };
}

/**
 * Fit a casting directional light's orthographic shadow frustum to the
 * bounding sphere of `box` (world space; null / empty ⇒ radius 10 around the
 * origin). Returns false for anything else, or a light sitting on its target.
 * The caller brings `box` up to date; the light's own world matrix is updated here.
 */
export function fitDirectionalShadowCamera(THREE: ShadowThree, light: ShadowThree, box: ShadowThree | null): boolean {
    if (!THREE || !light || light.isDirectionalLight !== true || light.castShadow !== true || !light.shadow) return false;
    const sphere = new THREE.Sphere();
    if (!box || box.isEmpty()) sphere.set(new THREE.Vector3(0, 0, 0), SHADOW_FALLBACK_RADIUS);
    else box.getBoundingSphere(sphere);
    const radius = Math.max(sphere.radius, SHADOW_MIN_RADIUS) * SHADOW_FIT_MARGIN;

    light.updateWorldMatrix(true, false);
    light.target.updateMatrixWorld();
    const eye = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
    const target = new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld);
    if (eye.distanceToSquared(target) < 1e-12) return false;
    const cam = light.shadow.camera;
    // Same view `LightShadow.updateMatrices` builds: at the light, looking at its target.
    const view = new THREE.Matrix4().lookAt(eye, target, cam.up).setPosition(eye).invert();
    const c = sphere.center.clone().applyMatrix4(view);
    cam.left = c.x - radius;
    cam.right = c.x + radius;
    cam.bottom = c.y - radius;
    cam.top = c.y + radius;
    // Ortho near may be negative, so casters behind the light's position still land in the map.
    cam.near = -c.z - radius;
    cam.far = -c.z + radius;
    cam.updateProjectionMatrix();
    return true;
}
