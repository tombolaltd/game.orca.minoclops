// PARITY CONTRACT: byte-identical twin of
//   templates/arcade-base-game-template/game/src/core/services/orca/fit-area.ts
// `npm run check:parity` diffs the two (leading imports stripped). The editor
// canvas and the runtime must fit a node into its area IDENTICALLY, so every
// change here lands in BOTH files in one commit.
//
// FIT TO AREA — the `fitArea` mode of the Responsive Scaler. The AREA is the
// screen less a MARGIN at each edge. Each margin is a share of the screen's
// width or of its height — whichever the thing kept clear there grows with: a
// jackpots panel across the top of a phone held upright is sized by the
// screen's width, the cabinet along the bottom by its height. The node is
// scaled so a BOX of it fits the area (never past `maxScale`) and placed so
// the box sits in it at `alignX` / `alignY` (0 = left / top, 0.5 = centre,
// 1 = right / bottom). The box is the node's BOUNDS — everything it shows,
// measured by the editor and saved as `content` for the game — or, with
// `contentMode: 'custom'`, a box the author sets, outside which the node may
// run into the margins. The fit owns the node's place and size: its own x / y
// are not used and its own scale only for a flip. Its rotation turns the box,
// and the box round that is what fits. The "screen" is the camera frame in
// the editor and what the player sees of the game in the game. Pure: no
// imports, no state; authored data is never written.

export type FitAreaEdge = 'left' | 'top' | 'right' | 'bottom';

/** What a margin is a share of. */
export type FitAreaAxis = 'width' | 'height';

/** The space kept clear at one edge of the screen. */
export interface FitAreaMargin {
  /** A share of the screen's width or height (0.1 = 10 %). */
  size: number;
  of: FitAreaAxis;
}

export type FitAreaMargins = Record<FitAreaEdge, FitAreaMargin>;

/** A box in a node's own units: its top-left corner and its size. */
export interface FitAreaBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle by its edges, in one space (left < right, top < bottom). */
export interface FitAreaRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What a Fit to Area node fits: its bounds, or a box its author sets. */
export type FitAreaContentMode = 'bounds' | 'custom';

export interface FitAreaSettings {
  margins: FitAreaMargins;
  contentMode: FitAreaContentMode;
  /** The box fitted, in the node's own units: its bounds as last measured, or the author's box. */
  content: FitAreaBox;
  alignX: number;
  alignY: number;
  /** The most the fit may enlarge the box (1 = its own size); null = no limit. */
  maxScale: number | null;
}

/** The node's own transform, as far as the fit uses it. */
export interface FitAreaNodeFrame {
  /** Only the signs count: a negative scale flips the node. */
  scaleX: number;
  scaleY: number;
  /** Radians. */
  rotation: number;
  pivotX: number;
  pivotY: number;
}

export interface FitAreaResult {
  /** The size the box is shown at (1 = its own units). */
  ratio: number;
  /** The node's scale: the ratio, signed like its own. */
  scaleX: number;
  scaleY: number;
  /** The node's position, in its parent's space. */
  x: number;
  y: number;
  /** The area, in the same space as the screen it was resolved from. */
  area: FitAreaRect;
  /** Where the box lands (the box round it, when the node is turned), in that space too. */
  shown: FitAreaRect;
}

export const FIT_AREA_EDGES: readonly FitAreaEdge[] = ['left', 'top', 'right', 'bottom'];

/** The largest share of the screen one margin may take. */
export const FIT_AREA_MAX_MARGIN = 0.9;

/** The smallest share of the screen the area may shrink to (a dragged margin stops there). */
export const FIT_AREA_MIN_AREA = 0.05;

