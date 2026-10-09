// @flowstate-injection: reels-component mode=injected
// @flowstate-injection-begin
import { GCReelView, GCSymbolView, GCService, SpinProfileAction, SpinProfileSequence, type ICascadeSettings } from '@game-studio/generic-reels';
import * as PIXI from 'pixi.js';
// NAMED, not `PIXI.filters.*`: Pixi 8 has no `filters` namespace OBJECT, so the
// v6 `PIXI.filters.BlurFilter` was `undefined.BlurFilter` at runtime. Blur moved
// into `pixi.js` core; GlowFilter is still a `pixi-filters` export. Same module
// split as scene-manager's authored-filter registry — keep the two consistent.
import { BlurFilter } from 'pixi.js';
import { GlowFilter } from 'pixi-filters';
import { Spine } from '@esotericsoftware/spine-pixi-v8';
import type { SkeletonData } from '@esotericsoftware/spine-pixi-v8';
import { AssetManager } from '@game-studio/arcade-base';
// `GameApplication.pixiApp.renderer` is the agreed-upon renderer access path
// for runtime baking (RenderTextures, dynamic blur). Soft import — the file
// path is part of the bundled template and is stable across re-injection.
import { GameApplication } from '../../../views/game/application';
// Global FlowState dispatcher — used to fire the `cascadeComplete` starter
// when the injected reel service finishes a cascade sequence. Same import +
// call convention as the application event triggers and scene methods.
import { Flowstate } from '../flowstate';

// Reads the live renderer resolution so RenderTextures + Filters bake at
// device fidelity (arcade-base `calcResolution` chooses 2..4). Defaults to
// 1 if the renderer isn't reachable yet — caller will get a soft pass.
function getRendererResolution(): number {
  try {
    const r = (GameApplication as any)?.pixiApp?.renderer?.resolution;
    return typeof r === 'number' && r > 0 ? r : 1;
  } catch {
    return 1;
  }
}

export interface FlowstateInjectedSpinProfileAction {
  stopReel: number | number[];
  reelSpeed: number | number[] | { speed: number; overrides?: Record<number, number> };
  delay: number;
}

/**
 * Single entry in `FlowstateInjectedReelsConfig.winlineColors[]`. Each
 * winline picks one entry (line index modulo array length); an entry is
 * either a solid color OR its own linear gradient (evenly-spaced stops).
 */
export type WinlineColorEntry =
  | { kind: 'solid'; color: number }
  | { kind: 'gradient'; colors: number[] };

export interface FlowstateInjectedReelsConfig {
  name: string;
  reelCount?: number;
  rowCount?: number;
  symbolWidth?: number;
  symbolHeight?: number;
  symbolRectMode?: 'shared' | 'individual';
  symbolRects?: Array<{ x?: number; y?: number }>;
  symbolSpacingX?: number;
  symbolSpacingY?: number;
  reelSpacing?: number;
  reelSpacings?: number[];
  reelOffsets?: Array<{ x?: number; y?: number }>;
  maskPadding?: number;
  symbols?: string[];
  symbolStaticsImage?: string;
  symbolStaticsAtlas?: string;
  /** `winAudio` is a BARE bucket-relative path (e.g. `assets/sounds/win.mp3`),
   *  NOT an `AssetRef` and NOT scope-qualified — the runtime derives the scope
   *  from the owning scene's origin. Absent/empty ⇒ that symbol is silent. */
  symbolEntries?: Array<{ sprite: string; spineAnimation?: string; skin?: string; animatedSpriteAsset?: string; winAnimation?: string; winAudio?: string; landAnimation?: string; landAnimationEnabled?: boolean; landAnimationLoop?: boolean; scale?: number }>;
  /** PREFERRED SYMBOL DRAW ORDER — a presentation-only overlay on top of
   *  `symbolEntries`, listing symbol IDs (indices into `symbolEntries`) with
   *  the FIRST entry drawn on TOP.
   *
   *  `symbolEntries` itself is NEVER reordered: the array index IS the symbol
   *  ID and is consumed by reel strips, server stops and the FlowState symbol
   *  action nodes. This array only decides which overlapping symbol wins.
   *
   *  ABSENT ⇒ identity order (`[0,1,2,…]`) ⇒ today's insertion-order
   *  rendering, byte-identical. The editor only emits the field when it
   *  differs from identity. Junk (non-number / non-integer / out-of-range /
   *  duplicate / missing IDs) is normalized at the read site — see
   *  `normalizeSymbolDrawOrder`. */
  symbolDrawOrder?: number[];
  /** Dynamic text slots drawn on symbols (exported only when enabled); see
   *  `ReelsSymbolTextState`. Absent ⇒ no text layer at all. */
  symbolTexts?: FlowstateSymbolTextSlot[];
  /** `'animatedSprite'` is a legacy alias for `'sprite'` (treated identically at runtime). */
  symbolMode?: 'spine' | 'sprite' | 'animatedSprite';
  sharedSpineAnimation?: string;
  showDebugCells?: boolean;
  spinProfileActions?: FlowstateInjectedSpinProfileAction[];
  /** Initial rollback ("rollstart") speed at the start of a spin. Maps onto
   *  `IReelSettings.rollbackSpeed`. Default -15. */
  rollbackSpeed?: number;
  /** Elastic stop bounce intensity. Maps onto
   *  `IReelSettings.bounceSettings.elasticStopIntensity`. Default 0.98. */
  elasticStopIntensity?: number;
  /** Elastic stop bounce duration (seconds). Maps onto
   *  `IReelSettings.bounceSettings.elasticStopDuration`. Default 0.8. */
  elasticStopDuration?: number;
  /** Elastic stop bounce amplitude. Maps onto
   *  `IReelSettings.bounceSettings.elasticBounceAmplitude`. Default 1. */
  elasticBounceAmplitude?: number;
  /** Elastic stop bounce period. Maps onto
   *  `IReelSettings.bounceSettings.elasticBouncePeriod`. Default 0.3. */
  elasticBouncePeriod?: number;
  /** Cascade fall duration (seconds) per symbol. Maps onto
   *  `ICascadeSettings.cascadeFallSettings.fallTime`. */
  cascadeFallTime?: number;
  /** Cascade fall start offset (px). Maps onto
   *  `ICascadeSettings.cascadeFallSettings.fallOffset`. */
  cascadeFallOffset?: number;
  /** Cascade landing bounce duration (seconds). Maps onto
   *  `ICascadeSettings.cascadeBounceSettings.duration`. */
  cascadeBounceDuration?: number;
  /** Cascade landing bounce offset (px). Maps onto
   *  `ICascadeSettings.cascadeBounceSettings.offset`. */
  cascadeBounceOffset?: number;
  /** Stagger delay between each reel's removal phase (seconds). Maps onto
   *  `ICascadeSettings.cascadeRemoveDelay`. */
  cascadeRemoveDelay?: number;
  /** Per-block fall stagger delay (seconds). Maps onto
   *  `ICascadeSettings.cascadeBlockFallDelay`. */
  cascadeBlockFallDelay?: number;
  /** Visual effect applied to winning symbols on top of the existing winning tween. Defaults to `'none'`. */
  winSymbolEffect?: 'none' | 'sheen' | 'glow' | 'pulse';
  /** Vertical blur strength applied per-symbol while the reel is spinning (>= reelBlurSpeedTrigger). 0..16, default 0 (disabled). */
  reelBlurStrength?: number;
  /** Reel speed at/above which the blurred texture is shown. Default 8. */
  reelBlurSpeedTrigger?: number;
  winningSymbolBehavior?: 'playAnimation' | 'playAnimationWithWinline';
  nonWinningSymbolBehavior?: 'darken' | 'alpha' | 'none';
  winlineColor?: number;
  winlineThickness?: number;
  winlineAlpha?: number;
  winlineLeadLength?: number;
  winningTweenStyle?:
    | 'none' | 'pulse' | 'bounce' | 'pop' | 'shake' | 'spin' | 'wiggle'
    | 'sway' | 'flash' | 'expand' | 'heartbeat';
  winningTweenDurationSec?: number;
  winningTweenIntensity?: number;
  winningTweenEase?: string;
  nonWinningAlpha?: number;
  nonWinningDarkenColor?: number;
  winlineDrawOrder?: 'inFront' | 'behind';
  winlineCycleDelaySec?: number;
  winlineMultiPlayMode?: 'cycle' | 'concurrent';
  /** Per-line color entries (line i → entries[i % entries.length]). Each
   *  entry is either a solid color or its own gradient. Falls back to
   *  `[{kind:'solid', color: winlineColor}]` when omitted/empty. Only
   *  consulted when `winlineFillMode === 'colors'`. */
  winlineColors?: WinlineColorEntry[];
  winlineFillMode?: 'colors' | 'texture';
  /** Path string (resolved through `resolveTexture`). Only used when
   *  `winlineFillMode === 'texture'`. */
  winlineTexture?: string | null;
  winlineStrokeStyle?: 'solid' | 'dashed' | 'dotted';
  winlineDashLength?: number;
  winlineDashGap?: number;
  winlineDotSize?: number;
  winlineDotGap?: number;
  winlinePathAnimation?:
    | 'none' | 'fadeIn' | 'drawOnLeft' | 'drawOnRight'
    | 'pulse' | 'glow' | 'travel' | 'dash';
  winlinePathAnimationDurationSec?: number;
  winlinePathAnimationIntensity?: number;
  winlinePathAnimationEase?: string;
  /** Visual shape variant for the winline polyline. Defaults to `'plain'`. */
  winlineRopeStyle?: 'plain' | 'curved' | 'tapered' | 'trail';
  /** Pixi-filters GlowFilter toggle. */
  winlineGlowEnabled?: boolean;
  winlineGlowColor?: number;
  winlineGlowDistance?: number;
  winlineGlowStrength?: number;
  winlineGlowAlpha?: number;
  winlineGlowQuality?: number;
}

/** Per-symbol render scale bounds. Mirrors the editor's authoring slider —
 *  keep the two in lock-step if the range ever changes. */
const SYMBOL_SCALE_MIN = 0.1;
const SYMBOL_SCALE_MAX = 3;

/**
 * Clamp an authored per-symbol `scale` into [0.1, 3].
 *
 * The field is written by the editor ONLY when the author moved it off the
 * default, so `undefined` (and any junk / NaN / non-finite value) must fall
 * back to 1 — a scene exported before this field existed then renders exactly
 * as it did before.
 */
function clampSymbolScale(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return 1;
  return Math.max(SYMBOL_SCALE_MIN, Math.min(SYMBOL_SCALE_MAX, parsed));
}

/** zIndex the winline player parks a WINNING symbol at while a line is being
 *  presented (see `presentLines` in the winline sibling block below, which
 *  hardcodes the same literal). Draw-order priorities are derived to stay far
 *  below this so a win always beats the authored draw order, and `applySkin`
 *  refuses to stomp a live elevation. */
const WINLINE_SYMBOL_ELEVATION_ZINDEX = 1000;

/** Fallback pad-row reach used by `isSymbolOnScreen`'s elastic-overshoot
 *  widening when the reel's bounce geometry can't be read, and as the default
 *  for a missing `coreSettings.topOffset` / `bottomOffset`. Matches the
 *  package's `DEFAULT_CORE_SETTINGS` (`topOffset: 1, bottomOffset: 1`), so the
 *  fallback wakes exactly the rows a default reel actually has. */
const REELS_DEFAULT_OVERSHOOT_ROW_REACH = 1;

/** Ceiling for a derived draw-order zIndex. Keeps every priority well below
 *  `WINLINE_SYMBOL_ELEVATION_ZINDEX` even for an absurd symbol count (above
 *  this many symbols the top-most priorities tie and fall back to insertion
 *  order — Pixi's `sortChildren` is a stable sort). */
const SYMBOL_DRAW_PRIORITY_MAX = 900;

/**
 * Normalize an authored `symbolDrawOrder` into a DENSE permutation of
 * `0..count-1`. Never throws — a hand-edited scene JSON can put anything in
 * here.
 *
 * Rules (mirroring `clampSymbolScale`'s "junk falls back to the default"
 * precedent): non-number / non-integer / out-of-range / duplicate IDs are
 * DROPPED, and any ID that never appeared is appended in ascending order.
 * `undefined` (the pre-feature shape) therefore yields the identity order.
 */
function normalizeSymbolDrawOrder(order: unknown, count: number): number[] {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count as number)) : 0;
  const seen = new Set<number>();
  const normalized: number[] = [];
  if (Array.isArray(order)) {
    for (const raw of order) {
      // Real numbers ONLY — `Number(null)` / `Number('')` coerce to 0 and
      // would silently promote symbol 0 to the top of the list. Matches the
      // editor-side `normalizeReelsSymbolDrawOrder` exactly.
      if (typeof raw !== 'number' || !Number.isInteger(raw)) continue;
      if (raw < 0 || raw >= total) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      normalized.push(raw);
    }
  }
  for (let id = 0; id < total; id += 1) {
    if (!seen.has(id)) normalized.push(id);
  }
  return normalized;
}

/**
 * Derive the per-symbol-ID draw priority (zIndex) table from an authored
 * `symbolDrawOrder`, or `null` when the resolved order is the IDENTITY order.
 *
 * `zIndex = count - positionInDrawOrder`, so the FIRST list entry gets the
 * highest zIndex and is drawn on top.
 *
 * BACK-COMPAT — why identity returns `null` rather than a descending ramp:
 * the reel symbol holder now has `sortableChildren` enabled unconditionally
 * (see `allowZIndexSymbolSorting` in `buildFlowstateReelsDisplay`). Pixi's
 * `Container.sortChildren` SKIPS the sort entirely while every child's zIndex
 * is 0, so leaving all symbols at 0 in the default case reproduces today's
 * raw insertion order exactly. Handing out a distinct descending zIndex per
 * symbol ID would instead re-stack overlapping symbols (visible as soon as a
 * per-symbol `scale > 1` makes neighbours overlap), which is NOT what an
 * absent `symbolDrawOrder` may do.
 */
function buildSymbolDrawPriorities(order: unknown, count: number): number[] | null {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count as number)) : 0;
  if (total === 0) return null;
  const normalized = normalizeSymbolDrawOrder(order, total);
  let isIdentity = true;
  for (let i = 0; i < total; i += 1) {
    if (normalized[i] !== i) { isIdentity = false; break; }
  }
  if (isIdentity) return null;
  const priorities = new Array<number>(total).fill(0);
  for (let position = 0; position < normalized.length; position += 1) {
    priorities[normalized[position]] = Math.min(SYMBOL_DRAW_PRIORITY_MAX, total - position);
  }
  return priorities;
}

/**
 * Look up a draw priority for a symbol ID that may exceed the AUTHORED symbol
 * count. `ensureMinimumSymbolEntries` pads `symbolEntries` up to
 * `reelCount * rowCount` by repeating the authored entries modulo the authored
 * count, so padded ID N is a clone of authored symbol `N % authoredCount` and
 * must render at that symbol's depth. Same wrap the padding itself uses.
 */
function symbolDrawPriorityFor(priorities: number[] | null, symbolId: number): number {
  if (!priorities || priorities.length === 0) return 0;
  const finite = Number.isFinite(symbolId) ? Math.round(symbolId) : 0;
  const index = ((finite % priorities.length) + priorities.length) % priorities.length;
  return priorities[index] ?? 0;
}

// =========================================================================
// Dynamic symbol TEXTS (Reels node `symbolTexts`)
// =========================================================================
// A text slot is drawn on every symbol view; the TEXT itself travels with the
// reel STRIP ENTRY, not with the view. The package recycles a fixed pool of
// views while a reel spins (every index step re-skins every view from the
// strip), so a value tied to a view would jump from symbol to symbol. Instead
// a strip entry that carries texts is written as a VIRTUAL skin id that
// `ReelsSymbolTextState` decodes back to `{ symbol, texts }` the moment the
// package writes it onto a view (the `symbolData.skin` accessor installed by
// `FlowstateInjectedSymbolView`). Every package path copies skins verbatim —
// strip scrolling, stop blending, cascades — so the texts land with their
// symbols. This is the same sub-skin idea the Cash Collector games use.

export interface FlowstateSymbolTextStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  fill?: number;
  stroke?: number;
  strokeThickness?: number;
  dropShadow?: boolean;
  dropShadowColor?: number;
  dropShadowBlur?: number;
  dropShadowDistance?: number;
  dropShadowAlpha?: number;
  letterSpacing?: number;
}

export interface FlowstateSymbolTextSlot {
  name?: string;
  /** Symbol ids the text is drawn on; empty = every symbol. */
  symbols?: number[];
  offsetX?: number;
  offsetY?: number;
  anchorX?: number;
  anchorY?: number;
  /** Widest the text may draw before it is scaled to fit; 0 = no limit. */
  maxWidth?: number;
  /** Random texts for the filler symbols a reel scrolls past in `spinReelsToGrid`. */
  fillerTexts?: string[];
  style?: FlowstateSymbolTextStyle;
}

