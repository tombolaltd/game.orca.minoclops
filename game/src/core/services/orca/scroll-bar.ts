// PARITY CONTRACT: the editor copy of the scroll-bar maths. Both game
// templates carry a byte-identical twin (core/services/orca/scroll-bar.ts)
// and `npm run check:parity` diffs them (leading imports stripped). The editor
// canvas and the runtime must size, place and drive a scroll bar IDENTICALLY,
// so every change here lands in EVERY copy in one commit.
//
// A SCROLL BAR (`scrollBar` node): a track `length` long and `thickness` thick
// (vertical: along = y; horizontal: along = x) with a THUMB inside it, `inset`
// in from every edge. The thumb is as long as the visible share of the content
// (`visible / total` of the free track, never shorter than `minLength`) and
// slides over the free travel as the POSITION goes 0..max (max = total −
// visible). `step: 'whole'` snaps the position to whole numbers. The node's
// origin is the track's TOP-LEFT corner. Pure: no imports, no state; authored
// data is never written.

export const SCROLL_BAR_MIN_LENGTH = 10;
export const SCROLL_BAR_MAX_LENGTH = 10000;
export const SCROLL_BAR_MIN_THICKNESS = 2;
export const SCROLL_BAR_MAX_THICKNESS = 400;

export type ScrollBarOrientation = 'vertical' | 'horizontal';
export type ScrollBarStep = 'whole' | 'continuous';

/** The track: `texture` (a bare bucket-relative path, '' = none) or else a rect in `color`. */
export interface ScrollBarTrack {
  enabled: boolean;
  color: number;
  alpha: number;
  texture: string;
  radius: number;
}

/** The thumb: drawn like the track; `inset` = the gap between it and the track's edges. */
export interface ScrollBarThumb {
  color: number;
  alpha: number;
  texture: string;
  radius: number;
  /** The shortest the thumb gets, px along the bar. */
  minLength: number;
  inset: number;
}

export interface NormalizedScrollBar {
  orientation: ScrollBarOrientation;
  /** Along the bar, px (10..10000). */
  length: number;
  /** Across the bar, px (2..400). */
  thickness: number;
  track: ScrollBarTrack;
  thumb: ScrollBarThumb;
  /** Hidden while everything fits (visible ≥ total). */
  autoHide: boolean;
  /** Drag the thumb; a click on the track pages by `visible`. */
  interactive: boolean;
  step: ScrollBarStep;
  /** '' = off; else a main.orca custom event emitted with `{ position }` when the USER scrolls. */
  changeEvent: string;
  /** Editor only: the content the Scene view previews (total / visible / position). */
  previewTotal: number;
  previewVisible: number;
  previewPosition: number;
}

export type ScrollBarLike = { [K in keyof NormalizedScrollBar]?: unknown };

export interface ScrollBarSize {
  width: number;
  height: number;
}

export interface ScrollBarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function colorOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(Math.floor(value), 0, 0xffffff) : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return Math.max(0, finiteOr(value, fallback));
}

/** Every field defaulted: a 300 × 16 vertical bar, dark track, light thumb, previewing 3 of 10. */
export function defaultScrollBar(): NormalizedScrollBar {
  return {
    orientation: 'vertical',
    length: 300,
    thickness: 16,
    track: { enabled: true, color: 0x000000, alpha: 0.35, texture: '', radius: 8 },
    thumb: { color: 0xffffff, alpha: 0.85, texture: '', radius: 6, minLength: 24, inset: 2 },
    autoHide: true,
    interactive: true,
    step: 'whole',
    changeEvent: '',
    previewTotal: 10,
    previewVisible: 3,
    previewPosition: 0,
  };
}

/** A whole node with every field defaulted and clamped. Never writes `raw`. */
export function normalizeScrollBar(raw: unknown): NormalizedScrollBar {
  const d = defaultScrollBar();
  const b = record(raw) as ScrollBarLike;
  const track = record(b.track);
  const thumb = record(b.thumb);
  return {
    orientation: b.orientation === 'horizontal' ? 'horizontal' : 'vertical',
    length: clamp(finiteOr(b.length, d.length), SCROLL_BAR_MIN_LENGTH, SCROLL_BAR_MAX_LENGTH),
    thickness: clamp(finiteOr(b.thickness, d.thickness), SCROLL_BAR_MIN_THICKNESS, SCROLL_BAR_MAX_THICKNESS),
    track: {
      enabled: boolOr(track.enabled, d.track.enabled),
      color: colorOr(track.color, d.track.color),
      alpha: clamp(finiteOr(track.alpha, d.track.alpha), 0, 1),
      texture: trimmed(track.texture),
      radius: nonNegative(track.radius, d.track.radius),
    },
    thumb: {
      color: colorOr(thumb.color, d.thumb.color),
      alpha: clamp(finiteOr(thumb.alpha, d.thumb.alpha), 0, 1),
      texture: trimmed(thumb.texture),
      radius: nonNegative(thumb.radius, d.thumb.radius),
      minLength: clamp(finiteOr(thumb.minLength, d.thumb.minLength), 0, SCROLL_BAR_MAX_LENGTH),
      inset: clamp(finiteOr(thumb.inset, d.thumb.inset), 0, SCROLL_BAR_MAX_THICKNESS / 2),
    },
    autoHide: boolOr(b.autoHide, d.autoHide),
    interactive: boolOr(b.interactive, d.interactive),
    step: b.step === 'continuous' ? 'continuous' : 'whole',
    changeEvent: trimmed(b.changeEvent),
    previewTotal: nonNegative(b.previewTotal, d.previewTotal),
    previewVisible: nonNegative(b.previewVisible, d.previewVisible),
    previewPosition: nonNegative(b.previewPosition, d.previewPosition),
  };
}