/** The axis an edge's margin is a share of unless the author picks the other. */
export const FIT_AREA_DEFAULT_AXIS: Readonly<Record<FitAreaEdge, FitAreaAxis>> = {
  left: 'width',
  top: 'height',
  right: 'width',
  bottom: 'height',
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readField(source: unknown, key: string): unknown {
  return source && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined;
}

export function normalizeFitAreaMargin(raw: unknown, edge: FitAreaEdge): FitAreaMargin {
  const size = readField(raw, 'size');
  const of = readField(raw, 'of');
  return {
    size: isFiniteNumber(size) ? clampNumber(size, 0, FIT_AREA_MAX_MARGIN) : 0,
    of: of === 'width' || of === 'height' ? of : FIT_AREA_DEFAULT_AXIS[edge],
  };
}

export function normalizeFitAreaMargins(raw: unknown): FitAreaMargins {
  return {
    left: normalizeFitAreaMargin(readField(raw, 'left'), 'left'),
    top: normalizeFitAreaMargin(readField(raw, 'top'), 'top'),
    right: normalizeFitAreaMargin(readField(raw, 'right'), 'right'),
    bottom: normalizeFitAreaMargin(readField(raw, 'bottom'), 'bottom'),
  };
}

/** A usable content box, or null (missing, not numbers, or no area). */
export function normalizeFitAreaContent(raw: unknown): FitAreaBox | null {
  const x = readField(raw, 'x');
  const y = readField(raw, 'y');
  const width = readField(raw, 'width');
  const height = readField(raw, 'height');
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

export function normalizeFitAreaAlign(raw: unknown): number {
  return isFiniteNumber(raw) ? clampNumber(raw, 0, 1) : 0.5;
}

export function normalizeFitAreaMaxScale(raw: unknown): number | null {
  return isFiniteNumber(raw) && raw > 0 ? raw : null;
}

export function normalizeFitAreaContentMode(raw: unknown): FitAreaContentMode {
  return raw === 'custom' ? 'custom' : 'bounds';
}

/**
 * The content box a scaler without one uses: its reference size, centred on
 * the node's origin — the box the other modes scale.
 */
export function defaultFitAreaContent(referenceWidth: unknown, referenceHeight: unknown): FitAreaBox {
  const width = isFiniteNumber(referenceWidth) && referenceWidth > 0 ? referenceWidth : 1920;
  const height = isFiniteNumber(referenceHeight) && referenceHeight > 0 ? referenceHeight : 1080;
  return { x: -width / 2, y: -height / 2, width, height };
}

/** Every fit setting of a scaler, filled in. Reads `margins`, `contentMode`, `content`, `alignX`, `alignY`, `maxScale`. */
export function normalizeFitAreaSettings(raw: unknown): FitAreaSettings {
  return {
    margins: normalizeFitAreaMargins(readField(raw, 'margins')),
    contentMode: normalizeFitAreaContentMode(readField(raw, 'contentMode')),
    content: normalizeFitAreaContent(readField(raw, 'content'))
      ?? defaultFitAreaContent(readField(raw, 'referenceWidth'), readField(raw, 'referenceHeight')),
    alignX: normalizeFitAreaAlign(readField(raw, 'alignX')),
    alignY: normalizeFitAreaAlign(readField(raw, 'alignY')),
    maxScale: normalizeFitAreaMaxScale(readField(raw, 'maxScale')),
  };
}

function orderedRect(rect: FitAreaRect): FitAreaRect {
  return {
    left: Math.min(rect.left, rect.right),
    top: Math.min(rect.top, rect.bottom),
    right: Math.max(rect.left, rect.right),
    bottom: Math.max(rect.top, rect.bottom),
  };
}

/** One margin's length, in the screen's units. */
export function fitAreaMarginLength(screen: FitAreaRect, margin: FitAreaMargin): number {
  const s = orderedRect(screen);
  return margin.size * (margin.of === 'width' ? s.right - s.left : s.bottom - s.top);
}

/** The area: the screen less its margins, or null when nothing is left of it. */
export function resolveFitAreaRect(screen: FitAreaRect, margins: FitAreaMargins): FitAreaRect | null {
  const s = orderedRect(screen);
  const area: FitAreaRect = {
    left: s.left + fitAreaMarginLength(s, margins.left),
    top: s.top + fitAreaMarginLength(s, margins.top),
    right: s.right - fitAreaMarginLength(s, margins.right),
    bottom: s.bottom - fitAreaMarginLength(s, margins.bottom),
  };
  if (![area.left, area.top, area.right, area.bottom].every(isFiniteNumber)) return null;
  return area.right - area.left > 0 && area.bottom - area.top > 0 ? area : null;
}

/**
 * Where a box `width` wide sits centred across the screen between a `left`
 * and a `right` margin (the jackpots panel's Fit to Area placement): the x of
 * its left edge, or null when nothing is left between the margins or nothing
 * is finite. A box wider than the space stays centred on it.
 */
export function centreBetweenMargins(screen: FitAreaRect, left: FitAreaMargin, right: FitAreaMargin, width: number): number | null {
  const s = orderedRect(screen);
  const from = s.left + fitAreaMarginLength(s, left);
  const to = s.right - fitAreaMarginLength(s, right);
  if (!isFiniteNumber(from) || !isFiniteNumber(to) || !isFiniteNumber(width) || !(to - from > 0)) return null;
  return (from + to) / 2 - width / 2;
}

/**
 * Where a box `width` wide goes across the screen in the jackpots panel's Fit
 * to Area placement: its middle on the middle of the space between a `left`
 * and a `right` margin, kept at least `edge` inside each side of the screen —
 * moved in when it would come closer, and shrunk (`scale` below 1) only when
 * it is wider than the screen less `edge` each side. `left` is the x of its
 * left edge at that scale. Null when nothing is left between the margins or
 * nothing is finite.
 */
export function placeBetweenMargins(screen: FitAreaRect, left: FitAreaMargin, right: FitAreaMargin, width: number, edge: number): { left: number; scale: number } | null {
  const s = orderedRect(screen);
  const from = s.left + fitAreaMarginLength(s, left);
  const to = s.right - fitAreaMarginLength(s, right);
  if (![from, to, width, edge].every(isFiniteNumber) || !(to - from > 0) || !(width > 0)) return null;
  const clear = Math.max(0, Math.min(edge, (s.right - s.left) / 4));
  const scale = Math.min(1, (s.right - s.left - 2 * clear) / width);
  const size = width * scale;
  return { left: Math.min(s.right - clear - size, Math.max(s.left + clear, (from + to) / 2 - size / 2)), scale };
}

/**
 * Fit a node: its scale and where its x / y = 0 lands. Null when there is no
 * area, its own scale is zero (a collapsed node is left alone) or nothing is
 * finite — the node then keeps its ordinary transform.
 */
export function resolveFitArea(
  screen: FitAreaRect,
  settings: FitAreaSettings,
  frame: FitAreaNodeFrame,
): FitAreaResult | null {
  const area = resolveFitAreaRect(screen, settings.margins);
  if (!area) return null;
  const content = settings.content;
  if (!(Math.abs(frame.scaleX) > 0) || !(Math.abs(frame.scaleY) > 0)) return null;
  if (!(content.width > 0) || !(content.height > 0)) return null;
  const signX = frame.scaleX < 0 ? -1 : 1;
  const signY = frame.scaleY < 0 ? -1 : 1;
  const rotation = isFiniteNumber(frame.rotation) ? frame.rotation : 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  // The box at size 1, turned, from where the node's pivot lands.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const cornerX of [content.x, content.x + content.width]) {
    for (const cornerY of [content.y, content.y + content.height]) {
      const vx = (cornerX - frame.pivotX) * signX;
      const vy = (cornerY - frame.pivotY) * signY;
      const px = cos * vx - sin * vy;
      const py = sin * vx + cos * vy;
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (!(spanX > 0) || !(spanY > 0)) return null;
  const areaWidth = area.right - area.left;
  const areaHeight = area.bottom - area.top;
  let ratio = Math.min(areaWidth / spanX, areaHeight / spanY);
  if (settings.maxScale !== null) ratio = Math.min(ratio, settings.maxScale);
  if (!(ratio > 0) || !Number.isFinite(ratio)) return null;
  const shownWidth = spanX * ratio;
  const shownHeight = spanY * ratio;
  const left = area.left + (areaWidth - shownWidth) * clampNumber(settings.alignX, 0, 1);
  const top = area.top + (areaHeight - shownHeight) * clampNumber(settings.alignY, 0, 1);
  const x = left - minX * ratio;
  const y = top - minY * ratio;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  return {
    ratio,
    scaleX: signX * ratio,
    scaleY: signY * ratio,
    x,
    y,
    area,
    shown: { left, top, right: left + shownWidth, bottom: top + shownHeight },
  };
}

/**
 * The margin an edge gets when it is dragged to `coordinate` (in the screen's
 * space), kept in a share of `margins[edge].of`. Stops where the area would
 * shrink below {@link FIT_AREA_MIN_AREA} of the screen, and at
 * {@link FIT_AREA_MAX_MARGIN}. Rounded to 0.1 %.
 */
export function fitAreaMarginAt(
  screen: FitAreaRect,
  margins: FitAreaMargins,
  edge: FitAreaEdge,
  coordinate: number,
): number {
  const s = orderedRect(screen);
  const margin = margins[edge];
  const basis = margin.of === 'width' ? s.right - s.left : s.bottom - s.top;
  if (!(basis > 0) || !isFiniteNumber(coordinate)) return margin.size;
  const horizontal = edge === 'left' || edge === 'right';
  const span = horizontal ? s.right - s.left : s.bottom - s.top;
  const opposite = margins[edge === 'left' ? 'right' : edge === 'right' ? 'left' : edge === 'top' ? 'bottom' : 'top'];
  const room = span - fitAreaMarginLength(s, opposite) - span * FIT_AREA_MIN_AREA;
  let length: number;
  switch (edge) {
    case 'left': length = coordinate - s.left; break;
    case 'right': length = s.right - coordinate; break;
    case 'top': length = coordinate - s.top; break;
    default: length = s.bottom - coordinate; break;
  }
  length = clampNumber(length, 0, Math.max(0, room));
  return Math.round(clampNumber(length / basis, 0, FIT_AREA_MAX_MARGIN) * 1000) / 1000;
}

/**
 * The alignment that puts the shown box at `shown` (where a drag moved it),
 * each 0..1 and rounded to 0.1 %. An axis with next to no spare room keeps
 * its alignment: nudging a node that fills the area across must not decide
 * where it sits on a wider screen.
 */
export function fitAreaAlignFor(
  area: FitAreaRect,
  shown: FitAreaRect,
  current: { alignX: number; alignY: number },
): { alignX: number; alignY: number } {
  const along = (areaStart: number, areaEnd: number, shownStart: number, shownEnd: number, keep: number): number => {
    const span = areaEnd - areaStart;
    const spare = span - (shownEnd - shownStart);
    if (!(spare > span * 0.005) || !isFiniteNumber(shownStart)) return keep;
    return Math.round(clampNumber((shownStart - areaStart) / spare, 0, 1) * 1000) / 1000;
  };
  return {
    alignX: along(area.left, area.right, shown.left, shown.right, current.alignX),
    alignY: along(area.top, area.bottom, shown.top, shown.bottom, current.alignY),
  };
}

/** A measured box rounded OUT to 0.01 (so it never shrinks), or null when it has no area. */
export function fitAreaBoxAround(x: number, y: number, width: number, height: number): FitAreaBox | null {
  if (![x, y, width, height].every(isFiniteNumber) || !(width > 0) || !(height > 0)) return null;
  const left = Math.floor(x * 100) / 100;
  const top = Math.floor(y * 100) / 100;
  const right = Math.ceil((x + width) * 100) / 100;
  const bottom = Math.ceil((y + height) * 100) / 100;
  return {
    x: left,
    y: top,
    width: Math.round((right - left) * 100) / 100,
    height: Math.round((bottom - top) * 100) / 100,
  };
}

/**
 * The rect a `fitArea` host offers its children for `parentAnchor`: the box
 * its author set, in its own units. A host fitting its bounds offers none —
 * its children make those bounds, so anchoring them to it would chase itself.
 */
export function fitAreaChildAnchorRect(settings: FitAreaSettings): { centerX: number; centerY: number; width: number; height: number } | null {
  if (settings.contentMode !== 'custom') return null;
  const content = settings.content;
  return {
    centerX: content.x + content.width / 2,
    centerY: content.y + content.height / 2,
    width: content.width,
    height: content.height,
  };
}

/** The scaler fields that belong to Fit to Area, merged as ONE group. */
export const FIT_AREA_FIELDS: readonly string[] = ['margins', 'contentMode', 'content', 'alignX', 'alignY', 'maxScale'];

/**
 * A scaler without its Fit to Area fields. A per-camera-mode override that
 * carries a scaler brings its OWN fit settings (or none): merging them field
 * by field over the base would leak, say, one mode's `maxScale` into another.
 */
export function withoutFitAreaFields<T extends object>(scaler: T | null | undefined): Partial<T> {
  if (!scaler || typeof scaler !== 'object') return {};
  const rest: Record<string, unknown> = { ...(scaler as Record<string, unknown>) };
  for (const field of FIT_AREA_FIELDS) delete rest[field];
  return rest as Partial<T>;
}