/** Virtual skin ids start far above any real symbol id. */
const VIRTUAL_SKIN_BASE = 1 << 20;
const SYMBOL_TEXT_LAYER_ZINDEX = 500;
const SYMBOL_TEXT_FONT_FILE_RE = /\.(otf|ttf|woff2?)(\?|#|$)/i;

interface NormalizedSymbolTextSlot {
  symbols: Set<number> | null;
  offsetX: number;
  offsetY: number;
  anchorX: number;
  anchorY: number;
  maxWidth: number;
  fillerTexts: string[];
  fontRef: string;
  style: Required<Omit<FlowstateSymbolTextStyle, 'fontFamily'>>;
}

function normalizeSymbolTextSlots(raw: unknown): NormalizedSymbolTextSlot[] {
  if (!Array.isArray(raw)) return [];
  const num = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return raw.slice(0, 5).map((entry) => {
    const slot = (entry && typeof entry === 'object' ? entry : {}) as FlowstateSymbolTextSlot;
    const style = (slot.style && typeof slot.style === 'object' ? slot.style : {}) as FlowstateSymbolTextStyle;
    const ids = Array.isArray(slot.symbols)
      ? slot.symbols.filter((id) => typeof id === 'number' && Number.isInteger(id) && id >= 0)
      : [];
    return {
      symbols: ids.length > 0 ? new Set(ids) : null,
      offsetX: num(slot.offsetX, 0),
      offsetY: num(slot.offsetY, 0),
      anchorX: Math.max(0, Math.min(1, num(slot.anchorX, 0.5))),
      anchorY: Math.max(0, Math.min(1, num(slot.anchorY, 0.5))),
      maxWidth: Math.max(0, num(slot.maxWidth, 0)),
      fillerTexts: Array.isArray(slot.fillerTexts) ? slot.fillerTexts.filter((t) => typeof t === 'string' && t !== '') : [],
      fontRef: typeof style.fontFamily === 'string' && style.fontFamily.trim() ? style.fontFamily.trim() : 'Arial',
      style: {
        fontSize: Math.max(1, num(style.fontSize, 36)),
        fontWeight: style.fontWeight === 'normal' ? 'normal' : 'bold',
        fill: num(style.fill, 0xffffff),
        stroke: num(style.stroke, 0x000000),
        strokeThickness: Math.max(0, num(style.strokeThickness, 6)),
        dropShadow: style.dropShadow !== false,
        dropShadowColor: num(style.dropShadowColor, 0x000000),
        dropShadowBlur: Math.max(0, num(style.dropShadowBlur, 4)),
        dropShadowDistance: Math.max(0, num(style.dropShadowDistance, 3)),
        dropShadowAlpha: Math.max(0, Math.min(1, num(style.dropShadowAlpha, 0.6))),
        letterSpacing: num(style.letterSpacing, 0),
      },
    };
  });
}

/**
 * One reels node's symbol-text slots, its virtual-skin table and the texts
 * FlowState has staged for the NEXT board. Hung on the reel service (so every
 * symbol view can reach it) and on the root (so the FlowState methods can).
 */
export class ReelsSymbolTextState {
  public readonly slots: NormalizedSymbolTextSlot[];
  /** Font family per slot: a system font as authored, a font FILE once loaded. */
  public readonly families: string[];
  private table = new Map<number, { symbol: number; texts: string[] }>();
  private nextId = VIRTUAL_SKIN_BASE;
  private staged = new Map<string, string[]>();

  constructor(slots: NormalizedSymbolTextSlot[]) {
    this.slots = slots;
    // A font file draws with a generic fallback until the scene manager has
    // loaded it (`setFamily`), so a missing font never blanks the text.
    this.families = slots.map((slot) => (SYMBOL_TEXT_FONT_FILE_RE.test(slot.fontRef) ? 'sans-serif' : slot.fontRef));
  }

  public get slotCount(): number {
    return this.slots.length;
  }

  public setFamily(slot: number, family: string): void {
    if (slot >= 0 && slot < this.families.length && family) this.families[slot] = family;
  }

  public appliesTo(slot: number, symbol: number): boolean {
    const set = this.slots[slot]?.symbols;
    return !set || set.has(symbol);
  }

  /**
   * A strip value for `symbol` carrying `texts`. Always a virtual id, so the
   * write sets the view's texts explicitly — empty texts clear stale ones.
   */
  public encode(symbol: number, texts: readonly string[] | null | undefined): number {
    const list = Array.from({ length: this.slots.length }, (_, i) => String(texts?.[i] ?? ''));
    const id = this.nextId;
    this.nextId += 1;
    this.table.set(id, { symbol, texts: list });
    return id;
  }

  /** A filler strip value: `symbol` with a random filler text in every slot that has some. */
  public encodeFiller(symbol: number): number {
    let any = false;
    const texts = this.slots.map((slot, i) => {
      if (slot.fillerTexts.length === 0 || !this.appliesTo(i, symbol)) return '';
      any = true;
      return slot.fillerTexts[Math.floor(Math.random() * slot.fillerTexts.length)];
    });
    return any ? this.encode(symbol, texts) : symbol;
  }

  public decode(raw: number): { symbol: number; texts: string[] } | null {
    if (raw < VIRTUAL_SKIN_BASE) return null;
    return this.table.get(raw) ?? null;
  }

  /**
   * Forget every virtual id. Only safe when the strips that used them are
   * being replaced. Ids keep counting up, so an old strip value can never be
   * mistaken for a new one.
   */
  public resetTable(): void {
    this.table.clear();
  }

  public stage(reel: number, row: number, slot: number, text: string): void {
    if (slot < 0 || slot >= this.slots.length) return;
    const key = `${reel}:${row}`;
    const texts = this.staged.get(key) ?? this.slots.map(() => '');
    texts[slot] = text;
    this.staged.set(key, texts);
  }

  public stagedAt(reel: number, row: number): string[] | null {
    return this.staged.get(`${reel}:${row}`) ?? null;
  }

  public clearStaged(): void {
    this.staged.clear();
  }
}

function buildSymbolTextStyle(slot: NormalizedSymbolTextSlot, family: string): PIXI.TextStyleOptions {
  const s = slot.style;
  return {
    fontFamily: family,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    fill: s.fill,
    letterSpacing: s.letterSpacing,
    align: 'center',
    ...(s.strokeThickness > 0 ? { stroke: { color: s.stroke, width: s.strokeThickness } } : {}),
    dropShadow: s.dropShadow
      ? { color: s.dropShadowColor, blur: s.dropShadowBlur, distance: s.dropShadowDistance, alpha: s.dropShadowAlpha, angle: Math.PI / 4 }
      : false,
  };
}

class FlowstateInjectedReelService extends GCService {}

// ═══════════════════════════════════════════════════════════════════════════
// ORCA_TEMP_DIAG — TEMPORARY DIAGNOSTIC INSTRUMENTATION. NOT A FIX.
// Delete this entire block (and its two call sites, both marked
// `ORCA_TEMP_DIAG`) to revert. Purpose: capture the render state of every
// symbol on the frames around a spine SETTLE, to identify why a reel column
// blanks for exactly one frame ~500ms (the authored `land` duration) after
// the reel stops.
//
// KILL SWITCH (no rebuild needed) — in the browser console:
//     window.ORCA_TEMP_DIAG_REELS = false    // stop collecting
//     window.ORCA_TEMP_DIAG_REELS = true     // resume
// DUMP THE CAPTURE:
//     window.__ORCA_TEMP_DIAG_DUMP()         // console.table of all rows
//     copy(JSON.stringify(window.__ORCA_TEMP_DIAG_LOG))   // export
//
// FALSIFIABILITY. The columns are chosen so the candidate hypotheses give
// DIFFERENT signatures on the `SETTLE` row, not merely consistent ones:
//   * invalid-texture (candidate 4) => sVis=true, sWA≈1, texValid=false OR
//     btValid=false OR btW/btH=0, and `texSrc` names which texture failed.
//   * alpha bail                    => sWA<=0 (already refuted statically;
//                                      this proves it at runtime).
//   * stale transform               => wtx/wty differ from the post-settle
//                                      rows by more than a pixel or two.
//   * fall-through / no texture     => sVis=false and texSrc='EMPTY'.
//   * degenerate size               => sW/sH ≈ 0 or 1 vs fW/fH.
// The `post` rows are the key control: whatever the defect is, it must be
// TRANSIENT (the artefact self-corrects on the next frame), so the differing
// column between `SETTLE` and `post+1` is the cause. Any property that is
// identical across SETTLE and all `post` rows is NOT the cause.
// ═══════════════════════════════════════════════════════════════════════════

interface OrcaTempDiagView {
  sprite: PIXI.Sprite;
  spine: { visible: boolean; autoUpdate: boolean } | null;
  lastRenderableTexture: PIXI.Texture | null;
  symbolData?: { index?: number; skin?: number };
  parentReelData?: { index?: number };
}

type OrcaTempDiagRow = Record<string, unknown>;

const ORCA_TEMP_DIAG_LEAD_FRAMES = 3;
const ORCA_TEMP_DIAG_TAIL_FRAMES = 3;
const ORCA_TEMP_DIAG_MAX_ROWS = 5000;
const ORCA_TEMP_DIAG_LEAD_MAX_AGE = 180;

const orcaTempDiagState = {
  frame: 0,
  installed: false,
  lead: new Map<OrcaTempDiagView, { ring: OrcaTempDiagRow[]; age: number }>(),
  tail: new Map<OrcaTempDiagView, number>(),
  rows: [] as OrcaTempDiagRow[],
};

function orcaTempDiagWindow(): Record<string, unknown> | null {
  return typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : null;
}

function orcaTempDiagEnabled(): boolean {
  const w = orcaTempDiagWindow();
  if (!w) return false;
  return w.ORCA_TEMP_DIAG_REELS !== false;
}

function orcaTempDiagSample(view: OrcaTempDiagView, tag: string): OrcaTempDiagRow {
  const sprite = view.sprite;
  const tex: PIXI.Texture | null = sprite ? sprite.texture : null;
  const base = tex ? tex.source : null;

  let texSrc = 'none';
  if (tex) {
    if (tex === PIXI.Texture.EMPTY) {
      texSrc = 'EMPTY';
    } else if (view.lastRenderableTexture && tex === view.lastRenderableTexture) {
      texSrc = 'lastRenderable';
    } else {
      let baked = false;
      try { baked = SPINE_STATIC_BAKED_TEXTURES.has(tex); } catch { baked = false; }
      texSrc = baked ? 'bake' : 'other';
    }
  }

  let frameW = -1;
  let frameH = -1;
  try {
    const fr = findAncestorReelFrameTransform(view as unknown as PIXI.Container);
    if (fr) { frameW = Math.round(fr.width); frameH = Math.round(fr.height); }
  } catch { /* no-op */ }

  const wt = sprite ? sprite.worldTransform : null;

  return {
    f: orcaTempDiagState.frame,
    tag,
    reel: view.parentReelData?.index ?? -1,
    row: view.symbolData?.index ?? -1,
    skin: view.symbolData?.skin ?? -1,
    sVis: sprite ? sprite.visible : null,
    sA: sprite ? Number(sprite.alpha.toFixed(3)) : null,
    // v8's accumulated alpha; unlike Pixi 6's `worldAlpha` it accumulates only
    // to the enclosing render-group root, which is fine for this diagnostic.
    sWA: sprite ? Number(sprite.groupAlpha.toFixed(3)) : null,
    sRend: sprite ? sprite.renderable : null,
    sW: sprite ? Math.round(sprite.width) : -1,
    sH: sprite ? Math.round(sprite.height) : -1,
    fW: frameW,
    fH: frameH,
    wtx: wt ? Math.round(wt.tx) : null,
    wty: wt ? Math.round(wt.ty) : null,
    texSrc,
    texValid: tex ? isTextureSourceReady(tex.source) : null,
    btValid: base ? isTextureSourceReady(base) : null,
    btW: base ? base.width : -1,
    btH: base ? base.height : -1,
    spVis: view.spine ? view.spine.visible : null,
    spAuto: view.spine ? view.spine.autoUpdate : null,
  };
}

function orcaTempDiagPush(row: OrcaTempDiagRow): void {
  const rows = orcaTempDiagState.rows;
  rows.push(row);
  while (rows.length > ORCA_TEMP_DIAG_MAX_ROWS) rows.shift();
  const w = orcaTempDiagWindow();
  if (w) w.__ORCA_TEMP_DIAG_LOG = rows;
}

function orcaTempDiagInstall(): void {
  if (orcaTempDiagState.installed) return;
  orcaTempDiagState.installed = true;

  const w = orcaTempDiagWindow();
  if (w) {
    w.__ORCA_TEMP_DIAG_LOG = orcaTempDiagState.rows;
    w.__ORCA_TEMP_DIAG_DUMP = (): void => {
      /* eslint-disable no-console */
      console.log('[ORCA_TEMP_DIAG] ' + orcaTempDiagState.rows.length + ' rows');
      try { console.table(orcaTempDiagState.rows); } catch { console.log(orcaTempDiagState.rows); }
      /* eslint-enable no-console */
    };
  }

  try {
    // Registered AFTER the application's own render callback at the same
    // priority, so each sample reflects the state the renderer just drew.
    PIXI.Ticker.shared.add((): void => {
      orcaTempDiagState.frame += 1;
      if (!orcaTempDiagEnabled()) return;

      orcaTempDiagState.lead.forEach((entry, view) => {
        entry.age += 1;
        if (entry.age > ORCA_TEMP_DIAG_LEAD_MAX_AGE) {
          orcaTempDiagState.lead.delete(view);
          return;
        }
        entry.ring.push(orcaTempDiagSample(view, 'pre'));
        while (entry.ring.length > ORCA_TEMP_DIAG_LEAD_FRAMES) entry.ring.shift();
      });

      orcaTempDiagState.tail.forEach((left, view) => {
        orcaTempDiagPush(orcaTempDiagSample(view, 'post'));
        if (left <= 1) orcaTempDiagState.tail.delete(view);
        else orcaTempDiagState.tail.set(view, left - 1);
      });
    }, null, PIXI.UPDATE_PRIORITY.LOW);
  } catch { /* no-op */ }
}

/** ORCA_TEMP_DIAG — a land track just started on this symbol; begin sampling
 *  a rolling window so we have the frames LEADING UP TO the settle. */
function orcaTempDiagOnLandStart(view: unknown): void {
  orcaTempDiagInstall();
  if (!orcaTempDiagEnabled()) return;
  const v = view as OrcaTempDiagView;
  if (!orcaTempDiagState.lead.has(v)) orcaTempDiagState.lead.set(v, { ring: [], age: 0 });
}

/** ORCA_TEMP_DIAG — the spine has just been parked and the static restored.
 *  This is the frame the artefact appears on. Flush the lead window, capture
 *  the settle frame itself, and arm the tail so we catch the self-correction. */
function orcaTempDiagOnSettle(view: unknown): void {
  orcaTempDiagInstall();
  if (!orcaTempDiagEnabled()) return;
  const v = view as OrcaTempDiagView;

  const entry = orcaTempDiagState.lead.get(v);
  if (entry) {
    entry.ring.forEach((r) => orcaTempDiagPush(r));
    orcaTempDiagState.lead.delete(v);
  }

  const row = orcaTempDiagSample(v, 'SETTLE');
  orcaTempDiagPush(row);
  // eslint-disable-next-line no-console
  console.log('[ORCA_TEMP_DIAG] SETTLE', row);

  orcaTempDiagState.tail.set(v, ORCA_TEMP_DIAG_TAIL_FRAMES);
}


class FlowstateInjectedSymbolView extends GCSymbolView {
  private static symbolVisualResolver: (skinIndex: number) => { texture: PIXI.Texture; hasSprite: boolean; hasSpine: boolean; skin?: string; spineSkeletonPath?: string; winAnimation?: string; landAnimation?: string; landAnimationEnabled?: boolean; landAnimationLoop?: boolean; symbolScale?: number; drawPriority?: number } = () => ({
    texture: PIXI.Texture.EMPTY,
    hasSprite: false,
    hasSpine: false,
  });
  private readonly sprite: PIXI.Sprite;
  private lastRenderableTexture: PIXI.Texture | null = null;
  // Live spin-blur state. While the reel spins fast (speed >= trigger AND
  // `reelBlurStrength > 0`) a single vertical `BlurFilter` is applied
  // directly to the displayed static sprite — uniform for sprite mode AND
  // spine mode (whose resting pose is pre-baked into the sprite texture).
  // Driven per-tick from the live reel speed by the spin-blur ticker in
  // `buildFlowstateReelsDisplay`, torn down on teardown. Replaces the old
  // baked-blur-texture swap (dropped: a single live filter is simpler, can't
  // double-blur, and matches the editor preview exactly).
  private spinBlurFilter: BlurFilter | null = null;
  private spinBlurActive = false;
  // Spine symbol-mode state. A single `Spine` is hosted on `this` (the
  // per-symbol container) when the node is in spine mode and the shared
  // skeleton resolves from the loaded asset resources. It is cached and
  // only rebuilt when the skeleton path changes; the per-symbol skin is
  // re-applied when it changes. Stays hidden during spinning (static
  // sprite shown) and is revealed on reel stop via `setAnimationSkin`.
  private spine: Spine | null = null;
  private spineSkeletonPath: string | null = null;
  private spineSkinName: string | null = null;
  // Spine LIVENESS. A hosted `Spine` is only auto-updating (and visible) while
  // a track is genuinely playing; the rest of the time it is FROZEN
  // (`autoUpdate = false`, hidden) and the baked setup-pose static sprite is
  // shown instead, so an idle grid ticks zero skeletons on the shared ticker.
  // `spineActiveTracks` holds the one-shot `TrackEntry`s being waited on;
  // `spineLoopingTracks` holds track indices started with loop=true (they never
  // complete, so they hold the spine live until a skin change or explicit stop).
  private spineActiveTracks = new Set<unknown>();
  private spineLoopingTracks = new Set<number>();
  private spineStateListener: { complete: (entry: any) => void; interrupt: (entry: any) => void; dispose: (entry: any) => void } | null = null;
  // Re-entrancy guard: `setAnimation` drains its event queue synchronously, so
  // replacing a watched track fires `interrupt` for the OLD entry while the new
  // one is still being installed. Freezing there would clear the track we just
  // set (this is what breaks a cycled/repeated win animation).
  private spineTrackStarting = false;
  // ---- `applySkin` REDUNDANT-REAPPLICATION memo (anti-flicker) -----------
  // `setAnimationSkin()` has no in-template call sites: the package calls it
  // (`GRReelView.setAndPosition(true)` on reel stop, `GCReelView.
  // triggerCascadeFall()` per cascade). Because `applySkin` unconditionally
  // runs `cancelSymbolAnimationForSkinChange()` → `parkSpine()` and then
  // `startSpineTrack()` (which has no "already playing this" check), ANY
  // repeat call for the SAME cell restarts the land animation from t=0 and
  // ping-pongs baked-static ↔ live-spine — visible as a flicker.
  //
  // `lastAppliedSymbolSkin` / `lastAppliedSymbolIndex` identify the cell the
  // last `applySkin` resolved for. The identity is (skin, grid index) on
  // PURPOSE: `GCReelView.triggerCascadeFall` reassigns `symbolData.index` for
  // every symbol that falls, and a cascade landing IS a legitimate re-land —
  // including the index makes the guard stand down there instead of
  // swallowing the replay.
  private lastAppliedSymbolSkin: number | null = null;
  private lastAppliedSymbolIndex: number | null = null;
  // The land animation currently asserted on TRACK 0 by `applySkin`. Set only
  // by the spine branch of `applySkin`, cleared by `parkSpine`. Track 1 (win /
  // `playSymbolAnimation`) never writes it.
  private activeLandAnimation: string | null = null;
  // Last transform computed by `layoutSpine`, MEASURED AT THE SETUP POSE.
  // Re-asserted (never re-measured) by the guard: `getLocalBounds()` on a
  // mid-animation skeleton returns the ANIMATED bounds, so re-running
  // `layoutSpine` while a land is playing would visibly shift the symbol.
  private spineLayoutMemo: { scale: number; x: number; y: number } | null = null;
  // Animated-sprite symbol-mode playback state (FlowState
  // `playSymbolAnimation` only — the BUILD path still shows the cheap
  // frame-0 static texture). A single `PIXI.AnimatedSprite` is lazily hosted
  // on `this` and rebuilt only when the source descriptor path changes,
  // mirroring `ensureSpine`.
  private animatedSprite: PIXI.AnimatedSprite | null = null;
  private animatedSpriteSource: string | null = null;
  // Visibility captured just before a FlowState-driven symbol animation
  // starts, so `stopSymbolAnimation` can put the symbol back exactly how it
  // looked (landed spine, or static sprite) rather than guessing.
  private preAnimationVisibility: { spriteVisible: boolean; spineVisible: boolean | null } | null = null;
  // FlowState visual-override state. `visualOverrideSnapshot` is taken on the
  // FIRST override and is what `clearVisualOverride` restores;
  // `visualOverrideApplied` is the merged live override, re-asserted after a
  // `setSymbolIndex` (which re-runs `applySkin`, resetting scale + tint).
  private visualOverrideSnapshot: {
    alpha: number;
    visible: boolean;
    scaleX: number;
    scaleY: number;
    spriteTint: number;
    spineTint: number | null;
  } | null = null;
  private visualOverrideApplied: { alpha?: number; tint?: number; scale?: number; visible?: boolean } | null = null;
  // Symbol TEXTS (see `ReelsSymbolTextState`). `baseSkin` is what
  // `symbolData.skin` reads back: the real symbol id, never a virtual one.
  private baseSkin = 0;
  private cellTexts: string[] = [];
  private textLayer: PIXI.Container | null = null;
  // Per slot: a holder carrying the offset + fit scale, and the Text itself
  // (what FlowState tweens, so a tween never fights the fit).
  private textHolders: Array<PIXI.Container | null> = [];
  private textObjects: Array<PIXI.Text | null> = [];

  constructor() {
    super();
    this.sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
    this.addChild(this.sprite);
    this.installSkinCodec();
  }

  // =======================================================================
  // Symbol texts
  // =======================================================================

  private get symbolTextState(): ReelsSymbolTextState | null {
    const service = (this as unknown as { _service?: { __orcaSymbolTexts?: ReelsSymbolTextState } })._service;
    return service?.__orcaSymbolTexts ?? null;
  }

  /**
   * Route every write of `symbolData.skin` through `writeSkin`, which decodes
   * a virtual skin into the symbol it stands for plus its texts. Reads return
   * the REAL symbol id, so nothing else in this file (or the package) ever
   * sees a virtual id.
   */
  private installSkinCodec(): void {
    const data = this.symbolData as unknown as { skin?: unknown } | undefined;
    if (!data) return;
    this.baseSkin = typeof data.skin === 'number' && Number.isFinite(data.skin) ? data.skin : 0;
    Object.defineProperty(data, 'skin', {
      configurable: true,
      enumerable: true,
      get: () => this.baseSkin,
      set: (value: unknown) => this.writeSkin(value),
    });
  }

  private writeSkin(value: unknown): void {
    const raw = typeof value === 'number' ? value : Number(value);
    const state = this.symbolTextState;
    const decoded = state && Number.isFinite(raw) ? state.decode(raw) : null;
    if (decoded) {
      this.baseSkin = decoded.symbol;
      this.setCellTexts(decoded.texts);
      return;
    }
    const next = Number.isFinite(raw) ? raw : 0;
    // Re-asserting the SAME symbol on a resting, visible cell (a resize, a
    // texture refresh) keeps its text; any other plain write is a different
    // strip entry, so the text goes.
    const keep = next === this.baseSkin
      && this.parentReelData?.spinning !== true
      && this.symbolData?.onScreen === true;
    this.baseSkin = next;
    if (!keep && this.hasAnyCellText()) this.setCellTexts([]);
  }

  private hasAnyCellText(): boolean {
    for (let i = 0; i < this.textObjects.length || i < this.cellTexts.length; i += 1) {
      if (this.getCellText(i) !== '') return true;
    }
    return false;
  }

  /** The text a slot shows now (a count-up writing the Text directly included). */
  public getCellText(slot: number): string {
    const obj = this.textObjects[slot];
    if (obj && !obj.destroyed) return obj.text;
    return this.cellTexts[slot] ?? '';
  }

  public getCellTexts(): string[] {
    const count = this.symbolTextState?.slotCount ?? 0;
    return Array.from({ length: count }, (_, i) => this.getCellText(i));
  }

  public setCellText(slot: number, text: string): void {
    const next = this.getCellTexts();
    if (slot < 0 || slot >= next.length) return;
    next[slot] = text;
    this.setCellTexts(next);
  }

  /** Replace every slot's text; a changed text starts from a clean transform. */
  public setCellTexts(texts: readonly (string | null | undefined)[]): void {
    const count = this.symbolTextState?.slotCount ?? 0;
    const next = Array.from({ length: count }, (_, i) => String(texts[i] ?? ''));
    for (let i = 0; i < count; i += 1) {
      const obj = this.textObjects[i];
      if (obj && !obj.destroyed && obj.text !== next[i]) {
        obj.alpha = 1;
        obj.scale.set(1, 1);
        obj.rotation = 0;
        obj.position.set(0, 0);
      }
    }
    this.cellTexts = next;
    this.renderCellTexts();
  }

  /** The live Text of a slot (built on demand) — the target FlowState tweens. */
  public getCellTextObject(slot: number): PIXI.Text | null {
    const state = this.symbolTextState;
    if (!state || slot < 0 || slot >= state.slotCount) return null;
    const existing = this.textObjects[slot];
    if (existing && !existing.destroyed) return existing;
    this.cellTexts = this.getCellTexts();
    this.renderCellTexts(slot);
    const obj = this.textObjects[slot];
    return obj && !obj.destroyed ? obj : null;
  }

  /**
   * This view's symbol as a strip value that keeps its texts: a virtual skin
   * when any slot shows text, the plain symbol otherwise. `spinReelsToGrid`
   * builds the board it spins AWAY from out of these, so values scroll off
   * with their symbols.
   */
  public encodedSkin(): number {
    const state = this.symbolTextState;
    if (!state || !this.hasAnyCellText()) return this.baseSkin;
    return state.encode(this.baseSkin, this.getCellTexts());
  }

  /** Re-apply the text styles (a slot's font finished loading). */
  public refreshCellTextStyles(): void {
    const state = this.symbolTextState;
    if (!state) return;
    for (let i = 0; i < this.textObjects.length; i += 1) {
      const obj = this.textObjects[i];
      if (!obj || obj.destroyed || !state.slots[i]) continue;
      obj.style = buildSymbolTextStyle(state.slots[i], state.families[i] ?? 'sans-serif');
      this.fitCellText(i);
    }
  }

  /**
   * Show / hide / lay out the slot texts. `forceSlot` builds that slot's Text
   * even while it is empty, for a FlowState caller that wants to write it.
   */
  private renderCellTexts(forceSlot = -1): void {
    const state = this.symbolTextState;
    if (!state || state.slotCount === 0) {
      if (this.textLayer) this.textLayer.visible = false;
      return;
    }
    for (let i = 0; i < state.slotCount; i += 1) {
      const text = this.cellTexts[i] ?? '';
      const existing = this.textObjects[i];
      if (!existing && text === '' && i !== forceSlot) continue;
      const obj = existing && !existing.destroyed ? existing : this.buildCellText(i, state);
      if (obj.text !== text) obj.text = text;
      const holder = this.textHolders[i];
      if (holder) holder.visible = state.appliesTo(i, this.baseSkin);
      this.fitCellText(i);
    }
    if (this.textLayer) this.textLayer.visible = true;
  }

  private buildCellText(slot: number, state: ReelsSymbolTextState): PIXI.Text {
    if (!this.textLayer) {
      this.textLayer = new PIXI.Container();
      this.textLayer.label = 'symbolTexts';
      this.addChild(this.textLayer);
      // Set AFTER parenting: the zIndex setter is what switches the view to
      // sorted children, keeping the texts above a spine built later.
      this.textLayer.zIndex = SYMBOL_TEXT_LAYER_ZINDEX;
    }
    const config = state.slots[slot];
    const holder = new PIXI.Container();
    holder.position.set(config.offsetX, config.offsetY);
    const text = new PIXI.Text({ text: '', style: buildSymbolTextStyle(config, state.families[slot] ?? 'sans-serif') });
    text.anchor.set(config.anchorX, config.anchorY);
    holder.addChild(text);
    this.textLayer.addChild(holder);
    this.textHolders[slot] = holder;
    this.textObjects[slot] = text;
    return text;
  }

  /** Scale the holder down so the text fits the slot's `maxWidth`. */
  private fitCellText(slot: number): void {
    const state = this.symbolTextState;
    const holder = this.textHolders[slot];
    const obj = this.textObjects[slot];
    if (!state || !holder || !obj || obj.destroyed) return;
    const maxWidth = state.slots[slot]?.maxWidth ?? 0;
    let fit = 1;
    if (maxWidth > 0) {
      const natural = obj.width / Math.max(0.0001, Math.abs(obj.scale.x) || 1);
      if (natural > maxWidth) fit = maxWidth / natural;
    }
    holder.scale.set(fit, fit);
  }

  public static configureSymbolVisualResolver(resolver: (skinIndex: number) => { texture: PIXI.Texture; hasSprite: boolean; hasSpine: boolean; skin?: string; spineSkeletonPath?: string; winAnimation?: string; landAnimation?: string; landAnimationEnabled?: boolean; landAnimationLoop?: boolean; symbolScale?: number; drawPriority?: number }): void {
    FlowstateInjectedSymbolView.symbolVisualResolver = resolver;
  }

  /**
   * Per-symbol-INDEX animsprite frame provider (sprite / legacy
   * `animatedSprite` mode). Installed by `buildFlowstateReelsDisplay`, which
   * owns the index→frames registry so every symbol VIEW currently showing a
   * given symbol index shares ONE decoded frame list.
   *
   * `frames === null` means "not resolved yet" — the provider kicks the async
   * resolve as a side effect, so `playSymbolAnimation` returns false and the
   * caller can simply re-fire. Same static-resolver convention (and the same
   * last-built-node-wins caveat) as `symbolVisualResolver` above.
   */
  private static animspriteFrameProvider: (skinIndex: number) => { path: string; frames: PIXI.Texture[] | null; animationSpeed: number } | null = () => null;

  public static configureAnimspriteFrameProvider(
    provider: (skinIndex: number) => { path: string; frames: PIXI.Texture[] | null; animationSpeed: number } | null,
  ): void {
    FlowstateInjectedSymbolView.animspriteFrameProvider = provider;
  }

  /**
   * Toggle the live vertical spin-blur `BlurFilter` on the displayed static
   * sprite. Called per-tick (only for MOVING reels) by the spin-blur ticker.
   * No-op while the spine is shown (sprite hidden during a land/win) so the
   * landed spine reveal is never clobbered.
   */
  public setSpinBlurState(blurred: boolean, strength: number): void {
    if (!this.sprite.visible) {
      if (this.spinBlurActive || this.sprite.filters) {
        this.sprite.filters = null;
        this.spinBlurActive = false;
      }
      return;
    }
    const wantBlur = blurred && strength > 0;
    if (wantBlur) {
      if (!this.spinBlurFilter) {
        // `strengthX`/`strengthY` — Pixi 8.3 deprecated `blurX`/`blurY`.
        this.spinBlurFilter = new BlurFilter({ strengthX: 0, strengthY: strength, quality: 4 });
      }
      this.spinBlurFilter.strengthY = strength;
      if (!Array.isArray(this.sprite.filters) || this.sprite.filters[0] !== this.spinBlurFilter) {
        this.sprite.filters = [this.spinBlurFilter];
      }
      this.spinBlurActive = true;
    } else if (this.spinBlurActive || this.sprite.filters) {
      this.sprite.filters = null;
      this.spinBlurActive = false;
    }
  }

  /** Detach + destroy the spin-blur filter (teardown). */
  public clearSpinBlur(): void {
    if (this.sprite.filters) this.sprite.filters = null;
    if (this.spinBlurFilter) {
      try { this.spinBlurFilter.destroy(); } catch { /* ignore */ }
      this.spinBlurFilter = null;
    }
    this.spinBlurActive = false;
  }

  public setStaticSkin(): void {
    this.applySkin(false);
  }

  public setAnimationSkin(): void {
    this.applySkin(true);
  }

  // Win-presentation path: a GR setStaticSkin() between reel-stop and win
  // (force-display / snapshot) re-bakes the static sprite and hides the live
  // spine, so the win would otherwise play on a HIDDEN spine. Re-reveal the
  // live spine and hide the baked static sprite so the win is actually seen.
  // No-op when no spine can be built — never hide the sprite with nothing in
  // its place.
  public revealSpineForWin(): void {
    const spine = this.ensureSpineForWin();
    if (!spine) return;
    spine.visible = true;
    this.sprite.visible = false;
  }

  /**
   * Build (or reuse) this symbol's hosted `Spine` OUTSIDE the reel-stop path.
   * Symbols only hold a live spine while a land animation is playing, so by
   * win-presentation time most cells are back on the baked static sprite with
   * no spine child at all — the winline has to be able to build one on demand.
   */
  public ensureSpineForWin(): Spine | null {
    const visual = this.readVisual();
    if (!visual?.hasSpine || !visual.spineSkeletonPath) return this.spine;
    const skinName = visual.skin ?? null;
    // The hosted `Spine` is memoised across spins and ONLY `ensureSpine`
    // re-applies the per-symbol skin. A cell whose land animation is disabled
    // never routes through `applySkin`'s spine branch, so returning the cached
    // spine unconditionally left it wearing the skin from the FIRST win —
    // every later win at that cell then replayed the previous symbol.
    if (this.spine
      && this.spineSkeletonPath === visual.spineSkeletonPath
      && this.spineSkinName === skinName) {
      return this.spine;
    }
    const frame = findAncestorReelFrameTransform(this) ?? this.symbolSettings.frameTransfrom;
    return this.ensureSpine(visual.spineSkeletonPath, skinName, frame);
  }

  /**
   * Build-on-demand + play `animationName` on `trackIndex`, waking the spine
   * for the duration of that track only. Returns whether playback started.
   */
  public playSpineTrack(trackIndex: number, animationName: string, loop: boolean): boolean {
    const spine = this.ensureSpineForWin();
    if (!spine) return false;
    try {
      if (!spine.skeleton.data.findAnimation(animationName)) return false;
    } catch {
      return false;
    }
    this.revealSpineForWin();
    return this.startSpineTrack(spine, trackIndex, animationName, loop);
  }

  // =======================================================================
  // FlowState per-symbol getters / setters
  // =======================================================================
  // Public surface consumed by the per-reel / per-symbol FlowState methods.
  // Every entry point is defensive: it warns with the `[FlowState/reels]`
  // prefix and no-ops rather than throwing, so a bad author value can never
  // abort a flow walk or the reels build.

  /**
   * Swap this view to a different symbol INDEX. `symbolData.skin` is the
   * NUMBER index into the node's `symbolEntries[]` (NOT the spine skin
   * string) — the shared visual resolver normalizes it modulo the entry
   * count, so any in-range-ish value resolves.
   */
  public setSymbolIndex(index: number): void {
    if (typeof index !== 'number' || !Number.isFinite(index) || index < 0) {
      console.warn('[FlowState/reels] setSymbolIndex: ignoring invalid index', index);
      return;
    }
    try {
      if (!this.symbolData) {
        console.warn('[FlowState/reels] setSymbolIndex: symbol has no symbolData');
        return;
      }
      this.symbolData.skin = Math.round(index);
      this.setStaticSkin();
      // `applySkin` resets container scale + sprite tint, so re-assert any
      // live visual override rather than silently dropping it.
      if (this.visualOverrideApplied) this.writeVisualOverride(this.visualOverrideApplied);
    } catch (err) {
      console.warn('[FlowState/reels] setSymbolIndex failed', err);
    }
  }

  /**
   * Play an animation on this symbol. Returns whether playback actually
   * started. Branches on the three render modes:
   *   spine          → track 1 (track 0 holds the land animation)
   *   animatedSprite → lazily built `PIXI.AnimatedSprite`
   *   static sprite  → nothing to play (warn + false)
   */
  public playSymbolAnimation(animationName?: string, loop?: boolean): boolean {
    const symbolIndex = this.resolveSymbolIndex();
    const visual = this.readVisual();

    if (visual?.hasSpine && visual.spineSkeletonPath) {
      return this.playSpineSymbolAnimation(visual.spineSkeletonPath, visual.skin ?? null, visual.winAnimation, animationName, loop === true);
    }

    let animsprite: { path: string; frames: PIXI.Texture[] | null; animationSpeed: number } | null = null;
    try {
      animsprite = FlowstateInjectedSymbolView.animspriteFrameProvider(symbolIndex);
    } catch (err) {
      console.warn('[FlowState/reels] playSymbolAnimation: animsprite frame provider failed', err);
    }
    if (animsprite && animsprite.path) {
      if (!animsprite.frames || animsprite.frames.length === 0) {
        // The provider kicked the async frame resolve as a side effect —
        // never block the flow walk waiting for it.
        console.warn(`[FlowState/reels] playSymbolAnimation: animsprite frames for symbol ${symbolIndex} are still resolving`);
        return false;
      }
      return this.playAnimatedSpriteSymbolAnimation(animsprite.path, animsprite.frames, animsprite.animationSpeed, loop === true);
    }

    console.warn(`[FlowState/reels] playSymbolAnimation: symbol ${symbolIndex} is a static sprite; nothing to play`);
    return false;
  }

  /**
   * Stop whatever `playSymbolAnimation` started and put the symbol back to
   * its pre-animation visual state. Spine clears track 1 ONLY (track 0 holds
   * the landed pose); animated sprites stop and reset to frame 0; a static
   * sprite is a no-op.
   */
  public stopSymbolAnimation(): void {
    if (this.spine) {
      this.spineLoopingTracks.delete(1);
      try {
        this.spine.state.setEmptyAnimation(1, 0);
      } catch (err) {
        console.warn('[FlowState/reels] stopSymbolAnimation: spine track clear failed', err);
      }
      // A looping track fires no `complete`, so nothing would have settled it.
      if (this.spineActiveTracks.size === 0 && this.spineLoopingTracks.size === 0) {
        this.settleSpine();
      }
    }
    if (this.animatedSprite) {
      try {
        this.animatedSprite.onComplete = undefined;
        this.animatedSprite.stop();
        this.animatedSprite.gotoAndStop(0);
      } catch (err) {
        console.warn('[FlowState/reels] stopSymbolAnimation: animatedSprite stop failed', err);
      }
      this.animatedSprite.visible = false;
    }
    this.restoreAnimationVisibility();
  }

  /**
   * Apply a transient visual override. `alpha` / `visible` / `scale` act on
   * the symbol CONTAINER; `tint` acts on the inner static sprite (a Container
   * has no tint) and, when present, on the hosted spine. The pre-override
   * values are snapshotted on the FIRST call so `clearVisualOverride` can put
   * them back.
   */
  public applyVisualOverride(o: { alpha?: number; tint?: number; scale?: number; visible?: boolean }): void {
    if (!o || typeof o !== 'object') {
      console.warn('[FlowState/reels] applyVisualOverride: expected an options object', o);
      return;
    }
    if (!this.visualOverrideSnapshot) {
      this.visualOverrideSnapshot = {
        alpha: this.alpha,
        visible: this.visible,
        scaleX: this.scale.x,
        scaleY: this.scale.y,
        spriteTint: typeof this.sprite.tint === 'number' ? this.sprite.tint : 0xffffff,
        spineTint: this.readSpineTint(),
      };
    }
    this.visualOverrideApplied = { ...(this.visualOverrideApplied ?? {}), ...o };
    this.writeVisualOverride(o);
  }

  /** Restore the pre-override visuals and drop the snapshot. Idempotent. */
  public clearVisualOverride(): void {
    const snap = this.visualOverrideSnapshot;
    this.visualOverrideSnapshot = null;
    this.visualOverrideApplied = null;
    if (!snap) return;
    try {
      this.alpha = snap.alpha;
      this.visible = snap.visible;
      this.scale.set(snap.scaleX, snap.scaleY);
      this.sprite.tint = snap.spriteTint;
      // A spine built AFTER the snapshot has no captured tint — reset it to
      // neutral so a cleared override never leaves a stale tint behind.
      this.writeSpineTint(snap.spineTint ?? 0xffffff);
    } catch (err) {
      console.warn('[FlowState/reels] clearVisualOverride failed', err);
    }
  }

  private writeVisualOverride(o: { alpha?: number; tint?: number; scale?: number; visible?: boolean }): void {
    try {
      if (typeof o.alpha === 'number' && Number.isFinite(o.alpha)) {
        this.alpha = Math.max(0, Math.min(1, o.alpha));
      }
      if (typeof o.visible === 'boolean') {
        this.visible = o.visible;
      }
      if (typeof o.scale === 'number' && Number.isFinite(o.scale) && o.scale > 0) {
        this.scale.set(o.scale, o.scale);
      }
      if (typeof o.tint === 'number' && Number.isFinite(o.tint)) {
        const tint = (o.tint >>> 0) & 0xffffff;
        this.sprite.tint = tint;
        this.writeSpineTint(tint);
      }
    } catch (err) {
      console.warn('[FlowState/reels] applyVisualOverride failed', err);
    }
  }

  /** PIXI 8 `Spine` extends `ViewContainer` → `Container`, which carries a
   *  NATIVE `tint` accessor — so unlike pixi-spine 3.1's `SpineBase.tint`
   *  this is always present. The defensive shape is kept so a future runtime
   *  swap degrades to sprite-only tinting instead of throwing. */
  private readSpineTint(): number | null {
    if (!this.spine) return null;
    try {
      const tint = this.spine.tint;
      return typeof tint === 'number' ? tint : null;
    } catch {
      return null;
    }
  }

  private writeSpineTint(tint: number): void {
    if (!this.spine) return;
    try {
      if (typeof this.spine.tint === 'number') {
        this.spine.tint = tint;
      } else {
        console.warn('[FlowState/reels] applyVisualOverride: spine tint unsupported; tinted the static sprite only');
      }
    } catch (err) {
      console.warn('[FlowState/reels] applyVisualOverride: spine tint failed; tinted the static sprite only', err);
    }
  }

  private resolveSymbolIndex(): number {
    const raw = typeof this.symbolData?.skin === 'number' ? this.symbolData.skin : 0;
    return Number.isFinite(raw) ? raw : 0;
  }

  private readVisual(): ReturnType<typeof FlowstateInjectedSymbolView.symbolVisualResolver> | null {
    try {
      return FlowstateInjectedSymbolView.symbolVisualResolver(this.resolveSymbolIndex());
    } catch (err) {
      console.warn('[FlowState/reels] playSymbolAnimation: symbol visual resolve failed', err);
      return null;
    }
  }

  /**
   * The clamped per-symbol render scale (0.1–3, default 1) for the symbol
   * index this view currently shows.
   *
   * IMPORTANT: this scale is applied to the CHILD display objects (the static
   * sprite, the hosted spine, the hosted animated sprite) and NEVER to `this`.
   * `GCReelView.buildReel` writes `symbol.width = frameTransform.width` and
   * `symbol.scale.y = symbol.scale.x` onto the symbol CONTAINER, which is why
   * `applySkin` defensively resets `this.scale.set(1, 1)` — anything we wrote
   * onto the container would be clobbered (or would fight) with that.
   * It also means cell/frame geometry, reel layout, spacing and the mask are
   * untouched: only the rendered artwork inside the cell changes size.
   */
  private resolveSymbolScale(
    visual?: ReturnType<typeof FlowstateInjectedSymbolView.symbolVisualResolver> | null,
  ): number {
    const resolved = visual === undefined ? this.readVisual() : visual;
    return clampSymbolScale(resolved?.symbolScale);
  }

  private playSpineSymbolAnimation(
    skeletonPath: string,
    skinName: string | null,
    winAnimation: string | undefined,
    requestedName: string | undefined,
    loop: boolean,
  ): boolean {
    let spine = this.spine;
    if (!spine) {
      // The spine child is only built on reel STOP (`setAnimationSkin`);
      // build it on demand so a flow can animate a symbol at any time.
      const parentFrame = findAncestorReelFrameTransform(this);
      const frame = parentFrame ?? this.symbolSettings.frameTransfrom;
      spine = this.ensureSpine(skeletonPath, skinName, frame);
    }
    if (!spine) {
      console.warn('[FlowState/reels] playSymbolAnimation: spine skeleton not loaded yet', skeletonPath);
      return false;
    }

    const hasAnimation = (name: string): boolean => {
      if (!name) return false;
      try {
        return !!spine!.skeleton.data.findAnimation(name);
      } catch {
        return false;
      }
    };
    const requested = typeof requestedName === 'string' ? requestedName.trim() : '';
    const configured = typeof winAnimation === 'string' ? winAnimation.trim() : '';
    const name = hasAnimation(requested)
      ? requested
      : (hasAnimation(configured) ? configured : (hasAnimation('win') ? 'win' : ''));
    if (!name) {
      console.warn('[FlowState/reels] playSymbolAnimation: no matching spine animation', {
        requested,
        winAnimation: configured,
        skeletonPath,
      });
      return false;
    }

    this.captureAnimationVisibility();
    this.revealSpineForWin();
    // Track 1 — track 0 belongs to the land animation and must not be
    // disturbed, so a played animation overlays the landed pose.
    return this.startSpineTrack(spine, 1, name, loop);
  }

  private playAnimatedSpriteSymbolAnimation(
    sourcePath: string,
    frames: PIXI.Texture[],
    animationSpeed: number,
    loop: boolean,
  ): boolean {
    const anim = this.ensureAnimatedSprite(sourcePath, frames);
    if (!anim) return false;
    this.captureAnimationVisibility();
    try {
      anim.animationSpeed = Number.isFinite(animationSpeed) && animationSpeed > 0 ? animationSpeed : 1;
      anim.loop = loop;
      anim.onComplete = loop ? undefined : () => { this.restoreAfterAnimatedSprite(); };
      anim.visible = true;
      this.sprite.visible = false;
      anim.gotoAndPlay(0);
      return true;
    } catch (err) {
      console.warn('[FlowState/reels] playSymbolAnimation: animatedSprite play failed', err);
      return false;
    }
  }

  /**
   * Lazily build (or rebuild on source change) the hosted `PIXI.AnimatedSprite`
   * and size/position it exactly like the static sprite. Mirrors `ensureSpine`.
   */
  private ensureAnimatedSprite(sourcePath: string, frames: PIXI.Texture[]): PIXI.AnimatedSprite | null {
    if (this.animatedSprite && this.animatedSpriteSource !== sourcePath) {
      this.destroyAnimatedSprite();
    }
    if (!this.animatedSprite) {
      if (frames.length === 0) return null;
      try {
        // `autoUpdate` left at its default (true) so `play()` advances on the
        // shared ticker — passing false would require manual `update()` calls
        // and the animation would never move.
        const anim = new PIXI.AnimatedSprite(frames);
        anim.loop = false;
        anim.visible = false;
        this.animatedSprite = anim;
        this.animatedSpriteSource = sourcePath;
        this.addChild(anim);
      } catch (err) {
        console.warn('[FlowState/reels] failed to create AnimatedSprite for symbol', sourcePath, err);
        return null;
      }
    }
    const anim = this.animatedSprite;
    try {
      const parentFrame = findAncestorReelFrameTransform(this);
      const frame = parentFrame ?? this.symbolSettings.frameTransfrom;
      // Same per-symbol scale as `showStaticSprite` — the animsprite REPLACES
      // the static sprite while it plays, so a mismatch here would pop the
      // symbol back to 1x for the duration of the animation.
      const symbolScale = this.resolveSymbolScale();
      anim.width = Math.max(1, frame.width) * symbolScale;
      anim.height = Math.max(1, frame.height) * symbolScale;
      anim.x = -anim.width * 0.5;
      anim.y = -anim.height * 0.5;
    } catch (err) {
      console.warn('[FlowState/reels] AnimatedSprite layout failed', err);
    }
    return anim;
  }

  private destroyAnimatedSprite(): void {
    if (!this.animatedSprite) return;
    try {
      this.animatedSprite.onComplete = undefined;
      this.animatedSprite.stop();
      this.removeChild(this.animatedSprite);
      // `destroy()` WITHOUT `texture`/`textureSource` — the frame textures are
      // shared across every symbol view showing this index.
      this.animatedSprite.destroy();
    } catch {
      // no-op
    }
    this.animatedSprite = null;
    this.animatedSpriteSource = null;
  }

  private restoreAfterAnimatedSprite(): void {
    if (this.animatedSprite) {
      try {
        this.animatedSprite.stop();
        this.animatedSprite.gotoAndStop(0);
      } catch {
        // no-op
      }
      this.animatedSprite.visible = false;
    }
    this.restoreAnimationVisibility();
  }

  private captureAnimationVisibility(): void {
    if (this.preAnimationVisibility) return;
    this.preAnimationVisibility = {
      spriteVisible: this.sprite.visible,
      spineVisible: this.spine ? this.spine.visible : null,
    };
  }

  private restoreAnimationVisibility(): void {
    const snap = this.preAnimationVisibility;
    if (!snap) return;
    this.preAnimationVisibility = null;
    try {
      this.sprite.visible = snap.spriteVisible;
      if (this.spine && snap.spineVisible !== null) this.spine.visible = snap.spineVisible;
    } catch {
      // no-op
    }
  }

  /** Any skin re-application (spin, stop, or a `setSymbolIndex` swap)
   *  SUPERSEDES a flow-driven animation: stop + hide the animated-sprite
   *  child, FREEZE the hosted spine (tracks cleared, back to the setup pose,
   *  no longer auto-updating) and drop the pre-animation visibility snapshot,
   *  because the `applySkin` branches set the correct visual state
   *  themselves. No-op unless something was actually running. */
  private cancelSymbolAnimationForSkinChange(): void {
    if (this.animatedSprite) {
      try {
        this.animatedSprite.onComplete = undefined;
        this.animatedSprite.stop();
        this.animatedSprite.gotoAndStop(0);
      } catch {
        // no-op
      }
      this.animatedSprite.visible = false;
    }
    this.parkSpine();
    this.preAnimationVisibility = null;
  }

  private applySkin(showSpine: boolean): void {
    const rawSymbolSkin = typeof this.symbolData?.skin === 'number'
      ? this.symbolData.skin
      : 0;
    const symbolSkin = Number.isFinite(rawSymbolSkin) ? rawSymbolSkin : 0;
    const visual = FlowstateInjectedSymbolView.symbolVisualResolver(symbolSkin);
    const texture = this.resolveStaticTexture(visual);
    const parentFrame = findAncestorReelFrameTransform(this);
    const frame = parentFrame ?? this.symbolSettings.frameTransfrom;

    this.scale.set(1, 1);
    // Author-preferred DRAW ORDER (presentation-only overlay on the symbol
    // IDs — see `symbolDrawOrder` / `buildSymbolDrawPriorities`). Written on
    // the symbol CONTAINER, whose parent is the reel's `_symbolHolder`; that
    // holder has `sortableChildren` on (`allowZIndexSymbolSorting`), so Pixi
    // re-sorts every render. That survives `GCReelView.triggerCascadeFall`,
    // which force-moves falling symbols to raw child index 0 — and since the
    // cascade also re-calls `setAnimationSkin()` this write is re-asserted
    // there for free. Default (no authored order) is 0 for EVERY symbol,
    // which makes Pixi skip the sort entirely and keeps insertion order.
    //
    // A live winline elevation (`zIndex 1000`) is deliberately NOT stomped:
    // a GR `setStaticSkin()` can land mid-presentation, and the winline owns
    // the restore (it snapshots the pre-elevation zIndex — i.e. the draw
    // priority — and writes it back in `clearLinePresentation`).
    if (this.zIndex < WINLINE_SYMBOL_ELEVATION_ZINDEX) {
      this.zIndex = visual.drawPriority ?? 0;
    }

    // =====================================================================
    // REDUNDANT-REAPPLICATION GUARD (anti-flicker).
    // =====================================================================
    // Everything above this point is a cheap re-assertion and stays
    // UNCONDITIONAL — `scale.set(1, 1)` (undoing `GCReelView.buildReel`'s
    // container write) and the `zIndex` write that `GCReelView.
    // triggerCascadeFall` relies on to fix draw order after it force-moves a
    // falling symbol to raw child index 0.
    //
    // What is guarded is only the DESTRUCTIVE half: `parkSpine()` (clear
    // tracks → setup pose → freeze → hide) followed by either a
    // `state.setAnimation(0, land)` restart (`showSpine`) or a swap back to
    // the baked static (`!showSpine`). When the package re-asserts the SAME
    // cell while that cell's land animation is genuinely still playing,
    // BOTH are pure flicker, so we short-circuit them.
    //
    // Deliberately NOT a blanket "same args ⇒ return" early-out: that would
    // break `setSymbolIndex` (re-runs `applySkin` after mutating
    // `symbolData.skin`), the cascade zIndex re-assert above, and
    // `refreshAllSymbolSkins()` (animsprite first-frame `.then`,
    // `ensureReelSpineDataLoaded`, and the 300-frame bake-retry ticker) —
    // all three of which must still re-resolve textures. The first two
    // CHANGE the cell identity; the third only stands down while a land is
    // genuinely live, and `restoreStaticAfterSpine()` re-resolves the
    // texture when that land settles (correct ordering — a texture that
    // resolved mid-land lands on screen at settle time, not mid-animation).
    const sameCell = this.lastAppliedSymbolSkin === symbolSkin
      && this.lastAppliedSymbolIndex === this.resolveSymbolGridIndex();
    if (this.holdLiveLandAnimation(visual, frame, showSpine, sameCell)) {
      return;
    }

    this.cancelSymbolAnimationForSkinChange();

    // Spine symbol-mode branch. PERF: a Spine is only woken when a land
    // animation will GENUINELY play on an ON-SCREEN cell. Every other state
    // (spinning, landed with no land animation, the off-screen top/bottom pad
    // rows, skeleton not loaded yet) stays on the cheap baked static sprite,
    // which is a render of this same skeleton's setup pose.
    if (visual.hasSpine && visual.spineSkeletonPath) {
      const landName = showSpine ? this.resolveLandAnimationName(visual) : null;
      if (landName && this.isSymbolOnScreen()) {
        const spine = this.ensureSpine(visual.spineSkeletonPath, visual.skin ?? null, frame);
        if (spine) {
          spine.visible = true;
          // Mirror the static path's `showStaticSprite(..., resetTint = true, ...)`.
          // `ensureSpine` MEMOISES the Spine object across spins, so a winline
          // darken written by the winline player's `applyTint` would otherwise
          // survive into the NEXT spin's land — the sprite gets cleaned by
          // `resetTint` but the spine never did, leaving a symbol dark for the
          // duration of its land and then snapping bright when the static
          // returns. An explicit `applyVisualOverride` tint is author-owned and
          // is deliberately NOT cleared here (it is re-asserted elsewhere).
          if (typeof this.visualOverrideApplied?.tint !== 'number') {
            this.writeSpineTint(0xffffff);
          }
          // LAND animation (track 0). Reel-STOPPED path only (showSpine).
          // LOOPING IS AUTHOR-CONTROLLED via the per-symbol `landAnimationLoop`
          // flag and DEFAULTS OFF (absent/false => play ONCE). A one-shot land
          // is watched by `startSpineTrack`, which freezes the spine back to
          // the baked static sprite when it finishes; an explicit
          // `landAnimationLoop === true` holds the spine live until the next
          // skin change. WIN animations still play on track 1 (see
          // playWinAnimation) so a win can overlay the landed state without
          // colliding with it.
          this.startSpineTrack(spine, 0, landName, visual.landAnimationLoop === true);
          this.activeLandAnimation = landName;
          orcaTempDiagOnLandStart(this); // ORCA_TEMP_DIAG
          this.sprite.texture = PIXI.Texture.EMPTY;
          this.sprite.alpha = 0;
          this.sprite.visible = false;
          // Landed: the spine is shown and the sprite hidden — drop any live
          // spin-blur filter so it can't linger on the hidden sprite.
          if (this.sprite.filters) { this.sprite.filters = null; this.spinBlurActive = false; }
          this.drawPlaceholderBackground(frame.width, frame.height, false);
          this.rememberAppliedCell(symbolSkin);
          return;
        }
        // Skeleton not loaded yet → fall through to the static sprite.
      }
    }

    this.showStaticSprite(frame, texture, true, this.resolveSymbolScale(visual));
    this.rememberAppliedCell(symbolSkin);
  }

  /** Record the cell identity the guard at the top of `applySkin` compares
   *  against. Written at the END of every completed `applySkin` pass (both the
   *  spine branch and the static fall-through). */
  private rememberAppliedCell(symbolSkin: number): void {
    this.lastAppliedSymbolSkin = symbolSkin;
    this.lastAppliedSymbolIndex = this.resolveSymbolGridIndex();
  }

  /**
   * `applySkin`'s redundant-reapplication guard. Returns true when it HELD a
   * live land animation, in which case the caller must return immediately
   * without `cancelSymbolAnimationForSkinChange()`.
   *
   * Applies to BOTH `applySkin` forms:
   *  - `showSpine === true` (`setAnimationSkin`) — suppresses a
   *    `parkSpine()` + `startSpineTrack(0, land)` restart-from-t=0.
   *  - `showSpine === false` (`setStaticSkin`) — suppresses a `parkSpine()` +
   *    `showStaticSprite()` swap back to the baked static. This is the one
   *    that matters at reel stop: `setStaticSkin()` has MANY package
   *    producers (`onForceDisplayReel$`, `onReelSetupUpdate$`,
   *    `forceApplyStartPositionChange`, `reelFrameTransform`) plus the
   *    template's own `refreshAllSymbolSkins()`, and any of them landing
   *    inside the ~0.8s `elasticStopDuration` window used to kill the land
   *    animation mid-flight. Skipping `showStaticSprite()` costs nothing
   *    visually — the sprite is already HIDDEN while the spine is live — and
   *    `restoreStaticAfterSpine()` re-resolves the texture at settle time.
   *
   * Never holds when the reel is SPINNING: `GRReelView.beginReelSpin` sets
   * `parentReelData.spinning = true` on every symbol BEFORE its
   * `setAndPosition()`, and a spinning reel must show the cheap blurred
   * static, never a live skeleton. (`injectCurrentDisplay`'s earlier
   * `setAndPosition()` runs before that flag flips, but it is gated on
   * `coreSettings.snapshotInjection` which defaults false and this template
   * never enables — and it is immediately superseded by the post-flag call.)
   */
  private holdLiveLandAnimation(
    visual: ReturnType<typeof FlowstateInjectedSymbolView.symbolVisualResolver>,
    frame: PIXI.Rectangle,
    showSpine: boolean,
    sameCell: boolean,
  ): boolean {
    if (!sameCell) return false;
    if (!visual.hasSpine || !visual.spineSkeletonPath) return false;
    // A flow-driven `playSymbolAnimation` is in flight (track 1 / animsprite):
    // keep the documented "a skin re-application SUPERSEDES it" contract and
    // take the full teardown path.
    if (this.preAnimationVisibility !== null) return false;
    const spine = this.spine;
    if (!spine) return false;
    if (this.spineSkeletonPath !== visual.spineSkeletonPath) return false;
    if (this.spineSkinName !== (visual.skin ?? null)) return false;
    if (!showSpine && this.parentReelData?.spinning === true) return false;
    const landName = this.resolveLandAnimationName(visual);
    if (!landName || !this.isLandTrackLive(landName)) return false;
    // Re-assert the cheap visual state and leave the live spine alone.
    // No `parkSpine()`, no `startSpineTrack()`, no `showStaticSprite()`, and
    // no `isSymbolOnScreen()` re-gate — so a transient
    // `symbolData.onScreen === false` mid-stop can no longer revert a landed
    // symbol to the baked static either.
    this.reassertSpineLayout(frame);
    spine.visible = true;
    this.sprite.visible = false;
    if (this.sprite.filters) { this.sprite.filters = null; this.spinBlurActive = false; }
    return true;
  }

  /** The package-owned grid row this view currently represents
   *  (`symbolData.index`), or null when unreadable. Part of the `applySkin`
   *  guard identity so a `GCReelView.triggerCascadeFall` index reassignment
   *  always counts as a NEW landing (and therefore replays the land
   *  animation) even when the symbol's skin happens to be unchanged. */
  private resolveSymbolGridIndex(): number | null {
    const raw = this.symbolData?.index;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }

  /**
   * Is `landName` GENUINELY still playing on track 0 right now?
   *
   * Only consulted by `applySkin`'s redundant-reapplication guard.
   *  - A LOOPING land is never watched (it never completes) but is very much
   *    live — `spineLoopingTracks` is the authority for it.
   *  - A ONE-SHOT land is live only while its `TrackEntry` is still in
   *    `spineActiveTracks`; once `complete` fires, `settleSpine()` has already
   *    put the baked static back and the guard must NOT short-circuit.
   *  - Track 1 (win / `playSymbolAnimation`) is deliberately never consulted.
   * Fails CLOSED (full teardown path) whenever it can't tell.
   */
  private isLandTrackLive(landName: string): boolean {
    const spine = this.spine;
    if (!spine) return false;
    if (this.activeLandAnimation !== landName) return false;
    if (!spine.autoUpdate || !spine.visible) return false;
    const looping = this.spineLoopingTracks.has(0);
    try {
      const tracks = (spine.state as unknown as { tracks?: unknown[] }).tracks;
      const current = Array.isArray(tracks) ? tracks[0] : undefined;
      if (!current) return false;
      const name = (current as { animation?: { name?: string } }).animation?.name;
      if (typeof name === 'string' && name !== landName) return false;
      return looping || this.spineActiveTracks.has(current);
    } catch {
      return false;
    }
  }

  /** Re-assert the spine transform `layoutSpine` last computed, WITHOUT
   *  re-measuring. `layoutSpine` reads `getLocalBounds()`, which on a
   *  mid-animation skeleton returns the ANIMATED bounds — re-running it during
   *  a live land would recentre against a moving box and visibly jitter the
   *  symbol. Falls back to a real `layoutSpine` when there is no memo yet. */
  private reassertSpineLayout(frame: PIXI.Rectangle): void {
    const spine = this.spine;
    if (!spine) return;
    const memo = this.spineLayoutMemo;
    if (!memo) {
      this.layoutSpine(frame);
      return;
    }
    spine.scale.set(memo.scale, memo.scale);
    spine.position.set(memo.x, memo.y);
  }

  /** The static-sprite half of `applySkin`: size, texture and reveal the baked
   *  sprite (or blank it + show the placeholder when there is no usable
   *  texture). `resetTint` is false when restoring after a spine freeze so a
   *  live winline tint isn't wiped. `symbolScale` is the author's per-symbol
   *  render scale (default 1) — see `resolveSymbolScale`. */
  private showStaticSprite(frame: PIXI.Rectangle, texture: PIXI.Texture | null, resetTint: boolean, symbolScale = 1): void {
    // Width/height are read back from the locals, not from `sprite.width`,
    // because the sprite may currently hold `Texture.EMPTY` (zero-sized) after
    // a spine reveal, which makes the getter NaN.
    //
    // The per-symbol scale multiplies the RENDERED size only; `frame` (the
    // cell) is left alone, so the existing `-w*0.5 / -h*0.5` recentring keeps
    // the (now larger/smaller) artwork centred in an unchanged cell. The
    // placeholder background below is deliberately still drawn at the RAW
    // frame size — it visualises the cell, not the symbol.
    const scale = clampSymbolScale(symbolScale);
    // A SPINE BAKE is drawn at its OWN canvas size, NOT stretched to the cell.
    //
    // `bakeSpineStaticTexture` renders the skeleton at native scale (1) centred
    // in a canvas sized from the NODE-level `symbolWidth`/`symbolHeight`, and
    // `layoutSpine` draws the live spine at that same native scale. `frame`,
    // however, is the PER-REEL rect (`symbolRects[reelIndex]` when
    // `symbolRectMode === 'individual'`). Stretching the bake to `frame` would
    // therefore magnify the static by `frame.width / bakeWidth` while the spine
    // stayed at 1 — a real size POP at every land, on exactly the reels whose
    // rect differs from the node size. Sizing from `texture.orig` keeps the two
    // representations the same magnification on every reel.
    //
    // In `shared` mode (and for every reel that kept the default rect) the bake
    // canvas IS the frame, so this resolves to the identical numbers and the
    // path is a no-op. Authored SPRITE textures are unaffected: they carry no
    // native-scale contract and are still fitted to the cell as before.
    const isSpineBake = !!texture && SPINE_STATIC_BAKED_TEXTURES.has(texture);
    const baseWidth = isSpineBake && texture.orig ? texture.orig.width : frame.width;
    const baseHeight = isSpineBake && texture.orig ? texture.orig.height : frame.height;
    const width = Math.max(1, baseWidth) * scale;
    const height = Math.max(1, baseHeight) * scale;
    this.sprite.width = width;
    this.sprite.height = height;
    this.sprite.x = -width * 0.5;
    this.sprite.y = -height * 0.5;
    if (resetTint) this.sprite.tint = 0xffffff;

    if (texture && isSymbolTextureCandidate(texture)) {
      if (isRenderableTexture(texture)) {
        this.lastRenderableTexture = texture;
      }
      this.sprite.texture = texture;
      this.sprite.alpha = 1;
      this.sprite.visible = true;
      this.drawPlaceholderBackground(frame.width, frame.height, false);
      return;
    }

    this.sprite.texture = PIXI.Texture.EMPTY;
    this.sprite.alpha = 0;
    this.sprite.visible = false;
    this.drawPlaceholderBackground(frame.width, frame.height, true);
  }

  private resolveStaticTexture(
    visual: ReturnType<typeof FlowstateInjectedSymbolView.symbolVisualResolver>,
  ): PIXI.Texture | null {
    const resolved = visual.texture;
    if (isRenderableTexture(resolved)) return resolved;
    return isSymbolTextureCandidate(resolved) ? resolved : this.lastRenderableTexture;
  }

  /**
   * The land animation to play on reel stop, or null when there is genuinely
   * nothing to play. Probed against the CACHED `SkeletonData` so no throwaway
   * `Spine` is constructed just to answer the question.
   */
  private resolveLandAnimationName(
    visual: ReturnType<typeof FlowstateInjectedSymbolView.symbolVisualResolver>,
  ): string | null {
    if (visual.landAnimationEnabled !== true) return null;
    if (!visual.hasSpine || !visual.spineSkeletonPath) return null;
    const landName = typeof visual.landAnimation === 'string' ? visual.landAnimation.trim() : '';
    if (!landName) return null;
    try {
      const data = resolveReelsSpineData(visual.spineSkeletonPath) as
        { findAnimation?: (name: string) => unknown } | null;
      if (!data || typeof data.findAnimation !== 'function') return null;
      return data.findAnimation(landName) ? landName : null;
    } catch {
      return null;
    }
  }

  /**
   * Is this view one of the reel's VISIBLE rows — INCLUDING the pad rows the
   * elastic stop can physically drag into view?
   *
   * Every reel is padded with `topOffset`/`bottomOffset` off-screen symbols
   * (package default 1/1) that normally sit behind the reel mask, so waking a
   * skeleton for them is normally waste. `GRReelView.setAndPosition` refreshes
   * `symbolData.onScreen` immediately before calling `setAnimationSkin()`
   * (`index >= 0 && index <= reelSize - bottomOffset`), but the cascade path
   * (`GCReelView.triggerCascadeFall`) reassigns `symbolData.index` WITHOUT
   * refreshing `onScreen` — so fall back to the same index range the package
   * derives that flag from. Fails OPEN (treats the symbol as visible)
   * whenever it can't tell.
   *
   * OVERSHOOT WIDENING. That flag is evaluated ONCE, at the instant of the
   * stop, and describes the reel's REST layout. `GRReelView.
   * applyReelStopEffect` then immediately displaces EVERY symbol by
   * `inertia * elasticStopIntensity` and `Elastic.easeOut`-tweens it back
   * over `elasticStopDuration`. During that window the pad rows slide INTO
   * the mask — and without this widening they show the baked setup-pose
   * static right next to visible rows showing a live spine at land frame 0,
   * which reads as a per-symbol flicker as the oscillation decays. The reach
   * is derived from the live bounce geometry (see
   * `resolveOvershootRowReach`) and is hard-capped at the pad count, so this
   * can wake at most `topOffset + bottomOffset` extra skeletons per reel
   * (default 1 + 1) for the duration of the land only.
   */
  private isSymbolOnScreen(): boolean {
    const data = this.symbolData;
    if (!data) return true;
    if (data.onScreen === true) return true;
    const reelSize = findAncestorReelSize(this);
    if (reelSize === null) return true;
    const index = typeof data.index === 'number' ? data.index : -1;
    const reach = this.resolveOvershootRowReach();
    return index >= -reach && index < reelSize + reach;
  }

  /**
   * How many PAD rows either side of the visible window the elastic stop can
   * drag into the mask, as a row count.
   *
   * `GRReelView.applyReelStopEffect` passes the live `_speedControl.speed` as
   * `inertia`; `defaultSpinBounceEffect` then does
   * `symbol.y += inertia * elasticStopIntensity` before easing back, so the
   * peak displacement IS `|inertia * elasticStopIntensity|` px (the
   * `Elastic.easeOut` counter-overshoot past the rest position is strictly
   * smaller — its envelope is `amplitude * 2^(-10t)` and the first crossing
   * past the target sits near `t = period/2`, i.e. ~35% of the initial
   * displacement at the default `period = 0.3`). Dividing by `symbolHeight`
   * (`frameTransform.height + symbolVerticalPadding`) converts that to rows.
   *
   * With the template's defaults — profile `reelSpeed 45`,
   * `elasticStopIntensity 0.98`, symbol height 156+ — the displacement is
   * ~44px, i.e. well under one row, so this returns exactly 1 and only the
   * single pad row each side is woken. An author who cranks `reelSpeed` or
   * shrinks the symbol gets a proportionally larger reach, still capped at
   * the pad count because the reel physically owns no other symbols
   * (`_totalSymbolCount = topOffset + bottomOffset + reelSize`).
   *
   * Floor of 1 (when padding exists): the reel mask is drawn
   * `maskPadding` taller than the row stack on each side
   * (`getReelMaskTop`), so the adjacent pad row grazes the mask edge even at
   * rest. Fails to the WIDEST safe value (the pad count) whenever the bounce
   * geometry can't be read, matching `isSymbolOnScreen`'s fail-open contract.
   */
  private resolveOvershootRowReach(): number {
    const ctx = findAncestorReelBounceContext(this);
    if (!ctx) return REELS_DEFAULT_OVERSHOOT_ROW_REACH;
    const maxPad = Math.max(ctx.topOffset, ctx.bottomOffset);
    if (maxPad <= 0) return 0;
    if (!(ctx.symbolHeight > 0)) return maxPad;
    const displacement = ctx.inertia * ctx.intensity;
    if (!(displacement > 0)) {
      // Reel is at rest (e.g. the cascade path, where `_speedControl` has
      // already been reset but `triggerCascadeFall` still displaces symbols
      // by `fallOffset`). Widest safe value.
      return maxPad;
    }
    return Math.max(1, Math.min(maxPad, Math.ceil(displacement / ctx.symbolHeight)));
  }

  /**
   * Lazily build (or rebuild on skeleton change) the hosted `Spine`, apply
   * the per-symbol skin, and size/centre it into the cell frame. Returns
   * null when the skeleton data isn't in the loaded resources yet (caller
   * falls back to the static sprite).
   */
  private ensureSpine(skeletonPath: string, skinName: string | null, frame: PIXI.Rectangle): Spine | null {
    if (this.spine && this.spineSkeletonPath !== skeletonPath) {
      this.destroySpine();
    }

    if (!this.spine) {
      const spineData = resolveReelsSpineData(skeletonPath);
      if (!spineData) {
        return null;
      }
      try {
        const spine = new Spine(spineData as SkeletonData);
        // Built FROZEN: `startSpineTrack` wakes it only for the duration of a
        // track, so an idle grid never ticks a skeleton on the shared ticker
        // and a spine built purely for a win probe never double-draws over
        // the baked static sprite.
        spine.autoUpdate = false;
        spine.visible = false;
        spine.skeleton.setToSetupPose();
        this.spine = spine;
        this.spineSkeletonPath = skeletonPath;
        this.spineSkinName = null;
        this.addChild(spine);
      } catch (err) {
        console.warn('[FlowState/reels] failed to create Spine for symbol', skeletonPath, err);
        return null;
      }
    }

    if (this.spine && this.spineSkinName !== skinName) {
      this.applySpineSkin(skinName);
      this.spineSkinName = skinName;
    }

    this.layoutSpine(frame);
    return this.spine;
  }

  private applySpineSkin(skinName: string | null): void {
    if (!this.spine) return;
    try {
      this.spine.skeleton.setToSetupPose();
      this.spine.skeleton.setSkinByName(skinName && skinName !== 'default' ? skinName : 'default');
      this.spine.skeleton.setSlotsToSetupPose();
    } catch (err) {
      console.warn(`[FlowState/reels] spine skin "${skinName ?? ''}" not found; using default skin`, err);
      try {
        this.spine.skeleton.setToSetupPose();
      } catch {
        // no-op
      }
    }
  }

  private layoutSpine(frame: PIXI.Rectangle): void {
    if (!this.spine) return;
    // Measure at NATIVE scale so `getLocalBounds()` can never be skewed by a
    // per-symbol scale applied on a previous layout pass.
    this.spine.scale.set(1, 1);
    if (typeof this.spine.update === 'function') {
      this.spine.update(0);
    }
    const bounds = this.spine.getLocalBounds();
    const boundsWidth = bounds.width || 1;
    const boundsHeight = bounds.height || 1;
    // The spine is deliberately NOT fitted to the cell frame: it stays at its
    // NATIVE scale (1) so every symbol renders at the size the artist authored.
    // Fit-scaling divided by each skeleton's own bounding box, so per-symbol
    // bounds variation (a taller skeleton, a stray attachment) produced visibly
    // inconsistent symbol sizes across the reel. The frame only defines the
    // CENTRE point: the skeleton's local bounds box is centred on the cell
    // origin (0,0), matching the sprite which occupies
    // [-w/2, w/2] × [-h/2, h/2].
    //
    // The author's per-symbol scale is the ONE multiplier layered on top of
    // that native scale, and it MUST match what `showStaticSprite` does to the
    // baked static sprite: the static is a render of this same setup pose
    // stretched to `frame.w × frame.h × symbolScale`, and this spine is the
    // same pose at `symbolScale`. If the two ever diverge the win/land reveal
    // (which swaps sprite → live spine) visibly pops. `bounds` is in the
    // spine's own untransformed space, so the recentring offset is scaled by
    // the same factor to stay centred on the cell origin.
    const symbolScale = this.resolveSymbolScale();
    this.spine.scale.set(symbolScale, symbolScale);
    const offsetX = -(bounds.x + boundsWidth / 2) * symbolScale;
    const offsetY = -(bounds.y + boundsHeight / 2) * symbolScale;
    this.spine.position.set(offsetX, offsetY);
    // Memoised for `reassertSpineLayout` — the ONLY safe way to re-apply this
    // transform once a track is running (see that method).
    this.spineLayoutMemo = { scale: symbolScale, x: offsetX, y: offsetY };
  }

  /**
   * Start a spine track and keep the skeleton LIVE only while it runs.
   * A one-shot track is watched via `state.addListener` (the per-`TrackEntry`
   * `listener` field isn't honoured reliably across spine runtimes — same
   * reason `methods/spine.ts` uses the state listener; spine 4.x's
   * `AnimationStateListener` shape is identical to 3.x's, so this survived
   * the pixi-spine → @esotericsoftware/spine-pixi-v8 swap unchanged) and
   * freezes the spine back to the baked static sprite on complete /
   * interrupt / dispose.
   * A LOOPING track never completes, so it is deliberately NOT watched — it
   * holds the spine live until the next skin change or an explicit stop.
   */
  private startSpineTrack(spine: Spine, trackIndex: number, animationName: string, loop: boolean): boolean {
    this.spineTrackStarting = true;
    try {
      spine.autoUpdate = true;
      const entry = spine.state.setAnimation(trackIndex, animationName, loop);
      // A frozen spine still holds the pose it was last rendered with, so
      // apply frame 0 now — otherwise revealing it flashes the stale pose for
      // one frame before the ticker's first update lands.
      if (typeof spine.update === 'function') spine.update(0);
      if (loop) {
        this.spineLoopingTracks.add(trackIndex);
      } else {
        this.spineLoopingTracks.delete(trackIndex);
        this.watchSpineTrack(entry);
      }
      return true;
    } catch (err) {
      console.warn('[FlowState/reels] spine animation failed', { animationName, trackIndex, error: err });
      return false;
    } finally {
      this.spineTrackStarting = false;
    }
  }

  private watchSpineTrack(entry: unknown): void {
    const spine = this.spine;
    if (!entry || !spine) return;
    this.spineActiveTracks.add(entry);
    if (this.spineStateListener) return;
    const listener = {
      complete: (settledEntry: any) => this.onSpineTrackSettled(settledEntry),
      interrupt: (settledEntry: any) => this.onSpineTrackSettled(settledEntry),
      dispose: (settledEntry: any) => this.onSpineTrackSettled(settledEntry),
    };
    this.spineStateListener = listener;
    try {
      spine.state.addListener(listener);
    } catch (err) {
      console.warn('[FlowState/reels] spine track listener attach failed', err);
      this.spineStateListener = null;
    }
  }

  private onSpineTrackSettled(entry: unknown): void {
    if (!this.spineActiveTracks.delete(entry)) return;
    if (this.spineTrackStarting) return;
    if (this.spineActiveTracks.size > 0 || this.spineLoopingTracks.size > 0) return;
    this.settleSpine();
  }

  /** Freeze the spine and put the baked static sprite back on screen. */
  private settleSpine(): void {
    this.parkSpine();
    this.restoreStaticAfterSpine();
    orcaTempDiagOnSettle(this);
  }

  /**
   * Freeze the hosted spine WITHOUT touching the static sprite: detach the
   * track listener FIRST (so `clearTracks`' own dispose events can't re-enter
   * this), clear every track, return to the setup pose the static texture was
   * baked from, stop auto-updating and hide it. The `Spine` instance is KEPT —
   * only a skeleton-path change destroys it.
   */
  private parkSpine(): void {
    const spine = this.spine;
    const listener = this.spineStateListener;
    this.spineStateListener = null;
    this.spineActiveTracks.clear();
    this.spineLoopingTracks.clear();
    // No land is asserted on track 0 any more — `applySkin`'s guard must not
    // treat a parked spine as live.
    this.activeLandAnimation = null;
    if (!spine) return;
    if (listener) {
      try { spine.state.removeListener(listener); } catch { /* no-op */ }
    }
    try { spine.state.clearTracks(); } catch { /* no-op */ }
    try { spine.skeleton.setToSetupPose(); } catch { /* no-op */ }
    spine.autoUpdate = false;
    spine.visible = false;
  }

  /** Re-show the baked static sprite once the spine has been frozen. Keeps the
   *  current tint so a live winline darken/highlight isn't wiped. */
  private restoreStaticAfterSpine(): void {
    // The pre-animation snapshot is superseded — we are deliberately back on
    // the static sprite, and replaying a "spine visible" snapshot would blank
    // the symbol.
    this.preAnimationVisibility = null;
    const visual = this.readVisual();
    const frame = findAncestorReelFrameTransform(this) ?? this.symbolSettings.frameTransfrom;
    const texture = visual ? this.resolveStaticTexture(visual) : this.lastRenderableTexture;
    this.showStaticSprite(frame, texture, false, this.resolveSymbolScale(visual));
  }

  private destroySpine(): void {
    if (!this.spine) return;
    this.parkSpine();
    try {
      this.removeChild(this.spine);
      this.spine.destroy({ children: true });
    } catch {
      // no-op
    }
    this.spine = null;
    this.spineSkeletonPath = null;
    this.spineSkinName = null;
    this.spineLayoutMemo = null;
  }

  private drawPlaceholderBackground(width: number, height: number, visible: boolean): void {
    const symbolAny = this as unknown as { _background?: PIXI.Graphics };
    const background = symbolAny._background;
    if (!background) {
      return;
    }

    const normalizedWidth = Math.max(1, width);
    const normalizedHeight = Math.max(1, height);
    const cornerRadius = Math.max(8, Math.min(normalizedWidth, normalizedHeight) * 0.12);
    background.cacheAsBitmap = false;
    background.clear();
    if (visible) {
      background
        .roundRect(
          -normalizedWidth * 0.5,
          -normalizedHeight * 0.5,
          normalizedWidth,
          normalizedHeight,
          cornerRadius,
        )
        .fill({ color: 0xffffff, alpha: 0.18 });
    } else {
      // Alpha-0 fill, not a bare `rect()`: Pixi 8 derives Graphics bounds from
      // fill/stroke INSTRUCTIONS, so an unfilled path contributes none and the
      // symbol's local bounds would shrink whenever the placeholder hides.
      background
        .rect(-normalizedWidth * 0.5, -normalizedHeight * 0.5, normalizedWidth, normalizedHeight)
        .fill({ color: 0xffffff, alpha: 0 });
    }
    background.cacheAsBitmap = true;
    background.hitArea = new PIXI.Rectangle(-normalizedWidth * 0.5, -normalizedHeight * 0.5, normalizedWidth, normalizedHeight);
  }
}

class FlowstateInjectedReelView extends GCReelView<FlowstateInjectedSymbolView> {
  private visibleMaskHeight: number | null = null;
  private visibleMaskTop = 0;

  constructor(service: FlowstateInjectedReelService, reelSize: number, reelIndex: number) {
    super(FlowstateInjectedSymbolView, service, reelSize, reelIndex);
  }

  public setVisibleMaskBounds(height: number, top: number): void {
    this.visibleMaskHeight = Math.max(1, height);
    this.visibleMaskTop = top;
  }

  public override rebuildMask(): void {
    if (this.visibleMaskHeight === null) {
      super.rebuildMask();
      return;
    }

    const reelViewAny = this as unknown as {
      _viewMask?: PIXI.Container;
      _viewMaskYOffset?: number;
      _symbolHolder?: PIXI.Container;
      _service?: FlowstateInjectedReelService;
    };

    if (reelViewAny._viewMask) {
      this.removeChild(reelViewAny._viewMask);
    }

    const maskTexture = reelViewAny._service?.coreSettings?.viewMaskTexture;
    const maskWidth = Math.max(1, this.frameTransform.width * 4);
    const maskX = -this.frameTransform.width;
    const maskY = this.visibleMaskTop + (reelViewAny._viewMaskYOffset ?? 0);
    let maskDisplay: PIXI.Sprite | PIXI.Graphics;

    if (maskTexture) {
      const textureMask = new PIXI.Sprite(maskTexture);
      textureMask.width = maskWidth;
      textureMask.height = this.visibleMaskHeight;
      textureMask.anchor.set(0.5, 0);
      textureMask.position.set(this.frameTransform.width, maskY);
      maskDisplay = textureMask;
    } else {
      const graphicsMask = new PIXI.Graphics();
      graphicsMask.clear();
      graphicsMask
        .rect(maskX, maskY, maskWidth, this.visibleMaskHeight)
        .fill({ color: 0xFF700B, alpha: 1 })
        .stroke({ width: 2, color: 0x0000FF, alpha: 1 });
      maskDisplay = graphicsMask;
    }

    reelViewAny._viewMask = maskDisplay;
    this.addChild(maskDisplay);
    if (reelViewAny._symbolHolder) {
      reelViewAny._symbolHolder.mask = maskDisplay;
    }
  }
}

// =========================================================================
// Spine skeleton resolution (spine symbol mode)
// =========================================================================
// Parsed reels spine skeleton data, self-healed from the SCOPE-QUALIFIED
// `/assets/<scope>/<path>` URLs by the async `loadSpineData` loader threaded
// in from SceneManager (`loadReelSpineData` → `parseSpineDataFromUrls`). The
// sync `resolveReelsSpineData` below is lookup-only against the AssetManager
// loader resources, which register spine under a SCOPE-QUALIFIED key
// (`core/…` / `skins/<skin>/…`) that the bare candidate set in
// `buildReelSpineLookupCandidates` can't reproduce — so a plain preload is
// NOT enough on its own (the "fixed it but still broken" trap). This cache,
// keyed by the NORMALIZED bare skeleton path (all the sync resolver has),
// bridges that gap, mirroring the standalone spine node's async
// `loadSpineDataForNode` fallback.
const REELS_PARSED_SPINE_CACHE = new Map<string, unknown>();
const REELS_SPINE_LOAD_PROMISES = new Map<string, Promise<unknown | null>>();

function normalizeReelSpinePath(rawPath: string): string {
  return (rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .split('?')[0]
    .split('#')[0]
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

// Kick off (once) the scope-aware async load + parse of a reels spine
// skeleton, populating `REELS_PARSED_SPINE_CACHE` so the sync resolver
// self-heals a lookup miss. De-duped by normalized path; `onLoaded` fires
// after a successful populate so already-stopped reels re-read their skin and
// the pending-bake retry ticker picks up the newly-cached data.
function ensureReelSpineDataLoaded(
  rawPath: string,
  loadSpineData: (skeletonPath: string) => Promise<unknown | null>,
  onLoaded?: () => void,
): void {
  const normalized = normalizeReelSpinePath(rawPath);
  if (!normalized) return;
  if (REELS_PARSED_SPINE_CACHE.has(normalized)) return;
  if (REELS_SPINE_LOAD_PROMISES.has(normalized)) return;

  const promise = loadSpineData(rawPath)
    .then((data) => {
      REELS_SPINE_LOAD_PROMISES.delete(normalized);
      if (data) {
        REELS_PARSED_SPINE_CACHE.set(normalized, data);
        if (onLoaded) {
          try { onLoaded(); } catch { /* refresh is best-effort */ }
        }
      }
      return data;
    })
    .catch((err) => {
      REELS_SPINE_LOAD_PROMISES.delete(normalized);
      console.warn('[FlowState/reels] async spine data load failed', rawPath, err);
      return null;
    });

  REELS_SPINE_LOAD_PROMISES.set(normalized, promise);
}

// Mirrors the loader-resource lookup that `SceneManager.resolveSpineData`
// uses (AssetManager → AssetManager.animations). It does NOT file-parse
// `.skel`/`.atlas`
// (that's the editor's approach) and does NOT depend on SceneManager
// instance state (asset-index aliases), so we recreate just the
// path-normalization candidate set here. The shared skeleton asset is
// asset-synced (AssetReferenceScanner ASSET_PROPERTY_PATHS.reels covers
// `sharedSpineAnimation`), so it should already be in the loaded resources
// by the time a reel stops — callers must still guard the not-yet-loaded
// case (null return).
//
// PIXI 8: there is NO third `PIXI.Loader.shared.resources[key].spineData`
// probe any more — `Loader` was deleted in v8, so the v6 call was a
// guaranteed `undefined.shared` TypeError, not a fallback. Its job (reading
// the SCOPE-QUALIFIED preload registration) is done by the async
// `loadSpineData` loader threaded in from SceneManager, whose
// `findPreloadedSpineData` is the ported replacement.
function buildReelSpineLookupCandidates(rawPath: string): string[] {
  const candidates: string[] = [];
  const add = (value: string | undefined): void => {
    if (!value) return;
    const normalized = value.trim();
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };
  const normalized = (rawPath || '').trim().replace(/\\/g, '/');
  if (!normalized) return candidates;
  const withoutQuery = normalized.split('?')[0].split('#')[0];
  const withoutDotPrefix = withoutQuery.replace(/^\.\//, '');
  const withoutLeadingSlash = withoutDotPrefix.replace(/^\/+/, '');
  add(normalized);
  add(withoutQuery);
  add(withoutDotPrefix);
  add(withoutLeadingSlash);
  const staticAssetsMatch = withoutLeadingSlash.match(/^static\/assets\/[^/]+\/(.+)$/i);
  if (staticAssetsMatch?.[1]) add(staticAssetsMatch[1]);
  const assetsMatch = withoutLeadingSlash.match(/^assets\/[^/]+\/(.+)$/i);
  if (assetsMatch?.[1]) add(assetsMatch[1]);
  const base = withoutLeadingSlash.split('/').pop() ?? '';
  add(base);
  add(base.replace(/\.[^.]+$/, ''));
  return candidates;
}

function resolveReelsSpineData(rawPath: string): unknown | null {
  // Async-parsed cache first: populated (scope-correct) by
  // ensureReelSpineDataLoaded when the AssetManager lookup below would miss
  // the scope-qualified preload registration. This is what makes a
  // spine-mode reels resolve at runtime (the editor is immune — it loads
  // spine file-direct via readFileBase64).
  const normalizedRaw = normalizeReelSpinePath(rawPath);
  if (normalizedRaw) {
    const parsed = REELS_PARSED_SPINE_CACHE.get(normalizedRaw);
    if (parsed) return parsed;
  }

  const candidates = buildReelSpineLookupCandidates(rawPath);
  const assetManager = AssetManager as unknown as {
    getSpineResourceData?: (name: string) => unknown;
    animations?: Record<string, unknown>;
  };
  for (const key of candidates) {
    if (!key) continue;
    try {
      const fromAssetManager = assetManager.getSpineResourceData?.(key);
      if (fromAssetManager) return fromAssetManager;
    } catch {
      // Keep trying fallback key formats.
    }
    const fromAnimations = assetManager.animations?.[key];
    if (fromAnimations) return fromAnimations;
  }
  return null;
}

function findAncestorReelFrameTransform(displayObject: PIXI.Container | null | undefined): PIXI.Rectangle | null {
  let current = displayObject?.parent ?? null;

  while (current) {
    const reelFrameTransform = (
      current as {
        frameTransform?: PIXI.Rectangle;
        _reelFrameTransform?: PIXI.Rectangle;
      }
    ).frameTransform ?? (
      current as {
        frameTransform?: PIXI.Rectangle;
        _reelFrameTransform?: PIXI.Rectangle;
      }
    )._reelFrameTransform;
    if (reelFrameTransform instanceof PIXI.Rectangle) {
      return reelFrameTransform;
    }
    current = current.parent;
  }

  return null;
}

/** Nearest ancestor reel view's VISIBLE row count (`GRReelView.reelSize`), or
 *  null when the symbol isn't parented under one yet. */
function findAncestorReelSize(displayObject: PIXI.Container | null | undefined): number | null {
  let current = displayObject?.parent ?? null;

  while (current) {
    const size = (current as { reelSize?: number }).reelSize;
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
      return Math.round(size);
    }
    current = current.parent;
  }

  return null;
}

/**
 * Elastic-stop geometry read off the nearest ancestor reel view, for
 * `FlowstateInjectedSymbolView.resolveOvershootRowReach`.
 *
 * `inertia` is `GRReelView._speedControl.speed` — the SAME value the package
 * passes to `applyReelStopEffect` as the bounce inertia. It is still live at
 * the moment `setAndPosition(true)` runs, because `movementUpdate` only calls
 * `_speedControl.reset()` AFTER `applyReelStopEffect`. Reached through the
 * private field exactly like the spin-blur ticker already does; everything
 * else comes off public getters (`reelSize`, `symbolHeight`) or the service's
 * public `coreSettings` / `reelSettings`. Returns null when there is no reel
 * ancestor (caller fails open).
 */
function findAncestorReelBounceContext(displayObject: PIXI.Container | null | undefined): {
  inertia: number;
  intensity: number;
  symbolHeight: number;
  topOffset: number;
  bottomOffset: number;
} | null {
  let current = displayObject?.parent ?? null;

  while (current) {
    const reel = current as {
      reelSize?: number;
      symbolHeight?: number;
      _speedControl?: { speed?: number };
      _service?: {
        coreSettings?: { topOffset?: number; bottomOffset?: number };
        reelSettings?: { bounceSettings?: { elasticStopIntensity?: number } };
      };
    };
    if (typeof reel.reelSize === 'number' && Number.isFinite(reel.reelSize) && reel.reelSize > 0) {
      const core = reel._service?.coreSettings;
      const bounceIntensity = reel._service?.reelSettings?.bounceSettings?.elasticStopIntensity;
      const speed = reel._speedControl?.speed;
      const height = reel.symbolHeight;
      return {
        inertia: typeof speed === 'number' && Number.isFinite(speed) ? Math.abs(speed) : 0,
        intensity: typeof bounceIntensity === 'number' && Number.isFinite(bounceIntensity)
          ? Math.abs(bounceIntensity)
          : 0,
        symbolHeight: typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : 0,
        topOffset: typeof core?.topOffset === 'number' && Number.isFinite(core.topOffset)
          ? Math.max(0, Math.round(core.topOffset))
          : REELS_DEFAULT_OVERSHOOT_ROW_REACH,
        bottomOffset: typeof core?.bottomOffset === 'number' && Number.isFinite(core.bottomOffset)
          ? Math.max(0, Math.round(core.bottomOffset))
          : REELS_DEFAULT_OVERSHOOT_ROW_REACH,
      };
    }
    current = current.parent;
  }

  return null;
}

function syncReelSymbolFrame(reelView: FlowstateInjectedReelView, frame: PIXI.Rectangle, maskHeight: number, maskTop: number): void {
  reelView.setVisibleMaskBounds(maskHeight, maskTop);
  reelView.reelFrameTransform = frame;
  reelView.rebuildMask();

  for (const symbol of reelView.symbols) {
    symbol.x = frame.width * 0.5;
    const symbolAny = symbol as unknown as { _background?: PIXI.Graphics };
    if (symbolAny._background) {
      symbolAny._background.cacheAsBitmap = true;
      symbolAny._background.hitArea = new PIXI.Rectangle(-frame.width * 0.5, -frame.height * 0.5, frame.width, frame.height);
    }
    symbol.setStaticSkin();
  }
}

function getReelMaskTop(symbolSpacingY: number, maskPadding: number): number {
  return (symbolSpacingY * 0.5) - maskPadding;
}

// =========================================================================
// Shared reel-cell resolution
// =========================================================================
// The reel strip SCROLLS, so `reelView.symbols[rowIndex]` is NOT the symbol
// view currently displayed in visible row `rowIndex` — the only correct
// mapping is a nearest-Y search against the row's rest-Y. These two helpers
// are the SINGLE implementation of that mapping: both the winline player
// (`createFlowstateReelsWinlinePlayer`) and the `_flowstateResolveSymbolCell`
// handle attached to the reels root call them, so per-cell FlowState
// getters/setters and the win presentation can never disagree about which
// view a given cell maps to.

/** reelView-local Y of the row centre at rest (matches `buildInitialDisplayMap` strip layout). */
function getReelRowCenterY(geom: FlowstateReelGeometry, rowIndex: number): number {
  return geom.maskTop + geom.maskPadding + (rowIndex + 0.5) * geom.symbolHeight + rowIndex * geom.symbolSpacingY;
}

/** Nearest-Y lookup of the symbol view currently occupying a visible cell.
 *  Returns null when the reel has no symbols or nothing sits within
 *  `symbolHeight * 0.5 + symbolSpacingY` of the row's rest-Y. */
function resolveReelSymbolViewForCell(geom: FlowstateReelGeometry, rowIndex: number): PIXI.Container | null {
  const expectedY = getReelRowCenterY(geom, rowIndex);
  const tolerance = geom.symbolHeight * 0.5 + geom.symbolSpacingY;
  const reelView = geom.reelView as PIXI.Container & { symbols?: PIXI.Container[] };
  const symbols = Array.isArray(reelView.symbols) ? reelView.symbols : null;
  if (!symbols) return null;
  let best: PIXI.Container | null = null;
  let bestDist = Infinity;
  for (const sym of symbols) {
    if (!sym || typeof (sym as any).y !== 'number') continue;
    const dist = Math.abs((sym as any).y - expectedY);
    if (dist < bestDist) {
      bestDist = dist;
      best = sym;
    }
  }
  return bestDist <= tolerance ? best : null;
}

// =========================================================================
// Animsprite first-frame resolution (sprite/animatedSprite mode)
// =========================================================================
// Asynchronously fetches the `.animsprite.json` sidecar and constructs a
// PIXI.Texture from its first frame. Sidecar shape (authored by the editor):
// `{ version, textures: string[], animationSpeed, loop, playing, ... }` —
// one bucket-relative PNG path per frame; the entire image IS the frame (no
// atlas sub-rects). BOTH the descriptor path AND its `textures[]` frame refs
// are BARE bucket-relative refs (e.g. `1.png`, `Spine/x.png`) and must be
// resolved through the SAME scope-aware resolver the caller threads in
// (`SceneManager.toAbsoluteSceneAssetUrl(ref, origin)`), which yields the
// scope-qualified `/assets/<scope>/<R>` URL every other reels/scene texture
// uses. Resolving against `window.location.href` alone (page root, no
// `<scope>` segment) 404s and the symbol renders blank. Returns null on any
// failure. Cached by the resolved (scope-qualified) descriptor URL so repeat
// lookups are cheap AND a core scene's descriptor never collides with a
// same-named skin scene's.
const ANIMSPRITE_FIRST_FRAME_CACHE = new Map<string, Promise<PIXI.Texture | null>>();
// Full frame LIST cache (FlowState `playSymbolAnimation` only). Deliberately
// separate from the first-frame cache above so the BUILD path still issues
// exactly ONE image request per descriptor — the remaining frames are only
// fetched when a flow actually asks a symbol to animate.
const ANIMSPRITE_FRAMES_CACHE = new Map<string, Promise<PIXI.Texture[]>>();
// Raw `textures[]` refs from the descriptor, shared by both resolvers above so
// the descriptor JSON is fetched once. Entries are index-preserving: a
// non-string / blank entry becomes '' rather than being dropped, so
// `refs[0]` keeps its exact historical first-frame meaning.
const ANIMSPRITE_FRAME_REFS_CACHE = new Map<string, Promise<string[]>>();
// Descriptor `animationSpeed`, populated as a side effect of the refs fetch
// and read synchronously once that promise has settled.
const ANIMSPRITE_ANIMATION_SPEED = new Map<string, number>();

function resolveAnimspriteFrameRefs(
  path: string,
  resolveAssetUrl: (ref: string) => string,
): Promise<string[]> {
  const descriptorUrl = resolveAssetUrl(path);
  const cached = ANIMSPRITE_FRAME_REFS_CACHE.get(descriptorUrl);
  if (cached) return cached;

  const promise = (async (): Promise<string[]> => {
    try {
      const res = await fetch(descriptorUrl);
      if (!res.ok) return [];
      const json = await res.json() as { textures?: unknown; animationSpeed?: unknown };
      if (typeof json.animationSpeed === 'number' && Number.isFinite(json.animationSpeed) && json.animationSpeed > 0) {
        ANIMSPRITE_ANIMATION_SPEED.set(descriptorUrl, json.animationSpeed);
      }
      const textures = Array.isArray(json.textures) ? json.textures : null;
      if (!textures) return [];
      return textures.map((ref) => (typeof ref === 'string' ? ref.trim() : ''));
    } catch (err) {
      console.warn('[FlowState/reels] animsprite descriptor resolve failed', path, err);
      return [];
    }
  })();
  ANIMSPRITE_FRAME_REFS_CACHE.set(descriptorUrl, promise);
  return promise;
}

/** Descriptor `animationSpeed` (1 when unknown / not yet fetched). */
function getAnimspriteAnimationSpeed(path: string, resolveAssetUrl: (ref: string) => string): number {
  if (!path) return 1;
  const speed = ANIMSPRITE_ANIMATION_SPEED.get(resolveAssetUrl(path));
  return typeof speed === 'number' && speed > 0 ? speed : 1;
}

/** Build a `PIXI.Texture` from a resolved frame URL, awaiting decode. Null on
 *  any failure (identical semantics to the historical first-frame path).
 *
 *  PIXI 8: `BaseTexture` is gone and `Texture.from(url)` is a synchronous
 *  CACHE LOOKUP that never fetches, so the fetch must go through `Assets`
 *  (the same route `SceneManager.loadSpritesheetPageTexture` takes). A
 *  resolved-but-pixel-less texture is still rejected, so a 404 frame keeps
 *  returning null rather than silently painting a 1x1. */
function loadAnimspriteFrameTexture(imageUrl: string): Promise<PIXI.Texture | null> {
  return (async (): Promise<PIXI.Texture | null> => {
    try {
      const texture = await PIXI.Assets.load<PIXI.Texture>(imageUrl);
      if (!isTextureSourceReady(texture?.source)) {
        console.warn('[FlowState/reels] animsprite frame resolved without pixels', imageUrl);
        return null;
      }
      return texture;
    } catch (err) {
      console.warn('[FlowState/reels] animsprite frame load failed', imageUrl, err);
      return null;
    }
  })();
}

/**
 * Resolve EVERY frame of an `.animsprite.json` into decoded textures, for
 * FlowState-driven per-symbol animation playback. NOT called from the build
 * path — the build still only ever resolves frame 0 (below). Cached the same
 * scope-qualified way. Returns `[]` on any failure.
 */
function resolveAnimspriteFrames(
  path: string,
  resolveAssetUrl: (ref: string) => string,
): Promise<PIXI.Texture[]> {
  if (!path) return Promise.resolve([]);
  const descriptorUrl = resolveAssetUrl(path);
  const cached = ANIMSPRITE_FRAMES_CACHE.get(descriptorUrl);
  if (cached) return cached;

  const promise = (async (): Promise<PIXI.Texture[]> => {
    try {
      const refs = await resolveAnimspriteFrameRefs(path, resolveAssetUrl);
      const frameRefs = refs.filter((ref) => ref.length > 0);
      if (frameRefs.length === 0) return [];
      const loaded = await Promise.all(frameRefs.map((ref) => loadAnimspriteFrameTexture(resolveAssetUrl(ref))));
      return loaded.filter((tex): tex is PIXI.Texture => !!tex);
    } catch (err) {
      console.warn('[FlowState/reels] animsprite frames resolve failed', path, err);
      return [];
    }
  })();
  ANIMSPRITE_FRAMES_CACHE.set(descriptorUrl, promise);
  return promise;
}

function resolveAnimspriteFirstFrame(
  path: string,
  resolveAssetUrl: (ref: string) => string,
): Promise<PIXI.Texture | null> {
  if (!path) return Promise.resolve(null);
  // Key the cache by the SCOPE-QUALIFIED descriptor URL (not the bare ref) so
  // a core scene and a skin scene sharing a descriptor basename stay distinct.
  const descriptorUrl = resolveAssetUrl(path);
  const cached = ANIMSPRITE_FIRST_FRAME_CACHE.get(descriptorUrl);
  if (cached) return cached;

  const promise = (async (): Promise<PIXI.Texture | null> => {
    try {
      const refs = await resolveAnimspriteFrameRefs(path, resolveAssetUrl);
      const firstFrameRef = refs.length > 0 ? refs[0] : '';
      if (!firstFrameRef) return null;
      // `textures[]` entries are BARE bucket-relative refs (same shape as the
      // descriptor path). Resolve them through the SAME scope-aware resolver so
      // the frame URL is `/assets/<scope>/<R>` — matching
      // `SceneManager.toAbsoluteSceneAssetUrl`, NOT page-relative to
      // `window.location.href` (which would drop the `<scope>` segment and 404).
      return await loadAnimspriteFrameTexture(resolveAssetUrl(firstFrameRef));
    } catch (err) {
      console.warn('[FlowState/reels] animsprite first-frame resolve failed', path, err);
      return null;
    }
  })();
  ANIMSPRITE_FIRST_FRAME_CACHE.set(descriptorUrl, promise);
  return promise;
}

// =========================================================================
// Bake resolution (supersampling)
// =========================================================================
// RenderTexture bakes (spine resting pose) are supersampled so the static
// sprite stays crisp when the device renderer runs at 1x. Mirrors the editor
// preview (`Pixi8Adapter.reelsBakeEffectiveResolution`): take the renderer
// resolution (floored at 2), multiply by the supersample factor, and clamp
// to a max. Baked textures use LINEAR scaleMode so the downscale is smooth.
const REELS_BAKE_SUPERSAMPLE = 2;
const REELS_BAKE_MAX_RESOLUTION = 4;
function reelsBakeEffectiveResolution(rendererResolution: number | undefined): number {
  const base = Math.max(rendererResolution || 1, 2);
  return Math.min(REELS_BAKE_MAX_RESOLUTION, base * REELS_BAKE_SUPERSAMPLE);
}

// =========================================================================
// Spine static-pose baking (spine symbol-mode optimisation)
// =========================================================================
// In spine symbol-mode the per-symbol `Spine` is only revealed on reel STOP
// (`setAnimationSkin`) — during idle/spin we show a cheap static `Sprite`.
// Historically spine symbols had no sprite texture for that idle/spin state
// (only an authored `entry.sprite`, often empty), so spinning rendered
// nothing AND the per-reel blur had no texture to blur ("blur doesn't work
// for spine"). This helper bakes the skeleton's RESTING pose (setup pose,
// empty animation) into an in-memory RenderTexture so the idle/spin state
// has a real, blur-able sprite that matches the landed spine. No disk
// writes, no new asset files — purely runtime. Cached (shared across reels
// and symbols) by skeleton path + skin + target frame size. Returns null
// (caller falls back to the authored sprite / empty texture) when the
// renderer or skeleton data isn't available, or on any error — never throws.
const SPINE_STATIC_CACHE = new Map<string, PIXI.Texture>();
// Identity set for textures produced by `bakeSpineStaticTexture`. A bake is a
// render of the skeleton at NATIVE scale (1) centred in a canvas sized from the
// NODE-level `symbolWidth`/`symbolHeight`, so it must be DRAWN at that same
// canvas size to stay 1:1 with the live spine — see `showStaticSprite`. Authored
// sprite textures carry no such constraint and are still fitted to the cell.
// A `WeakSet` so a texture destroyed elsewhere isn't retained by this bookkeeping.
const SPINE_STATIC_BAKED_TEXTURES = new WeakSet<PIXI.Texture>();
let spineBakeNoRendererWarned = false;

// Bump whenever the bake GEOMETRY changes (scale/position/canvas maths below).
// `SPINE_STATIC_CACHE` is module-level and survives a hot reload, so without a
// version token a warm session would keep serving textures baked by the old
// geometry. v2 = native scale (was: fit-to-frame).
const SPINE_STATIC_CACHE_VERSION = 2;

function spineStaticCacheKey(
  skeletonPath: string,
  skinName: string | null,
  w: number,
  h: number,
  bakeResolution: number,
): string {
  // `bakeResolution` is part of the identity because it decides the actual
  // TEXEL count of the RenderTexture (`w * res` x `h * res`). Two bakes of the
  // same skeleton/skin/cell at different renderer resolutions are genuinely
  // different textures, and `SPINE_STATIC_CACHE` is module-level (it survives a
  // hot reload and every scene rebuild), so without this token a resolution
  // change mid-session would keep serving a texture baked under the old
  // assumption. Including it means a mismatch simply MISSES and re-bakes, which
  // is why this needs no `SPINE_STATIC_CACHE_VERSION` bump — and why a future
  // change to `reelsBakeEffectiveResolution` self-invalidates for free.
  return `${skeletonPath}|${skinName ?? 'default'}|${w}x${h}@${bakeResolution}|v${SPINE_STATIC_CACHE_VERSION}`;
}

function bakeSpineStaticTexture(
  skeletonPath: string,
  skinName: string | null,
  frameWidth: number,
  frameHeight: number,
): PIXI.Texture | null {
  if (!skeletonPath) return null;
  const w = Math.max(1, Math.round(frameWidth));
  const h = Math.max(1, Math.round(frameHeight));
  // Resolved BEFORE the cache lookup so it can take part in the key. Reading
  // the renderer resolution is defensive (falls back to 1), so this stays safe
  // on the "renderer not up yet" path below — and because
  // `reelsBakeEffectiveResolution` floors its input at 2, every current input
  // maps to the same effective value, so adding this token invalidates nothing
  // today. It only starts discriminating if the bake resolution formula or the
  // live renderer resolution actually changes.
  const bakeResolution = reelsBakeEffectiveResolution(getRendererResolution());
  const key = spineStaticCacheKey(skeletonPath, skinName, w, h, bakeResolution);
  const cached = SPINE_STATIC_CACHE.get(key);
  if (cached) return cached;

  const renderer = GameApplication?.pixiApp?.renderer as unknown as
    (PIXI.Renderer & { render?: (...a: any[]) => void }) | undefined;
  if (!renderer || typeof renderer.render !== 'function') {
    if (!spineBakeNoRendererWarned) {
      spineBakeNoRendererWarned = true;
      console.warn('[FlowState/reels] spine mode set but no Pixi renderer available; skipping spine static bake');
    }
    return null;
  }

  const spineData = resolveReelsSpineData(skeletonPath);
  if (!spineData) return null;

  let spine: Spine | null = null;
  try {
    spine = new Spine(spineData as SkeletonData);
    spine.autoUpdate = false;
    try {
      spine.skeleton.setToSetupPose();
      spine.skeleton.setSkinByName(skinName && skinName !== 'default' ? skinName : 'default');
      spine.skeleton.setSlotsToSetupPose();
    } catch (skinErr) {
      console.warn(`[FlowState/reels] spine bake skin "${skinName ?? ''}" not found; using default`, skinErr);
      try { spine.skeleton.setToSetupPose(); } catch { /* no-op */ }
    }
    // Resting pose: clear track 0 so no animation overlays the setup pose.
    try { spine.state.setEmptyAnimation(0, 0); } catch { /* no-op */ }
    spine.update(0);

    const bounds = spine.getLocalBounds();
    const boundsWidth = bounds.width || 1;
    const boundsHeight = bounds.height || 1;
    // Draw the resting pose at NATIVE scale (1), centred in the frame-sized
    // canvas — matching `layoutSpine`, so the idle/spin sprite and the landed
    // spine are the same size. The canvas stays `w × h` (the cell frame) so
    // `applySkin`'s stretch to `frame.width/height` remains a 1:1 no-op and
    // every downstream contract (spin blur, win pulse, cascade, winline
    // geometry, placeholder hitArea) is preserved.
    // NOTE: a skeleton whose setup-pose bounds exceed the cell will be CROPPED
    // by this bake canvas during idle/spin. Authors should size
    // `symbolWidth`/`symbolHeight` to cover their largest skeleton.
    spine.scale.set(1);
    spine.position.set(
      w / 2 - (bounds.x + boundsWidth / 2),
      h / 2 - (bounds.y + boundsHeight / 2),
    );

    // MUST be the same value the cache key was built from, or the key would
    // describe a texture that wasn't produced.
    const resolution = bakeResolution;
    // PIXI 8: `scaleMode` is a TextureSource style option (`'linear'`), not a
    // post-hoc `baseTexture.scaleMode = SCALE_MODES.LINEAR` assignment —
    // `SCALE_MODES` no longer exists as a runtime value.
    const renderTexture = PIXI.RenderTexture.create({ width: w, height: h, resolution, scaleMode: 'linear' });
    renderer.render({ container: spine, target: renderTexture, clear: true });
    SPINE_STATIC_CACHE.set(key, renderTexture);
    SPINE_STATIC_BAKED_TEXTURES.add(renderTexture);
    return renderTexture;
  } catch (err) {
    console.warn('[FlowState/reels] spine static bake failed', skeletonPath, err);
    return null;
  } finally {
    if (spine) {
      try { spine.destroy({ children: true }); } catch { /* no-op */ }
    }
  }
}

/**
 * Build a partial `ICascadeSettings` from the authored flat cascade fields
 * on a Reels node config. Returns `null` when no cascade field is present
 * (so the package's `GCSettings` defaults stay in effect). Only the
 * nested groups that have at least one authored value are emitted.
 */
function buildCascadeSettingsFromConfig(
  node: FlowstateInjectedReelsConfig,
): Partial<ICascadeSettings> | null {
  const settings: Partial<ICascadeSettings> = {};
  let hasAny = false;

  if (typeof node.cascadeFallTime === 'number' || typeof node.cascadeFallOffset === 'number') {
    const fall: { fallTime?: number; fallOffset?: number } = {};
    if (typeof node.cascadeFallTime === 'number') fall.fallTime = node.cascadeFallTime;
    if (typeof node.cascadeFallOffset === 'number') fall.fallOffset = node.cascadeFallOffset;
    settings.cascadeFallSettings = fall as ICascadeSettings['cascadeFallSettings'];
    hasAny = true;
  }
  if (typeof node.cascadeBounceDuration === 'number' || typeof node.cascadeBounceOffset === 'number') {
    const bounce: { duration?: number; offset?: number } = {};
    if (typeof node.cascadeBounceDuration === 'number') bounce.duration = node.cascadeBounceDuration;
    if (typeof node.cascadeBounceOffset === 'number') bounce.offset = node.cascadeBounceOffset;
    settings.cascadeBounceSettings = bounce as ICascadeSettings['cascadeBounceSettings'];
    hasAny = true;
  }
  if (typeof node.cascadeRemoveDelay === 'number') {
    settings.cascadeRemoveDelay = node.cascadeRemoveDelay;
    hasAny = true;
  }
  if (typeof node.cascadeBlockFallDelay === 'number') {
    settings.cascadeBlockFallDelay = node.cascadeBlockFallDelay;
    hasAny = true;
  }

  return hasAny ? settings : null;
}

export function buildFlowstateReelsDisplay(
  node: FlowstateInjectedReelsConfig,
  resolveTexture: (path: string, atlasPath?: string) => PIXI.Texture,
  resolveAssetUrl: (ref: string) => string,
  loadSpineData?: (skeletonPath: string) => Promise<unknown | null>,
  // Bare ref → SCOPE-QUALIFIED path (`core/<ref>` / `skins/<skin>/<ref>`), used
  // for the per-symbol win-audio alias. Optional so a legacy caller still
  // builds; the cue then falls back to the unscoped path.
  scopeQualifyRef?: (ref: string) => string,
  // Loads a symbol-text font FILE and resolves the family to draw it with.
  // Optional so an older scene manager still builds (texts then keep a
  // generic fallback font).
  loadFont?: (fontRef: string) => Promise<string>,
): PIXI.Container {
  const root = new PIXI.Container() as PIXI.Container & {
    _flowstateReelService?: FlowstateInjectedReelService;
    _flowstateReelsWinlinePlayer?: FlowstateReelsWinlinePlayer;
    _flowstateReelsCascadeSettings?: Partial<ICascadeSettings>;
    /** Symbol-text slots + virtual-skin table (absent when the node has none). */
    _flowstateSymbolTexts?: ReelsSymbolTextState;
    /** `SceneManager.getDisplayObjectById` resolves `<nodeId>::<key>` refs here. */
    __orcaResolveSubNode?: (key: string) => PIXI.Container | undefined;
    // Per-reel / per-symbol FlowState access handles. Assigned AFTER the reel
    // build loop (see below) so both arrays are fully populated.
    _flowstateReelViews?: FlowstateInjectedReelView[];
    _flowstateReelsGridSize?: { reelCount: number; rowCount: number };
    _flowstateResolveSymbolCell?: (reelIndex: number, rowIndex: number) => FlowstateInjectedSymbolView | null;
    // Runtime symbol DRAW-ORDER override (`methods/generic-reels.ts`
    // `setSymbolDrawOrder`). PER-ROOT, not static: the visual resolver is a
    // `private static` with a last-built-node-wins caveat, so a static handle
    // would widen that bug across multiple reels nodes in one scene.
    _flowstateSetSymbolDrawOrder?: (order: number[]) => void;
    /** AUTHORED symbol count — the permutation length the methods layer
     *  validates against (NOT the padded `symbolEntries.length`). */
    _flowstateAuthoredSymbolCount?: number;
  };
  root.label = node.name;
  root.sortableChildren = true;

  const reelCount = toClampedInt(node.reelCount, 5, 1, 20);
  const rowCount = toClampedInt(node.rowCount, 3, 1, 12);
  const symbolWidth = toPositiveNumber(node.symbolWidth, 200);
  const symbolHeight = toPositiveNumber(node.symbolHeight, 200);
  const symbolRectMode = node.symbolRectMode === 'individual' ? 'individual' : 'shared';
  const symbolRects = symbolRectMode === 'individual'
    ? Array.from({ length: reelCount }, (_, index) => ({
      x: toPositiveNumber(node.symbolRects?.[index]?.x, symbolWidth),
      y: toPositiveNumber(node.symbolRects?.[index]?.y, symbolHeight),
    }))
    : [];
  const symbolSpacingX = toNumber(node.symbolSpacingX, 0);
  const symbolSpacingY = toNumber(node.symbolSpacingY, 0);
  const reelSpacing = toNumber(node.reelSpacing, 0);
  const reelSpacings = Array.isArray(node.reelSpacings) && node.reelSpacings.length > 0 ? node.reelSpacings : null;
  const reelOffsets = Array.from({ length: reelCount }, (_, index) => {
    const offset = Array.isArray(node.reelOffsets) ? node.reelOffsets[index] : null;
    return {
      x: toNumber(offset?.x, 0),
      y: toNumber(offset?.y, 0),
    };
  });
  const maskPadding = Math.max(0, toNumber(node.maskPadding, 0));
  const authoredSymbolEntries = normalizeSymbolEntries(node.symbolEntries, node.symbols);
  const symbolEntries = ensureMinimumSymbolEntries(
    authoredSymbolEntries,
    reelCount,
    rowCount,
  );
  // Defensive wrapper: a missing / 404 sprite frame must never throw out of
  // the reels build (which would abort the whole scene). On any failure fall
  // back to an empty texture so the symbol renders blank instead of crashing.
  const safeResolveTexture = (path: string, atlasPath?: string): PIXI.Texture => {
    try {
      const resolved = resolveTexture(path, atlasPath) as PIXI.Texture | null | undefined;
      return resolved ?? (PIXI.Texture.EMPTY as PIXI.Texture);
    } catch (err) {
      console.warn('[FlowState/reels] symbol texture resolve failed', path, err);
      return PIXI.Texture.EMPTY as PIXI.Texture;
    }
  };

  const textures: PIXI.Texture[] = symbolEntries.map(() => PIXI.Texture.EMPTY as PIXI.Texture);
  symbolEntries.forEach((entry, index) => {
    const spritePath = entry.sprite;
    const atlasPath = node.symbolStaticsAtlas && !/[/\\]/.test(spritePath)
      ? node.symbolStaticsAtlas
      : undefined;
    const resolvedTexture = spritePath
      ? safeResolveTexture(spritePath, atlasPath)
      : (PIXI.Texture.EMPTY as PIXI.Texture);
    textures[index] = isSymbolTextureCandidate(resolvedTexture)
      ? resolvedTexture
      : (PIXI.Texture.EMPTY as PIXI.Texture);
  });

  // In `sprite` (and legacy `animatedSprite`) mode, prefer the first frame
  // of an `animatedSpriteAsset` for the static stop-state — this matches
  // the editor's preview, which shows frame 0 of the animsprite. Resolution
  // is async (fetch + image decode); on completion we patch `textures[]`
  // and force every reel's symbols to re-read via `setStaticSkin`.
  const isSpriteSymbolMode = node.symbolMode === 'sprite' || node.symbolMode === 'animatedSprite';
  const isSpineSymbolMode = node.symbolMode === 'spine';
  const reelViewsForRefresh: FlowstateInjectedReelView[] = [];
  const refreshAllSymbolSkins = (): void => {
    for (const rv of reelViewsForRefresh) {
      for (const sym of rv.symbols) {
        try { sym.setStaticSkin(); } catch { /* destroyed */ }
      }
    }
  };

  // A symbol image still loading when a cell is drawn is the scene manager's
  // on-demand placeholder (a 1x1 texture whose source is swapped when the
  // image lands). A sprite sized against it keeps a ~200x scale, so the landed
  // image draws far too big and the cell looks empty until a spin re-skins it.
  // Re-skin every symbol once such a texture lands — on a microtask, because
  // the source swap emits `update` before the frame takes the image's size.
  let symbolRefreshQueued = false;
  const awaitedSymbolTextures = new Set<PIXI.Texture>();
  // Not the type guard itself: a `false` from it would narrow `texture` to never.
  const hasLanded = (texture: PIXI.Texture): boolean => isRenderableTexture(texture);
  const refreshWhenTextureLands = (texture: PIXI.Texture): void => {
    if (!texture.dynamic || hasLanded(texture) || awaitedSymbolTextures.has(texture)) return;
    awaitedSymbolTextures.add(texture);
    const onUpdate = (): void => {
      if (!hasLanded(texture)) return;
      texture.off('update', onUpdate);
      awaitedSymbolTextures.delete(texture);
      if (symbolRefreshQueued) return;
      symbolRefreshQueued = true;
      void Promise.resolve().then(() => {
        symbolRefreshQueued = false;
        refreshAllSymbolSkins();
      });
    };
    texture.on('update', onUpdate);
  };
  textures.forEach(refreshWhenTextureLands);

  // Reel-blur configuration. While a reel spins fast (speed >=
  // `reelBlurSpeedTrigger`) a single live vertical `BlurFilter` is applied
  // to each symbol's displayed static sprite by the spin-blur ticker below
  // (see `FlowstateInjectedSymbolView.setSpinBlurState`). No baked-blur
  // textures — one live filter per symbol, matching the editor preview.
  const reelBlurStrength = Math.max(0, Math.min(16, toNumber(node.reelBlurStrength, 0)));
  const reelBlurSpeedTrigger = toNumber(node.reelBlurSpeedTrigger, 8);

  if (isSpriteSymbolMode) {
    symbolEntries.forEach((entry, index) => {
      const animPath = (entry as { animatedSpriteAsset?: string }).animatedSpriteAsset;
      if (!animPath) return;
      resolveAnimspriteFirstFrame(animPath, resolveAssetUrl).then((tex) => {
        if (!tex) return;
        textures[index] = tex;
        refreshAllSymbolSkins();
      }).catch(() => { /* logged inside helper */ });
    });
  }

  // In `spine` mode, bake the skeleton's RESTING pose into a static sprite
  // texture used for the idle/spin state. Without this, spine symbols render
  // nothing while spinning AND the per-reel blur has no texture to blur
  // ("blur doesn't work for spine"). The landed spine still plays on reel
  // stop via `setAnimationSkin` → `ensureSpine`. Skeleton data may not be
  // loaded at build time (`resolveReelsSpineData` returns null) — in that
  // case we retry on the shared ticker for a bounded window, then give up
  // (falling back to the authored sprite / empty texture).
  if (isSpineSymbolMode) {
    // Self-heal spine data from the SCOPE-QUALIFIED URLs so a preload /
    // registration-key miss (the sync resolver can't reproduce the
    // scope-qualified AssetManager key) still resolves without a manual
    // reload. Populates REELS_PARSED_SPINE_CACHE; the pending-bake retry
    // ticker below and reel-stop `ensureSpine` both read it once the async
    // load completes. De-duped per distinct skeleton by the loader.
    if (loadSpineData) {
      const spineSkeletons = new Set<string>();
      for (const entry of symbolEntries) {
        const skeletonPath = (node.sharedSpineAnimation || entry.spineAnimation || '').trim();
        if (skeletonPath) spineSkeletons.add(skeletonPath);
      }
      for (const skeletonPath of spineSkeletons) {
        ensureReelSpineDataLoaded(skeletonPath, loadSpineData, refreshAllSymbolSkins);
      }
    }

    const pendingSpineBakes: number[] = [];
    symbolEntries.forEach((entry, index) => {
      const skeletonPath = (node.sharedSpineAnimation || entry.spineAnimation || '').trim();
      if (!skeletonPath) return;
      const baked = bakeSpineStaticTexture(skeletonPath, entry.skin ?? null, symbolWidth, symbolHeight);
      if (baked) {
        textures[index] = baked;
      } else {
        pendingSpineBakes.push(index);
      }
    });

    if (pendingSpineBakes.length > 0) {
      const ticker = PIXI.Ticker.shared;
      let framesWaited = 0;
      const maxFrames = 300; // ~5s @60fps before giving up on late spine data.
      const retrySpineBakes = (): void => {
        framesWaited += 1;
        let resolvedAny = false;
        for (let i = pendingSpineBakes.length - 1; i >= 0; i -= 1) {
          const index = pendingSpineBakes[i];
          const entry = symbolEntries[index];
          const skeletonPath = (node.sharedSpineAnimation || entry.spineAnimation || '').trim();
          const baked = bakeSpineStaticTexture(skeletonPath, entry.skin ?? null, symbolWidth, symbolHeight);
          if (baked) {
            textures[index] = baked;
            pendingSpineBakes.splice(i, 1);
            resolvedAny = true;
          }
        }
        if (resolvedAny) refreshAllSymbolSkins();
        if (pendingSpineBakes.length === 0 || framesWaited >= maxFrames) {
          try { ticker.remove(retrySpineBakes); } catch { /* no-op */ }
        }
      };
      ticker.add(retrySpineBakes);
      root.once('destroyed', () => { try { ticker.remove(retrySpineBakes); } catch { /* no-op */ } });
    }
  }

  // Author-preferred symbol DRAW ORDER → per-symbol-ID zIndex table, resolved
  // at build time and re-pointable at runtime by `setSymbolDrawOrder` (hence
  // `let`, and hence the visual resolver below reads it through the closure
  // rather than capturing the array).
  // `null` ⇒ identity order ⇒ every symbol stays at zIndex 0.
  //
  // Derived from the AUTHORED entry count (NOT the padded `symbolEntries`
  // length): the draw order is a permutation of authored symbol IDs, and
  // `symbolDrawPriorityFor` wraps padded tail IDs back onto their source.
  let symbolDrawPriorities = buildSymbolDrawPriorities(node.symbolDrawOrder, authoredSymbolEntries.length);

  root._flowstateAuthoredSymbolCount = authoredSymbolEntries.length;
  root._flowstateSetSymbolDrawOrder = (order: number[]): void => {
    symbolDrawPriorities = buildSymbolDrawPriorities(order, authoredSymbolEntries.length);
    // Every visible cell re-enters `applySkin`, which re-reads the resolver
    // and re-asserts its `zIndex` (winline-elevated cells excepted).
    refreshAllSymbolSkins();
  };

  FlowstateInjectedSymbolView.configureSymbolVisualResolver((skinIndex: number) => {
    if (textures.length === 0) {
      return {
        texture: PIXI.Texture.EMPTY,
        hasSprite: false,
        hasSpine: false,
      };
    }
    const finiteSkinIndex = Number.isFinite(skinIndex) ? skinIndex : 0;
    const normalizedIndex = ((Math.round(finiteSkinIndex) % textures.length) + textures.length) % textures.length;
    const entry = symbolEntries[normalizedIndex];
    const spritePath = entry?.sprite;
    let texture = textures[normalizedIndex];

    if (spritePath && !isRenderableTexture(texture)) {
      const atlasPath = node.symbolStaticsAtlas && !/[/\\]/.test(spritePath)
        ? node.symbolStaticsAtlas
        : undefined;
      const resolvedTexture = safeResolveTexture(spritePath, atlasPath);
      if (isSymbolTextureCandidate(resolvedTexture)) {
        texture = resolvedTexture;
        textures[normalizedIndex] = resolvedTexture;
        refreshWhenTextureLands(resolvedTexture);
      }
    }

    // The shared skeleton (node-level) wins over the legacy per-symbol
    // `entry.spineAnimation`. A node in spine mode with any resolvable
    // skeleton path counts as spine-capable; the per-symbol `entry.skin`
    // names the skin applied via `skeleton.setSkinByName`.
    const spineSkeletonPath = (node.sharedSpineAnimation || entry?.spineAnimation || '').trim();

    return {
      texture: texture || PIXI.Texture.EMPTY,
      hasSprite: !!entry?.sprite,
      hasSpine: isSpineSymbolMode && !!spineSkeletonPath,
      skin: entry?.skin,
      spineSkeletonPath: spineSkeletonPath || undefined,
      // Per-symbol spine ANIMATION names (distinct from the spine SKIN name).
      // `winAnimation` falls back to 'win' downstream; `landAnimation` +
      // `landAnimationEnabled` gate the track-0 land playback on reel stop,
      // and `landAnimationLoop` (DEFAULT OFF) decides whether that land
      // playback loops or plays once and holds its final pose.
      winAnimation: typeof entry?.winAnimation === 'string' ? entry.winAnimation.trim() : undefined,
      landAnimation: typeof entry?.landAnimation === 'string' ? entry.landAnimation.trim() : undefined,
      landAnimationEnabled: entry?.landAnimationEnabled === true,
      landAnimationLoop: entry?.landAnimationLoop === true,
      // Per-symbol RENDER scale (0.1–3, default 1). Written by the editor only
      // when the author moved it off the default, so an absent field ⇒ 1 and a
      // pre-scale scene renders exactly as before. Clamped here, at the read
      // site, so junk in a hand-edited scene JSON can never blow up layout.
      symbolScale: clampSymbolScale(entry?.scale),
      // Per-symbol DRAW PRIORITY (zIndex) derived from the node-level
      // `symbolDrawOrder`. `null` table ⇒ identity order ⇒ 0 for every
      // symbol ⇒ Pixi skips the child sort and today's insertion order is
      // preserved exactly. `normalizedIndex` IS the symbol ID (the index
      // into `symbolEntries`); the lookup wraps modulo the AUTHORED count so
      // padded tail clones inherit their source symbol's depth.
      drawPriority: symbolDrawPriorityFor(symbolDrawPriorities, normalizedIndex),
    };
  });

  // Per-symbol-INDEX animsprite frame registry (sprite / legacy
  // `animatedSprite` mode), backing `FlowstateInjectedSymbolView.playSymbolAnimation`.
  // Resolution is LAZY: the build path above still resolves ONLY frame 0 (the
  // cheap static stop-state texture), so registering this provider adds no
  // build-time fetches. The first `playSymbolAnimation` on an index kicks the
  // full frame resolve and returns false; the next call plays. Keyed by INDEX
  // so every symbol VIEW showing that symbol shares one decoded frame list.
  const animspriteFramesByIndex = new Map<number, { frames: PIXI.Texture[]; animationSpeed: number }>();
  const animspriteFrameRequests = new Set<number>();
  FlowstateInjectedSymbolView.configureAnimspriteFrameProvider((skinIndex: number) => {
    if (!isSpriteSymbolMode || symbolEntries.length === 0) return null;
    const finiteSkinIndex = Number.isFinite(skinIndex) ? skinIndex : 0;
    const normalizedIndex = ((Math.round(finiteSkinIndex) % symbolEntries.length) + symbolEntries.length) % symbolEntries.length;
    const animPath = (symbolEntries[normalizedIndex]?.animatedSpriteAsset || '').trim();
    if (!animPath) return null;
    const resolved = animspriteFramesByIndex.get(normalizedIndex) ?? null;
    if (!resolved && !animspriteFrameRequests.has(normalizedIndex)) {
      animspriteFrameRequests.add(normalizedIndex);
      resolveAnimspriteFrames(animPath, resolveAssetUrl).then((frames) => {
        if (frames.length === 0) return;
        animspriteFramesByIndex.set(normalizedIndex, {
          frames,
          animationSpeed: getAnimspriteAnimationSpeed(animPath, resolveAssetUrl),
        });
      }).catch(() => { /* logged inside helper */ });
    }
    return {
      path: animPath,
      frames: resolved ? resolved.frames : null,
      animationSpeed: resolved ? resolved.animationSpeed : 1,
    };
  });

  const reelService = new FlowstateInjectedReelService();
  // Symbol texts: hung on the service BEFORE any reel view exists, because the
  // views' skin codec reaches the state through `_service`.
  const symbolTextSlots = normalizeSymbolTextSlots(node.symbolTexts);
  const symbolTextState = symbolTextSlots.length > 0 ? new ReelsSymbolTextState(symbolTextSlots) : null;
  if (symbolTextState) {
    (reelService as unknown as { __orcaSymbolTexts?: ReelsSymbolTextState }).__orcaSymbolTexts = symbolTextState;
    root._flowstateSymbolTexts = symbolTextState;
  }
  // Enable zIndex sorting on every reel's `_symbolHolder`. `GRReelView.buildReel`
  // reads `coreSettings.allowZIndexSymbolSorting` ONCE, at construction time,
  // so this MUST be assigned before the `FlowstateInjectedReelView`s below.
  // The setter merges a Partial into the package defaults, so nothing else in
  // `ICoreSettings` (topOffset / bottomOffset / masks / recursiveTransforming)
  // is disturbed.
  //
  // This is what makes the authored `symbolDrawOrder` render at all, and it is
  // SAFE for scenes without one: with an identity order every symbol keeps
  // zIndex 0, and Pixi's `Container.sortChildren` bails out before sorting
  // while all children are at 0 — raw insertion order is untouched.
  reelService.coreSettings = {
    allowZIndexSymbolSorting: true,
  };
  reelService.symbolSettings = {
    frameTransfrom: new PIXI.Rectangle(0, 0, symbolWidth, symbolHeight),
  };
  reelService.reelSettings = {
    reelStartDelay: 0,
    symbolVerticalPadding: symbolSpacingY,
    rollbackSpeed: typeof node.rollbackSpeed === 'number' && Number.isFinite(node.rollbackSpeed)
      ? node.rollbackSpeed
      : -15,
    bounceSettings: {
      elasticStopIntensity: toNumber(node.elasticStopIntensity, 0.98),
      elasticStopDuration: toNumber(node.elasticStopDuration, 0.8),
      elasticBounceAmplitude: toNumber(node.elasticBounceAmplitude, 1),
      elasticBouncePeriod: toNumber(node.elasticBouncePeriod, 0.3),
    },
  };

  const spinProfile = buildSpinProfileSequence(node.spinProfileActions, reelCount);
  if (spinProfile) {
    reelService.spinProfile = spinProfile;
  }

  reelService.model.onScreenReels = buildInitialDisplayMap(reelCount, rowCount, textures.length);
  root._flowstateReelService = reelService;

  // Cascade settings authored on the node are applied to the GCService now
  // (so `GCReelView`'s fall/bounce reads are correct from first cascade) and
  // also exposed on `root` so the `runCascade` FlowState method can re-apply
  // them per call.
  const cascadeSettings = buildCascadeSettingsFromConfig(node);
  if (cascadeSettings) {
    reelService.cascadeSettings = cascadeSettings;
    root._flowstateReelsCascadeSettings = cascadeSettings;
  }

  // Surface the GCService cascade-complete event to FlowState. The package
  // seeds `eventFire.serviceEvent.ON_CASCADE_COMPLETE` as an assignable no-op
  // slot (fired by GCModel when a cascade sequence settles), so we COMPOSE
  // with any prior assignment rather than clobber it — the default is a
  // no-op here, but composing keeps this safe if the package or upstream
  // injection ever wires cascade orchestration into the same slot. Dispatch
  // mirrors `runFlowsByStarterType` usage in the application event triggers.
  const prevOnCascadeComplete = reelService.eventFire.serviceEvent.ON_CASCADE_COMPLETE;
  reelService.eventFire.serviceEvent.ON_CASCADE_COMPLETE = () => {
    if (typeof prevOnCascadeComplete === 'function') prevOnCascadeComplete();
    void Flowstate.runFlowsByStarterType('cascadeComplete');
  };

  // Standard-spin counterpart to the cascade block above. The package seeds
  // `eventFire.serviceEvent.ON_SPIN_COMPLETE` as an assignable no-op slot,
  // fired when a spin sequence settles and every reel has landed — including
  // from the FlowState `completeSpinSequence()` method in
  // `methods/generic-reels.ts`, which invokes this same slot on this same
  // service instance, so the composed wrapper below is on that path too.
  // COMPOSE rather than clobber so any prior assignment still runs first.
  const prevOnSpinComplete = reelService.eventFire.serviceEvent.ON_SPIN_COMPLETE;
  reelService.eventFire.serviceEvent.ON_SPIN_COMPLETE = () => {
    if (typeof prevOnSpinComplete === 'function') prevOnSpinComplete();
    void Flowstate.runFlowsByStarterType('spinComplete');
  };

  const reelGeometries: FlowstateReelGeometry[] = [];

  // ── Leaked-ticker capture (package bug workaround) ─────────────────────
  // `GRReelView`'s constructor ends with:
  //
  //     const ticker: Ticker = Ticker.shared;
  //     ticker.add((delta) => { this.update(delta); });
  //
  // The callback is an ANONYMOUS arrow held nowhere, and the package ships no
  // `destroy()` override, so it is unremovable by reference and outlives the
  // reel view FOREVER. Consequences on every `loadScene`/`unloadScene` (the
  // scene manager's `teardownCurrentScene` does
  // `currentContainer.destroy({ children: true })`):
  //   1. MEMORY — the closure strongly retains the destroyed `GRReelView`,
  //      hence its symbols, spines and render textures. Nothing under a torn
  //      down reels node can ever be collected. Grows per scene load.
  //   2. CPU — `reelCount` dead callbacks are appended to `Ticker.shared`
  //      per build and never drop off.
  //   3. CRASH — `update()` → `movementUpdate()` early-returns only when
  //      `_reelSpinState === SpinState.STOPPED`. Unload a scene mid-spin and
  //      the dead reel keeps driving DESTROYED symbols; `applySkin` then hits
  //      `this.scale` on a view whose `transform` is null and throws. Pixi's
  //      `Ticker.update` has no try/catch, so the throw aborts the rest of
  //      the listener chain — including the Application's `render` — and
  //      does so again every frame. That is a hard visual freeze.
  //
  // We cannot remove what we cannot name, so we NAME it: patch
  // `Ticker.shared.add` for the exact duration of the (synchronous)
  // `GRReelView` constructor and record whatever it registers. Narrow window,
  // no Pixi internals touched (`_head`/`TickerListener` are left alone), and
  // `remove(fn, context)` matches on the same pair `add` was given.
  const capturedReelTickers: Array<{ fn: any; context: any }> = [];
  const constructReelView = (index: number): FlowstateInjectedReelView => {
    const ticker = PIXI.Ticker.shared as unknown as { add: (...args: any[]) => unknown };
    const originalAdd = ticker.add;
    const hadOwnAdd = Object.prototype.hasOwnProperty.call(ticker, 'add');
    ticker.add = function capturingAdd(fn: any, context?: any, priority?: any) {
      capturedReelTickers.push({ fn, context });
      return originalAdd.call(this, fn, context, priority);
    };
    try {
      return new FlowstateInjectedReelView(reelService, rowCount, index);
    } finally {
      // Restore precisely: `add` is normally a PROTOTYPE method, so the own
      // property we just created must be deleted rather than overwritten —
      // otherwise a later prototype patch (or another capture) would be
      // shadowed by this stale copy.
      if (hadOwnAdd) ticker.add = originalAdd;
      else delete (ticker as unknown as Record<string, unknown>).add;
    }
  };

  let cumulativeX = 0;
  for (let reelIndex = 0; reelIndex < reelCount; reelIndex += 1) {
    const symbolRect = symbolRectMode === 'individual'
      ? symbolRects[reelIndex]
      : { x: symbolWidth, y: symbolHeight };
    const rowStrideY = symbolRect.y + symbolSpacingY;
    const maskedHeight = Math.max(1, (rowCount * rowStrideY) - symbolSpacingY + (maskPadding * 2));
    const maskTop = getReelMaskTop(symbolSpacingY, maskPadding);
    const reelWrapper = new PIXI.Container();
    reelWrapper.position.set(cumulativeX + reelOffsets[reelIndex].x, reelOffsets[reelIndex].y);
    const gapAfter = reelSpacings ? toNumber(reelSpacings[reelIndex], reelSpacing) : reelSpacing;
    cumulativeX += symbolRect.x + symbolSpacingX + gapAfter;

    const reelContainer = constructReelView(reelIndex);

    // Per-reel stop event → FlowState `reelStop` starter, carrying this
    // reel's index as a starter value arg (`reelIndex`, matching the menu
    // output name). `ON_REEL_STOP` is a package-seeded no-op slot on the
    // reel VIEW; `FlowstateInjectedReelView` never assigns it (its land
    // animations run through the symbol view's `applySkin(true)` path), but
    // we still COMPOSE — this runs after construction, so `prevOnReelStop`
    // captures whatever the class/package installed and is invoked first.
    // `reelIndex` is a `let` loop binding, so each closure captures its own.
    const prevOnReelStop = reelContainer.eventFire.reelEvent.ON_REEL_STOP;
    reelContainer.eventFire.reelEvent.ON_REEL_STOP = () => {
      if (typeof prevOnReelStop === 'function') prevOnReelStop();
      void Flowstate.runFlowsByStarterType('reelStop', { reelIndex });
    };

    reelContainer.enableMask();
    syncReelSymbolFrame(reelContainer, new PIXI.Rectangle(0, 0, symbolRect.x, symbolRect.y), maskedHeight, maskTop);

    const reelMask = new PIXI.Graphics();
    reelMask
      .rect(0, maskTop, Math.max(1, symbolRect.x), maskedHeight)
      .fill({ color: 0xffffff, alpha: 1 });

    reelWrapper.addChild(reelContainer);
    reelWrapper.addChild(reelMask);
    reelWrapper.mask = reelMask;
    root.addChild(reelWrapper);

    reelViewsForRefresh.push(reelContainer);

    reelGeometries.push({
      reelWrapper,
      reelView: reelContainer,
      symbolWidth: symbolRect.x,
      symbolHeight: symbolRect.y,
      symbolSpacingY,
      maskTop,
      maskPadding,
      rowCount,
    });
  }

  // Unconditional teardown for the captured package tickers (see the
  // capture block above). Registered AFTER the build loop so
  // `reelViewsForRefresh` is fully populated. Pixi's
  // `Container.destroy({ children: true })` emits `destroyed` on a node
  // BEFORE it destroys that node's children, so the reel views are still
  // intact (and still safe to touch) when this runs.
  root.once('destroyed', () => {
    const ticker = PIXI.Ticker.shared;
    for (const captured of capturedReelTickers) {
      try { ticker.remove(captured.fn, captured.context); } catch { /* no-op */ }
    }
    capturedReelTickers.length = 0;
    // Belt-and-braces: if the package ever moves its `ticker.add` out of the
    // constructor the capture window above misses it, so also park every reel
    // in `SpinState.STOPPED` (0). `movementUpdate` early-returns on that, which
    // downgrades any surviving callback from "drives destroyed symbols and
    // throws" to a harmless no-op. Private-field reach, exactly like the
    // spin-blur ticker's `_speedControl`.
    for (const rv of reelViewsForRefresh) {
      try { (rv as unknown as { _reelSpinState?: number })._reelSpinState = 0; } catch { /* no-op */ }
    }
  });

  // FlowState per-reel / per-symbol access handles. Assigned HERE — after the
  // build loop — so `reelViewsForRefresh` and `reelGeometries` are both fully
  // populated. `_flowstateReelViews` intentionally shares the same array
  // reference the refresh/blur paths already use.
  root._flowstateReelViews = reelViewsForRefresh;
  root._flowstateReelsGridSize = { reelCount, rowCount };
  root._flowstateResolveSymbolCell = (reelIndex: number, rowIndex: number): FlowstateInjectedSymbolView | null => {
    if (typeof reelIndex !== 'number' || !Number.isFinite(reelIndex)) return null;
    if (typeof rowIndex !== 'number' || !Number.isFinite(rowIndex)) return null;
    const reel = Math.round(reelIndex);
    const row = Math.round(rowIndex);
    if (reel < 0 || reel >= reelGeometries.length) return null;
    const geom = reelGeometries[reel];
    if (!geom) return null;
    if (row < 0 || row >= geom.rowCount) return null;
    // Shared nearest-Y mapping — the SAME resolution the winline player uses.
    const view = resolveReelSymbolViewForCell(geom, row);
    return view instanceof FlowstateInjectedSymbolView ? view : null;
  };

  // `<nodeId>::cell:<reel>:<row>` → the symbol at that cell now;
  // `<nodeId>::text:<reel>:<row>:<slot>` → its text. Resolved LIVE on every
  // lookup, so a ref taken before a spin still names whatever landed there.
  root.__orcaResolveSubNode = (key: string): PIXI.Container | undefined => {
    const match = /^(cell|text):(-?\d+):(-?\d+)(?::(\d+))?$/.exec(String(key ?? ''));
    if (!match) return undefined;
    const view = root._flowstateResolveSymbolCell?.(Number(match[2]), Number(match[3])) ?? null;
    if (!view) return undefined;
    if (match[1] === 'cell') return view;
    return view.getCellTextObject(Number(match[4] ?? 0)) ?? undefined;
  };

  if (symbolTextState && loadFont) {
    const refreshTextStyles = (): void => {
      for (const rv of reelViewsForRefresh) {
        for (const sym of rv.symbols) {
          try { sym.refreshCellTextStyles(); } catch { /* destroyed */ }
        }
      }
    };
    symbolTextState.slots.forEach((slot, index) => {
      if (!SYMBOL_TEXT_FONT_FILE_RE.test(slot.fontRef)) return;
      loadFont(slot.fontRef)
        .then((family) => {
          if (root.destroyed || !family) return;
          symbolTextState.setFamily(index, family);
          refreshTextStyles();
        })
        .catch((err) => console.warn('[FlowState/reels] symbol text font failed to load', slot.fontRef, err));
    });
  }

  // Live spin-blur ticker. One `PIXI.Ticker.shared` callback walks every
  // reel; for MOVING reels (speed > 0.01) it pushes the blur state into each
  // symbol's live `BlurFilter` via `setSpinBlurState`, gated on
  // `speed >= reelBlurSpeedTrigger`. A reel that drops to stopped WHILE
  // blurred gets a ONE-SHOT `setSpinBlurState(false, …)` clear (a stop can go
  // from full speed to 0 in a single tick, never passing through the
  // sub-trigger window that would otherwise clear it, stranding the filter);
  // after that, and for reels that were never blurred, stopped/landed reels
  // are skipped every tick so the landed spine reveal (set by
  // `setAnimationSkin`) is never clobbered. The per-reel flag is re-armed by
  // the next moving tick, so this survives repeated spins. On teardown the
  // ticker is removed and every symbol's filter destroyed.
  if (reelBlurStrength > 0) {
    const ticker = PIXI.Ticker.shared;
    const blurredReels: boolean[] = reelViewsForRefresh.map(() => false);
    const tickFn = (): void => {
      for (let i = 0; i < reelViewsForRefresh.length; i += 1) {
        const rv = reelViewsForRefresh[i];
        const speedCtrl = (rv as unknown as { _speedControl?: { speed?: number } })._speedControl;
        const speed = typeof speedCtrl?.speed === 'number' ? Math.abs(speedCtrl.speed) : 0;
        if (speed <= 0.01) {
          // Stopped/landed reel. Only touch it if we left blur on it.
          if (blurredReels[i]) {
            for (const sym of rv.symbols) sym.setSpinBlurState(false, reelBlurStrength);
            blurredReels[i] = false;
          }
          continue;
        }
        const blurred = speed >= reelBlurSpeedTrigger;
        for (const sym of rv.symbols) sym.setSpinBlurState(blurred, reelBlurStrength);
        blurredReels[i] = blurred;
      }
    };
    ticker.add(tickFn);
    root.once('destroyed', () => {
      try { ticker.remove(tickFn); } catch { /* no-op */ }
      for (const rv of reelViewsForRefresh) {
        for (const sym of rv.symbols) { try { sym.clearSpinBlur(); } catch { /* ignore */ } }
      }
    });
  }

  root._flowstateReelsWinlinePlayer = createFlowstateReelsWinlinePlayer(root, node, reelGeometries, resolveTexture, scopeQualifyRef);

  return root;
}

function buildInitialDisplayMap(reelCount: number, rowCount: number, textureCount: number): number[][] {
  const symbolCount = Math.max(1, textureCount);
  const genericReelsOffsetCount = 2;
  const totalSymbolCount = rowCount + genericReelsOffsetCount;
  const stripLength = Math.max(symbolCount, totalSymbolCount * 2);
  const map: number[][] = [];

  for (let reelIndex = 0; reelIndex < reelCount; reelIndex += 1) {
    const reelSymbols: number[] = [];
    for (let rowIndex = 0; rowIndex < stripLength; rowIndex += 1) {
      reelSymbols.push((reelIndex * rowCount + rowIndex) % symbolCount);
    }
    map.push(reelSymbols);
  }

  return map;
}

function buildSpinProfileSequence(actions: FlowstateInjectedSpinProfileAction[] | undefined, reelCount: number): SpinProfileSequence | null {
  if (!Array.isArray(actions) || actions.length === 0) {
    return null;
  }

  const validActions: SpinProfileAction[] = [];
  const coveredReels = new Set<number>();

  for (const action of actions) {
    if (!action || typeof action !== 'object') {
      continue;
    }

    const stopReelRaw = (action as FlowstateInjectedSpinProfileAction).stopReel;
    const reelSpeedRaw = (action as FlowstateInjectedSpinProfileAction).reelSpeed;
    const delayRaw = (action as FlowstateInjectedSpinProfileAction).delay;
    if (typeof delayRaw !== 'number' || !Number.isFinite(delayRaw)) {
      continue;
    }
    const delaySeconds = Math.max(0, delayRaw) / 1000;

    const normalizedStopReel = normalizeStopReel(stopReelRaw);
    const normalizedReelSpeed = normalizeReelSpeed(reelSpeedRaw);
    if (!normalizedStopReel || normalizedReelSpeed === null) {
      continue;
    }

    if (Array.isArray(normalizedStopReel)) {
      normalizedStopReel.forEach((stopValue) => {
        if (stopValue >= 1 && stopValue <= reelCount) {
          coveredReels.add(stopValue);
        }
      });
    } else if (normalizedStopReel >= 1 && normalizedStopReel <= reelCount) {
      coveredReels.add(normalizedStopReel);
    }

    validActions.push(new SpinProfileAction(normalizedStopReel, normalizedReelSpeed, delaySeconds));
  }

  if (validActions.length === 0) {
    return null;
  }

  if (coveredReels.size < reelCount) {
    return null;
  }

  return new SpinProfileSequence(validActions);
}

function normalizeStopReel(value: number | number[] | undefined): number | number[] | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.round(value));
  }

  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
      .map(entry => Math.max(1, Math.round(entry)));
    return normalized.length > 0 ? normalized : null;
  }

  return null;
}

