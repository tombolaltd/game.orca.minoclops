// ──────────────────────────────────────────────────────────────────────────────
// Global Pixi 6 IMG-load rejection suppression
// ──────────────────────────────────────────────────────────────────────────────
// Pixi 6's LoaderResource._onError (and the arcade-base AssetManager loader
// path) rejects a per-resource internal promise that nobody catches,
// producing spurious "Uncaught (in promise) Error: Failed to load element
// using: IMG" or an uncaught DOM `error` Event (seen as
// `Uncaught (in promise) Event` from pixi `core.js`) on any texture/asset
// that fails to load. These are NOT application errors — the loader's onError
// signal already handles them. This file is synced to existing projects via
// project-migrate.js, so this handler covers both new and existing projects.
const __isOrcaSuppressibleRejection = (reason: unknown): boolean => {
  if (!reason) return false;
  // Pixi loader's "Failed to load element using: IMG/AUDIO/VIDEO" Error.
  const message = (reason as { message?: unknown })?.message;
  if (typeof message === 'string' && message.includes('Failed to load element using:')) {
    return true;
  }
  // A genuine DOM Event reaching the rejection path.
  if (typeof Event !== 'undefined' && reason instanceof Event && reason.type === 'error') {
    return true;
  }
  // Cross-realm fallback: a DOM `error` Event raised in a different realm
  // (e.g. another window/document) may fail `instanceof Event` here. Duck-type
  // it conservatively — it must look like an error Event with a load target —
  // so we never swallow unrelated application rejections.
  if (typeof reason === 'object') {
    const ev = reason as { type?: unknown; target?: unknown };
    if (ev.type === 'error' && ev.target && typeof ev.target === 'object') {
      return true;
    }
  }
  return false;
};

const __orcaUnhandledRejectionHandler = (event: PromiseRejectionEvent): void => {
  if (__isOrcaSuppressibleRejection(event?.reason)) {
    event.preventDefault();
  }
};

// Register on both `window` and `self` so the handler is installed regardless
// of the realm the loader rejection surfaces in. In a normal renderer realm
// `self === window`, so guard against a double-registration of the same target.
const __orcaRejectionTargets = new Set<EventTarget>();
if (typeof window !== 'undefined') __orcaRejectionTargets.add(window);
if (typeof self !== 'undefined') __orcaRejectionTargets.add(self as unknown as EventTarget);
for (const target of __orcaRejectionTargets) {
  target.addEventListener('unhandledrejection', __orcaUnhandledRejectionHandler as EventListener);
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                              SCENE MANAGER                                   ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║ Singleton that builds, loads, and draws Orca scenes exported from the        ║
 * ║ Flowstate editor.                                                             ║
 * ║                                                                               ║
 * ║ Workflow:                                                                     ║
 * ║   1. Export scenes from the editor (File → Export Scene…) — each scene is    ║
 * ║      written to its own JSON file under <skin>/scene-data/.                  ║
 * ║   2. Register every JSON via buildScenes([...sceneDatas]) (or call           ║
 * ║      buildScenes() with no args to auto-load every scene-data/*.json for     ║
 * ║      the active skin).                                                        ║
 * ║   3. Call setRendererDimensions(width, height) once at boot and on every     ║
 * ║      resize so the manager can auto-snap the camera on every load.           ║
 * ║   4. Call loadScene(name | index) to construct a PIXI Container tree. The    ║
 * ║      manager will auto-call drawScene with the cached renderer dims.         ║
 * ║   5. (Optional) addChild(getDontDestroyContainer()) to the stage AFTER the   ║
 * ║      scene root so nodes flagged dontDestroyOnLoad render above the          ║
 * ║      scene by default and survive across loadScene / unloadScene calls.      ║
 * ║   6. Call unloadScene() to tear down the active scene without immediately    ║
 * ║      loading another (DDOL containers are preserved).                        ║
 * ║   7. Call drawScene(width, height) on every resize to re-apply the           ║
 * ║      camera-space viewport transform.  This exactly replicates the editor's  ║
 * ║      camera-bounds draw logic, treating the supplied width/height as the     ║
 * ║      camera output dimensions.                                                ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

// Spine 4.x only — the pixi-spine multi-runtime (3.7 / 3.8 / 4.1) selection is
// not available on Pixi 8 and the packages are uninstalled.
import {
    AtlasAttachmentLoader,
    SkeletonBinary,
    SkeletonJson,
    Spine,
    SpineTexture,
    TextureAtlas,
} from '@esotericsoftware/spine-pixi-v8';
import type { SkeletonData } from '@esotericsoftware/spine-pixi-v8';
import { AssetManager, device, eventEmitter, gameConfig, queryStringParams } from '@game-studio/arcade-base';
// NAMED, not namespace: pixi-filters v6 moved Blur/ColorMatrix/Alpha/Noise/
// Displacement into `pixi.js` core, so a by-name lookup over a namespace object
// silently yields `undefined` at runtime. Importing each constructor makes a
// missing one a COMPILE error instead.
import {
    AdjustmentFilter,
    AdvancedBloomFilter,
    AsciiFilter,
    BackdropBlurFilter,
    BevelFilter,
    BloomFilter,
    BulgePinchFilter,
    ColorGradientFilter,
    ColorMapFilter,
    ColorOverlayFilter,
    ColorReplaceFilter,
    ConvolutionFilter,
    CrossHatchFilter,
    CRTFilter,
    DotFilter,
    DropShadowFilter,
    EmbossFilter,
    GlitchFilter,
    GlowFilter,
    GodrayFilter,
    GrayscaleFilter,
    HslAdjustmentFilter,
    KawaseBlurFilter,
    MotionBlurFilter,
    MultiColorReplaceFilter,
    OldFilmFilter,
    OutlineFilter,
    PixelateFilter,
    RadialBlurFilter,
    ReflectionFilter,
    RGBSplitFilter,
    ShockwaveFilter,
    SimpleLightmapFilter,
    SimplexNoiseFilter,
    TiltShiftAxisFilter,
    TiltShiftFilter,
    TwistFilter,
    ZoomBlurFilter,
} from 'pixi-filters';
import { buildFlowstateReelsDisplay } from './components/reels';
import { attachScratchBehaviour } from './components/scratchable-item';
import type { ScratchableItemDisplay } from './components/scratchable-item';
import { ACTIVE_SKIN, ENTRY_SCENE_NAME, ENTRY_SCENE_SCOPE, PORTRAIT_CHAT_CROP } from './active-skin';
// Namespace read so an active-skin.ts generated before ENABLE_3D / SCENE3D_SHADOW_QUALITY existed still compiles.
import * as activeSkinExports from './active-skin';
import { SKIN_SCENES } from './generated-skin-scenes';
import { compileRichText, hasRichText, registerHtmlTextFont } from './rich-text';
import type { RichTextNode } from './rich-text';
import { translationMarkupToHtmlText } from './translation-markup';
// Unconditional by design: every path that copies scene-manager.ts also seeds
// generated-custom-components.ts first (the codegen ordering guard), so this
// import target always exists — even in a project with zero components.
import { customComponents } from './generated-custom-components';
import type { OrcaComponent, OrcaComponentContext } from './custom-components/orca-component';
import {
    getGameModelProperty,
    setGameModelProperty,
    getSettingsModelProperty,
    setSettingsModelProperty,
} from './methods/model';
// SOLE locale source for the LocalizationManager component — see
// `getLocalizationLocale()`. Imported directly (not via `methods/index`) so the
// module graph stays narrow, exactly as `./methods/model` above.
import { translations } from './methods/translations';
// Parity twin of the editor's `src/services/sceneParentAnchor.ts` — pure, and
// the SOLE implementation of the nine-point offset maths on this side.
import { isParentAnchorPoint, resolveAnchorOffset } from './scene-parent-anchor';
import type { AnchorRect } from './scene-parent-anchor';
import { parseAnimationChannel, type AnimationChannel } from './animation-channels';
import { applyIkHandles, normalizeIkComponent, type IkComponentLike, type IkDisplayObjectLike, type NormalizedIk } from './animation-ik';
import { prepareSkinnedMesh, updateSkinnedMesh, type PreparedSkinnedMesh } from './skinned-mesh';
import {
    advanceParallaxTravel,
    normalizeParallax,
    parallaxDrawnFrameHeight,
    placeParallaxLayer,
    type NormalizedParallax,
} from './parallax';
import {
    fitAreaChildAnchorRect,
    normalizeFitAreaMargin,
    normalizeFitAreaSettings,
    resolveFitArea,
    withoutFitAreaFields,
    type FitAreaMargin,
    type FitAreaRect,
    type FitAreaSettings,
} from './fit-area';
import {
    resolveActiveLayoutProfile,
    type LayoutProfileCondition,
    type LayoutProfileEnvironment,
    type LayoutProfilePlatform,
} from './layout-profiles';
import { OrcaParticleEmitter } from './particle-emitter';
import { resolveFlexLayoutStyle } from './scene-flex-layout';
import type { FlexLayoutValue } from './scene-flex-layout';
import { Scene3DLayer } from './scene-3d';
import type {
    OrcaScene3DData,
    OrcaScene3DNode,
    Scene3DComponentEnv,
    Scene3DComponentHost,
} from './scene-3d';

import * as Pixi from 'pixi.js';

/** Pixi 8.14: a video played before its size is known loops `_onPlayStart` ↔ `_mediaReady` until the stack overflows. */
function guardVideoSourcePlayStart(): void {
    const proto = Pixi.VideoSource.prototype as unknown as { _onPlayStart: (this: object) => void; __orcaPlayStartGuarded?: boolean };
    if (proto.__orcaPlayStartGuarded) return;
    const original = proto._onPlayStart;
    if (typeof original !== 'function') return;
    const active = new WeakSet<object>();
    proto._onPlayStart = function guardedOnPlayStart(this: object): void {
        if (active.has(this)) return;
        active.add(this);
        try {
            original.call(this);
        } finally {
            active.delete(this);
        }
    };
    proto.__orcaPlayStartGuarded = true;
}
// Before any VideoSource is built: each one binds `_onPlayStart` in its constructor.
guardVideoSourcePlayStart();

/** Project-global 3D switch, off unless explicitly true; read at call time only (import-cycle safety). */
function isScene3DEnabled(): boolean {
    return (activeSkinExports as unknown as { ENABLE_3D?: unknown }).ENABLE_3D === true;
}

/** Project 3D shadow tier, untrusted; absent in an older active-skin.ts, which the layer treats as 'medium'. */
function scene3DShadowQuality(): unknown {
    return (activeSkinExports as unknown as { SCENE3D_SHADOW_QUALITY?: unknown }).SCENE3D_SHADOW_QUALITY;
}

// Side effect: registers the LayoutSystem on every renderer created AFTER this
// module evaluates (application.ts imports it before `app.init()`).
import { LayoutSystem, getYoga } from '@pixi/layout';

/**
 * `@pixi/layout` mixes a `layout` ACCESSOR onto `Container.prototype` (setter
 * builds a Yoga `Layout` for ANY truthy value, getter returns it or `null`).
 * `@game-studio/cabinet` 5 (09-09 batch onwards) `HTPNudgeView` uses `layout`
 * as a plain `'anchored' | 'floating'` field and reads
 * `this.labelText[this.layout]`, so without this the cabinet throws
 * `Cannot read properties of undefined (reading 'split')` at construction.
 * A string is never a valid `LayoutOptions`, so string writes stay a plain
 * per-instance value; everything else still reaches the library. Such an
 * instance also gets an own `visible` accessor that hides the string from the
 * library's patched `visible` setter (installed once any flex layout exists),
 * which would otherwise call `'anchored'._onChildAdded` when the nudge
 * animates. Editor twin: `shieldStringLayoutFields` in `Pixi8Adapter.ts`.
 */
const FOREIGN_STRING_LAYOUT = Symbol.for('orca.foreignStringLayout');
const FOREIGN_LAYOUT_HIDDEN = Symbol.for('orca.foreignStringLayoutHidden');
// Must differ from the per-instance key, or every Container inherits it.
const STRING_LAYOUT_SHIELD_INSTALLED = Symbol.for('orca.stringLayoutShieldInstalled');
type OrcaStringLayoutHost = Pixi.Container & {
    [FOREIGN_STRING_LAYOUT]?: string;
    [FOREIGN_LAYOUT_HIDDEN]?: boolean;
};
function inheritedVisibleDescriptor(target: object): PropertyDescriptor | undefined {
    for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'visible');
        if (descriptor) return descriptor;
    }
    return undefined;
}
const stringLayoutVisible: PropertyDescriptor = {
    configurable: true,
    enumerable: false,
    get(this: OrcaStringLayoutHost) {
        return inheritedVisibleDescriptor(this)?.get?.call(this);
    },
    set(this: OrcaStringLayoutHost, value: boolean) {
        const setter = inheritedVisibleDescriptor(this)?.set;
        if (!setter) return;
        this[FOREIGN_LAYOUT_HIDDEN] = true;
        try {
            setter.call(this, value);
        } finally {
            this[FOREIGN_LAYOUT_HIDDEN] = false;
        }
    },
};
function shieldStringLayoutFields(): void {
    const proto = Pixi.Container.prototype as unknown as Record<PropertyKey, unknown>;
    if (proto[STRING_LAYOUT_SHIELD_INSTALLED] === true) return;
    const mixin = Object.getOwnPropertyDescriptor(proto, 'layout');
    if (!mixin || !mixin.get || !mixin.set || !mixin.configurable) return;
    const mixinGet = mixin.get;
    const mixinSet = mixin.set;
    Object.defineProperty(proto, 'layout', {
        configurable: true,
        enumerable: mixin.enumerable,
        get(this: OrcaStringLayoutHost) {
            const own = this[FOREIGN_STRING_LAYOUT];
            return own !== undefined && !this[FOREIGN_LAYOUT_HIDDEN] ? own : mixinGet.call(this);
        },
        set(this: OrcaStringLayoutHost, value: unknown) {
            if (typeof value === 'string') {
                this[FOREIGN_STRING_LAYOUT] = value;
                if (!Object.prototype.hasOwnProperty.call(this, 'visible')) {
                    Object.defineProperty(this, 'visible', stringLayoutVisible);
                }
                return;
            }
            if (this[FOREIGN_STRING_LAYOUT] !== undefined) {
                this[FOREIGN_STRING_LAYOUT] = undefined;
                if (Object.getOwnPropertyDescriptor(this, 'visible')?.get === stringLayoutVisible.get) {
                    delete (this as { visible?: boolean }).visible;
                }
            }
            mixinSet.call(this, value);
        },
    });
    proto[STRING_LAYOUT_SHIELD_INSTALLED] = true;
}
shieldStringLayoutFields();

type PixiContainer = Pixi.Container;
// Pixi 8 has no `DisplayObject`: every scene object is a `Container`.
type PixiDisplayObject = Pixi.Container;
type PixiFilter = Pixi.Filter;
type PixiGraphics = Pixi.Graphics;
type PixiTextStyle = Pixi.TextStyleOptions;
type PixiTextStyleAlign = Pixi.TextStyleAlign;
type PixiTextStyleFontStyle = Pixi.TextStyleFontStyle;
type PixiTextStyleFontWeight = Pixi.TextStyleFontWeight;
type PixiTexture = Pixi.Texture;
type OrcaResolvedDisplayObjectWrapper = PixiContainer & {
    __orcaResolvedDisplayObject?: PixiDisplayObject;
    __orcaPendingCallbacks?: Array<(obj: PixiDisplayObject) => void>;
};

/**
 * The intermediate container handed to `Spine.addSlotObject`. It exists ONLY
 * to absorb the bone transform: `Spine.updateSlotObject` REPLACES
 * position / angle / scale / alpha / visible on whatever it is given, every
 * frame. The authored node lives inside it and keeps its own transform.
 */
type OrcaSpineSlotWrapper = PixiContainer & { __orcaSpineSlotWrapper?: boolean };

/** One built parallax layer: its strip, the image it tiles, and a trimmed frame of it the layer owns. */
interface OrcaParallaxLayerView {
    sprite: Pixi.TilingSprite;
    base: PixiTexture | null;
    drawn: PixiTexture | null;
}

/** A built `parallax` node (`parallax.ts`) and how far it has scrolled, px at full speed. */
interface OrcaParallaxView {
    root: PixiContainer;
    data: NormalizedParallax;
    layers: OrcaParallaxLayerView[];
    travel: number;
}

/** Read by `components/scratchable-item.ts`, which declares the same shape itself (no shared import). */
type OrcaScratchDebrisSprite = PixiContainer & {
    __orcaScratchDebris?: { emitter: OrcaParticleEmitter; container: PixiContainer };
};

/**
 * The texture-bearing Pixi 8 classes. `NineSliceSprite` and `TilingSprite`
 * descend from `ViewContainer`, NOT from `Sprite`, so no single base type
 * covers the family — but all three expose `texture` and `anchor`.
 */
type PixiSpriteFamily = Pixi.Sprite | Pixi.NineSliceSprite | Pixi.TilingSprite;

/**
 * Pixi 8 deleted `DisplayObject`: every scene object is typed as a plain
 * `Container`, which has no `texture` / `textures` / `anchor`. Narrow through
 * here before reading any of them rather than casting the container away.
 * `AnimatedSprite extends Sprite`, so it narrows on the first branch.
 */
function asSpriteFamily(obj: unknown): PixiSpriteFamily | null {
    return obj instanceof Pixi.Sprite
        || obj instanceof Pixi.NineSliceSprite
        || obj instanceof Pixi.TilingSprite
        ? obj
        : null;
}

/**
 * Current-frame texture of any sprite-family object, else `null`. The
 * `textures[0]` fallback preserves the legacy read order for an
 * `AnimatedSprite` built before its first frame was assigned; Pixi 8 frames
 * may be bare `Texture`s or `{ texture, time }` frame objects.
 */
function readSpriteFamilyTexture(obj: unknown): PixiTexture | null {
    const sprite = asSpriteFamily(obj);
    if (sprite?.texture) return sprite.texture;
    if (obj instanceof Pixi.AnimatedSprite) {
        const first = obj.textures[0];
        if (!first) return null;
        return 'texture' in first ? first.texture : first;
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — mirror of the editor's OrcaSceneData export format
// ─────────────────────────────────────────────────────────────────────────────

export interface OrcaTransform {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
    rotation: number;
    pivotX: number;
    pivotY: number;
    skewX: number;
    skewY: number;
}

export interface OrcaRectTransform {
    anchorMinX: number;
    anchorMinY: number;
    anchorMaxX: number;
    anchorMaxY: number;
    anchoredPositionX: number;
    anchoredPositionY: number;
    sizeDeltaX: number;
    sizeDeltaY: number;
    pivotX: number;
    pivotY: number;
}

/**
 * One of the PARENT's nine anchor points. Declared here (rather than in the
 * parity twin) so `scene-parent-anchor.ts` can stay byte-identical to the
 * editor's `src/services/sceneParentAnchor.ts`; the twin's back-import is
 * `import type`, which is erased at emit and so adds no module edge.
 */
export type ParentAnchorPoint =
    | 'top-left'    | 'top-center'    | 'top-right'
    | 'middle-left' | 'middle-center' | 'middle-right'
    | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface OrcaResponsiveScaler {
    mode: string;
    referenceWidth: number;
    referenceHeight: number;
    /** `fitArea` only (`fit-area.ts`): the margins kept clear at the screen's edges. */
    margins?: unknown;
    /** `fitArea` only: `'custom'` fits `content` as the author set it; otherwise it is the node's bounds as the editor measured them. */
    contentMode?: string;
    /** `fitArea` only: the box fitted, in the node's own units. */
    content?: unknown;
    alignX?: number;
    alignY?: number;
    maxScale?: number;
}

type OrcaResponsiveScalerMode = 'fitWidth' | 'fitHeight' | 'stretch' | 'bestFit' | 'bestFitShrink' | 'fitArea';

export type OrcaCameraMode =
    | 'landscape16x9'
    | 'portrait9x16'
    | 'desktop16x9'
    | 'landscape720p'
    | 'iPhoneProLandscape'
    | 'iPhoneProPortrait'
    | 'galaxyS24Landscape'
    | 'galaxyS24Portrait'
    | 'custom';

/**
 * Per-node override emitted by a LayoutManager component for a particular
 * layout mode (portrait / landscape / desktop). Each field is a shallow
 * partial override of the matching SceneNode field.
 */
export interface OrcaLayoutEntry {
    transform?: Partial<OrcaTransform>;
    responsiveScaler?: Partial<OrcaResponsiveScaler>;
    visible?: boolean;
    alpha?: number;
}

/**
 * Mirrors the editor's LayoutManager component. The host node and every
 * descendant in its subtree may have a per-mode override keyed by node id.
 */
export interface OrcaLayoutManager {
    enabledModes: { portrait: boolean; portraitChat?: boolean; landscape: boolean; desktop: boolean };
    modes: Partial<Record<'portrait' | 'portraitChat' | 'landscape' | 'desktop', { entries: Record<string, OrcaLayoutEntry> }>>;
}

/**
 * Mirrors the editor's AdvancedLayoutManager component: ordered profiles, the
 * first enabled one whose conditions all hold on the live screen applies its
 * SPARSE entries (`layout-profiles.ts`); no match leaves the subtree authored.
 */
export interface OrcaAdvancedLayoutManager {
    profiles: Array<{
        id: string;
        name: string;
        enabled?: boolean;
        conditions: LayoutProfileCondition[];
        entries: Record<string, OrcaLayoutEntry>;
    }>;
}

export type OrcaActiveLayoutMode = 'portrait' | 'landscape' | 'desktop';

/**
 * Per-node override emitted by a LocalizationManager component for one locale.
 * Every field is optional — the editor emits the component only when at least
 * one entry is non-empty, so `undefined` is the common case.
 */
export interface OrcaLocalizationEntry {
    /** Replaces a text node's string. */
    text?: string;
    /**
     * Asset property name -> BUCKET-RELATIVE ref, BARE exactly like every other
     * scene asset ref (`3.png`, `Spine/x.png`). Only the keys in
     * {@link LOCALIZABLE_ASSET_KEYS} are honoured.
     */
    assets?: Record<string, string>;
    /** Ordered replacement for an `animatedSprite`'s baked `textures[]`. */
    frames?: string[];
}

/**
 * Mirrors the editor's LocalizationManager component. The host node and every
 * descendant in its subtree may have a per-locale override keyed by node id.
 *
 * `locales` is keyed by the project's declared translation language codes
 * (`main.orca.translations.languages[].code`) — the SAME namespace
 * `methods/translations.ts` resolves `?locale=` against.
 */
export interface OrcaLocalizationManager {
    locales: Record<string, { entries: Record<string, OrcaLocalizationEntry> }>;
}

/**
 * The node fields a localization entry's `assets` record may substitute. Keys
 * outside this set are ignored (with one warning) rather than blindly written
 * onto the node.
 */
const LOCALIZABLE_ASSET_KEYS: ReadonlySet<string> = new Set([
    'texture',
    'spritesheetPath',
    'assetPath',
    'skeleton',
    'atlas',
    'src',
]);

export interface OrcaFilterComponent {
    enabled: boolean;
    type: string;
    settings: Record<string, number | boolean | string | number[] | string[]>;
}

/** Working copy an animated node's channels write into (see `applyAnimatedValues`). */
interface OrcaAnimatedState {
    /** Authored-space scale (before any responsive-scaler ratio). */
    scale: { x: number; y: number };
    /** Authored width/height override (`0` = native size). */
    size: { width: number; height: number };
    /** True when a responsive scaler owns this node's scale. */
    responsive: boolean;
    /** Text node copy the style channels mutate, or null. */
    text: OrcaSceneNode | null;
    /** Graphics command copies the shape channels mutate, or null. */
    commands: OrcaGraphicsCommand[] | null;
}

export interface OrcaCanvasScaler {
    uiScaleMode: string;
    scaleFactor: number;
    referenceWidth: number;
    referenceHeight: number;
    matchWidthOrHeight: number;
}

export interface OrcaDropShadowOptions {
    color: number;
    blur: number;
    angle: number;
    distance: number;
    alpha: number;
}

export type OrcaGraphicsCommand = Record<string, unknown>;

/** A single colour stop in a linear gradient fill (mirrors the editor). */
export interface OrcaColorStop {
    offset: number;       // 0..1
    color: number;        // 0xRRGGBB
    alpha?: number;       // 0..1, default 1
}

/** Linear gradient fill spec (mirrors the editor). */
export interface OrcaGradientFill {
    stops: OrcaColorStop[];
    direction?: 'vertical' | 'horizontal'; // default 'vertical' (top→bottom)
}

/** Per-run rich-text style overrides (mirrors the editor RichTextRunStyle). */
export interface OrcaRichTextRunStyle {
    fill?: number;
    fillAlpha?: number;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: string | number;
    fontStyle?: string;
    underline?: boolean;
    stroke?: number;
    strokeAlpha?: number;
    strokeThickness?: number;
    letterSpacing?: number;
}

/** A contiguous run of rich text sharing one override set (mirrors the editor). */
export interface OrcaRichTextRun {
    text: string;
    style?: OrcaRichTextRunStyle;
}

export interface OrcaAssetDefinition {
    alias: string;
    src: string;
    type: string;
    tags?: string[];
}

export interface OrcaAssetBundle {
    name: string;
    assets: OrcaAssetDefinition[];
}

export interface OrcaAssetManifest {
    basePath: string;
    bundles: OrcaAssetBundle[];
}

/** One authored custom-component instance, as serialized on a scene node. */
export interface OrcaAuthoredCustomComponent {
    id: string;
    /** The component's `definition.name` — the key into `customComponents`. */
    type: string;
    enabled: boolean;
    properties: Record<string, unknown>;
    /**
     * `assetRef` property values, persisted SEPARATELY from `properties` as
     * bucket-relative path strings. EVERY value here is an asset ref by
     * construction, so the runtime detects them structurally and never
     * consults `definition.properties[].type`. The split is persistence-only:
     * these arrive at the component merged INTO `properties`, already resolved
     * to a texture.
     */
    assetProperties?: Record<string, string> | null;
}

/** One pointer-event -> custom-event mapping on an authored Button component. */
export interface OrcaButtonBinding {
    /** A pixi pointer event name, e.g. 'pointertap'. */
    pointerEvent: string;
    /** The project custom event to emit. */
    eventName: string;
}

/**
 * Button component, as serialized on a scene node.
 *
 * The editor drops unwired rows on export, but the runtime mirror is the
 * AUTHORING scene file, so everything here is still treated as untrusted.
 */
export interface OrcaAuthoredButton {
    enabled?: boolean;
    bindings?: OrcaButtonBinding[] | null;
}

/**
 * Spine slot attachment, as serialized on a scene node whose PARENT is a
 * `spine` node. Exported only when `slotName` is non-empty.
 *
 * Untrusted like every other authored component — and specifically, a STALE
 * `slotName` is deliberately preserved by the editor, so a name the skeleton
 * has no slot for WILL arrive here and must never be handed straight to
 * `Spine.addSlotObject` (its `getSlotFromRef` throws on a miss).
 */
export interface OrcaAuthoredSpineAttachment {
    enabled?: boolean;
    slotName?: string;
}

/** Lightweight scene node — mirrors the editor's OrcaSceneNode export type */
export interface OrcaSceneNode {
    id: string;
    name: string;
    type: string;
    transform: OrcaTransform;
    visible: boolean;
    alpha: number;
    zIndex: number;
    children: OrcaSceneNode[];

    // Any node type — survives loadScene / unloadScene when true. The runtime
    // reparents the flagged node (and its entire subtree) to the persistent
    // dontDestroyContainer so it persists across scene swaps.
    dontDestroyOnLoad?: boolean;

    // User-authored custom components attached to this node. Fully untrusted:
    // may be absent, null, a non-array, or carry unknown types / junk values.
    customComponents?: OrcaAuthoredCustomComponent[] | null;

    // Button component — makes the node interactive and emits a project custom
    // event per bound pointer event. Untrusted, like customComponents.
    button?: OrcaAuthoredButton | null;

    // Spine slot attachment — honoured only when this node's PARENT is a
    // `spine` node. Untrusted, like button.
    spineAttachment?: OrcaAuthoredSpineAttachment | null;

    // IK handle of a two-bone chain (`animation-ik.ts`). Untrusted, like button.
    ik?: IkComponentLike | null;

    // Flex Layout (`@pixi/layout`). Untrusted — only `resolveFlexLayoutStyle`
    // may turn it into a `container.layout` value.
    flexLayout?: { enabled?: boolean; style?: Record<string, unknown> } | null;

    // Optional components
    filters?: OrcaFilterComponent[];
    rectTransform?: OrcaRectTransform;
    // Pins the node to one of its PARENT's nine anchor points; `transform.x/y`
    // then reads as an OFFSET from that point. Untrusted (`point` is typed
    // `string` and validated by `isParentAnchorPoint`), and mutually exclusive
    // with `rectTransform`, which owns its position outright.
    parentAnchor?: { point: string } | null;
    responsiveScaler?: OrcaResponsiveScaler;
    layoutManager?: OrcaLayoutManager;
    advancedLayoutManager?: OrcaAdvancedLayoutManager;
    localizationManager?: OrcaLocalizationManager;

    // canvas
    renderMode?: string;
    scaler?: OrcaCanvasScaler;
    pixelPerfect?: boolean;

    // camera
    zoom?: number;
    frameWidth?: number;
    frameHeight?: number;
    mode?: OrcaCameraMode;
    // Absent = the renderer background is left exactly as the host set it.
    // `clear` makes the 2D canvas transparent so the `scene3d` layer shows through.
    background?: { mode?: string; color?: string } | null;

    // jackpotsModule
    // Authored landscape X offset for the jackpots panel, as a fraction
    // (0..1) of the camera/renderer width. Consumed by the gated jackpots
    // runtime helper via getJackpotsGameLeftEdge() and passed to the
    // package's positionViews(); absent ⇒ package default (trueWidth + 20).
    gameLeftEdge?: number;
    // `'fitArea'`: the panel centres between `areaMargins` (left / right,
    // each a share of the screen's width or height) instead.
    placement?: string;
    areaMargins?: { left?: unknown; right?: unknown };
    // Its restyle, while switched on: each quality's baked atlas page
    // (bucket-relative) and the fingerprint of the atlas it was baked from.
    panelStyle?: { enabled?: boolean; pages?: Record<string, unknown>; atlas?: Record<string, unknown> };

    // sprite / nineSlice / tilingSprite / animatedSprite
    texture?: string;
    // sprite — single frame of a packed multi-page `*.spritesheet.json` atlas.
    // When BOTH are present they take precedence over `texture`; either absent
    // falls back to the whole-image `texture` path (locked contract; emitted
    // verbatim by the exporter).
    spritesheetPath?: string;
    spritesheetFrame?: string;
    tint?: number;
    blendMode?: string;
    width?: number;
    height?: number;

    // ── skinnedMesh ──
    // A grid mesh whose vertices follow its bones (`skinned-mesh.ts`): the
    // grid's rest rectangle (`offsetX/Y`, `width` × `height`, `cols` × `rows`)
    // and each bone's id + bind pose with per-vertex weights. Untrusted.
    offsetX?: number;
    offsetY?: number;
    cols?: number;
    rows?: number;
    skinning?: unknown;

    // ── scratchableItem ──
    // Scratch-card panel. Renders as an ordinary sprite (reusing `texture` /
    // `spritesheetPath` / `spritesheetFrame` / `tint` / `blendMode` / `width` /
    // `height` above); the fields below drive the scratch-to-reveal behaviour
    // wired by `components/scratchable-item.ts`.
    /** Default true. When false the panel renders but ignores pointer input. */
    scratchEnabled?: boolean;
    /** Brush DIAMETER in DISPLAY px — same unit as `width`/`height`, NOT
     *  source-texture texels. Converted to the mask's local space by
     *  `components/scratchable-item.ts`. Default 60. */
    brushSize?: number;
    /** 0 = fully soft falloff .. 1 = hard edge. Default 0.5. */
    brushHardness?: number;
    /** Optional custom brush image ref (bucket-relative). Default null. */
    brushTexture?: string | null;
    /** Fraction scratched (0..1) at which the panel counts as revealed. Default 0.6. */
    revealThreshold?: number;
    /** Default true — clear the WHOLE mask once `revealThreshold` is hit. */
    autoRevealOnThreshold?: boolean;
    /** How the reveal presents: `'instant'` (default) | `'fade'` | `'dissolve'`.
     *  Unrecognised values fall back to `'instant'`. */
    autoRevealStyle?: string;
    /** Reveal animation length in MILLISECONDS. Default 400, clamped 0..10000.
     *  `<= 0` collapses any style to `'instant'`. */
    autoRevealDurationMs?: number;

    // nineSlice
    leftWidth?: number;
    topHeight?: number;
    rightWidth?: number;
    bottomHeight?: number;

    // tilingSprite
    tileScaleX?: number;
    tileScaleY?: number;
    tilePositionX?: number;
    tilePositionY?: number;

    // parallax (`parallax.ts`; also `width` / `height`). Untrusted.
    speed?: number;
    direction?: string;
    layers?: unknown;

    // animatedSprite
    textures?: string[];
    animationSpeed?: number;
    loop?: boolean;
    playing?: boolean;

    // video / videoSequencer
    src?: string;
    autoplay?: boolean;
    muted?: boolean;
    playbackRate?: number;
    videos?: Array<{ name?: string; src: string }>;
    activeIndex?: number;
    advanceOnEnd?: boolean;

    // reels
    reelCount?: number;
    rowCount?: number;
    symbolWidth?: number;
    symbolHeight?: number;
    symbolSpacingX?: number;
    symbolSpacingY?: number;
    reelSpacing?: number;
    reelSpacings?: number[];
    maskPadding?: number;
    symbols?: string[];
    symbolStaticsImage?: string;
    symbolStaticsAtlas?: string;
    symbolEntries?: Array<{ sprite: string; spineAnimation?: string; skin?: string; animatedSpriteAsset?: string; winAudio?: string }>;
    // The editor exports `'sprite'`; `'animatedSprite'` is a legacy alias
    // (treated identically at runtime). `'spine'` selects per-symbol spine skins.
    symbolMode?: 'spine' | 'sprite' | 'animatedSprite';
    sharedSpineAnimation?: string;
    showDebugCells?: boolean;
    spinProfileActions?: Array<{
        stopReel: number | number[];
        reelSpeed: number | number[] | { speed: number; overrides?: Record<number, number> };
        delay: number;
    }>;

    // text
    text?: string;
    fontFamily?: string;
    fontSize?: number;
    fill?: number;
    fillAlpha?: number;
    strokeAlpha?: number;
    fillGradient?: OrcaGradientFill;
    fontWeight?: string | number;
    fontStyle?: string;
    align?: string;
    wordWrap?: boolean;
    wordWrapWidth?: number;
    // Render `text` as translation markup (HTMLText). Rich runs take precedence.
    allowMarkup?: boolean;
    stroke?: number;
    strokeThickness?: number;
    dropShadow?: boolean;
    dropShadowOptions?: OrcaDropShadowOptions;
    letterSpacing?: number;
    lineHeight?: number;
    leading?: number;
    // Rich/multi-style runs. When present, authoritative per-run styling and
    // `text` equals the concatenation of run texts; the flat text fields above
    // are the BASE/`default` style.
    richText?: OrcaRichTextRun[];

    // graphics
    commands?: OrcaGraphicsCommand[];

    // Mask COMPONENT. Clips the node's child subtree to a vector shape OR an
    // image alpha. Valid on ANY renderable node type (every PIXI node extends
    // Container); consumed in finishNodeBuild → applyContainerMask.
    mask?: {
        source: 'shape' | 'texture';
        shape?: OrcaGraphicsCommand[];   // present when source === 'shape'
        texture?: string;               // present when source === 'texture'
        enabled: boolean;               // default true
        inverse?: boolean;              // optional; clip OUTSIDE the shape
        sourceNodeId?: string;          // optional; live-link to a DESCENDANT
                                        // scene node that drives the mask
    };

    // spine
    skeleton?: string;
    atlas?: string;
    animation?: string;
    playOnLoad?: boolean;
    skin?: string;
    timeScale?: number;

    // particles
    config?: string | Record<string, unknown>;
    autoStart?: boolean;

    // game-specific data (from customProperties)
    gameData?: Record<string, unknown>;
}

/** Origin scope of a loaded scene — used for sandbox enforcement. */
export type SceneOrigin = 'core' | 'skin';

/** Top-level scene file as exported by the editor */
export interface OrcaSceneData {
    version: string;
    name: string;
    pixiVersion: string;
    viewport: { width: number; height: number };
    backgroundColor: number;
    nodes: OrcaSceneNode[];
    assets: OrcaAssetManifest;
    /** Optional three.js section, drawn beneath the 2D scene when the camera background is `clear`. */
    scene3d?: OrcaScene3DData;
    /**
     * Set at load time by `loadScenesFromSceneDataFolder` based on which
     * webpack context the file came from. Not present on disk.
     */
    origin?: SceneOrigin;
}

// ─────────────────────────────────────────────────────────────────────────────
// SceneManager
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_FRAME_WIDTH = 1920;
const DEFAULT_FRAME_HEIGHT = 1080;
const DEG_TO_RAD = Math.PI / 180;

/** True when the chat-band crop (`ratio` = gameAreaHeight / width, null = off) picks the landscape bucket: band W × min(H, W×ratio) wider than tall; editor parity twin. */
export function isChatBandLandscape(frameWidth: number, frameHeight: number, ratio: number | null): boolean {
    if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return false;
    return frameWidth > Math.min(frameHeight, frameWidth * ratio);
}

/** Camera frame for the chat-band crop: landscape band max(W,H) × that×ratio centred on the camera, else top-anchored W × min(H, W×ratio); editor parity twin. */
export function resolveChatBandFrame(
    frameWidth: number,
    frameHeight: number,
    centerX: number,
    centerY: number,
    ratio: number | null,
): { width: number; height: number; centerX: number; centerY: number } {
    if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) {
        return { width: frameWidth, height: frameHeight, centerX, centerY };
    }
    if (isChatBandLandscape(frameWidth, frameHeight, ratio)) {
        const width = Math.max(frameWidth, frameHeight);
        return { width, height: width * ratio, centerX, centerY };
    }
    const height = Math.min(frameHeight, frameWidth * ratio);
    return { width: frameWidth, height, centerX, centerY: centerY - (frameHeight / 2) + (height / 2) };
}

/** LayoutManager bucket for a chat-band crop: 'landscape' exactly when `isChatBandLandscape`; editor parity twin. */
export function resolveChatBandLayoutMode(
    frameWidth: number,
    frameHeight: number,
    ratio: number | null,
    activeMode: OrcaActiveLayoutMode,
): OrcaActiveLayoutMode {
    return isChatBandLandscape(frameWidth, frameHeight, ratio) ? 'landscape' : activeMode;
}

/** Mount placeholders whose display transform is owned by counterScaleSystemMounts. */
const SYSTEM_MOUNT_NODE_TYPES = new Set(['cabinet', 'jackpotsModule', 'chatOverlay']);

/**
 * What the LayoutManager pass last wrote to a display object's `visible` /
 * `alpha`, plus whether the runtime has since claimed that property. `null`
 * means "not asserted yet"; a `*Released` flag is permanent for the life of
 * the display object.
 */
interface LayoutAssertionRecord {
    visible: boolean | null;
    alpha: number | null;
    visibleReleased: boolean;
    alphaReleased: boolean;
}

/**
 * The absolute parent-local position the parent-anchor pass last wrote for a
 * display object.
 *
 * Unlike `visible` / `alpha`, `transform` is deliberately NOT release-tracked
 * (AGENTS.md rule 18) — so the anchor pass instead writes ONLY when the
 * resolved target actually changes. A repeat draw at an unchanged frame writes
 * nothing, which is what keeps a flow-driven `setNodePosition` or position
 * tween on an anchored node running undisturbed.
 */
interface ParentAnchorWriteRecord {
    x: number;
    y: number;
}

/**
 * The auto-seeded system singletons every scene carries. A scene whose ROOT
 * holds nothing else has no authored content at all: these four are the only
 * singletons, they are always root-level, and none of them can host children
 * (the jackpots `Panel Frame` / `Panel Anchor` pair lives under
 * `jackpotsModule`), so a root-level test is exact and needs no tree walk.
 */
const SYSTEM_SINGLETON_NODE_TYPES: ReadonlySet<string> = new Set([
    'camera',
    'cabinet',
    'jackpotsModule',
    'chatOverlay',
]);

const IDENTITY_TRANSFORM: OrcaTransform = {
    x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 0, pivotY: 0, skewX: 0, skewY: 0,
};

/**
 * Node types built as a plain `PIXI.Sprite` off the SAME texture branch
 * (frame-qualified atlas frame when both spritesheet fields are set, else the
 * whole-image `texture`). Every pass that reasons about that branch — most
 * importantly the `preloadSceneSpritesheetFrames` work list — MUST key off
 * this set rather than testing a single type literal, or a new member is
 * silently skipped by the preload and renders nothing.
 */
const SPRITE_FAMILY_TEXTURE_TYPES: ReadonlySet<string> = new Set(['sprite', 'scratchableItem']);

/**
 * Node types whose whole-image `texture` is resolved synchronously during the
 * build, and so must be preloaded by `collectSceneStaticTexturePaths`.
 */
const STATIC_TEXTURE_NODE_TYPES: ReadonlySet<string> = new Set([
    'sprite',
    'scratchableItem',
    'nineSlice',
    'tilingSprite',
]);

/**
 * Node types that honour an explicit authored `width` / `height` as their BASE
 * display size (AGENTS.md rule 18 — the runtime half of the contract the editor
 * implements in `Pixi8Adapter.applySpriteFamilySizeOverride`).
 *
 * DELIBERATELY WIDER than `SPRITE_FAMILY_TEXTURE_TYPES`: that set enumerates the
 * shared *texture-resolution* branch (`sprite` / `scratchableItem` only), while
 * the *size* contract also covers `animatedSprite` / `nineSlice` / `tilingSprite`.
 * Keep the two separate — overloading either one silently changes the other's
 * pass.
 */
const SPRITE_FAMILY_SIZE_TYPES: ReadonlySet<string> = new Set([
    'sprite',
    'scratchableItem',
    'animatedSprite',
    'nineSlice',
    'tilingSprite',
]);

/**
 * Node types whose resolved RectTransform rect is written as a real display
 * SIZE rather than being emulated with a content scale. Mirrors the editor's
 * `Pixi8Adapter.applyRectSizeOverrides` switch EXACTLY.
 *
 * DELIBERATELY NOT `SPRITE_FAMILY_SIZE_TYPES`: that set omits `video` /
 * `videoSequencer`, which would silently send those two down the content-scale
 * branch and diverge from the editor.
 */
const RECT_SIZE_OVERRIDE_TYPES: ReadonlySet<string> = new Set([
    'sprite',
    'scratchableItem',
    'animatedSprite',
    'nineSlice',
    'tilingSprite',
    'video',
    'videoSequencer',
]);

/**
 * Size-overridden types whose PIVOT is expressed through `sprite.anchor`
 * rather than `pivot`. Mirrors the editor's `canUseAnchorPivot` test — the
 * geometry-sized and video types are excluded there and must stay excluded.
 */
const RECT_ANCHOR_PIVOT_TYPES: ReadonlySet<string> = new Set([
    'sprite',
    'scratchableItem',
    'animatedSprite',
]);

/**
 * Node types that never take the rect-layout branch. A `canvas` always carries
 * a `rectTransform` that is deliberately never consumed (it takes the canvas
 * branch), and the three system mounts plus the camera have their display
 * transform owned by `counterScaleSystemMounts` / `drawScene`.
 */
const RECT_LAYOUT_EXCLUDED_TYPES: ReadonlySet<string> = new Set([
    'canvas',
    'camera',
    'cabinet',
    'jackpotsModule',
    'chatOverlay',
]);

/** Mirrors the editor's `DEFAULT_RECT_TRANSFORM` (src/types/scene.ts). */
const DEFAULT_RECT_TRANSFORM: OrcaRectTransform = {
    anchorMinX: 0.5,
    anchorMinY: 0.5,
    anchorMaxX: 0.5,
    anchorMaxY: 0.5,
    anchoredPositionX: 0,
    anchoredPositionY: 0,
    sizeDeltaX: 100,
    sizeDeltaY: 100,
    pivotX: 0.5,
    pivotY: 0.5,
};

/** Parent box a rect-laid-out child anchors against, in parent-local units. */
interface RectLayoutBox {
    width: number;
    height: number;
}


type FilterCtor = new (...args: any[]) => PixiFilter;

/**
 * Every filter the runtime can build, keyed by the EXACT name string the
 * editor persists into `.reef` scene data (`FilterComponent.type`).
 *
 * Explicit rather than reflective: Pixi 8 split the filter surface across TWO
 * modules — Blur/ColorMatrix/Alpha/Noise/Displacement live in `pixi.js` core
 * and pixi-filters v6 no longer exports them — so enumerating one namespace
 * misses half the catalogue and produces a silent no-op instead of a compile
 * error. Named imports make an absent constructor fail the build.
 *
 * KNOWN DIVERGENCE from the editor's picker (pixi-filters v4 + pixi.js-legacy
 * v6): `FXAAFilter`, `TiltShiftXFilter` and `TiltShiftYFilter` exist there and
 * in NEITHER runtime module, so a scene authored with one resolves to null and
 * warns by name (see createFilterInstance).
 */
const FILTER_CTORS: Record<string, FilterCtor> = {
    // pixi.js 8 core
    AlphaFilter: Pixi.AlphaFilter,
    BlurFilter: Pixi.BlurFilter,
    ColorMatrixFilter: Pixi.ColorMatrixFilter,
    DisplacementFilter: Pixi.DisplacementFilter,
    NoiseFilter: Pixi.NoiseFilter,
    // pixi-filters 6
    AdjustmentFilter,
    AdvancedBloomFilter,
    AsciiFilter,
    BackdropBlurFilter,
    BevelFilter,
    BloomFilter,
    BulgePinchFilter,
    ColorGradientFilter,
    ColorMapFilter,
    ColorOverlayFilter,
    ColorReplaceFilter,
    ConvolutionFilter,
    CrossHatchFilter,
    CRTFilter,
    DotFilter,
    DropShadowFilter,
    EmbossFilter,
    GlitchFilter,
    GlowFilter,
    GodrayFilter,
    GrayscaleFilter,
    HslAdjustmentFilter,
    KawaseBlurFilter,
    MotionBlurFilter,
    MultiColorReplaceFilter,
    OldFilmFilter,
    OutlineFilter,
    PixelateFilter,
    RadialBlurFilter,
    ReflectionFilter,
    RGBSplitFilter,
    ShockwaveFilter,
    SimpleLightmapFilter,
    SimplexNoiseFilter,
    TiltShiftAxisFilter,
    TiltShiftFilter,
    TwistFilter,
    ZoomBlurFilter,
};

type SpineLoadSpec = { key: string; skeletonPath: string; atlasPath?: string };
type SpriteDescriptorCacheEntry = { texturePath: string | null; warned?: boolean };

/**
 * Draw-order bookkeeping for objects a custom component adds to its host
 * node's container. One tracker per host, shared by every component on it.
 */
type OrcaInjectedChildTracker = {
    host: PixiContainer;
    /**
     * Everything already accounted for: the node's authored children and its
     * snapshot mask (both present before any component ran), plus every
     * injected object already stamped.
     */
    known: Set<PixiDisplayObject>;
    /** `host.children.length` at the last stamp — the sweep's change detector. */
    childCount: number;
    /** zIndex for the next injected object; starts above every authored child. */
    nextZIndex: number;
};

/**
 * One live custom-component instance plus the bookkeeping needed to tear it
 * down cleanly (auto-`off` of every subscription it opened via `orca.on`).
 */
type OrcaComponentRegistration = {
    instance: OrcaComponent;
    /** A THREE Object3D on a 3D host. */
    displayObject: PixiDisplayObject;
    node: OrcaSceneNode | OrcaScene3DNode;
    componentType: string;
    subscriptions: Array<{ eventName: string; handler: (payload?: any) => void }>;
    /** True when the owning node is dontDestroyOnLoad — survives scene swaps. */
    ddol: boolean;
    tornDown: boolean;
    /** Null when the host cannot hold children. Shared with the node's other components. */
    injectedChildren: OrcaInjectedChildTracker | null;
};

/** How one host kind (a 2D display object or a 3D Object3D) differs for its components. */
type OrcaComponentHostOptions = {
    host: '2d' | '3d';
    ddol: boolean;
    injectedChildren: OrcaInjectedChildTracker | null;
    /** A non-empty `assetRef` path → its runtime value (a texture in 2D, a URL string in 3D). */
    resolveAsset: (rawPath: string) => unknown;
    /** 3D only: adds `three` + `getObject3DById` to the context. */
    three?: Scene3DComponentEnv;
};

class SceneManager {
    // Composite-key map: '<origin>:<name>' (e.g. 'core:main', 'skin:main').
    // This is the canonical store — every (scope, name) pair is unique.
    private scenesByKey: Map<string, OrcaSceneData> = new Map();
    // Bare-name map for legacy callers that don't pass a scope (e.g. flow
    // graphs authored before SceneRef.scope was plumbed through). When a
    // skin scene and a core scene share a name, the **skin** scene wins
    // here — skins overlay core in the active-skin model.
    private scenesByName: Map<string, OrcaSceneData> = new Map();
    private scenesByIndex: OrcaSceneData[] = [];

    private currentScene: OrcaSceneData | null = null;
    private currentContainer: PixiContainer | null = null;
    private nodeDisplayObjects: Map<string, PixiDisplayObject> = new Map();
    // Node ids that carried a LayoutManager override on the PREVIOUS draw, so a
    // mode switch can un-stick the ones the new mode no longer overrides.
    private previousLayoutOverrideIds: Set<string> = new Set();
    // Per-display-object bookkeeping for the LayoutManager's visible/alpha
    // writes. Weak so a torn-down scene's entries go with its display objects.
    private layoutAssertions: WeakMap<PixiDisplayObject, LayoutAssertionRecord> = new WeakMap();
    // What the parent-anchor pass last wrote. Weak for the same reason — but
    // note a DDOL object OUTLIVES its scene, which is why both build paths
    // explicitly reset it (a stale entry would suppress the first write into
    // the new scene).
    private parentAnchorWrites: WeakMap<PixiDisplayObject, ParentAnchorWriteRecord> = new WeakMap();
    /** Authored node data of every built node — the animation channel appliers read it. */
    private nodeDataById: Map<string, OrcaSceneNode> = new Map();

    /** Nodes carrying an `ik` component in the current tree (DDOL survivors re-add themselves on rebind). */
    private ikHandleIds: Set<string> = new Set();

    /** Keyed IK strength (`@ik.mix`) by node id — overrides the authored `mix` while a clip drives it. */
    private ikMixById: Map<string, number> = new Map();

    /** `skinnedMesh` nodes in the current tree (DDOL survivors re-add themselves on rebind). */
    private skinnedMeshIds: Set<string> = new Set();

    /** Each skinned mesh's prepared grid + weights, keyed by its display object. */
    private skinnedMeshPrepared: WeakMap<PixiDisplayObject, PreparedSkinnedMesh> = new WeakMap();

    /** Built parallax backgrounds; a destroyed one is dropped on the next tick, a DDOL survivor keeps scrolling. */
    private parallaxViews: Set<OrcaParallaxView> = new Set();
    private afterDrawHooks: Set<() => void> = new Set();
    // Tracks canvas-baked linear-gradient fill textures per Graphics object so
    // they can be destroyed on rebuild / teardown (avoids GPU texture leaks).
    private graphicsGradientTextures: WeakMap<any, PixiTexture[]> = new WeakMap();
    private activeSceneSpines: Set<Spine> = new Set();
    // Live particle emitters, ticked by update(). An emitter leaves the set when
    // its node container is destroyed; DDOL containers are reparented, not
    // destroyed, so their emitters keep running across scene swaps.
    private activeParticleEmitters: Set<OrcaParticleEmitter> = new Set();

    // Every live custom-component instance (the teardown registry). DDOL
    // instances stay in here across scene swaps; non-DDOL ones are removed by
    // their display object's `destroyed` handler.
    private activeSceneComponents: Set<OrcaComponentRegistration> = new Set();
    // The subset of the above that receives onUpdate every frame. Mirrors the
    // activeSceneSpines / trackSpineForUpdates pair; kept separate so a
    // component that throws can be dropped from the ticker while staying alive
    // for teardown.
    private componentUpdateQueue: Set<OrcaComponentRegistration> = new Set();
    // '<host>:<type>' pairs already warned about a target mismatch.
    private warnedComponentTargets: Set<string> = new Set();

    /**
     * Resolve a scene-node UUID (as authored in the editor) to its live
     * Pixi DisplayObject, if the node currently exists in the loaded
     * scene tree (or the persistent DDOL container).
     *
     * Returns `undefined` when the node has not been built (e.g. its
     * scene is not loaded) — callers must handle this gracefully.
     *
     * Used by FlowState method modules and pixi-event auto-registration
     * to dispatch actions onto the correct on-stage object.
     */
    public getDisplayObjectById(nodeId: string): PixiDisplayObject | undefined {
        const direct = this.nodeDisplayObjects.get(nodeId);
        if (direct || typeof nodeId !== 'string') return direct;
        // `<nodeId>::<key>` names a PART of a built node (a reels cell, or the
        // text on it), resolved live by that node's display object.
        const split = nodeId.indexOf('::');
        if (split <= 0) return undefined;
        const owner = this.nodeDisplayObjects.get(nodeId.slice(0, split)) as
            (PixiDisplayObject & { __orcaResolveSubNode?: (key: string) => PixiDisplayObject | undefined }) | undefined;
        const resolveSubNode = owner?.__orcaResolveSubNode;
        return typeof resolveSubNode === 'function' ? resolveSubNode(nodeId.slice(split + 2)) : undefined;
    }

    /** Authored node data of a built node, keyed like {@link getDisplayObjectById}. */
    public getNodeDataById(nodeId: string): OrcaSceneNode | undefined {
        return this.nodeDataById.get(nodeId);
    }

    /**
     * Run `fn` after every `drawScene` (resize / orientation / scene load), once
     * the layout passes have re-posed the tree. The animation player uses it to
     * re-assert the channels a running clip owns. Returns an unsubscribe.
     */
    public onAfterDraw(fn: () => void): () => void {
        this.afterDrawHooks.add(fn);
        return () => { this.afterDrawHooks.delete(fn); };
    }

    private runAfterDrawHooks(): void {
        for (const hook of Array.from(this.afterDrawHooks)) {
            try { hook(); } catch (err) { console.warn('[SceneManager] after-draw hook threw', err); }
        }
    }

    /**
     * Apply sampled Animation Timeline channel values to a built node with the
     * SAME authored semantics the editor preview uses (`animation-channels.ts`):
     * x/y stay OFFSETS from a parent anchor, scale composes with a responsive
     * scaler and an authored width/height, rotation is radians, text / graphics /
     * filter channels rebuild just that sub-object, and filter channels address
     * the AUTHORED stack index (disabled filters are built but passed through).
     * Never throws; an inapplicable channel is skipped.
     */
    public applyAnimatedValues(
        nodeId: string,
        writes: ReadonlyArray<{ property: string; value: number | boolean }>,
    ): void {
        const obj = this.nodeDisplayObjects.get(nodeId);
        if (!obj || (obj as { destroyed?: boolean }).destroyed) return;
        const node = this.nodeDataById.get(nodeId);
        const state = this.animatedStateFor(obj, node);
        let restyleText = false;
        let redrawGraphics = false;
        let resize = false;

        for (const { property, value } of writes) {
            const channel = parseAnimationChannel(property);
            try {
                switch (channel.kind) {
                    case 'transform':
                        if (this.applyAnimatedTransform(obj, state, channel, Number(value))) resize = true;
                        break;
                    case 'display':
                        if (channel.field === 'alpha') obj.alpha = Number(value);
                        else if (channel.field === 'visible') obj.visible = value === true;
                        else if (channel.field === 'tint') (obj as { tint?: number }).tint = Number(value);
                        else {
                            state.size[channel.field] = Number(value);
                            resize = true;
                        }
                        break;
                    case 'field':
                        this.applyAnimatedField(obj, channel.field, Number(value));
                        break;
                    case 'text':
                        if (state.text) {
                            this.writePath(state.text, channel.path, value);
                            restyleText = true;
                        }
                        break;
                    case 'graphics':
                        if (state.commands?.[channel.index]) {
                            (state.commands[channel.index] as Record<string, unknown>)[channel.field] = value;
                            redrawGraphics = true;
                        }
                        break;
                    case 'filter': {
                        const filter = (obj as { __orcaFiltersByIndex?: Map<number, PixiFilter> }).__orcaFiltersByIndex?.get(channel.index);
                        if (!filter) break;
                        if (channel.key === 'enabled') filter.enabled = value !== false;
                        else this.writeFilterSetting(filter, channel.key, value);
                        break;
                    }
                    case 'frame':
                        if (obj instanceof Pixi.AnimatedSprite && obj.totalFrames > 0) {
                            obj.gotoAndStop(Math.max(0, Math.min(obj.totalFrames - 1, Math.floor(Number(value) || 0))));
                        }
                        break;
                    case 'ik': {
                        const mix = Number(value);
                        if (Number.isFinite(mix)) this.ikMixById.set(nodeId, Math.min(1, Math.max(0, mix)));
                        break;
                    }
                    case 'state':
                        // `@skeleton.state` switches animations in the player; it writes nothing here.
                        break;
                    default:
                        this.writePath(obj, property.split('.'), value);
                        break;
                }
            } catch (err) {
                console.warn(`[SceneManager] Animated channel "${property}" failed`, err);
            }
        }

        if (resize && node && !state.responsive) {
            const sizedNode = { ...node, width: state.size.width, height: state.size.height } as OrcaSceneNode;
            this.applySpriteFamilySizeOverride(obj, sizedNode, state.scale.x, state.scale.y);
        }
        if (restyleText && state.text && obj instanceof Pixi.Text) {
            const style = this.buildTextStyle(state.text);
            // Keep the family the async font load already resolved.
            style.fontFamily = obj.style.fontFamily;
            obj.style = style;
        }
        if (redrawGraphics && state.commands && obj instanceof Pixi.Graphics) {
            obj.clear();
            this.applyGraphicsCommands(obj, state.commands);
        }
    }

    /** Per-object animated working copy, seeded from the authored node on first use. */
    private animatedStateFor(obj: PixiDisplayObject, node: OrcaSceneNode | undefined): OrcaAnimatedState {
        const tagged = obj as { __orcaAnimatedState?: OrcaAnimatedState };
        if (tagged.__orcaAnimatedState) return tagged.__orcaAnimatedState;
        const ratio = (obj as { __orcaResponsiveRatio?: { x: number; y: number } }).__orcaResponsiveRatio;
        const state: OrcaAnimatedState = {
            scale: { x: node?.transform?.scaleX ?? obj.scale.x, y: node?.transform?.scaleY ?? obj.scale.y },
            size: { width: this.readSizeOverride(node?.width), height: this.readSizeOverride(node?.height) },
            responsive: !!ratio,
            text: node?.type === 'text'
                ? { ...node, dropShadowOptions: node.dropShadowOptions ? { ...node.dropShadowOptions } : undefined } as OrcaSceneNode
                : null,
            commands: node?.type === 'graphics' && Array.isArray(node.commands)
                ? node.commands.map((cmd) => ({ ...cmd }))
                : null,
        };
        tagged.__orcaAnimatedState = state;
        return state;
    }

    /** Returns true when the sprite-family size override must be re-asserted. */
    private applyAnimatedTransform(
        obj: PixiDisplayObject,
        state: OrcaAnimatedState,
        channel: Extract<AnimationChannel, { kind: 'transform' }>,
        value: number,
    ): boolean {
        if (!Number.isFinite(value)) return false;
        // A node fitted to an area is placed and sized by the fit (the editor previews alike).
        if ((obj as { __orcaFitPlaced?: boolean }).__orcaFitPlaced
            && (channel.field === 'x' || channel.field === 'y' || channel.field === 'scaleX' || channel.field === 'scaleY')) {
            return false;
        }
        const ratio = (obj as { __orcaResponsiveRatio?: { x: number; y: number } }).__orcaResponsiveRatio;
        const offset = (obj as { __orcaAnchorOffset?: { x: number; y: number } }).__orcaAnchorOffset;
        switch (channel.field) {
            case 'x':
                obj.position.x = value + (offset?.x ?? 0);
                return false;
            case 'y':
                obj.position.y = value + (offset?.y ?? 0);
                return false;
            case 'scaleX':
                state.scale.x = value;
                obj.scale.x = value * (ratio?.x ?? 1);
                return true;
            case 'scaleY':
                state.scale.y = value;
                obj.scale.y = value * (ratio?.y ?? 1);
                return true;
            case 'rotation':
                obj.rotation = value;
                return false;
            case 'skewX':
                obj.skew.x = value;
                return false;
            case 'skewY':
                obj.skew.y = value;
                return false;
            case 'pivotX':
            case 'pivotY': {
                const anchor = (obj as { anchor?: { x: number; y: number } }).anchor;
                const axis = channel.field === 'pivotX' ? 'x' : 'y';
                if (anchor && typeof anchor === 'object') anchor[axis] = Math.min(1, Math.max(0, value));
                else obj.pivot[axis] = value;
                return false;
            }
            default:
                return false;
        }
    }

    private applyAnimatedField(obj: PixiDisplayObject, field: string, value: number): void {
        if (!Number.isFinite(value)) return;
        switch (field) {
            case 'animationSpeed':
                if (obj instanceof Pixi.AnimatedSprite) obj.animationSpeed = value;
                return;
            case 'tilePositionX':
            case 'tilePositionY':
            case 'tileScaleX':
            case 'tileScaleY': {
                if (!(obj instanceof Pixi.TilingSprite)) return;
                const target = field.startsWith('tilePosition') ? obj.tilePosition : obj.tileScale;
                if (field.endsWith('X')) target.x = value;
                else target.y = value;
                return;
            }
            case 'leftWidth':
            case 'topHeight':
            case 'rightWidth':
            case 'bottomHeight':
                if (obj instanceof Pixi.NineSliceSprite) obj[field] = Math.max(0, value);
                return;
            case 'timeScale': {
                const spine = obj as { state?: { timeScale: number } };
                if (spine.state && typeof spine.state.timeScale === 'number') spine.state.timeScale = Math.max(0, value);
                return;
            }
            case 'playbackRate': {
                const resource = (obj as Pixi.Sprite).texture?.source?.resource as unknown;
                if (typeof HTMLVideoElement !== 'undefined' && resource instanceof HTMLVideoElement && value > 0) {
                    resource.playbackRate = value;
                }
                return;
            }
            default:
                return;
        }
    }

    /** Accessor-first, uniform-second filter write without the per-frame diagnostic. */
    private writeFilterSetting(filter: PixiFilter, key: string, value: number | boolean): void {
        if (this.hasWritableFilterProperty(filter, key)) {
            try {
                (filter as unknown as Record<string, unknown>)[key] = value;
                return;
            } catch {
                // Fall through to the uniform.
            }
        }
        const uniforms = (filter as unknown as { uniforms?: Record<string, unknown> }).uniforms;
        const uniformKey = uniforms ? this.resolveFilterUniformKey(uniforms, key) : null;
        if (uniforms && uniformKey) {
            try { uniforms[uniformKey] = value; } catch { /* ignored */ }
        }
    }

    /** Write a nested value, never creating intermediate hops. */
    private writePath(target: unknown, path: ReadonlyArray<string | number>, value: unknown): void {
        let cursor = target as Record<string | number, unknown> | null;
        for (let i = 0; i < path.length - 1; i += 1) {
            const next = cursor?.[path[i]];
            if (!next || typeof next !== 'object') return;
            cursor = next as Record<string | number, unknown>;
        }
        if (cursor && path.length > 0) cursor[path[path.length - 1]] = value;
    }

    /**
     * Snapshot of every live `[nodeId, displayObject]` pair. Used by the
     * pixi-event auto-registration sweep to attach pointer listeners to
     * every starter target in one pass after `loadScene`.
     */
    public getAllDisplayObjects(): IterableIterator<[string, PixiDisplayObject]> {
        return this.nodeDisplayObjects.entries();
    }

    // DDOL state — see getDontDestroyContainer() / unloadScene() / loadScene()
    private dontDestroyContainer: PixiContainer | null = null;
    private dontDestroyByKey: Map<string, PixiContainer> = new Map();
    private ddolKeysBoundThisLoad: Set<string> = new Set();
    // Once-only: DDOL is not honoured inside a Spine slot attachment.
    private warnedSpineSlotDdol = false;

    // Cached renderer dimensions so loadScene can auto-snap the camera even
    // when invoked from a flow with no viewport context. Host should set
    // these via setRendererDimensions() at boot and on every resize.
    private lastRendererWidth = 0;
    private lastRendererHeight = 0;

    // Coalesces the late-texture rect re-layout: many lazily-loaded textures
    // resolve in the same tick and each would otherwise force a full draw.
    private rectLayoutRefreshQueued = false;

    // Optional pixi parent that scene roots are mounted onto automatically
    // by loadScene(). Registered once at boot via setHostStage(). When null,
    // loadScene() returns the new container but does NOT attach it — the
    // caller is responsible for parenting it.
    private hostStage: PixiContainer | null = null;

    // Live pixi renderer, registered once at boot via setHostRenderer().
    // Needed by node types that draw into a RenderTexture at build time (the
    // `scratchableItem` dynamic mask). When null those nodes degrade to their
    // plain visual form with a single warn — never a throw.
    private hostRenderer: any | null = null;

    // Created on first use (keeps imported bindings out of construction time).
    private scene3dLayer: Scene3DLayer | null = null;
    private scene3dDisabledNoticeShown = false;
    // The host's renderer background RGBA, captured before a camera `background` first overrides it.
    private savedRendererBackground: number[] | null = null;

    // Flex Layout fallback for a host renderer created BEFORE `@pixi/layout`
    // registered its system: Yoga is loaded here instead, layouts built
    // meanwhile are parked, and `update()` drives the pass itself.
    private pendingFlexLayouts: Array<{ target: PixiContainer; style: Record<string, FlexLayoutValue> }> = [];
    private flexLayoutFallbackInit: Promise<void> | null = null;
    private flexLayoutFallback: LayoutSystem | null = null;

    // System-singleton mount targets for the currently loaded scene. These
    // are the placeholder PIXI.Containers built from `cabinet`,
    // `jackpotsModule`, and `chatOverlay` scene-graph nodes. Their position
    // among root-level scene siblings reflects the user-authored draw order
    // in the editor — content authored AFTER (later sibling) renders ON TOP
    // because of pixi's later-sibling-on-top rule. attachCabinet() etc.
    // reparent externally-constructed views into these placeholders so the
    // authored order applies in-game.
    private cabinetMountTarget: PixiContainer | null = null;
    private jackpotsMountTarget: PixiContainer | null = null;
    private chatOverlayMountTarget: PixiContainer | null = null;

    // Last-attached external views, cached so they automatically re-bind
    // into each new scene's mount targets across loadScene / unloadScene.
    // The host typically calls attachCabinet(...) once at boot, before the
    // first loadScene; subsequent reloads rebind without further host work.
    private attachedCabinet: PixiContainer | null = null;
    private attachedJackpots: PixiContainer | null = null;
    private attachedChatOverlay: PixiContainer | null = null;

    private filterRegistryInitialized = false;
    private filterCtorByType: Map<string, FilterCtor> = new Map();
    private normalizedFilterTypeMap: Map<string, string> = new Map();
    private sceneAssetsByAlias: Map<string, OrcaAssetDefinition> = new Map();
    private sceneAssetsByPath: Map<string, OrcaAssetDefinition> = new Map();
    private sceneSpineDataCache: Map<string, unknown> = new Map();
    private sceneSpineLoadPromises: Map<string, Promise<{ spineData: unknown; resolvedKey: string }>> = new Map();
    private sceneFontFamilyCache: Map<string, string> = new Map();
    private sceneFontLoadPromises: Map<string, Promise<string>> = new Map();
    /** The URL each scene font file loaded from (normalized ref → URL). */
    private sceneFontUrls: Map<string, string> = new Map();
    private spriteDescriptorTextureCache: Map<string, SpriteDescriptorCacheEntry> = new Map();
    // Frame textures parsed from multi-page `*.spritesheet.json` descriptors,
    // keyed by SCOPE-QUALIFIED descriptor path → (frameName → Texture). A core
    // sheet and an active-skin sheet sharing a basename therefore resolve to
    // DISTINCT frame textures. Populated by `preloadSceneSpritesheetFrames`
    // ahead of the synchronous frame-qualified sprite-node build.
    private spritesheetFrameTextureCache: Map<string, Map<string, PixiTexture>> = new Map();
    // Every SCOPE-QUALIFIED alias this manager has registered with `Assets`
    // (`core/3.png`, `skins/<skin>/Spine/x.atlas`, …). Pixi 8's `Cache` has no
    // public key enumeration — where Pixi 6 let `invalidateAndReloadCurrentScene`
    // walk `PIXI.utils.TextureCache` / `Loader.shared.resources`, eviction is now
    // driven by this ledger, which is scope-qualified by construction.
    private registeredAssetAliases: Set<string> = new Set();
    private unavailableSceneTexturePaths: Set<string> = new Set();
    // Bumped by `invalidateAndReloadCurrentScene` so freshly re-baked assets
    // bypass the browser HTTP/disk cache when the URL itself hasn't changed.
    // Appended as `?v=<n>` to fetch URLs returned by `toAbsoluteSceneAssetUrl`.
    // Stays at 0 in steady-state so initial loads don't carry a query.
    private assetCacheBust: number = 0;

    // SCOPE of the scene currently being built by `buildSceneContainer`.
    // Read SYNCHRONOUSLY by the texture / sprite-descriptor / video / spine
    // resolvers so a BARE asset ref (e.g. `3.png`, `3.sprite.json`) resolves
    // from the OWNING scene's bucket — `core` vs `skins/<ACTIVE_SKIN>` — and a
    // core `3.png` can never shadow (or be shadowed by) an active-skin `3.png`
    // that shares a basename. Scenes are built synchronously inside
    // `buildSceneContainer`, so this field is keyed to the scene being BUILT
    // (NOT `currentScene`, whose timing is unreliable across DDOL / nested
    // cases). The async Spine fallback captures this value at build time and
    // threads it explicitly, since it resolves URLs after the build returns.
    private activeBuildOrigin: SceneOrigin = 'core';

    // Node id -> the ACTIVE locale's LocalizationManager entry, for the scene
    // currently being walked. Stamped ONCE per scene by
    // `beginSceneLocalization` (preload collection + `buildSceneContainer`),
    // read synchronously by `localizeNode`, cleared on teardown.
    //
    // Deliberately NOT the LayoutManager's per-draw pattern: that one re-runs
    // on every `drawScene` and carries `previousLayoutOverrideIds` because
    // ORIENTATION changes mid-session. Locale does NOT — `queryStringParams` is
    // populated once at module-eval from the URL and is fixed for the page
    // lifetime — and reverting a substituted `texture` would mean re-running
    // asset resolution rather than assigning a scalar. So there is no revert
    // set and no per-draw call site here, by design.
    private localizationOverrides: Map<string, OrcaLocalizationEntry> = new Map();

    // Resolved once; `null` until the first read. See `getLocalizationLocale`.
    private localizationLocale: string | null = null;

    // Localized refs already warned about (keyed SCOPE-QUALIFIED) — one console
    // line per ref, ever. Mirrors `warnedMissingKeys` in methods/translations.ts.
    private warnedLocalizedRefs: Set<string> = new Set();

    // One-shot latch for `warnIfLoadedSceneHasNoAuthoredContent`. The FIRST
    // loadScene of a session is always the host boot's entry-scene load
    // (`application.init()` loads it before FlowState binds any starter), so
    // this latch is what scopes the warning to the ENTRY scene — a later
    // flow-driven load of a deliberately empty scene is legitimate and silent.
    private entrySceneContentChecked = false;

    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
    * Register one or more OrcaSceneData objects.
     * Call this before loadScene — typically by importing the JSON files
     * exported from the editor that live in the active skin's scene-data/
     * folder under `<gameSrc>/skins/<skin>/scene-data/`.
    *
    * This also preloads Spine skeleton/atlas data referenced by exported
    * scene assets so Spine nodes can be constructed immediately after.
     *
     * @example
     *   import mainScene from '../../skins/dummy-skin-1/scene-data/main-scene.json';
     *   import uiScene   from '../../skins/dummy-skin-1/scene-data/ui-scene.json';
     *   SceneManager.getInstance().buildScenes([mainScene, uiScene]);
     *
     * Or call with no args to auto-load every JSON scene from the active
     * skin's scene-data folder (the loader filters by ACTIVE_SKIN):
     *   SceneManager.getInstance().buildScenes();
     */
    public async buildScenes(scenes: OrcaSceneData[] = []): Promise<void> {
        const sceneList = scenes.length > 0 ? scenes : this.loadScenesFromSceneDataFolder();

        this.scenesByKey.clear();
        this.scenesByName.clear();
        this.scenesByIndex = [];
        this.unavailableSceneTexturePaths.clear();

        for (const scene of sceneList) {
            this.ensureSceneAssetTags(scene);
            const origin: SceneOrigin = scene.origin ?? 'core';
            const compositeKey = `${origin}:${scene.name}`;
            this.scenesByKey.set(compositeKey, scene);
            // Skin overlays core for legacy bare-name lookups. Without
            // this, a flow's `loadScene('main')` against a skin scene that
            // shares its name with a core scene would silently jump into
            // core. Warn so the collision is surfaced — graph authors
            // should use SceneRef.scope to disambiguate.
            const existing = this.scenesByName.get(scene.name);
            if (!existing || origin === 'skin') {
                this.scenesByName.set(scene.name, scene);
            }
            if (existing && existing.origin !== origin) {
                console.warn(
                    `[SceneManager] Scene name collision "${scene.name}" between core and skin — skin overrides core for bare-name lookups. Use SceneRef.scope to disambiguate.`,
                );
            }
            this.scenesByIndex.push(scene);
        }

        if (this.scenesByIndex.length === 0) {
            console.warn('[SceneManager] No scenes registered. Add JSON files to ./scene-data or pass scenes explicitly to buildScenes([...]).');
        }

        await this.preloadSceneSpineAssets();
        await this.preloadSceneTextureAssets();
    }

    /**
     * Every reel symbol's win sound in the registered scenes, scope-qualified
     * exactly as the reels play it (preloaded while the game loads).
     */
    public audioPaths(): string[] {
        const out = new Set<string>();
        for (const scene of this.scenesByIndex) {
            const origin: SceneOrigin = scene.origin ?? 'core';
            const visit = (node: OrcaSceneNode): void => {
                if (node.type === 'reels' && Array.isArray(node.symbolEntries)) {
                    for (const entry of node.symbolEntries) {
                        const raw = typeof entry?.winAudio === 'string' ? entry.winAudio.trim() : '';
                        const normalized = raw ? this.normalizeSceneAssetPath(raw) : '';
                        if (normalized) out.add(this.scopeQualifyRef(normalized, origin));
                    }
                }
                if (Array.isArray(node.children)) {
                    for (const child of node.children) visit(child);
                }
            };
            for (const node of scene.nodes ?? []) visit(node);
        }
        return Array.from(out);
    }

    /**
     * Preload texture assets (e.g. reel symbol images) referenced by registered
     * scene files so they are available synchronously when loadScene() builds
     * the PIXI display tree.  Without this, textures resolved via
     * PIXI.Texture.from() trigger async downloads that cause a visible pop-in.
     */
    private async preloadSceneTextureAssets(): Promise<void> {
        if (this.scenesByIndex.length === 0) return;

        // Keys/srcs below are SCOPE-QUALIFIED (`core/3.png`,
        // `skins/<skin>/3.png`) so a core ref and an active-skin ref sharing a
        // basename are registered under DISTINCT loader cache keys and fetched
        // from DISTINCT URLs. `seenKeys` is keyed by the scoped form too, so we
        // don't drop a skin ref just because a core ref of the same basename
        // was already queued.
        const seenKeys = new Set<string>();
        const texturePaths: Array<{ key: string; src: string }> = [];
        const descriptorPaths: Array<{ path: string; scope: SceneOrigin }> = [];
        const spritesheetFrameRefs: Array<{ path: string; frame: string; scope: SceneOrigin }> = [];
        const entry = this.getEntryScene();
        const entryKey = entry ? `${entry.scope}:${entry.name}` : '';

        for (const scene of this.scenesByIndex) {
            const origin: SceneOrigin = scene.origin ?? 'core';
            // Stamp this scene's locale overrides so the collectors below walk
            // LOCALIZED nodes and the substituted binary is what gets probed
            // and registered with `Assets`.
            this.beginSceneLocalization(scene);
            const bundles = scene.assets?.bundles;
            if (Array.isArray(bundles)) {
                for (const bundle of bundles) {
                    if (!Array.isArray(bundle.assets)) continue;

                    for (const asset of bundle.assets) {
                        const tags = asset.tags ?? [];
                        const isTexture = tags.includes('pixi:texture') || tags.includes('pixi:reelsSymbol') || tags.includes('pixi:spritesheet');
                        const isSpriteDescriptor = tags.includes('pixi:spriteDescriptor') || this.isSpriteDescriptorPath(asset.src);

                        const normalizedSrc = this.normalizeSceneAssetPath(asset.src);
                        if (!normalizedSrc) continue;

                        if (isSpriteDescriptor) {
                            descriptorPaths.push({ path: normalizedSrc, scope: origin });
                        }

                        if (!isTexture) continue;
                        const scopedSrc = this.scopeQualifyRef(normalizedSrc, origin);
                        if (seenKeys.has(scopedSrc)) continue;
                        seenKeys.add(scopedSrc);

                        texturePaths.push({ key: scopedSrc, src: scopedSrc });
                    }
                }
            }

            for (const descriptorPath of this.collectSceneSpriteDescriptorPaths(scene.nodes)) {
                descriptorPaths.push({ path: descriptorPath, scope: origin });
            }

            for (const ref of this.collectSceneSpritesheetFrameRefs(scene.nodes)) {
                spritesheetFrameRefs.push({ path: ref.path, frame: ref.frame, scope: origin });
            }

            for (const texturePath of this.collectSceneStaticTexturePaths(scene.nodes)) {
                const scopedSrc = this.scopeQualifyRef(texturePath, origin);
                if (!scopedSrc || seenKeys.has(scopedSrc)) continue;
                seenKeys.add(scopedSrc);
                texturePaths.push({ key: scopedSrc, src: scopedSrc });
            }

            // Raw scratch-brush bitmaps. Resolved SYNCHRONOUSLY during the
            // build (attachScratchBehaviour), so unlike a node `texture` there
            // is no deferred-wiring path to rescue a lazy 0x0 texture.
            for (const brushPath of this.collectSceneScratchBrushPaths(scene.nodes)) {
                const scopedSrc = this.scopeQualifyRef(brushPath, origin);
                if (!scopedSrc || seenKeys.has(scopedSrc)) continue;
                seenKeys.add(scopedSrc);
                texturePaths.push({ key: scopedSrc, src: scopedSrc });
            }

            // Plain-image reel symbols. A scene saved by the editor carries no
            // asset bundles, so they otherwise all loaded on demand and the
            // first board could be drawn before its images arrived.
            for (const symbolPath of this.collectSceneReelSymbolImagePaths(scene.nodes)) {
                const scopedSrc = this.scopeQualifyRef(symbolPath, origin);
                if (!scopedSrc || seenKeys.has(scopedSrc)) continue;
                seenKeys.add(scopedSrc);
                texturePaths.push({ key: scopedSrc, src: scopedSrc });
            }

            // Custom-component `assetRef` values. Also resolved SYNCHRONOUSLY
            // during the build (instantiateCustomComponents), so an unloaded
            // texture would reach `onCreate` measuring 0x0.
            for (const assetRef of this.collectSceneComponentAssetPaths(scene.nodes)) {
                if (this.isSpriteDescriptorPath(assetRef)) {
                    descriptorPaths.push({ path: assetRef, scope: origin });
                    continue;
                }
                const scopedSrc = this.scopeQualifyRef(assetRef, origin);
                if (!scopedSrc || seenKeys.has(scopedSrc)) continue;
                seenKeys.add(scopedSrc);
                texturePaths.push({ key: scopedSrc, src: scopedSrc });
            }

            // Locale substitutes for the active locale. Queued so the LOCALIZED
            // binary is the one fetched — and so a 404 on it is recorded in
            // `unavailableSceneTexturePaths` before the synchronous build,
            // which is what lets `localizeNode` fall a node back to its base
            // ref without waiting on an async load.
            for (const localizedRef of this.collectLocalizedTexturePaths()) {
                if (this.isSpriteDescriptorPath(localizedRef)) {
                    descriptorPaths.push({ path: localizedRef, scope: origin });
                    continue;
                }
                const scopedSrc = this.scopeQualifyRef(localizedRef, origin);
                if (!scopedSrc || seenKeys.has(scopedSrc)) continue;
                seenKeys.add(scopedSrc);
                texturePaths.push({ key: scopedSrc, src: scopedSrc });
            }

            // Every plain image the ENTRY scene's nodes draw. A scene saved by
            // the editor carries no asset bundles, so they otherwise loaded on
            // demand AFTER the boot dismissed its loading screen, popping in.
            // Other scenes still load theirs when a flow loads them.
            if (entryKey && `${origin}:${scene.name}` === entryKey) {
                for (const imagePath of this.collectSceneNodeTexturePaths(scene.nodes)) {
                    const scopedSrc = this.scopeQualifyRef(imagePath, origin);
                    if (!scopedSrc || seenKeys.has(scopedSrc)) continue;
                    seenKeys.add(scopedSrc);
                    texturePaths.push({ key: scopedSrc, src: scopedSrc });
                }
            }
        }

        // Fetch + parse the atlas page owning each referenced frame ahead of the
        // synchronous scene build (runs even when there are no plain textures).
        await this.preloadSceneSpritesheetFrames(spritesheetFrameRefs);

        for (const { path: texturePath, scope } of await this.preloadSceneSpriteDescriptors(descriptorPaths)) {
            const normalizedSrc = this.normalizeSceneAssetPath(texturePath);
            if (!normalizedSrc) continue;
            const scopedSrc = this.scopeQualifyRef(normalizedSrc, scope);
            if (seenKeys.has(scopedSrc)) continue;
            seenKeys.add(scopedSrc);
            texturePaths.push({ key: scopedSrc, src: scopedSrc });
        }

        if (texturePaths.length === 0) return;

        // Pixi 8 has no shared `Loader`; `Assets` replaces it. The SCOPE-QUALIFIED
        // ref (`core/3.png`, `skins/<skin>/3.png`) stays the cache ALIAS, exactly
        // as it was the loader resource name — so a core ref and a skin ref
        // sharing a basename still occupy distinct cache slots — while the
        // fetched `src` remains the absolute, `?v=N`-cache-busted URL.
        const queued: Array<{ key: string; src: string; url: string }> = [];

        // Probed in parallel: sequential round-trips add up to seconds of boot on a remote host.
        const pending = texturePaths.filter((entry) => !Pixi.Cache.has(entry.key));
        const probeResults = await Promise.all(pending.map((entry) => this.canFetchSceneAsset(entry.src)));

        pending.forEach((entry, index) => {
            const probeResult = probeResults[index];
            if (probeResult === 'missing') {
                this.markSceneTextureUnavailable(entry.src);
                console.warn(`[SceneManager] Static texture preload skipped — server returned 404: ${entry.src}`);
                return;
            }
            if (probeResult === 'unknown') {
                console.debug(`[SceneManager] Static texture probe was inconclusive; queueing anyway: ${entry.src}`);
            }

            queued.push({ key: entry.key, src: entry.src, url: this.toAbsoluteSceneAssetUrl(entry.src) });
        });

        if (queued.length === 0) return;

        try {
            Pixi.Assets.add(queued.map(({ key, url }) => ({ alias: key, src: url })));
            for (const { key } of queued) this.registeredAssetAliases.add(key);
        } catch (err) {
            console.warn('[SceneManager] Static texture preload could not register aliases; continuing with texture fallback if needed.', err);
        }

        // Loaded in parallel and awaited as one batch (the old `loader.load()`
        // completion signal), but with per-entry error containment so one 404
        // still leaves the rest preloaded.
        await Promise.all(queued.map(async ({ key, src }) => {
            try {
                await Pixi.Assets.load(key);
            } catch (err) {
                this.markSceneTextureUnavailable(src);
                console.warn(`[SceneManager] Static texture preload failed for "${src}"; continuing with missing texture fallback.`, err);
            }
        }));
    }

    /**
     * Preload Spine skeleton data referenced by registered scene files.
     * This allows scene-exported Spine nodes to render without requiring
     * matching entries in skin data-list animation manifests.
     */
    private async preloadSceneSpineAssets(): Promise<void> {
        if (this.scenesByIndex.length === 0) return;

        const specs: Array<SpineLoadSpec & { scope: SceneOrigin }> = [];
        // De-dupe by SCOPE-QUALIFIED skeleton so a core and an active-skin
        // skeleton sharing a basename are both preloaded under distinct keys.
        const seenSkeletons = new Set<string>();

        for (const scene of this.scenesByIndex) {
            const origin: SceneOrigin = scene.origin ?? 'core';
            this.indexSceneAssets(scene);
            // Skeleton / atlas may both be locale-substituted, so the spec
            // collector must walk LOCALIZED nodes.
            this.beginSceneLocalization(scene);
            const sceneSpecs = this.collectSceneSpineLoadSpecs(scene);

            for (const spec of sceneSpecs) {
                const normalizedSkeleton = this.normalizeSceneAssetPath(spec.skeletonPath);
                if (!normalizedSkeleton) continue;
                const scopedSkeleton = this.scopeQualifyRef(normalizedSkeleton, origin);
                if (seenSkeletons.has(scopedSkeleton)) continue;
                seenSkeletons.add(scopedSkeleton);
                specs.push({ ...spec, scope: origin });
            }
        }

        if (specs.length === 0) return;

        // asset-manager@6 no longer exposes the `loader` / `cacheAnimationData`
        // pair this used to drive — Pixi 8 deleted the shared `Loader` it
        // wrapped. Skeleton + atlas are registered with `Assets` instead, under
        // the SAME SCOPE-QUALIFIED aliases the old loader used as resource
        // names (`skins/<skin>/Spine/x.json`), so a core and an active-skin
        // skeleton sharing a basename still occupy distinct cache slots. Those
        // aliases are also the shape `Spine.from({ skeleton, atlas })` expects.
        // The atlas's page images are resolved by the spine atlas loader from
        // the dirname of the RESOLVED src URL, so they stay descriptor-relative
        // and land in the right bucket without any extra registration.
        const registrations: Array<{ alias: string; src: string }> = [];
        const entries: Array<{ skeletonAlias: string; atlasAlias: string; cacheKey: string }> = [];

        for (const spec of specs) {
            const normalizedSkeleton = this.normalizeSceneAssetPath(spec.skeletonPath);
            const normalizedAtlas = this.normalizeSceneAssetPath(spec.atlasPath ?? '');
            if (!normalizedSkeleton) continue;
            if (!normalizedAtlas) {
                console.warn(`[SceneManager] Spine preload skipped — no atlas resolved for skeleton "${spec.skeletonPath}"`);
                continue;
            }

            const skeletonAlias = this.scopeQualifyRef(normalizedSkeleton, spec.scope);
            const atlasAlias = this.scopeQualifyRef(normalizedAtlas, spec.scope);
            // Must match `loadSpineDataForNode`'s key byte-for-byte: that is the
            // cache slot the synchronous build path probes before it attempts
            // its own fetch-and-parse.
            const cacheKey = `${skeletonAlias}::${normalizedAtlas}`;
            if (this.sceneSpineDataCache.has(cacheKey)) continue;

            registrations.push(
                { alias: skeletonAlias, src: this.toAbsoluteSceneAssetUrl(spec.skeletonPath, spec.scope) },
                { alias: atlasAlias, src: this.toAbsoluteSceneAssetUrl(spec.atlasPath ?? '', spec.scope) },
            );
            entries.push({ skeletonAlias, atlasAlias, cacheKey });
        }

        if (entries.length === 0) return;

        try {
            Pixi.Assets.add(registrations);
            for (const { alias } of registrations) this.registeredAssetAliases.add(alias);
        } catch (err) {
            console.warn('[SceneManager] Spine preload could not register aliases; scene spine nodes will fall back to their own URL parse.', err);
        }

        // Awaited as one batch (the old `loader.load()` completion signal) with
        // per-skeleton error containment, so one bad atlas still leaves the rest
        // preloaded before the synchronous scene build runs.
        await Promise.all(entries.map(async ({ skeletonAlias, atlasAlias, cacheKey }) => {
            try {
                const atlas = await Pixi.Assets.load<TextureAtlas>(atlasAlias);
                // The spine skeleton loader is raw: `.skel` yields a Uint8Array,
                // `.json` the parsed JSON. Turning either into SkeletonData is
                // the caller's job.
                const rawSkeleton = await Pixi.Assets.load<unknown>(skeletonAlias);
                const attachmentLoader = new AtlasAttachmentLoader(atlas);
                const skeletonData: SkeletonData = rawSkeleton instanceof Uint8Array
                    ? new SkeletonBinary(attachmentLoader).readSkeletonData(rawSkeleton)
                    : new SkeletonJson(attachmentLoader).readSkeletonData(rawSkeleton);

                this.sceneSpineDataCache.set(cacheKey, skeletonData);
            } catch (err) {
                console.warn(`[SceneManager] Spine preload failed for "${skeletonAlias}"; the scene build will retry via its own URL parse.`, err);
            }
        }));
    }

    private loadScenesFromSceneDataFolder(): OrcaSceneData[] {
        type SceneModule = OrcaSceneData | { default?: OrcaSceneData };
        type SceneContext = {
            keys(): string[];
            (key: string): SceneModule;
        };

        // Scenes live in two trees, both nested under <gameSrc>:
        //   skins/<skin>/scene-data/**/*.json   (per-skin, filtered to ACTIVE_SKIN)
        //   core/scene-data/**/*.json           (always loaded)
        // The relative path under scene-data/ (with .json stripped) is the
        // scene's runtime name, matching the editor-side SceneRef.name (e.g.
        // "scenes/main", "levels/boss/main"). The relative path here is three
        // levels up from this file (core/services/orca → src).
        const loadedScenes: OrcaSceneData[] = [];

        const unwrap = (moduleValue: SceneModule): OrcaSceneData =>
            ((moduleValue as { default?: OrcaSceneData }).default ?? (moduleValue as OrcaSceneData));

        const ingest = (raw: OrcaSceneData, relName: string, origin: SceneOrigin, key: string): void => {
            // Prefer the on-disk relative path as the runtime name so it
            // matches the editor's SceneRef.name. Authored `data.name` is
            // ignored to keep keys stable across renames.
            const named = { ...raw, name: relName, origin } as OrcaSceneData;
            if (this.isSceneData(named)) {
                loadedScenes.push(named);
            } else {
                console.warn(`[SceneManager] Ignoring invalid scene file: ${key}`);
            }
        };

        try {
            for (const [relName, raw] of Object.entries(SKIN_SCENES)) {
                ingest(raw as OrcaSceneData, relName, 'skin', `skin/${ACTIVE_SKIN}/scene-data/${relName}.json`);
            }
        } catch (err) {
            console.warn('[SceneManager] Failed to load skin scenes', err);
        }

        try {
            const coreCtx = (require as any).context('../../../core/scene-data', true, /\.json$/i) as SceneContext;
            const keys = coreCtx.keys().sort((a, b) => a.localeCompare(b));

            for (const key of keys) {
                const m = key.match(/^\.\/(.+)\.json$/i);
                if (!m) continue;
                const [, relName] = m;

                ingest(unwrap(coreCtx(key)), relName, 'core', key);
            }
        } catch (err) {
            console.warn('[SceneManager] No core/scene-data folder found', err);
        }

        return loadedScenes;
    }

    private isSceneData(value: unknown): value is OrcaSceneData {
        if (!value || typeof value !== 'object') return false;

        const scene = value as Partial<OrcaSceneData>;
        if (typeof scene.name !== 'string' || !Array.isArray(scene.nodes)) return false;
        if (typeof scene.version !== 'string' || typeof scene.pixiVersion !== 'string') return false;
        if (!scene.viewport || typeof scene.viewport !== 'object') return false;

        const viewport = scene.viewport as { width?: unknown; height?: unknown };
        return typeof viewport.width === 'number' && typeof viewport.height === 'number';
    }

    /**
     * Load a scene by name or by index (registration order).
     * Destroys the previously loaded scene container if one exists, but
     * preserves any node subtree marked dontDestroyOnLoad — those are
     * detached and re-parented to the persistent dontDestroyContainer (and
     * later re-bound into the new scene tree if a same-keyed slot exists).
     *
     * If renderer dimensions have been supplied via setRendererDimensions(),
     * the camera transform is snapped immediately so flow-driven loadScene
     * calls don't require the host to manually re-call drawScene().
     *
     * If a host stage has been registered via setHostStage(), the freshly-
     * built container is also attached to that stage automatically (and the
     * DDOL container, if it lives on the same stage, is brought back to the
     * front so DDOL nodes keep their default above-scene render order).
     *
     * @returns The root PIXI.Container for the scene, ready to be added to the stage.
     */
    public loadScene(nameOrIndex: string | number, scope?: 'core' | 'skin'): PixiContainer | null {
        let scene: OrcaSceneData | undefined;
        if (typeof nameOrIndex === 'number') {
            scene = this.scenesByIndex[nameOrIndex];
        } else if (scope) {
            scene = this.scenesByKey.get(`${scope}:${nameOrIndex}`);
        } else {
            scene = this.scenesByName.get(nameOrIndex);
        }

        if (!scene) {
            const label = scope ? `${scope}:${nameOrIndex}` : String(nameOrIndex);
            console.warn(`[SceneManager] Scene not found: "${label}"`);
            return null;
        }

        // Tear down previous scene while preserving DDOL subtrees.
        this.teardownCurrentScene();

        this.currentScene = scene;
        this.indexSceneAssets(scene);
        this.ddolKeysBoundThisLoad.clear();

        // Catastrophic-build guard. buildSceneContainer already isolates
        // individual failing nodes (per-node try/catch), but if the build
        // itself throws unexpectedly we must still degrade gracefully rather
        // than unwinding out of loadScene() — application.init() calls this
        // un-awaited and un-guarded, so a throw here would blank the stage.
        // Fall back to an empty root container so the rest of the boot
        // sequence (camera snap, system-view reattach) keeps working.
        try {
            this.currentContainer = this.buildSceneContainer(scene);
        } catch (e) {
            console.error(
                `[SceneManager] Scene build failed catastrophically for "${scene.name}" — attaching an empty container so the stage degrades gracefully:`,
                e,
            );
            const fallback = new Pixi.Container();
            fallback.label = scene.name;
            fallback.sortableChildren = true;
            this.currentContainer = fallback;
        }

        // Auto-mount onto the host stage so flow-driven loadScene calls don't
        // orphan the new container. Re-add the DDOL container on top so DDOL
        // subtrees keep their default above-scene render order.
        if (this.hostStage && this.currentContainer) {
            this.hostStage.addChild(this.currentContainer);
            if (this.dontDestroyContainer && this.dontDestroyContainer.parent === this.hostStage) {
                this.hostStage.addChild(this.dontDestroyContainer); // re-add to bring to front (idempotent)
            }
        }

        // Reparent any cached system views (cabinet / jackpots panel / chat
        // overlay) into this scene's placeholder mount points so the
        // user-authored draw order in the editor applies in-game.
        this.reattachAttachedViews();

        this.applySceneBackground(scene);

        // Auto-snap the camera with cached renderer dimensions so flow-driven
        // loadScene() "just works" without the caller knowing the viewport.
        if (this.lastRendererWidth > 0 && this.lastRendererHeight > 0) {
            this.drawScene(this.lastRendererWidth, this.lastRendererHeight);
        }

        this.warnIfLoadedSceneHasNoAuthoredContent();

        return this.currentContainer;
    }

    /**
     * ONE-SHOT boot diagnostic for an entry scene that holds nothing but the
     * system singletons. Such a scene is LEGAL and loads perfectly cleanly —
     * it builds no nodes, fetches no assets and logs nothing at all — which is
     * exactly why an entry scene left pinned to an untouched scaffold seed
     * presents as a game that renders only the cabinet, in total silence,
     * while every FlowState `nodeRef` into the author's real scene misses.
     *
     * Warning only: never an error, never a throw, never a behaviour change.
     */
    private warnIfLoadedSceneHasNoAuthoredContent(): void {
        if (this.entrySceneContentChecked) return;
        this.entrySceneContentChecked = true;
        try {
            const scene = this.currentScene;
            if (!scene || !Array.isArray(scene.nodes)) return;
            const authored = scene.nodes.filter(
                (node) => !!node && !SYSTEM_SINGLETON_NODE_TYPES.has(node.type),
            );
            if (authored.length > 0) return;
            const origin: SceneOrigin = scene.origin ?? 'core';
            console.warn(
                `[SceneManager] Entry scene "${origin}:${scene.name}" contains no content beyond the `
                + `system nodes (camera / cabinet / jackpots module / chat overlay), so nothing authored `
                + `will render and FlowState nodeRefs into other scenes will not resolve. The skin's entry `
                + `scene may be pointing at a scene that was never edited.`,
            );
        } catch {
            // Diagnostic only — never allowed to affect the load.
        }
    }

    /**
     * Unload the currently-loaded scene without immediately loading another.
     * DDOL containers are detached and kept alive in dontDestroyContainer.
     *
     * @param name Optional scene name. If supplied and it doesn't match the
     *             currently-loaded scene, this is a no-op (with a warning).
     */
    public unloadScene(name?: string, scope?: 'core' | 'skin'): void {
        if (!this.currentScene || !this.currentContainer) {
            return;
        }

        if (name !== undefined) {
            const currentOrigin: SceneOrigin = this.currentScene.origin ?? 'core';
            const nameMismatch = name !== this.currentScene.name;
            const scopeMismatch = scope !== undefined && scope !== currentOrigin;
            if (nameMismatch || scopeMismatch) {
                const requested = scope ? `${scope}:${name}` : name;
                console.warn(
                    `[SceneManager] unloadScene("${requested}") ignored — current scene is "${currentOrigin}:${this.currentScene.name}"`,
                );
                return;
            }
        }

        this.teardownCurrentScene();
        this.currentScene = null;
        this.currentContainer = null;
        this.applySceneBackground(null);
    }

    /**
     * True when any registered scene's camera asks for a `clear` background.
     * Pixi 8 only creates an alpha-capable WebGL context when `backgroundAlpha`
     * is below 1 at `app.init()`, so the host asks this BEFORE initialising.
     */
    public requiresTransparentCanvas(): boolean {
        if (!isScene3DEnabled()) return false;
        try {
            const scenes = this.scenesByIndex.length > 0 ? this.scenesByIndex : this.loadScenesFromSceneDataFolder();
            return scenes.some((scene) => this.findCameraNode(scene.nodes)?.background?.mode === 'clear');
        } catch {
            return false;
        }
    }

    /** Where the loaded scene's 3D layer stands, for FlowState diagnostics. */
    public getScene3DState(): 'disabled' | 'inactive' | 'building' | 'ready' {
        if (!isScene3DEnabled()) return 'disabled';
        const layer = this.scene3dLayer;
        if (!layer || !layer.isActive()) return 'inactive';
        return layer.isReady() ? 'ready' : 'building';
    }

    /**
     * A `scene3d` node's live Object3D (holder Group for model3d / primitive3d,
     * the light, the camera, or the Group), or null when 3D is disabled, the
     * layer is inactive / still building, or the id is not in the loaded scene.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public getObject3DById(id: string): any | null {
        if (!isScene3DEnabled()) return null;
        return this.scene3dLayer?.getObjectById(id) ?? null;
    }

    /**
     * Run `cb(true)` once the loaded scene's 3D tree is built (immediately when it
     * already is); `cb(false)` if the build fails or the scene is swapped first.
     * Returns false — never calling `cb` — when 3D is disabled or no 3D layer is
     * active, so the caller can no-op.
     */
    public whenScene3DReady(cb: (ready: boolean) => void): boolean {
        if (!isScene3DEnabled()) return false;
        const layer = this.scene3dLayer;
        if (!layer || !layer.isActive()) return false;
        return layer.whenReady(cb);
    }

    /**
     * Run `cb(true)` once model3d `id`'s glTF has loaded (its mixer exists), or
     * `cb(false)` if it fails / the scene is swapped. Returns false — never calling
     * `cb` — unless the 3D tree is built and `id` is one of its model3d nodes.
     */
    public whenModel3DReady(id: string, cb: (loaded: boolean) => void): boolean {
        if (!isScene3DEnabled()) return false;
        return this.scene3dLayer?.whenModelReady(id, cb) ?? false;
    }

    /** The model3d's three `AnimationMixer`, once its glTF has loaded. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public getModel3DMixer(id: string): any | null {
        if (!isScene3DEnabled()) return null;
        return this.scene3dLayer?.getMixer(id) ?? null;
    }

    /** The model3d's glTF `AnimationClip`s (empty until loaded, or when it has none). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public getModel3DClips(id: string): any[] {
        if (!isScene3DEnabled()) return [];
        return this.scene3dLayer?.getClips(id) ?? [];
    }

    /**
     * Apply the loaded scene camera's `background` to the host renderer and
     * (de)activate the 3D layer. A scene without one restores whatever the
     * host had, so the absent case behaves exactly as before.
     */
    private applySceneBackground(scene: OrcaSceneData | null): void {
        const background = scene ? this.findCameraNode(scene.nodes)?.background : null;
        const validColor = typeof background?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(background.color);
        const enabled3D = isScene3DEnabled();
        // An unusable `color` falls back to the host background rather than keeping a previous scene's `clear`.
        // With 3D disabled nothing can show through, so `clear` behaves as ABSENT.
        const mode = background?.mode === 'clear' ? (enabled3D ? 'clear' : null) : background?.mode === 'color' && validColor ? 'color' : null;
        if (!enabled3D && scene?.scene3d && !this.scene3dDisabledNoticeShown) {
            this.scene3dDisabledNoticeShown = true;
            console.info(`[SceneManager] Scene "${scene.name}" has a 3D section, but 3D is disabled for this project (Project Settings); it is not rendered.`);
        }
        const rendererBackground = this.hostRenderer?.background as
            | { color: unknown; alpha: number; colorRgba: number[] }
            | undefined;

        if (rendererBackground) {
            try {
                if (mode && !this.savedRendererBackground) {
                    this.savedRendererBackground = rendererBackground.colorRgba.slice();
                }
                if (mode === 'clear') {
                    rendererBackground.alpha = 0;
                } else if (mode === 'color') {
                    rendererBackground.alpha = 1;
                    rendererBackground.color = background!.color as string;
                } else if (!mode && this.savedRendererBackground) {
                    // Alpha first: Pixi warns when a translucent colour lands on an opaque background.
                    rendererBackground.alpha = this.savedRendererBackground[3];
                    rendererBackground.color = this.savedRendererBackground;
                    this.savedRendererBackground = null;
                }
            } catch (err) {
                console.warn('[SceneManager] Could not apply the camera background', err);
            }
        }

        if (mode === 'clear' && scene?.scene3d && Array.isArray(scene.scene3d.nodes)) {
            const layer = this.scene3dLayer ?? (this.scene3dLayer = new Scene3DLayer());
            const canvas = (this.hostRenderer?.canvas ?? null) as HTMLCanvasElement | null;
            layer.setHost(canvas, Number(this.hostRenderer?.resolution) || 1);
            const origin: SceneOrigin = scene.origin ?? 'core';
            layer.activate(
                scene.scene3d,
                (src) => this.toAbsoluteSceneAssetUrl(src, origin),
                this.create3DComponentHost(origin),
                scene3DShadowQuality(),
            );
        } else {
            // 3D nodes' custom components live and die with this layer, so they never run in a non-`clear` scene.
            this.scene3dLayer?.deactivate();
        }
    }

    /**
     * Register the pixi stage (or any container) that scene roots should be
     * attached to. Once set, every subsequent `loadScene()` call will mount
     * the freshly-built scene container into this parent automatically (and
     * the previous scene's container is detached/destroyed by the teardown
     * step). The DDOL container, if registered as a child of the same stage,
     * is re-added on top after each load so DDOL nodes always render above
     * the active scene.
     *
     * Call this once at boot, before the first `loadScene()`.
     */
    public setHostStage(stage: PixiContainer | null): void {
        this.hostStage = stage;
    }

    /**
     * Register the live pixi renderer. Required by node types that bake into a
     * RenderTexture during the scene build — currently `scratchableItem`,
     * whose scratch mask is a RenderTexture painted on every pointer move.
     *
     * Call this once at boot alongside `setHostStage()`. When it is never
     * called, a `scratchableItem` still renders as a plain sprite (one warn,
     * no scratch behaviour) rather than failing the scene build.
     */
    public setHostRenderer(renderer: any | null): void {
        this.hostRenderer = renderer;
    }

    /**
     * Reparent an externally-constructed cabinet view into the current
     * scene's `cabinet` placeholder, so the user-authored draw order in the
     * editor (cabinet's position among root-level siblings) applies in-game.
     *
     * The view is cached internally and automatically re-bound into each
     * subsequent scene's cabinet placeholder across loadScene / unloadScene
     * — the host only needs to call this once at boot, after constructing
     * the cabinet (and may call again to swap the view).
     *
     * If the active scene has no cabinet placeholder (legacy / hand-authored
     * scene without the singleton), the view is parked on the persistent
     * dontDestroyContainer so it stays visible until a scene with a
     * placeholder loads.
     *
     * Pass `null` to clear the cached attachment.
     */
    public attachCabinet(view: PixiContainer | null): void {
        this.attachedCabinet = view;
        this.reattachSystemView(view, this.cabinetMountTarget);
    }

    /**
     * Reparent an externally-constructed jackpots panel view into the
     * current scene's `jackpotsModule` placeholder. See attachCabinet() for
     * lifecycle semantics — the view is cached and rebound on every
     * loadScene.
     *
     * NOTE: in @game-studio/jackpots the panel is constructed by
     * `JackpotRound.createViews(stage)` deep inside the package; the host
     * must invoke this AFTER that construction (typically inside the
     * jackpots-onComplete hook) to take ownership of placement.
     */
    public attachJackpots(view: PixiContainer | null): void {
        this.attachedJackpots = view;
        this.reattachSystemView(view, this.jackpotsMountTarget);
    }

    /**
     * Reparent an externally-constructed chat-overlay view into the current
     * scene's `chatOverlay` placeholder. See attachCabinet() for lifecycle
     * semantics.
     */
    public attachChatOverlay(view: PixiContainer | null): void {
        this.attachedChatOverlay = view;
        this.reattachSystemView(view, this.chatOverlayMountTarget);
    }

    /**
     * Reparent `view` into `mountTarget`. Falls back to the persistent
     * dontDestroyContainer when no mount target exists, so the view stays
     * alive until a scene with the matching placeholder loads.
     */
    private reattachSystemView(
        view: PixiContainer | null,
        mountTarget: PixiContainer | null,
    ): void {
        if (!view || (view as { destroyed?: boolean }).destroyed) return;
        const target = mountTarget ?? this.getOrCreateDontDestroyContainer();
        if (view.parent === target) return;
        target.addChild(view);
    }

    /**
     * Re-bind every cached system view into the current scene's mount
     * targets. Called automatically by loadScene after the new scene
     * container is built.
     */
    private reattachAttachedViews(): void {
        this.reattachSystemView(this.attachedCabinet, this.cabinetMountTarget);
        this.reattachSystemView(this.attachedJackpots, this.jackpotsMountTarget);
        this.reattachSystemView(this.attachedChatOverlay, this.chatOverlayMountTarget);
    }

    /**
     * Detach attached system views back to the persistent
     * dontDestroyContainer before scene-container destroy, so they survive
     * teardown without being recursively destroyed alongside the scene.
     */
    /**
     * Apply inverse transform to each system-singleton mount target so its
     * children (which compute layout in stage-pixel coords assuming an
     * identity parent) are not double-transformed by currentContainer's
     * camera letterbox scale + position.
     */
    private counterScaleSystemMounts(effectiveZoom: number, tx: number, ty: number): void {
        const mounts = [
            this.cabinetMountTarget,
            this.jackpotsMountTarget,
            this.chatOverlayMountTarget,
        ];
        const inv = effectiveZoom !== 0 ? 1 / effectiveZoom : 1;
        for (const mount of mounts) {
            if (!mount) continue;
            mount.scale.set(inv);
            mount.position.set(-tx * inv, -ty * inv);
        }
    }

    private parkAttachedViewsForTeardown(): void {
        const ddolHost = this.getOrCreateDontDestroyContainer();
        const park = (view: PixiContainer | null): void => {
            if (!view || (view as { destroyed?: boolean }).destroyed) return;
            if (view.parent && view.parent !== ddolHost) {
                ddolHost.addChild(view);
            } else if (!view.parent) {
                ddolHost.addChild(view);
            }
        };
        park(this.attachedCabinet);
        park(this.attachedJackpots);
        park(this.attachedChatOverlay);
    }

    /**
     * Cache the host's renderer dimensions. Call this once at boot and on
     * every resize before drawScene(). loadScene() uses the cached values to
     * snap the camera transform automatically.
     */
    public setRendererDimensions(width: number, height: number): void {
        if (Number.isFinite(width) && width > 0) this.lastRendererWidth = width;
        if (Number.isFinite(height) && height > 0) this.lastRendererHeight = height;
    }

    /**
     * The canonical 3-way device mode, resolved from the cached renderer
     * dimensions. Deliberately NOT cached and NOT subscribed to
     * GLOBAL_ORIENTATION_CHANGE (see the design note in drawScene) — callers
     * must call setRendererDimensions() first so this reads the CURRENT frame.
     */
    public getActiveLayoutMode(): OrcaActiveLayoutMode {
        return this.resolveActiveLayoutMode(this.lastRendererWidth, this.lastRendererHeight);
    }

    /**
     * Persistent container for nodes flagged `dontDestroyOnLoad`. The host
     * MUST `addChild` this container to the stage exactly once at boot,
     * AFTER the active scene root so DDOL nodes render above the scene by
     * default. Created lazily on first access. Survives every loadScene /
     * unloadScene call.
     */
    public getDontDestroyContainer(): PixiContainer {
        return this.getOrCreateDontDestroyContainer();
    }

    /**
     * Returns the name of the scene the host should load first.
     *
     * Sourced from `main.entryScene` via the auto-generated `active-skin.ts`
     * (`ENTRY_SCENE_NAME`). When the editor's selection is unresolvable for
     * the active skin (or no entry scene is set), falls back to the first
     * registered scene's name (alphabetical from
     * `loadScenesFromSceneDataFolder`; `buildScenes()` preserves that
     * order).
     *
     * Returns null when no scenes are registered.
     */
    public getEntrySceneName(): string | null {
        const entry = this.getEntryScene();
        return entry?.name ?? null;
    }

    /**
     * Returns the scope-qualified entry scene the host should load first.
     *
     * Resolves `ENTRY_SCENE_NAME` against `ENTRY_SCENE_SCOPE` (when both are
     * emitted by the active-skin generator) so a per-skin entry scene whose
     * name collides with a core scene resolves to the skin scene rather than
     * the core one. Falls back to first-registered scene when the entry is
     * unresolvable.
     */
    public getEntryScene(): { name: string; scope: 'core' | 'skin' } | null {
        if (ENTRY_SCENE_NAME) {
            // `ENTRY_SCENE_SCOPE` is an auto-generated const whose inferred type
            // can be a NARROW string literal — e.g. the scaffold placeholder
            // `''` before the editor regenerates active-skin.ts. Widen to a
            // plain `string` local before the equality checks: comparing the
            // literal-typed const directly (`'' === 'skin'`) is a compile error
            // (TS2367, "types have no overlap") that breaks the whole game build.
            const rawScope: string = ENTRY_SCENE_SCOPE;
            const scope: 'skin' | 'core' | null =
                rawScope === 'skin' || rawScope === 'core' ? rawScope : null;
            if (scope) {
                const scene = this.scenesByKey.get(`${scope}:${ENTRY_SCENE_NAME}`);
                if (scene) return { name: ENTRY_SCENE_NAME, scope };
            } else if (this.scenesByName.has(ENTRY_SCENE_NAME)) {
                const scene = this.scenesByName.get(ENTRY_SCENE_NAME)!;
                const origin: SceneOrigin = scene.origin ?? 'core';
                return { name: ENTRY_SCENE_NAME, scope: origin };
            }
        }
        const first = this.scenesByIndex[0];
        if (!first) return null;
        const origin: SceneOrigin = first.origin ?? 'core';
        return { name: first.name, scope: origin };
    }

    /**
     * Authored landscape X offset for the jackpots panel, read from the
     * current scene's `jackpotsModule` system-singleton node (`gameLeftEdge`,
     * a 0..1 fraction of camera/renderer width). The gated jackpots runtime
     * helper multiplies this by the renderer width and passes it to the
     * package's `positionViews(width, height, landscapeXPosition)`. Returns
     * `undefined` when no scene/node is loaded or the value is unset/non-finite
     * so the package default (`trueWidth + 20`) applies.
     */
    public getJackpotsGameLeftEdge(): number | undefined {
        if (!this.currentScene) return undefined;
        const node = this.findJackpotsModuleNode(this.currentScene.nodes);
        const edge = node?.gameLeftEdge;
        return typeof edge === 'number' && Number.isFinite(edge) ? edge : undefined;
    }

    /**
     * The jackpots panel's Fit to Area margins when its `jackpotsModule` node
     * places it that way (centred between them in landscape), else undefined
     * (placed by `getJackpotsGameLeftEdge`). Each margin is a share of the
     * screen's width or height (`fit-area.ts`).
     */
    public getJackpotsAreaMargins(): { left: FitAreaMargin; right: FitAreaMargin } | undefined {
        if (!this.currentScene) return undefined;
        const node = this.findJackpotsModuleNode(this.currentScene.nodes);
        if (!node || node.placement !== 'fitArea') return undefined;
        return {
            left: normalizeFitAreaMargin(node.areaMargins?.left, 'left'),
            right: normalizeFitAreaMargin(node.areaMargins?.right, 'right'),
        };
    }

    /**
     * The jackpots panel's restyle when its `jackpotsModule` node has one
     * switched on: each quality's restyled atlas page as a URL (`'1'` desktop,
     * `'0.5'` phones) and the fingerprint of the atlas it was baked from, for
     * the gated jackpots runtime helper to swap in. Undefined: the package's art.
     */
    public getJackpotsPanelStyle(): { pages: Record<string, string>; atlas: Record<string, string> } | undefined {
        if (!this.currentScene) return undefined;
        const style = this.findJackpotsModuleNode(this.currentScene.nodes)?.panelStyle;
        if (!style || style.enabled === false || !style.pages || typeof style.pages !== 'object') return undefined;
        const pages: Record<string, string> = {};
        const atlas: Record<string, string> = {};
        for (const quality of ['1', '0.5']) {
            const ref = style.pages[quality];
            const print = style.atlas?.[quality];
            if (typeof ref !== 'string' || !ref || typeof print !== 'string') continue;
            pages[quality] = this.toAbsoluteSceneAssetUrl(ref, this.currentScene.origin ?? 'core');
            atlas[quality] = print;
        }
        return Object.keys(pages).length ? { pages, atlas } : undefined;
    }

    /**
     * Look up a registered scene by its runtime name (matches the editor's
     * `SceneRef.name`, e.g. `"scenes/main"`). Pass `scope` to disambiguate
     * when a core scene and a skin scene share the same name. Returns
     * `undefined` if absent.
     */
    public findScene(name: string, scope?: 'core' | 'skin'): OrcaSceneData | undefined {
        if (scope) return this.scenesByKey.get(`${scope}:${name}`);
        return this.scenesByName.get(name);
    }

    /**
     * Apply camera-space viewport transform so the scene fills the supplied
     * canvas dimensions.
     *
     * This exactly replicates the editor's camera-mode draw logic:
     *   fitScale      = min(width / effW, gameAreaHeight / effH)
     *   effectiveZoom = camera.zoom * fitScale
     *   origin        = centre of game-area band − effectiveCentre.xy * effectiveZoom
     * where effW × effH / effectiveCentre is the frame after `resolveChatBandFrame`.
     *
     * The supplied width/height should be the game's current renderer dimensions
     * (i.e. the camera output bounds).  Call this on every resize.
     *
     * If the loaded scene has no camera node the container is left at (0,0)
     * with scale 1 (world-space 1:1 mapping).
     */
    public drawScene(width: number, height: number): void {
        if (!this.currentScene || !this.currentContainer) return;

        const camera = this.findCameraNode(this.currentScene.nodes);
        const viewportWidth = Math.max(1, width);
        const viewportHeight = Math.max(1, height);

        // Build per-draw layout-override map. Active mode is derived from the
        // dimensions we were just handed (desktop still short-circuits on the
        // device singleton), so it can never lag a rotation the way the
        // device singleton's orientation can — which is also why we don't
        // subscribe to GLOBAL_ORIENTATION_CHANGE here.
        const activeMode = this.resolveActiveLayoutMode(viewportWidth, viewportHeight);
        // Selects a LayoutManager's optional `portraitChat` bucket while the chat is docked.
        const portraitChatOpen = this.chatBandShowing(viewportHeight);

        if (!camera) {
            this.scene3dLayer?.setFrame(null, viewportWidth, viewportHeight);
            const layoutOverrides = this.buildLayoutOverrideMap(
                this.currentScene.nodes, activeMode, portraitChatOpen, this.resolveLayoutProfileEnvironment(viewportWidth, viewportHeight),
            );
            this.currentContainer.position.set(0, 0);
            this.currentContainer.scale.set(1);
            // Reset counter-scale to identity when there's no camera state.
            this.counterScaleSystemMounts(1, 0, 0);
            // World == screen here, so a viewport-sized frame centred on the
            // synthetic camera lands screen-space canvases at the top-left.
            this.applyScreenSpaceCanvasTransforms(
                { ...IDENTITY_TRANSFORM, x: viewportWidth / 2, y: viewportHeight / 2 },
                viewportWidth,
                viewportHeight,
                1,
            );
            const overrideWrittenIdsNoCamera = this.applyLayoutOverrideTransforms(layoutOverrides);
            // No camera means no DECLARED root rect, so a root-level child's
            // anchor is inert — exactly as the editor treats a scene whose
            // camera wrapper is missing.
            this.applyRectTransforms(viewportWidth, viewportHeight, null, layoutOverrides, overrideWrittenIdsNoCamera);
            // World == screen here, so the screen a Fit to Area node fills is the viewport.
            this.applyResponsiveScalerTransforms(viewportWidth, viewportHeight, layoutOverrides, {
                left: 0,
                top: 0,
                right: viewportWidth,
                bottom: viewportHeight,
            });
            this.runAfterDrawHooks();
            return;
        }

        const cameraFrame = this.resolveCameraFrame(camera, activeMode);
        const frameWidth  = cameraFrame.width;
        const frameHeight = cameraFrame.height;
        const zoom        = (camera.zoom && camera.zoom > 0) ? camera.zoom : 1;

        // arcade-base shrinks device.gameHeight to the non-chat band (width *
        // HeightRatio) in portrait with the chat docked; fullscreenPortrait
        // overlays the chat instead, so that case fits the full canvas.
        // Opt-in: crop the frame to the chat band (see resolveChatBandFrame); off/null letterboxes the full frame into it.
        // The LIVE band, not canHideChat, gates the crop so a hideable chat re-crops on every toggle.
        const cropping = PORTRAIT_CHAT_CROP
            && activeMode === 'portrait'
            && width > 0
            && this.chatBandShowing(height);
        const gameAreaHeight = this.chatOverlaysGame() && !cropping ? height : Math.min(device.gameHeight, height);
        const chatBandRatio = cropping ? gameAreaHeight / width : null;
        // Frame mode (activeMode) still drives transposition and the crop gate; only the override bucket may differ.
        const overrideMode = resolveChatBandLayoutMode(frameWidth, frameHeight, chatBandRatio, activeMode);
        const cropLandscape = isChatBandLandscape(frameWidth, frameHeight, chatBandRatio);
        // Profiles match the LIVE viewport, not the chat-band override bucket.
        const layoutOverrides = this.buildLayoutOverrideMap(
            this.currentScene.nodes, overrideMode, portraitChatOpen, this.resolveLayoutProfileEnvironment(viewportWidth, viewportHeight),
        );

        // Resolve effective camera transform (LayoutManager override merges
        // shallowly over the camera's own transform).
        const cameraOverride = layoutOverrides.get(camera.id);
        const cameraTransform: OrcaTransform = cameraOverride?.transform
            ? { ...camera.transform, ...cameraOverride.transform }
            : camera.transform;

        const effectiveFrame = resolveChatBandFrame(
            frameWidth,
            frameHeight,
            cameraTransform.x,
            cameraTransform.y,
            chatBandRatio,
        );
        const effFrameWidth = effectiveFrame.width;
        const effFrameHeight = effectiveFrame.height;
        const frameCentreTransform: OrcaTransform = {
            ...cameraTransform,
            x: effectiveFrame.centerX,
            y: effectiveFrame.centerY,
        };

        const fitScale      = Math.min(width / effFrameWidth, gameAreaHeight / effFrameHeight);
        const effectiveZoom = zoom * fitScale;

        // Frame centre maps to the centre of the game-area band (== canvas centre when no chat band).
        const tx = (width  / 2) - (frameCentreTransform.x * effectiveZoom);
        const ty = (gameAreaHeight / 2) - (frameCentreTransform.y * effectiveZoom);

        this.currentContainer.scale.set(effectiveZoom);
        this.currentContainer.position.set(tx, ty);

        if (this.scene3dLayer) {
            // The fitted frame (camera zoom scales content, not the frame), centred on the game-area band.
            const frameScreenWidth = effFrameWidth * fitScale;
            const frameScreenHeight = effFrameHeight * fitScale;
            this.scene3dLayer.setFrame({
                x: (width - frameScreenWidth) / 2,
                y: (gameAreaHeight - frameScreenHeight) / 2,
                width: frameScreenWidth,
                height: frameScreenHeight,
            }, width, height);
        }

        // Counter-scale system-singleton mount targets so their hosted views
        // (which compute layout in stage-pixel coords assuming an identity
        // parent) are not double-transformed by currentContainer's letterbox.
        this.counterScaleSystemMounts(effectiveZoom, tx, ty);

        // Match editor camera mode for screen-space canvases.
        // They are anchored to the camera frame's top-left in world space and
        // inversely scaled against camera zoom so UI remains frame-locked.
        this.applyScreenSpaceCanvasTransforms(frameCentreTransform, effFrameWidth, effFrameHeight, zoom);
        const overrideWrittenIds = this.applyLayoutOverrideTransforms(layoutOverrides);
        // The scene-ROOT anchoring rect: the effective (orientation-transposed,
        // chat-band-cropped) camera frame, centred on its effective centre.
        const rootAnchorRect: AnchorRect = {
            centerX: Number.isFinite(frameCentreTransform.x) ? frameCentreTransform.x : 0,
            centerY: Number.isFinite(frameCentreTransform.y) ? frameCentreTransform.y : 0,
            width: effFrameWidth,
            height: effFrameHeight,
        };
        this.applyRectTransforms(effFrameWidth, effFrameHeight, rootAnchorRect, layoutOverrides, overrideWrittenIds);
        const safeFitScale = Math.max(0.0001, fitScale);
        const responsiveWidth = cropLandscape ? effFrameWidth : Math.max(1, viewportWidth / safeFitScale);
        // The chat strip is not visible game area, so the scaler reference stops at the band.
        const responsiveHeight = cropLandscape
            ? effFrameHeight
            : Math.max(1, (chatBandRatio !== null ? gameAreaHeight : viewportHeight) / safeFitScale);
        // The screen a Fit to Area node fills: what the player sees of the game
        // (the canvas, less a chat strip held open below it), in scene space.
        const safeEffectiveZoom = Math.max(0.0001, effectiveZoom);
        const screenHalfWidth = (width / 2) / safeEffectiveZoom;
        const screenHalfHeight = (gameAreaHeight / 2) / safeEffectiveZoom;
        // The band centre maps to the effective (chat-band-cropped) frame centre.
        const screenCenterX = Number.isFinite(frameCentreTransform.x) ? frameCentreTransform.x : 0;
        const screenCenterY = Number.isFinite(frameCentreTransform.y) ? frameCentreTransform.y : 0;
        this.applyResponsiveScalerTransforms(responsiveWidth, responsiveHeight, layoutOverrides, {
            left: screenCenterX - screenHalfWidth,
            top: screenCenterY - screenHalfHeight,
            right: screenCenterX + screenHalfWidth,
            bottom: screenCenterY + screenHalfHeight,
        });
        this.runAfterDrawHooks();
    }

    /**
     * True when the editor's `fullscreenPortrait` is on — mirrored into
     * `features.ts` as `canHideChat`, which arcade-base resolves per region into
     * `gameConfig.features`. A sub-game keeps arcade-base's own height ratio.
     */
    private chatOverlaysGame(): boolean {
        try {
            return gameConfig.features?.canHideChat === true && !queryStringParams.isSubGame;
        } catch {
            return false;
        }
    }

    /** True when launched as a game in game; the arcade-base getter can throw. */
    private isSubGame(): boolean {
        try {
            const value: unknown = queryStringParams.isSubGame;
            return value === true || value === 'true';
        } catch {
            return false;
        }
    }

    /** True while arcade-base has shrunk the game area for a docked chat / game-in-game / prize-league panel. */
    private chatBandShowing(height: number): boolean {
        const gameHeight = device.gameHeight;
        try {
            // Same-getter compare is exact; the canvas rect `height` can differ by sub-pixel rounding.
            const available = (device as unknown as { availableHeight?: unknown }).availableHeight;
            if (!queryStringParams.isSubGame && typeof available === 'number' && Number.isFinite(available)) {
                return gameHeight < available;
            }
        } catch {
            // Fall through to the canvas-height test.
        }
        return gameHeight < height;
    }

    /** Return the container for the currently loaded scene (may be null). */
    public getCurrentContainer(): PixiContainer | null {
        return this.currentContainer;
    }

    /** Return the data for the currently loaded scene (may be null). */
    public getCurrentScene(): OrcaSceneData | null {
        return this.currentScene;
    }

    /**
     * Editor-driven hot reload for re-baked assets (sprite Resolution
     * change, texture re-process, etc.). Called from `editor-integration`
     * in response to an `orca-asset-invalidated` postMessage from the
     * editor.
     *
     * Steps:
     *   1. Bump `assetCacheBust` so subsequent fetch URLs carry `?v=N`.
     *   2. Evict matching entries from Pixi 8's `Assets` cache. Pixi 6's three
     *      URL/name-keyed maps (`PIXI.utils.BaseTextureCache`,
     *      `PIXI.utils.TextureCache`, `PIXI.Loader.shared.resources`) are all
     *      gone, and Pixi 8's `Cache` exposes no key enumeration — so eviction
     *      walks `registeredAssetAliases`, this manager's own ledger of the
     *      SCOPE-QUALIFIED aliases it registered. `Assets.unload` drops the
     *      cache entry AND destroys the underlying `TextureSource`, which is
     *      what steps (2a) and (2b) used to do separately. Dropping the alias
     *      from the ledger is what lets the next preload re-`add` it against
     *      the new `?v=N` URL (the old `loader.add` skip-if-present hazard).
     *   3. Clear matching entries from internal `spriteDescriptorTextureCache`
     *      + `unavailableSceneTexturePaths` so descriptors are re-resolved
     *      against the freshly written `.sprite.json`.
     *   4. Re-run scene-wide preloads so re-fetched textures land in the
     *      `Assets` cache before scene rebuild.
     *   5. Rebuild the current scene container so sprites pick up new
     *      textures.
     *
     * `evictedBaseTextures` and `evictedLoaderResources` are retained for the
     * `editor-integration` stats payload but are now structurally always 0:
     * Pixi 8 has no separate BaseTexture cache (source destruction is folded
     * into `Assets.unload`, counted by `evictedTextures`) and no shared Loader.
     *
     * Empty `paths` means "invalidate everything".
     */
    public async invalidateAndReloadCurrentScene(paths: string[]): Promise<{
        evictedBaseTextures: number;
        evictedTextures: number;
        evictedLoaderResources: number;
        evictedDescriptors: number;
    }> {
        const matchAny = (key: string): boolean => {
            if (paths.length === 0) return true;
            for (const p of paths) {
                if (p && key.indexOf(p) !== -1) return true;
            }
            return false;
        };

        this.assetCacheBust += 1;

        // Pixi 8: no BaseTexture cache and no shared Loader to walk.
        const evictedBaseTextures = 0;
        const evictedLoaderResources = 0;
        let evictedTextures = 0;
        let evictedDescriptors = 0;

        // Aliases are SCOPE-QUALIFIED (`core/3.png` vs `skins/<skin>/3.png`),
        // so an invalidated bare path legitimately matches both buckets'
        // entries via substring — exactly as the old URL-keyed walk did — while
        // a scoped path still evicts only its own bucket.
        const staleAliases = Array.from(this.registeredAssetAliases).filter(matchAny);

        for (const alias of staleAliases) {
            this.registeredAssetAliases.delete(alias);
            try {
                await Pixi.Assets.unload(alias);
                evictedTextures += 1;
            } catch (err) {
                // Never loaded, or already unloaded — drop the cache entry
                // directly so the alias can be re-registered against `?v=N`.
                try {
                    Pixi.Cache.remove(alias);
                    evictedTextures += 1;
                } catch {
                    console.warn(`[SceneManager] Could not evict cached asset "${alias}" during invalidation.`, err);
                }
            }
        }

        for (const key of Array.from(this.spriteDescriptorTextureCache.keys())) {
            const entry = this.spriteDescriptorTextureCache.get(key);
            const texturePath = entry?.texturePath || '';
            if (matchAny(key) || (texturePath && matchAny(texturePath))) {
                this.spriteDescriptorTextureCache.delete(key);
                evictedDescriptors += 1;
            }
        }

        // Evict spritesheet frame textures whose SCOPE-QUALIFIED descriptor key
        // matches an invalidated path. `preloadSceneTextureAssets` re-runs below
        // (re-fetching with the new `?v=N` cache-bust) and repopulates them.
        for (const key of Array.from(this.spritesheetFrameTextureCache.keys())) {
            if (matchAny(key)) {
                this.spritesheetFrameTextureCache.delete(key);
            }
        }

        // Parsed SkeletonData seeded by `preloadSceneSpineAssets`, keyed
        // `<scope-qualified skeleton>::<atlas>`. Evicting the `Assets` alias
        // above is not enough on its own — the build path probes this map
        // first, so a re-baked skeleton/atlas would otherwise never re-parse.
        for (const key of Array.from(this.sceneSpineDataCache.keys())) {
            if (matchAny(key)) this.sceneSpineDataCache.delete(key);
        }

        for (const key of Array.from(this.unavailableSceneTexturePaths)) {
            if (matchAny(key)) this.unavailableSceneTexturePaths.delete(key);
        }

        // Re-run preloads so the evicted entries are re-fetched (with the new
        // `?v=N` cache-bust query) and re-registered before the scene rebuild
        // pulls textures out of the `Assets` cache.
        try {
            await this.preloadSceneTextureAssets();
        } catch (err) {
            console.warn('[SceneManager] Texture preload during invalidation failed:', err);
        }
        try {
            await this.preloadSceneSpineAssets();
        } catch (err) {
            console.warn('[SceneManager] Spine preload during invalidation failed:', err);
        }

        if (this.currentScene && this.currentScene.name) {
            const scope = (this.currentScene as any).origin || undefined;
            this.loadScene(this.currentScene.name, scope);
        }

        return { evictedBaseTextures, evictedTextures, evictedLoaderResources, evictedDescriptors };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DDOL / scene-teardown helpers
    // ─────────────────────────────────────────────────────────────────────────

    private getOrCreateDontDestroyContainer(): PixiContainer {
        if (!this.dontDestroyContainer) {
            // Typed (not the loose `PIXI` façade) so the assignment narrows
            // `dontDestroyContainer` away from `| null` for the return below.
            const c = new Pixi.Container();
            c.label = '__orca_dontDestroyOnLoad';
            c.sortableChildren = true;
            this.dontDestroyContainer = c;
        }
        return this.dontDestroyContainer;
    }

    private getDontDestroyKey(node: OrcaSceneNode): string {
        const name = (node.name ?? '').trim();
        return name.length > 0 ? `name:${name}` : `id:${node.id}`;
    }

    /**
     * Walk a container tree and detach every displayObject flagged __ddol,
     * re-parenting it to the persistent dontDestroyContainer. Walks
     * depth-first so nested DDOL containers under non-DDOL parents are
     * preserved when the parent is later destroyed.
     */
    private detachDontDestroySubtrees(root: PixiContainer): void {
        const ddolHost = this.getOrCreateDontDestroyContainer();
        const visit = (container: PixiContainer): void => {
            if (!container || !Array.isArray(container.children)) return;
            // Snapshot — addChild mutates the parent's children array.
            const children = container.children.slice();
            for (const child of children) {
                if ((child as { __ddol?: boolean }).__ddol === true) {
                    if (child !== ddolHost) {
                        ddolHost.addChild(child);
                    }
                    continue;
                }
                // Never descend into a Spine slot wrapper: lifting a DDOL node
                // out of it would leave the skeleton driving an empty wrapper,
                // and the node itself unpositioned. `applySpineSlotAttachment`
                // already refuses to put a DDOL node in a slot, so this only
                // catches a subtree reparented there by user code.
                if ((child as OrcaSpineSlotWrapper).__orcaSpineSlotWrapper === true) {
                    if (!this.warnedSpineSlotDdol && this.subtreeHasDontDestroy(child as PixiContainer)) {
                        this.warnedSpineSlotDdol = true;
                        console.warn(
                            '[SceneManager] dontDestroyOnLoad is ignored inside a Spine slot attachment: a node attached to a slot cannot outlive the skeleton that positions it.',
                        );
                    }
                    continue;
                }
                if (Array.isArray((child as PixiContainer).children)) {
                    visit(child as PixiContainer);
                }
            }
        };
        visit(root);
    }

    /** Does any object in this subtree (inclusive) carry the DDOL flag? */
    private subtreeHasDontDestroy(root: PixiContainer): boolean {
        if (!root) return false;
        if ((root as { __ddol?: boolean }).__ddol === true) return true;
        const children = root.children;
        if (!Array.isArray(children)) return false;
        for (const child of children) {
            if (this.subtreeHasDontDestroy(child as PixiContainer)) return true;
        }
        return false;
    }

    /**
     * Destroy the current scene container while preserving DDOL subtrees,
     * then reset per-scene tracking maps. Spines that ended up under the
     * persistent dontDestroyContainer are re-added to activeSceneSpines so
     * update() keeps animating them after the load.
     */
    private teardownCurrentScene(): void {
        if (this.currentContainer) {
            // Park externally-attached system views (cabinet / jackpots /
            // chat overlay) on the DDOL host BEFORE detaching DDOL subtrees
            // and destroying the scene container. Without this, the views
            // would be destroyed alongside the scene container.
            this.parkAttachedViewsForTeardown();
            this.detachDontDestroySubtrees(this.currentContainer);
            this.currentContainer.destroy({ children: true });
        }
        // The 3D section belongs to the scene being torn down.
        this.scene3dLayer?.deactivate();
        // Mount targets belonged to the now-destroyed scene container.
        this.cabinetMountTarget = null;
        this.jackpotsMountTarget = null;
        this.chatOverlayMountTarget = null;
        // Kill animation-clip timelines BEFORE the node registry is dropped —
        // they tween DisplayObjects that have just been destroyed. Lazily
        // required so the module graph stays acyclic at eval time
        // (animation-player -> methods/node-ref -> scene-manager).
        try {
            const animationPlayer = require('./animation-player').default as { stopAll(): void };
            animationPlayer.stopAll();
        } catch (err) {
            console.warn('[SceneManager] Failed to stop animation clips on teardown', err);
        }

        // Custom components: the destroy above already fired each non-DDOL
        // node's `destroyed` handler, which tore its components down. Sweep for
        // any that slipped through. A registration holds its OWN node +
        // displayObject references, so the nodeDisplayObjects.clear() below
        // cannot orphan a live instance. DDOL subtrees were REPARENTED, not
        // destroyed, so their components survive the swap still tracked for
        // updates — which is the DDOL contract.
        for (const registration of Array.from(this.activeSceneComponents)) {
            if (registration.ddol) continue;
            if ((registration.displayObject as { destroyed?: boolean } | null)?.destroyed) {
                this.teardownComponentRegistration(registration);
            }
        }

        this.nodeDisplayObjects.clear();
        this.nodeDataById.clear();
        this.ikHandleIds.clear();
        this.ikMixById.clear();
        this.skinnedMeshIds.clear();
        this.activeSceneSpines.clear();
        this.previousLayoutOverrideIds.clear();
        this.localizationOverrides.clear();

        // Re-register spines now living under the DDOL host so their state
        // continues to advance via update().
        if (this.dontDestroyContainer) {
            this.collectSpinesUnder(this.dontDestroyContainer, this.activeSceneSpines);
        }
    }

    private collectSpinesUnder(node: PixiDisplayObject, out: Set<Spine>): void {
        if (!node) return;
        if (node instanceof Spine) {
            out.add(node);
        }
        const children = (node as PixiContainer).children;
        if (Array.isArray(children)) {
            for (const child of children) this.collectSpinesUnder(child, out);
        }
    }

    public update(deltaSeconds: number): void {
        if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
            return;
        }

        for (const spine of Array.from(this.activeSceneSpines)) {
            if ((spine as unknown as { destroyed?: boolean }).destroyed) {
                this.activeSceneSpines.delete(spine);
                continue;
            }

            if ((spine as unknown as { parent?: unknown }).parent) {
                spine.update(deltaSeconds);
            }
        }

        this.updateCustomComponents(deltaSeconds * 1000);
        this.updateParticleEmitters(deltaSeconds);
        this.sweepInjectedChildDrawOrder();
        this.solveIkHandles();
        this.updateSkinnedMeshes();
        this.updateParallaxes(deltaSeconds);
        if (this.flexLayoutFallback && this.hostStage) {
            this.flexLayoutFallback.update(this.hostStage);
        }
        this.scene3dLayer?.render(deltaSeconds);
    }

    /**
     * Hand a node to `@pixi/layout`. The system surfaces never take part: their
     * views are positioned by arcade-base, not by the scene.
     */
    private applyFlexLayout(displayObject: PixiDisplayObject, node: OrcaSceneNode): void {
        if (node.type === 'camera' || node.type === 'cabinet' || node.type === 'jackpotsModule' || node.type === 'chatOverlay') return;
        const style = resolveFlexLayoutStyle(node.flexLayout);
        if (!style) return;
        if (!getYoga()) {
            this.pendingFlexLayouts.push({ target: displayObject, style });
            this.ensureFlexLayoutFallback();
            return;
        }
        this.assignFlexLayout(displayObject, style, node.name);
    }

    private assignFlexLayout(target: PixiContainer, style: Record<string, FlexLayoutValue>, label: string): void {
        try {
            (target as unknown as { layout: unknown }).layout = style;
        } catch (err) {
            console.warn(`[SceneManager] Flex layout could not be applied to "${label}":`, err);
        }
    }

    private ensureFlexLayoutFallback(): void {
        if (this.flexLayoutFallbackInit) return;
        const system = new LayoutSystem();
        this.flexLayoutFallbackInit = system.init().then(() => {
            if (!this.hostRenderer?.layout) this.flexLayoutFallback = system;
            const pending = this.pendingFlexLayouts;
            this.pendingFlexLayouts = [];
            for (const entry of pending) {
                if (!entry.target.destroyed) this.assignFlexLayout(entry.target, entry.style, entry.target.label);
            }
        }).catch((err) => {
            this.pendingFlexLayouts = [];
            console.warn('[SceneManager] Flex layout is unavailable — Yoga failed to load:', err);
        });
    }

    private updateParticleEmitters(deltaSeconds: number): void {
        for (const emitter of Array.from(this.activeParticleEmitters)) {
            if (emitter.destroyed) {
                this.activeParticleEmitters.delete(emitter);
                continue;
            }
            if (!emitter.emit && emitter.particleCount === 0) continue;
            try {
                emitter.update(deltaSeconds);
            } catch (err) {
                // A per-frame thrower would flood the console; drop it once.
                console.error('[SceneManager] Particle emitter update failed; stopping it.', err);
                emitter.destroy();
                this.activeParticleEmitters.delete(emitter);
            }
        }
    }

    /**
     * Build a `particles` node: a plain container hosting an
     * `OrcaParticleEmitter` (Pixi 8 `ParticleContainer`s). FlowState
     * `methods/particles.ts` reaches the emitter through `__particleEmitter`.
     */
    private buildParticleEmitter(node: OrcaSceneNode): PixiContainer {
        const container = new Pixi.Container();
        try {
            const emitter = new OrcaParticleEmitter(container, node.config ?? {}, {
                resolveTexture: (ref) => this.resolveParticleTexture(ref, node.name),
                warn: (message) => console.warn(`[SceneManager] Particle node "${node.name}": ${message}`),
            });
            emitter.emit = node.autoStart !== false;
            (container as PixiContainer & { __particleEmitter?: OrcaParticleEmitter }).__particleEmitter = emitter;
            this.activeParticleEmitters.add(emitter);
            container.once('destroyed', () => {
                emitter.destroy();
                this.activeParticleEmitters.delete(emitter);
            });
        } catch (e) {
            console.error(`[SceneManager] Error creating particle emitter for "${node.name}":`, e);
        }
        return container;
    }

    /**
     * Particle textures are never preloaded (the runtime scene's
     * `assets.bundles` is empty), so they always take the lazy on-demand path;
     * a genuine 404 is reported by `loadTextureOnDemand`. Only the "resolved to
     * the white placeholder" case is flagged here, with the URL it expected.
     */
    private resolveParticleTexture(ref: string, nodeLabel: string): PixiTexture {
        const texture = this.resolveTextureFromPath(ref, ['pixi:texture', 'pixi:particleTexture']);
        if (!texture || texture === Pixi.Texture.WHITE || texture === Pixi.Texture.EMPTY) {
            const scope = this.activeBuildOrigin;
            const expectedUrl = this.toAbsoluteSceneAssetUrl(
                this.scopeQualifyRef(this.normalizeSceneAssetPath(ref), scope),
            );
            console.warn(
                `[SceneManager] Particle node "${nodeLabel}": texture "${ref}" could not be resolved `
                + `(scene scope "${scope}", expected ${expectedUrl}). Particles will render as plain white quads. `
                + 'Re-save the scene in Orca so `sync-skin-assets` re-mirrors it.',
            );
            return Pixi.Texture.WHITE;
        }
        return texture;
    }

    /**
     * Bend every skinned mesh to its bones' live transforms — the SAME
     * deformation the editor canvas runs (`skinned-mesh.ts`), after the clip
     * and the IK solve wrote this frame. Never throws.
     */
    private updateSkinnedMeshes(): void {
        if (this.skinnedMeshIds.size === 0) return;
        const resolve = (id: string): PixiDisplayObject | null => {
            const obj = this.nodeDisplayObjects.get(id);
            return obj && !(obj as { destroyed?: boolean }).destroyed ? obj : null;
        };
        for (const id of this.skinnedMeshIds) {
            const mesh = resolve(id);
            if (!(mesh instanceof Pixi.MeshSimple)) continue;
            const prepared = this.skinnedMeshPrepared.get(mesh);
            if (!prepared) continue;
            try {
                if (updateSkinnedMesh(mesh, prepared, mesh.vertices, resolve)) {
                    mesh.geometry.getBuffer('aPosition').update();
                }
            } catch (err) {
                console.warn('[SceneManager] skinned mesh update failed', err);
            }
        }
    }

    /**
     * A parallax background (`parallax.ts`, the parity twin of the editor's):
     * one tiling strip per layer, the back layer added first so the first draws
     * in front, in a holder whose bounds are the node's declared area. Scene
     * children draw on top of the holder. Scrolls from the first tick.
     */
    private buildParallax(node: OrcaSceneNode): PixiContainer {
        const data = normalizeParallax(node);
        const root = new Pixi.Container();
        root.sortableChildren = true;
        const layersRoot = new Pixi.Container();
        layersRoot.label = '__orcaParallaxLayers';
        layersRoot.boundsArea = new Pixi.Rectangle(-data.width / 2, -data.height / 2, data.width, data.height);
        root.addChild(layersRoot);
        const layers = data.layers.map((layer): OrcaParallaxLayerView => {
            const sprite = new Pixi.TilingSprite({ texture: Pixi.Texture.EMPTY, width: data.width, height: 1 });
            sprite.visible = false;
            const view: OrcaParallaxLayerView = {
                sprite,
                // Resolved here, while `activeBuildOrigin` is this scene's bucket.
                base: layer.texture ? this.resolveStaticNodeTextureFromPath(layer.texture) : null,
                drawn: null,
            };
            sprite.once('destroyed', () => this.releaseParallaxDrawnTexture(view));
            return view;
        });
        for (let index = layers.length - 1; index >= 0; index -= 1) layersRoot.addChild(layers[index].sprite);
        const view: OrcaParallaxView = { root, data, layers, travel: 0 };
        this.layoutParallax(view);
        this.parallaxViews.add(view);
        return root;
    }

    /** Place every strip at the view's travel; a layer whose image has not arrived stays hidden. */
    private layoutParallax(view: OrcaParallaxView): void {
        for (let index = 0; index < view.layers.length; index += 1) {
            const layer = view.layers[index];
            const sprite = layer.sprite;
            if ((sprite as { destroyed?: boolean }).destroyed) continue;
            const drawn = this.parallaxDrawnTexture(layer);
            if (!drawn) {
                sprite.visible = false;
                continue;
            }
            const place = placeParallaxLayer(view.data, view.data.layers[index], drawn.width, drawn.height, view.travel);
            if (sprite.texture !== drawn) sprite.texture = drawn;
            sprite.position.set(place.x, place.y);
            if (sprite.width !== place.width) sprite.width = place.width;
            if (sprite.height !== place.height) sprite.height = place.height;
            sprite.tileScale.set(place.tileScale, place.tileScale);
            sprite.tilePosition.set(place.tileX, 0);
            sprite.visible = place.height > 0;
        }
    }

    /**
     * What a layer draws: its image, or a trimmed frame of it the layer owns
     * (`parallaxDrawnFrameHeight`). Re-derived when an on-demand image lands,
     * because that swaps the placeholder's source in place.
     */
    private parallaxDrawnTexture(layer: OrcaParallaxLayerView): PixiTexture | null {
        const base = layer.base;
        // An on-demand load draws the shared 1x1 `Texture.WHITE` source until it lands.
        if (!base || base.destroyed || !this.isTextureReady(base) || base.source === Pixi.Texture.WHITE.source) {
            this.releaseParallaxDrawnTexture(layer);
            return null;
        }
        const frame = base.frame;
        const trimmed = parallaxDrawnFrameHeight(frame.width, frame.height, base.source.width, base.source.height, base.rotate !== 0);
        if (trimmed === null) {
            this.releaseParallaxDrawnTexture(layer);
            return base;
        }
        const current = layer.drawn;
        if (
            current && !current.destroyed && current.source === base.source
            && current.frame.x === frame.x && current.frame.y === frame.y
            && current.frame.width === frame.width && current.frame.height === trimmed
        ) {
            return current;
        }
        const next = new Pixi.Texture({ source: base.source, frame: new Pixi.Rectangle(frame.x, frame.y, frame.width, trimmed) });
        this.releaseParallaxDrawnTexture(layer, next);
        layer.drawn = next;
        return next;
    }

    /** Destroy a layer's trimmed frame (never the image), moving its strip onto `replacement` first. */
    private releaseParallaxDrawnTexture(layer: OrcaParallaxLayerView, replacement: PixiTexture = Pixi.Texture.EMPTY): void {
        const drawn = layer.drawn;
        layer.drawn = null;
        if (!drawn) return;
        if (!(layer.sprite as { destroyed?: boolean }).destroyed && layer.sprite.texture === drawn) {
            layer.sprite.texture = replacement;
        }
        if (!drawn.destroyed) drawn.destroy(false);
    }

    /** Scroll every built parallax and drop the destroyed ones. Never throws. */
    private updateParallaxes(deltaSeconds: number): void {
        if (this.parallaxViews.size === 0) return;
        for (const view of Array.from(this.parallaxViews)) {
            if ((view.root as { destroyed?: boolean }).destroyed) {
                this.parallaxViews.delete(view);
                continue;
            }
            try {
                view.travel = advanceParallaxTravel(view.travel, view.data.speed, deltaSeconds);
                this.layoutParallax(view);
            } catch (err) {
                console.warn('[SceneManager] parallax update failed', err);
            }
        }
    }

    /**
     * Bend every IK chain toward its handle — the SAME solve the editor canvas
     * runs (`animation-ik.ts`), on the live display objects only, after this
     * frame's clip writes. Never throws.
     */
    private solveIkHandles(): void {
        if (this.ikHandleIds.size === 0) return;
        const resolve = (id: string): IkDisplayObjectLike | null => {
            const obj = this.nodeDisplayObjects.get(id);
            return obj && !(obj as { destroyed?: boolean }).destroyed ? (obj as unknown as IkDisplayObjectLike) : null;
        };
        const active: Array<{ handle: IkDisplayObjectLike; ik: NormalizedIk }> = [];
        for (const id of this.ikHandleIds) {
            const node = this.nodeDataById.get(id);
            const handle = resolve(id);
            if (!node?.ik || !handle) continue;
            const keyed = this.ikMixById.get(id);
            const ik = normalizeIkComponent(keyed === undefined ? node.ik : { ...node.ik, mix: keyed });
            if (ik) active.push({ handle, ik });
        }
        try {
            applyIkHandles(active, resolve);
        } catch (err) {
            console.warn('[SceneManager] IK solve failed', err);
        }
    }

    /**
     * Tick every tracked custom component. `update()` is fed SECONDS by the
     * host ticker but the authoring contract is `onUpdate(deltaMs)`, so the
     * conversion happens once, here.
     *
     * A component that throws is reported ONCE and then dropped from the
     * ticker (it stays alive for teardown) — a per-frame thrower would
     * otherwise flood the console. One failure never stops its siblings.
     */
    private updateCustomComponents(deltaMs: number): void {
        if (this.componentUpdateQueue.size === 0) return;

        for (const registration of Array.from(this.componentUpdateQueue)) {
            if (registration.tornDown) {
                this.componentUpdateQueue.delete(registration);
                continue;
            }

            if ((registration.displayObject as { destroyed?: boolean } | null)?.destroyed) {
                this.teardownComponentRegistration(registration);
                continue;
            }

            const onUpdate = registration.instance.onUpdate;
            if (typeof onUpdate !== 'function') {
                this.componentUpdateQueue.delete(registration);
                continue;
            }

            try {
                onUpdate.call(registration.instance, deltaMs);
            } catch (e) {
                console.error(
                    `[SceneManager] Custom component "${registration.componentType}" on node "${registration.node?.name ?? '?'}" (id "${registration.node?.id ?? '?'}") threw in onUpdate — removing it from the update loop:`,
                    e,
                );
                this.untrackComponentForUpdates(registration);
            }
        }
    }

    public trackSpineForUpdates(spine: Spine | null | undefined): void {
        if (!spine || (spine as unknown as { destroyed?: boolean }).destroyed) {
            return;
        }

        this.activeSceneSpines.add(spine);
    }

    public untrackSpineForUpdates(spine: Spine | null | undefined): void {
        if (!spine) {
            return;
        }

        this.activeSceneSpines.delete(spine);
    }

    private trackComponentForUpdates(registration: OrcaComponentRegistration | null | undefined): void {
        if (!registration || registration.tornDown) {
            return;
        }

        this.componentUpdateQueue.add(registration);
    }

    private untrackComponentForUpdates(registration: OrcaComponentRegistration | null | undefined): void {
        if (!registration) {
            return;
        }

        this.componentUpdateQueue.delete(registration);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Custom components (user-authored OrcaComponent subclasses)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Instantiate every authored custom component on a node.
     *
     * Called at the very END of finishNodeBuild — after the child subtree is
     * built and registered in `nodeDisplayObjects`, and after the clip mask is
     * applied — so a component's `onCreate` can already resolve its own
     * descendants via `orca.getDisplayObjectById`.
     *
     * The authored array is fully untrusted. Every failure mode (missing
     * entry, unknown type, throwing constructor / __orcaInit / onCreate) warns
     * and continues; nothing here may unwind into the scene build.
     */
    private instantiateCustomComponents(displayObject: PixiDisplayObject, node: OrcaSceneNode): void {
        const authored = node?.customComponents;
        if (!Array.isArray(authored) || authored.length === 0) return;

        // A DDOL node reused across a scene swap returns early from buildNode
        // (before finishNodeBuild), so this cannot run twice for the same
        // display object — this stamp is belt-and-braces for any future path
        // that re-finishes an already-built object.
        const stamp = displayObject as { __orcaComponentsInstantiated?: boolean };
        if (stamp.__orcaComponentsInstantiated === true) return;
        stamp.__orcaComponentsInstantiated = true;

        const injectedChildren = this.createInjectedChildTracker(displayObject);
        const options: OrcaComponentHostOptions = {
            host: '2d',
            ddol: (displayObject as { __ddol?: boolean }).__ddol === true,
            injectedChildren,
            resolveAsset: (ref) => this.resolveStaticNodeTextureFromPath(ref),
        };

        for (const entry of authored) {
            const registration = this.createComponentRegistration(entry, node, displayObject, options);
            if (registration) {
                // Teardown is driven off the display object for BOTH DDOL and
                // non-DDOL nodes. A DDOL object is reparented (never destroyed)
                // by teardownCurrentScene, so this simply never fires on a
                // scene swap — which is exactly the DDOL contract.
                if (typeof (displayObject as { once?: unknown }).once === 'function') {
                    (displayObject as PixiContainer).once('destroyed', () => {
                        this.teardownComponentRegistration(registration);
                    });
                }
                this.runComponentOnCreate(registration);
            }

            // A thrower may still have added objects, and one failure must not
            // skip the stamping of the node's other components.
            this.stampInjectedChildDrawOrder(injectedChildren);
        }
    }

    /**
     * The `Scene3DComponentHost` handed to the 3D layer: the SAME registration,
     * context, update-loop and teardown machinery as 2D nodes, with the
     * Object3D as host and `assetRef`s resolved to scoped URL strings.
     */
    private create3DComponentHost(origin: SceneOrigin): Scene3DComponentHost {
        return {
            attach: (node, object3d, env) => {
                const authored = Array.isArray(node?.customComponents)
                    ? (node.customComponents as OrcaAuthoredCustomComponent[])
                    : [];
                const options: OrcaComponentHostOptions = {
                    host: '3d',
                    ddol: false,
                    injectedChildren: null,
                    resolveAsset: (ref) => this.toAbsoluteSceneAssetUrl(ref, origin),
                    three: env,
                };
                const registrations: OrcaComponentRegistration[] = [];
                for (const entry of authored) {
                    const registration = this.createComponentRegistration(entry, node, object3d, options);
                    if (registration) registrations.push(registration);
                }
                if (registrations.length === 0) return null;
                return {
                    start: () => {
                        for (const registration of registrations) this.runComponentOnCreate(registration);
                    },
                    destroy: () => {
                        for (const registration of registrations) this.teardownComponentRegistration(registration);
                    },
                };
            },
        };
    }

    /**
     * Construct one authored component, `__orcaInit` it and register it for
     * updates and teardown — everything except `onCreate`, which the caller
     * runs via `runComponentOnCreate` once the host's tree is built.
     *
     * The authored entry is fully untrusted. Every failure mode (missing
     * entry, unknown type, wrong target, throwing constructor / __orcaInit)
     * warns and returns null; nothing here may unwind into the scene build.
     */
    private createComponentRegistration(
        entry: OrcaAuthoredCustomComponent | null | undefined,
        node: OrcaSceneNode | OrcaScene3DNode,
        host: unknown,
        options: OrcaComponentHostOptions,
    ): OrcaComponentRegistration | null {
        if (!entry || typeof entry !== 'object') return null;
        if (entry.enabled === false) return null;

        const componentType = typeof entry.type === 'string' ? entry.type : '';
        const registered = componentType
            ? (customComponents as Record<string, { ctor?: unknown; definition?: any } | undefined>)[componentType]
            : undefined;

        if (!registered || typeof registered.ctor !== 'function') {
            console.warn(
                `[SceneManager] Unknown custom component type "${componentType}" on node "${node?.name ?? '?'}" (id "${node?.id ?? '?'}") — skipping it.`,
            );
            return null;
        }

        const rawTarget = (registered.definition as any)?.target;
        const target = rawTarget === '3d' || rawTarget === 'any' ? rawTarget : '2d';
        if (target !== 'any' && target !== options.host) {
            const key = `${options.host}:${componentType}`;
            if (!this.warnedComponentTargets.has(key)) {
                this.warnedComponentTargets.add(key);
                console.warn(
                    `[SceneManager] Custom component "${componentType}" targets ${target} nodes but is attached to a ${options.host} node (e.g. "${node?.name ?? '?'}") — skipping it.`,
                );
            }
            return null;
        }

        let registration: OrcaComponentRegistration | null = null;
        try {
            const Ctor = registered.ctor as new () => OrcaComponent;
            const instance = new Ctor();

            registration = {
                instance,
                displayObject: host as PixiDisplayObject,
                node,
                componentType,
                subscriptions: [],
                ddol: options.ddol,
                tornDown: false,
                injectedChildren: options.injectedChildren,
            };

            const properties = this.mergeComponentProperties(registered.definition, entry.properties);
            this.resolveComponentAssetProperties(
                properties,
                entry.assetProperties,
                registered.definition,
                options.resolveAsset,
            );

            const context = this.createComponentContext(registration, options.three);
            // The 5th argument (the host Object3D) only exists for 3D hosts.
            const init = instance.__orcaInit as (...args: unknown[]) => void;
            if (options.three) init.call(instance, node, host, properties, context, host);
            else init.call(instance, node, host, properties, context);

            this.activeSceneComponents.add(registration);
            if (typeof instance.onUpdate === 'function') {
                this.trackComponentForUpdates(registration);
            }
            return registration;
        } catch (e) {
            console.error(
                `[SceneManager] Custom component "${componentType}" on node "${node?.name ?? '?'}" (id "${node?.id ?? '?'}") failed to initialise — skipping it:`,
                e,
            );
            if (registration) {
                this.teardownComponentRegistration(registration, { skipOnDestroy: true });
            }
            return null;
        }
    }

    private runComponentOnCreate(registration: OrcaComponentRegistration): void {
        if (registration.tornDown) return;
        try {
            registration.instance.onCreate?.();
        } catch (e) {
            console.error(
                `[SceneManager] Custom component "${registration.componentType}" on node "${registration.node?.name ?? '?'}" (id "${registration.node?.id ?? '?'}") failed to initialise — skipping it:`,
                e,
            );
            // Drop the half-built instance but still release anything its
            // onCreate managed to subscribe to before throwing.
            this.teardownComponentRegistration(registration, { skipOnDestroy: true });
        }
    }

    /**
     * Snapshot a node's authored children (and its snapshot mask) BEFORE any of
     * its components run, so anything found in the container afterwards can
     * only have come from user code.
     */
    private createInjectedChildTracker(host: PixiDisplayObject): OrcaInjectedChildTracker | null {
        const children = (host as PixiContainer)?.children;
        if (!Array.isArray(children)) return null;

        let maxZIndex = 0;
        const known = new Set<PixiDisplayObject>();
        for (const child of children) {
            known.add(child);
            const zIndex = typeof child?.zIndex === 'number' ? child.zIndex : 0;
            if (zIndex > maxZIndex) maxZIndex = zIndex;
        }

        return { host, known, childCount: children.length, nextZIndex: maxZIndex + 1 };
    }

    /**
     * Lift every newly-injected object above the host's authored children, so
     * `addChild` from a component reads the way plain PIXI does — on top.
     * Authored children carry an `applyHierarchyDrawOrder` zIndex >= 1 while an
     * injected object keeps PIXI's default 0, which a sortable container would
     * otherwise sort to the BACK.
     *
     * An object whose zIndex is already non-zero was placed deliberately by the
     * component and is left alone; the rest keep their relative insertion order.
     */
    private stampInjectedChildDrawOrder(tracker: OrcaInjectedChildTracker | null): void {
        if (!tracker) return;

        const children = tracker.host?.children;
        if (!Array.isArray(children)) return;

        // A `spine` node's skeleton arrives asynchronously (addChildAt 0) long
        // after its components ran — it is the node's own art, not injected.
        const resolved = (tracker.host as OrcaResolvedDisplayObjectWrapper).__orcaResolvedDisplayObject;

        for (const child of children) {
            if (tracker.known.has(child)) continue;
            tracker.known.add(child);
            if (child === resolved) continue;
            if (child?.zIndex === 0) child.zIndex = tracker.nextZIndex++;
        }

        tracker.childCount = children.length;
    }

    /**
     * Catch objects a component added AFTER onCreate (from onUpdate, or from an
     * event handler). O(1) per component per frame; the O(children) pass runs
     * only when the host's child count actually moved.
     */
    private sweepInjectedChildDrawOrder(): void {
        if (this.activeSceneComponents.size === 0) return;

        for (const registration of this.activeSceneComponents) {
            const tracker = registration.injectedChildren;
            if (!tracker || registration.tornDown) continue;

            const children = tracker.host?.children;
            if (!Array.isArray(children) || children.length === tracker.childCount) continue;

            this.stampInjectedChildDrawOrder(tracker);
        }
    }

    /**
     * Authored values merged OVER the definition defaults. Authored keys win;
     * gaps fall back to `definition.properties[].default`. Authored keys the
     * definition doesn't declare are kept as-is.
     */
    private mergeComponentProperties(
        definition: { properties?: Array<{ name?: unknown; default?: unknown }> } | null | undefined,
        authored: Record<string, unknown> | null | undefined,
    ): Record<string, any> {
        const merged: Record<string, any> = {};

        const defs = definition?.properties;
        if (Array.isArray(defs)) {
            for (const def of defs) {
                if (!def || typeof def.name !== 'string' || def.name.length === 0) continue;
                if (def.default !== undefined) merged[def.name] = def.default;
            }
        }

        if (authored && typeof authored === 'object' && !Array.isArray(authored)) {
            for (const key of Object.keys(authored)) {
                const value = authored[key];
                if (value !== undefined) merged[key] = value;
            }
        }

        return merged;
    }

    /**
     * Overlay a component's persisted `assetRef` paths onto its merged property
     * record as resolved textures, so the two-record split stays invisible to
     * the author.
     *
     * EVERY value in `assetProperties` is an asset ref by construction, so that
     * walk is structural. The DEFINITION is consulted for a second, unavoidable
     * pass: the editor OMITS unset asset keys (dropping the record entirely when
     * it would be empty), while the parser normalizes an `assetRef` declared
     * without a default to `default: ''` — so a never-assigned texture would
     * otherwise reach the author as `''`, the one type the base-class contract
     * says cannot occur. Every declared `assetRef` is therefore forced to `null`
     * unless a non-empty ref was persisted. (The preload COLLECTOR and the
     * editor-side scanner stay definition-free — neither can reach the component
     * registry — which is why the rule differs there.)
     *
     * Kept out of `mergeComponentProperties` (which must stay a pure function of
     * its two arguments) because resolution reads the current build pass's scope.
     *
     * Runs INSIDE the synchronous build (buildSceneContainer → buildNode →
     * finishNodeBuild → instantiateCustomComponents), so
     * `resolveStaticNodeTextureFromPath` sees the OWNING scene's
     * `activeBuildOrigin` and a bare ref resolves from the right bucket.
     * An unset/empty ref yields `null` — the value the base-class contract
     * documents and the one an author can test for; a SET but unresolvable ref
     * keeps the file-wide `PIXI.Texture.WHITE` missing-texture fallback.
     * On a 3D host `resolve` yields the scoped `/assets/…` URL string instead.
     */
    private resolveComponentAssetProperties(
        merged: Record<string, any>,
        assetProperties: Record<string, string> | null | undefined,
        definition: { properties?: Array<{ name?: unknown; type?: unknown }> } | null | undefined,
        resolve: (rawPath: string) => unknown,
    ): void {
        const refs =
            assetProperties && typeof assetProperties === 'object' && !Array.isArray(assetProperties)
                ? assetProperties
                : null;

        if (refs) {
            for (const key of Object.keys(refs)) {
                const raw = refs[key];
                const rawPath = typeof raw === 'string' ? raw.trim() : '';
                // An asset value alwaysresolvekey.
                merged[key] = rawPath ? this.resolveStaticNodeTextureFromPath(rawPath) : null;
            }
        }

        const defs = definition?.properties;
        if (!Array.isArray(defs)) return;

        for (const def of defs) {
            if (!def || def.type !== 'assetRef') continue;
            const name = def.name;
            if (typeof name !== 'string' || name.length === 0) continue;
            const raw = refs ? refs[name] : undefined;
            if (typeof raw !== 'string' || raw.trim().length === 0) merged[name] = null;
        }
    }

    /**
     * The per-instance `orca` context injected by __orcaInit. Built per
     * component (not shared) because `on` records each subscription against
     * that instance so teardown can auto-`off` everything it left open —
     * nothing else in the runtime does this, and a leaked handler would
     * otherwise survive scene swaps.
     */
    private createComponentContext(
        registration: OrcaComponentRegistration,
        three?: Scene3DComponentEnv,
    ): OrcaComponentContext {
        const context = this.createBaseComponentContext(registration);
        if (!three) return context;
        return {
            ...context,
            three: three.THREE,
            getObject3DById: (nodeId: string) => {
                try {
                    return three.getObject3DById(nodeId) ?? null;
                } catch {
                    return null;
                }
            },
        } as OrcaComponentContext;
    }

    private createBaseComponentContext(registration: OrcaComponentRegistration): OrcaComponentContext {
        const manager = this;
        const label = (): string =>
            `"${registration.componentType}" on node "${registration.node?.name ?? '?'}" (id "${registration.node?.id ?? '?'}")`;

        return {
            getGameModelProperty: (propertyName: string) => getGameModelProperty(propertyName as any),
            setGameModelProperty: (propertyName: string, value: unknown) =>
                setGameModelProperty(propertyName as any, value as any),
            getSettingsModelProperty: (propertyName: string) => getSettingsModelProperty(propertyName as any),
            setSettingsModelProperty: (propertyName: string, value: unknown) =>
                setSettingsModelProperty(propertyName as any, value as any),

            on: (eventName: string, handler: (payload?: any) => void): void => {
                if (!eventName || typeof handler !== 'function' || registration.tornDown) return;
                try {
                    eventEmitter.on(eventName as any, handler as any);
                } catch (e) {
                    console.warn(`[SceneManager] Custom component ${label()} failed to subscribe to "${eventName}":`, e);
                    return;
                }
                registration.subscriptions.push({ eventName, handler });
            },

            off: (eventName: string, handler: (payload?: any) => void): void => {
                if (!eventName || typeof handler !== 'function') return;
                try {
                    eventEmitter.off(eventName as any, handler as any);
                } catch { /* ignored */ }
                const index = registration.subscriptions.findIndex(
                    (sub) => sub.eventName === eventName && sub.handler === handler,
                );
                if (index >= 0) registration.subscriptions.splice(index, 1);
            },

            // PAYLOAD CONTRACT: event-triggers/custom-events.ts forwards an
            // event argument to a flow starter ONLY when it is a plain object
            // (arrays / scalars / null forward `undefined`), so an Orca custom
            // event's pass-props must be sent as a single object keyed by prop
            // name. Not enforced here — anything else simply arrives at flow
            // starters as no args.
            emit: (eventName: string, payload?: Record<string, unknown>): void => {
                if (!eventName) return;
                try {
                    eventEmitter.emit(eventName as any, payload as any);
                } catch (e) {
                    console.warn(`[SceneManager] Custom component ${label()} failed to emit "${eventName}":`, e);
                }
            },

            getDisplayObjectById: (nodeId: string) => manager.getDisplayObjectById(nodeId) ?? null,

            loadScene: (name: string, scope?: 'core' | 'skin'): void => {
                try {
                    manager.loadScene(name, scope);
                } catch (e) {
                    console.warn(`[SceneManager] Custom component ${label()} failed to load scene "${name}":`, e);
                }
            },

            unloadScene: (name?: string, scope?: 'core' | 'skin'): void => {
                try {
                    manager.unloadScene(name, scope);
                } catch (e) {
                    console.warn(`[SceneManager] Custom component ${label()} failed to unload scene:`, e);
                }
            },
        };
    }

    /**
     * Retire one component instance: drop it from the update loop and the live
     * registry, run `onDestroy` (individually guarded), then auto-`off` every
     * subscription it opened. Idempotent.
     */
    private teardownComponentRegistration(
        registration: OrcaComponentRegistration | null | undefined,
        options?: { skipOnDestroy?: boolean },
    ): void {
        if (!registration || registration.tornDown) return;
        registration.tornDown = true;

        this.componentUpdateQueue.delete(registration);
        this.activeSceneComponents.delete(registration);

        if (options?.skipOnDestroy !== true) {
            try {
                registration.instance?.onDestroy?.();
            } catch (e) {
                console.error(
                    `[SceneManager] Custom component "${registration.componentType}" on node "${registration.node?.name ?? '?'}" (id "${registration.node?.id ?? '?'}") threw in onDestroy:`,
                    e,
                );
            }
        }

        for (const sub of registration.subscriptions.splice(0)) {
            try {
                eventEmitter.off(sub.eventName as any, sub.handler as any);
            } catch { /* ignored */ }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Localization (LocalizationManager component)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * The language code localization overrides are read from.
     *
     * SINGLE SOURCE OF TRUTH: this consumes `methods/translations.ts`'s public
     * `getTranslationLocale()`, which IS the authored resolution ladder
     * (`?locale=` exact own-key hit -> case-insensitive match -> the generated
     * `ORCA_TRANSLATION_BASE_LANGUAGE`) and which already wraps the
     * `queryStringParams.locale` read in a try/catch — that arcade-base getter
     * THROWS when the param is absent. Re-deriving the ladder here would let
     * the two drift, so this is the ONLY locale read in the scene manager.
     *
     * Resolved once and cached: `queryStringParams` is populated at module-eval
     * from the URL and never changes for the page lifetime.
     *
     * '' means "no localization" — a project that declares no translations
     * degrades to no overrides at all, never to a throw.
     */
    private getLocalizationLocale(): string {
        if (this.localizationLocale !== null) return this.localizationLocale;

        let resolved = '';
        try {
            resolved = translations.getTranslationLocale();
        } catch (err) {
            console.warn('[SceneManager] Could not resolve the active locale; localization overrides are disabled.', err);
            resolved = '';
        }

        this.localizationLocale = typeof resolved === 'string' ? resolved.trim().toLowerCase() : '';
        return this.localizationLocale;
    }

    /**
     * The ACTIVE locale's entry table for one LocalizationManager, or null.
     * The base-language rung of the ladder already ran inside
     * `getLocalizationLocale()`; the case-insensitive pass here is defensive
     * against a hand-edited scene file (the exporter normalizes its keys).
     */
    private resolveLocalizationEntries(
        manager: OrcaLocalizationManager | undefined,
    ): Record<string, OrcaLocalizationEntry> | null {
        const locales = manager?.locales;
        if (!locales || typeof locales !== 'object' || Array.isArray(locales)) return null;

        const locale = this.getLocalizationLocale();
        if (!locale) return null;

        if (Object.prototype.hasOwnProperty.call(locales, locale)) {
            return locales[locale]?.entries ?? null;
        }

        const match = Object.keys(locales).find((code) => code.trim().toLowerCase() === locale);
        return match ? (locales[match]?.entries ?? null) : null;
    }

    /**
     * Build the scene's node id -> localized entry map ONCE. Walks the tree
     * tracking the innermost ancestor LocalizationManager — a deeper one fully
     * REPLACES the outer host's entries for that subtree (the editor enforces
     * no-nesting; this is the defensive runtime implementation, and mirrors
     * `buildLayoutOverrideMap`'s walk).
     */
    private buildLocalizationOverrideMap(roots: OrcaSceneNode[] | undefined): Map<string, OrcaLocalizationEntry> {
        const overrides = new Map<string, OrcaLocalizationEntry>();
        if (!Array.isArray(roots) || roots.length === 0) return overrides;
        // Cheap exit for the overwhelmingly common case (no declared locale, or
        // no component anywhere): never walk the tree at all.
        if (!this.getLocalizationLocale()) return overrides;

        const walk = (node: OrcaSceneNode, activeEntries: Record<string, OrcaLocalizationEntry> | null): void => {
            let nextActiveEntries = activeEntries;
            if (node.localizationManager) {
                nextActiveEntries = this.resolveLocalizationEntries(node.localizationManager);
            }
            if (nextActiveEntries) {
                const entry = nextActiveEntries[node.id];
                if (entry && typeof entry === 'object') overrides.set(node.id, entry);
            }
            if (Array.isArray(node.children) && node.children.length > 0) {
                for (const child of node.children) walk(child, nextActiveEntries);
            }
        };

        for (const root of roots) walk(root, null);
        return overrides;
    }

    /**
     * Stamp the localization overrides for a scene ahead of a SYNCHRONOUS walk
     * of its nodes — the preload collectors and `buildSceneContainer`. Same
     * ambient-field contract as `activeBuildOrigin`.
     */
    private beginSceneLocalization(scene: OrcaSceneData): void {
        this.localizationOverrides = this.buildLocalizationOverrideMap(scene?.nodes);
    }

    /**
     * Every localized plain-image ref in the stamped map (`texture` /
     * `assetPath` and each `frames[]` entry), so `preloadSceneTextureAssets`
     * registers and probes the LOCALIZED binary rather than only the base one.
     *
     * That probe is also what makes the build-time degradation below possible:
     * a localized ref the server 404s lands in `unavailableSceneTexturePaths`
     * BEFORE the synchronous build, so `localizeNode` can fall the node back to
     * its base ref without waiting on an async load.
     *
     * Descriptor (`*.sprite.json`), spritesheet-frame and spine refs are
     * reached by the sibling collectors instead — those walk the LOCALIZED
     * node, so they already see the substituted path.
     */
    private collectLocalizedTexturePaths(): string[] {
        const paths: string[] = [];
        if (this.localizationOverrides.size === 0) return paths;

        const add = (raw: unknown): void => {
            if (typeof raw !== 'string') return;
            const normalized = this.normalizeSceneAssetPath(raw);
            if (normalized && !paths.includes(normalized)) paths.push(normalized);
        };

        for (const entry of this.localizationOverrides.values()) {
            const assets = entry.assets;
            if (assets && typeof assets === 'object' && !Array.isArray(assets)) {
                add(assets.texture);
                add(assets.assetPath);
            }
            if (Array.isArray(entry.frames)) {
                for (const frame of entry.frames) add(frame);
            }
        }

        return paths;
    }

    /**
     * True when a localized ref is KNOWN-missing for the scene being built.
     *
     * The ref is scope-qualified against the OWNING scene's `activeBuildOrigin`
     * — never the active skin — exactly like every other scene asset ref, so a
     * localized `3.png` can never be judged by (or collide with) another
     * bucket's file of the same name.
     */
    private isLocalizedRefUnavailable(normalizedRef: string): boolean {
        if (!normalizedRef) return true;
        return this.unavailableSceneTexturePaths.has(
            this.scopeQualifyRef(normalizedRef, this.activeBuildOrigin),
        );
    }

    private warnLocalizedRefOnce(scopedKey: string, message: string): void {
        if (this.warnedLocalizedRefs.has(scopedKey)) return;
        this.warnedLocalizedRefs.add(scopedKey);
        console.warn(`[SceneManager] ${message}`);
    }

    /**
     * The ref a node should actually build with: the localized one, or the BASE
     * one when the localized binary is known-missing (one warn per ref, ever).
     * Never a hard failure and never a blank node.
     */
    private resolveLocalizedRef(node: OrcaSceneNode, field: string, localizedRef: string, baseRef: string): string {
        const normalized = this.normalizeSceneAssetPath(localizedRef);
        if (!normalized) return baseRef;
        if (!this.isLocalizedRefUnavailable(normalized)) return localizedRef;

        this.warnLocalizedRefOnce(
            this.scopeQualifyRef(normalized, this.activeBuildOrigin),
            `Localized "${field}" for locale "${this.getLocalizationLocale()}" could not be loaded on node `
            + `"${node.name ?? '?'}" (id "${node.id ?? '?'}"): "${localizedRef}" — falling back to "${baseRef || '(none)'}".`,
        );
        return baseRef;
    }

    /**
     * Apply the active locale's entry for a node, returning a SHALLOW clone
     * carrying the substituted text / asset refs (or the node itself when
     * nothing applies, which is the common case).
     *
     * Called at the top of `buildNode` and from the preload collectors, so the
     * substitution always lands BEFORE `Assets` resolution and the localized
     * binary is the one actually fetched. `children` is shared by reference, so
     * descendants are localized by their own `buildNode` / visit call.
     */
    private localizeNode(node: OrcaSceneNode): OrcaSceneNode {
        if (this.localizationOverrides.size === 0) return node;
        const entry = this.localizationOverrides.get(node.id);
        if (!entry) return node;

        let localized: OrcaSceneNode | null = null;
        const target = (): OrcaSceneNode => {
            if (!localized) localized = { ...node };
            return localized;
        };

        if (typeof entry.text === 'string') {
            target().text = entry.text;
        }

        const assets = entry.assets;
        if (assets && typeof assets === 'object' && !Array.isArray(assets)) {
            for (const key of Object.keys(assets)) {
                const raw = assets[key];
                if (typeof raw !== 'string' || !raw.trim()) continue;
                if (!LOCALIZABLE_ASSET_KEYS.has(key)) {
                    this.warnLocalizedRefOnce(
                        `unsupported:${key}`,
                        `Localization entry uses unsupported asset property "${key}" — ignoring it.`,
                    );
                    continue;
                }
                const baseValue = (node as unknown as Record<string, unknown>)[key];
                const baseRef = typeof baseValue === 'string' ? baseValue : '';
                const resolved = this.resolveLocalizedRef(node, key, raw.trim(), baseRef);
                (target() as unknown as Record<string, unknown>)[key] = resolved;
            }
        }

        if (Array.isArray(entry.frames) && entry.frames.length > 0) {
            const frames = entry.frames.filter((frame): frame is string => typeof frame === 'string' && !!frame.trim());
            // A frame sequence is ATOMIC: if any localized frame is missing we
            // keep the ENTIRE base list rather than build a half-localized
            // animation (or one whose frame count silently changed).
            const missing = frames.find((frame) => this.isLocalizedRefUnavailable(this.normalizeSceneAssetPath(frame)));
            if (frames.length === 0) {
                // nothing usable — leave the authored frames alone
            } else if (missing) {
                this.warnLocalizedRefOnce(
                    this.scopeQualifyRef(this.normalizeSceneAssetPath(missing), this.activeBuildOrigin),
                    `Localized frame for locale "${this.getLocalizationLocale()}" could not be loaded on node `
                    + `"${node.name ?? '?'}" (id "${node.id ?? '?'}"): "${missing}" — falling back to the authored frames.`,
                );
            } else {
                target().textures = frames;
            }
        }

        return localized ?? node;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scene construction
    // ─────────────────────────────────────────────────────────────────────────

    private buildSceneContainer(scene: OrcaSceneData): PixiContainer {
        // Stamp the scope of the scene being built so the synchronous
        // texture / sprite-descriptor / video / spine resolvers downstream
        // qualify every BARE ref with this scene's bucket (`core` vs
        // `skins/<ACTIVE_SKIN>`). buildSceneContainer is synchronous and
        // non-reentrant, so this remains valid for the whole build pass.
        this.activeBuildOrigin = scene.origin ?? 'core';
        // Resolve the active locale's overrides ONCE for the whole build, not
        // per draw (see `localizationOverrides`).
        this.beginSceneLocalization(scene);
        const root = new Pixi.Container();
        root.label = scene.name;
        root.sortableChildren = true;
        const topLevelEntries: Array<{ node: OrcaSceneNode; displayObject: PixiDisplayObject }> = [];

        for (const node of scene.nodes) {
            // Per-node guard: a single node that throws during construction
            // (e.g. a reels node referencing a missing/404 sprite frame) must
            // not abort the whole scene build and blank the stage. Skip the
            // failed node and keep building its siblings.
            let obj: PixiDisplayObject | null = null;
            try {
                obj = this.buildNode(node);
            } catch (e) {
                console.warn(
                    `[SceneManager] Failed to build node "${node?.name ?? '?'}" (id "${node?.id ?? '?'}", type "${node?.type ?? '?'}") — skipping it and continuing scene build:`,
                    e,
                );
                obj = null;
            }
            if (obj) {
                root.addChild(obj);
                topLevelEntries.push({ node, displayObject: obj });
            }
        }

        this.applyHierarchyDrawOrder(root, topLevelEntries);

        return root;
    }

    /**
     * The `(spritesheetPath, spritesheetFrame)` pair for a sprite-family node,
     * or null when the node isn't frame-mode. SINGLE SOURCE OF TRUTH for the
     * locked "BOTH fields non-empty, else fall back to whole-image `texture`"
     * contract: `resolveSpriteFamilyTexture` (build) and
     * `collectSceneSpritesheetFrameRefs` (preload) both go through it, so the
     * preload can never disagree with the build about what frame mode is.
     */
    private readSpritesheetFrameRef(node: OrcaSceneNode): { path: string; frame: string } | null {
        if (!SPRITE_FAMILY_TEXTURE_TYPES.has(node.type)) return null;
        const path = typeof node.spritesheetPath === 'string' ? node.spritesheetPath.trim() : '';
        const frame = typeof node.spritesheetFrame === 'string' ? node.spritesheetFrame.trim() : '';
        return path && frame ? { path, frame } : null;
    }

    /**
     * Resolve the base texture for a sprite-family node. Shared verbatim by the
     * `sprite` and `scratchableItem` build branches so the two can never drift.
     */
    private resolveSpriteFamilyTexture(node: OrcaSceneNode): PixiTexture {
        const frameRef = this.readSpritesheetFrameRef(node);
        if (frameRef) {
            return this.resolveSpritesheetFrameTexture(frameRef.path, frameRef.frame, this.activeBuildOrigin);
        }
        return node.texture ? this.resolveStaticNodeTextureFromPath(node.texture) : Pixi.Texture.EMPTY;
    }

    /**
     * TARGETED RESCUE for a reused `dontDestroyOnLoad` scratch panel.
     *
     * The DDOL reuse path rebinds an existing display object and RETURNS before
     * the type switch, so `attachScratchBehaviour` never runs again for it. A
     * first wire that degraded — e.g. the panel's plain `<name>.png` texture was
     * still an on-demand 1x1 placeholder when the scene first built — would
     * therefore be PERMANENT, unrescuable by any later `loadScene`.
     *
     * Runs ONLY when no handle was ever stashed. Re-wiring a live handle would
     * double-bind the pointer handlers and orphan the existing mask, so the
     * absence of `__orcaScratchHandle` is the whole gate. This is a rescue, not
     * a general DDOL rebuild — do not widen it.
     */
    private rescueDdolScratchBehaviour(reused: PixiDisplayObject, node: OrcaSceneNode): void {
        if (node.type !== 'scratchableItem') return;
        if (!(reused instanceof Pixi.Sprite)) return;
        const sprite = reused as ScratchableItemDisplay;
        if (sprite.__orcaScratchHandle) return;
        attachScratchBehaviour(sprite, node, {
            renderer: this.hostRenderer,
            stage: this.hostStage,
            resolveTexture: (ref: string) => this.resolveStaticNodeTextureFromPath(ref),
        });
    }

    private buildNode(sourceNode: OrcaSceneNode): PixiDisplayObject | null {
        // Locale substitution FIRST so every branch below — and every asset
        // resolver they call — sees the localized text / refs, and the ref is
        // swapped BEFORE `Assets` resolution. A no-op (returns `sourceNode`
        // itself) when this node carries no entry for the active locale.
        const node = this.localizeNode(sourceNode);

        // DDOL reuse / fresh-build registration — works for ANY node type.
        // PIXI reparenting applies to any DisplayObject (sprite / graphics /
        // text all extend Container), so a node of any type flagged
        // dontDestroyOnLoad survives loadScene / unloadScene exactly like a
        // DDOL container. If a same-keyed displayObject is alive in the DDOL
        // host, rebind it into the new scene tree at this slot, refreshing
        // common properties from the new scene but preserving its children.
        // `ddolRegisterKey` is set when a FRESH build should be registered +
        // marked __ddol after the type switch below.
        let ddolRegisterKey: string | null = null;
        if (node.dontDestroyOnLoad === true) {
            const key = this.getDontDestroyKey(node);

            if (this.ddolKeysBoundThisLoad.has(key)) {
                console.warn(
                    `[SceneManager] Duplicate dontDestroyOnLoad key "${key}" in scene "${this.currentScene?.name ?? '?'}" (node "${node.name}", id "${node.id}"). The first occurrence wins; rebuilding this one as a fresh non-DDOL node for this load.`,
                );
                // Fall through to normal build path below — do NOT mark __ddol.
            } else {
                this.ddolKeysBoundThisLoad.add(key);
                const reused = this.dontDestroyByKey.get(key);

                if (reused && !(reused as { destroyed?: boolean }).destroyed) {
                    // Rebind: detach from current parent, refresh common props,
                    // skip rebuilding children (preserved across loads).
                    if (reused.parent) reused.parent.removeChild(reused);
                    this.applyTransform(reused, node.transform, node);
                    reused.visible = node.visible;
                    reused.alpha = node.alpha;
                    this.resetLayoutAssertion(reused);
                    this.resetParentAnchorWrite(reused);
                    reused.label = node.name;
                    this.applyFilters(reused, node.filters);
                    (reused as { __ddol?: boolean }).__ddol = true;
                    this.nodeDisplayObjects.set(node.id, reused);
                    this.nodeDataById.set(node.id, node);
                    if (node.ik) this.ikHandleIds.add(node.id);
                    if (node.type === 'skinnedMesh') this.skinnedMeshIds.add(node.id);
                    this.rescueDdolScratchBehaviour(reused, node);
                    return reused;
                }

                // First time we've seen this DDOL slot — build fresh below,
                // then register + mark __ddol before children are attached.
                ddolRegisterKey = key;
            }
        }

        let displayObject: PixiDisplayObject;

        switch (node.type) {
            case 'container':
            case 'canvas':
            case 'camera': {
                const c = new Pixi.Container();
                c.sortableChildren = true;
                displayObject = c;
                break;
            }
            // System-singleton mount points. These are placeholder containers
            // whose position among root-level siblings dictates draw order
            // for the externally-constructed cabinet / jackpots panel /
            // chat-overlay views. The host wires the real views in via
            // attachCabinet/Jackpots/ChatOverlay; if no host attaches a view
            // the placeholder simply renders nothing (matching legacy behaviour
            // where these singletons had no visual presence in the scene tree).
            case 'cabinet': {
                const c = new Pixi.Container();
                c.sortableChildren = true;
                c.label = '__orca_cabinetMount';
                this.cabinetMountTarget = c;
                displayObject = c;
                break;
            }
            case 'jackpotsModule': {
                const c = new Pixi.Container();
                c.sortableChildren = true;
                c.label = '__orca_jackpotsMount';
                this.jackpotsMountTarget = c;
                displayObject = c;
                break;
            }
            case 'chatOverlay': {
                const c = new Pixi.Container();
                c.sortableChildren = true;
                c.label = '__orca_chatOverlayMount';
                this.chatOverlayMountTarget = c;
                displayObject = c;
                break;
            }
            case 'sprite': {
                // Frame-qualified sprite — render a single frame of a packed
                // multi-page atlas. Takes precedence over the whole-image
                // `texture` path ONLY when BOTH fields are present. Shared with
                // `scratchableItem` via `resolveSpriteFamilyTexture`.
                const sprite = new Pixi.Sprite(this.resolveSpriteFamilyTexture(node));
                if (node.width  && node.width  > 0) sprite.width  = node.width;
                if (node.height && node.height > 0) sprite.height = node.height;
                if (node.tint   !== undefined)       sprite.tint   = node.tint;
                if (node.blendMode) {
                    sprite.blendMode = this.resolveBlendMode(node.blendMode);
                }
                displayObject = sprite;
                break;
            }
            case 'scratchableItem': {
                // Scratch-card panel. Built EXACTLY like a `sprite` (SAME
                // `resolveSpriteFamilyTexture` branch, same
                // tint/blendMode/width/height handling) — the scratch-to-reveal
                // behaviour is bolted on afterwards by the component module.
                const texture = this.resolveSpriteFamilyTexture(node);
                // Diagnostic ONLY (build-time, once per node, never per frame):
                // separates "the texture never resolved" from "the scratch mask
                // ate the sprite" when a panel comes out invisible.
                // `Texture.WHITE` is the resolvers' own missing-texture
                // fallback and they already warn for it, so it isn't repeated.
                if (!this.isTextureReady(texture)) {
                    console.warn(
                        `[FlowState/scratchableItem] Node "${node.name ?? '?'}" resolved no valid texture at build time `
                        + `(texture="${node.texture ?? ''}", spritesheetPath="${node.spritesheetPath ?? ''}", `
                        + `spritesheetFrame="${node.spritesheetFrame ?? ''}") — it will render nothing until the texture loads.`,
                    );
                }
                const sprite = new Pixi.Sprite(texture);
                if (node.width  && node.width  > 0) sprite.width  = node.width;
                if (node.height && node.height > 0) sprite.height = node.height;
                if (node.tint   !== undefined)       sprite.tint   = node.tint;
                if (node.blendMode) {
                    sprite.blendMode = this.resolveBlendMode(node.blendMode);
                }
                // MASK SLOT OWNERSHIP: the scratch RenderTexture takes
                // `sprite.mask` unconditionally. That is safe because a
                // `scratchableItem` cannot host the authored Mask component —
                // the editor's `SceneGraphService.normalizeNodeMask` strips it,
                // so `node.mask` is always absent and `applyContainerMask`
                // (which runs LAST, in finishNodeBuild) never touches this node.
                // Do NOT add a runtime branch that arbitrates the slot.
                //
                // The brush resolver is called SYNCHRONOUSLY by
                // attachScratchBehaviour, so `resolveStaticNodeTextureFromPath`
                // still sees this scene's `activeBuildOrigin`.
                //
                // ORDERING: `applyTransform` (finishNodeBuild, below) sets
                // `sprite.anchor` from the authored pivot AFTER this call, and
                // the layout-manager override pass re-applies it on resize. The
                // component therefore re-reads the anchor per frame rather than
                // capturing it here — do NOT "fix" this by applying the anchor
                // early, which cannot cover the later override pass.
                attachScratchBehaviour(sprite as ScratchableItemDisplay, node, {
                    renderer: this.hostRenderer,
                    stage: this.hostStage,
                    resolveTexture: (ref: string) => this.resolveStaticNodeTextureFromPath(ref),
                });
                displayObject = sprite;
                break;
            }
            case 'animatedSprite': {
                // `node.textures[]` is editor-baked at scene-export: it may be a long, repeated list of
                // frame paths and `node.animationSpeed` is derived from the Time Remap quantum (1 / (60 * q)).
                const frames = (node.textures ?? []).map(t => this.resolveTextureFromPath(t, ['pixi:texture', 'pixi:animatedSpriteFrame']));
                const anim = frames.length > 0
                    ? new Pixi.AnimatedSprite(frames)
                    : new Pixi.AnimatedSprite([Pixi.Texture.EMPTY]);
                // No `anim.width =`: Pixi re-applies a set width on every frame change, dropping the
                // node's scale. applyTransform's size override sizes it instead.
                if (node.tint        !== undefined) anim.tint        = node.tint;
                if (node.animationSpeed !== undefined) anim.animationSpeed = node.animationSpeed;
                anim.loop = node.loop ?? true;
                // `playing` is EDITOR-PREVIEW state (default false); `playOnLoad` is the
                // runtime contract (default true) — the same field the spine branch uses.
                // Absent => true, so scenes exported before the field still autoplay.
                if (node.playOnLoad ?? true) anim.play();
                if (node.blendMode) anim.blendMode = this.resolveBlendMode(node.blendMode);
                displayObject = anim;
                break;
            }
            case 'reels': {
                // Capture the owning scene's build scope synchronously so the
                // scope-aware URL resolver AND the async spine-data loader both
                // target this scene's bucket (`core` / `skins/<skin>`), even if
                // invoked after another scene has begun building.
                const reelsScope = this.activeBuildOrigin;
                // Called loosely: a project's `components/reels.ts` is only
                // re-injected on a scene save, so an older copy may still take
                // five parameters and must keep compiling (it ignores the rest).
                const buildReels = buildFlowstateReelsDisplay as unknown as (...args: unknown[]) => typeof displayObject;
                displayObject = buildReels(
                    node,
                    (path: string, atlasPath?: string) =>
                        atlasPath
                            ? this.resolveTextureFromAtlasFrame(atlasPath, path)
                            : this.resolveStaticNodeTextureFromPath(path),
                    // Scope-aware URL resolver for the `animatedSpriteAsset`
                    // first-frame descriptor + frame refs — captures the owning
                    // scene's origin so they resolve to `/assets/<scope>/<R>`
                    // like every other reels/scene texture (NOT page-relative).
                    (ref: string) => this.toAbsoluteSceneAssetUrl(ref, reelsScope),
                    // Scope-bound async spine-data loader for spine symbol-mode.
                    // The injected reels resolver is lookup-only and can't find
                    // the scope-qualified preload key; this self-heals by
                    // consuming that registration (or parsing the scoped URLs).
                    (skeletonPath: string) => this.loadReelSpineData(skeletonPath, reelsScope),
                    // Scope-qualified PATH (not URL) for per-symbol win audio:
                    // the sound-manager alias / dedup key IS the path, so it
                    // must carry the scope or a core and a skin file sharing a
                    // basename would collide on one alias.
                    (ref: string) => this.scopeQualifyRef(this.normalizeSceneAssetPath(ref), reelsScope),
                    // Symbol-text font FILES load exactly like a Text node's
                    // font and resolve the same hashed family. A failed load
                    // still draws with that family first: the page's
                    // `fonts-v2.css` declares it for every scene font.
                    (fontRef: string) => this.ensureSceneFontLoaded(fontRef, reelsScope)
                        .catch(() => `${this.getSceneFontFamily(fontRef)}, sans-serif`),
                );
                break;
            }
            case 'text': {
                const textNode = node as unknown as RichTextNode;
                if (hasRichText(textNode)) {
                    // Rich/multi-style text — compile the BASE flat fields + per-run
                    // overrides into an HTMLText (byte-identical compile to the
                    // editor for WYSIWYG parity).
                    const compiled = compileRichText(textNode, (family) => this.getSceneFontFamily(family));
                    const t = new Pixi.HTMLText({ text: compiled.text, style: compiled.style });
                    // Load every distinct base/run font file, then re-rasterize once so
                    // the compiled (hashed) families resolve to the real glyphs.
                    const families = new Set<string>();
                    if (textNode.fontFamily) families.add(textNode.fontFamily);
                    for (const run of textNode.richText ?? []) {
                        const family = run.style?.fontFamily;
                        if (family) families.add(family);
                    }
                    Promise.all([...families].map((family) => this.ensureSceneHtmlTextFontLoaded(family)))
                        .then(() => {
                            if (t.destroyed) return;
                            // Same-family writes don't bump styleKey; force a re-measure with the loaded font.
                            Pixi.CanvasTextMetrics.clearMetrics();
                            t.style.update();
                            t.onViewUpdate();
                        })
                        .catch(() => {
                            // Leave the compiled fonts in place when font loading fails.
                        });
                    displayObject = t;
                } else if (node.allowMarkup === true) {
                    // Opt-in translation markup (`@game-studio/htp-rich-text-editor`):
                    // the node's flat base style, with `node.text` (already
                    // localization-overridden) re-validated into HTMLText markup.
                    const { style } = compileRichText({ ...textNode, richText: [] }, (family) => this.getSceneFontFamily(family));
                    const t = new Pixi.HTMLText({ text: translationMarkupToHtmlText(textNode.text), style });
                    if (textNode.fontFamily) {
                        this.ensureSceneHtmlTextFontLoaded(textNode.fontFamily)
                            .then(() => {
                                if (t.destroyed) return;
                                // Same-family writes don't bump styleKey; force a re-measure with the loaded font.
                                Pixi.CanvasTextMetrics.clearMetrics();
                                t.style.update();
                                t.onViewUpdate();
                            })
                            .catch(() => {
                                // Leave the compiled font in place when font loading fails.
                            });
                    }
                    displayObject = t;
                } else {
                    const style = this.buildTextStyle(node);
                    // Pixi 8 caches rasterised text by its style key, so text drawn
                    // before its font loads keeps the fallback glyphs even when the
                    // same family is set again later. Until the font is usable, draw
                    // with a distinct family list; switching to the real family then
                    // changes the key and redraws.
                    if (typeof style.fontFamily === 'string' && !this.isSceneFontFamilyReady(node.fontFamily ?? '', style.fontFamily)) {
                        style.fontFamily = `${style.fontFamily}, sans-serif`;
                    }
                    // Pixi 8 `Text` is options-object only.
                    const t = new Pixi.Text({ text: node.text ?? '', style });
                    this.ensureSceneFontLoaded(node.fontFamily ?? '')
                        .then((fontFamily) => {
                            if (t.destroyed) return;
                            // Never write an empty/undefined family: Pixi 8 spreads the
                            // style over `defaultTextStyle`, so it would clobber the
                            // default rather than fall back to it, and `fontFamily.split`
                            // in `fontStringFromTextStyle` assumes a real string.
                            if (!fontFamily) return;
                            t.style.fontFamily = fontFamily;
                            // Same family string early-returns in the setter; drop stale fallback-font metrics and bump styleKey.
                            Pixi.CanvasTextMetrics.clearMetrics();
                            t.style.update();
                            // Pixi 8 replaced the `dirty` + `updateText` pair with
                            // a single view-invalidation call.
                            t.onViewUpdate();
                        })
                        .catch(() => {
                            // Leave the existing family in place when font loading fails.
                        });
                    displayObject = t;
                }
                break;
            }
            case 'graphics': {
                const g = new Pixi.Graphics();
                this.applyGraphicsCommands(g, node.commands ?? []);
                displayObject = g;
                break;
            }
            case 'nineSlice': {
                const texture = node.texture ? this.resolveStaticNodeTextureFromPath(node.texture) : Pixi.Texture.EMPTY;
                // Pixi 8 renamed `NineSlicePlane` → `NineSliceSprite` and takes an
                // options object. Omitting width/height defaults them to the
                // texture's own extent, exactly as the Pixi 6 ctor did.
                const ns = new Pixi.NineSliceSprite({
                    texture,
                    leftWidth:    node.leftWidth    ?? 0,
                    topHeight:    node.topHeight    ?? 0,
                    rightWidth:   node.rightWidth   ?? 0,
                    bottomHeight: node.bottomHeight ?? 0,
                });
                if (node.width  && node.width  > 0) ns.width  = node.width;
                if (node.height && node.height > 0) ns.height = node.height;
                if (node.tint !== undefined) (ns as any).tint = node.tint;
                displayObject = ns;
                break;
            }
            case 'tilingSprite': {
                const texture = node.texture ? this.resolveStaticNodeTextureFromPath(node.texture) : Pixi.Texture.EMPTY;
                const ts = new Pixi.TilingSprite({
                    texture,
                    width:  node.width  ?? 100,
                    height: node.height ?? 100,
                });
                if (node.tileScaleX    !== undefined) ts.tileScale.x    = node.tileScaleX;
                if (node.tileScaleY    !== undefined) ts.tileScale.y    = node.tileScaleY;
                if (node.tilePositionX !== undefined) ts.tilePosition.x = node.tilePositionX;
                if (node.tilePositionY !== undefined) ts.tilePosition.y = node.tilePositionY;
                if (node.tint          !== undefined) (ts as any).tint  = node.tint;
                if (node.blendMode) ts.blendMode = this.resolveBlendMode(node.blendMode);
                displayObject = ts;
                break;
            }
            case 'parallax': {
                displayObject = this.buildParallax(node);
                break;
            }
            case 'skinnedMesh': {
                // A texture on a grid mesh bent by its bones each frame
                // (`updateSkinnedMeshes`). Malformed data → an empty container.
                const prepared = prepareSkinnedMesh(node);
                if (!prepared) {
                    displayObject = new Pixi.Container();
                    break;
                }
                const mesh = new Pixi.MeshSimple({
                    texture: node.texture ? this.resolveStaticNodeTextureFromPath(node.texture) : Pixi.Texture.EMPTY,
                    vertices: prepared.positions.slice(),
                    uvs: prepared.uvs,
                    indices: prepared.indices,
                });
                mesh.autoUpdate = false;
                if (node.tint !== undefined) mesh.tint = node.tint;
                if (node.blendMode) mesh.blendMode = this.resolveBlendMode(node.blendMode);
                this.skinnedMeshPrepared.set(mesh, prepared);
                displayObject = mesh;
                break;
            }
            case 'spine': {
                try {
                    const { spineData, resolvedKey } = this.resolveSpineData(node);

                    if (spineData) {
                        displayObject = this.createSpineDisplayObject(node, spineData, resolvedKey);
                    } else {
                        const attemptedKeys = this.buildSpineLookupCandidates(node);
                        console.warn(
                            `[SceneManager] Spine data not loaded for node "${node.name}". Tried keys: ${attemptedKeys.join(', ') || '(none)'} (skeleton: "${node.skeleton ?? ''}", atlas: "${node.atlas ?? ''}"). Falling back to direct runtime load.`,
                        );
                        const spineContainer = new Pixi.Container();
                        this.loadSpineIntoContainer(spineContainer, node);
                        displayObject = spineContainer;
                    }
                } catch (e) {
                    console.error(`[SceneManager] Error creating Spine node "${node.name}":`, e);
                    displayObject = new Pixi.Container();
                }
                break;
            }
            case 'particles': {
                displayObject = this.buildParticleEmitter(node);
                break;
            }
            case 'video': {
                displayObject = this.buildVideoSprite(node, node.src ?? '', this.activeBuildOrigin);
                break;
            }
            case 'videoSequencer': {
                // Capture the build scope so deferred src swaps (advance-on-end
                // / flow-driven setIndex) keep resolving from this scene's
                // bucket even after another scene has been built.
                const videoScope = this.activeBuildOrigin;
                const videos = Array.isArray(node.videos) ? node.videos : [];
                const idx = Math.max(0, Math.min((node.activeIndex ?? 0) | 0, Math.max(0, videos.length - 1)));
                const activeSrc = videos[idx]?.src ?? '';
                const sprite = this.buildVideoSprite(node, activeSrc, videoScope);

                // Back-reference for FlowState methods/video-sequencer.ts.
                // Holds the playlist + a swap function bound to this sprite,
                // so flow nodes can drive next/previous/setIndex at runtime.
                let activeIndex = idx;
                const setIndex = (next: number) => {
                    if (videos.length === 0) return;
                    activeIndex = ((next % videos.length) + videos.length) % videos.length;
                    const el = (sprite as any).__videoEl as HTMLVideoElement | undefined;
                    const nextSrc = videos[activeIndex]?.src ?? '';
                    if (el) this.applyVideoSrcToElement(sprite, el, nextSrc, node, videoScope);
                };
                (sprite as any).__videoSequencer = {
                    get index() { return activeIndex; },
                    get count() { return videos.length; },
                    setIndex
                };

                if (node.advanceOnEnd && videos.length > 0) {
                    const el = (sprite as any).__videoEl as HTMLVideoElement | undefined;
                    if (el) {
                        el.addEventListener('ended', () => {
                            setIndex(activeIndex + 1);
                        });
                    }
                }

                displayObject = sprite;
                break;
            }
            default: {
                console.warn(`[SceneManager] Unsupported node type "${node.type}", using empty container`);
                displayObject = new Pixi.Container();
                break;
            }
        }

        // Register a fresh DDOL build BEFORE finishNodeBuild attaches children
        // (defensive against a child referencing the same key), so it can be
        // detached + re-bound across subsequent scene swaps regardless of type.
        if (ddolRegisterKey !== null) {
            (displayObject as { __ddol?: boolean }).__ddol = true;
            this.dontDestroyByKey.set(ddolRegisterKey, displayObject);
        }

        return this.finishNodeBuild(displayObject, node);
    }

    /**
     * Apply common properties + recursively attach children. Shared between
     * the normal buildNode path and the fresh-DDOL-container path. Returns
     * the same displayObject for chaining.
     */
    private finishNodeBuild(displayObject: PixiDisplayObject, node: OrcaSceneNode): PixiDisplayObject {
        // Apply common properties
        this.applyTransform(displayObject, node.transform, node);
        displayObject.visible = node.visible;
        displayObject.alpha   = node.alpha;
        this.resetLayoutAssertion(displayObject);
        this.resetParentAnchorWrite(displayObject);
        displayObject.label   = node.name;
        this.applyFilters(displayObject, node.filters);
        // Before children are added, so each child joins its parent's Yoga tree on `added`.
        this.applyFlexLayout(displayObject, node);
        this.nodeDisplayObjects.set(node.id, displayObject);
        this.nodeDataById.set(node.id, node);
        if (node.ik) this.ikHandleIds.add(node.id);
        if (node.type === 'skinnedMesh') this.skinnedMeshIds.add(node.id);

        // Recursively attach children
        if ('addChild' in displayObject && node.children.length > 0) {
            const container = displayObject as PixiContainer;
            const childEntries: Array<{ node: OrcaSceneNode; displayObject: PixiDisplayObject }> = [];

            for (const child of node.children) {
                // Per-node guard (recursive): a failing child must not abort
                // building its siblings or unwind to its ancestors. Skip it
                // and keep going so one broken node never blanks the stage.
                let childObj: PixiDisplayObject | null = null;
                try {
                    childObj = this.buildNode(child);
                } catch (e) {
                    console.warn(
                        `[SceneManager] Failed to build child node "${child?.name ?? '?'}" (id "${child?.id ?? '?'}", type "${child?.type ?? '?'}") — skipping it and continuing scene build:`,
                        e,
                    );
                    childObj = null;
                }
                if (childObj) {
                    container.addChild(childObj);
                    // Spine slot redirect. Runs HERE, before the
                    // applyContainerMask / applyButtonComponent /
                    // instantiateCustomComponents tail, so the wrapper is
                    // already in the spine's children when
                    // createInjectedChildTracker snapshots them — otherwise
                    // addSlotObject's internal addChild would be misread as a
                    // component-injected child and zIndex-stamped.
                    this.applySpineSlotAttachment(displayObject, node, child, childObj);
                    childEntries.push({ node: child, displayObject: childObj });
                }
            }

            this.applyHierarchyDrawOrder(container, childEntries);
            if (node.type === 'scratchableItem') this.bindScratchDebris(displayObject, node, childEntries);
        }

        // Clip mask COMPONENT — applied AFTER children are attached so the mask
        // object can live on the display list (PIXI requires a mask to be
        // on-stage). Valid on ANY node type (every PIXI node extends Container);
        // absent/disabled masks no-op.
        if (node.mask) {
            this.applyContainerMask(displayObject as PixiContainer, node);
        }

        // Canvas responsive scaling — mirrors the editor's scaler logic
        if (node.type === 'canvas' && node.scaler) {
            this.applyCanvasScalerTransform(displayObject as PixiContainer, node);
        }

        // Button component — before custom components so a component's
        // onCreate already sees the node interactive.
        this.applyButtonComponent(displayObject, node);

        // Custom components LAST — onCreate can then resolve this node's own
        // descendants, which are all built and registered by now.
        this.instantiateCustomComponents(displayObject, node);

        return displayObject;
    }

    /**
     * The FIRST authored `particles` child of a `scratchableItem` is its scratch
     * debris: silenced here, then started / stopped / moved by the scratch
     * component, which adopts it lazily on the first stroke.
     */
    private bindScratchDebris(
        sprite: PixiDisplayObject,
        node: OrcaSceneNode,
        entries: Array<{ node: OrcaSceneNode; displayObject: PixiDisplayObject }>,
    ): void {
        const authored = node.children.find((child) => child?.type === 'particles');
        if (!authored) return;
        const entry = entries.find((e) => e.node === authored);
        if (!entry) return;
        const container = entry.displayObject as PixiContainer & { __particleEmitter?: OrcaParticleEmitter };
        const emitter = container.__particleEmitter;
        if (!emitter || emitter.destroyed) return;
        emitter.emit = false;
        (sprite as OrcaScratchDebrisSprite).__orcaScratchDebris = { emitter, container };
    }

    /**
     * Redirect an authored child of a `spine` node onto a skeleton SLOT, so it
     * follows that slot's bone and draws in the skeleton's draw order.
     *
     * THE WRAPPER IS MANDATORY. `Spine.updateSlotObject` unconditionally
     * REPLACES `position` / `angle` / `scale` / `alpha` / `visible` on the
     * container it was given, on every `spine.update(dt)` — it does not
     * compose. So a fresh intermediate container takes the bone transform and
     * the authored display object lives inside it, which keeps three things
     * working: the node's own transform / alpha / visible read as an OFFSET
     * from the bone; `applyLayoutOverrideTransforms` and its
     * `assertLayoutVisible` / `assertLayoutAlpha` ownership tracking still own
     * the authored node; and the Pixi-8 `zIndex` setter's
     * `parent.sortableChildren = true` side effect stays inside the wrapper
     * instead of reaching the `Spine`.
     *
     * The spine node's OWN display object is untouched — `resolveNode<Spine>`
     * unwraps exactly what it did before.
     */
    private applySpineSlotAttachment(
        parentDisplayObject: PixiDisplayObject,
        parentNode: OrcaSceneNode,
        childNode: OrcaSceneNode,
        childObj: PixiDisplayObject,
    ): void {
        if (parentNode.type !== 'spine') return;

        const attachment = childNode?.spineAttachment;
        if (!attachment || typeof attachment !== 'object') return;
        if (attachment.enabled === false) return;

        const slotName = typeof attachment.slotName === 'string' ? attachment.slotName.trim() : '';
        if (!slotName) return;

        // A slot-attached node is positioned by a skeleton it cannot outlive,
        // so DDOL and slot attachment are mutually exclusive. DDOL wins — it is
        // the cross-scene contract — and the child stays an ordinary child.
        if (childNode.dontDestroyOnLoad === true) {
            console.warn(
                `[SceneManager] Node "${childNode.name}" is both dontDestroyOnLoad and attached to Spine slot "${slotName}" on "${parentNode.name}". A node in a slot cannot outlive the skeleton that positions it — keeping dontDestroyOnLoad and ignoring the slot attachment.`,
            );
            return;
        }

        if (parentDisplayObject instanceof Spine) {
            // Preloaded (normal) path: `resolveSpineData` is synchronous, so
            // the node's display object already IS the Spine.
            this.bindSpineSlotObject(parentDisplayObject, slotName, childObj, childNode, parentNode);
            return;
        }

        // Fallback path: the display object is the placeholder container from
        // `loadSpineIntoContainer` and the Spine resolves later. Re-check the
        // slot at fire time — the skeleton does not exist yet.
        const pending = (parentDisplayObject as OrcaResolvedDisplayObjectWrapper).__orcaPendingCallbacks;
        if (Array.isArray(pending)) {
            pending.push((resolved) => {
                if (resolved instanceof Spine) {
                    this.bindSpineSlotObject(resolved, slotName, childObj, childNode, parentNode);
                }
            });
            return;
        }

        console.warn(
            `[SceneManager] Spine slot "${slotName}" requested by "${childNode.name}", but parent "${parentNode.name}" resolved to neither a Spine nor a pending spine load — leaving it as an ordinary child.`,
        );
    }

    /**
     * Wrap `childObj` and hand the wrapper to `spine.addSlotObject`.
     *
     * The slot is pre-checked with `findSlot`: `addSlotObject` resolves through
     * `getSlotFromRef`, which THROWS on an unknown slot, and the editor
     * deliberately preserves a stale `slotName` rather than clearing it. On a
     * miss the child simply stays an ordinary child.
     */
    private bindSpineSlotObject(
        spine: Spine,
        slotName: string,
        childObj: PixiDisplayObject,
        childNode: OrcaSceneNode,
        parentNode: OrcaSceneNode,
    ): void {
        if ((spine as { destroyed?: boolean }).destroyed) return;
        if ((childObj as { destroyed?: boolean }).destroyed) return;

        let slot: ReturnType<Spine['skeleton']['findSlot']> | null = null;
        try {
            slot = spine.skeleton.findSlot(slotName);
        } catch {
            slot = null;
        }

        if (!slot) {
            console.warn(
                `[SceneManager] Spine slot "${slotName}" not found on node "${parentNode.name}" — leaving "${childNode.name}" as an ordinary child.`,
            );
            return;
        }

        try {
            const wrapper = new Pixi.Container() as OrcaSpineSlotWrapper;
            wrapper.__orcaSpineSlotWrapper = true;
            wrapper.label = `__orca_spineSlot:${slotName}`;
            // Reparents out of the spine's own children; addSlotObject then
            // adds the wrapper back and drives it from the bone.
            wrapper.addChild(childObj);
            spine.addSlotObject(slot, wrapper);
        } catch (e) {
            console.warn(
                `[SceneManager] Failed to attach "${childNode.name}" to Spine slot "${slotName}" on "${parentNode.name}":`,
                e,
            );
            // Never leave the child orphaned by a half-done attach.
            if (!childObj.parent && !(spine as { destroyed?: boolean }).destroyed) {
                spine.addChild(childObj);
            }
        }
    }

    /**
     * Wire an authored Button component: make the node interactive and emit the
     * bound project custom event for each mapped pointer event.
     *
     * Emission goes through the SAME `eventEmitter` as `fireCustomEvent`, with
     * the same ALWAYS-an-object payload, so an `onCustomEvent` starter (and a
     * custom component's `orca.on`) cannot tell a button press from a graph
     * fire. The payload is empty because a button carries no pass-props; an
     * event declaring some simply receives them as undefined.
     *
     * NO TEARDOWN IS REGISTERED, deliberately: the listeners live on the
     * node's own display object, so they die with it on scene teardown and
     * correctly SURVIVE on a `dontDestroyOnLoad` node, which is reparented
     * rather than destroyed. Nothing is subscribed on the shared emitter, so
     * there is nothing to leak.
     *
     * Fully untrusted input — every failure mode warns and continues.
     */
    private applyButtonComponent(displayObject: PixiDisplayObject, node: OrcaSceneNode): void {
        const button = node?.button;
        if (!button || typeof button !== 'object') return;
        if (button.enabled === false) return;

        const bindings = Array.isArray(button.bindings) ? button.bindings : [];
        if (bindings.length === 0) return;

        // A DDOL node returns early from buildNode before finishNodeBuild, so
        // this cannot run twice for one display object; belt-and-braces for any
        // future path that re-finishes an already-built object.
        const stamp = displayObject as { __orcaButtonBound?: boolean };
        if (stamp.__orcaButtonBound === true) return;

        let bound = 0;

        for (const binding of bindings) {
            const pointerEvent = typeof binding?.pointerEvent === 'string' ? binding.pointerEvent.trim() : '';
            const eventName = typeof binding?.eventName === 'string' ? binding.eventName.trim() : '';
            if (!pointerEvent || !eventName) continue;

            try {
                (displayObject as PixiContainer).on(pointerEvent as any, () => {
                    try {
                        eventEmitter.emit(eventName as any, {} as any);
                    } catch (e) {
                        console.warn(
                            `[SceneManager] Button on node "${node?.name ?? '?'}" (id "${node?.id ?? '?'}") failed to emit "${eventName}":`,
                            e,
                        );
                    }
                });
                bound++;
            } catch (e) {
                console.warn(
                    `[SceneManager] Button on node "${node?.name ?? '?'}" (id "${node?.id ?? '?'}") could not listen for "${pointerEvent}":`,
                    e,
                );
            }
        }

        if (bound === 0) return;

        stamp.__orcaButtonBound = true;
        // Pixi 8 drives interactivity entirely off `eventMode`; `interactive`
        // is gone. Only set once a binding actually landed, so a misconfigured
        // button never starts swallowing pointer input from what is behind it.
        displayObject.eventMode = 'static';
        displayObject.cursor = 'pointer';
    }

    /**
     * Apply a container's clip-mask COMPONENT at runtime — the consumer for the
     * editor's `Mask` component (tagged `__orcaNodeMask` in the editor adapter;
     * see Pixi8Adapter.applyContainerMask for parity).
     *
     * LIVE-LINK path: when `mask.sourceNodeId` resolves to a built display
     * object that lives WITHIN the masked node's subtree, that descendant's
     * actual display object drives the mask directly — `container.mask` is set
     * to it and its `renderable` flag is cleared so it doesn't double-render
     * (PIXI's MaskSystem still consumes a `renderable=false` object: stencil for
     * Graphics, sprite-mask filter for Sprite/AnimatedSprite). No snapshot
     * `__orcaNodeMask` object is built in this case. Because `applyContainerMask`
     * runs in `finishNodeBuild` AFTER the whole child subtree is built (and
     * registered in `nodeDisplayObjects`), the descendant source is always
     * available by the time we look it up.
     *
     * SNAPSHOT (fallback) path — when `sourceNodeId` is absent/unresolvable or
     * resolves outside the subtree: builds a vector `PIXI.Graphics`
     * (source === 'shape', reusing the SAME applyGraphicsCommands interpreter
     * the `graphics` node type uses) or a `PIXI.Sprite` (source === 'texture',
     * reusing the SAME scope-qualified texture/descriptor resolution as
     * `sprite` nodes via resolveStaticNodeTextureFromPath, which keys off
     * activeBuildOrigin). The mask object is positioned at the container's
     * LOCAL top-left origin (0,0) to match the editor's placement, added as a
     * child (PIXI requires the mask on the display list), then assigned to
     * `container.mask`.
     *
     * Guard: caller only invokes this when `node.mask` is present; a disabled
     * mask (`enabled === false`) or an empty texture/shape no-ops, leaving the
     * container unmasked exactly as today.
     *
     * NOT REACHED for `scratchableItem` BY CONTRACT: that node type owns
     * `container.mask` (its scratch RenderTexture) and cannot host the authored
     * Mask component — the editor's `SceneGraphService.normalizeNodeMask`
     * strips it, so `node.mask` is always absent there. Do not add a runtime
     * branch here that arbitrates the single-valued `mask` slot.
     */
    private applyContainerMask(container: PixiContainer, node: OrcaSceneNode): void {
        const mask = node.mask;
        if (!mask || mask.enabled === false) {
            return;
        }

        // LIVE-LINK: a descendant scene node drives the mask. Resolve its built
        // display object and confirm it lives within this masked node's subtree
        // (PIXI requires the mask object on the display list; a descendant is).
        const sourceNodeId = (mask.sourceNodeId ?? '').trim();
        if (sourceNodeId) {
            const liveSource = this.nodeDisplayObjects.get(sourceNodeId);
            if (liveSource && this.isWithinSubtree(liveSource, container)) {
                this.hideMaskSource(liveSource);
                container.mask = liveSource;
                return;
            }
            // Unresolvable / out-of-subtree source: fall through to the snapshot
            // path below so a stale link still produces a usable clip.
        }

        if (mask.source === 'texture') {
            const texturePath = (mask.texture ?? '').trim();
            if (!texturePath) return;

            // Same resolution path as `sprite` nodes: handles `.sprite.json`
            // descriptors + scope-qualified `/assets/<scope>/<ref>` loading,
            // keyed off the owning scene's origin via activeBuildOrigin.
            const texture = this.resolveStaticNodeTextureFromPath(texturePath);
            const maskSprite = new Pixi.Sprite(texture);
            (maskSprite as { __orcaNodeMask?: boolean }).__orcaNodeMask = true;
            maskSprite.position.set(0, 0);
            this.hideMaskSource(maskSprite);
            container.addChild(maskSprite);
            container.mask = maskSprite;

            // The texture may still be resolving. Re-assert the mask binding
            // once its source uploads so the clip isn't lost on the late
            // texture swap-in. Pixi 8 raises that signal on the SOURCE
            // (`BaseTexture` is gone).
            const textureSource = (texture as { source?: { once?: (event: string, cb: () => void) => void } })?.source;
            if (textureSource && !this.isTextureReady(texture) && typeof textureSource.once === 'function') {
                textureSource.once('update', () => {
                    if ((container as { destroyed?: boolean }).destroyed) return;
                    if ((maskSprite as { destroyed?: boolean }).destroyed) return;
                    if (maskSprite.parent === container) {
                        container.mask = maskSprite;
                    }
                });
            }
        } else {
            // source === 'shape': reuse the graphics-command interpreter.
            const shapeCommands = Array.isArray(mask.shape) ? mask.shape : [];
            const maskGraphics = new Pixi.Graphics();
            (maskGraphics as { __orcaNodeMask?: boolean }).__orcaNodeMask = true;
            this.applyGraphicsCommands(maskGraphics, shapeCommands);
            maskGraphics.position.set(0, 0);
            this.hideMaskSource(maskGraphics);
            container.addChild(maskGraphics);
            container.mask = maskGraphics;
        }

        // `inverse` (clip OUTSIDE the shape): the editor viewport ignores it and
        // the authored value is persisted but intentionally not honoured here,
        // keeping runtime/editor parity.
    }

    /**
     * Stop a mask source double-rendering — WITHOUT breaking the mask itself.
     *
     * Pixi 8 routes a Sprite mask through `AlphaMask` (which sets
     * `renderable = false` on it anyway) but a Graphics/Container mask through
     * `StencilMask`, which draws the mask via `collectRenderables` and bails on
     * `globalDisplayStatus < 0b111`. Clearing `renderable` on a stencil source
     * therefore collects NOTHING and the mask clips the whole subtree away —
     * silent, and invisible to the type-checker. Stencil sources are hidden by
     * Pixi's own `includeInBuild = false` instead, so leave them alone.
     */
    private hideMaskSource(source: PixiDisplayObject): void {
        if (source instanceof Pixi.Sprite) {
            source.renderable = false;
        }
    }

    /**
     * Walk up `obj`'s parent chain to determine whether `ancestor` is one of
     * its ancestors (or the object itself). Used to confirm a live-link mask
     * source lives within the masked node's subtree before binding it.
     */
    private isWithinSubtree(obj: PixiDisplayObject, ancestor: PixiContainer): boolean {
        let cursor: PixiDisplayObject | null = obj;
        while (cursor) {
            if (cursor === ancestor) return true;
            cursor = cursor.parent ?? null;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private getRenderTier(node: OrcaSceneNode): number {
        if (node.type !== 'canvas') {
            return 0;
        }

        return node.renderMode === 'screenSpace' ? 2 : 1;
    }

    /**
     * Stamp sibling draw order onto a node's authored children.
     *
     * A SPINE-SLOT-ATTACHED child is deliberately NOT excluded. By the time
     * this runs it already lives inside its `__orcaSpineSlotWrapper`, so the
     * Pixi-8 `zIndex` setter flips the WRAPPER's `sortableChildren`, never the
     * `Spine`'s; and `SpinePipe.addRenderable` draws slot containers itself in
     * skeleton draw order (they carry `includeInBuild = false`), so neither the
     * stamp nor the `sortChildren()` below can affect where a slot child draws.
     */
    private applyHierarchyDrawOrder(
        parent: PixiContainer,
        entries: Array<{ node: OrcaSceneNode; displayObject: PixiDisplayObject }>,
    ): void {
        const totalEntries = entries.length;

        entries.forEach((entry, index) => {
            const tier = this.getRenderTier(entry.node);
            entry.displayObject.zIndex = (tier * 100000) + (totalEntries - index);
        });

        if (parent.sortableChildren) {
            parent.sortChildren();
        }
    }

    /**
     * Apply renderer dimensions to a canvas node using its scaler settings.
     * Mirrors the editor's resolveCanvasLayout for scaleWithScreenSize mode.
     * Call again after drawScene if the renderer is resized.
     */
    public applyCanvasScalerTransform(
        container: PixiContainer,
        node: OrcaSceneNode,
        rendererWidth?: number,
        rendererHeight?: number,
    ): void {
        const scaler = node.scaler;
        if (!scaler) return;

        const rw = rendererWidth  ?? scaler.referenceWidth;
        const rh = rendererHeight ?? scaler.referenceHeight;

        if (scaler.uiScaleMode === 'scaleWithScreenSize') {
            const sw    = rw / scaler.referenceWidth;
            const sh    = rh / scaler.referenceHeight;
            const blend = Math.min(1, Math.max(0, scaler.matchWidthOrHeight));
            const s     = sw * (1 - blend) + sh * blend;
            container.scale.set(s);
            container.position.set(rw / 2, rh / 2);
        } else {
            // constantPixelSize
            container.scale.set(scaler.scaleFactor);
        }
    }

    private getCanvasScaleForFrame(canvasNode: OrcaSceneNode, frameWidth: number, frameHeight: number): number {
        const scaler = canvasNode.scaler;
        const isPixelPerfect = canvasNode.pixelPerfect === true;

        // A MISSING scaler resolves to scaleWithScreenSize with 1920x1080
        // defaults, matching the editor's `resolveCanvasLayout`.
        if (scaler?.uiScaleMode === 'constantPixelSize') {
            let constantScale = scaler.scaleFactor && scaler.scaleFactor > 0 ? scaler.scaleFactor : 1;
            if (isPixelPerfect) {
                constantScale = Math.max(1, Math.round(constantScale));
            }
            return Math.max(0.0001, constantScale);
        }

        const { width: referenceWidth, height: referenceHeight } = this.getCanvasReferenceDimensions(canvasNode);
        const match = Math.min(1, Math.max(0, scaler?.matchWidthOrHeight ?? 0.5));
        const widthScale = Math.max(0.0001, frameWidth / referenceWidth);
        const heightScale = Math.max(0.0001, frameHeight / referenceHeight);

        const logWidth = Math.log2(widthScale);
        const logHeight = Math.log2(heightScale);
        let resolvedScale = Math.pow(2, (logWidth * (1 - match)) + (logHeight * match));

        if (!Number.isFinite(resolvedScale) || resolvedScale <= 0) {
            resolvedScale = 1;
        }

        if (isPixelPerfect) {
            resolvedScale = Math.max(1, Math.round(resolvedScale));
        }

        return Math.max(0.0001, resolvedScale);
    }

    /** Authored canvas reference resolution; mirrors the editor helper of the same name. */
    private getCanvasReferenceDimensions(canvasNode: OrcaSceneNode): { width: number; height: number } {
        const scaler = canvasNode.scaler;
        const rawWidth = typeof scaler?.referenceWidth === 'number' && Number.isFinite(scaler.referenceWidth)
            ? scaler.referenceWidth
            : DEFAULT_FRAME_WIDTH;
        const rawHeight = typeof scaler?.referenceHeight === 'number' && Number.isFinite(scaler.referenceHeight)
            ? scaler.referenceHeight
            : DEFAULT_FRAME_HEIGHT;

        return {
            width: Math.max(1, Math.round(rawWidth)),
            height: Math.max(1, Math.round(rawHeight)),
        };
    }

    /**
     * Logical (canvas-local) size a screen-space canvas presents to its rect
     * children — the `logicalWidth`/`logicalHeight` half of the editor's
     * `resolveCanvasLayout`.
     */
    private getCanvasLogicalSizeForFrame(
        canvasNode: OrcaSceneNode,
        frameWidth: number,
        frameHeight: number,
    ): RectLayoutBox {
        if (canvasNode.scaler?.uiScaleMode === 'constantPixelSize') {
            const scale = this.getCanvasScaleForFrame(canvasNode, frameWidth, frameHeight);
            return {
                width: Math.max(1, frameWidth / scale),
                height: Math.max(1, frameHeight / scale),
            };
        }

        return this.getCanvasReferenceDimensions(canvasNode);
    }

    private normalizeResponsiveScalerMode(rawMode: unknown): OrcaResponsiveScalerMode {
        switch (rawMode) {
            case 'fitWidth':
            case 'fitHeight':
            case 'stretch':
            case 'bestFit':
            case 'bestFitShrink':
            case 'fitArea':
                return rawMode;
            default:
                return 'bestFit';
        }
    }

    private normalizeResponsiveScaler(
        node: OrcaSceneNode,
        responsiveScalerSource?: OrcaResponsiveScaler,
        transformSource?: OrcaTransform,
    ): {
        mode: OrcaResponsiveScalerMode;
        referenceWidth: number;
        referenceHeight: number;
        baseScaleX: number;
        baseScaleY: number;
        /** The Fit to Area settings, filled in — `fitArea` mode only. */
        fit: FitAreaSettings | null;
    } | null {
        const source = responsiveScalerSource ?? node.responsiveScaler;
        if (!source) {
            return null;
        }

        if (node.type === 'canvas' || node.type === 'camera') {
            return null;
        }

        const referenceWidth = Number.isFinite(source.referenceWidth) && source.referenceWidth > 0
            ? Math.round(source.referenceWidth)
            : DEFAULT_FRAME_WIDTH;
        const referenceHeight = Number.isFinite(source.referenceHeight) && source.referenceHeight > 0
            ? Math.round(source.referenceHeight)
            : DEFAULT_FRAME_HEIGHT;
        const transform = transformSource ?? node.transform;
        const baseScaleX = Number.isFinite(transform?.scaleX)
            ? transform.scaleX
            : 1;
        const baseScaleY = Number.isFinite(transform?.scaleY)
            ? transform.scaleY
            : 1;
        const mode = this.normalizeResponsiveScalerMode(source.mode);

        return {
            mode,
            referenceWidth,
            referenceHeight,
            baseScaleX,
            baseScaleY,
            fit: mode === 'fitArea' ? normalizeFitAreaSettings(source) : null,
        };
    }

    private getCanvasResponsiveDimensionsForFrame(canvasNode: OrcaSceneNode, frameWidth: number, frameHeight: number): { width: number; height: number } {
        const scaler = canvasNode.scaler;
        const baseWidth = scaler && Number.isFinite(scaler.referenceWidth) && scaler.referenceWidth > 0
            ? scaler.referenceWidth
            : DEFAULT_FRAME_WIDTH;
        const baseHeight = scaler && Number.isFinite(scaler.referenceHeight) && scaler.referenceHeight > 0
            ? scaler.referenceHeight
            : DEFAULT_FRAME_HEIGHT;

        // Screen-space canvas responsive scaling uses the camera-visible world
        // dimensions for the current output aspect ratio. This includes
        // letterbox/pillarbox padding equivalents so authored scaling in editor
        // camera mode carries through to game output.
        if (canvasNode.renderMode !== 'worldSpace') {
            return {
                width: Math.max(1, frameWidth),
                height: Math.max(1, frameHeight),
            };
        }

        // World-space canvas children scale against the authored canvas reference size.
        return {
            width: Math.max(1, baseWidth),
            height: Math.max(1, baseHeight),
        };
    }

    /**
     * The scaler in force for this camera mode: the node's own, with a per-mode
     * LayoutManager override merged over it. The override brings its OWN Fit to
     * Area settings (or none) as one group, so one mode's never leak into
     * another — the editor's `applyLayoutManagersForActiveMode` merges alike.
     */
    private mergeResponsiveScalerOverride(node: OrcaSceneNode, override?: OrcaLayoutEntry): OrcaResponsiveScaler | undefined {
        return override?.responsiveScaler && node.responsiveScaler
            ? { ...withoutFitAreaFields(node.responsiveScaler), ...override.responsiveScaler } as OrcaResponsiveScaler
            : node.responsiveScaler;
    }

    private applyResponsiveScalerToNode(
        node: OrcaSceneNode,
        availableWidth: number,
        availableHeight: number,
        override?: OrcaLayoutEntry,
        screenRect: FitAreaRect | null = null,
    ): void {
        const effectiveResponsiveScaler = this.mergeResponsiveScalerOverride(node, override);
        const effectiveTransform = override?.transform
            ? { ...node.transform, ...override.transform } as OrcaTransform
            : node.transform;

        const scaler = this.normalizeResponsiveScaler(node, effectiveResponsiveScaler, effectiveTransform);
        if (!scaler) return;

        const displayObject = this.nodeDisplayObjects.get(node.id);
        if (!displayObject) return;

        if (scaler.fit) {
            this.applyFitAreaToObject(displayObject, scaler.fit, scaler.baseScaleX, scaler.baseScaleY, effectiveTransform, screenRect);
            return;
        }
        (displayObject as { __orcaFitPlaced?: boolean }).__orcaFitPlaced = false;

        const safeAvailableWidth = Math.max(1, availableWidth);
        const safeAvailableHeight = Math.max(1, availableHeight);
        const widthRatio = safeAvailableWidth / Math.max(1, scaler.referenceWidth);
        const heightRatio = safeAvailableHeight / Math.max(1, scaler.referenceHeight);

        let responsiveScaleX = 1;
        let responsiveScaleY = 1;

        switch (scaler.mode) {
            case 'fitWidth':
                responsiveScaleX = widthRatio;
                responsiveScaleY = widthRatio;
                break;
            case 'fitHeight':
                responsiveScaleX = heightRatio;
                responsiveScaleY = heightRatio;
                break;
            case 'stretch':
                responsiveScaleX = widthRatio;
                responsiveScaleY = heightRatio;
                break;
            case 'bestFit':
            default: {
                // Cover fit: fills both axes, may crop but avoids letterboxing.
                const bestFitRatio = Math.max(widthRatio, heightRatio);
                responsiveScaleX = bestFitRatio;
                responsiveScaleY = bestFitRatio;
                break;
            }
            case 'bestFitShrink': {
                // Contain fit: preserves all content, may letterbox.
                const bestFitRatio = Math.min(widthRatio, heightRatio);
                responsiveScaleX = bestFitRatio;
                responsiveScaleY = bestFitRatio;
                break;
            }
        }

        const nextScaleX = scaler.baseScaleX * responsiveScaleX;
        const nextScaleY = scaler.baseScaleY * responsiveScaleY;

        if (!Number.isFinite(nextScaleX) || !Number.isFinite(nextScaleY)) {
            return;
        }

        displayObject.scale.set(nextScaleX, nextScaleY);
        // Remembered so an animated scale channel composes with the scaler ratio.
        (displayObject as { __orcaResponsiveRatio?: { x: number; y: number } }).__orcaResponsiveRatio = {
            x: responsiveScaleX,
            y: responsiveScaleY,
        };
        // DELIBERATELY NOT followed by applySpriteFamilySizeOverride. This
        // assignment is absolute and DOES discard an authored width/height —
        // but the editor behaves identically (Pixi8Adapter runs
        // applyResponsiveScalerToNative AFTER its own size-override call and
        // never re-asserts), and matching the editor beats matching rule 18's
        // literal wording. A node with BOTH a size override and a
        // responsiveScaler renders at native × scaler ratio on BOTH sides.
        // Only nodes with a scaler reach here at all — the guard above returns
        // early otherwise — so this costs nothing for everyone else.
    }

    /**
     * Responsive Scaler ▸ Fit to Area (`fit-area.ts`): scale and place the node
     * so its box — its bounds as the editor last measured them, or the box its
     * author set — fits the screen less its margins. The twin call site of the
     * editor's `Pixi8Adapter.applyFitAreaToNative`. The fit owns the node's
     * place and size, so animated x / y / scale channels leave it alone
     * (`__orcaFitPlaced`), as the editor's preview does. Written on every draw,
     * like every other scaler mode's scale.
     */
    private applyFitAreaToObject(
        displayObject: PixiDisplayObject,
        settings: FitAreaSettings,
        baseScaleX: number,
        baseScaleY: number,
        transform: OrcaTransform,
        screenRect: FitAreaRect | null,
    ): void {
        const tagged = displayObject as { __orcaFitPlaced?: boolean };
        tagged.__orcaFitPlaced = false;
        const parent = displayObject.parent;
        if (!screenRect || !parent || !this.currentContainer) return;

        const fit = resolveFitArea(this.mapFitAreaRect(screenRect, this.currentContainer, parent), settings, {
            scaleX: baseScaleX,
            scaleY: baseScaleY,
            rotation: displayObject.rotation,
            pivotX: displayObject.pivot?.x ?? 0,
            pivotY: displayObject.pivot?.y ?? 0,
        });
        if (!fit) return;

        const ownX = Number.isFinite(transform?.x) ? transform.x : 0;
        const ownY = Number.isFinite(transform?.y) ? transform.y : 0;
        displayObject.scale.set(fit.scaleX, fit.scaleY);
        displayObject.position.set(fit.x, fit.y);
        tagged.__orcaFitPlaced = true;
        (displayObject as { __orcaResponsiveRatio?: { x: number; y: number } }).__orcaResponsiveRatio = {
            x: fit.ratio,
            y: fit.ratio,
        };
        (displayObject as { __orcaAnchorOffset?: { x: number; y: number } }).__orcaAnchorOffset = { x: fit.x - ownX, y: fit.y - ownY };
    }

    /** An axis-aligned rect carried from one container's space into another's (the box round its corners). */
    private mapFitAreaRect(rect: FitAreaRect, from: PixiContainer, to: PixiContainer): FitAreaRect {
        if (from === to) return { ...rect };
        const corners = [
            to.toLocal(new Pixi.Point(rect.left, rect.top), from),
            to.toLocal(new Pixi.Point(rect.right, rect.top), from),
            to.toLocal(new Pixi.Point(rect.right, rect.bottom), from),
            to.toLocal(new Pixi.Point(rect.left, rect.bottom), from),
        ];
        const xs = corners.map((point) => point.x);
        const ys = corners.map((point) => point.y);
        return {
            left: Math.min(...xs),
            top: Math.min(...ys),
            right: Math.max(...xs),
            bottom: Math.max(...ys),
        };
    }

    private resolveActiveLayoutMode(width?: number, height?: number): OrcaActiveLayoutMode {
        // Desktop ignores orientation entirely; otherwise orientation comes from
        // the CURRENT viewport dimensions, which — unlike the device singleton —
        // cannot be one flip stale relative to the resize that triggered us.
        if (device?.type?.isDesktop) return 'desktop';
        const w = typeof width === 'number' ? width : NaN;
        const h = typeof height === 'number' ? height : NaN;
        if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
            return h > w ? 'portrait' : 'landscape';
        }
        if (device?.orientation?.isPortrait) return 'portrait';
        return 'landscape';
    }

    /**
     * The screen Advanced Layout Manager profiles are matched against. A sub-game
     * (game in game) wins over the device type; a hybrid (touch-enabled desktop)
     * counts as desktop; anything unclassified as mobile.
     */
    private resolveLayoutProfileEnvironment(width: number, height: number): LayoutProfileEnvironment {
        const type = device?.type;
        let platform: LayoutProfilePlatform = 'mobile';
        if (this.isSubGame()) platform = 'gameInGame';
        else if (type?.isDesktop) platform = 'desktop';
        else if (type?.isTablet) platform = 'tablet';
        else if (type?.isHybrid) platform = 'desktop';
        return { platform, width, height };
    }

    private resolveLayoutManagerMode(
        layoutManager: OrcaLayoutManager,
        activeMode: OrcaActiveLayoutMode,
        portraitChatOpen: boolean,
    ): OrcaActiveLayoutMode | 'portraitChat' | null {
        const enabled = layoutManager.enabledModes;
        if (!enabled) return null;

        const modes = layoutManager.modes ?? {};
        const isUsable = (k: OrcaActiveLayoutMode): boolean => Boolean(enabled[k] && modes[k]);

        if (activeMode === 'portrait' && portraitChatOpen
            && enabled.portraitChat === true && modes.portraitChat) return 'portraitChat';

        if (isUsable(activeMode)) return activeMode;

        // Per spec: desktop and portrait both fall back to landscape only.
        if (activeMode === 'desktop' || activeMode === 'portrait') {
            return isUsable('landscape') ? 'landscape' : null;
        }

        // Landscape: scan first usable in (landscape, portrait, desktop).
        for (const key of ['landscape', 'portrait', 'desktop'] as const) {
            if (isUsable(key)) return key;
        }
        return null;
    }

    /**
     * Build a per-draw map of node id → resolved LayoutEntry. Walks the scene
     * tree and tracks the innermost ancestor host of EITHER kind
     * (LayoutManager or AdvancedLayoutManager) — a deeper host fully replaces
     * the outer one for that subtree, and an advanced host with no matching
     * profile gives its subtree no overrides. The editor enforces no-nesting;
     * this is a defensive runtime implementation.
     */
    private buildLayoutOverrideMap(
        roots: OrcaSceneNode[],
        activeMode: OrcaActiveLayoutMode,
        portraitChatOpen: boolean,
        profileEnv: LayoutProfileEnvironment,
    ): Map<string, OrcaLayoutEntry> {
        const overrides = new Map<string, OrcaLayoutEntry>();

        const walk = (node: OrcaSceneNode, activeEntries: Record<string, OrcaLayoutEntry> | null): void => {
            let nextActiveEntries = activeEntries;
            // The editor refuses the advanced component on the camera; ignore it there.
            const advanced = node.type !== 'camera' ? node.advancedLayoutManager : undefined;
            if (advanced) {
                // Same node carrying both: the advanced host wins, as in the editor.
                const profile = resolveActiveLayoutProfile(Array.isArray(advanced.profiles) ? advanced.profiles : [], profileEnv);
                nextActiveEntries = profile?.entries ?? null;
            } else if (node.layoutManager) {
                const resolvedMode = this.resolveLayoutManagerMode(node.layoutManager, activeMode, portraitChatOpen);
                nextActiveEntries = resolvedMode
                    ? (node.layoutManager.modes[resolvedMode]?.entries ?? null)
                    : null;
            }
            if (nextActiveEntries) {
                const entry = nextActiveEntries[node.id];
                if (entry) overrides.set(node.id, entry);
            }
            if (node.children.length > 0) {
                for (const child of node.children) walk(child, nextActiveEntries);
            }
        };

        for (const root of roots) walk(root, null);
        return overrides;
    }

    /**
     * Derive the camera reference frame from the (new) `mode` field, falling
     * back to legacy `frameWidth`/`frameHeight` for back-compat with any
     * pre-`mode` scene data, then transpose it to match the active layout mode.
     */
    private resolveCameraFrame(
        camera: OrcaSceneNode,
        activeMode: OrcaActiveLayoutMode,
    ): { width: number; height: number } {
        let width: number;
        let height: number;

        switch (camera.mode) {
            case 'portrait9x16':
                width = 1080; height = 1920; break;
            case 'desktop16x9':
            case 'landscape16x9':
                width = 1920; height = 1080; break;
            case 'landscape720p':
                width = 1280; height = 720; break;
            case 'iPhoneProLandscape':
                width = 2556; height = 1179; break;
            case 'iPhoneProPortrait':
                width = 1179; height = 2556; break;
            case 'galaxyS24Landscape':
                width = 2340; height = 1080; break;
            case 'galaxyS24Portrait':
                width = 1080; height = 2340; break;
            default:
                width = (camera.frameWidth && camera.frameWidth > 0) ? camera.frameWidth : DEFAULT_FRAME_WIDTH;
                height = (camera.frameHeight && camera.frameHeight > 0) ? camera.frameHeight : DEFAULT_FRAME_HEIGHT;
                break;
        }

        // The author sized the portrait LayoutManager overrides against a
        // portrait frame, so the frame must follow the bucket we're applying.
        // The named modes are transpose-pairs, so the swap reproduces the
        // paired mode's frame exactly; a square frame is a no-op.
        const wantsPortrait = activeMode === 'portrait';
        const frameIsPortrait = height > width;
        if (wantsPortrait !== frameIsPortrait) {
            return { width: height, height: width };
        }
        return { width, height };
    }

    /**
     * Returns the ids whose display-side `position` this pass rewrote, so the
     * later parent-anchor pass knows which nodes it must re-assert over even
     * though their resolved anchor target is unchanged.
     */
    private applyLayoutOverrideTransforms(layoutOverrides: Map<string, OrcaLayoutEntry>): Set<string> {
        // @lm-overrides-v2
        // A spine-slot-attached node is still written here: the bone transform
        // lands on its `__orcaSpineSlotWrapper`, so these overrides compose on
        // top of it as an offset, exactly as for any other node.
        const wroteTransformIds = new Set<string>();
        if (!this.currentScene) return wroteTransformIds;
        if (layoutOverrides.size === 0 && this.previousLayoutOverrideIds.size === 0) return wroteTransformIds;
        const walk = (nodes: OrcaSceneNode[]): void => {
            for (const node of nodes) {
                const override = layoutOverrides.get(node.id);
                if (override) {
                    const displayObject = this.nodeDisplayObjects.get(node.id);
                    // The camera's display-side transform is driven by drawScene's
                    // letterbox math, NOT by node.transform — skip cameras here
                    // so we don't fight the camera path.
                    if (displayObject && node.type !== 'camera') {
                        if (override.transform) {
                            const merged: OrcaTransform = { ...node.transform, ...override.transform };
                            this.applyTransform(displayObject, merged, node);
                            wroteTransformIds.add(node.id);
                        }
                        if (typeof override.visible === 'boolean') {
                            this.assertLayoutVisible(displayObject, override.visible);
                        }
                        if (typeof override.alpha === 'number') {
                            this.assertLayoutAlpha(displayObject, override.alpha);
                        }
                    }
                } else if (
                    this.previousLayoutOverrideIds.has(node.id)
                    && node.type !== 'camera'
                    && !SYSTEM_MOUNT_NODE_TYPES.has(node.type)
                ) {
                    // Overridden in the mode we just left but not in this one:
                    // restore the authored base state so it can't stick. Only
                    // these nodes are touched — a blanket reset would snap
                    // tween-animated nodes back on every resize.
                    const displayObject = this.nodeDisplayObjects.get(node.id);
                    if (displayObject) {
                        this.applyTransform(displayObject, node.transform, node);
                        wroteTransformIds.add(node.id);
                        this.assertLayoutVisible(displayObject, node.visible);
                        this.assertLayoutAlpha(displayObject, node.alpha);
                    }
                }
                if (node.children.length > 0) walk(node.children);
            }
        };
        walk(this.currentScene.nodes);
        this.previousLayoutOverrideIds = new Set(layoutOverrides.keys());
        return wroteTransformIds;
    }

    /**
     * Forget what the layout pass last asserted on a display object, so the
     * next draw starts from the authored baseline again. Called from both
     * build paths, which have just written `node.visible` / `node.alpha`.
     */
    private resetLayoutAssertion(displayObject: PixiDisplayObject): void {
        this.layoutAssertions.delete(displayObject);
    }

    /**
     * Forget the parent-anchor position last written for a display object.
     * Called from BOTH build paths — the fresh build (`finishNodeBuild`) and
     * the DDOL rebind, which returns before `finishNodeBuild` ever runs and
     * reuses a display object whose record would otherwise still describe the
     * PREVIOUS scene's anchor.
     */
    private resetParentAnchorWrite(displayObject: PixiDisplayObject): void {
        this.parentAnchorWrites.delete(displayObject);
    }

    private getLayoutAssertion(displayObject: PixiDisplayObject): LayoutAssertionRecord {
        let record = this.layoutAssertions.get(displayObject);
        if (!record) {
            record = { visible: null, alpha: null, visibleReleased: false, alphaReleased: false };
            this.layoutAssertions.set(displayObject, record);
        }
        return record;
    }

    /**
     * Write a LayoutManager-owned `visible`, unless the runtime has taken the
     * property over. Ownership transfers the first time we notice the live
     * value differs from what we last wrote: only a flow node, tween, custom
     * component or node extension can have done that, and an explicit runtime
     * hide must outlive every later redraw — including an orientation change,
     * which would otherwise re-show it from the incoming mode's entry.
     * Ownership lasts until the node is rebuilt (loadScene / DDOL rebind).
     */
    private assertLayoutVisible(displayObject: PixiDisplayObject, value: boolean): void {
        const record = this.getLayoutAssertion(displayObject);
        if (record.visibleReleased) return;
        if (record.visible !== null && displayObject.visible !== record.visible) {
            record.visibleReleased = true;
            return;
        }
        displayObject.visible = value;
        record.visible = value;
    }

    /** `assertLayoutVisible` for `alpha` — a fade-out is a hide too. */
    private assertLayoutAlpha(displayObject: PixiDisplayObject, value: number): void {
        const record = this.getLayoutAssertion(displayObject);
        if (record.alphaReleased) return;
        if (record.alpha !== null && displayObject.alpha !== record.alpha) {
            record.alphaReleased = true;
            return;
        }
        displayObject.alpha = value;
        record.alpha = value;
    }

    private applyResponsiveScalerTransforms(
        frameWidth: number,
        frameHeight: number,
        layoutOverrides?: Map<string, OrcaLayoutEntry>,
        screenRect: FitAreaRect | null = null,
    ): void {
        if (!this.currentScene) {
            return;
        }

        const applyRecursive = (nodes: OrcaSceneNode[], activeCanvas: OrcaSceneNode | null): void => {
            for (const node of nodes) {
                const nextCanvas = node.type === 'canvas' ? node : activeCanvas;
                const attachedCanvas = node.type === 'canvas' ? activeCanvas : nextCanvas;

                let availableWidth = frameWidth;
                let availableHeight = frameHeight;

                if (attachedCanvas) {
                    const canvasDimensions = this.getCanvasResponsiveDimensionsForFrame(attachedCanvas, frameWidth, frameHeight);
                    availableWidth = canvasDimensions.width;
                    availableHeight = canvasDimensions.height;
                }

                this.applyResponsiveScalerToNode(node, availableWidth, availableHeight, layoutOverrides?.get(node.id), screenRect);

                if (node.children.length > 0) {
                    applyRecursive(node.children, nextCanvas);
                }
            }
        };

        applyRecursive(this.currentScene.nodes, null);
    }

    private collectScreenSpaceCanvasNodes(nodes: OrcaSceneNode[], out: OrcaSceneNode[] = []): OrcaSceneNode[] {
        for (const node of nodes) {
            if (node.type === 'canvas' && node.renderMode !== 'worldSpace') {
                out.push(node);
            }

            if (node.children.length > 0) {
                this.collectScreenSpaceCanvasNodes(node.children, out);
            }
        }

        return out;
    }

    private applyScreenSpaceCanvasTransforms(
        cameraTransform: OrcaTransform,
        frameWidth: number,
        frameHeight: number,
        zoom: number,
    ): void {
        if (!this.currentScene) return;

        const safeZoom = Math.max(0.0001, zoom);
        const baseWorldScale = 1 / safeZoom;
        const screenSpaceCanvases = this.collectScreenSpaceCanvasNodes(this.currentScene.nodes);

        for (const canvasNode of screenSpaceCanvases) {
            const displayObject = this.nodeDisplayObjects.get(canvasNode.id);
            if (!displayObject || !(displayObject instanceof Pixi.Container)) continue;

            const canvasScale = this.getCanvasScaleForFrame(canvasNode, frameWidth, frameHeight);
            displayObject.position.set(
                cameraTransform.x - ((frameWidth * baseWorldScale) / 2),
                cameraTransform.y - ((frameHeight * baseWorldScale) / 2),
            );
            displayObject.scale.set(canvasScale * baseWorldScale);
            displayObject.rotation = 0;
            displayObject.pivot.set(0, 0);

            if (displayObject.skew) {
                displayObject.skew.set(0, 0);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // RectTransform layout — runtime half of the editor's
    // `Pixi8Adapter.applyNodeLayoutRecursive` / `applyRectTransformToNative`.
    // ─────────────────────────────────────────────────────────────────────

    private clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, value));
    }

    private isValidBounds(bounds: { x: number; y: number; width: number; height: number }): boolean {
        return (
            Number.isFinite(bounds.x)
            && Number.isFinite(bounds.y)
            && Number.isFinite(bounds.width)
            && Number.isFinite(bounds.height)
            && bounds.width > 0
            && bounds.height > 0
        );
    }

    private readLocalBounds(obj: PixiDisplayObject): { x: number; y: number; width: number; height: number } | null {
        try {
            const bounds = obj.getLocalBounds();
            return bounds && this.isValidBounds(bounds) ? bounds : null;
        } catch {
            return null;
        }
    }

    /**
     * Defensive normalization of untrusted authored/agent-written rect data;
     * mirrors the editor's `getNormalizedRectTransform`.
     */
    private normalizeRectTransform(source: OrcaRectTransform): OrcaRectTransform {
        const normalized: OrcaRectTransform = { ...DEFAULT_RECT_TRANSFORM, ...source };

        normalized.anchorMinX = this.clamp(normalized.anchorMinX, 0, 1);
        normalized.anchorMinY = this.clamp(normalized.anchorMinY, 0, 1);
        normalized.anchorMaxX = this.clamp(normalized.anchorMaxX, 0, 1);
        normalized.anchorMaxY = this.clamp(normalized.anchorMaxY, 0, 1);
        normalized.pivotX = this.clamp(normalized.pivotX, 0, 1);
        normalized.pivotY = this.clamp(normalized.pivotY, 0, 1);

        if (normalized.anchorMinX > normalized.anchorMaxX) {
            const swap = normalized.anchorMinX;
            normalized.anchorMinX = normalized.anchorMaxX;
            normalized.anchorMaxX = swap;
        }

        if (normalized.anchorMinY > normalized.anchorMaxY) {
            const swap = normalized.anchorMinY;
            normalized.anchorMinY = normalized.anchorMaxY;
            normalized.anchorMaxY = swap;
        }

        return normalized;
    }

    private getPreferredNodeSize(node: OrcaSceneNode, obj: PixiDisplayObject): RectLayoutBox {
        const widthFromNode = typeof node.width === 'number' && Number.isFinite(node.width)
            ? Math.max(0, node.width)
            : 0;
        const heightFromNode = typeof node.height === 'number' && Number.isFinite(node.height)
            ? Math.max(0, node.height)
            : 0;

        if (widthFromNode > 0 || heightFromNode > 0) {
            return { width: widthFromNode, height: heightFromNode };
        }

        const bounds = this.readLocalBounds(obj);
        if (bounds) {
            return { width: bounds.width, height: bounds.height };
        }

        return { width: 0, height: 0 };
    }

    private getIntrinsicTextureSize(obj: PixiDisplayObject): RectLayoutBox {
        const texture = readSpriteFamilyTexture(obj);

        if (!texture) return { width: 0, height: 0 };

        const width = Number(texture.orig?.width ?? texture.width ?? 0);
        const height = Number(texture.orig?.height ?? texture.height ?? 0);

        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return { width: 0, height: 0 };
        }

        return { width, height };
    }

    private getRectContentBaseSize(
        node: OrcaSceneNode,
        obj: PixiDisplayObject,
        fallbackSize: RectLayoutBox,
    ): RectLayoutBox {
        const explicitWidth = typeof node.width === 'number' && Number.isFinite(node.width)
            ? Math.max(0, node.width)
            : 0;
        const explicitHeight = typeof node.height === 'number' && Number.isFinite(node.height)
            ? Math.max(0, node.height)
            : 0;

        if (explicitWidth > 0 || explicitHeight > 0) {
            const resolvedWidth = explicitWidth > 0
                ? explicitWidth
                : (fallbackSize.width > 0 ? fallbackSize.width : explicitHeight);
            const resolvedHeight = explicitHeight > 0
                ? explicitHeight
                : (fallbackSize.height > 0 ? fallbackSize.height : explicitWidth);

            return {
                width: Math.max(0, resolvedWidth),
                height: Math.max(0, resolvedHeight),
            };
        }

        if (SPRITE_FAMILY_SIZE_TYPES.has(node.type)) {
            const textureSize = this.getIntrinsicTextureSize(obj);
            if (textureSize.width > 0 && textureSize.height > 0) {
                return textureSize;
            }
        }

        return {
            width: Math.max(0, fallbackSize.width),
            height: Math.max(0, fallbackSize.height),
        };
    }

    /** Returns true when the rect was written as a real display size. */
    private applyRectSizeOverrides(
        obj: PixiDisplayObject,
        node: OrcaSceneNode,
        width: number,
        height: number,
    ): boolean {
        if (!RECT_SIZE_OVERRIDE_TYPES.has(node.type)) return false;

        const resolvedWidth = Math.max(0, width);
        const resolvedHeight = Math.max(0, height);

        if (node.type === 'tilingSprite') {
            obj.width = Math.max(1, resolvedWidth);
            obj.height = Math.max(1, resolvedHeight);
            return true;
        }

        obj.width = resolvedWidth;
        obj.height = resolvedHeight;
        return true;
    }

    private isRectLayoutNode(node: OrcaSceneNode): boolean {
        return !!node.rectTransform && !RECT_LAYOUT_EXCLUDED_TYPES.has(node.type);
    }

    /**
     * Resolve one node's rect against its parent box and write the resulting
     * position / size (or content scale) onto the display object. Returns the
     * resolved rect, which becomes the child box for the subtree.
     */
    private applyRectTransformToObject(
        obj: PixiDisplayObject,
        node: OrcaSceneNode,
        parentBox: RectLayoutBox,
    ): RectLayoutBox {
        const rect = this.normalizeRectTransform(node.rectTransform as OrcaRectTransform);
        const fallbackSize = this.getPreferredNodeSize(node, obj);
        const baseContentSize = this.getRectContentBaseSize(node, obj, fallbackSize);
        const baseLocalBounds = this.readLocalBounds(obj);

        const baseLocalBoundsX = baseLocalBounds?.x ?? 0;
        const baseLocalBoundsY = baseLocalBounds?.y ?? 0;
        const baseLocalBoundsWidth = baseLocalBounds?.width ?? Math.max(1, baseContentSize.width);
        const baseLocalBoundsHeight = baseLocalBounds?.height ?? Math.max(1, baseContentSize.height);

        const anchorLeft = parentBox.width * rect.anchorMinX;
        const anchorTop = parentBox.height * rect.anchorMinY;
        const anchorRight = parentBox.width * rect.anchorMaxX;
        const anchorBottom = parentBox.height * rect.anchorMaxY;

        let rectWidth = (anchorRight - anchorLeft) + rect.sizeDeltaX;
        let rectHeight = (anchorBottom - anchorTop) + rect.sizeDeltaY;

        if (!Number.isFinite(rectWidth)) rectWidth = fallbackSize.width;
        if (!Number.isFinite(rectHeight)) rectHeight = fallbackSize.height;

        rectWidth = Math.max(0, rectWidth);
        rectHeight = Math.max(0, rectHeight);

        if (rectWidth === 0 && fallbackSize.width > 0) rectWidth = fallbackSize.width;
        if (rectHeight === 0 && fallbackSize.height > 0) rectHeight = fallbackSize.height;

        rectWidth = this.clamp(rectWidth, 1, Math.max(1, parentBox.width));
        rectHeight = this.clamp(rectHeight, 1, Math.max(1, parentBox.height));

        // Clamped values stay LOCAL: the parsed scene node is the source of
        // truth for loadScene / DDOL rebind, so it is never written back.
        const shouldClampRectPosition = !node.responsiveScaler;
        const unclampedLeft = anchorLeft + rect.anchoredPositionX;
        const unclampedTop = anchorTop + rect.anchoredPositionY;
        const clampedLeft = shouldClampRectPosition
            ? this.clamp(unclampedLeft, 0, Math.max(0, parentBox.width - rectWidth))
            : unclampedLeft;
        const clampedTop = shouldClampRectPosition
            ? this.clamp(unclampedTop, 0, Math.max(0, parentBox.height - rectHeight))
            : unclampedTop;
        const clampedAnchoredPositionX = clampedLeft - anchorLeft;
        const clampedAnchoredPositionY = clampedTop - anchorTop;

        const resolvedRectWidth = Math.max(1, rectWidth);
        const resolvedRectHeight = Math.max(1, rectHeight);

        const targetPivotX = anchorLeft + clampedAnchoredPositionX + (resolvedRectWidth * rect.pivotX);
        const targetPivotY = anchorTop + clampedAnchoredPositionY + (resolvedRectHeight * rect.pivotY);

        obj.position.set(targetPivotX, targetPivotY);
        obj.scale.set(1, 1);
        obj.rotation = 0;

        let finalPositionX = targetPivotX;
        let finalPositionY = targetPivotY;
        let finalPivotX = resolvedRectWidth * rect.pivotX;
        let finalPivotY = resolvedRectHeight * rect.pivotY;

        const usedSizeOverride = this.applyRectSizeOverrides(obj, node, resolvedRectWidth, resolvedRectHeight);
        const anchorTarget = asSpriteFamily(obj)?.anchor;
        const canUseAnchorPivot = usedSizeOverride
            && RECT_ANCHOR_PIVOT_TYPES.has(node.type)
            && !!anchorTarget
            && typeof anchorTarget.set === 'function';

        if (canUseAnchorPivot) {
            anchorTarget!.set(rect.pivotX, rect.pivotY);
            finalPivotX = 0;
            finalPivotY = 0;
        }

        if (!usedSizeOverride) {
            const baseWidthForScale = baseLocalBoundsWidth > 0
                ? baseLocalBoundsWidth
                : (baseContentSize.width > 0 ? baseContentSize.width : resolvedRectWidth);
            const baseHeightForScale = baseLocalBoundsHeight > 0
                ? baseLocalBoundsHeight
                : (baseContentSize.height > 0 ? baseContentSize.height : resolvedRectHeight);
            const contentScaleX = baseWidthForScale > 0 ? (resolvedRectWidth / baseWidthForScale) : 1;
            const contentScaleY = baseHeightForScale > 0 ? (resolvedRectHeight / baseHeightForScale) : 1;

            obj.scale.set(contentScaleX, contentScaleY);

            const localPivotX = baseLocalBoundsX + (baseLocalBoundsWidth * rect.pivotX);
            const localPivotY = baseLocalBoundsY + (baseLocalBoundsHeight * rect.pivotY);
            finalPositionX = targetPivotX - (localPivotX * contentScaleX);
            finalPositionY = targetPivotY - (localPivotY * contentScaleY);
            finalPivotX = 0;
            finalPivotY = 0;
        }

        obj.position.set(finalPositionX, finalPositionY);

        if (obj.pivot) {
            obj.pivot.set(finalPivotX, finalPivotY);
        }

        if (obj.skew) {
            obj.skew.set(0, 0);
        }

        this.deferRectLayoutForTexture(obj);

        return { width: resolvedRectWidth, height: resolvedRectHeight };
    }

    private resolveCanvasChildBox(
        canvasNode: OrcaSceneNode,
        frameWidth: number,
        frameHeight: number,
    ): RectLayoutBox {
        if (canvasNode.renderMode === 'worldSpace') {
            return this.getCanvasReferenceDimensions(canvasNode);
        }
        return this.getCanvasLogicalSizeForFrame(canvasNode, frameWidth, frameHeight);
    }

    /**
     * The DECLARED rect `node` offers its CHILDREN for `parentAnchor`, in those
     * children's parent-local space. Mirrors the `childLayout.anchorRect`
     * assignment in `Pixi8Adapter.applyNodeLayoutRecursive` — keep the two in
     * lock-step.
     *
     * - a `canvas` → its resolved logical rect. The centre is HALF the size
     *   because a canvas authors its children from its TOP-LEFT (both render
     *   modes set pivot 0 and place the native at the rect's corner).
     * - a `responsiveScaler` host → its reference rect, centred on the node's
     *   own local origin; a Fit to Area host → the box its author set, or none
     *   when it fits its own bounds (`fit-area.ts`), from the scaler in force
     *   for this camera mode.
     * - anything else → no rect, which makes a child's stored anchor INERT.
     */
    private resolveChildAnchorRect(node: OrcaSceneNode, childBox: RectLayoutBox, override?: OrcaLayoutEntry): AnchorRect | null {
        if (node.type === 'canvas') {
            return {
                centerX: childBox.width / 2,
                centerY: childBox.height / 2,
                width: childBox.width,
                height: childBox.height,
            };
        }

        const scaler = this.normalizeResponsiveScaler(node);
        if (!scaler) return null;

        const effective = this.normalizeResponsiveScaler(node, this.mergeResponsiveScalerOverride(node, override));
        if (effective?.fit) {
            return fitAreaChildAnchorRect(effective.fit);
        }

        return {
            centerX: 0,
            centerY: 0,
            width: scaler.referenceWidth,
            height: scaler.referenceHeight,
        };
    }

    /**
     * Displace an anchored node's POSITION ONLY — scale / rotation / pivot /
     * skew stay exactly as `applyTransform` left them, mirroring the editor's
     * ordinary-branch anchoring.
     *
     * WRITES ONLY WHEN THE RESOLVED TARGET CHANGES. `transform` is deliberately
     * not release-tracked (AGENTS.md rule 18), so an unconditional per-draw
     * write would stomp a flow-driven `setNodePosition` or position tween every
     * frame with no escape hatch. `forceRewrite` covers the one case a value
     * comparison cannot see: the LayoutManager pass re-wrote this object's
     * position earlier in the SAME draw, so our last-written record is stale.
     */
    private applyParentAnchorToObject(
        obj: PixiDisplayObject,
        node: OrcaSceneNode,
        parentAnchorRect: AnchorRect | null,
        override: OrcaLayoutEntry | undefined,
        forceRewrite: boolean,
    ): void {
        const point = node.parentAnchor?.point;
        if (!isParentAnchorPoint(point)) return;
        // Mutually exclusive with `rectTransform`; the system surfaces own their
        // display transform outright (the editor strips the field from them).
        if (node.rectTransform || RECT_LAYOUT_EXCLUDED_TYPES.has(node.type)) return;
        // A parent that declares no rect makes a stored anchor INERT — preserved,
        // never destroyed (the `variableRef` precedent, AGENTS.md rule 24).
        if (!parentAnchorRect) return;

        // A per-mode LayoutManager override supplies x/y, which is still an
        // OFFSET from the anchor — read it from the same merged shape
        // `applyLayoutOverrideTransforms` used so the two cannot double-apply.
        const overrideTransform = override?.transform;
        const baseX = typeof overrideTransform?.x === 'number' ? overrideTransform.x : node.transform.x;
        const baseY = typeof overrideTransform?.y === 'number' ? overrideTransform.y : node.transform.y;

        const offset = resolveAnchorOffset(point, parentAnchorRect);
        // Remembered so an animated x/y channel stays an OFFSET from the anchor.
        (obj as { __orcaAnchorOffset?: { x: number; y: number } }).__orcaAnchorOffset = { x: offset.x, y: offset.y };
        const targetX = baseX + offset.x;
        const targetY = baseY + offset.y;
        if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return;

        const record = this.parentAnchorWrites.get(obj);
        if (!forceRewrite && record && record.x === targetX && record.y === targetY) return;

        obj.position.set(targetX, targetY);
        this.parentAnchorWrites.set(obj, { x: targetX, y: targetY });
    }

    /**
     * Walk the scene and resolve every RectTransform against its parent's
     * layout box, seeded from the resolved camera frame. Runs inside drawScene
     * so resize / orientation changes re-flow for free.
     *
     * The SAME walk resolves `parentAnchor`, which needs the identical
     * parent-by-parent descent (and, for a canvas parent, the identical
     * logical-rect resolution) — a second traversal would only be an
     * opportunity to drift. The two chains stay separate values, though: the
     * rect box falls back to a node's preferred size, whereas an anchor rect
     * must be `null` for any parent that does not DECLARE one.
     */
    private applyRectTransforms(
        frameWidth: number,
        frameHeight: number,
        rootAnchorRect: AnchorRect | null,
        layoutOverrides: Map<string, OrcaLayoutEntry>,
        overrideWrittenIds: ReadonlySet<string>,
    ): void {
        if (!this.currentScene) return;

        const safeFrameWidth = Math.max(1, frameWidth);
        const safeFrameHeight = Math.max(1, frameHeight);

        const walk = (nodes: OrcaSceneNode[], parentBox: RectLayoutBox, parentAnchorRect: AnchorRect | null): void => {
            for (const node of nodes) {
                let childBox = parentBox;
                const obj = this.nodeDisplayObjects.get(node.id);
                const alive = obj && !(obj as { destroyed?: boolean }).destroyed;

                if (node.type === 'canvas') {
                    childBox = this.resolveCanvasChildBox(node, safeFrameWidth, safeFrameHeight);
                } else if (alive && this.isRectLayoutNode(node)) {
                    // Children anchor against the PRE-contentScale rect, exactly
                    // as the editor does.
                    childBox = this.applyRectTransformToObject(obj, node, parentBox);
                } else if (alive) {
                    this.applyParentAnchorToObject(
                        obj,
                        node,
                        parentAnchorRect,
                        layoutOverrides.get(node.id),
                        overrideWrittenIds.has(node.id),
                    );
                    const preferred = this.getPreferredNodeSize(node, obj);
                    childBox = {
                        width: preferred.width > 0 ? preferred.width : parentBox.width,
                        height: preferred.height > 0 ? preferred.height : parentBox.height,
                    };
                }

                if (node.children.length > 0) {
                    walk(node.children, childBox, this.resolveChildAnchorRect(node, childBox, layoutOverrides.get(node.id)));
                }
            }
        };

        walk(this.currentScene.nodes, { width: safeFrameWidth, height: safeFrameHeight }, rootAnchorRect);
    }

    /**
     * Pixi 8 analogue of the removed `Texture.valid`. A `TextureSource` only
     * carries a `resource` (ImageBitmap / canvas / video element) once its
     * pixels exist, and source dimensions default to 1x1 — so they cannot
     * stand in for readiness on their own.
     */
    private isTextureReady(texture: unknown): boolean {
        if (!texture || texture === Pixi.Texture.EMPTY) return false;
        const source = (texture as { source?: { resource?: unknown; width?: number; height?: number } }).source;
        if (!source) return false;
        return !!source.resource && (source.width ?? 0) > 0 && (source.height ?? 0) > 0;
    }

    /**
     * A rect node sized off a lazily-resolved texture first lays out against an
     * invalid 1x1, so re-run the pass once the real extent arrives — the
     * runtime analogue of the editor's post-texture-load `refreshResponsiveLayout`.
     */
    private deferRectLayoutForTexture(obj: PixiDisplayObject): void {
        const texture = readSpriteFamilyTexture(obj);
        if (!texture || texture === Pixi.Texture.EMPTY || this.isTextureReady(texture)) return;
        // Pixi 8 raises the pixels-arrived signal on the SOURCE, not the texture.
        const source = (texture as { source?: { once?: (event: string, cb: () => void) => void } }).source;
        if (!source || typeof source.once !== 'function') return;

        const tagged = obj as { __orcaRectLayoutDeferredTexture?: unknown };
        if (tagged.__orcaRectLayoutDeferredTexture === texture) return;
        tagged.__orcaRectLayoutDeferredTexture = texture;

        source.once('update', () => {
            if (tagged.__orcaRectLayoutDeferredTexture === texture) {
                tagged.__orcaRectLayoutDeferredTexture = undefined;
            }
            if ((obj as { destroyed?: boolean }).destroyed) return;
            this.scheduleRectLayoutRefresh();
        });
    }

    private scheduleRectLayoutRefresh(): void {
        if (this.rectLayoutRefreshQueued) return;
        this.rectLayoutRefreshQueued = true;

        Promise.resolve().then(() => {
            this.rectLayoutRefreshQueued = false;
            if (!this.currentScene || !this.currentContainer) return;
            if (this.lastRendererWidth <= 0 || this.lastRendererHeight <= 0) return;
            this.drawScene(this.lastRendererWidth, this.lastRendererHeight);
        });
    }

    /**
     * Parsed `SkeletonData` for a SCOPE-QUALIFIED skeleton ref. Pixi 8 has no
     * `Loader.shared.resources` to probe, and the `Assets` cache holds the RAW
     * skeleton (JSON object / Uint8Array), never parsed `SkeletonData` — so
     * `sceneSpineDataCache`, seeded by `preloadSceneSpineAssets` under
     * `<scoped skeleton>::<atlas>`, is the only valid lookup. Matched on the
     * skeleton half so a caller that has not resolved the atlas still hits.
     */
    private findPreloadedSpineData(scopedSkeletonRef: string): unknown | undefined {
        if (!scopedSkeletonRef) return undefined;

        const exact = this.sceneSpineDataCache.get(scopedSkeletonRef);
        if (exact) return exact;

        const prefix = `${scopedSkeletonRef}::`;
        for (const key of Array.from(this.sceneSpineDataCache.keys())) {
            if (key.indexOf(prefix) === 0) return this.sceneSpineDataCache.get(key);
        }
        return undefined;
    }

    private resolveSpineData(node: OrcaSceneNode): { spineData: unknown | null; resolvedKey: string | null } {
        // Scope of the scene currently being built — the preload keyed its
        // parsed data by the owning bucket, so the probe must too.
        const scope = this.activeBuildOrigin;
        const candidates = this.buildSpineLookupCandidates(node);
        const assetManager = AssetManager as unknown as {
            getSpineResourceData?: (name: string) => unknown;
            animations?: Record<string, unknown>;
        };

        for (const key of candidates) {
            if (!key) continue;

            try {
                const fromAssetManager = assetManager.getSpineResourceData?.(key);
                if (fromAssetManager) {
                    return { spineData: fromAssetManager, resolvedKey: key };
                }
            } catch {
                // Keep trying fallback key formats.
            }

            const fromAnimations = assetManager.animations?.[key];
            if (fromAnimations) {
                return { spineData: fromAnimations, resolvedKey: key };
            }

            const fromPreload = this.findPreloadedSpineData(
                this.scopeQualifyRef(this.normalizeSceneAssetPath(key), scope),
            );
            if (fromPreload) {
                return { spineData: fromPreload, resolvedKey: key };
            }
        }

        return { spineData: null, resolvedKey: null };
    }

    private createSpineDisplayObject(node: OrcaSceneNode, spineData: unknown, resolvedKey: string | null): Spine {
        const spine = new Spine(spineData as any);
        spine.skeleton.setToSetupPose();

        if (node.skin && node.skin !== 'default') {
            try {
                spine.skeleton.setSkinByName(node.skin);
                spine.skeleton.setSlotsToSetupPose();
            } catch (e) {
                console.warn(`[SceneManager] Spine skin "${node.skin}" not found for "${node.name}" (key: "${resolvedKey ?? 'unknown'}")`, e);
            }
        }

        const availableAnimations = Array.isArray((spine as any)?.spineData?.animations)
            ? (spine as any).spineData.animations
            : [];
        const requestedAnimation = typeof node.animation === 'string' ? node.animation.trim() : '';
        const fallbackAnimationName = availableAnimations[0]?.name;
        const selectedAnimationName = requestedAnimation && spine.skeleton.data.findAnimation(requestedAnimation) !== null
            ? requestedAnimation
            : fallbackAnimationName;

        if (selectedAnimationName) {
            spine.state.setAnimation(0, selectedAnimationName, node.loop ?? true);
        }

        if (requestedAnimation && requestedAnimation !== selectedAnimationName) {
            console.warn(
                `[SceneManager] Spine animation "${requestedAnimation}" not found for "${node.name}" (key: "${resolvedKey ?? 'unknown'}"), falling back to "${selectedAnimationName ?? 'setup pose'}"`,
            );
        }

        if (node.timeScale !== undefined) spine.state.timeScale = node.timeScale;
        spine.autoUpdate = false;
        if (typeof spine.update === 'function') {
            spine.update(0);
        }
        if (node.playOnLoad) {
            this.activeSceneSpines.add(spine);
        }
        return spine;
    }

    private loadSpineIntoContainer(container: PixiContainer, node: OrcaSceneNode): void {
        (container as OrcaResolvedDisplayObjectWrapper).__orcaPendingCallbacks =
            (container as OrcaResolvedDisplayObjectWrapper).__orcaPendingCallbacks ?? [];

        void this.loadSpineDataForNode(node)
            .then(({ spineData, resolvedKey }) => {
                if ((container as unknown as { destroyed?: boolean }).destroyed) {
                    return;
                }

                const spine = this.createSpineDisplayObject(node, spineData, resolvedKey);
                (container as OrcaResolvedDisplayObjectWrapper).__orcaResolvedDisplayObject = spine;
                container.addChildAt(spine, 0);
                const pending = (container as OrcaResolvedDisplayObjectWrapper).__orcaPendingCallbacks as Array<(obj: PixiDisplayObject) => void> | undefined;
                (container as OrcaResolvedDisplayObjectWrapper).__orcaPendingCallbacks = undefined;
                pending?.forEach((cb) => {
                    try {
                        cb(spine);
                    } catch (callbackError) {
                        console.error(`[SceneManager] Deferred Spine callback failed for node "${node.name}"`, callbackError);
                    }
                });
            })
            .catch((error) => {
                (container as OrcaResolvedDisplayObjectWrapper).__orcaPendingCallbacks = undefined;
                console.error(
                    `[SceneManager] Direct Spine load failed for node "${node.name}" (skeleton: "${node.skeleton ?? ''}", atlas: "${node.atlas ?? ''}")`,
                    error,
                );
            });
    }

    private async loadSpineDataForNode(node: OrcaSceneNode): Promise<{ spineData: unknown; resolvedKey: string }> {
        // Capture the build scope synchronously (before any await) so the
        // async URL resolution targets the owning scene's bucket.
        const scope = this.activeBuildOrigin;
        const resolvedSkeleton = this.resolveSceneAssetPath(node.skeleton ?? '', ['pixi:spineSkeleton']);
        const inferredAtlasPath = this.inferSpineAtlasPath(node.skeleton ?? '', node.atlas ?? '');
        const resolvedAtlas = inferredAtlasPath
            ? this.resolveSceneAssetPath(inferredAtlasPath, ['pixi:spineAtlas'])
            : undefined;
        const candidates = this.buildSpineLookupCandidates(node);
        const resolvedKey = candidates[0] || resolvedSkeleton;

        if (!resolvedSkeleton) {
            throw new Error('Missing Spine skeleton path');
        }

        // Scope-qualify the cache key so a core and an active-skin skeleton
        // sharing a basename never share a parsed-spine-data cache slot.
        const cacheKey = `${this.scopeQualifyRef(this.normalizeSceneAssetPath(resolvedSkeleton), scope)}::${this.normalizeSceneAssetPath(resolvedAtlas || '')}`;
        const cachedSpineData = this.sceneSpineDataCache.get(cacheKey);
        if (cachedSpineData) {
            return { spineData: cachedSpineData, resolvedKey };
        }

        const inFlightLoad = this.sceneSpineLoadPromises.get(cacheKey);
        if (inFlightLoad) {
            return inFlightLoad;
        }

        // Pixi 8 removed `Loader.shared`, so the preload's parsed SkeletonData
        // is the only pre-existing source. It is keyed by the SCOPE-QUALIFIED
        // skeleton ref, so probe the lookup candidates (asset-index aliases and
        // the resolved path) under this scene's scope.
        for (const candidate of candidates.concat([resolvedSkeleton])) {
            const existing = this.findPreloadedSpineData(
                this.scopeQualifyRef(this.normalizeSceneAssetPath(candidate), scope),
            );
            if (existing) {
                this.sceneSpineDataCache.set(cacheKey, existing);
                return { spineData: existing, resolvedKey };
            }
        }

        const loadPromise = this.parseSpineDataFromUrls(resolvedSkeleton, resolvedAtlas, scope)
            .then((spineData) => {
                this.sceneSpineDataCache.set(cacheKey, spineData);
                this.sceneSpineLoadPromises.delete(cacheKey);
                return { spineData, resolvedKey };
            })
            .catch((error) => {
                this.sceneSpineLoadPromises.delete(cacheKey);
                throw error;
            });

        this.sceneSpineLoadPromises.set(cacheKey, loadPromise);
        return loadPromise;
    }

    /**
     * Scope prefix for a scene origin. A `core` scene's bucket maps to the
     * `core` runtime sub-path; a `skin` scene maps to `skins/<ACTIVE_SKIN>`.
     * Only the active skin is ever loaded at runtime, so a single prefix
     * suffices for skin scenes.
     */
    private scopePrefixForOrigin(origin: SceneOrigin | undefined): string {
        return origin === 'skin' ? `skins/${ACTIVE_SKIN}` : 'core';
    }

    /**
     * Prefix a BARE normalized ref with its owning scene's scope so it maps
     * to a scope-distinct runtime URL / cache key (`core/3.png` vs
     * `skins/<skin>/3.png`). De-collides same-basename refs across buckets.
     */
    private scopeQualifyRef(normalizedRef: string, origin: SceneOrigin | undefined): string {
        if (!normalizedRef) return normalizedRef;
        return `${this.scopePrefixForOrigin(origin)}/${normalizedRef}`;
    }

    private toAbsoluteSceneAssetUrl(assetPath: string, scope?: SceneOrigin): string {
        // Asset refs are bucket-relative subpaths (e.g. `1.png`, `Spine/x.png`,
        // `assets/generated/y.png`). Both dev and prod expose every bucket's
        // binaries under the `/assets` publicPath, so the fetch URL for a ref
        // R is `<assets base>/R`. When `scope` is provided, the ref is
        // SCOPE-QUALIFIED first (`/assets/core/R` or `/assets/skins/<skin>/R`)
        // so a core ref and an active-skin ref sharing a basename resolve to
        // distinct URLs. Unscoped callers (audio, fonts, legacy refs) keep the
        // flat `/assets/R` shape, which the dev middleware / prod flat copy
        // still resolve. Resolve R against the page-relative `assets/`
        // directory (NOT a hardcoded absolute `/assets/`) so prod sub-path
        // hosting keeps working, and so that a ref already under a folder
        // literally named `assets/` lands at `/assets/assets/...` (matching the
        // bucket-root mount). Absolute refs (http(s)://, file://, data:) are
        // preserved because `new URL(absolute, base)` ignores the base.
        const assetsBase = new URL('assets/', window.location.href);
        const normalizedRef = this.normalizeSceneAssetPath(assetPath);
        const scopedRef = scope ? this.scopeQualifyRef(normalizedRef, scope) : normalizedRef;
        const base = new URL(scopedRef, assetsBase).toString();
        if (this.assetCacheBust <= 0) return base;
        // Append cache-bust query so a re-fetch after `invalidateAndReloadCurrentScene`
        // is not satisfied by the browser HTTP / memory cache when the path
        // itself hasn't changed (e.g. user re-baked a sprite at a new
        // Resolution but `processing.outputTexturePath` is the same).
        return base + (base.indexOf('?') === -1 ? '?' : '&') + 'v=' + this.assetCacheBust;
    }

    private async fetchTextResource(targetUrl: string): Promise<string> {
        const response = await fetch(targetUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} while loading ${targetUrl}`);
        }

        return response.text();
    }

    private responseLooksLikeSceneAsset(response: Response, assetPath: string): boolean {
        if (!(response.ok || response.status === 206)) return false;

        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const normalizedPath = assetPath.split('?')[0].split('#')[0].toLowerCase();
        const isTexturePath = /\.(png|jpe?g|webp|gif|bmp)$/i.test(normalizedPath);
        const isTextAssetPath = /\.(json|atlas)$/i.test(normalizedPath);

        if (!contentType) {
            return !(isTexturePath || isTextAssetPath);
        }

        if (contentType === 'text/html') return false;

        if (isTexturePath) {
            return contentType.startsWith('image/') || contentType === 'application/octet-stream';
        }

        if (isTextAssetPath) {
            return contentType.includes('json') || contentType.startsWith('text/') || contentType === 'application/octet-stream';
        }

        return true;
    }

    /**
     * Defensive availability probe — NOT an authoritative gate.
     *
     * Returns:
     *   'ok'      — confirmed reachable + content-type looks right
     *   'missing' — explicit HTTP 404 from the server
     *   'unknown' — anything else (HEAD unsupported, ambiguous content-type,
     *               network error, partial response). Callers MUST proceed
     *               with the load attempt for 'unknown' results — only
     *               'missing' is authoritative enough to suppress queueing.
     *
     * Rationale: an earlier version returned a boolean, and ambiguous probe
     * results were treated as failure, gating off legitimate textures whose
     * server responses didn't fit the heuristic. The Pixi loader's onError
     * signal handles real load failures separately.
     */
    private async canFetchSceneAsset(assetPath: string): Promise<'ok' | 'missing' | 'unknown'> {
        const targetUrl = this.toAbsoluteSceneAssetUrl(assetPath);

        try {
            const response = await fetch(targetUrl, { method: 'HEAD' });
            if (response.status === 404) return 'missing';
            if (response.ok && this.responseLooksLikeSceneAsset(response, assetPath)) return 'ok';
            // HEAD may be unsupported (405) or ambiguous — fall through to GET probe.
            if (response.status !== 405 && !response.ok) {
                // Non-OK, non-404 (e.g. 5xx) — try a GET probe before giving up.
            }
        } catch {
            // Some dev/prod static servers do not support HEAD consistently.
        }

        try {
            const response = await fetch(targetUrl, {
                method: 'GET',
                headers: { Range: 'bytes=0-0' },
            });
            await response.body?.cancel();
            if (response.status === 404) return 'missing';
            if (this.responseLooksLikeSceneAsset(response, assetPath)) return 'ok';
            return 'unknown';
        } catch {
            return 'unknown';
        }
    }

    /**
     * Build a spine `TextureAtlas` from already-fetched atlas text. Spine 4.2's
     * constructor is synchronous and leaves each page textureless, so the page
     * images are loaded through `Assets` and attached as `SpineTexture`s — the
     * same sequence the official `spineTextureAtlasLoader` runs.
     */
    private async createTextureAtlasFromUrl(atlasText: string, atlasUrl: string): Promise<TextureAtlas> {
        const atlas = new TextureAtlas(atlasText);

        await Promise.all(atlas.pages.map(async (page) => {
            // Page names are declared RELATIVE TO THE ATLAS and are frequently
            // `.webp` — resolve against the atlas URL, never the bucket root,
            // and never assume the skeleton's extension.
            const imageUrl = new URL(page.name, atlasUrl).toString();
            try {
                const texture = await Pixi.Assets.load<Pixi.Texture>({
                    src: imageUrl,
                    data: { alphaMode: page.pma ? 'premultiplied-alpha' : 'premultiply-alpha-on-upload' },
                });
                // Substring-matched by `invalidateAndReloadCurrentScene`, so an
                // invalidated page ref still evicts its loaded image.
                this.registeredAssetAliases.add(imageUrl);
                page.setTexture(SpineTexture.from(texture.source));
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                throw new Error(`Failed to load Spine atlas image: ${imageUrl} (${detail})`);
            }
        }));

        return atlas;
    }

    /**
     * Spine 4.x is the only runtime available on Pixi 8 —
     * `@esotericsoftware/spine-pixi-v8` ships it alone and the pixi-spine
     * 3.7 / 3.8 runtimes have no Pixi 8 release. Reject an older export here,
     * by name, rather than letting `readSkeletonData` fail opaquely inside the
     * 4.x parser.
     */
    private assertSupportedSpineRuntime(rawVersion: unknown, skeletonUrl: string): void {
        const version = String(rawVersion ?? '').trim();
        if (!version || /^4(\.|$)/.test(version)) return;

        throw new Error(
            `Unsupported Spine runtime "${version}" for ${skeletonUrl} — this build ships the Spine 4.x runtime only `
            + '(@esotericsoftware/spine-pixi-v8); the Spine 3.7 / 3.8 runtimes have no Pixi 8 release. '
            + 'Re-export this skeleton and its atlas from Spine 4.x.',
        );
    }

    /**
     * Fetch-and-parse fallback for a spine skeleton the preload missed. A
     * rejection surfaces through the existing per-call-site diagnostics: a
     * standalone spine node logs `[SceneManager] Direct Spine load failed…`
     * and keeps its empty container; a reels symbol logs `[SceneManager] Reels
     * spine data load failed…` and falls back to its authored sprite. Nothing
     * here throws past those handlers.
     */
    private async parseSpineDataFromUrls(skeletonPath: string, atlasPath?: string, scope?: SceneOrigin): Promise<unknown> {
        const skeletonUrl = this.toAbsoluteSceneAssetUrl(skeletonPath, scope);
        const atlasUrl = atlasPath ? this.toAbsoluteSceneAssetUrl(atlasPath, scope) : '';

        if (!atlasUrl) {
            throw new Error(`Missing Spine atlas path for ${skeletonPath}`);
        }

        // `.skel` is a binary skeleton; everything else is read as JSON.
        const isBinarySkeleton = /\.skel(?:[?#].*)?$/i.test(skeletonPath);
        let skeletonBinary: Uint8Array | null = null;
        let skeletonJsonData: any = null;

        if (isBinarySkeleton) {
            const response = await fetch(skeletonUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} while loading ${skeletonUrl}`);
            }
            skeletonBinary = new Uint8Array(await response.arrayBuffer());
        } else {
            const skeletonText = await this.fetchTextResource(skeletonUrl);
            try {
                skeletonJsonData = JSON.parse(skeletonText);
            } catch {
                throw new Error(`Invalid Spine skeleton JSON: ${skeletonUrl}`);
            }
            this.assertSupportedSpineRuntime(skeletonJsonData?.skeleton?.spine, skeletonUrl);
        }

        const atlasText = await this.fetchTextResource(atlasUrl);
        const atlas = await this.createTextureAtlasFromUrl(atlasText, atlasUrl);
        const attachmentLoader = new AtlasAttachmentLoader(atlas);

        return skeletonBinary
            ? new SkeletonBinary(attachmentLoader).readSkeletonData(skeletonBinary)
            : new SkeletonJson(attachmentLoader).readSkeletonData(skeletonJsonData);
    }

    /**
     * Scope-bound async spine-data loader for the injected runtime reels
     * component. Reels spine symbols reference a skeleton via a bare,
     * bucket-relative `sharedSpineAnimation` (`.json`/`.skel`) with an
     * implicit same-basename `.atlas`. The injected `resolveReelsSpineData`
     * is lookup-only against the AssetManager loader resources and CANNOT
     * resolve asset-index aliases, the SCOPE-QUALIFIED preload key, or parse
     * from URL — so a bare-candidate miss returns null and the symbol renders
     * blank. This loader is threaded into `buildFlowstateReelsDisplay` to
     * self-heal that miss: it first consumes the scope-qualified registration
     * queued by `preloadSceneSpineAssets` (checking both the asset-index alias
     * key and the resolved-path key), then falls back to parsing the
     * scope-qualified `/assets/<scope>/<path>` URLs exactly like the
     * standalone spine node's `loadSpineDataForNode`. Returns null on any
     * failure (reels then falls back to the authored sprite / empty texture).
     */
    private async loadReelSpineData(skeletonPath: string, scope: SceneOrigin): Promise<unknown | null> {
        try {
            if (typeof skeletonPath !== 'string' || !skeletonPath.trim()) {
                return null;
            }

            const resolvedSkeleton = this.resolveSceneAssetPath(skeletonPath, ['pixi:spineSkeleton']);
            if (!resolvedSkeleton) {
                return null;
            }

            const assetManager = AssetManager as unknown as {
                getSpineResourceData?: (name: string) => unknown;
                animations?: Record<string, unknown>;
            };

            // Fast path: consume the scope-qualified registration from
            // preloadSceneSpineAssets. It may have been registered under the
            // asset-index alias key OR the resolved-path key, so probe both
            // (scope-qualified) before parsing.
            const aliases = this.getSceneAssetAliasesForPath(skeletonPath, ['pixi:spineSkeleton']);
            const registrationKeys = [...aliases, resolvedSkeleton]
                .map((candidate) => this.scopeQualifyRef(this.normalizeSceneAssetPath(candidate), scope))
                .filter(Boolean);
            for (const key of registrationKeys) {
                // Scope-qualified already — `findPreloadedSpineData` replaces the
                // Pixi 6 `Loader.shared.resources[key].spineData` probe.
                const fromPreload = this.findPreloadedSpineData(key);
                if (fromPreload) {
                    return fromPreload;
                }
                try {
                    const fromAssetManager = assetManager.getSpineResourceData?.(key);
                    if (fromAssetManager) {
                        return fromAssetManager;
                    }
                } catch {
                    // Fall through to the URL parse.
                }
                const fromAnimations = assetManager.animations?.[key];
                if (fromAnimations) {
                    return fromAnimations;
                }
            }

            // Self-heal: parse from the scope-qualified URLs (the same path the
            // standalone spine node uses when its preload/cache misses).
            const inferredAtlasPath = this.inferSpineAtlasPath(skeletonPath, '');
            const resolvedAtlas = inferredAtlasPath
                ? this.resolveSceneAssetPath(inferredAtlasPath, ['pixi:spineAtlas'])
                : undefined;
            return await this.parseSpineDataFromUrls(resolvedSkeleton, resolvedAtlas, scope);
        } catch (error) {
            console.warn(`[SceneManager] Reels spine data load failed for "${skeletonPath}"`, error);
            return null;
        }
    }

    private normalizeSceneAssetPath(rawPath: string): string {
        if (!rawPath) return '';

        const normalized = rawPath.trim().replace(/\\/g, '/');
        if (!normalized) return '';

        const withoutQuery = normalized.split('?')[0].split('#')[0];
        return withoutQuery.replace(/^\.\//, '').replace(/^\/+/, '');
    }

    private isSpriteDescriptorPath(rawPath: string): boolean {
        return /\.sprite\.json(?:[?#].*)?$/i.test((rawPath ?? '').trim());
    }

    private collectSceneSpriteDescriptorPaths(nodes: OrcaSceneNode[] | undefined): string[] {
        const descriptors: string[] = [];
        const addIfDescriptor = (rawPath: unknown): void => {
            if (typeof rawPath !== 'string' || !this.isSpriteDescriptorPath(rawPath)) return;
            const normalized = this.normalizeSceneAssetPath(rawPath);
            if (normalized && !descriptors.includes(normalized)) {
                descriptors.push(normalized);
            }
        };
        const visit = (sourceNode: OrcaSceneNode): void => {
            // Localized first: a locale-substituted `texture` may itself be a
            // descriptor, and it is the one that must be parsed ahead of the
            // synchronous build.
            const node = this.localizeNode(sourceNode);
            // Type-agnostic by design: `texture` is the whole-image ref for the
            // whole sprite family (`sprite` / `scratchableItem` / `nineSlice` /
            // `tilingSprite`), so a descriptor on ANY of them is collected.
            addIfDescriptor(node.texture);
            // `scratchableItem.brushTexture` is a SECOND, independent asset ref
            // on the node and is resolved SYNCHRONOUSLY during the scene build
            // (attachScratchBehaviour), so a descriptor brush must be parsed
            // ahead of it or `resolveSpriteDescriptorTexturePath` reports "was
            // not preloaded" and the brush silently degrades to the generated
            // radial one.
            addIfDescriptor(node.brushTexture);
            // Each parallax layer's image is resolved synchronously at build too.
            if (node.type === 'parallax' && Array.isArray(node.layers)) {
                for (const layer of node.layers) addIfDescriptor((layer as { texture?: unknown } | null)?.texture);
            }
            if (node.type === 'reels') {
                const entries: Array<string | undefined> = Array.isArray(node.symbolEntries) && node.symbolEntries.length > 0
                    ? node.symbolEntries.map((e) => e?.sprite)
                    : (Array.isArray(node.symbols) ? node.symbols : []);
                for (const sprite of entries) {
                    if (typeof sprite === 'string' && this.isSpriteDescriptorPath(sprite)) {
                        const normalized = this.normalizeSceneAssetPath(sprite);
                        if (normalized && !descriptors.includes(normalized)) {
                            descriptors.push(normalized);
                        }
                    }
                }
            }
            if (Array.isArray(node.children)) {
                for (const child of node.children) visit(child);
            }
        };

        if (Array.isArray(nodes)) {
            for (const node of nodes) visit(node);
        }

        return descriptors;
    }

    /**
     * Collect every `(spritesheetPath, spritesheetFrame)` pair referenced by a
     * frame-qualified sprite-family node. Frame mode is decided by the SHARED
     * {@link readSpritesheetFrameRef} helper — the SAME one `buildNode` uses —
     * so this preload can never disagree with the build about which nodes are
     * frame-mode. Drives `preloadSceneSpritesheetFrames` so the owning atlas
     * page is fetched + parsed ahead of the synchronous scene build; without
     * it `resolveSpritesheetFrameTexture` runs against an unparsed atlas and
     * the node renders NOTHING.
     */
    private collectSceneSpritesheetFrameRefs(nodes: OrcaSceneNode[] | undefined): Array<{ path: string; frame: string }> {
        const refs: Array<{ path: string; frame: string }> = [];
        const seen = new Set<string>();
        const visit = (sourceNode: OrcaSceneNode): void => {
            // `spritesheetPath` is locale-substitutable; the frame name is not.
            const node = this.localizeNode(sourceNode);
            const frameRef = this.readSpritesheetFrameRef(node);
            if (frameRef) {
                const normalized = this.normalizeSceneAssetPath(frameRef.path);
                if (normalized) {
                    const dedupeKey = `${normalized}::${frameRef.frame}`;
                    if (!seen.has(dedupeKey)) {
                        seen.add(dedupeKey);
                        refs.push({ path: normalized, frame: frameRef.frame });
                    }
                }
            }
            if (Array.isArray(node.children)) {
                for (const child of node.children) visit(child);
            }
        };

        if (Array.isArray(nodes)) {
            for (const node of nodes) visit(node);
        }

        return refs;
    }

    /**
     * Collect every RAW (non-descriptor, non-atlas-frame) image ref a node
     * resolves SYNCHRONOUSLY during the build. The runtime scene mirror's
     * `assets.bundles` is always empty, so without this a plain `<name>.png`
     * only starts downloading once the scene is built — invisible on
     * localhost, visible pop-in on a deployed server.
     */
    private collectSceneStaticTexturePaths(nodes: OrcaSceneNode[] | undefined): string[] {
        const paths: string[] = [];
        const add = (raw: unknown): void => {
            if (typeof raw !== 'string' || this.isSpriteDescriptorPath(raw)) return;
            const normalized = this.normalizeSceneAssetPath(raw);
            if (!normalized || !this.isLikelyTexturePath(normalized)) return;
            if (!paths.includes(normalized)) paths.push(normalized);
        };
        const visit = (sourceNode: OrcaSceneNode): void => {
            const node = this.localizeNode(sourceNode);
            if (STATIC_TEXTURE_NODE_TYPES.has(node.type) && !this.readSpritesheetFrameRef(node)) {
                add(node.texture);
            }
            if (node.type === 'animatedSprite' && Array.isArray(node.textures)) {
                for (const frame of node.textures) add(frame);
            }
            if (node.type === 'reels') {
                const sprites: Array<string | undefined> = Array.isArray(node.symbolEntries) && node.symbolEntries.length > 0
                    ? node.symbolEntries.map((e) => e?.sprite)
                    : (Array.isArray(node.symbols) ? node.symbols : []);
                for (const sprite of sprites) {
                    if (typeof sprite !== 'string') continue;
                    // Mirrors buildFlowstateReelsDisplay: a slash-less name with an atlas is an atlas frame.
                    if (node.symbolStaticsAtlas && !/[/\\]/.test(sprite)) continue;
                    add(sprite);
                }
            }
            const mask = node.mask;
            if (mask && mask.enabled !== false && mask.source === 'texture') {
                add(mask.texture);
            }
            if (Array.isArray(node.children)) {
                for (const child of node.children) visit(child);
            }
        };

        if (Array.isArray(nodes)) {
            for (const node of nodes) visit(node);
        }

        return paths;
    }

    /**
     * Collect every RAW (non-descriptor) `scratchableItem.brushTexture` ref so
     * the brush bitmap is in the loader cache before `attachScratchBehaviour`
     * resolves it synchronously during the build. An unloaded lazy texture
     * measures 0x0, so `brush.width = …` yields an Infinity scale and the first
     * strokes erase nothing. Descriptor brushes go through
     * `collectSceneSpriteDescriptorPaths` instead.
     */
    private collectSceneScratchBrushPaths(nodes: OrcaSceneNode[] | undefined): string[] {
        const paths: string[] = [];
        const visit = (node: OrcaSceneNode): void => {
            const brushRef = typeof node.brushTexture === 'string' ? node.brushTexture.trim() : '';
            if (brushRef && !this.isSpriteDescriptorPath(brushRef)) {
                const normalized = this.normalizeSceneAssetPath(brushRef);
                if (normalized && !paths.includes(normalized)) paths.push(normalized);
            }
            if (Array.isArray(node.children)) {
                for (const child of node.children) visit(child);
            }
        };

        if (Array.isArray(nodes)) {
            for (const node of nodes) visit(node);
        }

        return paths;
    }

    /**
     * Every plain-image reel symbol (`symbolEntries[].sprite`, or the legacy
     * `symbols`), so the first board draws from loaded textures. Descriptors
     * are `collectSceneSpriteDescriptorPaths`'; a bare name on a node with a
     * `symbolStaticsAtlas` is an atlas frame, not a file.
     */
    private collectSceneReelSymbolImagePaths(nodes: OrcaSceneNode[] | undefined): string[] {
        const paths: string[] = [];
        const visit = (node: OrcaSceneNode): void => {
            if (node.type === 'reels') {
                const entries: Array<string | undefined> = Array.isArray(node.symbolEntries) && node.symbolEntries.length > 0
                    ? node.symbolEntries.map((e) => e?.sprite)
                    : (Array.isArray(node.symbols) ? node.symbols : []);
                for (const raw of entries) {
                    const sprite = typeof raw === 'string' ? raw.trim() : '';
                    if (!sprite || this.isSpriteDescriptorPath(sprite) || !this.isLikelyTexturePath(sprite)) continue;
                    if (node.symbolStaticsAtlas && !/[/\\]/.test(sprite)) continue;
                    const normalized = this.normalizeSceneAssetPath(sprite);
                    if (normalized && !paths.includes(normalized)) paths.push(normalized);
                }
            }
            if (Array.isArray(node.children)) {
                for (const child of node.children) visit(child);
            }
        };

        if (Array.isArray(nodes)) {
            for (const node of nodes) visit(node);
        }

        return paths;
    }

    /**
     * Every plain image a scene's own nodes draw: `texture` across the sprite
     * family, an animated sprite's `textures[]`, each parallax layer's
     * `texture` and a mask's `texture`. Descriptors (`*.sprite.json`) are
     * `collectSceneSpriteDescriptorPaths`'; a ref with no image extension (an
     * atlas frame, a legacy alias) is left to the build.
     */
    private collectSceneNodeTexturePaths(nodes: OrcaSceneNode[] | undefined): string[] {
        const paths: string[] = [];
        const seen = new Set<string>();
        const add = (raw: unknown): void => {
            const ref = typeof raw === 'string' ? raw.trim() : '';
            if (!ref || this.isSpriteDescriptorPath(ref) || !this.isLikelyTexturePath(ref)) return;
            const normalized = this.normalizeSceneAssetPath(ref);
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            paths.push(normalized);
        };
        const visit = (sourceNode: OrcaSceneNode): void => {
            const node = this.localizeNode(sourceNode);
            add(node.texture);
            if (Array.isArray(node.textures)) {
                for (const frame of node.textures) add(frame);
            }
            if (node.type === 'parallax' && Array.isArray(node.layers)) {
                for (const layer of node.layers) add((layer as { texture?: unknown } | null)?.texture);
            }
            add((node.mask as { texture?: unknown } | null | undefined)?.texture);
            if (Array.isArray(node.children)) {
                for (const child of node.children) visit(child);
            }
        };

        if (Array.isArray(nodes)) {
            for (const node of nodes) visit(node);
        }

        return paths;
    }

    /**
     * Collect every custom-component `assetRef` path so the texture is in the
     * loader cache before `instantiateCustomComponents` resolves it
     * SYNCHRONOUSLY during the build — the same 0x0 hazard
     * `collectSceneScratchBrushPaths` guards against, here surfacing as a
     * component reading `width`/`height` as 0 in `onCreate`.
     *
     * EVERY value in `assetProperties` is an asset ref by construction, so this
     * is a purely structural walk with no registry or definition lookup. Both
     * descriptor and raw refs are returned unqualified; the caller splits them
     * and scope-qualifies exactly as it does for the sibling collectors.
     */
    private collectSceneComponentAssetPaths(nodes: OrcaSceneNode[] | undefined): string[] {
        const paths: string[] = [];
        const visit = (node: OrcaSceneNode): void => {
            const authored = node?.customComponents;
            if (Array.isArray(authored)) {
                for (const entry of authored) {
                    const assetProperties = entry?.assetProperties;
                    if (!assetProperties || typeof assetProperties !== 'object' || Array.isArray(assetProperties)) continue;
                    for (const key of Object.keys(assetProperties)) {
                        const raw = assetProperties[key];
                        if (typeof raw !== 'string') continue;
                        const normalized = this.normalizeSceneAssetPath(raw);
                        if (normalized && !paths.includes(normalized)) paths.push(normalized);
                    }
                }
            }
            if (Array.isArray(node.children)) {
                for (const child of node.children) visit(child);
            }
        };

        if (Array.isArray(nodes)) {
            for (const node of nodes) visit(node);
        }

        return paths;
    }

    private resolveTexturePathRelativeToDescriptor(descriptorPath: string, rawTexturePath: string): string {
        const trimmed = rawTexturePath.trim().replace(/\\/g, '/');
        if (!trimmed) return '';

        if (/^(?:https?:)?\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
            return trimmed;
        }

        const withoutLeadingSlash = trimmed.replace(/^\/+/, '');
        const runtimeSkinMatch = withoutLeadingSlash.match(/^game\/src\/skins\/[^/]+\/(.+)$/i);
        if (runtimeSkinMatch?.[1]) {
            return this.normalizeSceneAssetPath(runtimeSkinMatch[1]);
        }

        const runtimeCoreMatch = withoutLeadingSlash.match(/^game\/src\/core\/(.+)$/i);
        if (runtimeCoreMatch?.[1]) {
            return this.normalizeSceneAssetPath(runtimeCoreMatch[1]);
        }

        const authoringSkinMatch = withoutLeadingSlash.match(/^orca-project-files\/skins\/[^/]+\/(.+)$/i);
        if (authoringSkinMatch?.[1]) {
            return this.normalizeSceneAssetPath(authoringSkinMatch[1]);
        }

        const authoringCoreMatch = withoutLeadingSlash.match(/^orca-project-files\/core\/(.+)$/i);
        if (authoringCoreMatch?.[1]) {
            return this.normalizeSceneAssetPath(authoringCoreMatch[1]);
        }

        if (/^(assets|static|core|skins|orca-project-files|scenes|flowstate|\.orca-sources|\.cache)\//i.test(withoutLeadingSlash)) {
            return this.normalizeSceneAssetPath(withoutLeadingSlash);
        }

        const normalizedDescriptorPath = this.normalizeSceneAssetPath(descriptorPath);
        const descriptorDir = normalizedDescriptorPath.split('/').slice(0, -1).join('/');
        return this.normalizeSceneAssetPath(descriptorDir ? `${descriptorDir}/${trimmed}` : trimmed);
    }

    private cacheSpriteDescriptorTexturePath(descriptorPath: string, texturePath: string | null, scope: SceneOrigin): void {
        // Cache under SCOPE-QUALIFIED descriptor candidates so a core and an
        // active-skin descriptor sharing a basename resolve to distinct
        // backing textures.
        const candidates = this.buildSceneAssetPathCandidates(descriptorPath)
            .map(candidate => this.scopeQualifyRef(candidate, scope));
        for (const candidate of candidates) {
            this.spriteDescriptorTextureCache.set(candidate, { texturePath });
        }
    }

    /**
     * When a sprite descriptor (`*.sprite.json`) is unavailable or unparseable,
     * try the sibling source image alongside it (e.g. `Symbols/3.sprite.json`
     * → `Symbols/3.png`). Returns the first probe-able candidate path or null.
     * This is a graceful-fidelity fallback so reels symbols (and other sprite
     * descriptor consumers) render the bare source image instead of
     * `Texture.WHITE` when the authoring descriptor hasn't been baked yet.
     */
    private async tryResolveBareImageForDescriptor(descriptorPath: string, scope: SceneOrigin): Promise<string | null> {
        const normalized = this.normalizeSceneAssetPath(descriptorPath);
        const base = normalized.replace(/\.sprite\.json$/i, '');
        if (!base || base === normalized) return null;
        for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
            const candidate = `${base}${ext}`;
            // Probe the SCOPE-QUALIFIED sibling so we don't pick up a
            // same-basename image from the other bucket.
            const probe = await this.canFetchSceneAsset(this.scopeQualifyRef(candidate, scope));
            if (probe === 'ok' || probe === 'unknown') {
                return candidate;
            }
        }
        return null;
    }

    private async cacheSpriteDescriptorBareImageFallback(descriptorPath: string, scope: SceneOrigin): Promise<string | null> {
        const bareImagePath = await this.tryResolveBareImageForDescriptor(descriptorPath, scope);
        if (bareImagePath) {
            console.info(`[SceneManager] Sprite descriptor unavailable; falling back to sibling source image: ${descriptorPath} -> ${bareImagePath}`);
            this.cacheSpriteDescriptorTexturePath(descriptorPath, bareImagePath, scope);
            return bareImagePath;
        }
        this.cacheSpriteDescriptorTexturePath(descriptorPath, null, scope);
        return null;
    }

    private async preloadSceneSpriteDescriptors(
        descriptors: Array<{ path: string; scope: SceneOrigin }>,
    ): Promise<Array<{ path: string; scope: SceneOrigin }>> {
        // De-dupe by SCOPE-QUALIFIED descriptor identity so a core and an
        // active-skin descriptor sharing a basename are BOTH processed.
        const seenScopedDescriptors = new Set<string>();
        const uniqueDescriptors: Array<{ path: string; scope: SceneOrigin }> = [];
        for (const descriptor of descriptors) {
            const normalized = this.normalizeSceneAssetPath(descriptor.path);
            if (!normalized) continue;
            const scopedKey = this.scopeQualifyRef(normalized, descriptor.scope);
            if (seenScopedDescriptors.has(scopedKey)) continue;
            seenScopedDescriptors.add(scopedKey);
            uniqueDescriptors.push({ path: normalized, scope: descriptor.scope });
        }
        const texturePaths: Array<{ path: string; scope: SceneOrigin }> = [];

        for (const { path: descriptorPath, scope } of uniqueDescriptors) {
            try {
                const descriptorUrl = this.toAbsoluteSceneAssetUrl(descriptorPath, scope);
                const descriptorText = await this.fetchTextResource(descriptorUrl);
                // Defense-in-depth: even with the dev-server SPA fallback now
                // narrowed to exclude /assets/**, some prod / mock servers
                // still happily return HTML 200 for missing JSON. Detect that
                // case and treat it as "descriptor not found" with a legible
                // warning instead of the misleading "Invalid sprite
                // descriptor JSON" branch below.
                const looksLikeHtml = /^\s*<(?:!doctype|html|head|body)/i.test(descriptorText);
                if (looksLikeHtml) {
                    // HTML (SPA fallback) means the JSON file isn't really
                    // served — i.e. the asset was removed. Try the sibling
                    // source image; if that's gone too, degrade quietly.
                    const fallback = await this.cacheSpriteDescriptorBareImageFallback(descriptorPath, scope);
                    if (fallback) {
                        texturePaths.push({ path: fallback, scope });
                    } else {
                        console.debug(`[SceneManager] Sprite descriptor unavailable (removed asset, no sibling image): ${descriptorPath}`);
                    }
                    continue;
                }
                let descriptorJson: any;
                try {
                    descriptorJson = JSON.parse(descriptorText);
                } catch {
                    // Distinguish a genuinely-removed asset (descriptor AND
                    // sibling image both gone) from a real malformed-but-
                    // present descriptor. Only the former is quieted.
                    const fallback = await this.cacheSpriteDescriptorBareImageFallback(descriptorPath, scope);
                    if (fallback) {
                        console.warn(`[SceneManager] Invalid sprite descriptor JSON: ${descriptorPath}`);
                        texturePaths.push({ path: fallback, scope });
                    } else {
                        console.debug(`[SceneManager] Sprite descriptor unavailable (removed asset): ${descriptorPath}`);
                    }
                    continue;
                }

                const rawTextureCandidates = [
                    typeof descriptorJson?.processing?.outputTexturePath === 'string' ? descriptorJson.processing.outputTexturePath.trim() : '',
                    typeof descriptorJson?.texture === 'string' ? descriptorJson.texture.trim() : '',
                    typeof descriptorJson?.processing?.sourceImagePath === 'string' ? descriptorJson.processing.sourceImagePath.trim() : '',
                ].filter(Boolean);
                if (rawTextureCandidates.length === 0) {
                    console.warn(`[SceneManager] Sprite descriptor is missing a usable texture field: ${descriptorPath}`);
                    const fallback = await this.cacheSpriteDescriptorBareImageFallback(descriptorPath, scope);
                    if (fallback) texturePaths.push({ path: fallback, scope });
                    continue;
                }

                const attemptedTexturePaths: string[] = [];
                let texturePath = '';

                for (const rawTexturePath of rawTextureCandidates) {
                    const candidateTexturePath = this.resolveTexturePathRelativeToDescriptor(descriptorPath, rawTexturePath);
                    if (!candidateTexturePath) continue;

                    attemptedTexturePaths.push(candidateTexturePath);
                    // Treat both 'ok' and 'unknown' probe results as worth picking —
                    // only an explicit 'missing' (404) eliminates a candidate.
                    // Probe the SCOPE-QUALIFIED candidate (descriptor-relative
                    // images inherit the descriptor's scope).
                    const probeResult = await this.canFetchSceneAsset(this.scopeQualifyRef(this.normalizeSceneAssetPath(candidateTexturePath), scope));
                    if (probeResult !== 'missing') {
                        texturePath = candidateTexturePath;
                        break;
                    }
                }

                if (!texturePath) {
                    const tried = attemptedTexturePaths.length > 0 ? ` Tried: ${attemptedTexturePaths.join(', ')}` : '';
                    console.warn(`[SceneManager] Sprite descriptor has no fetchable backing texture: ${descriptorPath}.${tried}`);
                    const fallback = await this.cacheSpriteDescriptorBareImageFallback(descriptorPath, scope);
                    if (fallback) texturePaths.push({ path: fallback, scope });
                    continue;
                }

                this.cacheSpriteDescriptorTexturePath(descriptorPath, texturePath, scope);
                texturePaths.push({ path: texturePath, scope });
            } catch (err) {
                // Includes the `fetchTextResource` HTTP 404 throw path now that
                // the dev server returns honest 404s under /assets/**.
                const message = err instanceof Error ? err.message : String(err);
                const looksLike404 = /HTTP\s+404/i.test(message);
                const fallback = await this.cacheSpriteDescriptorBareImageFallback(descriptorPath, scope);
                if (fallback) {
                    texturePaths.push({ path: fallback, scope });
                } else if (looksLike404) {
                    // Descriptor 404s and no sibling image exists — the asset
                    // was removed. Degrade quietly (discoverable at debug).
                    console.debug(`[SceneManager] Sprite descriptor not found (404, removed asset): ${descriptorPath}`);
                } else {
                    // Unexpected, non-404 failure — keep this loud.
                    console.warn(`[SceneManager] Failed to load sprite descriptor "${descriptorPath}":`, err);
                }
            }
        }

        return texturePaths;
    }

    /**
     * Resolve a spritesheet page image to a READY `Texture` before it is handed
     * to `Spritesheet`, which needs real source dimensions to slice frame rects.
     *
     * Pixi 8 deleted `BaseTexture`, and its `Texture.from(url)` is a synchronous
     * cache lookup that never fetches — so the page image is loaded through
     * `Assets`, exactly like the Spine atlas page loader
     * (`createTextureAtlasFromUrl`). Resolves only with a texture that passes
     * `isTextureReady`; every other outcome rejects.
     */
    private async loadSpritesheetPageTexture(imageUrl: string): Promise<PixiTexture> {
        let texture: PixiTexture;
        try {
            texture = await Pixi.Assets.load<PixiTexture>(imageUrl);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to load spritesheet page image: ${imageUrl} (${detail})`);
        }

        // Substring-matched by `invalidateAndReloadCurrentScene`, so the page
        // image is evicted along with the descriptor that pulled it in.
        this.registeredAssetAliases.add(imageUrl);

        if (!this.isTextureReady(texture)) {
            throw new Error(`Spritesheet page image resolved without pixels: ${imageUrl}`);
        }

        return texture;
    }

    /**
     * Preload the atlas-frame textures referenced by frame-qualified `sprite`
     * nodes. Each `*.spritesheet.json` descriptor is fetched + parsed ONCE per
     * SCOPE, then the page owning each needed frame is built into a
     * `PIXI.Spritesheet` and its frame textures cached under the
     * SCOPE-QUALIFIED descriptor key — so the synchronous sprite build resolves
     * `textures[spritesheetFrame]` with no pop-in, and a core sheet and an
     * active-skin sheet sharing a basename never collide.
     */
    private async preloadSceneSpritesheetFrames(
        refs: Array<{ path: string; frame: string; scope: SceneOrigin }>,
    ): Promise<void> {
        if (refs.length === 0) return;

        // Group the needed frames per SCOPE-QUALIFIED descriptor identity so each
        // descriptor is fetched once and both buckets' sheets are processed.
        const byDescriptor = new Map<string, { path: string; scope: SceneOrigin; frames: Set<string> }>();
        for (const ref of refs) {
            const normalized = this.normalizeSceneAssetPath(ref.path);
            if (!normalized || !ref.frame) continue;
            const scopedKey = this.scopeQualifyRef(normalized, ref.scope);
            let entry = byDescriptor.get(scopedKey);
            if (!entry) {
                entry = { path: normalized, scope: ref.scope, frames: new Set<string>() };
                byDescriptor.set(scopedKey, entry);
            }
            entry.frames.add(ref.frame);
        }

        for (const [scopedDescriptorKey, entry] of byDescriptor) {
            try {
                await this.preloadSpritesheetDescriptorFrames(scopedDescriptorKey, entry.path, entry.scope, entry.frames);
            } catch (err) {
                console.warn(`[SceneManager] Failed to preload spritesheet frames for "${entry.path}":`, err);
            }
        }
    }

    /**
     * Fetch a multi-page `*.spritesheet.json` descriptor, select the page that
     * OWNS each needed frame, and parse those pages into the scope-qualified
     * frame-texture cache. Mirrors `preloadSceneSpriteDescriptors`' defensive
     * HTML-200 / malformed-JSON handling.
     */
    private async preloadSpritesheetDescriptorFrames(
        scopedDescriptorKey: string,
        descriptorPath: string,
        scope: SceneOrigin,
        neededFrames: Set<string>,
    ): Promise<void> {
        const existing = this.spritesheetFrameTextureCache.get(scopedDescriptorKey);
        const missingFrames = Array.from(neededFrames).filter((frame) => !this.isTextureReady(existing?.get(frame)));
        if (missingFrames.length === 0) return;

        const descriptorUrl = this.toAbsoluteSceneAssetUrl(descriptorPath, scope);
        const descriptorText = await this.fetchTextResource(descriptorUrl);

        // SPA fallbacks can answer a removed descriptor with an HTML 200; treat
        // that as "not found" instead of misreporting malformed JSON.
        if (/^\s*<(?:!doctype|html|head|body)/i.test(descriptorText)) {
            console.debug(`[SceneManager] Spritesheet descriptor unavailable (removed asset): ${descriptorPath}`);
            return;
        }

        let descriptorJson: any;
        try {
            descriptorJson = JSON.parse(descriptorText);
        } catch {
            console.warn(`[SceneManager] Invalid spritesheet descriptor JSON: ${descriptorPath}`);
            return;
        }

        const pages = Array.isArray(descriptorJson?.pages) ? descriptorJson.pages : [];
        if (pages.length === 0) {
            console.warn(`[SceneManager] Spritesheet descriptor has no pages: ${descriptorPath}`);
            return;
        }

        // Select the page that owns each frame; parse each distinct owning page
        // exactly once even when several frames share a page.
        const pagesToParse = new Map<number, any>();
        for (const frame of missingFrames) {
            const pageIndex = pages.findIndex(
                (page: any) => page && page.frames && Object.prototype.hasOwnProperty.call(page.frames, frame),
            );
            if (pageIndex < 0) {
                console.warn(`[SceneManager] Spritesheet frame "${frame}" not found in any page of descriptor: ${descriptorPath}`);
                continue;
            }
            pagesToParse.set(pageIndex, pages[pageIndex]);
        }

        for (const [, page] of pagesToParse) {
            try {
                await this.parseSpritesheetPageIntoCache(scopedDescriptorKey, descriptorPath, scope, page);
            } catch (err) {
                console.warn(`[SceneManager] Failed to parse spritesheet page for "${descriptorPath}":`, err);
            }
        }
    }

    /**
     * Build a single atlas page into a `PIXI.Spritesheet` and merge its frame
     * textures into the scope-qualified cache. A `*.spritesheet.json` page is a
     * directly PIXI-hash-parseable atlas (`{ image, size, frames }`), so this is
     * the multi-page generalization of the single-page reels-statics atlas load
     * — selecting the owning page is the only new step.
     */
    private async parseSpritesheetPageIntoCache(
        scopedDescriptorKey: string,
        descriptorPath: string,
        scope: SceneOrigin,
        page: any,
    ): Promise<void> {
        const frames = page?.frames && typeof page.frames === 'object' ? page.frames : null;
        const rawImage = typeof page?.image === 'string' ? page.image.trim() : '';
        if (!frames || !rawImage) {
            console.warn(`[SceneManager] Spritesheet page is missing image/frames: ${descriptorPath}`);
            return;
        }

        // Resolve the page image RELATIVE TO THE DESCRIPTOR's own directory, then
        // scope-qualify exactly like the sprite-descriptor + reels-atlas
        // resolvers so the page PNG is fetched from the owning bucket.
        const resolvedImagePath = this.resolveTexturePathRelativeToDescriptor(descriptorPath, rawImage);
        const imageUrl = this.toAbsoluteSceneAssetUrl(resolvedImagePath, scope);

        const pageTexture = await this.loadSpritesheetPageTexture(imageUrl);

        // Single-page PIXI-hash parse — `page.frames` is consumed verbatim by
        // Spritesheet (identical shape to the reels-statics atlas). Pixi 8's
        // `parse()` is Promise-only; the 6.x callback form is gone.
        const spritesheet = new Pixi.Spritesheet(pageTexture, { frames, meta: { scale: '1' } });
        const parsedTextures = await spritesheet.parse();

        let frameMap = this.spritesheetFrameTextureCache.get(scopedDescriptorKey);
        if (!frameMap) {
            frameMap = new Map<string, PixiTexture>();
            this.spritesheetFrameTextureCache.set(scopedDescriptorKey, frameMap);
        }

        // RULE 15a (bare-name shadowing): Pixi 6's `Spritesheet.parse()` used to
        // register every frame under its BARE name in the global
        // `PIXI.utils.TextureCache`, so this loop had to strip them back out or a
        // same-named frame from another scope's sheet would shadow this one.
        // Pixi 8 no longer does that: `Spritesheet.mjs` imports only Rectangle /
        // TextureSource / Texture and never touches `Cache`, and frame names
        // reach the global cache ONLY via the loader parser
        // (`spritesheetAsset.getCacheableAssets`, keyed `${cachePrefix}${frame}`),
        // which runs only for a sheet loaded through `Assets.load(<atlas json>)`.
        // This sheet is constructed directly, so nothing is published globally
        // and the scope-qualified `spritesheetFrameTextureCache` below is the
        // only place these frames are addressable. No strip is needed.
        for (const [frameName, texture] of Object.entries(parsedTextures)) {
            frameMap.set(frameName, texture);
        }
    }

    private buildSceneAssetPathCandidates(rawPath: string): string[] {
        const candidates: string[] = [];

        const addCandidate = (value: string | undefined): void => {
            if (!value) return;
            const normalized = this.normalizeSceneAssetPath(value);
            if (!normalized) return;
            if (!candidates.includes(normalized)) {
                candidates.push(normalized);
            }
        };

        addCandidate(rawPath);

        const normalized = this.normalizeSceneAssetPath(rawPath);
        if (!normalized) {
            return candidates;
        }

        const staticAssetsMatch = normalized.match(/^static\/assets\/[^/]+\/(.+)$/i);
        if (staticAssetsMatch?.[1]) {
            addCandidate(staticAssetsMatch[1]);
        }

        const assetsMatch = normalized.match(/^assets\/[^/]+\/(.+)$/i);
        if (assetsMatch?.[1]) {
            addCandidate(assetsMatch[1]);
        }

        const fileName = normalized.split('/').filter(Boolean).pop();
        addCandidate(fileName);

        if (fileName) {
            addCandidate(fileName.replace(/\.[^.]+$/, ''));
        }

        addCandidate(normalized.replace(/\.[^.]+$/, ''));

        return candidates;
    }

    private normalizeSceneAssetTags(asset: OrcaAssetDefinition): string[] {
        const tags = new Set<string>(Array.isArray(asset.tags) ? asset.tags : []);

        const lowerType = (asset.type || '').toLowerCase();
        const lowerSrc = (asset.src || '').toLowerCase();

        if (lowerType === 'texture' || /\.(png|jpe?g|webp|gif|bmp)$/.test(lowerSrc)) {
            tags.add('pixi:texture');
        }

        if (lowerType === 'json' && this.isSpriteDescriptorPath(lowerSrc)) {
            tags.add('pixi:spriteDescriptor');
        }

        if (lowerType === 'font' || /\.(otf|ttf|woff2?)$/.test(lowerSrc)) {
            tags.add('pixi:font');
        }

        if (lowerType === 'spine' || lowerSrc.endsWith('.skel.json') || lowerSrc.endsWith('.skeleton.json')) {
            tags.add('pixi:spineSkeleton');
        }

        if (lowerSrc.endsWith('.atlas')) {
            tags.add('pixi:spineAtlas');
        }

        return Array.from(tags);
    }

    private ensureSceneAssetTags(scene: OrcaSceneData): void {
        const bundles = scene.assets?.bundles;
        if (!Array.isArray(bundles)) return;

        for (const bundle of bundles) {
            if (!Array.isArray(bundle.assets)) continue;

            for (const asset of bundle.assets) {
                asset.tags = this.normalizeSceneAssetTags(asset);
            }
        }
    }

    private indexSceneAssets(scene: OrcaSceneData): void {
        this.sceneAssetsByAlias.clear();
        this.sceneAssetsByPath.clear();

        const bundles = scene.assets?.bundles;
        if (!Array.isArray(bundles)) return;

        for (const bundle of bundles) {
            if (!Array.isArray(bundle.assets)) continue;

            for (const asset of bundle.assets) {
                const normalizedTags = this.normalizeSceneAssetTags(asset);
                asset.tags = normalizedTags;

                if (asset.alias) {
                    this.sceneAssetsByAlias.set(asset.alias, asset);
                }

                const candidates = this.buildSceneAssetPathCandidates(asset.src);
                for (const candidate of candidates) {
                    if (!this.sceneAssetsByPath.has(candidate)) {
                        this.sceneAssetsByPath.set(candidate, asset);
                    }
                }
            }
        }
    }

    private hasAnyTag(asset: OrcaAssetDefinition, requiredTags: string[] | undefined): boolean {
        if (!requiredTags || requiredTags.length === 0) {
            return true;
        }

        const assetTags = new Set<string>(asset.tags ?? []);
        return requiredTags.some(tag => assetTags.has(tag));
    }

    private resolveSceneAssetPath(rawPath: string, requiredTags?: string[]): string {
        const byAlias = this.sceneAssetsByAlias.get(rawPath);
        if (byAlias && this.hasAnyTag(byAlias, requiredTags)) {
            return byAlias.src;
        }

        const candidates = this.buildSceneAssetPathCandidates(rawPath);
        for (const candidate of candidates) {
            const asset = this.sceneAssetsByPath.get(candidate);
            if (asset && this.hasAnyTag(asset, requiredTags)) {
                return asset.src;
            }
        }

        return rawPath;
    }

    private getSceneAssetAliasesForPath(rawPath: string, requiredTags?: string[]): string[] {
        const aliases: string[] = [];
        const candidates = this.buildSceneAssetPathCandidates(rawPath);

        for (const candidate of candidates) {
            const asset = this.sceneAssetsByPath.get(candidate);
            if (!asset || !asset.alias) continue;
            if (!this.hasAnyTag(asset, requiredTags)) continue;
            if (!aliases.includes(asset.alias)) {
                aliases.push(asset.alias);
            }
        }

        return aliases;
    }

    private buildTextureLookupCandidates(rawPath: string): string[] {
        const candidates: string[] = [];

        const addCandidate = (value: string | undefined): void => {
            if (!value) return;
            const normalized = value.trim();
            if (!normalized) return;
            if (!candidates.includes(normalized)) {
                candidates.push(normalized);
            }
        };

        const normalizedPath = rawPath.trim().replace(/\\/g, '/');
        if (!normalizedPath) {
            return candidates;
        }

        const withoutQuery = normalizedPath.split('?')[0].split('#')[0];
        const withoutDotPrefix = withoutQuery.replace(/^\.\//, '');
        const withoutLeadingSlash = withoutDotPrefix.replace(/^\/+/, '');

        addCandidate(normalizedPath);
        addCandidate(withoutQuery);
        addCandidate(withoutDotPrefix);
        addCandidate(withoutLeadingSlash);

        const staticAssetsMatch = withoutLeadingSlash.match(/^static\/assets\/[^/]+\/(.+)$/i);
        if (staticAssetsMatch?.[1]) {
            addCandidate(staticAssetsMatch[1]);
        }

        const assetsMatch = withoutLeadingSlash.match(/^assets\/[^/]+\/(.+)$/i);
        if (assetsMatch?.[1]) {
            addCandidate(assetsMatch[1]);
        }

        const fileName = withoutLeadingSlash.split('/').filter(Boolean).pop();
        addCandidate(fileName);

        if (fileName) {
            addCandidate(fileName.replace(/\.[^.]+$/, ''));
        }

        addCandidate(withoutLeadingSlash.replace(/\.[^.]+$/, ''));

        return candidates;
    }

    private markSceneTextureUnavailable(rawPath: string): void {
        for (const candidate of this.buildTextureLookupCandidates(rawPath)) {
            this.unavailableSceneTexturePaths.add(candidate);
        }
    }

    private isLikelyTexturePath(key: string): boolean {
        const normalized = key.trim().toLowerCase();
        if (!normalized) return false;

        if (/^https?:\/\//.test(normalized) || normalized.startsWith('file://')) {
            return /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/.test(normalized);
        }

        // A key is a loadable texture path if it carries a known image
        // extension — regardless of whether it contains a `/`. The previous
        // `/`-requirement blocked on-demand loading of bare top-level refs
        // (e.g. `2.png`), which forced a fall-back onto a bare-basename cache
        // probe that can return the WRONG bucket's texture when core and an
        // active skin share a basename. Extensionless keys (legacy
        // @game-studio short aliases like `spinButton`) still return false and
        // stay cache-only, so this does NOT introduce 404 spam for aliases.
        return /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/.test(normalized);
    }

    /**
     * Partition texture-lookup candidates into SPECIFIC (full bucket-relative
     * paths, plus bare top-level refs that carry a known image extension and
     * can therefore resolve via the skin-first `/assets/<ref>` middleware) and
     * BARE (basename / extensionless stems derived from a longer ref, which
     * collide across buckets). Specific candidates are probed first AND may be
     * loaded on-demand; bare candidates are a cache-only LAST resort, so a
     * same-basename file in another bucket can never shadow a sprite whose
     * full-path ref is resolvable.
     */
    private partitionTextureCandidates(
        candidates: string[],
        fullRefForms: Set<string>,
    ): { specific: string[]; bare: string[] } {
        const specific: string[] = [];
        const bare: string[] = [];

        for (const key of candidates) {
            // A candidate is "specific" when it still carries directory
            // structure (`/`) OR exactly equals a full ref-as-given form
            // (covers top-level refs like `2.png` whose full path has no `/`).
            // Everything else is a collision-prone basename / extensionless
            // stem and is deferred to the cache-only fallback pass.
            if (key.includes('/') || fullRefForms.has(key)) {
                specific.push(key);
            } else {
                bare.push(key);
            }
        }

        return { specific, bare };
    }

    private resolveSpriteDescriptorTexturePath(rawPath: string, scope: SceneOrigin): string | null {
        const resolvedDescriptorPath = this.resolveSceneAssetPath(rawPath, ['pixi:spriteDescriptor']);
        // Look up the descriptor cache under SCOPE-QUALIFIED candidates so a
        // core and an active-skin descriptor sharing a basename resolve to
        // their own backing texture.
        const candidates = Array.from(new Set<string>([
            ...this.buildSceneAssetPathCandidates(rawPath),
            ...this.buildSceneAssetPathCandidates(resolvedDescriptorPath),
        ])).map(candidate => this.scopeQualifyRef(candidate, scope));

        for (const candidate of candidates) {
            const cached = this.spriteDescriptorTextureCache.get(candidate);
            if (!cached) continue;

            if (cached.texturePath) {
                return cached.texturePath;
            }

            if (!cached.warned) {
                cached.warned = true;
                console.warn(`[SceneManager] Sprite descriptor has no usable texture; using missing texture fallback: ${rawPath}`);
            }
            return null;
        }

        console.warn(`[SceneManager] Sprite descriptor was not preloaded; using missing texture fallback: ${rawPath}`);
        return null;
    }

    private resolveStaticNodeTextureFromPath(rawPath: string): PixiTexture {
        if (this.isSpriteDescriptorPath(rawPath)) {
            const texturePath = this.resolveSpriteDescriptorTexturePath(rawPath, this.activeBuildOrigin);
            if (!texturePath) {
                return Pixi.Texture.WHITE;
            }

            const texture = this.resolveTextureFromPath(texturePath, ['pixi:texture']);
            if (texture === Pixi.Texture.WHITE) {
                console.warn(`[SceneManager] Sprite descriptor backing texture could not be resolved; using missing texture fallback: ${rawPath} -> ${texturePath}`);
            }
            return texture;
        }

        return this.resolveTextureFromPath(rawPath, ['pixi:texture']);
    }

    /**
     * On-demand (non-preloaded) texture load for Pixi 8.
     *
     * `Texture.from(url)` USED to kick off a fetch; in Pixi 8 it is a plain
     * synchronous cache read (`textureFrom` → `Cache.get(id)`) that returns
     * `undefined` on a miss and never downloads anything. `resolveTextureFromPath`
     * must stay synchronous, so this returns a placeholder backed by the shared
     * 1x1 `Texture.WHITE` source — the exact pixels the miss path already falls
     * back to — and swaps in the real source when `Assets.load` lands. Every
     * sprite already holding the placeholder picks the real image up for free.
     *
     * `alias` is the cache key to publish, and is non-null ONLY for a
     * scope-qualified key; an unscoped legacy candidate is keyed on its URL
     * alone so a bare basename can never become a globally shadowing alias
     * (AGENTS.md rule 15a).
     */
    private loadTextureOnDemand(key: string, alias: string | null): PixiTexture {
        const url = this.toAbsoluteSceneAssetUrl(key);
        const placeholder = new Pixi.Texture({ source: Pixi.Texture.WHITE.source, dynamic: true, label: key });

        const pending = alias
            ? Pixi.Assets.load<PixiTexture>({ alias, src: url })
            : Pixi.Assets.load<PixiTexture>(url);

        pending.then((loaded) => {
            if (alias) this.registeredAssetAliases.add(alias);
            this.registeredAssetAliases.add(url);

            if (placeholder.destroyed) return;
            if (!this.isTextureReady(loaded)) {
                this.markSceneTextureUnavailable(key);
                return;
            }

            // The source setter detaches the old source and emits `update` on
            // the texture; `update()` then re-derives the frame (the placeholder
            // is `noFrame`, and `orig` aliases `frame`). That `update` is what
            // re-fires the rule 18 width/height re-assertion parked by
            // `deferSpriteFamilySizeOverride`, now against the real extent.
            placeholder.source = loaded.source;
            placeholder.update();

            // A ready-looking 1x1 placeholder makes `deferRectLayoutForTexture`
            // skip, so drive the relayout the late extent needs from here.
            this.scheduleRectLayoutRefresh();
        }).catch((err) => {
            this.markSceneTextureUnavailable(key);
            console.warn(`[SceneManager] On-demand texture load failed; keeping missing texture fallback: ${key}`, err);
        });

        return placeholder;
    }

    private resolveTextureFromPath(rawPath: string, requiredTags?: string[]): PixiTexture {
        // Scope of the scene currently being built — bare refs resolve from
        // this bucket FIRST so cross-bucket same-basename refs never collide.
        const scope = this.activeBuildOrigin;
        const resolvedPath = this.resolveSceneAssetPath(rawPath, requiredTags);
        const candidates = this.buildTextureLookupCandidates(rawPath);
        const resolvedPathCandidates = this.buildTextureLookupCandidates(resolvedPath);
        const combinedCandidates = Array.from(new Set<string>([...resolvedPathCandidates, ...candidates]));
        const assetManager = AssetManager as unknown as {
            getTextureResourceData?: (name: string) => PixiTexture | undefined;
        };

        // The full ref-as-given forms (bucket-relative, slash-less for
        // top-level refs). These stay in the SPECIFIC pass so a bare top-level
        // ref like `2.png` is loaded via its `/assets/2.png` URL (skin-first
        // middleware) rather than colliding on a shared bare-basename cache key.
        const fullRefForms = new Set<string>([
            this.normalizeSceneAssetPath(rawPath),
            this.normalizeSceneAssetPath(resolvedPath),
        ].filter(Boolean));

        const { specific, bare } = this.partitionTextureCandidates(combinedCandidates, fullRefForms);

        const probeCache = (key: string): PixiTexture | undefined => {
            try {
                const textureFromAssets = assetManager.getTextureResourceData?.(key);
                if (textureFromAssets) {
                    return textureFromAssets;
                }
            } catch {
                // Keep trying fallback key formats.
            }

            // Pixi 8 collapses `PIXI.utils.TextureCache` and
            // `Loader.shared.resources` into ONE `Assets` cache keyed by the
            // registered alias. The preload registers the SCOPE-QUALIFIED ref
            // as that alias, so the same `key` still addresses the same slot.
            try {
                if (Pixi.Cache.has(key)) {
                    const cached = Pixi.Cache.get<PixiTexture>(key);
                    if (this.isTextureReady(cached)) {
                        return cached;
                    }
                }
            } catch {
                // Not a texture entry — keep trying fallback key formats.
            }

            return undefined;
        };

        // Pass S — SCOPE-QUALIFIED keys (MOST specific). For a node in a scene
        // of scope S, ref R is keyed `S/R` and fetched from `/assets/S/R`, so
        // a core `3.png` and an active-skin `3.png` are NEVER served from one
        // another's bucket. The preload step registered these exact scoped
        // keys, so the cache probe normally hits; the on-demand load is the
        // fallback for refs the preload didn't catch. Runs BEFORE the legacy
        // unscoped specific/bare passes, which remain for back-compat.
        const scopedKeys: string[] = [];
        const addScopedKey = (ref: string | undefined): void => {
            const normalized = this.normalizeSceneAssetPath(ref || '');
            if (!normalized) return;
            const scoped = this.scopeQualifyRef(normalized, scope);
            if (scoped && !scopedKeys.includes(scoped)) scopedKeys.push(scoped);
        };
        addScopedKey(rawPath);
        addScopedKey(resolvedPath);

        for (const key of scopedKeys) {
            const cached = probeCache(key);
            if (cached) {
                return cached;
            }

            if (this.unavailableSceneTexturePaths.has(key)) {
                continue;
            }

            if (!this.isLikelyTexturePath(key)) {
                continue;
            }

            try {
                // The scoped key already carries its bucket prefix
                // (`core/3.png`), so `toAbsoluteSceneAssetUrl(key)` yields
                // `/assets/core/3.png` directly — no scope arg needed. The key
                // is safe to publish as an `Assets` alias precisely BECAUSE it
                // is scope-qualified (rule 15a).
                return this.loadTextureOnDemand(key, key);
            } catch (err) {
                this.markSceneTextureUnavailable(key);
                console.warn(`[SceneManager] On-demand scope-qualified texture load threw; falling back: ${key}`, err);
            }
        }

        // Pass A — SPECIFIC candidates (full bucket-relative paths + bare
        // image-extension top-level refs). Probe the shared caches first, then
        // fall back to an on-demand load via the FULL `/assets/<ref>` URL,
        // which the skin-first dev middleware resolves to the correct bucket.
        // Doing this BEFORE the bare-basename fallback guarantees a resolvable
        // full-path ref always wins over a same-basename file in another bucket.
        for (const key of specific) {
            const cached = probeCache(key);
            if (cached) {
                return cached;
            }

            if (this.unavailableSceneTexturePaths.has(key)) {
                continue;
            }

            if (!this.isLikelyTexturePath(key)) {
                continue;
            }

            // Last-resort fallback: ask Pixi to load the texture on demand via
            // its URL resolver. This is the path that lets legitimate textures
            // not caught by the preload step still render. The IMG-load promise
            // suppression handler at the top of this file (and in main.ts)
            // mutes the cosmetic console noise from any genuine 404s.
            // Build the URL via `toAbsoluteSceneAssetUrl` so the `/assets`
            // publicPath is prepended (the candidate `key` is a bare
            // bucket-relative subpath like `1.png` / `assets/foo.png`, which
            // would otherwise resolve relative to the page root and 404 under
            // the bucket-root `/assets` mount).
            try {
                // Keyed on the URL ALONE — an unscoped candidate like `2.png`
                // must never become a global `Assets` alias, or it would shadow
                // a same-basename ref from another bucket (rule 15a).
                return this.loadTextureOnDemand(key, null);
            } catch (err) {
                this.markSceneTextureUnavailable(key);
                console.warn(`[SceneManager] On-demand texture load threw; falling back to white: ${key}`, err);
            }
        }

        // Pass B — BARE basename / extensionless fallback. Cache probe ONLY
        // (no on-demand load): these keys collide across buckets, and any real
        // file would already have resolved in Pass A via its full-path URL.
        // This pass preserves legitimate legacy @game-studio short-alias
        // lookups (e.g. `data-list.ts` aliases registered in the global caches).
        for (const key of bare) {
            const cached = probeCache(key);
            if (cached) {
                return cached;
            }
        }

        return Pixi.Texture.WHITE;
    }

    /**
     * Build a PIXI.Sprite backed by an HTMLVideoElement for `video` and
     * `videoSequencer` nodes. PIXI's VideoResource auto-updates the GPU
     * texture each frame while the element is playing, so no custom ticker
     * plumbing is required.
     */
    private buildVideoSprite(node: OrcaSceneNode, rawSrc: string, scope: SceneOrigin): Pixi.Sprite {
        const el = document.createElement('video');
        el.crossOrigin = 'anonymous';
        el.playsInline = true;
        el.preload = 'auto';
        el.muted = node.muted !== false;
        el.setAttribute('muted', el.muted ? 'true' : 'false');
        el.loop = !!node.loop;
        el.playbackRate = Number.isFinite(node.playbackRate as number) && (node.playbackRate as number) > 0
            ? (node.playbackRate as number)
            : 1;

        const sprite: Pixi.Sprite = new Pixi.Sprite(Pixi.Texture.WHITE);
        (sprite as any).__videoEl = el;

        this.applyVideoSrcToElement(sprite, el, rawSrc, node, scope);

        if (node.tint !== undefined) sprite.tint = node.tint;
        if (node.blendMode) sprite.blendMode = this.resolveBlendMode(node.blendMode);
        if (node.width  && node.width  > 0) sprite.width  = node.width;
        if (node.height && node.height > 0) sprite.height = node.height;

        return sprite;
    }

    private applyVideoSrcToElement(
        sprite: Pixi.Sprite,
        el: HTMLVideoElement,
        rawSrc: string,
        node: OrcaSceneNode,
        scope: SceneOrigin,
    ): void {
        const resolved = this.resolveVideoUrl(rawSrc, scope);
        if (!resolved) {
            sprite.texture = Pixi.Texture.WHITE;
            el.removeAttribute('src');
            try { el.load(); } catch { /* ignore */ }
            return;
        }

        if (el.src !== resolved) {
            el.src = resolved;
            try { el.load(); } catch { /* ignore */ }
        }

        try {
            // DYNAMIC, so the sprite hears when the video's size arrives (its
            // metadata loads after this): Pixi 8 refreshes a sprite's cached
            // bounds on texture updates only for dynamic textures, and a
            // sprite left with the empty size it had before the video loaded
            // draws nothing under a mask or a filter (a sprite mask renders
            // within the masked object's bounds).
            const base = Pixi.Texture.from(el);
            const current = sprite.texture;
            sprite.texture = current && current.dynamic && current.source === base.source
                ? current
                : new Pixi.Texture({ source: base.source, dynamic: true, label: base.label });
        } catch (e) {
            console.warn('[SceneManager] Failed to bind video texture:', e);
            sprite.texture = Pixi.Texture.WHITE;
        }

        if (node.autoplay !== false) {
            const tryPlay = () => { el.play().catch(() => { /* autoplay blocked */ }); };
            if (el.readyState >= 2) {
                tryPlay();
            } else {
                el.addEventListener('loadeddata', tryPlay, { once: true });
            }
        }
    }

    private resolveVideoUrl(rawSrc: string, scope: SceneOrigin): string {
        const raw = typeof rawSrc === 'string' ? rawSrc.trim() : '';
        if (!raw) return '';
        if (/^(https?:|file:|data:|blob:)/i.test(raw)) return raw;

        // Try to find the asset via the same scene-asset registry used for
        // textures (handles aliases, base paths, etc.).
        const resolved = this.resolveSceneAssetPath(raw);
        if (resolved && resolved !== raw && /^(https?:|file:|data:|blob:|\/)/i.test(resolved)) {
            return resolved;
        }

        // Fall back to a server-relative URL: editor writes generated videos
        // under `<gameRoot>/assets/generated/videos/...` and webpack-dev-server
        // serves that folder at `/assets/`. SCOPE-qualify so a core and an
        // active-skin clip sharing a basename resolve from their own bucket.
        const normalized = (resolved || raw).replace(/\\/g, '/');
        if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) {
            // Windows/`/`-prefixed legacy path — keep only the file name and
            // route it through the same publicPath resolver textures use so
            // it lands under `/assets/` rather than being returned bare.
            const fileName = normalized.split('/').pop() ?? '';
            return fileName ? this.toAbsoluteSceneAssetUrl(`assets/generated/videos/${fileName}`, scope) : '';
        }

        // Normal case: a bucket-relative ref (e.g. `scenes/clip.mp4`). Route it
        // through the same publicPath resolver textures use so the URL becomes
        // `/assets/<scope>/<ref>` (matching sprites) instead of a bare
        // page-root string.
        return this.toAbsoluteSceneAssetUrl(normalized, scope);
    }

    private resolveTextureFromAtlasFrame(atlasPath: string, frameName: string): PixiTexture {
        const normalizedFrameName = typeof frameName === 'string' ? frameName.trim() : '';
        if (!normalizedFrameName) {
            return Pixi.Texture.WHITE;
        }

        const resolvedAtlasPath = this.resolveSceneAssetPath(atlasPath, ['pixi:spritesheet', 'pixi:reelsSymbolStaticsAtlas']);
        const candidates = Array.from(new Set<string>([
            ...this.buildTextureLookupCandidates(resolvedAtlasPath),
            ...this.buildTextureLookupCandidates(atlasPath),
        ]));

        // Pixi 8: a parsed spritesheet lives in the `Assets` cache under its
        // own alias, and its frames are additionally cached by frame name.
        for (const key of candidates) {
            try {
                if (!Pixi.Cache.has(key)) continue;
                const sheet = Pixi.Cache.get<{ textures?: Record<string, PixiTexture> }>(key);
                const textureFromSheet = sheet?.textures?.[normalizedFrameName];
                if (this.isTextureReady(textureFromSheet)) {
                    return textureFromSheet as PixiTexture;
                }
            } catch {
                // Not a spritesheet entry — keep trying fallback key formats.
            }
        }

        try {
            if (Pixi.Cache.has(normalizedFrameName)) {
                const cachedTexture = Pixi.Cache.get<PixiTexture>(normalizedFrameName);
                if (this.isTextureReady(cachedTexture)) {
                    return cachedTexture;
                }
            }
        } catch {
            // Not a texture entry — fall through to the missing-texture fallback.
        }

        return Pixi.Texture.WHITE;
    }

    /**
     * Resolve a single packed-atlas frame for a frame-qualified `sprite` node.
     * Reads the SCOPE-QUALIFIED frame-texture cache populated by
     * `preloadSceneSpritesheetFrames`; returns `PIXI.Texture.WHITE` on any miss
     * (descriptor not preloaded, frame absent) — matching the existing
     * sprite-descriptor / reels-atlas miss behavior. This is the multi-page
     * companion to `resolveTextureFromAtlasFrame` (which looks up a single-page
     * PIXI-loader spritesheet); both are scope-qualified so cross-bucket
     * same-named frames never collide.
     */
    private resolveSpritesheetFrameTexture(spritesheetPath: string, frameName: string, scope: SceneOrigin): PixiTexture {
        const normalizedPath = this.normalizeSceneAssetPath(spritesheetPath);
        const normalizedFrame = typeof frameName === 'string' ? frameName.trim() : '';
        if (!normalizedPath || !normalizedFrame) {
            return Pixi.Texture.WHITE;
        }

        const scopedKey = this.scopeQualifyRef(normalizedPath, scope);
        const frameMap = this.spritesheetFrameTextureCache.get(scopedKey);
        const texture = frameMap?.get(normalizedFrame);
        if (this.isTextureReady(texture)) {
            return texture as PixiTexture;
        }

        if (!frameMap) {
            console.warn(`[SceneManager] Spritesheet was not preloaded; using missing texture fallback: ${spritesheetPath} (frame "${frameName}")`);
        } else {
            console.warn(`[SceneManager] Spritesheet frame "${frameName}" unresolved; using missing texture fallback: ${spritesheetPath}`);
        }
        return Pixi.Texture.WHITE;
    }

    private buildSpineLookupCandidates(node: OrcaSceneNode): string[] {
        const candidates: string[] = [];
        const inferredAtlasPath = this.inferSpineAtlasPath(node.skeleton ?? '', node.atlas ?? '');
        const resolvedSkeletonPath = node.skeleton
            ? this.resolveSceneAssetPath(node.skeleton, ['pixi:spineSkeleton'])
            : '';
        const resolvedAtlasPath = inferredAtlasPath
            ? this.resolveSceneAssetPath(inferredAtlasPath, ['pixi:spineAtlas'])
            : '';

        const addCandidate = (value: string | undefined): void => {
            if (!value) return;

            const normalized = value.trim();
            if (!normalized) return;
            if (!candidates.includes(normalized)) {
                candidates.push(normalized);
            }
        };

        const addPathCandidates = (rawPath: string | undefined): void => {
            if (!rawPath) return;

            const normalizedPath = rawPath.trim().replace(/\\/g, '/');
            if (!normalizedPath) return;

            const withoutQuery = normalizedPath.split('?')[0].split('#')[0];
            const withoutDotPrefix = withoutQuery.replace(/^\.\//, '');
            const withoutLeadingSlash = withoutDotPrefix.replace(/^\/+/, '');

            addCandidate(normalizedPath);
            addCandidate(withoutQuery);
            addCandidate(withoutDotPrefix);
            addCandidate(withoutLeadingSlash);

            const staticAssetsMatch = withoutLeadingSlash.match(/^static\/assets\/[^/]+\/(.+)$/i);
            if (staticAssetsMatch?.[1]) {
                addCandidate(staticAssetsMatch[1]);
            }

            const assetsMatch = withoutLeadingSlash.match(/^assets\/[^/]+\/(.+)$/i);
            if (assetsMatch?.[1]) {
                addCandidate(assetsMatch[1]);
            }
        };

        const skeletonAliases = this.getSceneAssetAliasesForPath(node.skeleton ?? '', ['pixi:spineSkeleton']);
        for (const alias of skeletonAliases) {
            addCandidate(alias);
        }

        const atlasAliases = this.getSceneAssetAliasesForPath(node.atlas ?? '', ['pixi:spineAtlas']);
        for (const alias of atlasAliases) {
            addCandidate(alias);
        }

        addPathCandidates(node.skeleton);
        addPathCandidates(node.atlas);
        addPathCandidates(inferredAtlasPath);
        addPathCandidates(resolvedSkeletonPath);
        addPathCandidates(resolvedAtlasPath);

        // Prepend SCOPE-QUALIFIED variants (using the scene currently being
        // built) so a preloaded scoped spine key (`core/<skeleton>` /
        // `skins/<skin>/<skeleton>`) resolves FIRST and a same-basename
        // skeleton/alias in another bucket can't shadow it. The unscoped
        // candidates remain afterwards as a back-compat fallback for legacy
        // @game-studio aliases registered in the global caches.
        const scope = this.activeBuildOrigin;
        const scoped = candidates
            .map(candidate => this.scopeQualifyRef(this.normalizeSceneAssetPath(candidate), scope))
            .filter(Boolean);
        const result: string[] = [];
        for (const candidate of [...scoped, ...candidates]) {
            if (candidate && !result.includes(candidate)) {
                result.push(candidate);
            }
        }
        return result;
    }

    private inferSpineAtlasPath(skeletonPath: string, atlasPath: string): string {
        const normalizedAtlasPath = (atlasPath || '').trim();
        if (normalizedAtlasPath) {
            return normalizedAtlasPath;
        }

        const normalizedSkeletonPath = (skeletonPath || '').trim();
        if (!normalizedSkeletonPath) {
            return '';
        }

        const lastDot = normalizedSkeletonPath.lastIndexOf('.');
        if (lastDot <= 0) {
            return `${normalizedSkeletonPath}.atlas`;
        }

        return `${normalizedSkeletonPath.slice(0, lastDot)}.atlas`;
    }

    private buildSpineLoadSpec(skeletonPath: string, explicitAtlasPath?: string): SpineLoadSpec | null {
        if (typeof skeletonPath !== 'string' || !skeletonPath.trim()) {
            return null;
        }

        const resolvedSkeleton = this.resolveSceneAssetPath(skeletonPath, ['pixi:spineSkeleton']);
        const inferredAtlasPath = this.inferSpineAtlasPath(skeletonPath, explicitAtlasPath ?? '');
        const resolvedAtlas = inferredAtlasPath
            ? this.resolveSceneAssetPath(inferredAtlasPath, ['pixi:spineAtlas'])
            : undefined;

        const aliases = this.getSceneAssetAliasesForPath(skeletonPath, ['pixi:spineSkeleton']);
        const key = aliases[0] || resolvedSkeleton;

        return {
            key,
            skeletonPath: resolvedSkeleton,
            atlasPath: resolvedAtlas,
        };
    }

    private collectSceneSpineLoadSpecs(scene: OrcaSceneData): SpineLoadSpec[] {
        const specs: SpineLoadSpec[] = [];

        const walk = (nodes: OrcaSceneNode[]): void => {
            for (const sourceNode of nodes) {
                // `skeleton` / `atlas` are locale-substitutable, so the spec
                // must be built from the LOCALIZED node or the preload would
                // register the base skeleton under the key the build probes.
                const node = this.localizeNode(sourceNode);
                if (node.type === 'spine') {
                    const spec = this.buildSpineLoadSpec(node.skeleton ?? '', node.atlas ?? '');
                    if (spec) {
                        specs.push(spec);
                    }
                } else if (node.type === 'reels') {
                    // Reels spine symbol-mode references skeletons via the
                    // node-level `sharedSpineAnimation` (and legacy per-symbol
                    // `spineAnimation`). Neither carries a separate atlas field —
                    // the atlas is always the same-basename `<skeleton>.atlas`
                    // (inferSpineAtlasPath), matching the editor's resolveAtlasPath
                    // and the electron asset-mirror inference. Queue each distinct
                    // skeleton so preloadSceneSpineAssets registers it under the
                    // scope-qualified key the runtime reels resolver consumes —
                    // without this branch a spine-mode reels never preloads and
                    // renders blank at runtime.
                    const reelSkeletons = new Set<string>();
                    if (typeof node.sharedSpineAnimation === 'string' && node.sharedSpineAnimation.trim()) {
                        reelSkeletons.add(node.sharedSpineAnimation.trim());
                    }
                    if (Array.isArray(node.symbolEntries)) {
                        for (const entry of node.symbolEntries) {
                            if (entry && typeof entry.spineAnimation === 'string' && entry.spineAnimation.trim()) {
                                reelSkeletons.add(entry.spineAnimation.trim());
                            }
                        }
                    }
                    for (const skeletonPath of reelSkeletons) {
                        const spec = this.buildSpineLoadSpec(skeletonPath);
                        if (spec) {
                            specs.push(spec);
                        }
                    }
                }

                if (node.children.length > 0) {
                    walk(node.children);
                }
            }
        };

        walk(scene.nodes);
        return specs;
    }
    private applyTransform(obj: PixiDisplayObject, t: OrcaTransform, node?: OrcaSceneNode): void {
        obj.position.set(t.x, t.y);
        obj.scale.set(t.scaleX, t.scaleY);
        obj.rotation = t.rotation * DEG_TO_RAD;

        // Anchor (sprites/text) takes priority; otherwise use pivot on containers
        const anchorTarget = (obj as any).anchor as { set?: (x: number, y: number) => void } | undefined;
        if (anchorTarget && typeof anchorTarget.set === 'function') {
            anchorTarget.set(
                Math.min(1, Math.max(0, t.pivotX)),
                Math.min(1, Math.max(0, t.pivotY)),
            );
            if ('pivot' in obj) (obj as PixiContainer).pivot.set(0, 0);
        } else if ('pivot' in obj) {
            (obj as PixiContainer).pivot.set(t.pivotX, t.pivotY);
        }

        if ((obj as any).skew) {
            (obj as any).skew.set(t.skewX, t.skewY);
        }

        // COMMON TAIL for the authored width/height override. `obj.scale.set`
        // above is ABSOLUTE and would otherwise wipe the size-derived scale a
        // sprite-family node needs, so every caller that re-applies a transform
        // (fresh build, DDOL rebind, LayoutManager override) re-asserts the
        // size here. `applyResponsiveScalerToNode` assigns scale outside this
        // method and carries its own call.
        if (node) {
            this.applySpriteFamilySizeOverride(obj, node, t.scaleX, t.scaleY);
        }
    }

    /**
     * Runtime half of the sprite-family width/height contract (AGENTS.md rule 18;
     * mirrors `Pixi8Adapter.applySpriteFamilySizeOverride` semantics exactly).
     *
     * Precedence: an explicit `width`/`height` (`> 0`) is the BASE display size
     * and the node's scale MULTIPLIES on top (`width:200` + `scaleX:2` → 400px).
     * `0` / absent / non-finite = native size scaled by the transform only —
     * such a node is left BYTE-FOR-BYTE as the caller's `scale.set` left it.
     *
     * PER-TYPE, matching the editor's fork:
     *  - `NineSliceSprite` / `TilingSprite`: `.width`/`.height` are REAL geometry
     *    dimensions independent of scale, so the size is assigned directly and
     *    the already-applied scale composes multiplicatively for free.
     *  - `Sprite` / `AnimatedSprite`: Pixi implements `.width`/`.height` as
     *    setters over `scale`, so no independent size exists — the scale is
     *    derived as `(override / texture.orig.dim) × effectiveScale`.
     *
     * `effectiveScaleX/Y` is the scale the CALLER just assigned (transform,
     * merged layout override, or responsive-scaler result), never read back off
     * the object — reading back would compound on a second call.
     */
    private applySpriteFamilySizeOverride(
        obj: PixiDisplayObject,
        node: OrcaSceneNode,
        effectiveScaleX: number,
        effectiveScaleY: number,
    ): void {
        if (!obj || (obj as { destroyed?: boolean }).destroyed) return;
        if (!SPRITE_FAMILY_SIZE_TYPES.has(node.type)) return;

        const overrideW = this.readSizeOverride(node.width);
        const overrideH = this.readSizeOverride(node.height);
        if (overrideW <= 0 && overrideH <= 0) return;

        // Geometry-sized types: size is not a scale proxy — assign it directly.
        if (obj instanceof Pixi.NineSliceSprite || obj instanceof Pixi.TilingSprite) {
            if (overrideW > 0) obj.width = overrideW;
            if (overrideH > 0) obj.height = overrideH;
            return;
        }

        // The remaining three types in the set all build a `Sprite`
        // (`animatedSprite` via `AnimatedSprite`, which extends it).
        if (!(obj instanceof Pixi.Sprite)) return;

        const scaleX = Number.isFinite(effectiveScaleX) ? effectiveScaleX : 1;
        const scaleY = Number.isFinite(effectiveScaleY) ? effectiveScaleY : 1;
        // Remembered for the deferred re-assert below, which fires long after
        // the caller's scale is out of scope.
        (obj as { __orcaSizeScale?: { x: number; y: number } }).__orcaSizeScale = { x: scaleX, y: scaleY };

        if (!this.writeSpriteFamilySizeScale(obj, overrideW, overrideH, scaleX, scaleY)) {
            // The texture has no real extent yet (an un-preloaded plain `.png`
            // arrives as a lazy 0x0 `Texture.from(url)`), so the division above
            // was skipped. Re-assert once it reports a size.
            this.deferSpriteFamilySizeOverride(obj, node);
        }
    }

    /** `> 0` finite authored dimension, else `0` meaning "use native size". */
    private readSizeOverride(value: number | undefined): number {
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }

    /**
     * Write the size-derived scale onto a Sprite/AnimatedSprite. Returns true
     * only when every REQUESTED axis landed, so the caller knows whether a
     * deferred retry is still needed.
     *
     * `> 1` (not `> 0`) on the native dimension is deliberate and copied from
     * the editor: it rejects both an unloaded 0x0 texture and the 1x1
     * `Texture.WHITE` placeholder, either of which would bake a garbage scale.
     * Every quotient is re-checked for finiteness before it is written.
     */
    private writeSpriteFamilySizeScale(
        sprite: Pixi.Sprite,
        overrideW: number,
        overrideH: number,
        scaleX: number,
        scaleY: number,
    ): boolean {
        const texture = sprite.texture;
        const nativeW = Number(texture?.orig?.width ?? 0);
        const nativeH = Number(texture?.orig?.height ?? 0);

        let complete = true;

        if (overrideW > 0) {
            const next = Number.isFinite(nativeW) && nativeW > 1 ? (overrideW / nativeW) * scaleX : NaN;
            if (Number.isFinite(next)) sprite.scale.x = next;
            else complete = false;
        }
        if (overrideH > 0) {
            const next = Number.isFinite(nativeH) && nativeH > 1 ? (overrideH / nativeH) * scaleY : NaN;
            if (Number.isFinite(next)) sprite.scale.y = next;
            else complete = false;
        }

        return complete;
    }

    /**
     * Re-apply the size override once a lazily-loaded texture reports a real
     * extent — the same `texture.on('update')` pattern `attachScratchBehaviour`
     * uses for the identical reason (only `.sprite.json` descriptors and packed
     * atlas frames are preloaded; a plain `<name>.png` node ref is not).
     *
     * Idempotent per bound texture, self-detaching, and inert once the sprite is
     * destroyed or the texture has been swapped out from under it.
     */
    private deferSpriteFamilySizeOverride(sprite: Pixi.Sprite, node: OrcaSceneNode): void {
        const texture = sprite.texture;
        if (!texture || texture === Pixi.Texture.EMPTY || typeof texture.on !== 'function') return;

        const tagged = sprite as { __orcaSizeDeferredTexture?: unknown; __orcaSizeScale?: { x: number; y: number } };
        if (tagged.__orcaSizeDeferredTexture === texture) return;
        tagged.__orcaSizeDeferredTexture = texture;

        const detach = (): void => {
            try { texture.off('update', onUpdate); } catch { /* no-op */ }
            if (tagged.__orcaSizeDeferredTexture === texture) tagged.__orcaSizeDeferredTexture = undefined;
        };

        const onUpdate = (): void => {
            if ((sprite as { destroyed?: boolean }).destroyed || sprite.texture !== texture) {
                detach();
                return;
            }
            const remembered = tagged.__orcaSizeScale ?? { x: 1, y: 1 };
            const done = this.writeSpriteFamilySizeScale(
                sprite,
                this.readSizeOverride(node.width),
                this.readSizeOverride(node.height),
                remembered.x,
                remembered.y,
            );
            if (done) detach();
        };

        texture.on('update', onUpdate);
    }

    private normalizeFilterTypeKey(type: string): string {
        return type
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
    }

    private isFilterCtor(candidate: unknown): candidate is FilterCtor {
        return typeof candidate === 'function';
    }

    private ensureFilterRegistry(): void {
        if (this.filterRegistryInitialized) {
            return;
        }

        this.filterRegistryInitialized = true;

        for (const [type, ctor] of Object.entries(FILTER_CTORS)) {
            // A constructor can still be missing at RUNTIME if the installed
            // pixi-filters/pixi.js minor drops an export the types still
            // declare — skip rather than registering `undefined`.
            if (!this.isFilterCtor(ctor)) {
                console.warn(`[SceneManager] Filter "${type}" is declared but absent from the installed Pixi modules; it will not be available.`);
                continue;
            }

            this.filterCtorByType.set(type, ctor);
            this.normalizedFilterTypeMap.set(this.normalizeFilterTypeKey(type), type);
        }
    }

    private resolveFilterType(type: string): string | null {
        this.ensureFilterRegistry();

        const direct = type.trim();
        if (this.filterCtorByType.has(direct)) {
            return direct;
        }

        const normalized = this.normalizeFilterTypeKey(direct);
        if (!normalized) return null;

        return this.normalizedFilterTypeMap.get(normalized) ?? null;
    }

    private createFilterInstance(filterType: string): PixiFilter | null {
        const resolvedType = this.resolveFilterType(filterType);
        if (!resolvedType) {
            console.warn(
                `[SceneManager] Filter "${filterType}" is not available in this runtime. `
                + `Pixi 8 / pixi-filters 6 dropped FXAAFilter, TiltShiftXFilter and TiltShiftYFilter, `
                + `which the editor's picker still offers. Known filters: ${Object.keys(FILTER_CTORS).join(', ')}.`,
            );
            return null;
        }

        const ctor = this.filterCtorByType.get(resolvedType);
        if (!ctor) return null;

        try {
            return new ctor();
        } catch (e) {
            try {
                return new ctor({});
            } catch {
                // e.g. DisplacementFilter, which REQUIRES a `{ sprite }` the
                // editor's settings model cannot supply.
                console.warn(`[SceneManager] Filter "${resolvedType}" could not be constructed without arguments:`, e);
                return null;
            }
        }
    }

    /**
     * True when `key` resolves to a real accessor or own data property on the
     * filter. Pixi 8 filters expose typed setters (`blur`, `gamma`, `angle`…)
     * that write into the underlying WebGPU-style uniform group; a plain
     * assignment for an unknown key would just create a dead own-property, so
     * the write has to be probed first.
     */
    private hasWritableFilterProperty(filter: PixiFilter, key: string): boolean {
        let cursor: object | null = filter as unknown as object;
        while (cursor) {
            const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
            if (descriptor) return !!descriptor.set || descriptor.writable === true;
            cursor = Object.getPrototypeOf(cursor);
        }
        return false;
    }

    /**
     * Pixi 8's base `Filter` has no `uniforms` bag (the v6 shape). Concrete
     * pixi-filters classes DO expose one, but keyed in shader convention
     * (`uGamma`, not `gamma`) — so an editor setting name has to be mapped.
     */
    private resolveFilterUniformKey(uniforms: Record<string, unknown>, key: string): string | null {
        if (key in uniforms) return key;
        const shaderKey = `u${key.charAt(0).toUpperCase()}${key.slice(1)}`;
        return shaderKey in uniforms ? shaderKey : null;
    }

    private applyFilterSettings(filter: PixiFilter, settings: OrcaFilterComponent['settings']): void {
        const filterTarget = filter as unknown as Record<string, unknown>;
        const uniforms = (filter as unknown as { uniforms?: Record<string, unknown> }).uniforms;

        for (const [key, value] of Object.entries(settings)) {
            const normalizedValue = Array.isArray(value) ? [...value] : value;

            if (this.hasWritableFilterProperty(filter, key)) {
                try {
                    filterTarget[key] = normalizedValue;
                    continue;
                } catch {
                    // Accessor rejected the value — try the uniform below.
                }
            }

            const uniformKey = uniforms ? this.resolveFilterUniformKey(uniforms, key) : null;
            if (uniforms && uniformKey) {
                try {
                    uniforms[uniformKey] = normalizedValue;
                    continue;
                } catch {
                    // Fall through to the diagnostic.
                }
            }

            console.warn(`[SceneManager] Filter setting "${key}" is not supported by "${filter.constructor.name}" on Pixi 8; ignoring it.`);
        }
    }

    private applyFilters(displayObject: PixiDisplayObject, filters?: OrcaFilterComponent[]): void {
        if (!filters || filters.length === 0) {
            return;
        }

        const runtimeFilters: PixiFilter[] = [];
        const byIndex = new Map<number, PixiFilter>();

        filters.forEach((filterComponent, index) => {
            const filter = this.createFilterInstance(filterComponent.type);
            if (!filter) {
                console.warn(`[SceneManager] Unsupported filter type "${filterComponent.type}" on "${displayObject.name || 'unnamed'}"`);
                return;
            }

            this.applyFilterSettings(filter, filterComponent.settings ?? {});
            // A disabled filter is still BUILT (Pixi 8 passes it through) so an
            // animated `enabled` channel can switch it on, and so a filter
            // channel's AUTHORED index addresses the right instance.
            if (!filterComponent.enabled) filter.enabled = false;
            runtimeFilters.push(filter);
            byIndex.set(index, filter);
        });

        (displayObject as { __orcaFiltersByIndex?: Map<number, PixiFilter> }).__orcaFiltersByIndex = byIndex;
        if (runtimeFilters.length > 0) {
            // `filters` READS as `readonly Filter[]` in Pixi 8 — it can only be
            // replaced wholesale, never pushed into.
            displayObject.filters = runtimeFilters;
        }
    }

    private buildTextStyle(node: OrcaSceneNode): PixiTextStyle {
        const style: PixiTextStyle = {};
        if (node.fontFamily      !== undefined) style.fontFamily      = this.getSceneFontFamily(node.fontFamily);
        if (node.fontSize        !== undefined) style.fontSize        = node.fontSize;
        // Fill — gradient (>= 2 stops) overrides fill/fillAlpha; else
        // fillAlpha < 1 emits a `{ color, alpha }` FillStyle; else the plain
        // number (legacy).
        const grad = node.fillGradient;
        if (grad && Array.isArray(grad.stops) && grad.stops.length >= 2) {
            const sorted = [...grad.stops].sort((a, b) => a.offset - b.offset);
            const horizontal = grad.direction === 'horizontal';
            // Pixi 8 replaced the v6 `fill: string[]` + `fillGradientType` +
            // `fillGradientStops` triple with a FillGradient object; the two
            // extra keys no longer exist and the string array is not a
            // FillInput, so the v6 shape produced NO gradient at all.
            style.fill = new Pixi.FillGradient({
                type: 'linear',
                start: { x: 0, y: 0 },
                end: horizontal ? { x: 1, y: 0 } : { x: 0, y: 1 },
                colorStops: sorted.map((s) => ({
                    offset: this.clamp01(s.offset),
                    color: this.colorToRgba(s.color, s.alpha ?? 1),
                })),
            });
        } else if (node.fill !== undefined) {
            style.fill = (typeof node.fillAlpha === 'number' && node.fillAlpha < 1)
                ? { color: node.fill, alpha: node.fillAlpha }
                : node.fill;
        }
        if (node.fontWeight      !== undefined) style.fontWeight      = String(node.fontWeight) as PixiTextStyleFontWeight;
        if (node.fontStyle       !== undefined) style.fontStyle       = node.fontStyle as PixiTextStyleFontStyle;
        if (node.align           !== undefined) style.align           = node.align as PixiTextStyleAlign;
        if (node.wordWrap        !== undefined) style.wordWrap        = node.wordWrap;
        if (node.wordWrapWidth   !== undefined) style.wordWrapWidth   = node.wordWrapWidth;
        // Spacing — letterSpacing / lineHeight / leading map straight through
        // (matches the editor's legacy createText + the rich-text default style).
        if (typeof node.letterSpacing === 'number') style.letterSpacing = node.letterSpacing;
        if (typeof node.lineHeight    === 'number') style.lineHeight    = node.lineHeight;
        if (typeof node.leading       === 'number') style.leading       = node.leading;
        // Stroke — solid only. Pixi 8 folded the v6 top-level `strokeThickness`
        // into the stroke object as `width`; a zero/absent thickness drew
        // nothing in v6, whereas a bare `{ color }` would default to width 1
        // here, so the whole object is gated on a positive thickness.
        if (typeof node.strokeThickness === 'number' && node.strokeThickness > 0) {
            style.stroke = {
                color: node.stroke ?? 0x000000,
                width: node.strokeThickness,
                ...(typeof node.strokeAlpha === 'number' && node.strokeAlpha < 1 ? { alpha: node.strokeAlpha } : {}),
            };
        }
        // Pixi 8 merged the five `dropShadow*` scalars into one object union.
        if (node.dropShadow === false) {
            style.dropShadow = false;
        } else if (node.dropShadowOptions) {
            const dso = node.dropShadowOptions;
            style.dropShadow = {
                color: dso.color,
                blur: dso.blur,
                // Authored angle is DEGREES; PIXI expects RADIANS — matches the
                // editor's Pixi8Adapter / richText degrees→radians conversion.
                angle: (dso.angle * Math.PI) / 180,
                distance: dso.distance,
                alpha: dso.alpha,
            };
        } else if (node.dropShadow === true) {
            style.dropShadow = true;
        }
        return style;
    }

    /** Convert a `0xRRGGBB` colour + alpha (0..1) into a CSS `rgba(...)` string. */
    private colorToRgba(color: number, alpha: number): string {
        const c = Math.max(0, Math.min(0xffffff, Math.round(color)));
        const r = (c >> 16) & 0xff;
        const g = (c >> 8) & 0xff;
        const b = c & 0xff;
        const a = Math.max(0, Math.min(1, alpha));
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }

    private clamp01(v: number): number {
        return Math.max(0, Math.min(1, v));
    }

    private isSceneFontPath(targetPath: string): boolean {
        return /\.(otf|ttf|woff2?)(\?|#|$)/i.test((targetPath || '').trim());
    }

    /** Whether canvas text can draw `family` now: a loaded face, or a bare family with nothing left to load. */
    private isSceneFontFamilyReady(rawFontPath: string, family: string): boolean {
        if (!family || typeof document === 'undefined' || !document.fonts) return true;
        if (!this.isSceneFontPath(rawFontPath)) {
            try {
                return document.fonts.check(`16px "${family.replace(/["']/g, '')}"`);
            } catch {
                return true;
            }
        }
        // `check` reports true for a family with no face at all, which is exactly
        // the state of a font file whose face has not been added yet.
        let loaded = false;
        document.fonts.forEach((face) => {
            if (face.status === 'loaded' && face.family.replace(/["']/g, '') === family) loaded = true;
        });
        return loaded;
    }

    private getSceneFontFamily(fontPath: string): string {
        if (!this.isSceneFontPath(fontPath)) {
            return fontPath;
        }

        const normalizedPath = this.normalizeSceneAssetPath(fontPath);
        const cached = this.sceneFontFamilyCache.get(normalizedPath);
        if (cached) {
            return cached;
        }

        const fileName = normalizedPath.split('/').pop() || normalizedPath;
        const stem = fileName.replace(/\.[^.]+$/, '') || 'font';
        let hash = 2166136261;
        for (let i = 0; i < normalizedPath.length; i += 1) {
            hash ^= normalizedPath.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }

        const familyName = `${stem.replace(/[^a-zA-Z0-9_-]+/g, '-')}-${(hash >>> 0).toString(36)}`;
        this.sceneFontFamilyCache.set(normalizedPath, familyName);
        return familyName;
    }

    private async ensureSceneFontLoaded(rawFontPath: string, scope: SceneOrigin = this.activeBuildOrigin): Promise<string> {
        const bareFamily = (rawFontPath ?? '').trim();
        if (bareFamily && !this.isSceneFontPath(rawFontPath) && typeof document !== 'undefined' && document.fonts) {
            // Bare family (e.g. a fonts-v2.css webfont): wait so callers re-measure with the real face.
            const key = `bare:${bareFamily}`;
            let pendingBare = this.sceneFontLoadPromises.get(key);
            if (!pendingBare) {
                pendingBare = (async () => {
                    try {
                        await Promise.race([
                            document.fonts.load(`16px "${bareFamily.replace(/["']/g, '')}"`),
                            new Promise<void>((resolve) => setTimeout(resolve, 5000)),
                        ]);
                    } catch {
                        // Best-effort: keep the family on failure.
                    }
                    return bareFamily;
                })();
                this.sceneFontLoadPromises.set(key, pendingBare);
            }
            return pendingBare;
        }
        if (!this.isSceneFontPath(rawFontPath) || typeof FontFace === 'undefined' || !document.fonts) {
            return rawFontPath;
        }

        const resolvedPath = this.resolveSceneAssetPath(rawFontPath, ['pixi:font']);
        const normalizedPath = this.normalizeSceneAssetPath(resolvedPath || rawFontPath);
        const familyName = this.getSceneFontFamily(rawFontPath);
        const pending = this.sceneFontLoadPromises.get(normalizedPath);
        if (pending) {
            return pending;
        }

        const loadPromise = (async () => {
            // A font ref is bucket-relative like any scene asset, so it is
            // fetched from the `/assets` mount: the owning scene's scoped URL,
            // then the flat one. The page-relative URL is the old form, which
            // only resolved when a stray copy sat outside the runtime mirror.
            const ref = resolvedPath || rawFontPath;
            const urls = Array.from(new Set([
                this.toAbsoluteSceneAssetUrl(ref, scope),
                this.toAbsoluteSceneAssetUrl(ref),
                encodeURI(ref),
            ]));
            let lastError: unknown = null;
            for (const url of urls) {
                try {
                    const loadedFont = await new FontFace(familyName, `url("${url}")`).load();
                    (document.fonts as any).add(loadedFont);
                    this.sceneFontFamilyCache.set(normalizedPath, familyName);
                    this.sceneFontUrls.set(normalizedPath, url);
                    return familyName;
                } catch (err) {
                    lastError = err;
                }
            }
            throw lastError;
        })();

        this.sceneFontLoadPromises.set(normalizedPath, loadPromise);

        try {
            return await loadPromise;
        } finally {
            this.sceneFontLoadPromises.delete(normalizedPath);
        }
    }

    /**
     * Font load for an `HTMLText` node. `HTMLText` rasterises through an SVG
     * `foreignObject`, an isolated document that can see neither
     * `document.fonts` (what `ensureSceneFontLoaded` populates) nor the page's
     * `fonts-v2.css` `@font-face`. Pixi inlines the face into the SVG itself,
     * but only for families it has loaded through `Assets` — so the SAME
     * hashed family must additionally be registered there.
     */
    private async ensureSceneHtmlTextFontLoaded(rawFontPath: string): Promise<string> {
        const familyName = await this.ensureSceneFontLoaded(rawFontPath);
        if (!this.isSceneFontPath(rawFontPath)) return familyName;

        const resolvedPath = this.resolveSceneAssetPath(rawFontPath, ['pixi:font']);
        const loadedUrl = this.sceneFontUrls.get(this.normalizeSceneAssetPath(resolvedPath || rawFontPath));
        await registerHtmlTextFont(familyName, loadedUrl ?? encodeURI(resolvedPath || rawFontPath));
        return familyName;
    }

    private applyGraphicsCommands(g: PixiGraphics, commands: OrcaGraphicsCommand[]): void {
        // Destroy any gradient fill textures generated on a previous build of
        // this Graphics (avoids GPU/texture leaks), then start a fresh list and
        // make sure they are also torn down when the Graphics is destroyed.
        const previousGradientTextures = this.graphicsGradientTextures.get(g);
        if (previousGradientTextures) {
            for (const tex of previousGradientTextures) {
                try { tex.destroy(true); } catch { /* already destroyed */ }
            }
        }
        const gradientTextures: PixiTexture[] = [];
        this.graphicsGradientTextures.set(g, gradientTextures);
        this.hookGraphicsGradientCleanup(g);

        for (const cmd of commands) {
            const type   = cmd['type']        as string;
            const fill   = cmd['fill']        as number | undefined;
            const stroke = cmd['stroke']      as number | undefined;
            const sw     = (cmd['strokeWidth'] as number | undefined) ?? 2;
            const fillAlpha = (typeof cmd['fillAlpha'] === 'number')
                ? this.clamp01(cmd['fillAlpha'] as number)
                : 1;
            const strokeAlpha = (typeof cmd['strokeAlpha'] === 'number')
                ? this.clamp01(cmd['strokeAlpha'] as number)
                : 1;

            const gradient = cmd['fillGradient'] as OrcaGradientFill | undefined;
            const hasGradient = !!gradient && Array.isArray(gradient.stops) && gradient.stops.length >= 2;

            // A 2-point open path has no fillable interior; Pixi 6's
            // begin/endFill around a `line` drew nothing either.
            const wantsFill = type !== 'line' && (hasGradient || fill !== undefined);
            const wantsStroke = stroke !== undefined;
            // Pixi 8 is RETAINED-mode: the path accumulates until a `fill()` or
            // `stroke()` consumes it. A command that would neither fill nor
            // stroke must be skipped entirely or its path would bleed into the
            // next command's fill.
            if (!wantsFill && !wantsStroke) continue;

            // Path FIRST, then fill/stroke — the inverse of Pixi 6's
            // beginFill → drawShape → endFill ordering.
            switch (type) {
                case 'rect':
                    g.rect(
                        cmd['x']      as number,
                        cmd['y']      as number,
                        cmd['width']  as number,
                        cmd['height'] as number,
                    );
                    break;
                case 'circle':
                    g.circle(
                        cmd['x']      as number,
                        cmd['y']      as number,
                        cmd['radius'] as number,
                    );
                    break;
                case 'ellipse':
                    g.ellipse(
                        cmd['x']      as number,
                        cmd['y']      as number,
                        (cmd['width']  as number) / 2,
                        (cmd['height'] as number) / 2,
                    );
                    break;
                case 'roundRect':
                    g.roundRect(
                        cmd['x']      as number,
                        cmd['y']      as number,
                        cmd['width']  as number,
                        cmd['height'] as number,
                        cmd['radius'] as number,
                    );
                    break;
                case 'line':
                    g.moveTo(cmd['x1'] as number, cmd['y1'] as number);
                    g.lineTo(cmd['x2'] as number, cmd['y2'] as number);
                    break;
                case 'polygon': {
                    // `close` defaults to true, matching Pixi 6's drawPolygon.
                    const pts = cmd['points'] as number[];
                    g.poly(pts);
                    break;
                }
                default:
                    continue;
            }

            // Fill — gradient (>= 2 stops) overrides the solid fill/fillAlpha.
            if (wantsFill) {
                const baked = hasGradient
                    ? this.bakeGradientFill(gradient as OrcaGradientFill, this.computeCommandBounds(cmd))
                    : null;
                if (baked) {
                    gradientTextures.push(baked.texture);
                    // `textureSpace: 'global'` preserves Pixi 6
                    // `beginTextureFill(texture, matrix)` semantics: the bitmap
                    // is laid out in the Graphics' own local space. The v8
                    // DEFAULT, 'local', would instead stretch it to each
                    // shape's bounds and make the matrix meaningless.
                    g.fill({ texture: baked.texture, matrix: baked.matrix, textureSpace: 'global' });
                } else if (fill !== undefined) {
                    g.fill({ color: fill, alpha: fillAlpha });
                }
            }

            if (wantsStroke) {
                g.stroke({ width: sw, color: stroke, alpha: strokeAlpha });
            }
        }
    }

    /**
     * Patch a Graphics object's `destroy` once so that any canvas-baked
     * gradient fill textures tracked for it are destroyed alongside it. The
     * runtime builds a fresh Graphics per node and tears it down via the scene
     * container's `destroy({ children: true })`, which does NOT destroy fill
     * textures — so this prevents a GPU texture leak on scene teardown.
     */
    private hookGraphicsGradientCleanup(g: PixiGraphics): void {
        if ((g as any).__orcaGradientDestroyHooked) return;
        (g as any).__orcaGradientDestroyHooked = true;
        const originalDestroy = g.destroy.bind(g);
        g.destroy = (options?: Parameters<PixiGraphics['destroy']>[0]) => {
            const textures = this.graphicsGradientTextures.get(g);
            if (textures) {
                for (const tex of textures) {
                    try { tex.destroy(true); } catch { /* already destroyed */ }
                }
                this.graphicsGradientTextures.delete(g);
            }
            originalDestroy(options);
        };
    }

    /**
     * Compute the axis-aligned local bounding box of a graphics command, used
     * to size + position a baked gradient fill texture. Mirrors the editor.
     */
    private computeCommandBounds(cmd: OrcaGraphicsCommand): { x: number; y: number; width: number; height: number } {
        const type = cmd['type'] as string;
        switch (type) {
            case 'rect':
            case 'roundRect':
                return {
                    x: cmd['x'] as number,
                    y: cmd['y'] as number,
                    width: cmd['width'] as number,
                    height: cmd['height'] as number,
                };
            case 'circle': {
                const r = cmd['radius'] as number;
                return { x: (cmd['x'] as number) - r, y: (cmd['y'] as number) - r, width: r * 2, height: r * 2 };
            }
            case 'ellipse': {
                // drawEllipse(x, y, width/2, height/2) — (x,y) is the centre.
                const w = cmd['width'] as number;
                const h = cmd['height'] as number;
                return { x: (cmd['x'] as number) - w / 2, y: (cmd['y'] as number) - h / 2, width: w, height: h };
            }
            case 'polygon': {
                const pts = cmd['points'] as number[] | undefined;
                if (!pts || pts.length < 2) return { x: 0, y: 0, width: 1, height: 1 };
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let i = 0; i + 1 < pts.length; i += 2) {
                    const px = pts[i];
                    const py = pts[i + 1];
                    if (px < minX) minX = px;
                    if (px > maxX) maxX = px;
                    if (py < minY) minY = py;
                    if (py > maxY) maxY = py;
                }
                return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
            }
            default:
                return { x: 0, y: 0, width: 1, height: 1 };
        }
    }

    /**
     * Bake a linear gradient into an offscreen `<canvas>` texture and compute a
     * `PIXI.Matrix` that maps it across the shape's local bounds ('vertical' =
     * top→bottom, 'horizontal' = left→right). Returns null when unrenderable.
     * Mirrors the editor's Pixi8Adapter.
     */
    private bakeGradientFill(
        gradient: OrcaGradientFill,
        bounds: { x: number; y: number; width: number; height: number },
    ): { texture: PixiTexture; matrix: any } | null {
        const stops = gradient.stops;
        if (!stops || stops.length < 2) return null;
        const horizontal = gradient.direction === 'horizontal';
        const w = Math.max(1, Math.ceil(Math.abs(bounds.width)));
        const h = Math.max(1, Math.ceil(Math.abs(bounds.height)));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const grad = horizontal
            ? ctx.createLinearGradient(0, 0, w, 0)
            : ctx.createLinearGradient(0, 0, 0, h);
        const sorted = [...stops].sort((a, b) => a.offset - b.offset);
        for (const stop of sorted) {
            grad.addColorStop(this.clamp01(stop.offset), this.colorToRgba(stop.color, stop.alpha ?? 1));
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
        const texture = Pixi.Texture.from(canvas);
        // Translate the w×h bitmap so its top-left aligns with the shape's
        // local bounding-box origin (1:1 pixel mapping).
        const matrix = new Pixi.Matrix();
        matrix.translate(bounds.x, bounds.y);
        return { texture, matrix };
    }

    /**
     * Pixi 8 blend modes are STRINGS and `BLEND_MODES` is a type-only export —
     * the Pixi 6 `PIXI.BLEND_MODES.NORMAL` enum reads no longer exist at
     * runtime. All seven authored modes are members of the v8 union verbatim.
     */
    private resolveBlendMode(blendMode: string): Pixi.BLEND_MODES {
        const map: Record<string, Pixi.BLEND_MODES> = {
            normal:   'normal',
            add:      'add',
            multiply: 'multiply',
            screen:   'screen',
            overlay:  'overlay',
            darken:   'darken',
            lighten:  'lighten',
        };
        return map[blendMode.toLowerCase()] ?? 'normal';
    }

    private findCameraNode(nodes: OrcaSceneNode[]): OrcaSceneNode | null {
        for (const node of nodes) {
            if (node.type === 'camera') return node;
            const found = this.findCameraNode(node.children);
            if (found) return found;
        }
        return null;
    }

    private findJackpotsModuleNode(nodes: OrcaSceneNode[]): OrcaSceneNode | null {
        for (const node of nodes) {
            if (node.type === 'jackpotsModule') return node;
            const found = this.findJackpotsModuleNode(node.children);
            if (found) return found;
        }
        return null;
    }
}

export default new SceneManager();