/** The track's size in the node's space (vertical: thickness × length; horizontal: length × thickness). */
export function scrollBarSize(b: NormalizedScrollBar): ScrollBarSize {
  return b.orientation === 'horizontal'
    ? { width: b.length, height: b.thickness }
    : { width: b.thickness, height: b.length };
}

/** Furthest the position goes: total − visible, never below 0 (bad numbers count as 0). */
export function scrollBarMaxPosition(total: number, visible: number): number {
  return Math.max(0, Math.max(0, finiteOr(total, 0)) - Math.max(0, finiteOr(visible, 0)));
}

/** A position kept inside 0..max; `step: 'whole'` rounds it (and never rounds past max). */
export function scrollBarClampPosition(b: NormalizedScrollBar, total: number, visible: number, position: number): number {
  const max = scrollBarMaxPosition(total, visible);
  const p = clamp(finiteOr(position, 0), 0, max);
  if (b.step !== 'whole') return p;
  const rounded = Math.round(p);
  return rounded > max ? Math.floor(max) : rounded;
}

/** Whether the bar shows: always unless `autoHide`, then only while some content is out of view. */
export function scrollBarShouldShow(b: NormalizedScrollBar, total: number, visible: number): boolean {
  return !b.autoHide || scrollBarMaxPosition(total, visible) > 0;
}

/** The inset actually used along / across: never more than half the track. */
function insets(b: NormalizedScrollBar): { along: number; across: number } {
  return {
    along: Math.min(b.thumb.inset, b.length / 2),
    across: Math.min(b.thumb.inset, b.thickness / 2),
  };
}

/** The thumb's length and the free travel it slides over, px along the bar. */
function thumbTravel(b: NormalizedScrollBar, total: number, visible: number): { start: number; thumbLength: number; free: number } {
  const inset = insets(b).along;
  const inner = Math.max(0, b.length - inset * 2);
  const t = Math.max(0, finiteOr(total, 0));
  const v = Math.max(0, finiteOr(visible, 0));
  const share = t > 0 ? clamp(v / t, 0, 1) : 1;
  const thumbLength = Math.min(inner, Math.max(inner * share, Math.min(b.thumb.minLength, inner)));
  return { start: inset, thumbLength, free: inner - thumbLength };
}

/**
 * Where the thumb sits for a position, in the node's space: as long as the
 * visible share of the free track (≥ `minLength`), `inset` in from the edges,
 * position 0..max spread over the free travel.
 */
export function scrollBarThumbRect(b: NormalizedScrollBar, total: number, visible: number, position: number): ScrollBarRect {
  const { start, thumbLength, free } = thumbTravel(b, total, visible);
  const max = scrollBarMaxPosition(total, visible);
  const p = scrollBarClampPosition(b, total, visible, position);
  const along = start + (max > 0 ? (free * p) / max : 0);
  const across = insets(b).across;
  const thumbThickness = Math.max(0, b.thickness - across * 2);
  return b.orientation === 'horizontal'
    ? { x: along, y: across, width: thumbLength, height: thumbThickness }
    : { x: across, y: along, width: thumbThickness, height: thumbLength };
}

/**
 * The position a drag lands on: `along` = the pointer, px along the bar in the
 * node's space; `grabOffset` = how far past the thumb's start it was grabbed.
 * The inverse of {@link scrollBarThumbRect}, clamped (and stepped).
 */
export function scrollBarPositionFromPointer(
  b: NormalizedScrollBar,
  total: number,
  visible: number,
  along: number,
  grabOffset: number,
): number {
  const { start, free } = thumbTravel(b, total, visible);
  const max = scrollBarMaxPosition(total, visible);
  if (!(free > 0) || !(max > 0)) return 0;
  const offset = finiteOr(along, 0) - finiteOr(grabOffset, 0) - start;
  return scrollBarClampPosition(b, total, visible, (offset / free) * max);
}

/**
 * A click on the track (`along` px along the bar, off the thumb) pages by
 * `visible` (by 1 when `visible` is 0) toward the click; on the thumb it stays.
 * Clamped (and stepped).
 */
export function scrollBarPageFromTrackClick(
  b: NormalizedScrollBar,
  total: number,
  visible: number,
  position: number,
  along: number,
): number {
  const current = scrollBarClampPosition(b, total, visible, position);
  const rect = scrollBarThumbRect(b, total, visible, current);
  const thumbStart = b.orientation === 'horizontal' ? rect.x : rect.y;
  const thumbEnd = thumbStart + (b.orientation === 'horizontal' ? rect.width : rect.height);
  const page = Math.max(0, finiteOr(visible, 0)) || 1;
  const at = finiteOr(along, thumbStart);
  if (at < thumbStart) return scrollBarClampPosition(b, total, visible, current - page);
  if (at > thumbEnd) return scrollBarClampPosition(b, total, visible, current + page);
  return current;
}