function normalizeReelSpeed(value: unknown): number | number[] | { speed: number; overrides?: Record<number, number> } | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
    return normalized.length > 0 ? normalized : null;
  }

  if (value && typeof value === 'object') {
    const source = value as { speed?: unknown; overrides?: unknown };
    if (typeof source.speed !== 'number' || !Number.isFinite(source.speed)) {
      return null;
    }

    const result: { speed: number; overrides?: Record<number, number> } = { speed: source.speed };

    if (source.overrides && typeof source.overrides === 'object') {
      const entries = Object.entries(source.overrides as Record<string, unknown>)
        .filter(([key, entryValue]) => Number.isFinite(Number(key)) && typeof entryValue === 'number' && Number.isFinite(entryValue))
        .map(([key, entryValue]) => [Number(key), entryValue] as [number, number]);
      if (entries.length > 0) {
        const overrides: Record<number, number> = {};
        entries.forEach(([key, entryValue]) => {
          overrides[key] = entryValue;
        });
        result.overrides = overrides;
      }
    }

    return result;
  }

  return null;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Pixi 8 analogue of the removed `BaseTexture.valid` / `Texture.valid` pair.
 * A `TextureSource` only carries a `resource` (ImageBitmap / canvas / video)
 * once its pixels exist, and its dimensions default to 1x1 — so neither can
 * stand in for readiness alone. Mirrors `SceneManager.isTextureReady`.
 */
