// PARITY CONTRACT: this file must be byte-identical content (modulo imports)
// to its twin — editor `src/services/three/skybox.ts` and runtime
// `templates/arcade-base-game-template/game/src/core/services/orca/scene-3d-skybox.ts`.
// If you change one, change both.
//
// The optional scene-level `scene3d.skybox`: normalisation, its image refs, and
// applying it to a three.js Scene (background, intensity, Y rotation and,
// optionally, the PBR environment).
//
// Pure module with NO imports: the THREE namespace is passed in, because the
// game compiles with TypeScript 4.9 and cannot type three, and the editor
// confines its three imports to `src/services/three/`.

export const SKYBOX_MODES = ['color', 'gradient', 'cubemap', 'equirect'] as const;

export type SkyboxMode = typeof SKYBOX_MODES[number];

/** three's cube-texture face order. */
export const SKYBOX_CUBE_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;

export type SkyboxCubeFace = typeof SKYBOX_CUBE_FACES[number];

export type SkyboxCubeFaces = { [K in SkyboxCubeFace]: string };

export interface SkyboxCommon {
    /** 0..10, default 1 — `scene.backgroundIntensity`. */
    intensity?: number;
    /** DEGREES about Y, default 0 — `scene.backgroundRotation` + `environmentRotation`. */
    rotation?: number;
    /** Also use the sky as `scene.environment`. Ignored for `color`. */
    environment?: boolean;
}

/** Image refs are bare bucket-relative paths; `''` means not yet assigned. */
export type Skybox3D = SkyboxCommon & (
    | { mode: 'color'; color: string }
    | { mode: 'gradient'; top: string; horizon: string; bottom: string }
    | { mode: 'cubemap'; faces: SkyboxCubeFaces }
    | { mode: 'equirect'; src: string }
);

export const SKYBOX_DEFAULT_COLOR = '#000000';
export const SKYBOX_DEFAULT_GRADIENT = { top: '#1e3a8a', horizon: '#93c5fd', bottom: '#e5e7eb' } as const;
export const SKYBOX_DEFAULT_INTENSITY = 1;
export const SKYBOX_MAX_INTENSITY = 10;

const SKYBOX_HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SKYBOX_DEG_TO_RAD = Math.PI / 180;
const skyboxWarned: { [key: string]: true } = {};

function skyboxColor(value: unknown, fallback: string): string {
    return typeof value === 'string' && SKYBOX_HEX_RE.test(value) ? value.toLowerCase() : fallback;
}

function skyboxRef(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function skyboxWarnOnce(key: string, message: string, err?: unknown): void {
    if (skyboxWarned[key]) return;
    skyboxWarned[key] = true;
    if (err === undefined) console.warn(message);
    else console.warn(message, err);
}

/** Total: any input yields a complete skybox or null (absent / unknown mode). */
export function normalizeSkybox(raw: unknown): Skybox3D | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const source = raw as { [key: string]: unknown };
    const mode = source.mode;
    const intensityRaw = source.intensity;
    const intensity = typeof intensityRaw === 'number' && Number.isFinite(intensityRaw)
        ? Math.min(SKYBOX_MAX_INTENSITY, Math.max(0, intensityRaw))
        : SKYBOX_DEFAULT_INTENSITY;
    const rotationRaw = source.rotation;
    const rotation = typeof rotationRaw === 'number' && Number.isFinite(rotationRaw) ? rotationRaw : 0;
    const common = { intensity, rotation, environment: source.environment === true };
    switch (mode) {
        case 'color':
            return { ...common, mode: 'color', color: skyboxColor(source.color, SKYBOX_DEFAULT_COLOR) };
        case 'gradient':
            return {
                ...common,
                mode: 'gradient',
                top: skyboxColor(source.top, SKYBOX_DEFAULT_GRADIENT.top),
                horizon: skyboxColor(source.horizon, SKYBOX_DEFAULT_GRADIENT.horizon),
                bottom: skyboxColor(source.bottom, SKYBOX_DEFAULT_GRADIENT.bottom),
            };
        case 'cubemap': {
            const facesRaw = source.faces && typeof source.faces === 'object'
                ? source.faces as { [key: string]: unknown }
                : {};
            return {
                ...common,
                mode: 'cubemap',
                faces: {
                    px: skyboxRef(facesRaw.px),
                    nx: skyboxRef(facesRaw.nx),
                    py: skyboxRef(facesRaw.py),
                    ny: skyboxRef(facesRaw.ny),
                    pz: skyboxRef(facesRaw.pz),
                    nz: skyboxRef(facesRaw.nz),
                },
            };
        }
        case 'equirect':
            return { ...common, mode: 'equirect', src: skyboxRef(source.src) };
        default:
            return null;
    }
}

