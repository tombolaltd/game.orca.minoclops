// PARITY CONTRACT: the editor copy of the bingo-ticket-holder maths. Both game
// templates will carry a byte-identical twin (core/services/orca/bingo-ticket-holder.ts)
// and `npm run check:parity` diffs them (leading imports stripped). The editor
// canvas and the runtime must lay out, order, scroll and clip the tickets
// IDENTICALLY, so every change here lands in EVERY copy in one commit.
//
// A BINGO TICKET HOLDER (`bingoTicketHolder` node): the view that holds a
// game's tickets. It makes one copy of a ticket PREFAB (a `.pod` holding a
// `bingoTicket`) per ticket — the runtime gets that prefab baked into the scene
// data as `ticketTemplate` — lays the copies out in SLOTS (slot k = the k-th
// place, top/left first) and re-orders them so the ticket closest to winning
// takes slot 0. An optional viewport shows `visibleCount` slots, clipped, and
// scrolls a slot (a row, for a grid) at a time. `portraitVisibleCount`
// overrides that count while the active layout bucket (the LayoutManager
// override mode) is 'portrait'; null = same as `visibleCount`. The node's origin is slot 0's
// top-left corner. `scrollBarId` names a `scrollBar` node in the SAME scene
// that shows (and drives) the viewport's scroll; '' = none. With a viewport,
// `dragScroll` lets a press-and-drag (past `dragThreshold` px — a shorter press
// is still a tap) scroll it live, snapping to the nearest slot on release, and
// `wheelScroll` scrolls it by whole slots per `wheelStep` px of wheel delta.
// Pure: no imports, no state; authored data is never written.

export const BINGO_TICKET_HOLDER_MAX_TICKETS = 96;
export const BINGO_TICKET_HOLDER_MAX_COLUMNS = 12;
export const BINGO_TICKET_HOLDER_MAX_REORDER_MS = 5000;
export const BINGO_TICKET_HOLDER_MAX_DRAG_THRESHOLD = 200;
export const BINGO_TICKET_HOLDER_MIN_WHEEL_STEP = 10;
export const BINGO_TICKET_HOLDER_MAX_WHEEL_STEP = 2000;

export type BingoTicketHolderDirection = 'vertical' | 'horizontal' | 'grid';
export type BingoTicketHolderSource = 'current' | 'next';
/**
 * The active layout bucket (the LayoutManager override mode): 'portrait',
 * 'landscape' or 'desktop'. Anything but 'portrait' uses `visibleCount`.
 */
export type BingoTicketHolderLayoutMode = 'portrait' | 'landscape' | 'desktop' | (string & {});

/** The `.pod` the copies come from — the same shape a `prefabInstance` stores (`path` is bucket-relative, with `.pod`). */
export interface BingoTicketHolderPrefabRef {
  path: string;
  prefabId?: string;
}

export interface BingoTicketHolderLayout {
  direction: BingoTicketHolderDirection;
  /** Grid only: slots per row (1..12). */
  columns: number;
  /** Distance between neighbouring slots' origins. */
  pitchX: number;
  pitchY: number;
}