function isTextureSourceReady(source: PIXI.TextureSource | null | undefined): boolean {
  if (!source) return false;
  return !!(source as { resource?: unknown }).resource
    && (source.width ?? 0) > 0
    && (source.height ?? 0) > 0;
}

function isRenderableTexture(texture: PIXI.Texture | null | undefined): texture is PIXI.Texture {
  if (!texture) {
    return false;
  }

  if (texture === PIXI.Texture.EMPTY || texture === PIXI.Texture.WHITE) {
    return false;
  }

  const source = texture.source;
  if (!isTextureSourceReady(source) || source === PIXI.Texture.EMPTY.source || source === PIXI.Texture.WHITE.source) {
    return false;
  }

  return true;
}

function isSymbolTextureCandidate(texture: PIXI.Texture | null | undefined): texture is PIXI.Texture {
  if (!texture) {
    return false;
  }

  return texture !== PIXI.Texture.EMPTY && texture !== PIXI.Texture.WHITE;
}

function toPositiveNumber(value: unknown, fallback: number): number {
  return Math.max(1, toNumber(value, fallback));
}

function toClampedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.round(toNumber(value, fallback));
  return Math.min(max, Math.max(min, parsed));
}

function normalizeSymbolEntries(
  rawEntries: Array<{ sprite: string; spineAnimation?: string; skin?: string; animatedSpriteAsset?: string; winAnimation?: string; landAnimation?: string; landAnimationEnabled?: boolean; landAnimationLoop?: boolean; scale?: number }> | undefined,
  fallbackSymbols: string[] | undefined,
): Array<{ sprite: string; spineAnimation?: string; skin?: string; animatedSpriteAsset?: string; winAnimation?: string; landAnimation?: string; landAnimationEnabled?: boolean; landAnimationLoop?: boolean; scale?: number }> {
  if (Array.isArray(rawEntries) && rawEntries.length > 0) {
    return rawEntries.map((entry) => ({
      sprite: typeof entry?.sprite === 'string' ? entry.sprite.trim() : '',
      spineAnimation: typeof entry?.spineAnimation === 'string' && entry.spineAnimation.trim().length > 0
        ? entry.spineAnimation.trim()
        : undefined,
      skin: typeof entry?.skin === 'string' && entry.skin.trim().length > 0
        ? entry.skin.trim()
        : undefined,
      animatedSpriteAsset: typeof entry?.animatedSpriteAsset === 'string' && entry.animatedSpriteAsset.trim().length > 0
        ? entry.animatedSpriteAsset.trim()
        : undefined,
      winAnimation: typeof entry?.winAnimation === 'string' && entry.winAnimation.trim().length > 0 ? entry.winAnimation.trim() : undefined,
      landAnimation: typeof entry?.landAnimation === 'string' && entry.landAnimation.trim().length > 0 ? entry.landAnimation.trim() : undefined,
      landAnimationEnabled: entry?.landAnimationEnabled === true ? true : undefined,
      landAnimationLoop: entry?.landAnimationLoop === true ? true : undefined,
      // Per-symbol render scale. Both normalizers do an EXPLICIT per-field
      // copy, so any new entry field has to be carried through here or it is
      // silently dropped before it ever reaches the visual resolver.
      // `undefined` is preserved (not defaulted to 1) so the "absent ⇒ 1"
      // clamp stays in exactly one place: `clampSymbolScale` at the read site.
      scale: Number.isFinite(Number(entry?.scale)) ? Number(entry?.scale) : undefined,
    }));
  }

  return (Array.isArray(fallbackSymbols) ? fallbackSymbols : []).map((sprite) => ({
    sprite: typeof sprite === 'string' ? sprite.trim() : '',
  }));
}