/** Every non-empty image ref, de-duplicated, in face order. */
export function skyboxImageRefs(skybox: Skybox3D | null | undefined): string[] {
    const sky = normalizeSkybox(skybox);
    if (!sky) return [];
    const refs: string[] = [];
    const push = (ref: string): void => {
        if (ref && refs.indexOf(ref) === -1) refs.push(ref);
    };
    if (sky.mode === 'cubemap') {
        for (const face of SKYBOX_CUBE_FACES) push(sky.faces[face]);
    } else if (sky.mode === 'equirect') {
        push(sky.src);
    }
    return refs;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SkyboxThree = any;

async function resolveSkyboxUrl(
    resolveUrl: (ref: string) => string | null | Promise<string | null>,
    ref: string,
): Promise<string | null> {
    if (!ref) return null;
    try {
        const url = await resolveUrl(ref);
        return typeof url === 'string' && url ? url : null;
    } catch (err) {
        skyboxWarnOnce(`resolve:${ref}`, `[Skybox] Could not resolve "${ref}".`, err);
        return null;
    }
}

function markSkyboxTexture(THREE: SkyboxThree, texture: SkyboxThree, equirect: boolean): void {
    if (equirect && THREE.EquirectangularReflectionMapping !== undefined) {
        texture.mapping = THREE.EquirectangularReflectionMapping;
    }
    if (THREE.SRGBColorSpace !== undefined) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
}

function createSkyboxGradientTexture(
    THREE: SkyboxThree,
    top: string,
    horizon: string,
    bottom: string,
): SkyboxThree | null {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Image top maps to +Y on an equirect sphere.
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, top);
    gradient.addColorStop(0.5, horizon);
    gradient.addColorStop(1, bottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    markSkyboxTexture(THREE, texture, true);
    return texture;
}

function loadSkyboxCube(THREE: SkyboxThree, urls: string[]): Promise<SkyboxThree> {
    return new Promise((resolve, reject) => {
        const texture = new THREE.CubeTextureLoader().load(
            urls,
            () => resolve(texture),
            undefined,
            (err: unknown) => {
                texture.dispose();
                reject(err);
            },
        );
    });
}

function loadSkyboxImage(THREE: SkyboxThree, url: string): Promise<SkyboxThree> {
    return new Promise((resolve, reject) => {
        new THREE.TextureLoader().load(url, resolve, undefined, reject);
    });
}

/**
 * Apply `skybox` to `scene`. Resolves to a dispose fn that frees the textures
 * it created and clears only what it set. A null skybox, a stale apply
 * (`isStale()` true after an await) or a failed load leaves the scene
 * untouched and resolves to a no-op; the caller disposes any previous skybox.
 */
export async function applySkybox(
    THREE: SkyboxThree,
    scene: SkyboxThree,
    skybox: Skybox3D | null,
    resolveUrl: (ref: string) => string | null | Promise<string | null>,
    isStale: () => boolean = () => false,
): Promise<() => void> {
    const noop = (): void => undefined;
    const sky = normalizeSkybox(skybox);
    if (!sky || !THREE || !scene) return noop;

    let background: SkyboxThree = null;
    let texture: SkyboxThree = null;
    try {
        if (sky.mode === 'color') {
            background = new THREE.Color(sky.color);
        } else if (sky.mode === 'gradient') {
            texture = createSkyboxGradientTexture(THREE, sky.top, sky.horizon, sky.bottom);
            if (!texture) {
                skyboxWarnOnce('gradient', '[Skybox] No 2D canvas available; the gradient sky is skipped.');
                return noop;
            }
        } else if (sky.mode === 'cubemap') {
            const urls: Array<string | null> = [];
            for (const face of SKYBOX_CUBE_FACES) urls.push(await resolveSkyboxUrl(resolveUrl, sky.faces[face]));
            if (isStale()) return noop;
            if (urls.some((url) => !url)) {
                skyboxWarnOnce('cubemap:faces', '[Skybox] A cubemap sky needs all six faces; showing no background.');
                return noop;
            }
            texture = await loadSkyboxCube(THREE, urls as string[]);
            markSkyboxTexture(THREE, texture, false);
        } else {
            const url = await resolveSkyboxUrl(resolveUrl, sky.src);
            if (isStale()) return noop;
            if (!url) {
                skyboxWarnOnce(`equirect:${sky.src}`, '[Skybox] The equirect sky has no resolvable image; showing no background.');
                return noop;
            }
            texture = await loadSkyboxImage(THREE, url);
            markSkyboxTexture(THREE, texture, true);
        }
    } catch (err) {
        if (texture) texture.dispose();
        skyboxWarnOnce(`load:${sky.mode}`, `[Skybox] The ${sky.mode} sky failed to load; showing no background.`, err);
        return noop;
    }
    if (isStale()) {
        if (texture) texture.dispose();
        return noop;
    }

    if (texture) background = texture;
    const environment = texture && sky.environment ? texture : null;
    const radians = (sky.rotation || 0) * SKYBOX_DEG_TO_RAD;

    scene.background = background;
    if (environment) scene.environment = environment;
    const setsIntensity = 'backgroundIntensity' in scene;
    if (setsIntensity) scene.backgroundIntensity = sky.intensity === undefined ? SKYBOX_DEFAULT_INTENSITY : sky.intensity;
    const backgroundRotation = scene.backgroundRotation;
    const environmentRotation = scene.environmentRotation;
    const rotatesBackground = !!backgroundRotation && typeof backgroundRotation.set === 'function';
    const rotatesEnvironment = !!environment && !!environmentRotation && typeof environmentRotation.set === 'function';
    if (rotatesBackground) backgroundRotation.set(0, radians, 0);
    if (rotatesEnvironment) environmentRotation.set(0, radians, 0);

    let disposed = false;
    return (): void => {
        if (disposed) return;
        disposed = true;
        if (scene.background === background) scene.background = null;
        if (environment && scene.environment === environment) scene.environment = null;
        if (setsIntensity) scene.backgroundIntensity = SKYBOX_DEFAULT_INTENSITY;
        if (rotatesBackground) backgroundRotation.set(0, 0, 0);
        if (rotatesEnvironment) environmentRotation.set(0, 0, 0);
        if (texture) texture.dispose();
    };
}