export interface NormalizedBingoTicketHolder {
  ticketPrefab: BingoTicketHolderPrefabRef | null;
  /** Pushed into every copied ticket. */
  source: BingoTicketHolderSource;
  /** Copies made (1..96); copies past the game's ticket count stay hidden and take no slot. */
  maxTickets: number;
  layout: BingoTicketHolderLayout;
  /** 0 = every slot shows; else the viewport shows this many slots. */
  visibleCount: number;
  /** null = same as `visibleCount`; else the count (same meaning) while the layout mode is 'portrait'. */
  portraitVisibleCount: number | null;
  /** Mask the copies to the viewport (only when the mode's visible count > 0). */
  clip: boolean;
  sortByToGo: boolean;
  /** How long a copy slides to its new slot (0 = jump). */
  reorderMs: number;
  /** '' = off; else the child of this name (anywhere in a copy) shows on the slot-0 ticket only. */
  bestChildName: string;
  /** '' = off; else the child of this name (anywhere in a copy) shows on EVERY copy while `source` is 'next', hidden while 'current'. */
  nextChildName: string;
  /** '' = off; else a main.orca custom event emitted with `{ ticketIndex }` when a copy is tapped. */
  tapEvent: string;
  /** Editor only: copies drawn in the Scene view (1..maxTickets). */
  previewCount: number;
  /** Editor only: order the preview copies by their sample to-go. */
  previewSort: boolean;
  /** '' = none; else the id of a `scrollBar` node in the same scene that shows / drives the scroll. */
  scrollBarId: string;
  /** Press and drag inside the viewport to scroll; release snaps to the nearest slot. */
  dragScroll: boolean;
  /** Px (0..200) the pointer moves before a press becomes a drag; a shorter press is still a tap. */
  dragThreshold: number;
  /** The mouse wheel over the viewport scrolls by whole slots (rows for a grid). */
  wheelScroll: boolean;
  /** Wheel delta in px (DOM deltaMode 0, 10..2000) per slot; smaller deltas accumulate. */
  wheelStep: number;
}

export type BingoTicketHolderLike = { [K in keyof NormalizedBingoTicketHolder]?: unknown };

export interface BingoTicketHolderPoint {
  x: number;
  y: number;
}

export interface BingoTicketHolderSize {
  width: number;
  height: number;
}