function ensureMinimumSymbolEntries(
  entries: Array<{ sprite: string; spineAnimation?: string; skin?: string; animatedSpriteAsset?: string; winAnimation?: string; landAnimation?: string; landAnimationEnabled?: boolean; landAnimationLoop?: boolean; scale?: number }>,
  reelCount: number,
  rowCount: number,
): Array<{ sprite: string; spineAnimation?: string; skin?: string; animatedSpriteAsset?: string; winAnimation?: string; landAnimation?: string; landAnimationEnabled?: boolean; landAnimationLoop?: boolean; scale?: number }> {
  const minimumCount = Math.max(1, reelCount * rowCount);
  const normalized = entries.slice();
  const sourceEntries: Array<{ sprite: string; spineAnimation?: string; skin?: string; animatedSpriteAsset?: string; winAnimation?: string; landAnimation?: string; landAnimationEnabled?: boolean; landAnimationLoop?: boolean; scale?: number }> = normalized.length > 0
    ? normalized.map((entry) => ({
      sprite: entry.sprite,
      spineAnimation: entry.spineAnimation,
      skin: entry.skin,
      animatedSpriteAsset: entry.animatedSpriteAsset,
      winAnimation: entry.winAnimation,
      landAnimation: entry.landAnimation,
      landAnimationEnabled: entry.landAnimationEnabled,
      landAnimationLoop: entry.landAnimationLoop,
      scale: entry.scale,
    }))
    : [{ sprite: '' }];

  while (normalized.length < minimumCount) {
    const source = sourceEntries[normalized.length % sourceEntries.length];
    normalized.push({
      sprite: source.sprite,
      spineAnimation: source.spineAnimation,
      skin: source.skin,
      animatedSpriteAsset: source.animatedSpriteAsset,
      winAnimation: source.winAnimation,
      landAnimation: source.landAnimation,
      landAnimationEnabled: source.landAnimationEnabled,
      landAnimationLoop: source.landAnimationLoop,
      scale: source.scale,
    });
  }

  return normalized;
}
// @flowstate-injection-end

