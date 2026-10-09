// PARITY CONTRACT: this file must be byte-identical content (modulo imports)
// to its twin — editor `src/services/three/primitiveGeometry.ts` and runtime
// `templates/arcade-base-game-template/game/src/core/services/orca/scene-3d-primitives.ts`.
// If you change one, change both.
//
// Unit-sized geometry and material parameters for `primitive3d` scene3d
// nodes. A primitive's size comes entirely from its transform.scale.
//
// Pure module with NO imports: the THREE namespace is passed in, because the
// game compiles with TypeScript 4.9 and cannot type three, and the editor
// confines its three imports to `src/services/three/`.

export const PRIMITIVE3D_SHAPES = ['plane', 'cube', 'sphere', 'cone', 'torus', 'pyramid'] as const;

export type Primitive3DShape = typeof PRIMITIVE3D_SHAPES[number];

export const PRIMITIVE3D_DEFAULT_SHAPE: Primitive3DShape = 'cube';
export const PRIMITIVE3D_DEFAULT_COLOR = '#ffffff';
export const PRIMITIVE3D_DEFAULT_ROUGHNESS = 0.5;
export const PRIMITIVE3D_DEFAULT_METALNESS = 0;

/** The fields `primitiveMaterialParams` reads. Untrusted: every field is re-checked. */
export interface Primitive3DMaterialSource {
    shape?: unknown;
    color?: unknown;
    roughness?: unknown;
    metalness?: unknown;
}

export interface Primitive3DMaterialParams {
    color: string;
    roughness: number;
    metalness: number;
    /** Callers map `'double'` to `THREE.DoubleSide` and `'front'` to `THREE.FrontSide`. */
    side: 'double' | 'front';
}

const PRIMITIVE3D_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Unknown or missing shapes fall back to `'cube'`. */
export function normalizePrimitiveShape(shape: unknown): Primitive3DShape {
    for (const known of PRIMITIVE3D_SHAPES) {
        if (shape === known) return known;
    }
    return PRIMITIVE3D_DEFAULT_SHAPE;
}

function unitIntervalOr(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(1, Math.max(0, value));
}

/** Parameters for a `MeshStandardMaterial`; only the plane is double-sided. */
export function primitiveMaterialParams(node: Primitive3DMaterialSource | null | undefined): Primitive3DMaterialParams {
    const source: Primitive3DMaterialSource = node || {};
    return {
        color: typeof source.color === 'string' && PRIMITIVE3D_COLOR_RE.test(source.color)
            ? source.color
            : PRIMITIVE3D_DEFAULT_COLOR,
        roughness: unitIntervalOr(source.roughness, PRIMITIVE3D_DEFAULT_ROUGHNESS),
        metalness: unitIntervalOr(source.metalness, PRIMITIVE3D_DEFAULT_METALNESS),
        side: normalizePrimitiveShape(source.shape) === 'plane' ? 'double' : 'front',
    };
}

/** Image extensions a `primitive3d.texture` may reference. */
export const PRIMITIVE3D_TEXTURE_EXT_RE = /\.(png|jpe?g|webp)$/i;
export const PRIMITIVE3D_TEXTURE_REPEAT_MIN = 0.01;
export const PRIMITIVE3D_TEXTURE_REPEAT_MAX = 1000;

/** The fields `primitiveTextureParams` reads. Untrusted: every field is re-checked. */
export interface Primitive3DTextureSource {
    texture?: unknown;
    textureRepeat?: unknown;
}

export interface Primitive3DTextureParams {
    /** Bare bucket-relative image path; resolve it like any other scene3d ref. */
    ref: string;
    repeatX: number;
    repeatY: number;
}

function textureRepeatAxis(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
    return Math.min(PRIMITIVE3D_TEXTURE_REPEAT_MAX, Math.max(PRIMITIVE3D_TEXTURE_REPEAT_MIN, value));
}

/** Tiling per axis; absent or non-finite ⇒ 1, otherwise clamped to 0.01..1000. */
export function normalizePrimitiveTextureRepeat(raw: unknown): { x: number; y: number } {
    const source = raw && typeof raw === 'object' ? raw as { x?: unknown; y?: unknown } : {};
    return { x: textureRepeatAxis(source.x), y: textureRepeatAxis(source.y) };
}

/** Null when there is no texture, or its ref is empty or not a png / jpg / jpeg / webp. */
export function primitiveTextureParams(node: Primitive3DTextureSource | null | undefined): Primitive3DTextureParams | null {
    const ref = node && typeof node.texture === 'string' ? node.texture.trim() : '';
    if (!ref || !PRIMITIVE3D_TEXTURE_EXT_RE.test(ref)) return null;
    const repeat = normalizePrimitiveTextureRepeat(node ? node.textureRepeat : undefined);
    return { ref, repeatX: repeat.x, repeatY: repeat.y };
}

/**
 * A new unit-sized BufferGeometry for `shape`, centred on the origin:
 * - plane: 1×1 lying flat in XZ, facing +Y
 * - cube: 1×1×1
 * - sphere: diameter 1
 * - cone: base diameter 1, height 1, apex +Y
 * - torus: ring lying flat in XZ, outer diameter 1
 * - pyramid: 1×1 axis-aligned square base, height 1, apex +Y
 * The caller owns (and must dispose) the returned geometry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPrimitiveGeometry(THREE: any, shape: string): any {
    switch (normalizePrimitiveShape(shape)) {
        case 'plane': {
            const geometry = new THREE.PlaneGeometry(1, 1);
            geometry.rotateX(-Math.PI / 2);
            return geometry;
        }
        case 'sphere':
            return new THREE.SphereGeometry(0.5, 32, 16);
        case 'cone':
            return new THREE.ConeGeometry(0.5, 1, 32);
        case 'torus': {
            const geometry = new THREE.TorusGeometry(0.35, 0.15, 16, 48);
            geometry.rotateX(-Math.PI / 2);
            return geometry;
        }
        case 'pyramid': {
            // Four radial segments start on +Z, so the base is a diamond until turned 45°.
            const geometry = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
            geometry.rotateY(Math.PI / 4);
            return geometry;
        }
        case 'cube':
        default:
            return new THREE.BoxGeometry(1, 1, 1);
    }
}