export interface BingoTicketHolderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One ticket the holder may show: `toGo` 0 = a win, < 0 or not a number = unknown. */
export interface BingoTicketHolderEntry {
  ticketIndex: number;
  toGo: number;
  visible: boolean;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function intIn(value: unknown, fallback: number, min: number, max: number): number {
  return clamp(Math.round(finiteOr(value, fallback)), min, max);
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

function prefabRefOf(value: unknown): BingoTicketHolderPrefabRef | null {
  const ref = record(value);
  const path = trimmed(ref.path);
  if (!path) return null;
  const prefabId = trimmed(ref.prefabId);
  return prefabId ? { path, prefabId } : { path };
}

/** Every field defaulted: twelve copies stacked downwards, all shown, sorted by to-go. */
export function defaultBingoTicketHolder(): NormalizedBingoTicketHolder {
  return {
    ticketPrefab: null,
    source: 'current',
    maxTickets: 12,
    layout: { direction: 'vertical', columns: 2, pitchX: 1100, pitchY: 180 },
    visibleCount: 0,
    portraitVisibleCount: null,
    clip: true,
    sortByToGo: true,
    reorderMs: 400,
    bestChildName: '',
    nextChildName: '',
    tapEvent: '',
    previewCount: 3,
    previewSort: true,
    scrollBarId: '',
    dragScroll: true,
    dragThreshold: 10,
    wheelScroll: true,
    wheelStep: 100,
  };
}

/** A whole node with every field defaulted and clamped. Never writes `raw`. */
export function normalizeBingoTicketHolder(raw: unknown): NormalizedBingoTicketHolder {
  const d = defaultBingoTicketHolder();
  const h = record(raw) as BingoTicketHolderLike;
  const layout = record(h.layout);
  const maxTickets = intIn(h.maxTickets, d.maxTickets, 1, BINGO_TICKET_HOLDER_MAX_TICKETS);
  const direction = layout.direction === 'horizontal' || layout.direction === 'grid' ? layout.direction : 'vertical';
  return {
    ticketPrefab: prefabRefOf(h.ticketPrefab),
    source: h.source === 'next' ? 'next' : 'current',
    maxTickets,
    layout: {
      direction,
      columns: intIn(layout.columns, d.layout.columns, 1, BINGO_TICKET_HOLDER_MAX_COLUMNS),
      pitchX: finiteOr(layout.pitchX, d.layout.pitchX),
      pitchY: finiteOr(layout.pitchY, d.layout.pitchY),
    },
    visibleCount: intIn(h.visibleCount, d.visibleCount, 0, maxTickets),
    portraitVisibleCount: typeof h.portraitVisibleCount === 'number' && Number.isFinite(h.portraitVisibleCount)
      ? intIn(h.portraitVisibleCount, 0, 0, maxTickets)
      : null,
    clip: boolOr(h.clip, d.clip),
    sortByToGo: boolOr(h.sortByToGo, d.sortByToGo),
    reorderMs: intIn(h.reorderMs, d.reorderMs, 0, BINGO_TICKET_HOLDER_MAX_REORDER_MS),
    bestChildName: trimmed(h.bestChildName),
    nextChildName: trimmed(h.nextChildName),
    tapEvent: trimmed(h.tapEvent),
    previewCount: intIn(h.previewCount, Math.min(d.previewCount, maxTickets), 1, maxTickets),
    previewSort: boolOr(h.previewSort, d.previewSort),
    scrollBarId: trimmed(h.scrollBarId),
    dragScroll: boolOr(h.dragScroll, d.dragScroll),
    dragThreshold: clamp(finiteOr(h.dragThreshold, d.dragThreshold), 0, BINGO_TICKET_HOLDER_MAX_DRAG_THRESHOLD),
    wheelScroll: boolOr(h.wheelScroll, d.wheelScroll),
    wheelStep: clamp(finiteOr(h.wheelStep, d.wheelStep), BINGO_TICKET_HOLDER_MIN_WHEEL_STEP, BINGO_TICKET_HOLDER_MAX_WHEEL_STEP),
  };
}

/** Whether the `nextChildName` child shows on the copies: only for a 'next' holder that names one. */
export function bingoTicketHolderNextChildVisible(h: NormalizedBingoTicketHolder): boolean {
  return h.source === 'next' && h.nextChildName !== '';
}

/** The viewport's slot count for a layout mode: `portraitVisibleCount` in 'portrait' (when set), else `visibleCount`. 0 = every slot shows. */
export function bingoTicketHolderVisibleCount(h: NormalizedBingoTicketHolder, mode: BingoTicketHolderLayoutMode): number {
  return mode === 'portrait' && h.portraitVisibleCount !== null ? h.portraitVisibleCount : h.visibleCount;
}

/** Slots per row: a grid's columns; one row of every slot when horizontal; one column when vertical. */
function rowLength(h: NormalizedBingoTicketHolder, count: number): number {
  if (h.layout.direction === 'grid') return h.layout.columns;
  return h.layout.direction === 'horizontal' ? Math.max(1, count) : 1;
}

/** Where slot `k` (0 = first) puts a copy's origin, in the holder's space. */
export function bingoTicketHolderSlot(h: NormalizedBingoTicketHolder, k: number): BingoTicketHolderPoint {
  const slot = Math.max(0, Math.floor(finiteOr(k, 0)));
  const { direction, columns, pitchX, pitchY } = h.layout;
  if (direction === 'horizontal') return { x: slot * pitchX, y: 0 };
  if (direction === 'grid') return { x: (slot % columns) * pitchX, y: Math.floor(slot / columns) * pitchY };
  return { x: 0, y: slot * pitchY };
}

/**
 * The rect the viewport shows (and clips to) in the holder's space: the
 * mode's visible-count first slots, each `ticketSize` big. Null when every
 * slot shows. Negative pitches grow the rect up / left from slot 0.
 * `mode` defaults to 'landscape' (= `visibleCount`).
 */
export function bingoTicketHolderViewport(
  h: NormalizedBingoTicketHolder,
  ticketSize: BingoTicketHolderSize,
  mode: BingoTicketHolderLayoutMode = 'landscape',
): BingoTicketHolderRect | null {
  const visible = bingoTicketHolderVisibleCount(h, mode);
  if (visible <= 0) return null;
  const width = Math.max(0, finiteOr(ticketSize?.width, 0));
  const height = Math.max(0, finiteOr(ticketSize?.height, 0));
  const perRow = Math.min(rowLength(h, visible), visible);
  const rows = Math.ceil(visible / perRow);
  const spanX = (perRow - 1) * h.layout.pitchX;
  const spanY = (rows - 1) * h.layout.pitchY;
  return {
    x: Math.min(0, spanX),
    y: Math.min(0, spanY),
    width: Math.abs(spanX) + width,
    height: Math.abs(spanY) + height,
  };
}

/** Sort key of a to-go: a win (0) first, then 1, 2, …; unknown (negative / not a number) last. */
export function bingoTicketHolderToGoKey(toGo: unknown): number {
  const n = finiteOr(toGo, -1);
  return n < 0 ? Number.MAX_SAFE_INTEGER : n;
}

/**
 * The ticket shown in each slot (slot 0 first): visible tickets only, each
 * index once. Sorted by to-go (win first, unknown last) when `sortByToGo`,
 * ties — and everything when not sorting — by ticket index.
 */
export function bingoTicketHolderOrder(entries: ReadonlyArray<BingoTicketHolderEntry>, sortByToGo: boolean): number[] {
  const seen = new Set<number>();
  const shown: Array<{ ticketIndex: number; key: number }> = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.visible !== true) continue;
    const ticketIndex = entry.ticketIndex;
    if (typeof ticketIndex !== 'number' || !Number.isInteger(ticketIndex) || ticketIndex < 0 || seen.has(ticketIndex)) continue;
    seen.add(ticketIndex);
    shown.push({ ticketIndex, key: sortByToGo ? bingoTicketHolderToGoKey(entry.toGo) : 0 });
  }
  shown.sort((a, b) => a.key - b.key || a.ticketIndex - b.ticketIndex);
  return shown.map((entry) => entry.ticketIndex);
}