// =========================================================================
// Winline player — sibling export (intentionally OUTSIDE the
// @flowstate-injection block so that template re-injection cannot clobber
// this runtime contract). The buildFlowstateReelsDisplay call above attaches
// an instance of `FlowstateReelsWinlinePlayer` onto the reels root container
// as `_flowstateReelsWinlinePlayer`. The flowstate methods file
// `methods/reels-winline.ts` resolves the target reels node, retrieves the
// player, and dispatches `playWinline` / `clearWinline` to it.
// =========================================================================

import { gsap } from 'gsap';
import { REELS_WINNING_MOTION_APPLIERS } from '../methods/reels-winline-motions';
import { REELS_WINLINE_PATH_APPLIERS } from '../methods/reels-winline-path-animations';
// Per-symbol win cue. Deliberately reuses the audio module's single alias
// registry + bus routing rather than re-registering sounds here.
import { playOrcaAudioPath } from '../methods/audio';

// =========================================================================
// Shared GSAP 3 tween cancellation.
//
// `@game-studio/generic-reels` 2.x peers on the same root `gsap` 3.x as
// this component and the winning-motion appliers. Its `TweenLite` + `Elastic`
// imports are GSAP 3 compatibility exports, not a separate GSAP 2 runtime.
// `GRReelView.defaultSpinBounceEffect` tweens each symbol's `y` at reel-stop;
// the public root API cancels that bounce as well as our presentation tweens.

