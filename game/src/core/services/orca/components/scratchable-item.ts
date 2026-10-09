import * as PIXI from 'pixi.js';
// Global FlowState dispatcher — used to fire the `scratchComplete` starter the
// first time a panel is fully scratched. Same import + call convention as
// `components/reels.ts` (`spinComplete` / `reelStop` / `cascadeComplete`).
import { Flowstate } from '../flowstate';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                        SCRATCHABLE ITEM COMPONENT                        ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║ Runtime half of the editor's `scratchableItem` scene node — a scratch    ║
 * ║ card panel. The node renders as an ordinary `PIXI.Sprite` (built by      ║
 * ║ SceneManager); this module bolts the scratch-to-reveal behaviour on top. ║
 * ║                                                                          ║
 * ║ HOW THE REVEAL WORKS (mask approach: ERASE, not inverse)                 ║
 * ║   A `PIXI.RenderTexture` is primed with an opaque WHITE rect and         ║
 * ║   assigned as the sprite's mask via a child sprite (pixi 8's `AlphaMask` ║
 * ║   clears the mask's own `renderable` for us). Scratching renders a soft  ║
 * ║   brush into that RenderTexture with the `'erase'` blend mode, punching  ║
 * ║   the mask's alpha to 0 so the sprite disappears there and whatever sits ║
 * ║   BEHIND it shows through.                                               ║
 * ║                                                                          ║
 * ║ ONE COORDINATE SPACE (hard invariant)                                    ║
 * ║   Everything — the RenderTexture, the mask sprite, the brush stamp, the  ║
 * ║   progress grid — lives in the sprite's LOCAL (texture) space. The RT is ║
 * ║   created at `localWidth x localHeight`, so the mask sprite stays at     ║
 * ║   SCALE 1 and maps 1:1 onto the sprite quad; crispness at the authored   ║
 * ║   DISPLAY size is bought with the RenderTexture's `resolution`, never by ║
 * ║   shrinking its logical dimensions and stretching the mask sprite back.  ║
 * ║   Do NOT reintroduce a display-sized RT + `maskSprite.width/height` +    ║
 * ║   per-stamp scale factors: that is three spaces to keep in step, and     ║
 * ║   pixi's alpha-mask pipe derives the mask UVs from the mask sprite's     ║
 * ║   world transform + `texture.orig` + `anchor`, so any drift there clips  ║
 * ║   the WHOLE node rather than just the scratched dot.                     ║
 * ║                                                                          ║
 * ║ BRUSH UNITS ARE DISPLAY PIXELS (hard contract)                           ║
 * ║   `brushSize` — and `setScratchBrushSize()` — are authored in the SAME   ║
 * ║   unit as the Inspector's Width/Height fields: DISPLAY pixels (rule 18,  ║
 * ║   an authored `width`/`height` > 0 is the BASE display size). It is      ║
 * ║   converted into the mask's LOCAL space exactly once, by `local /        ║
 * ║   display` per axis, and every consumer — the stamp, the progress        ║
 * ║   footprint, the stroke interpolation step — uses that converted         ║
 * ║   diameter, so all three stay in the single mask space described above.  ║
 * ║                                                                          ║
 * ║   WHY: the brush must NOT mean "N texels of whatever the source PNG      ║
 * ║   happens to be". An author sees Brush Size 60 beside Width 200 and      ║
 * ║   reads it as 60 of those 200. Interpreting it natively made one         ║
 * ║   authored value cover 0.16% of an 800x400 texture and ~90% of a 64x32   ║
 * ║   one, tripping `revealThreshold` on the FIRST stamp and blanking the    ║
 * ║   panel the instant it was touched. Progress is now the true erased      ║
 * ║   DISPLAY-area fraction, independent of source texture resolution.       ║
 * ║                                                                          ║
 * ║   The brush stays a circle in DISPLAY space, not texture space. Under a  ║
 * ║   non-uniform override (200x100 display over an 800x400 native) the two  ║
 * ║   axis factors differ, so the brush is an ELLIPSE in local space that    ║
 * ║   renders as a ROUND scratch mark on screen — which is the thing the     ║
 * ║   author is actually looking at. With no size override both factors are  ║
 * ║   exactly 1, the two spaces coincide, and behaviour is unchanged.        ║
 * ║                                                                          ║
 * ║ PROGRESS IS MEASURED AT DISPLAY RESOLUTION (hard contract)               ║
 * ║   `progress` is a coarse occupancy grid, and every stamp unconditionally ║
 * ║   claims the WHOLE cell under the brush centre so that a sub-cell brush  ║
 * ║   still makes headway. That claim is only honest while a cell is no      ║
 * ║   bigger than the brush, so the grid is sized to the node's DISPLAY      ║
 * ║   extent (about one cell per display pixel, clamped) rather than being a ║
 * ║   fixed 32x32.                                                           ║
 * ║                                                                          ║
 * ║   WHY: on a 200x100 panel a 32x32 cell is 6.25x3.13 display px. A 1-px   ║
 * ║   brush erases ~0.8 px² but claimed ~19.5 px² — a 25x over-report EVERY  ║
 * ║   stamp. Scrubbing such a brush over the panel drove `progress` past a   ║
 * ║   0.6 `revealThreshold` in ~25 passes while erasing under 1% of the      ║
 * ║   pixels, so the whole panel vanished with no visible scratch marks at   ║
 * ║   all. At display resolution the same gesture reports ~0.40 and the      ║
 * ║   panel survives, while a 60-px brush is unaffected (0.1413 vs 0.1445 on ║
 * ║   the first stamp) because its footprint already spanned many cells.     ║
 * ║   Do NOT put the grid back to a fixed resolution.                        ║
 * ║                                                                          ║
 * ║   THE MASK IS LAZY. It is created on the FIRST ACTUAL SCRATCH, never at  ║
 * ║   wire time: an unscratched panel's mask is a fully-opaque white rect,   ║
 * ║   so building it early is visually a no-op yet turns any mask defect     ║
 * ║   into a completely invisible node. Until the first stroke a             ║
 * ║   `scratchableItem` renders through EXACTLY the plain-`sprite` path.     ║
 * ║   A mask that fails to build is torn down and never assigned, so the     ║
 * ║   node degrades to visible-but-unscratchable rather than vanishing.      ║
 * ║                                                                          ║
 * ║   `'erase'` is a first-class member of pixi 8's `BLEND_MODES` string     ║
 * ║   union and maps to `[ZERO, ONE_MINUS_SRC_ALPHA]` — i.e.                 ║
 * ║   `dst *= (1 - srcAlpha)`. So a soft-edged brush erases proportionally   ║
 * ║   and repeated strokes accumulate. The inverse (start-empty,             ║
 * ║   paint-to-reveal) arrangement is therefore NOT needed. NB `BLEND_MODES` ║
 * ║   is TYPE-ONLY in pixi 8 — there is no `PIXI.BLEND_MODES.ERASE` value to ║
 * ║   read, the string IS the API.                                           ║
 * ║                                                                          ║
 * ║ INPUT (pixi 8 federated events)                                          ║
 * ║   Pixi 8 has ONLY federated events: `interactive` is a thin alias and    ║
 * ║   `eventMode` is the real API, so the sprite is `'static'` while scratch ║
 * ║   is enabled and `'passive'` while it is not (passive is not hit-tested, ║
 * ║   so a disabled panel does not swallow pointerdown from nodes beneath).  ║
 * ║   `pointerdown` starts the stroke; `globalpointermove` — which fires on  ║
 * ║   every interactive container regardless of the pointer's position —     ║
 * ║   continues it once the pointer leaves the sprite's bounds, replacing    ║
 * ║   the pixi 6 stage/InteractionManager capture (both of which are gone).  ║
 * ║   The HOST STAGE is still bound for pointer-UP as belt and braces, since ║
 * ║   a release outside the sprite reaches whichever surface is hit first.   ║
 * ║   Touch is normalised into the same pointer events, so this covers both  ║
 * ║   mouse and finger. Pointer input paints on move; the ticker drives only ║
 * ║   the reveal animation and the scripted `autoScratch` stroke.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

/** Subset of the exported scene node this component reads. Declared locally
 *  (rather than imported from `../scene-manager`) so the component never
 *  imports the scene manager back — same rule the reels component follows. */
export interface ScratchableItemNodeLike {
    name?: string;
    /** Read only by the one-shot wire diagnostic. */
    type?: string;
    /** Raw scene-JSON texture ref. Read only by the one-shot wire diagnostic. */
    texture?: string | null;
    /** Raw scene-JSON packed-atlas refs. Diagnostic only. */
    spritesheetPath?: string | null;
    spritesheetFrame?: string | null;
    width?: number;
    height?: number;
    scratchEnabled?: boolean;
    /** Brush DIAMETER in DISPLAY pixels — same unit as `width`/`height`, not
     *  source-texture texels. See the BRUSH UNITS block at the top. */
    brushSize?: number;
    brushHardness?: number;
    brushTexture?: string | null;
    revealThreshold?: number;
    autoRevealOnThreshold?: boolean;
    /** Default false. When true the reveal threshold is checked once per
     *  stroke end (pointer release / `autoScratch` finish), not per stamp. */
    revealOnPointerRelease?: boolean;
    /** Default false. When true a stroke may start off the item and begin once dragged onto it. */
    allowOutsideTouch?: boolean;
    /** `'instant'` (default) | `'fade'` | `'dissolve'`. Typed as a plain string
     *  because scene JSON is untrusted — coerced by `readAutoRevealStyle`. */
    autoRevealStyle?: string;
    /** Reveal animation length in MILLISECONDS. `<= 0` means instant. */
    autoRevealDurationMs?: number;
    /** Authored `autoScratch` paths. Points are NORMALISED 0..1 over the
     *  texture rect, origin top-left, independent of anchor and size override.
     *  Untrusted — coerced by `readScratchPaths`. */
    scratchPaths?: Array<{ id: string; name?: string; points: Array<{ x: number; y: number }> }>;
}

/** How a full reveal presents itself. Mirrors the editor's
 *  `ScratchAutoRevealStyle`; anything else coerces to `'instant'`. */
export type ScratchAutoRevealStyle = 'instant' | 'fade' | 'dissolve';

/** Injected host handles + resolvers. Nothing in here is imported by the
 *  component itself, mirroring the `buildFlowstateReelsDisplay` contract. */
export interface ScratchableItemDeps {
    /** Live pixi renderer, used to draw into the mask RenderTexture. */
    renderer: any | null;
    /** Stage that pointer move/up capture is attached to during a drag. */
    stage: PIXI.Container | null;
    /** Scope-aware texture resolver for the optional custom `brushTexture`.
     *  MUST be safe to call synchronously during `attachScratchBehaviour`
     *  (SceneManager's resolver keys off the owning scene's build origin). */
    resolveTexture: (ref: string) => PIXI.Texture;
}

/** Public control surface stashed on the display object. Consumed by
 *  `methods/scratchable-item.ts`. */
export interface OrcaScratchHandle {
    reset(): void;
    revealAll(): void;
    setEnabled(enabled: boolean): void;
    /** @param size Brush diameter in DISPLAY pixels (same unit as the
     *  Inspector's Brush Size / Width / Height fields). */
    setBrushSize(size: number): void;
    getProgress(): number;
    isComplete(): boolean;
    /** Drag a scripted stroke along authored path `pathIndex` (0-based) at
     *  constant speed over `durationMs`. Ignores `setEnabled(false)`. When the
     *  path ends naturally and `revealOnFinish !== false`, runs `revealAll()`
     *  and resolves once that reveal finishes. ALWAYS resolves — on finish, on
     *  cancel, on destroy and on bad input. */
    autoScratch(pathIndex: number, durationMs: number, revealOnFinish: boolean): Promise<void>;
}

/** Structural view of `OrcaParticleEmitter` — declared here so this module never imports it. */
interface ScratchDebrisEmitterLike {
    emit: boolean;
    readonly destroyed: boolean;
    readonly layer: PIXI.Container;
    setSpawnOffset?(x: number, y: number): void;
}

/** Stashed by SceneManager when the node has an authored `particles` child. */
interface ScratchDebrisSource {
    emitter: ScratchDebrisEmitterLike;
    container: PIXI.Container;
}

export type ScratchableItemDisplay = PIXI.Sprite & {
    __orcaScratchHandle?: OrcaScratchHandle;
    __orcaScratchDebris?: ScratchDebrisSource;
};

/** A held, unmoving pointer stops spraying debris after this long. */
const DEBRIS_IDLE_MS = 100;

const DEFAULT_BRUSH_SIZE = 60;
const DEFAULT_BRUSH_HARDNESS = 0.5;
const DEFAULT_REVEAL_THRESHOLD = 0.6;
const DEFAULT_AUTO_REVEAL_STYLE: ScratchAutoRevealStyle = 'instant';
const DEFAULT_AUTO_REVEAL_DURATION_MS = 400;
/** Same ceiling the editor's normalizer clamps to; re-applied here because the
 *  scene JSON on disk may predate that clamp. */
const MAX_AUTO_REVEAL_DURATION_MS = 10000;

/** Bounds on the untrusted `scratchPaths` scene JSON. */
const MAX_SCRATCH_PATHS = 256;
const MAX_SCRATCH_PATH_POINTS = 4096;

/** Per-axis bounds on the occupancy grid behind `progress`. The grid is sized
 *  to the node's DISPLAY extent (roughly one cell per display pixel) rather
 *  than being fixed — see the PROGRESS block at the top for why. The upper
 *  bound also caps the per-stamp footprint loop. */
const MIN_PROGRESS_GRID = 8;
const MAX_PROGRESS_GRID = 128;

/** Generated soft-brush bitmap size, in px. Scaled down/up per stroke. */
const BRUSH_BASE_SIZE = 128;

/** Hard cap on either RenderTexture REAL (device) dimension so a huge texture
 *  or authored width/height can't allocate an oversized GPU surface. The
 *  logical size is always the sprite's local extent — the cap is absorbed by
 *  lowering `resolution`, never by changing the RT's logical dimensions. */
const MAX_MASK_DIMENSION = 2048;

/** Bounds for the mask RenderTexture's `resolution` multiplier. */
const MIN_MASK_RESOLUTION = 0.05;
const MAX_MASK_RESOLUTION = 4;

/** Hard bound on the deferred-wire wait, and on how many `update` events may
 *  pass without the texture becoming measurable. Both exist so a texture that
 *  never resolves still reaches `wireScratchBehaviour`'s LOUD degrade warn
 *  instead of parking forever in silence — a silent permanent park is the one
 *  outcome this module must never produce. */
const TEXTURE_WAIT_TIMEOUT_MS = 10000;
const MAX_TEXTURE_UPDATE_ATTEMPTS = 16;

/** Outcome of the post-prime texel read-back. `unknown` = the check could not
 *  run (canvas renderer / no GL), which must NEVER fail the mask build. */
type PrimeVerdict = 'ok' | 'blank' | 'unknown';

/** Module-level soft-brush cache, keyed by quantised hardness. */
const softBrushTextureCache = new Map<string, PIXI.Texture>();

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return value < min ? min : value > max ? max : value;
}

function readNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readAutoRevealStyle(value: unknown): ScratchAutoRevealStyle {
    return value === 'fade' || value === 'dissolve' ? value : DEFAULT_AUTO_REVEAL_STYLE;
}

type NormalizedPoint = { x: number; y: number };

/**
 * Coerce the untrusted `scratchPaths` JSON into point lists. A malformed path
 * is KEPT as an empty entry rather than dropped, because `autoScratch` selects
 * by index and dropping one would silently retarget every later index.
 * Non-finite points are dropped, coordinates clamped to 0..1, and consecutive
 * duplicates collapsed so a repeated point never double-stamps.
 */
function readScratchPaths(value: unknown): NormalizedPoint[][] {
    if (!Array.isArray(value)) return [];
    const paths: NormalizedPoint[][] = [];
    for (const raw of value.slice(0, MAX_SCRATCH_PATHS)) {
        const points: NormalizedPoint[] = [];
        const rawPoints = raw && typeof raw === 'object' ? (raw as { points?: unknown }).points : null;
        if (Array.isArray(rawPoints)) {
            for (const p of rawPoints) {
                if (points.length >= MAX_SCRATCH_PATH_POINTS) break;
                if (!p || typeof p !== 'object') continue;
                const { x, y } = p as { x?: unknown; y?: unknown };
                if (typeof x !== 'number' || !Number.isFinite(x)) continue;
                if (typeof y !== 'number' || !Number.isFinite(y)) continue;
                const nx = clamp(x, 0, 1);
                const ny = clamp(y, 0, 1);
                const prev = points[points.length - 1];
                if (prev && prev.x === nx && prev.y === ny) continue;
                points.push({ x: nx, y: ny });
            }
        }
        paths.push(points);
    }
    return paths;
}

/**
 * Length, in mask-LOCAL (texture) units, of one DISPLAY pixel along one axis.
 *
 * `display` is the rule-18 authored size when one is present and the native
 * extent otherwise, so an unauthored node yields exactly 1 and every
 * display-space quantity passes through untouched.
 *
 * Guarded on BOTH inputs: a 0 / absent / NaN display or native dimension falls
 * back to 1 (today's native-space behaviour) rather than producing a
 * non-finite brush diameter that would poison the stamp and the progress grid.
 */
function displayToLocalFactor(local: number, display: number): number {
    if (!Number.isFinite(local) || local <= 0) return 1;
    if (!Number.isFinite(display) || display <= 0) return 1;
    const factor = local / display;
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/**
 * Build (once per hardness) a radial white brush whose alpha falls from 1 at
 * the centre to 0 at the rim. `hardness` 1 => effectively a hard-edged disc;
 * 0 => a fully soft gradient across the whole radius.
 */
function getSoftBrushTexture(hardness: number): PIXI.Texture {
    const clamped = clamp(hardness, 0, 1);
    const key = clamped.toFixed(2);
    const cached = softBrushTextureCache.get(key);
    if (cached && !(cached as unknown as { destroyed?: boolean }).destroyed) return cached;

    try {
        const canvas = document.createElement('canvas');
        canvas.width = BRUSH_BASE_SIZE;
        canvas.height = BRUSH_BASE_SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) return PIXI.Texture.WHITE;

        const radius = BRUSH_BASE_SIZE / 2;
        const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(Math.min(0.999, clamped), 'rgba(255,255,255,1)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(radius, radius, radius, 0, Math.PI * 2);
        ctx.fill();

        const texture = PIXI.Texture.from(canvas);
        softBrushTextureCache.set(key, texture);
        return texture;
    } catch (err) {
        console.warn('[FlowState/scratchableItem] Could not generate a soft brush; falling back to a hard disc.', err);
        return PIXI.Texture.WHITE;
    }
}

/**
 * Pixi 8 analogue of the removed `Texture.valid` — the same test
 * `SceneManager.isTextureReady` makes, restated here because that method is
 * private and this module must never import the scene manager back.
 *
 * A `TextureSource` only carries a `resource` (ImageBitmap / canvas / video)
 * once its pixels actually exist, and source dimensions default to 1x1, so
 * neither can stand in for readiness on its own.
 *
 * NOT usable on a `RenderTexture`: a render target's source is GPU-only and
 * never has a `resource`. Use `isRenderTextureAllocated` for those.
 */
function isTextureLoaded(texture: PIXI.Texture | undefined | null): boolean {
    if (!texture || texture === PIXI.Texture.EMPTY) return false;
    const source = texture.source as { resource?: unknown; width?: number; height?: number } | undefined;
    if (!source) return false;
    return !!source.resource && readNumber(source.width, 0) > 0 && readNumber(source.height, 0) > 0;
}

/** A RenderTexture has no `resource`, so readiness is purely "the surface was
 *  allocated with a real pixel extent". This says NOTHING about its contents —
 *  `verifyPrimedPixels` is what proves the prime landed. */
function isRenderTextureAllocated(texture: PIXI.RenderTexture | null | undefined): boolean {
    const source = texture?.source as { pixelWidth?: number; pixelHeight?: number } | undefined;
    if (!source) return false;
    return readNumber(source.pixelWidth, 0) > 0 && readNumber(source.pixelHeight, 0) > 0;
}

/**
 * True once the sprite's texture has actually LOADED and reports a real,
 * usable pixel extent.
 *
 * `> 0` IS NOT ENOUGH — do not put it back. An unloaded lazy texture does NOT
 * measure 0x0: with no frame supplied pixi substitutes a PLACEHOLDER 1x1 rect
 * (the source's own default extent) and `orig` aliases it, so the texture
 * reports 1x1 until the real pixels arrive and the source emits `update`. A
 * `> 0` test passes on that placeholder, which wired the ENTIRE component into
 * a 1x1 local space: a 1-display-px brush converted to a full-coverage 1x1
 * local brush, whose progress footprint claimed pi/4 (78.66%) of the grid on
 * the FIRST stamp, tripped a 0.6 `revealThreshold` and ran `revealAll()` —
 * i.e. one click removed the panel completely. `isTextureLoaded` gates on the
 * source actually holding pixels, which is the pixi 8 equivalent of the flag
 * pixi 6 called `valid`.
 *
 * `> 1` (not `> 0`) additionally rejects the resolvers' 1x1 `PIXI.Texture.WHITE`
 * missing-texture fallback, mirroring `SceneManager.writeSpriteFamilySizeScale`,
 * which uses `> 1` for exactly the same reason.
 */
function isTextureMeasurable(texture: PIXI.Texture | undefined): boolean {
    if (!isTextureLoaded(texture)) return false;
    return readNumber(texture?.width, 0) > 1 && readNumber(texture?.height, 0) > 1;
}

/** Best-effort source URL of a loaded/loading texture, across the resource
 *  shapes pixi 8 uses (ImageSource / CanvasSource / VideoSource / atlas page).
 *  `label` is where `Assets` records the resolved src. */
function readTextureSourceUrl(texture: PIXI.Texture | undefined): string {
    const source = texture?.source as unknown as {
        label?: string;
        resource?: { url?: string; src?: string; currentSrc?: string };
    } | undefined;
    if (!source) return texture?.label ?? '';
    return source.resource?.url
        ?? source.resource?.src
        ?? source.resource?.currentSrc
        ?? source.label
        ?? texture?.label
        ?? '';
}

/**
 * One-word verdict on the rule-18 authored-size contract, so a pasted
 * diagnostic answers "did my 200x100 apply?" without arithmetic.
 * `native` = nothing was authored (width/height 0), which is the untouched
 * default and NOT a fault.
 */
function describeSizeOverride(sprite: ScratchableItemDisplay, node: ScratchableItemNodeLike): string {
    const parts: string[] = [];
    const check = (authored: number, actual: number, axis: string): void => {
        if (authored <= 0) return;
        parts.push(`${axis}:${Math.abs(actual - authored) <= 0.5 ? 'applied' : `MISSED(${actual.toFixed(1)})`}`);
    };
    check(readNumber(node.width, 0), readNumber(sprite.width, 0), 'w');
    check(readNumber(node.height, 0), readNumber(sprite.height, 0), 'h');
    return parts.length > 0 ? parts.join(' ') : 'native';
}

/**
 * ONE-SHOT wire diagnostic — one grouped line per WIRE ATTEMPT, never per
 * frame. Every attempt reports, success and degrade alike, and a node parked
 * on a lazily-loading texture reports its park too (`degraded:
 * 'deferred-awaiting-texture'`) and then reports again when it settles — so a
 * built scratch node that produced NO line at all is itself a finding. Two
 * lines for one node is the deferred path, not a bug.
 *
 * Deliberately permanent: an invisible scratch panel is not reproducible from
 * a screenshot, and this dump separates "the texture never resolved", "the node
 * is drawn off-frame / at the wrong size", "no renderer or stage was
 * registered" and "the mask ate the sprite" in a single paste.
 *
 * DEFERRED BY ONE MICROTASK on purpose: `attachScratchBehaviour` is called from
 * `SceneManager.buildNode`, i.e. BEFORE `finishNodeBuild` → `applyTransform`
 * has set the anchor/scale/position and before the sprite is parented. A
 * microtask lands after the whole synchronous scene build (and its responsive
 * layout pass), so the values reported are the ones actually rendered.
 *
 * That microtask ALSO makes `spriteWidth`/`spriteHeight` a trustworthy readout
 * of the rule-18 authored-size contract on the lazy-texture path: SceneManager's
 * deferred size re-assert listens on the SAME `texture.on('update')` event and
 * subscribes AFTER this module does, so it has already run synchronously by the
 * time the microtask drains. `sizeOverrideHonoured` states the outcome outright.
 */
function logWireDiagnostic(
    sprite: ScratchableItemDisplay,
    node: ScratchableItemNodeLike,
    deps: ScratchableItemDeps,
    degraded: string,
): void {
    void Promise.resolve().then(() => {
        if ((sprite as unknown as { destroyed?: boolean }).destroyed) return;
        let bounds = { x: 0, y: 0, w: 0, h: 0 };
        try {
            const b = sprite.getBounds();
            bounds = { x: b.x, y: b.y, w: b.width, h: b.height };
        } catch { /* no-op */ }
        const texture = sprite.texture;
        console.info(`[FlowState/scratchableItem] wired "${node.name ?? '?'}"`, {
            node: node.name ?? '?',
            type: node.type ?? 'scratchableItem',
            degraded: degraded || 'no',
            textureRef: node.texture ?? '',
            spritesheetPath: node.spritesheetPath ?? '',
            spritesheetFrame: node.spritesheetFrame ?? '',
            resolvedUrl: readTextureSourceUrl(texture),
            textureLoaded: isTextureLoaded(texture),
            textureWidth: readNumber(texture?.width, 0),
            textureHeight: readNumber(texture?.height, 0),
            textureSourcePixels: `${readNumber(texture?.source?.pixelWidth, 0)}x${readNumber(texture?.source?.pixelHeight, 0)}`,
            authoredWidth: readNumber(node.width, 0),
            authoredHeight: readNumber(node.height, 0),
            spriteWidth: readNumber(sprite.width, 0),
            spriteHeight: readNumber(sprite.height, 0),
            sizeOverrideHonoured: describeSizeOverride(sprite, node),
            scaleX: readNumber(sprite.scale?.x, 0),
            scaleY: readNumber(sprite.scale?.y, 0),
            anchorX: readNumber(sprite.anchor?.x, 0),
            anchorY: readNumber(sprite.anchor?.y, 0),
            isRenderable: sprite.isRenderable === true,
            alpha: readNumber(sprite.alpha, 0),
            renderable: sprite.renderable === true,
            bounds,
            hasRenderer: !!deps.renderer && typeof deps.renderer.render === 'function',
            hasStage: !!deps.stage,
            maskAssigned: !!sprite.mask,
        });
    });
}

/**
 * Public entry point — see `wireScratchBehaviour` for the actual wiring.
 *
 * TEXTURE READINESS: `SceneManager.preloadSceneTextureAssets` normally has the
 * panel texture cached before the build (`collectSceneStaticTexturePaths`),
 * but a ref it misses falls through to
 * `SceneManager.loadTextureOnDemand`, whose cache-miss placeholder BORROWS the
 * shared 1x1 `Texture.WHITE` SOURCE and swaps the real source in later.
 *
 * TWO CONSEQUENCES, both of which this function exists to absorb:
 *
 *  1. THE READINESS GATE IS `isTextureMeasurable`, NOT `isTextureLoaded`. That
 *     placeholder has a real resource with `width`/`height` 1, so
 *     `isTextureLoaded` returns TRUE for it — wiring immediately, and then
 *     `wireScratchBehaviour` bounced off its own `isTextureMeasurable` guard
 *     (`> 1`) and returned PERMANENTLY. No handle was ever stashed, so every
 *     FlowState scratch node reported "missing __orcaScratchHandle". A texture
 *     can satisfy the loaded test and fail the measurable one forever; that
 *     gap was the bug.
 *
 *  2. THE DEFERRAL LISTENS ON THE **TEXTURE**, NOT THE SOURCE. The late arrival
 *     is `placeholder.source = loaded.source; placeholder.update();` — it
 *     REPLACES the source object, so a listener on the old source could never
 *     fire, and that old source is the shared global `Texture.WHITE.source`,
 *     onto which we must never leak a listener. `Texture.update()` re-emits on
 *     the texture, which is exactly why `SceneManager`'s sibling
 *     `deferSpriteFamilySizeOverride` binds there. Mirror it.
 *
 * The node renders as a plain sprite while parked. The wait is BOUNDED
 * (`TEXTURE_WAIT_TIMEOUT_MS` / `MAX_TEXTURE_UPDATE_ATTEMPTS`) and every exit —
 * parked, wired, given up on — emits a diagnostic line.
 */
export function attachScratchBehaviour(
    sprite: ScratchableItemDisplay,
    node: ScratchableItemNodeLike,
    deps: ScratchableItemDeps,
): void {
    const texture = sprite.texture;
    const renderable = deps.renderer && typeof deps.renderer.render === 'function';

    // Wire NOW when there is either nothing to wait for or nothing waiting
    // could fix. The degrade paths below all reach `wireScratchBehaviour`,
    // which owns the loud warn — never park on them:
    //   • no renderer                    — waiting cannot conjure one;
    //   • `Texture.EMPTY`                — the no-texture singleton, never loads;
    //   • the real `Texture.WHITE`       — the resolvers' missing-texture
    //     fallback, already loaded to an unusable 1x1 extent and inert forever.
    if (
        !renderable
        || !texture
        || typeof texture.on !== 'function'
        || texture === PIXI.Texture.EMPTY
        || texture === PIXI.Texture.WHITE
        || isTextureMeasurable(texture)
    ) {
        wireScratchBehaviour(sprite, node, deps);
        return;
    }

    // `error` is still raised on the SOURCE (`Texture` re-emits only
    // `update`/`destroy`), so it stays bound there — but NEVER when the source
    // is the shared global borrowed by `loadTextureOnDemand`'s placeholder: a
    // listener there is both unfireable for this sprite and a global leak. The
    // timeout covers that case instead.
    const source = texture.source;
    const errorSource = source && source !== PIXI.Texture.WHITE.source ? source : null;

    let settled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        try { texture.off('update', onTextureUpdate); } catch { /* no-op */ }
        try { errorSource?.off('error', onTextureError); } catch { /* no-op */ }
        try { sprite.off('destroyed', onSpriteDestroyed); } catch { /* no-op */ }
    };

    /** Stop waiting and wire with whatever is there — `wireScratchBehaviour`
     *  succeeds if the texture landed and emits its loud degrade warn if not. */
    function finish(): void {
        if (settled) return;
        settled = true;
        cleanup();
        wireScratchBehaviour(sprite, node, deps);
    }

    function onTextureUpdate(): void {
        if (settled) return;
        if ((sprite as unknown as { destroyed?: boolean }).destroyed) {
            onSpriteDestroyed();
            return;
        }
        // Texture swapped out from under us — the captured one is now stale, so
        // wire against whatever the sprite holds rather than waiting on a
        // texture nobody is rendering.
        if (sprite.texture !== texture) {
            finish();
            return;
        }
        attempts += 1;
        if (isTextureMeasurable(sprite.texture)) {
            finish();
            return;
        }
        if (attempts >= MAX_TEXTURE_UPDATE_ATTEMPTS) {
            console.warn(
                `[FlowState/scratchableItem] Texture for node "${node.name ?? '?'}" (texture="${node.texture ?? ''}") `
                + `emitted ${attempts} updates without ever reporting a usable extent — giving up on the deferred scratch wire.`,
            );
            finish();
        }
    }

    function onTextureTimeout(): void {
        if (settled) return;
        timer = null;
        console.warn(
            `[FlowState/scratchableItem] Texture for node "${node.name ?? '?'}" (texture="${node.texture ?? ''}") `
            + `did not become measurable within ${TEXTURE_WAIT_TIMEOUT_MS}ms — giving up on the deferred scratch wire.`,
        );
        finish();
    }

    function onTextureError(): void {
        if (settled) return;
        settled = true;
        cleanup();
        logWireDiagnostic(sprite, node, deps, 'texture-load-error');
        console.warn(
            `[FlowState/scratchableItem] Texture for node "${node.name ?? '?'}" failed to load — it renders as a plain sprite with no scratch behaviour.`,
        );
    }

    function onSpriteDestroyed(): void {
        settled = true;
        cleanup();
    }

    texture.on('update', onTextureUpdate);
    if (errorSource) errorSource.on('error', onTextureError);
    sprite.once('destroyed', onSpriteDestroyed);
    timer = setTimeout(onTextureTimeout, TEXTURE_WAIT_TIMEOUT_MS);

    // Report the park. "No diagnostic line at all" must never be a possible
    // outcome for a node that was built — the wire attempt that follows logs
    // its own line, so a parked node shows two.
    logWireDiagnostic(sprite, node, deps, 'deferred-awaiting-texture');
}

/**
 * Wire scratch-to-reveal behaviour onto an already-built sprite.
 *
 * Degrades to "plain sprite" (single warn, no throw) when the host renderer
 * isn't registered or the sprite has no measurable local size — the node must
 * always still RENDER even if it can't be scratched.
 */
function wireScratchBehaviour(
    sprite: ScratchableItemDisplay,
    node: ScratchableItemNodeLike,
    deps: ScratchableItemDeps,
): void {
    const renderer = deps.renderer;
    if (!renderer || typeof renderer.render !== 'function') {
        logWireDiagnostic(sprite, node, deps, 'no-renderer');
        console.warn(
            `[FlowState/scratchableItem] No pixi renderer registered (SceneManager.setHostRenderer) — node "${node.name ?? '?'}" renders as a plain sprite with no scratch behaviour.`,
        );
        return;
    }

    // LOCAL extent of the sprite (texture space). `node.width` / `node.height`
    // only change the sprite's SCALE, so the mask child — which lives in local
    // space — must span the texture's native size to cover the whole panel.
    const nativeWidth = readNumber(sprite.texture?.width, 0);
    const nativeHeight = readNumber(sprite.texture?.height, 0);
    if (!isTextureMeasurable(sprite.texture)) {
        logWireDiagnostic(sprite, node, deps, 'no-measurable-texture');
        console.warn(
            `[FlowState/scratchableItem] Node "${node.name ?? '?'}" has no measurable texture `
            + `(${nativeWidth}x${nativeHeight}, loaded=${isTextureLoaded(sprite.texture)}) — skipping scratch wiring.`,
        );
        return;
    }
    const localWidth = Math.max(1, Math.round(nativeWidth));
    const localHeight = Math.max(1, Math.round(nativeHeight));

    // ── SINGLE COORDINATE SPACE ───────────────────────────────────────────
    // The mask RenderTexture spans the sprite's LOCAL space 1:1 (`orig` ===
    // localWidth x localHeight), so the mask sprite needs no width/height
    // override and no per-stamp scale factor. Crispness at the authored
    // DISPLAY size is bought with `resolution`: the real GPU surface is
    // `local * resolution` device px while the logical size — the only thing
    // the mask filter and the brush stamps ever see — stays local.
    const displayWidth = readNumber(node.width, 0) > 0 ? (node.width as number) : localWidth;
    const displayHeight = readNumber(node.height, 0) > 0 ? (node.height as number) : localHeight;
    let maskResolution = clamp(
        Math.max(displayWidth / localWidth, displayHeight / localHeight),
        MIN_MASK_RESOLUTION,
        MAX_MASK_RESOLUTION,
    );
    // If MAX_MASK_DIMENSION bites, BOTH axes shrink proportionally through the
    // resolution — the logical space is never rescaled, so nothing downstream
    // has to know the cap fired.
    const dimensionCap = Math.min(
        1,
        MAX_MASK_DIMENSION / (localWidth * maskResolution),
        MAX_MASK_DIMENSION / (localHeight * maskResolution),
    );
    if (dimensionCap < 1) maskResolution *= dimensionCap;
    // Never round an axis away to zero real pixels.
    maskResolution = Math.max(maskResolution, 1 / Math.min(localWidth, localHeight));

    const nodeName = typeof node.name === 'string' ? node.name : '';
    const hardness = clamp(readNumber(node.brushHardness, DEFAULT_BRUSH_HARDNESS), 0, 1);
    const revealThreshold = clamp(readNumber(node.revealThreshold, DEFAULT_REVEAL_THRESHOLD), 0, 1);
    const autoReveal = node.autoRevealOnThreshold !== false;
    const revealOnPointerRelease = node.revealOnPointerRelease === true;
    const allowOutsideTouch = node.allowOutsideTouch === true;
    const scratchPaths = readScratchPaths(node.scratchPaths);

    let brushSize = Math.max(1, readNumber(node.brushSize, DEFAULT_BRUSH_SIZE));
    let enabled = node.scratchEnabled !== false;
    // `let` so a future handle setter is cheap; nothing mutates them today.
    let autoRevealStyle: ScratchAutoRevealStyle = readAutoRevealStyle(node.autoRevealStyle);
    let autoRevealDurationMs = clamp(
        readNumber(node.autoRevealDurationMs, DEFAULT_AUTO_REVEAL_DURATION_MS),
        0,
        MAX_AUTO_REVEAL_DURATION_MS,
    );

    // ── BRUSH UNIT CONVERSION (display px → local px) ──────────────────────
    // See the BRUSH UNITS block at the top. `brushSize` stays in DISPLAY px
    // for its whole life (so `setBrushSize` takes the Inspector's unit); these
    // two factors are the only place it becomes local. Both are exactly 1 when
    // no size override is authored, and both are guarded against a
    // 0 / absent / NaN dimension.
    const brushScaleX = displayToLocalFactor(localWidth, displayWidth);
    const brushScaleY = displayToLocalFactor(localHeight, displayHeight);
    /** Local-space brush diameter. A FUNCTION, not a constant: `setBrushSize`
     *  can change `brushSize` at any point after wiring. */
    const localBrushWidth = (): number => Math.max(1, brushSize * brushScaleX);
    const localBrushHeight = (): number => Math.max(1, brushSize * brushScaleY);

    // Brush bitmap: an authored custom image wins, else the generated radial.
    const brushRef = typeof node.brushTexture === 'string' ? node.brushTexture.trim() : '';
    let brushTexture: PIXI.Texture = PIXI.Texture.WHITE;
    if (brushRef) {
        try {
            brushTexture = deps.resolveTexture(brushRef) ?? getSoftBrushTexture(hardness);
        } catch (err) {
            console.warn(
                `[FlowState/scratchableItem] Could not resolve brushTexture "${brushRef}" for node "${nodeName}"; using the generated soft brush.`,
                err,
            );
            brushTexture = getSoftBrushTexture(hardness);
        }
    } else {
        brushTexture = getSoftBrushTexture(hardness);
    }

    const brush = new PIXI.Sprite(brushTexture);
    brush.anchor.set(0.5);
    // Pixi 8 blend modes are plain strings; `BLEND_MODES` is a type-only export.
    brush.blendMode = 'erase';

    // The brush MUST be rendered as a CHILD, never passed to `renderer.render()`
    // itself: that makes it a render-group root, and a root's own `blendMode` is
    // never folded into the `groupBlendMode` the batcher actually reads, so the
    // erase silently degrades to 'normal' and nothing is ever scratched away.
    // Allocated once per wired node — `stampAt` runs per pointermove step.
    const brushHolder = new PIXI.Container();
    brushHolder.addChild(brush);

    // ── Mask state ────────────────────────────────────────────────────────
    // LAZY BY DESIGN. The mask is NOT built at wire time. An unscratched panel's
    // mask is a fully-opaque white rect, so a correctly-masked unscratched
    // sprite is pixel-identical to an unmasked one — building it early buys
    // nothing visually while turning every possible mask defect (geometry,
    // priming, filter, coordinate space, resolution) into a totally invisible
    // node. Until the first actual scratch, a `scratchableItem` therefore takes
    // EXACTLY the same render path as a plain `sprite`. Do not re-add an eager
    // `ensureMask()`.
    let maskTexture: PIXI.RenderTexture | null = null;
    let maskSprite: PIXI.Sprite | null = null;
    /** Latched after the first failed build so we neither warn nor retry per
     *  pointermove. The node stays unmasked and unscratchable, but VISIBLE. */
    let maskFailed = false;

    // ── Anchor tracking ───────────────────────────────────────────────────
    // `SceneManager.applyTransform` sets `sprite.anchor` from the authored
    // pivot AFTER this component attaches (and again on every layout-manager
    // override pass, which may carry a DIFFERENT pivot per camera mode), so
    // the anchor must be re-read — never captured once at attach time.
    //
    // A non-zero anchor shifts the sprite's OWN quad to
    // `-anchor * native .. (1 - anchor) * native` while its children (the mask)
    // stay in the unshifted local space. Left untracked, the mask sits over the
    // wrong region and blanks most/all of the panel (the editor default pivot
    // is 0.5/0.5, so this is the DEFAULT case, not an edge case). It also
    // breaks input: pixi's InteractionManager hit-tests through
    // `displayObject._mask.containsPoint`.
    let anchorOffsetX = 0;
    let anchorOffsetY = 0;

    const syncMaskTransform = (): void => {
        anchorOffsetX = readNumber(sprite.anchor?.x, 0) * localWidth;
        anchorOffsetY = readNumber(sprite.anchor?.y, 0) * localHeight;
        if (maskSprite && !(maskSprite as unknown as { destroyed?: boolean }).destroyed) {
            maskSprite.position.set(-anchorOffsetX, -anchorOffsetY);
        }
    };

    /** Fill `target` with the opaque white "nothing scratched yet" rect, in the
     *  SAME local space every stamp uses. Two independent primer paths (the
     *  graphics-geometry batch and the sprite batch) so a no-op in one can be
     *  retried through the other. THROWS on a renderer error so `ensureMask`
     *  can abandon the whole build — a half-primed RenderTexture must never
     *  reach `sprite.mask`. */
    const primeMaskTexture = (target: PIXI.RenderTexture, viaSprite: boolean): void => {
        const filler: PIXI.Graphics | PIXI.Sprite = viaSprite
            ? new PIXI.Sprite(PIXI.Texture.WHITE)
            : new PIXI.Graphics();
        if (filler instanceof PIXI.Sprite) {
            filler.position.set(0, 0);
            filler.width = localWidth;
            filler.height = localHeight;
        } else {
            // Pixi 8 path API. `beginFill`/`drawRect`/`endFill` survive only as
            // deprecation shims and the old begin/draw/end ORDER silently
            // paints nothing — the fill must come AFTER the shape.
            filler.rect(0, 0, localWidth, localHeight);
            filler.fill({ color: 0xffffff, alpha: 1 });
        }
        try {
            renderer.render({ container: filler, target, clear: true });
        } finally {
            try {
                // `Texture.WHITE` is a shared singleton — destroy the wrapper only.
                filler.destroy(viaSprite ? { children: false, texture: false, textureSource: false } : true);
            } catch { /* no-op */ }
        }
    };

    /** Last read-back texel, for the first-mask diagnostic. */
    let primedPixel = '';
    let primeVerdict: PrimeVerdict = 'unknown';

    /**
     * PROVE the prime landed by reading one texel straight out of the mask
     * framebuffer.
     *
     * `isRenderTextureAllocated` reports only that the surface EXISTS. A prime
     * that is silently a no-op leaves it allocated and fully transparent, and
     * since the mask filter samples `mask.r * mask.a`, an all-zero mask clips
     * the ENTIRE node — the classic "panel renders fine, then vanishes on first
     * touch". So allocation is never accepted as proof.
     *
     * Returns `unknown` (a PASS) when there is no GL context to read from, e.g.
     * a WebGPU renderer.
     *
     * `renderer.extract.pixels` is deliberately NOT used: it ignores `frame`
     * for a Texture target and would copy the whole surface (up to
     * MAX_MASK_DIMENSION squared) to read one texel. The bind is saved and
     * restored explicitly rather than via `push`/`pop`, because `pop()` THROWS
     * on an empty stack and we are outside the renderer's own render pass.
     */
    const verifyPrimedPixels = (target: PIXI.RenderTexture): PrimeVerdict => {
        const gl: WebGLRenderingContext | undefined = renderer.gl;
        const renderTargets = renderer.renderTarget;
        if (!gl || typeof gl.readPixels !== 'function' || !renderTargets) return 'unknown';
        const source = target.source;
        const realWidth = Math.max(1, Math.round(readNumber(source?.pixelWidth, 0)));
        const realHeight = Math.max(1, Math.round(readNumber(source?.pixelHeight, 0)));
        const pixel = new Uint8Array(4);
        let saved: unknown = null;
        try {
            saved = typeof renderTargets.getBindState === 'function' ? renderTargets.getBindState() : null;
            // Binding the RT also binds its framebuffer as the GL read target.
            renderTargets.bind({ target, clear: false });
            gl.readPixels(realWidth >> 1, realHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        } catch {
            return 'unknown';
        } finally {
            try {
                if (saved && (saved as { target?: unknown }).target) {
                    renderTargets.bind({ ...(saved as object), clear: false });
                }
            } catch { /* no-op */ }
        }
        primedPixel = `rgba(${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3]})`;
        return pixel[3] > 8 && pixel[0] > 8 ? 'ok' : 'blank';
    };

    /** Snapshot of the first successful mask build, logged once after the first
     *  stamp (see `logFirstMaskDiagnostic`). ONE-SHOT for the node's whole
     *  lifetime — `reset()` rebuilds the mask but must not re-log. */
    let maskBuildReport: Record<string, unknown> | null = null;
    let maskDiagnosticEmitted = false;

    const readWorldBounds = (obj: PIXI.Container | null): unknown => {
        if (!obj) return 'none';
        try {
            const b = obj.getBounds();
            return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
        } catch {
            return 'unavailable';
        }
    };

    /** Capture the geometry of the just-built mask. Taken HERE rather than at
     *  log time because `revealAll()` may tear the mask down before the report
     *  is emitted, and its geometry is exactly what a blank-panel report needs.
     *
     *  MUST run BEFORE `sprite.mask = ms`: pixi 8's `AlphaMask.init` sets
     *  `mask.measurable = false`, after which `ms.getBounds()` reports nothing. */
    const captureMaskBuildReport = (rt: PIXI.RenderTexture, ms: PIXI.Sprite): void => {
        if (maskDiagnosticEmitted) return;
        maskBuildReport = {
            node: nodeName || '?',
            localSpace: `${localWidth}x${localHeight}`,
            authoredDisplay: `${displayWidth}x${displayHeight}`,
            renderTexture: {
                width: readNumber(rt.width, 0),
                height: readNumber(rt.height, 0),
                resolution: +maskResolution.toFixed(4),
                realWidth: readNumber(rt.source?.pixelWidth, 0),
                realHeight: readNumber(rt.source?.pixelHeight, 0),
                origWidth: readNumber(rt.orig?.width, 0),
                origHeight: readNumber(rt.orig?.height, 0),
                allocated: isRenderTextureAllocated(rt),
            },
            primed: primeVerdict,
            primedCentreTexel: primedPixel || 'not-read',
            anchor: { x: readNumber(sprite.anchor?.x, 0), y: readNumber(sprite.anchor?.y, 0) },
            anchorOffset: { x: anchorOffsetX, y: anchorOffsetY },
            maskSprite: {
                scaleX: readNumber(ms.scale?.x, 0),
                scaleY: readNumber(ms.scale?.y, 0),
                x: readNumber(ms.position?.x, 0),
                y: readNumber(ms.position?.y, 0),
            },
            maskWorldBounds: readWorldBounds(ms),
            spriteWorldBounds: readWorldBounds(sprite),
        };
    };

    /**
     * Build the mask on demand (first scratch / first reset-after-scratch).
     *
     * FAIL-SAFE ORDERING: the RenderTexture is created, primed and validated
     * BEFORE anything is assigned to `sprite.mask`. Any failure at any step
     * tears the partial work down, leaves `sprite.mask` null and returns false —
     * so a broken mask can never hide the node, only disable scratching.
     */
    const ensureMask = (): boolean => {
        if (maskTexture && maskSprite && !(maskSprite as unknown as { destroyed?: boolean }).destroyed) {
            syncMaskTransform();
            return true;
        }
        if (maskFailed) return false;

        let rt: PIXI.RenderTexture | null = null;
        let ms: PIXI.Sprite | null = null;
        try {
            rt = PIXI.RenderTexture.create({
                width: localWidth,
                height: localHeight,
                resolution: maskResolution,
            });
            primeMaskTexture(rt, false);
            if (!isRenderTextureAllocated(rt)) throw new Error('mask RenderTexture has no allocated surface after priming');
            primeVerdict = verifyPrimedPixels(rt);
            if (primeVerdict === 'blank') {
                // The graphics batch wrote nothing. Retry through the sprite
                // batch — the same path the brush stamps use — before giving up.
                primeMaskTexture(rt, true);
                primeVerdict = verifyPrimedPixels(rt);
            }
            if (primeVerdict === 'blank') {
                throw new Error(
                    `mask RenderTexture primed to a fully transparent surface (centre texel ${primedPixel}); `
                    + 'a mask like that clips the whole node',
                );
            }

            ms = new PIXI.Sprite(rt);
            ms.label = '__orcaScratchMask';
            // NO width/height override: the RenderTexture already spans the
            // sprite's LOCAL extent, so the mask sprite stays at scale 1 and
            // the alpha-mask pipe maps it onto the quad exactly. Setting a size
            // here is what reintroduces the second coordinate space.
            // Pixi requires the mask object on the display list; `renderable`
            // (not `visible`) is cleared so its transform still updates. Pixi 8
            // clears it itself in `AlphaMask.init`, but do it up-front so the
            // mask is never drawn in the frame it is added.
            ms.renderable = false;
            // Per-frame anchor tracking, WITHOUT a ticker: pixi 8 has no
            // per-frame `updateTransform` to wrap (it is now an options-object
            // setter), so use the `onRender` hook. `RenderGroup.runOnRender`
            // fires for every registered container — `renderable = false`
            // included — and runs BEFORE `updateRenderGroupTransforms`, so a
            // reposition here lands in the same frame. Assigned BEFORE
            // `addChild`, which is what registers it on the render group.
            ms.onRender = (): void => { syncMaskTransform(); };
            // Position it before it becomes the mask (`syncMaskTransform` only
            // refreshes the offsets while `maskSprite` is still null).
            syncMaskTransform();
            ms.position.set(-anchorOffsetX, -anchorOffsetY);

            // Point of no return — everything above succeeded.
            sprite.addChild(ms);
            maskTexture = rt;
            maskSprite = ms;
            // Report BEFORE the mask slot is taken: assigning it marks the mask
            // unmeasurable, which would blank the geometry the report exists for.
            captureMaskBuildReport(rt, ms);
            sprite.mask = ms;
            return true;
        } catch (err) {
            maskFailed = true;
            maskTexture = null;
            maskSprite = null;
            if (ms) {
                try {
                    ms.onRender = null;
                    if (ms.parent) ms.parent.removeChild(ms);
                    ms.destroy({ children: false, texture: false, textureSource: false });
                } catch { /* no-op */ }
            }
            if (rt) {
                try { rt.destroy(true); } catch { /* no-op */ }
            }
            // Belt and braces: never leave a partial object in the mask slot.
            sprite.mask = null;
            console.warn(
                `[FlowState/scratchableItem] Failed to create the scratch mask for "${nodeName}" — the node stays visible and unscratchable.`,
                err,
            );
            return false;
        }
    };

    /** Full teardown back to the pristine UNMASKED render path — the exact
     *  state a never-scratched node is in. Safe to call when no mask exists. */
    const destroyMask = (): void => {
        if (sprite.mask === maskSprite) sprite.mask = null;
        if (maskSprite && !(maskSprite as unknown as { destroyed?: boolean }).destroyed) {
            try {
                maskSprite.onRender = null;
                if (maskSprite.parent) maskSprite.parent.removeChild(maskSprite);
                maskSprite.destroy({ children: false, texture: false, textureSource: false });
            } catch { /* no-op */ }
        }
        maskSprite = null;
        if (maskTexture) {
            try { maskTexture.destroy(true); } catch { /* no-op */ }
            maskTexture = null;
        }
    };

    // ── Progress (coarse occupancy grid — never reads back pixels) ─────────
    // Sized to the DISPLAY extent, so one cell is about one display pixel and
    // the unconditional centre-cell claim below stays honest for a brush of any
    // size. See the PROGRESS block at the top. Independent per axis, so a
    // non-square panel gets non-square cells rather than a distorted estimate.
    const progressCols = Math.round(clamp(Math.round(displayWidth), MIN_PROGRESS_GRID, MAX_PROGRESS_GRID));
    const progressRows = Math.round(clamp(Math.round(displayHeight), MIN_PROGRESS_GRID, MAX_PROGRESS_GRID));
    const progressCellCount = progressCols * progressRows;
    const cells = new Uint8Array(progressCellCount);
    let markedCells = 0;
    let complete = false;
    let completeFired = false;

    const markCell = (col: number, row: number): void => {
        if (col < 0 || col >= progressCols || row < 0 || row >= progressRows) return;
        const index = row * progressCols + col;
        if (cells[index]) return;
        cells[index] = 1;
        markedCells += 1;
    };

    const markBrushFootprint = (localX: number, localY: number): void => {
        // SAME single space as `stampAt`: a pure anchor rebase, plus the SAME
        // display→local brush conversion, so the ellipse below is exactly the
        // disc the brush erases and `progress` is the true erased fraction.
        const nx = (localX + anchorOffsetX) / localWidth;
        const ny = (localY + anchorOffsetY) / localHeight;
        // Always claim the cell under the brush centre so a very small brush
        // still makes progress even when it covers no other cell centre. The
        // grid is display-resolution, so this over-claims by about one display
        // pixel rather than by a whole 6x3 block.
        markCell(Math.floor(nx * progressCols), Math.floor(ny * progressRows));

        // These normalise to `(brushSize / 2) / displayWidth|Height` — i.e. the
        // footprint is a pure function of the DISPLAY geometry, so an identical
        // authored brush claims an identical share of the grid whatever the
        // source texture's resolution happens to be.
        const rx = (localBrushWidth() / 2) / localWidth;
        const ry = (localBrushHeight() / 2) / localHeight;
        if (rx <= 0 || ry <= 0) return;

        const colFrom = Math.floor((nx - rx) * progressCols);
        const colTo = Math.floor((nx + rx) * progressCols);
        const rowFrom = Math.floor((ny - ry) * progressRows);
        const rowTo = Math.floor((ny + ry) * progressRows);

        for (let row = rowFrom; row <= rowTo; row += 1) {
            for (let col = colFrom; col <= colTo; col += 1) {
                const dx = ((col + 0.5) / progressCols - nx) / rx;
                const dy = ((row + 0.5) / progressRows - ny) / ry;
                if (dx * dx + dy * dy <= 1) markCell(col, row);
            }
        }
    };

    const getProgress = (): number => (complete ? 1 : markedCells / progressCellCount);

    // ── Painting ──────────────────────────────────────────────────────────
    /** Stamps issued since the mask was built — drives the one-shot diagnostic
     *  and the "threshold hit on the very first stamp" warning. */
    let stampCount = 0;

    const stampAt = (localX: number, localY: number): void => {
        if (!maskTexture) return;
        stampCount += 1;
        // PURE ANCHOR REBASE for the POSITION — no scale factor. `sprite.toLocal()`
        // returns coordinates whose origin is the sprite's transform origin, so
        // the panel spans `-anchor * local .. (1 - anchor) * local`, while the
        // RenderTexture spans `0 .. local`. Both are the SAME space otherwise.
        // The SIZE is the one thing that changes space: `brushSize` is authored
        // in DISPLAY px, so it is converted per axis here. Non-uniform overrides
        // give an ellipse in local space that renders as a circle on screen.
        brush.position.set(localX + anchorOffsetX, localY + anchorOffsetY);
        brush.width = localBrushWidth();
        brush.height = localBrushHeight();
        try {
            renderer.render({ container: brushHolder, target: maskTexture, clear: false });
        } catch (err) {
            console.warn(`[FlowState/scratchableItem] Failed to paint the scratch mask for "${nodeName}".`, err);
        }
        markBrushFootprint(localX, localY);
    };

    const markComplete = (): void => {
        if (completeFired) return;
        completeFired = true;
        complete = true;
        try {
            void Flowstate.runFlowsByStarterType('scratchComplete', { nodeName });
        } catch (err) {
            console.warn(`[FlowState/scratchableItem] scratchComplete dispatch failed for "${nodeName}".`, err);
        }
    };

    const fireStrokeStarter = (title: 'scratchStarted' | 'scratchStopped'): void => {
        try {
            void Flowstate.runFlowsByStarterType(title, { nodeName, progress: getProgress() });
        } catch (err) {
            console.warn(`[FlowState/scratchableItem] ${title} dispatch failed for "${nodeName}".`, err);
        }
    };

    // ── Scratch debris (first authored `particles` child) ─────────────────
    // Adopted lazily on the first stroke: only the emitter's LAYER moves, into
    // a host just above the sprite, so debris escapes the scratch mask, the
    // reveal's `renderable = false`, the fade's alpha and the size scale. The
    // emitter itself stays owned (and destroyed) by its particles container.
    type ScratchDebris = { emitter: ScratchDebrisEmitterLike; container: PIXI.Container; host: PIXI.Container };
    let debris: ScratchDebris | null = null;
    let debrisIdleTimer: ReturnType<typeof setTimeout> | null = null;

    const placeDebrisHost = (): void => {
        if (!debris || debris.host.destroyed) return;
        const { host } = debris;
        const parent = sprite.parent;
        if (!parent) {
            host.parent?.removeChild(host);
            return;
        }
        // Siblings are zIndex-sorted; an equal zIndex right after the sprite draws just above it.
        host.zIndex = sprite.zIndex;
        const target = parent.getChildIndex(sprite) + 1;
        if (host.parent === parent && parent.getChildIndex(host) === target) return;
        host.parent?.removeChild(host);
        parent.addChildAt(host, parent.getChildIndex(sprite) + 1);
    };

    const onDebrisSpriteRemoved = (): void => {
        if (debris && !debris.host.destroyed) debris.host.parent?.removeChild(debris.host);
    };

    const adoptDebris = (): ScratchDebris | null => {
        if (debris) return debris.emitter.destroyed ? null : debris;
        const source = sprite.__orcaScratchDebris;
        const emitter = source?.emitter;
        const layer = emitter?.layer;
        if (!source || !emitter || emitter.destroyed || !layer || layer.destroyed) return null;
        const host = new PIXI.Container({ label: '__orcaScratchDebrisHost' });
        host.eventMode = 'none';
        host.addChild(layer);
        debris = { emitter, container: source.container, host };
        sprite.on('added', placeDebrisHost);
        sprite.on('removed', onDebrisSpriteRemoved);
        placeDebrisHost();
        return debris;
    };

    const clearDebrisIdle = (): void => {
        if (debrisIdleTimer !== null) {
            clearTimeout(debrisIdleTimer);
            debrisIdleTimer = null;
        }
    };

    const stopDebris = (): void => {
        clearDebrisIdle();
        if (debris && !debris.emitter.destroyed) debris.emitter.emit = false;
    };

    /** Called at every stroke point: move the spawn point there and keep emitting. */
    const feedDebris = (localX: number, localY: number): void => {
        if (!sprite.__orcaScratchDebris && !debris) return;
        const d = adoptDebris();
        if (!d) return;
        try {
            const point = d.host.toLocal(sprite.toGlobal({ x: localX, y: localY }));
            if (Number.isFinite(point.x) && Number.isFinite(point.y)) d.emitter.setSpawnOffset?.(point.x, point.y);
        } catch { /* no-op */ }
        if (!d.emitter.emit) {
            placeDebrisHost();
            d.host.visible = d.container.visible;
            d.host.alpha = d.container.alpha;
            d.emitter.emit = true;
        }
        clearDebrisIdle();
        debrisIdleTimer = setTimeout(() => {
            debrisIdleTimer = null;
            if (debris && !debris.emitter.destroyed) debris.emitter.emit = false;
        }, DEBRIS_IDLE_MS);
    };

    /** On sprite teardown: hand the layer back to its container so the emitter's own destroy cleans it up. */
    const releaseDebris = (): void => {
        clearDebrisIdle();
        const d = debris;
        if (!d) return;
        debris = null;
        try { sprite.off('added', placeDebrisHost); } catch { /* no-op */ }
        try { sprite.off('removed', onDebrisSpriteRemoved); } catch { /* no-op */ }
        const layer = d.emitter.layer;
        if (!d.emitter.destroyed && layer && !layer.destroyed && !d.container.destroyed) {
            d.emitter.emit = false;
            d.container.addChildAt(layer, 0);
        }
        if (!d.host.destroyed) {
            d.host.parent?.removeChild(d.host);
            d.host.destroy({ children: false });
        }
    };

    /** The terminal state every reveal style ends in — and, for the default
     *  `'instant'` style, the WHOLE of `revealAll()`, synchronously, on the
     *  same call stack it has always run on. */
    const finishReveal = (): void => {
        stopDebris();
        markedCells = cells.length;
        cells.fill(1);
        complete = true;
        destroyMask();
        // "Fully revealed" == every pixel of the panel erased, i.e. whatever is
        // BEHIND it shows through. Dropping the mask alone would draw the panel
        // back at full opacity, so the sprite is taken out of the render pass
        // instead. `renderable = false` skips the sprite AND its children,
        // matching a fully-erased mask exactly, and needs no mask to exist.
        sprite.renderable = false;
        markComplete();
    };

    // ── Animated reveal (`fade` / `dissolve`) ─────────────────────────────
    // ORDERING: the erase/fade runs FIRST and `finishReveal()` — which drops
    // the mask and stops rendering the sprite — runs LAST. Destroying the mask
    // up front would pop a partially-erased panel back to full opacity for a
    // frame.
    /** Non-null exactly while a reveal animation is in flight. */
    let revealTick: ((ticker: PIXI.Ticker) => void) | null = null;
    /** `sprite.alpha` as it was when a `fade` started, so `reset()` can't leave
     *  an invisible sprite behind. */
    let revealAlphaRestore: number | null = null;
    /** Resolvers of `autoScratch` promises waiting on the in-flight reveal —
     *  flushed whenever it ends, completed or interrupted. */
    let revealWaiters: Array<() => void> = [];

    /** @param restoreAlpha false only when the sprite is gone — writing to a
     *  destroyed container's `alpha` is what turns a leak into a throw. */
    const stopRevealAnimation = (restoreAlpha: boolean): void => {
        if (revealTick) {
            try { PIXI.Ticker.shared.remove(revealTick); } catch { /* no-op */ }
            revealTick = null;
        }
        if (restoreAlpha && revealAlphaRestore !== null) sprite.alpha = revealAlphaRestore;
        revealAlphaRestore = null;
        const waiters = revealWaiters;
        revealWaiters = [];
        // Promise resolution is a microtask, so waiters observe `finishReveal()` too.
        for (const resolve of waiters) resolve();
    };

    /** Scatter the still-unscratched cells so `dissolve` erases the panel in a
     *  pseudo-random order. Deterministic (a seeded LCG shuffle) — no PRNG
     *  dependency, and no reliance on `Math.random`. */
    const buildDissolveOrder = (): number[] => {
        const order: number[] = [];
        for (let i = 0; i < cells.length; i += 1) {
            if (!cells[i]) order.push(i);
        }
        let seed = (0x9e3779b9 ^ order.length) >>> 0;
        for (let i = order.length - 1; i > 0; i -= 1) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const j = seed % (i + 1);
            const swap = order[i];
            order[i] = order[j];
            order[j] = swap;
        }
        return order;
    };

    const revealAll = (): void => {
        // Idempotent: a second call mid-animation must not stack a second tween.
        if (revealTick) return;

        // A duration of 0 (or an unrecognised style) is today's behaviour,
        // byte for byte, on the same synchronous call stack.
        let style: ScratchAutoRevealStyle = autoRevealDurationMs > 0 ? autoRevealStyle : 'instant';
        // THE MASK STAYS LAZY — `revealAll()` must work with no mask built at
        // all (the `revealScratch` node fires before the first stroke), so
        // `dissolve` degrades rather than forcing an eager `ensureMask()`.
        if (style === 'dissolve' && !maskTexture) style = 'fade';
        if (style === 'instant') {
            finishReveal();
            return;
        }

        // Latch `complete` at the START so `paintTo` stops accepting strokes and
        // `handle.isComplete()` reports true immediately; `markComplete()` —
        // which dispatches the `scratchComplete` starter — fires at the END, via
        // `finishReveal()`, so downstream flows sequence after the visual.
        complete = true;

        const duration = autoRevealDurationMs;
        const order = style === 'dissolve' ? buildDissolveOrder() : [];
        let cursor = 0;
        let elapsed = 0;

        if (style === 'fade') revealAlphaRestore = readNumber(sprite.alpha, 1);
        const startAlpha = revealAlphaRestore ?? 1;

        const step = (t: number): void => {
            if (style === 'fade') {
                sprite.alpha = startAlpha * (1 - t);
                return;
            }
            const target = Math.min(order.length, Math.ceil(t * order.length));
            while (cursor < target) {
                const index = order[cursor];
                cursor += 1;
                // A neighbouring stamp has already erased this cell.
                if (cells[index]) continue;
                const col = index % progressCols;
                const row = (index - col) / progressCols;
                stampAt(
                    ((col + 0.5) / progressCols) * localWidth - anchorOffsetX,
                    ((row + 0.5) / progressRows) * localHeight - anchorOffsetY,
                );
            }
        };

        const tick = (ticker: PIXI.Ticker): void => {
            if ((sprite as unknown as { destroyed?: boolean }).destroyed) {
                // Never touch a destroyed sprite, and never leak the callback.
                stopRevealAnimation(false);
                return;
            }
            elapsed += readNumber(ticker.deltaMS, 0);
            const t = clamp(elapsed / duration, 0, 1);
            step(t);
            if (t < 1) return;
            stopRevealAnimation(true);
            finishReveal();
        };

        revealTick = tick;
        PIXI.Ticker.shared.add(tick);
    };

    /** Erase from the previous point to the current one, stepping by ~1/3 of
     *  the brush diameter so a fast drag doesn't leave gaps. */
    let lastLocalX: number | null = null;
    let lastLocalY: number | null = null;

    /**
     * ONE-SHOT first-mask-build report — the companion to the wire diagnostic.
     * Emitted after the FIRST stamp so it can also state whether that stamp
     * tripped the reveal threshold. Never per frame, never per stroke.
     *
     * A blank panel has exactly two possible causes, and this report separates
     * them outright: an all-transparent mask (`primed` !== 'ok', or mask world
     * bounds that don't overlap the sprite's) versus `revealAll()` having
     * fired (`complete: true` / `spriteRenderable: false` on stamp 1).
     */
    const logFirstMaskDiagnostic = (): void => {
        if (!maskBuildReport) return;
        const report = maskBuildReport;
        maskBuildReport = null;
        maskDiagnosticEmitted = true;
        console.info(`[FlowState/scratchableItem] first mask build "${nodeName || '?'}"`, {
            ...report,
            brush: {
                // Authored (display px) vs what actually gets stamped (local px),
                // plus the factors between them — the three numbers needed to tell
                // "the author asked for a huge brush" from "the unit conversion
                // misfired" when a panel opens on the first touch.
                sizeDisplayPx: brushSize,
                sizeLocalPx: `${+localBrushWidth().toFixed(2)}x${+localBrushHeight().toFixed(2)}`,
                displayToLocalX: +brushScaleX.toFixed(4),
                displayToLocalY: +brushScaleY.toFixed(4),
                width: +readNumber(brush.width, 0).toFixed(2),
                height: +readNumber(brush.height, 0).toFixed(2),
                x: +readNumber(brush.position?.x, 0).toFixed(2),
                y: +readNumber(brush.position?.y, 0).toFixed(2),
                // EFFECTIVE blend mode, not the authored `blendMode` getter: the
                // latter returns `localBlendMode` and reported 'erase' even while
                // the batcher was drawing 'normal', hiding a total scratch failure.
                effectiveBlendMode: brush.groupBlendMode,
                blendModeIsErase: brush.groupBlendMode === 'erase',
            },
            stamps: stampCount,
            // Grid dimensions matter to a blank-panel report: `progress` is
            // marked cells over this total, and a cell much larger than the
            // brush is what lets a hairline scrub reveal the whole panel.
            progressGrid: `${progressCols}x${progressRows}`,
            progressCellDisplayPx: `${+(displayWidth / progressCols).toFixed(3)}x${+(displayHeight / progressRows).toFixed(3)}`,
            markedCells: `${markedCells}/${progressCellCount}`,
            progress: +getProgress().toFixed(4),
            revealThreshold,
            autoReveal,
            autoRevealStyle,
            autoRevealDurationMs,
            complete,
            maskAssigned: !!maskSprite && sprite.mask === maskSprite,
            spriteRenderable: sprite.renderable === true,
        });
    };

    /** The ONE threshold evaluation: per stamp by default, or once per stroke
     *  end when `revealOnPointerRelease`. `getProgress()` is computed live, so
     *  a release-time call always sees every stamp of the stroke. */
    const evaluateRevealThreshold = (): void => {
        if (!complete && getProgress() >= revealThreshold) {
            if (stampCount <= 1) {
                // A single brush-sized dot should be a fraction of a percent of
                // the panel. Hitting the threshold on stamp 1 means the panel
                // will look like it vanished the instant it is touched.
                console.warn(
                    `[FlowState/scratchableItem] "${nodeName || '?'}" reached its reveal threshold on the FIRST stamp `
                    + `(progress ${getProgress().toFixed(4)} >= revealThreshold ${revealThreshold}) — the panel opens immediately. `
                    + `Raise revealThreshold, or lower brushSize (${brushSize} display px) relative to the node's DISPLAY size `
                    + `(${displayWidth}x${displayHeight}).`,
                );
            }
            if (autoReveal) {
                revealAll();
            } else {
                complete = true;
                markComplete();
            }
        }
    };

    /** Shared by pointer input and `autoScratch`. The `enabled` gate lives in
     *  `paintTo` because it governs PLAYER input only. */
    const paintStroke = (localX: number, localY: number): void => {
        if (complete) return;
        if (!ensureMask()) return;
        feedDebris(localX, localY);

        if (lastLocalX === null || lastLocalY === null) {
            stampAt(localX, localY);
        } else {
            const dx = localX - lastLocalX;
            const dy = localY - lastLocalY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            // `distance` is LOCAL, so the step must be too — take the tighter
            // axis of the converted diameter so a non-uniform override can't
            // under-sample the short side and leave gaps in a fast drag.
            const step = Math.max(1, Math.min(localBrushWidth(), localBrushHeight()) / 3);
            const steps = Math.max(1, Math.ceil(distance / step));
            for (let i = 1; i <= steps; i += 1) {
                const t = i / steps;
                stampAt(lastLocalX + dx * t, lastLocalY + dy * t);
            }
        }
        lastLocalX = localX;
        lastLocalY = localY;

        if (!revealOnPointerRelease) evaluateRevealThreshold();

        logFirstMaskDiagnostic();
    };

    const paintTo = (localX: number, localY: number): void => {
        if (!enabled) return;
        paintStroke(localX, localY);
    };

    // ── Input (pixi 8 federated events) ───────────────────────────────────
    const stage = deps.stage;
    let dragging = false;
    /** Pointer driving the current stroke; null when not dragging. */
    let strokePointerId: number | null = null;

    const toLocalPoint = (global: PIXI.PointData): { x: number; y: number } | null => {
        try {
            const local = sprite.toLocal(global);
            if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return null;
            return { x: local.x, y: local.y };
        } catch {
            return null;
        }
    };

    const onMove = (event: PIXI.FederatedPointerEvent): void => {
        if (!dragging) return;
        const point = toLocalPoint(event.global);
        if (!point) return;
        paintTo(point.x, point.y);
    };

    const endDrag = (): void => {
        if (!dragging) return;
        dragging = false;
        stopDebris();
        strokePointerId = null;
        lastLocalX = null;
        lastLocalY = null;
        detachCapture();
    };

    // Only the pointer handlers use this. `setEnabled(false)` and the destroy
    // teardown call the bare `endDrag`, so neither fires a user-release starter.
    const endStroke = (): void => {
        const wasDragging = dragging;
        endDrag();
        // Before the `complete` check, so a release that completes the panel
        // suppresses `scratchStopped` exactly like a mid-stroke completion.
        if (wasDragging && revealOnPointerRelease) evaluateRevealThreshold();
        // `wasDragging` makes the sprite-level and stage-level release for the
        // same gesture produce exactly one dispatch; `complete` keeps a panel
        // finished mid-stroke from reporting "stopped" right after completing.
        if (!wasDragging || complete) return;
        fireStrokeStarter('scratchStopped');
    };

    // ── Scripted stroke (`autoScratch`) ───────────────────────────────────
    // A FAKE touch dragged along an authored path through `paintStroke`, so
    // interpolation, progress, threshold and auto-reveal are exactly a real
    // stroke's. Driven by `PIXI.Ticker.shared`, the ticker the reveal uses.
    type AutoScratchRun = {
        tick: ((ticker: PIXI.Ticker) => void) | null;
        resolve: () => void;
        revealOnFinish: boolean;
    };
    /** Non-null exactly while a scripted stroke is in flight. */
    let autoRun: AutoScratchRun | null = null;
    let autoScratchMaskWarned = false;

    const detachAutoRun = (run: AutoScratchRun): void => {
        stopDebris();
        if (run.tick) {
            try { PIXI.Ticker.shared.remove(run.tick); } catch { /* no-op */ }
            run.tick = null;
        }
        lastLocalX = null;
        lastLocalY = null;
    };

    const releaseAutoRun = (run: AutoScratchRun): void => {
        detachAutoRun(run);
        run.resolve();
    };

    /** Abandon the scripted stroke WITHOUT `scratchStopped` (the bare-`endDrag`
     *  convention for teardown / reset). Safe to call when none is running. */
    const cancelAutoScratch = (): void => {
        const run = autoRun;
        if (!run) return;
        autoRun = null;
        releaseAutoRun(run);
    };

    /** Natural end of the path: the full reveal when `revealOnFinish`, else
     *  `scratchStopped` — neither if the stroke already completed the panel. */
    const finishAutoScratch = (run: AutoScratchRun): void => {
        if (autoRun !== run) return;
        // Retired BEFORE any reveal, so nothing can treat it as a live stroke to cancel.
        autoRun = null;
        const destroyed = (sprite as unknown as { destroyed?: boolean }).destroyed === true;
        if (revealOnPointerRelease && !destroyed) evaluateRevealThreshold();
        if (complete || destroyed || !run.revealOnFinish) {
            const stopped = !complete && !destroyed;
            releaseAutoRun(run);
            if (stopped) fireStrokeStarter('scratchStopped');
            return;
        }
        detachAutoRun(run);
        revealAll();
        if (revealTick) revealWaiters.push(run.resolve);
        else run.resolve();
    };

    const paintNormalized = (p: NormalizedPoint): void => {
        // `ensureMask` re-syncs `anchorOffsetX/Y`, so convert AFTER it — the SAME
        // anchor-relative local space `toLocalPoint` feeds `paintTo`.
        if (!ensureMask()) return;
        paintStroke(p.x * localWidth - anchorOffsetX, p.y * localHeight - anchorOffsetY);
    };

    const autoScratch = (pathIndex: number, durationMs: number, revealOnFinish: boolean): Promise<void> => {
        cancelAutoScratch();
        if (typeof pathIndex !== 'number' || !Number.isInteger(pathIndex) || pathIndex < 0 || pathIndex >= scratchPaths.length) {
            console.warn(
                `[FlowState/scratchableItem] autoScratch: path index ${String(pathIndex)} is out of range for "${nodeName || '?'}" `
                + `(${scratchPaths.length} path${scratchPaths.length === 1 ? '' : 's'} authored).`,
            );
            return Promise.resolve();
        }
        const points = scratchPaths[pathIndex];
        if (points.length < 1) {
            console.warn(`[FlowState/scratchableItem] autoScratch: path ${pathIndex} on "${nodeName || '?'}" has no valid points.`);
            return Promise.resolve();
        }
        let duration = 0;
        if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
            duration = durationMs;
        } else {
            console.warn(`[FlowState/scratchableItem] autoScratch: non-finite durationMs ${String(durationMs)}; scratching instantly.`);
        }

        // The player's stroke and the scripted one share `lastLocalX/Y`, so a drag
        // in progress is released first (firing its own `scratchStopped`); the
        // second cancel drops any run a flow started from inside that dispatch.
        endStroke();
        cancelAutoScratch();

        if (complete || (sprite as unknown as { destroyed?: boolean }).destroyed) return Promise.resolve();
        if (!ensureMask()) {
            if (!autoScratchMaskWarned) {
                autoScratchMaskWarned = true;
                console.warn(`[FlowState/scratchableItem] autoScratch: "${nodeName || '?'}" has no scratch mask — nothing to scratch.`);
            }
            return Promise.resolve();
        }

        const run: AutoScratchRun = {
            tick: null,
            resolve: () => { /* replaced below */ },
            revealOnFinish: revealOnFinish !== false,
        };
        const done = new Promise<void>((resolve) => { run.resolve = resolve; });
        autoRun = run;
        lastLocalX = null;
        lastLocalY = null;
        // Every dispatch or paint below can synchronously run flow code that
        // resets / re-scratches this node, so `autoRun !== run` is re-checked.
        fireStrokeStarter('scratchStarted');
        if (autoRun !== run) return done;

        paintNormalized(points[0]);
        if (autoRun !== run) return done;

        // Arc length is measured in DISPLAY px so the speed is constant on screen.
        const cumulative: number[] = [0];
        for (let i = 1; i < points.length; i += 1) {
            const dx = (points[i].x - points[i - 1].x) * displayWidth;
            const dy = (points[i].y - points[i - 1].y) * displayHeight;
            cumulative.push(cumulative[i - 1] + Math.sqrt(dx * dx + dy * dy));
        }
        const total = cumulative[cumulative.length - 1];

        if (complete || points.length === 1 || !(total > 0)) {
            finishAutoScratch(run);
            return done;
        }

        if (duration <= 0) {
            for (let i = 1; i < points.length; i += 1) {
                paintNormalized(points[i]);
                if (autoRun !== run) return done;
                if (complete) break;
            }
            finishAutoScratch(run);
            return done;
        }

        let elapsed = 0;
        let travelledSoFar = 0;
        let nextVertex = 1;
        const tick = (ticker: PIXI.Ticker): void => {
            if (autoRun !== run) return;
            if ((sprite as unknown as { destroyed?: boolean }).destroyed) {
                cancelAutoScratch();
                return;
            }
            try {
                elapsed += readNumber(ticker.deltaMS, 0);
                const travelled = Math.min(total, (elapsed / duration) * total);
                if (travelled <= travelledSoFar) return;
                travelledSoFar = travelled;
                // Visit every vertex passed this frame so a long frame can't cut a corner.
                while (nextVertex < points.length && cumulative[nextVertex] <= travelled) {
                    paintNormalized(points[nextVertex]);
                    nextVertex += 1;
                    if (autoRun !== run) return;
                    if (complete) {
                        finishAutoScratch(run);
                        return;
                    }
                }
                if (nextVertex >= points.length) {
                    finishAutoScratch(run);
                    return;
                }
                const segStart = cumulative[nextVertex - 1];
                const segLength = cumulative[nextVertex] - segStart;
                const t = segLength > 0 ? (travelled - segStart) / segLength : 0;
                if (t <= 0) return;
                const a = points[nextVertex - 1];
                const b = points[nextVertex];
                paintNormalized({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
                if (autoRun !== run) return;
                if (complete) finishAutoScratch(run);
            } catch (err) {
                console.warn(`[FlowState/scratchableItem] autoScratch on "${nodeName || '?'}" failed mid-path.`, err);
                cancelAutoScratch();
            }
        };
        run.tick = tick;
        PIXI.Ticker.shared.add(tick);
        return done;
    };

    // Pixi 8 has no InteractionManager and no `renderer.plugins` — the
    // stage-capture hack those required is replaced by `globalpointermove`,
    // which `EventBoundary` dispatches to EVERY interactive container on every
    // pointer move regardless of hit-testing, so a drag keeps tracking once the
    // pointer leaves the sprite's bounds. It is bound on the SPRITE, which is
    // already `eventMode: 'static'` while scratching is enabled.
    //
    // UP is bound on the sprite (`pointerup` / `pointerupoutside` /
    // `pointercancel`) AND, as belt and braces, on the host stage when one is
    // registered — a release can land on whichever surface is hit first, and
    // `endStroke` is idempotent.
    let captureAttached = false;

    function attachCapture(): void {
        if (captureAttached) return;
        captureAttached = true;
        sprite.on('globalpointermove', onMove);
        sprite.on('pointerup', endStroke);
        sprite.on('pointerupoutside', endStroke);
        sprite.on('pointercancel', endStroke);
        if (stage) {
            // Required for the root to participate in interaction dispatch.
            stage.eventMode = 'static';
            stage.on('pointerup', endStroke);
            stage.on('pointerupoutside', endStroke);
            stage.on('pointercancel', endStroke);
        }
    }

    function detachCapture(): void {
        if (!captureAttached) return;
        captureAttached = false;
        try {
            sprite.off('globalpointermove', onMove);
            sprite.off('pointerup', endStroke);
            sprite.off('pointerupoutside', endStroke);
            sprite.off('pointercancel', endStroke);
        } catch { /* no-op */ }
        if (stage) {
            try {
                stage.off('pointerup', endStroke);
                stage.off('pointerupoutside', endStroke);
                stage.off('pointercancel', endStroke);
            } catch { /* no-op */ }
        }
    }

    const beginStroke = (event: PIXI.FederatedPointerEvent): void => {
        cancelAutoScratch();
        dragging = true;
        strokePointerId = event.pointerId;
        lastLocalX = null;
        lastLocalY = null;
        attachCapture();
        // Before the first stamp: `progress` reports the stroke's starting
        // state, and a press that completes the panel can't order this after
        // its own `scratchComplete`.
        fireStrokeStarter('scratchStarted');
        const point = toLocalPoint(event.global);
        if (point) paintTo(point.x, point.y);
    };

    // Pointers pressed (anywhere in the page) and not yet spent on a stroke.
    const armedPointers = new Set<number>();

    const onDown = (event: PIXI.FederatedPointerEvent): void => {
        if (!enabled || complete) return;
        armedPointers.delete(event.pointerId);
        beginStroke(event);
    };

    // ── Outside-start (`allowOutsideTouch`) ───────────────────────────────
    // Window listeners: a press arms once (so a held pointer never restarts), and a release off-sprite still ends the stroke.
    const hostWindow: Window | null = allowOutsideTouch
        && typeof window !== 'undefined'
        && typeof window.addEventListener === 'function'
        ? window
        : null;

    const onHostDown = (event: PointerEvent): void => {
        armedPointers.add(event.pointerId);
    };

    const onHostUp = (event: PointerEvent): void => {
        armedPointers.delete(event.pointerId);
        if (dragging && event.pointerId === strokePointerId) endStroke();
    };

    const isPointerOverSprite = (event: PIXI.FederatedPointerEvent): boolean => {
        const point = toLocalPoint(event.global);
        if (!point) return false;
        // The sprite quad spans `-anchor * native .. (1 - anchor) * native` locally.
        const left = -readNumber(sprite.anchor?.x, 0) * localWidth;
        const top = -readNumber(sprite.anchor?.y, 0) * localHeight;
        if (point.x < left || point.x > left + localWidth || point.y < top || point.y > top + localHeight) return false;
        // An interactive node drawn over the panel keeps the pointer, as it would a pointerdown.
        let target = event.target as unknown as PIXI.Container | null;
        if (!target) return true;
        for (; target; target = target.parent) {
            if (target === (sprite as unknown as PIXI.Container)) return true;
        }
        return false;
    };

    // Fires on every move while `'static'`; a disabled (`'passive'`) panel never receives it.
    const onOutsideMove = (event: PIXI.FederatedPointerEvent): void => {
        if (dragging) {
            // Belt and braces for a release no up listener heard (e.g. outside the window).
            if (event.pointerId === strokePointerId && event.buttons === 0) endStroke();
            return;
        }
        if ((event.buttons & 1) === 0) {
            armedPointers.delete(event.pointerId);
            return;
        }
        if (!enabled || complete) return;
        if (hostWindow && !armedPointers.has(event.pointerId)) return;
        if (!isPointerOverSprite(event)) return;
        armedPointers.delete(event.pointerId);
        beginStroke(event);
    };

    if (allowOutsideTouch) {
        sprite.on('globalpointermove', onOutsideMove);
        if (hostWindow) {
            hostWindow.addEventListener('pointerdown', onHostDown, true);
            hostWindow.addEventListener('pointerup', onHostUp, true);
            hostWindow.addEventListener('pointercancel', onHostUp, true);
        }
    }

    // `'passive'` (not `'none'`) when disabled: passive is not hit-tested on
    // itself, so a disabled panel does not swallow pointerdown from the nodes
    // beneath it, while its children stay interactive.
    sprite.eventMode = enabled ? 'static' : 'passive';
    sprite.on('pointerdown', onDown);

    logWireDiagnostic(sprite, node, deps, '');

    // NO eager `ensureMask()` here — see the mask-state block above. The mask is
    // built on the first actual scratch, so an untouched panel renders through
    // the plain-sprite path.

    // ── Teardown — a leaked RenderTexture per scene load is a real GPU leak ─
    sprite.once('destroyed', () => {
        stopRevealAnimation(false);
        cancelAutoScratch();
        endDrag();
        detachCapture();
        try { sprite.off('pointerdown', onDown); } catch { /* no-op */ }
        if (allowOutsideTouch) {
            try { sprite.off('globalpointermove', onOutsideMove); } catch { /* no-op */ }
            if (hostWindow) {
                hostWindow.removeEventListener('pointerdown', onHostDown, true);
                hostWindow.removeEventListener('pointerup', onHostUp, true);
                hostWindow.removeEventListener('pointercancel', onHostUp, true);
            }
            armedPointers.clear();
        }
        destroyMask();
        releaseDebris();
        // The brush texture is either module-cached (shared) or owned by the
        // scene asset cache, so destroy the sprite wrapper only.
        try { brush.destroy({ children: false, texture: false, textureSource: false }); } catch { /* no-op */ }
        try { brushHolder.destroy({ children: false }); } catch { /* no-op */ }
    });

    const handle: OrcaScratchHandle = {
        reset(): void {
            // Cancels any in-flight reveal and puts `alpha` back, so a reset
            // mid-`fade` can't leave an invisible sprite.
            stopRevealAnimation(true);
            cancelAutoScratch();
            stopDebris();
            cells.fill(0);
            markedCells = 0;
            complete = false;
            completeFired = false;
            stampCount = 0;
            lastLocalX = null;
            lastLocalY = null;
            // Pristine == unmasked + rendering. A fresh primed mask is rebuilt
            // lazily by the next stroke, so there is nothing to re-prime here
            // and a never-scratched node's reset is a genuine no-op.
            destroyMask();
            sprite.renderable = true;
            sprite.eventMode = enabled ? 'static' : 'passive';
        },
        revealAll(): void {
            cancelAutoScratch();
            revealAll();
        },
        setEnabled(next: boolean): void {
            enabled = next === true;
            // Toggle `eventMode` rather than gating in the handler so a
            // disabled panel doesn't swallow pointerdown from nodes beneath it.
            sprite.eventMode = enabled ? 'static' : 'passive';
            if (!enabled) {
                endDrag();
                stopDebris();
            }
        },
        setBrushSize(size: number): void {
            if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
                console.warn(`[FlowState/scratchableItem] setBrushSize: expected a positive number, got`, size);
                return;
            }
            // DISPLAY px, same unit as the authored `brushSize` / the Inspector
            // field. The display→local conversion happens per stamp.
            brushSize = size;
        },
        getProgress(): number {
            return getProgress();
        },
        isComplete(): boolean {
            return complete;
        },
        autoScratch(pathIndex: number, durationMs: number, revealOnFinish: boolean): Promise<void> {
            return autoScratch(pathIndex, durationMs, revealOnFinish);
        },
    };

    sprite.__orcaScratchHandle = handle;
}