/**
 * Furthest the viewport scrolls, in slots (rows for a grid): 0 when everything
 * fits or every slot shows. `mode` defaults to 'landscape' (= `visibleCount`).
 */
export function bingoTicketHolderMaxScroll(
  h: NormalizedBingoTicketHolder,
  visibleTickets: number,
  mode: BingoTicketHolderLayoutMode = 'landscape',
): number {
  const visible = bingoTicketHolderVisibleCount(h, mode);
  if (visible <= 0) return 0;
  const count = Math.max(0, Math.floor(finiteOr(visibleTickets, 0)));
  if (h.layout.direction === 'grid') {
    const columns = h.layout.columns;
    return Math.max(0, Math.ceil(count / columns) - Math.ceil(visible / columns));
  }
  return Math.max(0, count - visible);
}

/** A scroll position (whole slots / rows) kept inside 0..max for `mode` (default 'landscape'). */
export function bingoTicketHolderClampScroll(
  h: NormalizedBingoTicketHolder,
  visibleTickets: number,
  scroll: number,
  mode: BingoTicketHolderLayoutMode = 'landscape',
): number {
  return clamp(Math.round(finiteOr(scroll, 0)), 0, bingoTicketHolderMaxScroll(h, visibleTickets, mode));
}

/**
 * How far the copies move for a scroll position: one pitch per slot (per row
 * for a grid). Fractions are kept (a live drag between slots); negatives → 0.
 */
export function bingoTicketHolderScrollOffset(h: NormalizedBingoTicketHolder, scroll: number): BingoTicketHolderPoint {
  const s = Math.max(0, finiteOr(scroll, 0));
  if (h.layout.direction === 'horizontal') return { x: s === 0 ? 0 : -s * h.layout.pitchX, y: 0 };
  return { x: 0, y: s === 0 ? 0 : -s * h.layout.pitchY };
}

/** The pointer axis the viewport scrolls along: 'x' when horizontal, else 'y' (vertical, and a grid's rows). */
export function bingoTicketHolderScrollAxis(h: NormalizedBingoTicketHolder): 'x' | 'y' {
  return h.layout.direction === 'horizontal' ? 'x' : 'y';
}

/** The signed pitch one scroll step moves the copies by along the scroll axis (0 → 1). */
function signedScrollPitch(h: NormalizedBingoTicketHolder): number {
  const pitch = h.layout.direction === 'horizontal' ? h.layout.pitchX : h.layout.pitchY;
  return Number.isFinite(pitch) && pitch !== 0 ? pitch : 1;
}