function killGenericReelsBounceTween(view: PIXI.Container): void {
  // Transform points are distinct tween targets, not children of `view`
  // in GSAP's registry, so cancel them explicitly too.
  try { gsap.killTweensOf(view); } catch { /* no-op */ }
  try { gsap.killTweensOf(view.scale); } catch { /* no-op */ }
  try { gsap.killTweensOf(view.position); } catch { /* no-op */ }
}

export interface FlowstateReelGeometry {
  reelWrapper: PIXI.Container;
  reelView: PIXI.Container; // FlowstateInjectedReelView; kept loose so re-injection of the class doesn't break this type
  symbolWidth: number;
  symbolHeight: number;
  symbolSpacingY: number;
  maskTop: number;
  maskPadding: number;
  rowCount: number;
}

export interface FlowstateReelsWinlinePlayer {
  /** Each row is a per-reel row index. A row MAY be shorter than the reel
   *  count — reels without a supplied value are ignored. Empty rows and rows
   *  LONGER than the reel count are rejected, and validation stays
   *  all-or-nothing: one bad row rejects the whole call. Values must be
   *  INTEGERS in `[0, rowCount)` for their destination reel — fractional
   *  values are rejected, not rounded (matching the editor's winline preview). */
  playWinline(lines: number[][]): void;
  clearWinline(): void;
}

interface SymbolSnapshot {
  view: PIXI.Container;
  origTint: number;
  origAlpha: number;
  origScaleX: number;
  origScaleY: number;
  origX: number;
  origY: number;
  origRotation: number;
  origZIndex: number;
  /** The live spine's tint at snapshot time, or `null` when the symbol had no
   *  spine child. Tracked separately from `origTint` (the static sprite's)
   *  because a symbol mid-LAND renders through the spine, not the sprite. */
  origSpineTint: number | null;
  /** `true` if we toggled `parent.sortableChildren` on for the duration
   *  of the winline. Restored on clear (only if we set it). */
  weEnabledParentSortable: boolean;
}