/** Px per scroll step along the scroll axis: |pitchX| when horizontal, else |pitchY| (0 → 1). */
export function bingoTicketHolderScrollPitch(h: NormalizedBingoTicketHolder): number {
  return Math.abs(signedScrollPitch(h));
}

/**
 * The live (fractional) scroll while dragging: the copies follow the pointer,
 * so `startScroll − deltaAlongPx / pitch` with the SIGNED pitch (a positive
 * pitch: dragging up / left = a negative delta scrolls forward; a negative
 * pitch flips that, matching {@link bingoTicketHolderScrollOffset}). `deltaAlongPx`
 * = pointer movement along {@link bingoTicketHolderScrollAxis} since the press,
 * in the holder's space. Plain clamp to 0..maxScroll (no rubber band).
 */
export function bingoTicketHolderDragScroll(
  h: NormalizedBingoTicketHolder,
  startScroll: number,
  deltaAlongPx: number,
  maxScroll: number,
): number {
  const max = Math.max(0, finiteOr(maxScroll, 0));
  const next = finiteOr(startScroll, 0) - finiteOr(deltaAlongPx, 0) / signedScrollPitch(h);
  return clamp(next, 0, max);
}

/** The slot a released drag settles on: the nearest whole scroll, kept in 0..maxScroll. */
export function bingoTicketHolderSnapScroll(fractional: number, maxScroll: number): number {
  const max = Math.max(0, Math.floor(finiteOr(maxScroll, 0)));
  return clamp(Math.round(finiteOr(fractional, 0)), 0, max);
}

/**
 * Mouse-wheel scrolling: `deltaPx` (DOM deltaMode 0; positive = down = scroll
 * FORWARD) is added to `accumulator`; every whole `wheelStep` becomes a step
 * (signed: + forward, − back) and the remainder carries over, so small trackpad
 * deltas add up. The caller adds `steps` to the scroll and clamps it.
 * `wheelScroll` off → no steps and a cleared accumulator.
 */
export function bingoTicketHolderWheelScroll(
  h: NormalizedBingoTicketHolder,
  accumulator: number,
  deltaPx: number,
): { steps: number; accumulator: number } {
  if (h.wheelScroll === false) return { steps: 0, accumulator: 0 };
  const step = Math.max(BINGO_TICKET_HOLDER_MIN_WHEEL_STEP, finiteOr(h.wheelStep, 100));
  const total = finiteOr(accumulator, 0) + finiteOr(deltaPx, 0);
  const steps = Math.trunc(total / step);
  return { steps: steps === 0 ? 0 : steps, accumulator: total - steps * step };
}

/**
 * What a linked scroll bar shows (`scrollBarId`), in the units the holder
 * scrolls by: `count` shown tickets and the mode's visible slots (0 = every
 * slot shows → visible = total). A grid counts ROWS of `columns`, so the bar's
 * max position (total − visible) is the holder's {@link bingoTicketHolderMaxScroll}.
 * `mode` defaults to 'landscape' (= `visibleCount`).
 */
export function bingoTicketHolderScrollBarRange(
  h: NormalizedBingoTicketHolder,
  count: number,
  mode: BingoTicketHolderLayoutMode = 'landscape',
): { total: number; visible: number } {
  const shown = Math.max(0, Math.floor(finiteOr(count, 0)));
  const slots = bingoTicketHolderVisibleCount(h, mode);
  if (h.layout.direction === 'grid') {
    const columns = Math.max(1, h.layout.columns);
    const total = Math.ceil(shown / columns);
    return { total, visible: slots > 0 ? Math.ceil(slots / columns) : total };
  }
  return { total: shown, visible: slots > 0 ? slots : shown };
}

/** Pitches that butt copies of `ticketSize` together with `gap` between them. */
export function bingoTicketHolderAutoPitch(ticketSize: BingoTicketHolderSize, gap: number): { pitchX: number; pitchY: number } {
  const g = Math.max(0, finiteOr(gap, 0));
  return {
    pitchX: Math.max(0, finiteOr(ticketSize?.width, 0)) + g,
    pitchY: Math.max(0, finiteOr(ticketSize?.height, 0)) + g,
  };
}