export function createFlowstateReelsWinlinePlayer(
  root: PIXI.Container,
  node: FlowstateInjectedReelsConfig,
  geometries: FlowstateReelGeometry[],
  resolveTexture: (path: string, atlasPath?: string) => PIXI.Texture,
  scopeQualifyRef?: (ref: string) => string,
): FlowstateReelsWinlinePlayer {
  const reelCount = geometries.length;
  // Symbol IDs whose win cue has already fired for the CURRENT presentation.
  // A winline repeats the same symbol across cells and `'concurrent'` mode
  // presents several lines at once, so a per-cell play would stack N identical
  // one-shots into an audible flam. Reset by `clearLinePresentation`, so each
  // cycle step in `'cycle'` mode plays its cues afresh.
  const playedWinAudioSymbols = new Set<number>();
  const winlineGraphics: PIXI.Graphics[] = [];
  const winlineRopes: PIXI.MeshRope[] = [];
  const winlineSprites: PIXI.Sprite[] = [];
  const winlineContainers: PIXI.Container[] = [];
  const winlineMasks: PIXI.Graphics[] = [];
  const winlineFilters: PIXI.Filter[] = [];
  const winlineFilteredDisplays: PIXI.Container[] = [];
  const generatedGradientTextures: PIXI.Texture[] = [];
  const colorStripCache = new Map<string, Uint8ClampedArray>();
  let taperedAlphaTexture: PIXI.Texture | null = null;
  let trailAlphaTexture: PIXI.Texture | null = null;
  let dotMaskTexture: PIXI.Texture | null = null;
  const motionTweens: Array<gsap.core.Tween | gsap.core.Timeline> = [];
  const pathAnimTweens: Array<gsap.core.Tween | gsap.core.Timeline> = [];
  const winSymbolEffectCleanups: Array<() => void> = [];
  const touchedSymbols = new Map<PIXI.Container, SymbolSnapshot>();
  let cycleTween: gsap.core.Tween | null = null;
  let cycleActive = false;

  function readBehaviour() {
    const rawEntries = Array.isArray(node.winlineColors) ? node.winlineColors : [];
    const normalizedEntries: WinlineColorEntry[] = [];
    for (const entry of rawEntries.slice(0, 50)) {
      if (!entry || typeof entry !== 'object') continue;
      if ((entry as WinlineColorEntry).kind === 'solid' && typeof (entry as { color?: unknown }).color === 'number') {
        normalizedEntries.push({ kind: 'solid', color: (entry as { color: number }).color >>> 0 });
      } else if ((entry as WinlineColorEntry).kind === 'gradient' && Array.isArray((entry as { colors?: unknown }).colors)) {
        const colors = ((entry as { colors: unknown[] }).colors)
          .filter((c): c is number => typeof c === 'number')
          .map((c) => c >>> 0);
        if (colors.length >= 2) normalizedEntries.push({ kind: 'gradient', colors });
      }
    }
    const entries: WinlineColorEntry[] = normalizedEntries.length > 0
      ? normalizedEntries
      : [{ kind: 'solid', color: typeof node.winlineColor === 'number' ? (node.winlineColor >>> 0) : 0xffd700 }];
    const winningTweenDurationSec = typeof node.winningTweenDurationSec === 'number'
      ? Math.max(0.1, Math.min(10, node.winningTweenDurationSec))
      : 1;
    const winningTweenIntensity = typeof node.winningTweenIntensity === 'number'
      ? Math.max(0, Math.min(1, node.winningTweenIntensity))
      : 0.5;
    const winningTweenEase = typeof node.winningTweenEase === 'string' && node.winningTweenEase
      ? node.winningTweenEase
      : 'sine.inOut';
    const winlinePathAnimationDurationSec = typeof node.winlinePathAnimationDurationSec === 'number'
      ? Math.max(0.1, Math.min(10, node.winlinePathAnimationDurationSec))
      : 1;
    const winlinePathAnimationIntensity = typeof node.winlinePathAnimationIntensity === 'number'
      ? Math.max(0, Math.min(1, node.winlinePathAnimationIntensity))
      : 0.5;
    const winlinePathAnimationEase = typeof node.winlinePathAnimationEase === 'string' && node.winlinePathAnimationEase
      ? node.winlinePathAnimationEase
      : 'sine.inOut';
    // Normalize legacy `'drawOn'` literal that may still be present in
    // older exports → `'fadeIn'`.
    const rawPathAnim = (node.winlinePathAnimation as string | undefined) ?? 'none';
    const pathAnim: 'none' | 'fadeIn' | 'drawOnLeft' | 'drawOnRight' | 'pulse' | 'glow' | 'travel' | 'dash' =
      rawPathAnim === 'drawOn' ? 'fadeIn' : (rawPathAnim as any);
    const rawRopeStyle = (node.winlineRopeStyle as string | undefined) ?? 'plain';
    const ropeStyle: 'plain' | 'curved' | 'tapered' | 'trail' =
      (rawRopeStyle === 'curved' || rawRopeStyle === 'tapered' || rawRopeStyle === 'trail')
        ? rawRopeStyle
        : 'plain';
    return {
      winningSymbolBehavior: node.winningSymbolBehavior ?? 'playAnimation',
      nonWinningSymbolBehavior: node.nonWinningSymbolBehavior ?? 'none',
      winlineEntries: entries,
      winlineThickness: typeof node.winlineThickness === 'number' ? node.winlineThickness : 4,
      winlineAlpha: typeof node.winlineAlpha === 'number' ? node.winlineAlpha : 1,
      winlineLeadLength: typeof node.winlineLeadLength === 'number' ? node.winlineLeadLength : 40,
      symbolMode: node.symbolMode ?? 'spine',
      winSymbolEffect: node.winSymbolEffect ?? 'none',
      winningTweenStyle: node.winningTweenStyle ?? 'pulse',
      winningTweenDurationSec,
      winningTweenIntensity,
      winningTweenEase,
      nonWinningAlpha: typeof node.nonWinningAlpha === 'number' ? node.nonWinningAlpha : 0.3,
      nonWinningDarkenColor: typeof node.nonWinningDarkenColor === 'number' ? node.nonWinningDarkenColor : 0x485354,
      winlineDrawOrder: node.winlineDrawOrder ?? 'inFront',
      winlineCycleDelaySec: typeof node.winlineCycleDelaySec === 'number' ? node.winlineCycleDelaySec : 1.5,
      winlineMultiPlayMode: node.winlineMultiPlayMode ?? 'cycle',
      winlineFillMode: node.winlineFillMode ?? 'colors',
      winlineTexturePath: typeof node.winlineTexture === 'string' ? node.winlineTexture : '',
      winlineStrokeStyle: node.winlineStrokeStyle ?? 'solid',
      winlineDashLength: typeof node.winlineDashLength === 'number' ? node.winlineDashLength : 16,
      winlineDashGap: typeof node.winlineDashGap === 'number' ? node.winlineDashGap : 8,
      winlineDotSize: typeof node.winlineDotSize === 'number' ? node.winlineDotSize : 6,
      winlineDotGap: typeof node.winlineDotGap === 'number' ? node.winlineDotGap : 2,
      winlinePathAnimation: pathAnim,
      winlinePathAnimationDurationSec,
      winlinePathAnimationIntensity,
      winlinePathAnimationEase,
      winlineRopeStyle: ropeStyle,
      winlineGlowEnabled: node.winlineGlowEnabled === true,
      winlineGlowColor: typeof node.winlineGlowColor === 'number' ? (node.winlineGlowColor >>> 0) & 0xffffff : 0xffd700,
      winlineGlowDistance: typeof node.winlineGlowDistance === 'number'
        ? Math.max(0, Math.min(50, node.winlineGlowDistance))
        : 12,
      winlineGlowStrength: typeof node.winlineGlowStrength === 'number'
        ? Math.max(0, Math.min(10, node.winlineGlowStrength))
        : 2,
      winlineGlowAlpha: typeof node.winlineGlowAlpha === 'number'
        ? Math.max(0, Math.min(1, node.winlineGlowAlpha))
        : 1,
      winlineGlowQuality: typeof node.winlineGlowQuality === 'number'
        ? Math.max(0, Math.min(1, node.winlineGlowQuality))
        : 0.3,
    };
  }

  type Behaviour = ReturnType<typeof readBehaviour>;

  function validateLines(lines: unknown): number[][] | null {
    if (!Array.isArray(lines) || lines.length === 0) {
      console.warn('[FlowState/reels] playWinline: lines must be a non-empty array');
      return null;
    }
    const out: number[][] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // SHORT ROWS ARE ALLOWED: a row may supply fewer than `reelCount`
      // positions, leaving the remaining reels unselected. Empty rows and rows
      // LONGER than the reel count are still rejected. Validation stays
      // all-or-nothing — one bad row rejects the whole call.
      // Row values must be INTEGERS: fractional values are rejected (never
      // rounded) so this agrees with the editor's Pixi winline preview
      // (`Pixi8Adapter.previewWinline`), which rejects non-integers too.
      if (!Array.isArray(line) || line.length === 0 || line.length > reelCount) {
        console.warn(`[FlowState/reels] playWinline: line ${i} must be a non-empty number[] of length <= ${reelCount}`);
        return null;
      }
      const lineOut: number[] = [];
      for (let r = 0; r < line.length; r += 1) {
        const v = line[r];
        const rowCountAt = geometries[r]?.rowCount ?? 0;
        // Integer check FIRST, so a fractional value reports as "not an
        // integer" rather than being rounded into (or out of) range.
        if (typeof v !== 'number' || !Number.isFinite(v) || Math.floor(v) !== v) {
          console.warn(`[FlowState/reels] playWinline: line ${i} entry ${r} = ${v} must be an integer row index`);
          return null;
        }
        if (v < 0 || v >= rowCountAt) {
          console.warn(`[FlowState/reels] playWinline: line ${i} entry ${r} = ${v} is out of [0, ${rowCountAt}) range`);
          return null;
        }
        lineOut.push(v);
      }
      out.push(lineOut);
    }
    return out;
  }

  // Cell → symbol-view resolution is the SHARED module-scope
  // `getReelRowCenterY` / `resolveReelSymbolViewForCell` pair (see the
  // "Shared reel-cell resolution" block above) so the winline presentation
  // and the FlowState per-cell handles can never disagree.

  function snapshotSymbol(view: PIXI.Container): SymbolSnapshot {
    const anyView = view as any;
    const sprite = anyView.sprite as PIXI.Sprite | undefined;
    const spine = findChildSpine(view);
    const origTint = typeof sprite?.tint === 'number' ? sprite.tint : 0xffffff;
    // While a spine is live (mid-LAND, or a track-1 win) `applySkin` parks the
    // static sprite at `alpha = 0` / `visible = false`. That is a transient
    // SENTINEL, not the symbol's resting appearance — capturing it would make
    // `clearLinePresentation` write `alpha = 0` back onto a sprite that has
    // since been re-shown by `restoreStaticAfterSpine`, blanking the symbol
    // until the next spin. `showStaticSprite` always restores `alpha = 1` on
    // its renderable path, so 1 IS the correct resting value here.
    const spriteParked = !!sprite && (sprite.visible === false || sprite.alpha === 0);
    const origAlpha = sprite && !spriteParked
      ? sprite.alpha
      : (sprite ? 1 : view.alpha);
    return {
      view,
      origTint,
      origAlpha,
      origScaleX: view.scale.x,
      origScaleY: view.scale.y,
      origX: view.position.x,
      origY: view.position.y,
      origRotation: view.rotation,
      origZIndex: typeof view.zIndex === 'number' ? view.zIndex : 0,
      origSpineTint: spine ? readSpineTint(spine) : null,
      weEnabledParentSortable: false,
    };
  }

  /** PIXI 8 `Spine` extends `Container`, which has a native `tint` accessor
   *  (hex, 0xffffff = untinted). Read defensively — a runtime that lacks it
   *  reports `null` and is left alone. */
  function readSpineTint(spine: Spine): number | null {
    try {
      const t = spine.tint;
      return typeof t === 'number' ? t : null;
    } catch {
      return null;
    }
  }

  function applyTint(view: PIXI.Container, tint: number): void {
    const sprite = (view as any).sprite as PIXI.Sprite | undefined;
    if (sprite) sprite.tint = tint;
    // ALSO tint a live spine. A symbol that is still playing its LAND animation
    // renders through the spine with the sprite hidden, so a sprite-only tint
    // is INVISIBLE — and then `restoreStaticAfterSpine(resetTint = false)`
    // deliberately preserves it, so the symbol suddenly goes dark when its land
    // finishes. With per-reel stop stagger and a land shorter than the
    // presentation delay, that reads as "symbols dim one reel at a time as each
    // reel stops" instead of one clean simultaneous dim.
    const spine = findChildSpine(view);
    if (spine) {
      try {
        if (typeof spine.tint === 'number') spine.tint = tint;
      } catch { /* no-op — sprite tint already applied */ }
    }
  }

  function applyAlpha(view: PIXI.Container, alpha: number): void {
    const sprite = (view as any).sprite as PIXI.Sprite | undefined;
    if (sprite) sprite.alpha = alpha;
    else view.alpha = alpha;
    // Same reasoning as `applyTint`: `Spine` is a `Container`, so alpha works
    // directly and a live spine must dim with its static twin.
    const spine = findChildSpine(view);
    if (spine) spine.alpha = alpha;
  }

  function findChildSpine(view: PIXI.Container): Spine | null {
    for (const child of view.children) {
      if (child instanceof Spine) return child;
    }
    return null;
  }

  function findChildAnimatedSprite(view: PIXI.Container): PIXI.AnimatedSprite | null {
    for (const child of view.children) {
      if (child instanceof PIXI.AnimatedSprite) return child;
    }
    return null;
  }

  /**
   * Fire the symbol's authored win cue, at most once per DISTINCT symbol id
   * per presentation (see `playedWinAudioSymbols`). Fire-and-forget and
   * entirely non-fatal: a missing file, an unregistered alias or a rejected
   * promise warns and leaves the win presentation untouched.
   */
  function playSymbolWinAudio(skinIndex: number): void {
    if (!Number.isInteger(skinIndex) || skinIndex < 0) return;
    if (playedWinAudioSymbols.has(skinIndex)) return;
    const raw = node.symbolEntries?.[skinIndex]?.winAudio;
    const ref = typeof raw === 'string' ? raw.trim() : '';
    if (!ref) return;
    // Claim the symbol BEFORE the async play so sibling cells in the same
    // presentation pass can't race past the dedup check.
    playedWinAudioSymbols.add(skinIndex);
    // The sound-manager alias IS the path, so scope-qualify it (`core/<ref>` /
    // `skins/<skin>/<ref>`) or two same-basename files would share one alias.
    const scopedPath = scopeQualifyRef ? scopeQualifyRef(ref) : ref;
    try {
      void playOrcaAudioPath(scopedPath, { label: 'reels winAudio' }).catch((err) => {
        console.warn('[FlowState/reels] playWinline: win audio failed', { path: scopedPath, error: err });
      });
    } catch (err) {
      console.warn('[FlowState/reels] playWinline: win audio failed', { path: scopedPath, error: err });
    }
  }

  function playWinAnimation(view: PIXI.Container, symbolMode: string): void {
    // `symbolData.skin` is the NUMBER index into symbolEntries (NOT the spine
    // skin string) and is populated in BOTH symbol modes, so the per-symbol
    // audio lookup is mode-independent.
    const rawSkinIndex = (view as any).symbolData?.skin;
    const skinIndex = typeof rawSkinIndex === 'number' ? rawSkinIndex : -1;
    playSymbolWinAudio(skinIndex);

    // Drive inner spine / animatedSprite frame playback only — container
    // transform is owned by applyWinningTween.
    if (symbolMode === 'spine') {
      // Symbols only hold a live spine while a land animation is playing, so
      // by win time most cells are back on the baked static sprite with no
      // spine child at all — build one on demand rather than silently
      // skipping the win. `playSpineTrack` also re-reveals the spine, which
      // covers the GR `setStaticSkin()` (force-display / snapshot) that can
      // land between reel-stop and win presentation.
      const symbolView = view instanceof FlowstateInjectedSymbolView ? view : null;
      const spine = symbolView ? symbolView.ensureSpineForWin() : findChildSpine(view);
      if (spine) {
        // Per-symbol win animation NAME. Look up the entry's `winAnimation`
        // and fall back to the historical hardcoded 'win' so existing
        // projects keep working. Win plays on track 1 so it can overlay any
        // looped land animation on track 0.
        const entry = skinIndex >= 0 ? node.symbolEntries?.[skinIndex] : undefined;
        const winName = (entry?.winAnimation || 'win').trim() || 'win';
        if (spine.skeleton.data.findAnimation(winName)) {
          try {
            if (symbolView) {
              symbolView.playSpineTrack(1, winName, false);
            } else {
              spine.state.setAnimation(1, winName, false);
            }
          } catch (err) {
            console.warn('[FlowState/reels] playWinline: spine win animation failed', { winName, error: err });
          }
        }
      }
    } else if (symbolMode === 'sprite' || symbolMode === 'animatedSprite') {
      const anim = findChildAnimatedSprite(view);
      if (anim) {
        try {
          anim.gotoAndPlay(0);
        } catch (err) {
          console.warn('[FlowState/reels] playWinline: animatedSprite play failed', err);
        }
      }
    }
  }

  // Per-win visual effect (sheen / glow / pulse) layered on top of the
  // winning tween. Each effect returns a cleanup function which is run by
  // clearLinePresentation when the winline is dismissed or cycles.
  function applyWinSymbolEffect(view: PIXI.Container, effect: 'none' | 'sheen' | 'glow' | 'pulse'): void {
    if (!effect || effect === 'none') return;
    try {
      if (effect === 'pulse') {
        const tween = gsap.to(view.scale, {
          x: view.scale.x * 1.15,
          y: view.scale.y * 1.15,
          duration: 0.15,
          yoyo: true,
          repeat: 1,
          ease: 'sine.inOut',
          overwrite: 'auto',
        });
        winSymbolEffectCleanups.push(() => { try { tween.kill(); } catch { /* no-op */ } });
        return;
      }

      if (effect === 'glow') {
        // GlowFilter is a `pixi-filters` export and is pulsed via its `alpha`
        // accessor; the BlurFilter fallback (core `pixi.js`) has no `alpha`, so
        // the pulse is a no-op there exactly as it was under Pixi 6.
        const glow = new GlowFilter({ distance: 12, outerStrength: 2.5, innerStrength: 0, color: 0xffffff, quality: 0.3 });
        const appliedFilter: PIXI.Filter = glow;
        // Pixi's FilterSystem keys its render-target pool from the filter's
        // resolution on first use — must be set BEFORE assignment to
        // `view.filters`, otherwise the win-tween shake renders the glow at
        // the default resolution=1 and looks soft/jittery.
        try { appliedFilter.resolution = getRendererResolution(); } catch { /* no-op */ }
        // Whole-array reassignment: `Container.filters` reads back READONLY in
        // Pixi 8, so an in-place push would not register the new filter.
        const prevFilters = view.filters ? view.filters.slice() : [];
        view.filters = [...prevFilters, appliedFilter];
        const refTarget = { v: 0 };
        const tween = gsap.to(refTarget, {
          v: 1,
          duration: 0.5,
          yoyo: true,
          repeat: -1,
          ease: 'sine.inOut',
          onUpdate: () => {
            glow.alpha = 0.4 + 0.6 * refTarget.v;
          },
        });
        winSymbolEffectCleanups.push(() => {
          try { tween.kill(); } catch { /* no-op */ }
          try {
            const next = (view.filters ?? []).filter(f => f !== appliedFilter);
            view.filters = next.length > 0 ? next : null;
          } catch { /* no-op */ }
        });
        return;
      }

      if (effect === 'sheen') {
        // Horizontal gradient sheen (transparent → white → transparent)
        // translated left-to-right across the symbol bounds, masked to the
        // symbol's frame.
        const bounds = view.getLocalBounds();
        const w = Math.max(1, bounds.width);
        const h = Math.max(1, bounds.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(2, Math.floor(w));
        canvas.height = Math.max(2, Math.floor(h));
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
        grad.addColorStop(0.0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.85)');
        grad.addColorStop(1.0, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const sheenTex = PIXI.Texture.from(canvas);
        const overlay = new PIXI.Sprite(sheenTex);
        overlay.width = w * 0.5;
        overlay.height = h;
        overlay.position.set(bounds.x - overlay.width, bounds.y);
        const mask = new PIXI.Graphics();
        mask
          .rect(bounds.x, bounds.y, w, h)
          .fill({ color: 0xffffff, alpha: 1 });
        overlay.mask = mask;
        view.addChild(mask);
        view.addChild(overlay);
        const tween = gsap.to(overlay, {
          x: bounds.x + w,
          duration: 0.4,
          ease: 'sine.inOut',
        });
        winSymbolEffectCleanups.push(() => {
          try { tween.kill(); } catch { /* no-op */ }
          try { if (overlay.parent) overlay.parent.removeChild(overlay); overlay.destroy(); } catch { /* no-op */ }
          try { if (mask.parent) mask.parent.removeChild(mask); mask.destroy(); } catch { /* no-op */ }
          try { sheenTex.destroy(true); } catch { /* no-op */ }
        });
        return;
      }
    } catch (err) {
      console.warn('[FlowState/reels] win-symbol effect failed', effect, err);
    }
  }

  function applyWinningTween(view: PIXI.Container, _snap: SymbolSnapshot, style: Behaviour): void {
    const styleKey = style.winningTweenStyle;
    const applier = REELS_WINNING_MOTION_APPLIERS[styleKey] ?? REELS_WINNING_MOTION_APPLIERS.none;
    const tween = applier(
      view,
      style.winningTweenDurationSec,
      style.winningTweenIntensity,
      style.winningTweenEase,
    );
    if (tween) motionTweens.push(tween);
  }

  function getCellCenterInRootSpace(geom: FlowstateReelGeometry, rowIndex: number): { x: number; y: number } {
    const localX = geom.symbolWidth * 0.5;
    const localY = getReelRowCenterY(geom, rowIndex);
    const global = geom.reelView.toGlobal(new PIXI.Point(localX, localY));
    return root.toLocal(global);
  }

  function subdividePath(points: PIXI.Point[], maxSegmentLength: number): PIXI.Point[] {
    const max = Math.max(2, maxSegmentLength);
    const out: PIXI.Point[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      out.push(new PIXI.Point(a.x, a.y));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(0, Math.floor(dist / max) - 1);
      for (let s = 1; s <= steps; s += 1) {
        const t = s / (steps + 1);
        out.push(new PIXI.Point(a.x + dx * t, a.y + dy * t));
      }
    }
    const last = points[points.length - 1];
    out.push(new PIXI.Point(last.x, last.y));
    return out;
  }

  /** Catmull-Rom subdivision: emits `samplesPerSegment` interior samples
   *  per source segment, producing a smooth curve through all control
   *  points. Used when `winlineRopeStyle === 'curved'`. */
  function catmullRomSubdivide(points: PIXI.Point[], samplesPerSegment: number): PIXI.Point[] {
    if (points.length < 2) return points.slice();
    const out: PIXI.Point[] = [];
    const n = points.length;
    const samples = Math.max(2, samplesPerSegment | 0);
    for (let i = 0; i < n - 1; i += 1) {
      const p0 = points[i - 1] ?? points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] ?? p2;
      for (let s = 0; s < samples; s += 1) {
        const t = s / samples;
        const t2 = t * t;
        const t3 = t2 * t;
        const x = 0.5 * (
          (2 * p1.x) +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
        );
        const y = 0.5 * (
          (2 * p1.y) +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
        );
        out.push(new PIXI.Point(x, y));
      }
    }
    const last = points[n - 1];
    out.push(new PIXI.Point(last.x, last.y));
    return out;
  }

  /** Total Euclidean arc-length of a polyline. */
  function computePolylineLength(pts: PIXI.Point[]): number {
    let total = 0;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const dx = pts[i + 1].x - pts[i].x;
      const dy = pts[i + 1].y - pts[i].y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
  }

  /** Sample the point at arc-length `arcLen` along the polyline. */
  function samplePolylineAt(pts: PIXI.Point[], arcLen: number): { x: number; y: number } | null {
    if (pts.length < 2) return null;
    let remaining = Math.max(0, arcLen);
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (remaining <= segLen) {
        const t = segLen > 0 ? remaining / segLen : 0;
        return { x: a.x + dx * t, y: a.y + dy * t };
      }
      remaining -= segLen;
    }
    const last = pts[pts.length - 1];
    return { x: last.x, y: last.y };
  }

  /** Return `steps + 1` points evenly sampled in arc-length between
   *  `startArc` and `endArc`. Used to build per-dash MeshRope segments. */
  function samplePolylineRange(
    pts: PIXI.Point[],
    startArc: number,
    endArc: number,
    steps: number,
  ): PIXI.Point[] {
    const out: PIXI.Point[] = [];
    const n = Math.max(2, steps | 0);
    for (let i = 0; i <= n; i += 1) {
      const t = i / n;
      const arc = startArc + (endArc - startArc) * t;
      const p = samplePolylineAt(pts, arc);
      if (p) out.push(new PIXI.Point(p.x, p.y));
    }
    return out;
  }

  /** Build a 256-wide RGBA color-strip from N gradient stops. Used to
   *  sample dot tints in dotted+gradient mode without rebuilding a
   *  PIXI.Texture. */
  function buildColorStripFromColors(colors: number[]): Uint8ClampedArray {
    const w = 256;
    const out = new Uint8ClampedArray(w * 4);
    const n = Math.max(2, colors.length);
    for (let i = 0; i < w; i += 1) {
      const t = i / (w - 1);
      const f = t * (n - 1);
      const lo = Math.floor(f);
      const hi = Math.min(n - 1, lo + 1);
      const k = f - lo;
      const c0 = (colors[lo] ?? 0xffffff) >>> 0;
      const c1 = (colors[hi] ?? 0xffffff) >>> 0;
      const r = Math.round(((c0 >> 16) & 0xff) * (1 - k) + ((c1 >> 16) & 0xff) * k);
      const g = Math.round(((c0 >> 8) & 0xff) * (1 - k) + ((c1 >> 8) & 0xff) * k);
      const b = Math.round((c0 & 0xff) * (1 - k) + (c1 & 0xff) * k);
      const o = i * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
    return out;
  }

  function getColorStrip(colors: number[]): Uint8ClampedArray {
    const key = colors.map(c => (c >>> 0).toString(16).padStart(6, '0')).join('-');
    let strip = colorStripCache.get(key);
    if (!strip) {
      strip = buildColorStripFromColors(colors);
      colorStripCache.set(key, strip);
    }
    return strip;
  }

  function sampleColorStrip(strip: Uint8ClampedArray, t: number): number {
    const i = Math.max(0, Math.min(255, Math.floor(t * 256)));
    const o = i * 4;
    return (strip[o] << 16) | (strip[o + 1] << 8) | strip[o + 2];
  }

  function buildTaperedAlphaTexture(): PIXI.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 8;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0.0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,1)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 8);
    const tex = PIXI.Texture.from(canvas);
    generatedGradientTextures.push(tex);
    return tex;
  }

  function buildTrailAlphaTexture(): PIXI.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 8;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0.0, 'rgba(255,255,255,0)');
    grad.addColorStop(1.0, 'rgba(255,255,255,1)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 8);
    const tex = PIXI.Texture.from(canvas);
    generatedGradientTextures.push(tex);
    return tex;
  }

  function buildDotMaskTexture(): PIXI.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    const tex = PIXI.Texture.from(canvas);
    generatedGradientTextures.push(tex);
    return tex;
  }

  function isTextureUsable(texture: PIXI.Texture | null | undefined): boolean {
    if (!texture) return false;
    try {
      if (!isTextureSourceReady(texture.source)) return false;
      const w = texture.width;
      const h = texture.height;
      return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
    } catch {
      return false;
    }
  }

  const gradientTextureCache = new Map<string, PIXI.Texture>();

  function buildGradientTextureFromColors(colors: number[]): PIXI.Texture | null {
    if (!Array.isArray(colors) || colors.length < 2) return null;
    const normalized = colors.map((c) => ((Number(c) >>> 0) & 0xffffff));
    const key = normalized.map((c) => c.toString(16).padStart(6, '0')).join('-');
    const cached = gradientTextureCache.get(key);
    if (cached) return cached;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 8;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const toHex = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
      const grad = ctx.createLinearGradient(0, 0, 256, 0);
      const denom = Math.max(1, normalized.length - 1);
      for (let i = 0; i < normalized.length; i += 1) {
        grad.addColorStop(i / denom, toHex(normalized[i]));
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 8);
      const tex = PIXI.Texture.from(canvas);
      generatedGradientTextures.push(tex);
      gradientTextureCache.set(key, tex);
      return tex;
    } catch (err) {
      console.warn('[FlowState/reels] gradient texture build failed', err);
      return null;
    }
  }

  function drawDashedPolyline(
    g: PIXI.Graphics,
    points: PIXI.Point[],
    dashLength: number,
    dashGap: number,
    thickness: number,
    color: number,
    alpha: number,
  ): void {
    g.setStrokeStyle({ width: thickness, color, alpha });
    const period = Math.max(0.001, dashLength + dashGap);
    let carry = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen <= 0) continue;
      const ux = dx / segLen;
      const uy = dy / segLen;
      let cursor = 0;
      while (cursor < segLen) {
        const inPeriod = carry;
        const isDash = inPeriod < dashLength;
        const remainingInPhase = isDash ? (dashLength - inPeriod) : (period - inPeriod);
        const advance = Math.min(remainingInPhase, segLen - cursor);
        if (isDash) {
          g.moveTo(a.x + ux * cursor, a.y + uy * cursor);
          g.lineTo(a.x + ux * (cursor + advance), a.y + uy * (cursor + advance));
        }
        cursor += advance;
        carry = (carry + advance) % period;
      }
    }
    // Pixi 8 needs an explicit paint call: `setStrokeStyle` alone only arms the
    // style, so every dash subpath stays unrendered without this.
    g.stroke();
  }

  function drawDottedPolyline(
    g: PIXI.Graphics,
    points: PIXI.Point[],
    dotSize: number,
    dotGap: number,
    color: number,
    alpha: number,
  ): void {
    const radius = Math.max(0.5, dotSize / 2);
    const period = Math.max(0.001, dotSize + dotGap);
    let carry = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen <= 0) continue;
      const ux = dx / segLen;
      const uy = dy / segLen;
      let cursor = carry;
      while (cursor <= segLen) {
        g.circle(a.x + ux * cursor, a.y + uy * cursor, radius);
        cursor += period;
      }
      carry = cursor - segLen;
    }
    // One fill for every accumulated dot subpath — the Pixi 8 inversion of the
    // old beginFill → draw → endFill order.
    g.fill({ color, alpha });
  }

  function drawSingleWinline(line: number[], lineIndex: number, style: Behaviour): void {
    const entries = style.winlineEntries;
    const entry = entries[lineIndex % entries.length];
    const entryIsGradient = entry.kind === 'gradient';
    const entrySolidColor = entryIsGradient
      ? (((entry.colors[0] ?? 0xffd700) >>> 0) & 0xffffff)
      : ((entry.color >>> 0) & 0xffffff);

    // Build raw path points (one per selected reel + lead extensions).
    const rawPoints: PIXI.Point[] = [];
    const first = getCellCenterInRootSpace(geometries[0], line[0]);
    rawPoints.push(new PIXI.Point(first.x - style.winlineLeadLength, first.y));
    rawPoints.push(new PIXI.Point(first.x, first.y));
    for (let r = 1; r < line.length; r += 1) {
      const pt = getCellCenterInRootSpace(geometries[r], line[r]);
      rawPoints.push(new PIXI.Point(pt.x, pt.y));
    }
    const lastReelIndex = line.length - 1;
    const last = getCellCenterInRootSpace(geometries[lastReelIndex], line[lastReelIndex]);
    rawPoints.push(new PIXI.Point(last.x + style.winlineLeadLength, last.y));
    if (rawPoints.length < 2) return;

    let display: PIXI.Container | null = null;
    const strokeStyle = style.winlineStrokeStyle;
    const fillMode = style.winlineFillMode;
    const thickness = Math.max(1, style.winlineThickness);
    const alpha = Math.max(0, Math.min(1, style.winlineAlpha));

    // Tapered / trail rope styles require contiguous ropes; ignore them
    // (treat as 'plain') when stroke style is dashed/dotted.
    let ropeStyle = style.winlineRopeStyle;
    if (strokeStyle !== 'solid' && (ropeStyle === 'tapered' || ropeStyle === 'trail')) {
      ropeStyle = 'plain';
    }

    // Resolve fill-side data once.
    let fillTexture: PIXI.Texture | null = null;
    let fillColorStops: number[] | null = null;
    if (fillMode === 'texture' && style.winlineTexturePath) {
      try {
        const resolved = resolveTexture(style.winlineTexturePath);
        fillTexture = isTextureUsable(resolved) ? resolved : null;
      } catch (err) {
        console.warn('[FlowState/reels] winlineTexture resolve failed', err);
        fillTexture = null;
      }
    } else if (entryIsGradient) {
      fillTexture = buildGradientTextureFromColors(entry.colors);
      fillColorStops = entry.colors;
    }

    // Subdivision points used by solid-stroke ropes / fallback graphics.
    const subdividedPoints = ropeStyle === 'curved'
      ? catmullRomSubdivide(rawPoints, 16)
      : subdividePath(rawPoints, 2);

    // ── DASHED / DOTTED ─────────────────────────────────────────────────
    if (strokeStyle !== 'solid') {
      const useFancy = !!fillTexture; // gradient or texture fill
      if (strokeStyle === 'dashed') {
        const dashLen = Math.max(2, Math.min(100, style.winlineDashLength || 16));
        const dashGap = Math.max(0, Math.min(100, style.winlineDashGap || 8));
        if (useFancy && fillTexture) {
          // Per-dash MeshRope segments, each carrying a UV-sliced sub-
          // texture so the gradient/texture flows continuously across
          // gaps (visually equivalent to drawing a full-length rope with
          // dashed mask cutouts).
          const container = new PIXI.Container();
          const totalLen = computePolylineLength(rawPoints);
          const texW = Math.max(1, fillTexture.width || 1);
          const texH = Math.max(1, fillTexture.height || 1);
          const period = Math.max(0.001, dashLen + dashGap);
          for (let arcCursor = 0; arcCursor < totalLen; arcCursor += period) {
            const start = arcCursor;
            const end = Math.min(totalLen, arcCursor + dashLen);
            const segPts = samplePolylineRange(rawPoints, start, end, 4);
            if (segPts.length < 2) continue;
            const u0 = start / totalLen;
            const u1 = end / totalLen;
            const frameX = u0 * texW;
            const frameW = Math.max(1, (u1 - u0) * texW);
            try {
              const sliced = new PIXI.Texture({
                source: fillTexture.source,
                frame: new PIXI.Rectangle(frameX, 0, frameW, texH),
              });
              generatedGradientTextures.push(sliced);
              const rope = new PIXI.MeshRope({ texture: sliced, points: segPts });
              rope.scale.y = thickness / texH;
              rope.alpha = alpha;
              container.addChild(rope);
              winlineRopes.push(rope);
            } catch (err) {
              console.warn('[FlowState/reels] dashed-rope segment failed', err);
            }
          }
          display = container;
          winlineContainers.push(container);
        } else {
          const g = new PIXI.Graphics();
          drawDashedPolyline(g, rawPoints, dashLen, dashGap, thickness, entrySolidColor, alpha);
          display = g;
          winlineGraphics.push(g);
        }
      } else {
        const dotSize = Math.max(1, Math.min(50, style.winlineDotSize || 6));
        const dotGap = Math.max(0, Math.min(50, style.winlineDotGap || 2));
        if (useFancy) {
          if (!dotMaskTexture) dotMaskTexture = buildDotMaskTexture();
          const strip = fillColorStops ? getColorStrip(fillColorStops) : null;
          const container = new PIXI.Container();
          const totalLen = computePolylineLength(rawPoints);
          const period = Math.max(0.001, dotSize + dotGap);
          for (let arcCursor = 0; arcCursor <= totalLen; arcCursor += period) {
            const p = samplePolylineAt(rawPoints, arcCursor);
            if (!p) continue;
            const sprite = new PIXI.Sprite(dotMaskTexture);
            sprite.anchor.set(0.5);
            sprite.width = dotSize;
            sprite.height = dotSize;
            sprite.position.set(p.x, p.y);
            sprite.alpha = alpha;
            if (strip) {
              const t = totalLen > 0 ? arcCursor / totalLen : 0;
              sprite.tint = sampleColorStrip(strip, t);
            } else {
              // Texture fill without a cheap CPU strip: tint white so the
              // dot reads as a desaturated speck. (Full texture-sampled
              // dots would need a render-texture readback — out of scope.)
              sprite.tint = 0xffffff;
            }
            container.addChild(sprite);
            winlineSprites.push(sprite);
          }
          display = container;
          winlineContainers.push(container);
        } else {
          const g = new PIXI.Graphics();
          drawDottedPolyline(g, rawPoints, dotSize, dotGap, entrySolidColor, alpha);
          display = g;
          winlineGraphics.push(g);
        }
      }
    } else if (fillTexture) {
      // ── SOLID stroke with gradient / texture fill ────────────────────
      try {
        if (ropeStyle === 'tapered' || ropeStyle === 'trail') {
          // Stack the base gradient/texture rope with a tapered alpha-
          // mask rope on top, multiply-blended so the alpha gradient
          // attenuates the base.
          const container = new PIXI.Container();
          const baseRope = new PIXI.MeshRope({ texture: fillTexture, points: subdividedPoints });
          baseRope.scale.y = thickness / Math.max(1, fillTexture.height || 1);
          baseRope.alpha = alpha;
          container.addChild(baseRope);
          winlineRopes.push(baseRope);
          const maskTex = ropeStyle === 'tapered'
            ? (taperedAlphaTexture ??= buildTaperedAlphaTexture())
            : (trailAlphaTexture ??= buildTrailAlphaTexture());
          const maskRope = new PIXI.MeshRope({ texture: maskTex, points: subdividedPoints });
          maskRope.scale.y = thickness / Math.max(1, maskTex.height || 1);
          maskRope.alpha = alpha;
          maskRope.blendMode = 'multiply';
          container.addChild(maskRope);
          winlineRopes.push(maskRope);
          if (ropeStyle === 'trail') {
            const tweenState = { v: 0 };
            const tween = gsap.to(tweenState, {
              v: 1,
              duration: 1.5,
              repeat: -1,
              ease: 'none',
              onUpdate: () => {
                try {
                  const w = maskTex.width || 1;
                  if (maskTex.frame) {
                    maskTex.frame.x = -tweenState.v * w;
                    (maskTex as any).updateUvs?.();
                  }
                } catch { /* no-op */ }
              },
            });
            pathAnimTweens.push(tween);
          }
          display = container;
          winlineContainers.push(container);
        } else {
          const rope = new PIXI.MeshRope({ texture: fillTexture, points: subdividedPoints });
          const texHeight = Math.max(1, fillTexture.height || 1);
          rope.scale.y = thickness / texHeight;
          rope.alpha = alpha;
          display = rope;
          winlineRopes.push(rope);
        }
      } catch (err) {
        console.warn('[FlowState/reels] MeshRope construction failed; falling back to solid', err);
        display = null;
      }
    }

    if (!display) {
      // No gradient/texture fill — render a tinted alpha-mask rope for
      // tapered/trail, otherwise fall back to a plain Graphics polyline.
      if (ropeStyle === 'tapered' || ropeStyle === 'trail') {
        try {
          const maskTex = ropeStyle === 'tapered'
            ? (taperedAlphaTexture ??= buildTaperedAlphaTexture())
            : (trailAlphaTexture ??= buildTrailAlphaTexture());
          const rope = new PIXI.MeshRope({ texture: maskTex, points: subdividedPoints });
          rope.scale.y = thickness / Math.max(1, maskTex.height || 1);
          rope.alpha = alpha;
          rope.tint = entrySolidColor;
          display = rope;
          winlineRopes.push(rope);
          if (ropeStyle === 'trail') {
            const tweenState = { v: 0 };
            const tween = gsap.to(tweenState, {
              v: 1,
              duration: 1.5,
              repeat: -1,
              ease: 'none',
              onUpdate: () => {
                try {
                  const w = maskTex.width || 1;
                  if (maskTex.frame) {
                    maskTex.frame.x = -tweenState.v * w;
                    (maskTex as any).updateUvs?.();
                  }
                } catch { /* no-op */ }
              },
            });
            pathAnimTweens.push(tween);
          }
        } catch { display = null; }
      }
      if (!display) {
        const g = new PIXI.Graphics();
        g.setStrokeStyle({ width: thickness, color: entrySolidColor, alpha });
        g.moveTo(subdividedPoints[0].x, subdividedPoints[0].y);
        for (let i = 1; i < subdividedPoints.length; i += 1) {
          g.lineTo(subdividedPoints[i].x, subdividedPoints[i].y);
        }
        g.stroke();
        display = g;
        winlineGraphics.push(g);
      }
    }

    // ── Glow filter (pixi-filters GlowFilter) ───────────────────────────
    if (style.winlineGlowEnabled) {
      const f = new GlowFilter({
        distance: style.winlineGlowDistance,
        outerStrength: style.winlineGlowStrength,
        innerStrength: 0,
        color: style.winlineGlowColor,
        quality: style.winlineGlowQuality,
      });
      // Must set BEFORE assignment (FilterSystem caches its pool key).
      try { f.resolution = getRendererResolution(); } catch { /* no-op */ }
      (display as PIXI.Container).filters = [f];
      (display as PIXI.Container).alpha *= style.winlineGlowAlpha;
      winlineFilters.push(f);
      winlineFilteredDisplays.push(display);
    }

    if (style.winlineDrawOrder === 'behind') {
      root.addChildAt(display, 0);
    } else {
      root.addChild(display);
    }

    // ── Path animation ──────────────────────────────────────────────────
    const pathAnim = style.winlinePathAnimation;
    if (pathAnim === 'drawOnLeft' || pathAnim === 'drawOnRight') {
      // Inline progressive-reveal via a rectangular mask sweeping along
      // the local bounds. Works uniformly for Graphics, MeshRope, and
      // Container displays — no per-display-type point manipulation.
      try {
        const bounds = (display as PIXI.Container).getLocalBounds();
        if (bounds.width > 0 && bounds.height > 0) {
          const mask = new PIXI.Graphics();
          (display as PIXI.Container).addChild(mask);
          (display as PIXI.Container).mask = mask;
          winlineMasks.push(mask);
          const padY = thickness; // ensure mask covers full rope thickness
          const tweenState = { t: 0 };
          const baseAlpha = (display as PIXI.Container).alpha;
          const tween = gsap.to(tweenState, {
            t: 1,
            duration: Math.max(0.1, style.winlinePathAnimationDurationSec),
            repeat: -1,
            ease: style.winlinePathAnimationEase,
            onUpdate: () => {
              const t = tweenState.t;
              mask.clear();
              if (pathAnim === 'drawOnLeft') {
                mask.rect(bounds.x, bounds.y - padY, bounds.width * t, bounds.height + padY * 2);
              } else {
                const x = bounds.x + bounds.width * (1 - t);
                mask.rect(x, bounds.y - padY, bounds.width * t, bounds.height + padY * 2);
              }
              mask.fill({ color: 0xffffff, alpha: 1 });
              (display as PIXI.Container).alpha = baseAlpha;
            },
          });
          pathAnimTweens.push(tween);
        }
      } catch (err) {
        console.warn('[FlowState/reels] progressive reveal failed', err);
      }
    } else if (pathAnim !== 'none') {
      const applier = REELS_WINLINE_PATH_APPLIERS[pathAnim];
      if (applier) {
        const tween = applier(
          { display: display as { alpha: number }, origin: { alpha } },
          style.winlinePathAnimationDurationSec,
          style.winlinePathAnimationIntensity,
          style.winlinePathAnimationEase,
        );
        if (tween) pathAnimTweens.push(tween);
      }
    }
  }

  function clearLinePresentation(): void {
    // Per-symbol win cues are one-shots and are DELIBERATELY left to finish:
    // in `'cycle'` mode this runs on every cycle step, so stopping in-flight
    // audio here would chop every cue mid-sound. Only the dedup set is reset,
    // so the next presentation (or cycle step) plays its cues again.
    playedWinAudioSymbols.clear();
    for (const tween of motionTweens) {
      try { tween.kill(); } catch { /* no-op */ }
    }
    motionTweens.length = 0;
    for (const tween of pathAnimTweens) {
      try { tween.kill(); } catch { /* no-op */ }
    }
    pathAnimTweens.length = 0;
    for (const cleanup of winSymbolEffectCleanups) {
      try { cleanup(); } catch { /* no-op */ }
    }
    winSymbolEffectCleanups.length = 0;

    for (const snap of touchedSymbols.values()) {
      try {
        applyTint(snap.view, snap.origTint);
        applyAlpha(snap.view, snap.origAlpha);
        // `applyTint` above drove the sprite AND any live spine to the same
        // value. The spine may legitimately have had a different tint (or may
        // not have existed at snapshot time and was built later by
        // `ensureSpineForWin`, in which case it started untinted), so put its
        // own recorded value back.
        const restoredSpine = findChildSpine(snap.view);
        if (restoredSpine) {
          try {
            if (typeof restoredSpine.tint === 'number') restoredSpine.tint = snap.origSpineTint ?? 0xffffff;
          } catch { /* no-op */ }
        }
        snap.view.scale.set(snap.origScaleX, snap.origScaleY);
        snap.view.position.set(snap.origX, snap.origY);
        snap.view.rotation = snap.origRotation;
        snap.view.zIndex = snap.origZIndex;
        if (snap.weEnabledParentSortable && snap.view.parent) {
          (snap.view.parent as PIXI.Container).sortableChildren = false;
        }
      } catch { /* node may have been destroyed */ }
    }
    touchedSymbols.clear();

    for (const g of winlineGraphics) {
      try {
        if (g.parent) g.parent.removeChild(g);
        g.destroy();
      } catch { /* no-op */ }
    }
    winlineGraphics.length = 0;

    for (const rope of winlineRopes) {
      try {
        if (rope.parent) rope.parent.removeChild(rope);
        // Do NOT destroy the underlying user texture; only destroy the
        // rope display object.
        rope.destroy({ children: true, texture: false, textureSource: false });
      } catch { /* no-op */ }
    }
    winlineRopes.length = 0;

    for (const sprite of winlineSprites) {
      try {
        if (sprite.parent) sprite.parent.removeChild(sprite);
        // Do NOT destroy the dot-mask texture (closure-cached).
        sprite.destroy({ children: true, texture: false, textureSource: false });
      } catch { /* no-op */ }
    }
    winlineSprites.length = 0;

    for (const mask of winlineMasks) {
      try {
        if (mask.parent) {
          (mask.parent as PIXI.Container & { mask?: PIXI.Container | null }).mask = null;
          mask.parent.removeChild(mask);
        }
        mask.destroy();
      } catch { /* no-op */ }
    }
    winlineMasks.length = 0;

    // Clear glow filters from their display objects.
    for (const d of winlineFilteredDisplays) {
      try { (d as PIXI.Container).filters = []; } catch { /* no-op */ }
    }
    winlineFilteredDisplays.length = 0;
    winlineFilters.length = 0;

    for (const c of winlineContainers) {
      try {
        if (c.parent) c.parent.removeChild(c);
        c.destroy({ children: true, texture: false, textureSource: false });
      } catch { /* no-op */ }
    }
    winlineContainers.length = 0;

    // Destroy generated gradient textures (NEVER user-asset textures).
    for (const tex of generatedGradientTextures) {
      try { tex.destroy(true); } catch { /* no-op */ }
    }
    generatedGradientTextures.length = 0;
    gradientTextureCache.clear();
    colorStripCache.clear();
    taperedAlphaTexture = null;
    trailAlphaTexture = null;
    dotMaskTexture = null;
  }

  function clearWinline(): void {
    cycleActive = false;
    if (cycleTween) {
      try { cycleTween.kill(); } catch { /* no-op */ }
      cycleTween = null;
    }
    // NB: already-playing symbol win audio is NOT stopped here either — these
    // are short one-shots owned by the mixer's voice bookkeeping, and killing
    // them on dismiss would clip the cue the player just earned. Use the audio
    // stop nodes if a game genuinely needs a hard cut.
    clearLinePresentation();
  }

  function presentLines(linesToShow: number[][], lineIndices: number[], style: Behaviour): void {
    // Compute winning-cell set across all shown lines.
    const winningKey = new Set<string>();
    for (const line of linesToShow) {
      for (let r = 0; r < line.length; r += 1) {
        winningKey.add(`${r}:${line[r]}`);
      }
    }

    for (let r = 0; r < reelCount; r += 1) {
      const geom = geometries[r];
      if (!geom) continue;
      for (let row = 0; row < geom.rowCount; row += 1) {
        const view = resolveReelSymbolViewForCell(geom, row);
        if (!view) continue;

        const isWinner = winningKey.has(`${r}:${row}`);

        if (!touchedSymbols.has(view)) {
          // Kill the per-symbol bounce tween on EVERY touched symbol, not
          // just winners. `GRReelView.defaultSpinBounceEffect` uses the
          // shared GSAP 3 `TweenLite` compatibility export with
          // `Elastic.easeOut`; leaving non-winners uncancelled would keep
          // them visibly oscillating during win presentation.
          // We ALSO snap `view.position.y` to its rest-Y (matches
          // `GRReelView.getTargetPositionY`, equivalent to
          // `getReelRowCenterY(geom, row)` in reelView-local space) BEFORE
          // snapshotting, so `originY` captures the true resting slot
          // rather than a mid-bounce y — otherwise the winning yoyo
          // origin drifts and winners permanently settle off-slot.
          killGenericReelsBounceTween(view);
          const restY = getReelRowCenterY(geom, row);
          if (Number.isFinite(restY)) view.position.y = restY;
          touchedSymbols.set(view, snapshotSymbol(view));
        }
        const snap = touchedSymbols.get(view)!;

        if (isWinner) {
          applyTint(view, 0xffffff);
          applyAlpha(view, 1);
          // Elevate winning symbols above losing siblings during play.
          // Snapshot captures the original zIndex; clearLinePresentation
          // restores it (and disables `sortableChildren` if we toggled it).
          if (view.parent && !(view.parent as PIXI.Container).sortableChildren) {
            (view.parent as PIXI.Container).sortableChildren = true;
            snap.weEnabledParentSortable = true;
          }
          view.zIndex = 1000;
          playWinAnimation(view, style.symbolMode);
          applyWinningTween(view, snap, style);
          applyWinSymbolEffect(view, style.winSymbolEffect);
        } else {
          if (style.nonWinningSymbolBehavior === 'darken') {
            applyTint(view, style.nonWinningDarkenColor);
          } else if (style.nonWinningSymbolBehavior === 'alpha') {
            applyAlpha(view, style.nonWinningAlpha);
          }
          // 'none' → leave alone.
        }
      }
    }

    if (style.winningSymbolBehavior === 'playAnimationWithWinline') {
      for (let i = 0; i < linesToShow.length; i += 1) {
        drawSingleWinline(linesToShow[i], lineIndices[i], style);
      }
    }
  }

  function playWinline(rawLines: number[][]): void {
    const lines = validateLines(rawLines);
    if (!lines) return;

    // Reset any previous winline state first.
    clearWinline();

    const style = readBehaviour();

    if (lines.length <= 1) {
      presentLines(lines, lines.map((_, i) => i), style);
      return;
    }

    if (style.winlineMultiPlayMode === 'concurrent') {
      presentLines(lines, lines.map((_, i) => i), style);
      return;
    }

    // Cycle through one at a time, looping forever until cleared.
    cycleActive = true;
    const delaySeconds = Math.max(0.1, style.winlineCycleDelaySec);
    let index = 0;
    const showNext = () => {
      if (!cycleActive) return;
      clearLinePresentation();
      presentLines([lines[index]], [index], style);
      index = (index + 1) % lines.length;
      cycleTween = gsap.delayedCall(delaySeconds, showNext);
    };
    showNext();
  }

  return { playWinline, clearWinline };
}
