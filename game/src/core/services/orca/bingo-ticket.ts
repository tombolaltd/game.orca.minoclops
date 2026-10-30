// PARITY CONTRACT: the editor copy of the bingo-ticket maths. Both game
// templates carry a byte-identical twin (core/services/orca/bingo-ticket.ts)
// and `npm run check:parity` diffs them (leading imports stripped). The
// editor canvas and the runtime must lay out, fill and colour a ticket
// IDENTICALLY, so every change here lands in EVERY copy in one commit.
//
// A BINGO TICKET (`bingoTicket` node): ONE ticket of a bingo game drawn from
// data — a rows × cols grid of cells inside an optional ticket body, an
// optional header row of column labels above the grid, optional always-daubed
// free cells, and an optional "to go" badge beside the body. The node's origin
// is its TOP-LEFT corner; everything is laid out in the node's own space.
// Which column / row a number lands in follows the bingo game config rules
// (`byValueColumn`: value bands of ceil(numberMax / cols); `byIndex`: the
// number's position). Pure: no imports, no state; authored data is never written.

export const BINGO_TICKET_MAX_DIM = 12;
export const BINGO_TICKET_MAX_NUMBER = 999;
export const BINGO_TICKET_MAX_TO_GO_COLORS = 12;
export const BINGO_TICKET_MAX_SEED = 2147483647;

export type BingoTicketCellLayout = 'byIndex' | 'byValueColumn';
export type BingoTicketCellStateName = 'blank' | 'number' | 'called' | 'daubed' | 'winning';
export type BingoTicketToGoSide = 'right' | 'left' | 'top' | 'bottom';
export type BingoTicketSource = 'current' | 'next';
export type BingoTicketPresetName = 'bingo90' | 'bingo75Lines' | 'classic75';

/** How one surface draws: `texture` (a bare bucket-relative path, '' = none) or else a filled rect in `color`. */
export interface BingoTicketVisual {
  color: number;
  alpha: number;
  texture: string;
}

export interface BingoTicketBackground extends BingoTicketVisual {
  radius: number;
  enabled: boolean;
  /**
   * Grow the body to wrap the to-go badge too (union of grid body and badge,
   * plus paddingX / paddingY on the badge's outer side). Off = the body wraps
   * only the padded grid and the badge sits outside it.
   */
  coverBadge: boolean;
}

export interface BingoTicketCellStates {
  blank: BingoTicketVisual;
  number: BingoTicketVisual;
  called: BingoTicketVisual;
  daubed: BingoTicketVisual;
  winning: BingoTicketVisual;
}

export interface BingoTicketDab {
  enabled: boolean;
  texture: string;
  color: number;
  alpha: number;
  radiusFraction: number;
  popScale: number;
  popMs: number;
}

export interface BingoTicketNumberStyle {
  fontFamily: string;
  fontSize: number;
  fill: number;
  daubedFill: number;
  offsetY: number;
}

export interface BingoTicketHeader {
  enabled: boolean;
  labels: string[];
  height: number;
  fontFamily: string;
  fontSize: number;
  fill: number;
  color: number;
  alpha: number;
}

export interface BingoTicketFreeCell {
  row: number;
  col: number;
}

export interface BingoTicketToGo {
  enabled: boolean;
  side: BingoTicketToGoSide;
  width: number;
  height: number;
  radius: number;
  gap: number;
  colors: number[];
  winColor: number;
  labelFormat: string;
  winText: string;
  fontFamily: string;
  fontSize: number;
  fill: number;
}

export interface NormalizedBingoTicket {
  rows: number;
  cols: number;
  numberMax: number;
  cellLayout: BingoTicketCellLayout;
  numbersPerTicket: number;
  cellWidth: number;
  cellHeight: number;
  gapX: number;
  gapY: number;
  paddingX: number;
  paddingY: number;
  cornerRadius: number;
  background: BingoTicketBackground;
  cellStates: BingoTicketCellStates;
  dab: BingoTicketDab;
  numberStyle: BingoTicketNumberStyle;
  header: BingoTicketHeader;
  freeCells: BingoTicketFreeCell[];
  freeLabel: string;
  toGo: BingoTicketToGo;
  source: BingoTicketSource;
  ticketIndex: number;
  autoBind: boolean;
  previewSeed: number;
  previewCalled: number;
  previewToGo: number;
}

/** The authored fields of a `bingoTicket` node (untrusted). */
export type BingoTicketLike = { [K in keyof NormalizedBingoTicket]?: unknown };

/** A rectangle in the node's space (origin = the node's top-left corner). */
export interface BingoTicketRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the editor shows when the ticket is not bound to game data. */
export interface BingoTicketPreview {
  /** Sample numbers in ticket (server) order. */
  numbers: number[];
  /** rows × cols, 0 = no number. */
  grid: number[][];
  /** rows × cols, true for a daubed number or a free cell. */
  daubed: boolean[][];
  /** Rows whose every number is daubed. */
  winningRows: number[];
}

const DEFAULT_FONT = 'Arial';
const DEFAULT_TO_GO_COLORS = [0xe53223, 0xf39200, 0x1e88e5, 0x2e9d49];

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function intIn(value: unknown, fallback: number, min: number, max: number): number {
  return clamp(Math.round(finiteOr(value, fallback)), min, max);
}

function atLeast(value: unknown, fallback: number, min: number): number {
  return Math.max(min, finiteOr(value, fallback));
}

function colorOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(Math.floor(value), 0, 0xffffff) : fallback;
}

function alphaOr(value: unknown, fallback: number): number {
  return clamp(finiteOr(value, fallback), 0, 1);
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function fontOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function textureOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function visual(color: number, alpha = 1, texture = ''): BingoTicketVisual {
  return { color, alpha, texture };
}

function normalizeVisual(raw: unknown, fallback: BingoTicketVisual): BingoTicketVisual {
  const v = record(raw);
  return {
    color: colorOr(v.color, fallback.color),
    alpha: alphaOr(v.alpha, fallback.alpha),
    texture: 'texture' in v ? textureOf(v.texture) : fallback.texture,
  };
}

/** Every field defaulted: a 90-ball 3 × 9 ticket (the base the presets and normalisation fall back to). */
export function defaultBingoTicket(): NormalizedBingoTicket {
  return {
    rows: 3,
    cols: 9,
    numberMax: 90,
    cellLayout: 'byValueColumn',
    numbersPerTicket: 15,
    cellWidth: 101,
    cellHeight: 48,
    gapX: 2,
    gapY: 2,
    paddingX: 6,
    paddingY: 6,
    cornerRadius: 0,
    background: { enabled: true, color: 0x006971, alpha: 1, texture: '', radius: 14, coverBadge: false },
    cellStates: {
      blank: visual(0xc8ecea),
      number: visual(0xffffff),
      called: visual(0xffffff),
      daubed: visual(0xffffff),
      winning: visual(0xffffff),
    },
    dab: { enabled: true, texture: '', color: 0xe53223, alpha: 1, radiusFraction: 0.875, popScale: 1.25, popMs: 180 },
    numberStyle: { fontFamily: DEFAULT_FONT, fontSize: 34, fill: 0x000000, daubedFill: 0xffffff, offsetY: 0 },
    header: { enabled: false, labels: [], height: 40, fontFamily: DEFAULT_FONT, fontSize: 28, fill: 0xffffff, color: 0x006971, alpha: 1 },
    freeCells: [],
    freeLabel: 'FREE',
    toGo: {
      enabled: true,
      side: 'right',
      width: 110,
      height: 148,
      radius: 18,
      gap: 8,
      colors: DEFAULT_TO_GO_COLORS.slice(),
      winColor: 0xffc20e,
      labelFormat: '{n} TO GO',
      winText: 'WIN',
      fontFamily: DEFAULT_FONT,
      fontSize: 30,
      fill: 0xffffff,
    },
    source: 'current',
    ticketIndex: 0,
    autoBind: true,
    previewSeed: 1,
    previewCalled: 5,
    previewToGo: 3,
  };
}

/** A whole node with every field defaulted and clamped. Never writes `raw`. */
export function normalizeBingoTicket(raw: unknown): NormalizedBingoTicket {
  const d = defaultBingoTicket();
  const t = record(raw) as BingoTicketLike;
  const rows = intIn(t.rows, d.rows, 1, BINGO_TICKET_MAX_DIM);
  const cols = intIn(t.cols, d.cols, 1, BINGO_TICKET_MAX_DIM);
  const numbersPerTicket = intIn(t.numbersPerTicket, d.numbersPerTicket, 1, rows * cols);

  const bg = record(t.background);
  const bgVisual = normalizeVisual(bg, d.background);

  const states = record(t.cellStates);
  const blank = normalizeVisual(states.blank, d.cellStates.blank);
  const number = normalizeVisual(states.number, d.cellStates.number);
  const called = states.called === undefined ? { ...number } : normalizeVisual(states.called, number);
  const daubed = states.daubed === undefined ? { ...number } : normalizeVisual(states.daubed, number);
  const winning = states.winning === undefined ? { ...daubed } : normalizeVisual(states.winning, daubed);

  const dab = record(t.dab);
  const ns = record(t.numberStyle);

  const header = record(t.header);
  const headerEnabled = boolOr(header.enabled, d.header.enabled);
  let labels = (Array.isArray(header.labels) ? header.labels : [])
    .slice(0, BINGO_TICKET_MAX_DIM)
    .map((label) => (typeof label === 'string' ? label : typeof label === 'number' && Number.isFinite(label) ? String(label) : ''));
  if (headerEnabled) {
    labels = labels.slice(0, cols);
    while (labels.length < cols) labels.push('');
  }

  const freeCells: BingoTicketFreeCell[] = [];
  const seenFree = new Set<number>();
  if (Array.isArray(t.freeCells)) {
    for (const entry of t.freeCells) {
      const cell = record(entry);
      const row = cell.row;
      const col = cell.col;
      if (typeof row !== 'number' || typeof col !== 'number' || !Number.isInteger(row) || !Number.isInteger(col)) continue;
      if (row < 0 || row >= rows || col < 0 || col >= cols) continue;
      const key = row * BINGO_TICKET_MAX_DIM + col;
      if (seenFree.has(key)) continue;
      seenFree.add(key);
      freeCells.push({ row, col });
    }
  }

  const toGo = record(t.toGo);
  const side = toGo.side === 'left' || toGo.side === 'top' || toGo.side === 'bottom' ? toGo.side : 'right';
  const colors = Array.isArray(toGo.colors)
    ? toGo.colors.filter((c) => typeof c === 'number' && Number.isFinite(c)).slice(0, BINGO_TICKET_MAX_TO_GO_COLORS).map((c) => colorOr(c, 0))
    : [];

  return {
    rows,
    cols,
    numberMax: intIn(t.numberMax, d.numberMax, 1, BINGO_TICKET_MAX_NUMBER),
    cellLayout: t.cellLayout === 'byIndex' ? 'byIndex' : 'byValueColumn',
    numbersPerTicket,
    cellWidth: atLeast(t.cellWidth, d.cellWidth, 1),
    cellHeight: atLeast(t.cellHeight, d.cellHeight, 1),
    gapX: atLeast(t.gapX, d.gapX, 0),
    gapY: atLeast(t.gapY, d.gapY, 0),
    paddingX: atLeast(t.paddingX, d.paddingX, 0),
    paddingY: atLeast(t.paddingY, d.paddingY, 0),
    cornerRadius: atLeast(t.cornerRadius, d.cornerRadius, 0),
    background: {
      enabled: boolOr(bg.enabled, d.background.enabled),
      color: bgVisual.color,
      alpha: bgVisual.alpha,
      texture: bgVisual.texture,
      radius: atLeast(bg.radius, d.background.radius, 0),
      coverBadge: boolOr(bg.coverBadge, d.background.coverBadge),
    },
    cellStates: { blank, number, called, daubed, winning },
    dab: {
      enabled: boolOr(dab.enabled, d.dab.enabled),
      texture: textureOf(dab.texture),
      color: colorOr(dab.color, d.dab.color),
      alpha: alphaOr(dab.alpha, d.dab.alpha),
      radiusFraction: clamp(finiteOr(dab.radiusFraction, d.dab.radiusFraction), 0, 2),
      popScale: atLeast(dab.popScale, d.dab.popScale, 0),
      popMs: atLeast(dab.popMs, d.dab.popMs, 0),
    },
    numberStyle: {
      fontFamily: fontOr(ns.fontFamily, d.numberStyle.fontFamily),
      fontSize: atLeast(ns.fontSize, d.numberStyle.fontSize, 1),
      fill: colorOr(ns.fill, d.numberStyle.fill),
      daubedFill: colorOr(ns.daubedFill, d.numberStyle.daubedFill),
      offsetY: finiteOr(ns.offsetY, d.numberStyle.offsetY),
    },
    header: {
      enabled: headerEnabled,
      labels,
      height: atLeast(header.height, d.header.height, 0),
      fontFamily: fontOr(header.fontFamily, d.header.fontFamily),
      fontSize: atLeast(header.fontSize, d.header.fontSize, 1),
      fill: colorOr(header.fill, d.header.fill),
      color: colorOr(header.color, d.header.color),
      alpha: alphaOr(header.alpha, d.header.alpha),
    },
    freeCells,
    freeLabel: stringOr(t.freeLabel, d.freeLabel),
    toGo: {
      enabled: boolOr(toGo.enabled, d.toGo.enabled),
      side,
      width: atLeast(toGo.width, d.toGo.width, 1),
      height: atLeast(toGo.height, d.toGo.height, 1),
      radius: atLeast(toGo.radius, d.toGo.radius, 0),
      gap: atLeast(toGo.gap, d.toGo.gap, 0),
      colors: colors.length > 0 ? colors : d.toGo.colors,
      winColor: colorOr(toGo.winColor, d.toGo.winColor),
      labelFormat: stringOr(toGo.labelFormat, d.toGo.labelFormat),
      winText: stringOr(toGo.winText, d.toGo.winText),
      fontFamily: fontOr(toGo.fontFamily, d.toGo.fontFamily),
      fontSize: atLeast(toGo.fontSize, d.toGo.fontSize, 1),
      fill: colorOr(toGo.fill, d.toGo.fill),
    },
    source: t.source === 'next' ? 'next' : 'current',
    ticketIndex: intIn(t.ticketIndex, d.ticketIndex, 0, BINGO_TICKET_MAX_SEED),
    autoBind: boolOr(t.autoBind, d.autoBind),
    previewSeed: intIn(t.previewSeed, d.previewSeed, 0, BINGO_TICKET_MAX_SEED),
    previewCalled: intIn(t.previewCalled, d.previewCalled, 0, numbersPerTicket),
    previewToGo: intIn(t.previewToGo, d.previewToGo, 0, 99),
  };
}

// ── Presets ─────────────────────────────────────────────────────────────────

/**
 * Look presets (layout + visuals). The game-data and editor-preview fields are
 * not part of a preset — see {@link applyBingoTicketPreset}.
 */
export const bingoTicketPresets: Readonly<Record<BingoTicketPresetName, BingoTicketLike>> = {
  // 90-ball: 3 × 9, numbers in value bands of ten, a teal body wrapping the grid and its side badge.
  bingo90: {
    rows: 3,
    cols: 9,
    numberMax: 90,
    cellLayout: 'byValueColumn',
    numbersPerTicket: 15,
    cellWidth: 101,
    cellHeight: 48,
    gapX: 2,
    gapY: 2,
    paddingX: 6,
    paddingY: 6,
    cornerRadius: 0,
    background: { enabled: true, color: 0x006971, alpha: 1, texture: '', radius: 14, coverBadge: true },
    cellStates: {
      blank: visual(0xc8ecea),
      number: visual(0xffffff),
      called: visual(0xffffff),
      daubed: visual(0xffffff),
      winning: visual(0xffffff),
    },
    dab: { enabled: true, texture: '', color: 0xe53223, alpha: 1, radiusFraction: 0.875, popScale: 1.25, popMs: 180 },
    numberStyle: { fontFamily: DEFAULT_FONT, fontSize: 34, fill: 0x000000, daubedFill: 0xffffff, offsetY: 1 },
    header: { enabled: false, labels: [], height: 40, fontFamily: DEFAULT_FONT, fontSize: 28, fill: 0xffffff, color: 0x006971, alpha: 1 },
    freeCells: [],
    freeLabel: 'FREE',
    toGo: {
      enabled: true, side: 'right', width: 110, height: 148, radius: 18, gap: 7,
      colors: DEFAULT_TO_GO_COLORS.slice(), winColor: 0xffc20e,
      labelFormat: '{n}\nTO GO', winText: 'WIN', fontFamily: DEFAULT_FONT, fontSize: 30, fill: 0xffffff,
    },
  },
  // 75-ball lines: 5 × 5 by position, cream cells with rounded grid corners, a tall side badge.
  bingo75Lines: {
    rows: 5,
    cols: 5,
    numberMax: 75,
    cellLayout: 'byIndex',
    numbersPerTicket: 25,
    cellWidth: 196,
    cellHeight: 62,
    gapX: 5,
    gapY: 5,
    paddingX: 0,
    paddingY: 5,
    cornerRadius: 16,
    background: { enabled: false, color: 0x000000, alpha: 0, texture: '', radius: 0, coverBadge: false },
    cellStates: {
      blank: visual(0xfff8e6),
      number: visual(0xfff8e6),
      called: visual(0xfff8e6),
      daubed: visual(0xfff8e6),
      winning: visual(0xfff8e6),
    },
    dab: { enabled: true, texture: '', color: 0xe53223, alpha: 1, radiusFraction: 0.875, popScale: 1.25, popMs: 180 },
    numberStyle: { fontFamily: DEFAULT_FONT, fontSize: 44, fill: 0x1b140a, daubedFill: 0xffffff, offsetY: 0 },
    header: { enabled: false, labels: [], height: 40, fontFamily: DEFAULT_FONT, fontSize: 28, fill: 0xffffff, color: 0x1b140a, alpha: 1 },
    freeCells: [],
    freeLabel: 'FREE',
    toGo: {
      enabled: true, side: 'right', width: 76, height: 330, radius: 38, gap: 8,
      colors: DEFAULT_TO_GO_COLORS.slice(), winColor: 0xffc20e,
      labelFormat: '{n}\nT\nG', winText: 'W\nI\nN', fontFamily: DEFAULT_FONT, fontSize: 30, fill: 0xffffff,
    },
  },
  // Classic 75-ball card: B-I-N-G-O header, value-band columns and a free centre.
  classic75: {
    rows: 5,
    cols: 5,
    numberMax: 75,
    cellLayout: 'byValueColumn',
    numbersPerTicket: 24,
    cellWidth: 88,
    cellHeight: 72,
    gapX: 4,
    gapY: 4,
    paddingX: 8,
    paddingY: 8,
    cornerRadius: 0,
    background: { enabled: true, color: 0x1e3a8a, alpha: 1, texture: '', radius: 16, coverBadge: false },
    cellStates: {
      blank: visual(0xdbe4f5),
      number: visual(0xffffff),
      called: visual(0xffffff),
      daubed: visual(0xffffff),
      winning: visual(0xffffff),
    },
    dab: { enabled: true, texture: '', color: 0xe53223, alpha: 1, radiusFraction: 0.875, popScale: 1.25, popMs: 180 },
    numberStyle: { fontFamily: DEFAULT_FONT, fontSize: 36, fill: 0x111827, daubedFill: 0xffffff, offsetY: 0 },
    header: {
      enabled: true, labels: ['B', 'I', 'N', 'G', 'O'], height: 56, fontFamily: DEFAULT_FONT, fontSize: 40,
      fill: 0xffffff, color: 0x1e3a8a, alpha: 1,
    },
    freeCells: [{ row: 2, col: 2 }],
    freeLabel: 'FREE',
    toGo: {
      enabled: false, side: 'bottom', width: 200, height: 56, radius: 16, gap: 8,
      colors: DEFAULT_TO_GO_COLORS.slice(), winColor: 0xffc20e,
      labelFormat: '{n} TO GO', winText: 'BINGO!', fontFamily: DEFAULT_FONT, fontSize: 30, fill: 0xffffff,
    },
  },
};

/** A fresh normalised copy of a preset (game data and preview at their defaults). */
export function bingoTicketPreset(name: BingoTicketPresetName): NormalizedBingoTicket {
  return normalizeBingoTicket(JSON.parse(JSON.stringify(bingoTicketPresets[name] ?? {})));
}

/** `ticket` restyled as `name`: every look field from the preset, its game data and preview kept. */
export function applyBingoTicketPreset(ticket: unknown, name: BingoTicketPresetName): NormalizedBingoTicket {
  const current = normalizeBingoTicket(ticket);
  const preset = bingoTicketPreset(name);
  return normalizeBingoTicket({
    ...preset,
    source: current.source,
    ticketIndex: current.ticketIndex,
    autoBind: current.autoBind,
    previewSeed: current.previewSeed,
    previewCalled: current.previewCalled,
    previewToGo: current.previewToGo,
  });
}

// ── Layout ──────────────────────────────────────────────────────────────────

function gridWidth(t: NormalizedBingoTicket): number {
  return t.cols * t.cellWidth + (t.cols - 1) * t.gapX;
}

function gridHeight(t: NormalizedBingoTicket): number {
  return t.rows * t.cellHeight + (t.rows - 1) * t.gapY;
}

/** Height the header takes above the grid, its gap included (0 when off). */
function headerBlock(t: NormalizedBingoTicket): number {
  return t.header.enabled ? t.header.height + t.gapY : 0;
}

function bodySize(t: NormalizedBingoTicket): { width: number; height: number } {
  return {
    width: t.paddingX * 2 + gridWidth(t),
    height: t.paddingY * 2 + headerBlock(t) + gridHeight(t),
  };
}

interface TicketPlacement {
  width: number;
  height: number;
  /** What `background` fills (the padded grid, or with `coverBadge` the padded grid plus the badge). */
  body: BingoTicketRect;
  /** The padded grid (padding, header and grid) — what cells and header labels are placed from. */
  grid: BingoTicketRect;
  toGo: BingoTicketRect | null;
}

function placeTicket(t: NormalizedBingoTicket): TicketPlacement {
  const body = bodySize(t);
  if (!t.toGo.enabled) {
    const rect = { x: 0, y: 0, ...body };
    return { width: body.width, height: body.height, body: rect, grid: { ...rect }, toGo: null };
  }
  const bw = t.toGo.width;
  const bh = t.toGo.height;
  const gap = t.toGo.gap;
  // With `coverBadge` the body also wraps the badge, with paddingX / paddingY
  // on the badge's outer side; the node is then exactly the body.
  const cover = t.background.coverBadge;
  if (t.toGo.side === 'left' || t.toGo.side === 'right') {
    const outer = cover ? t.paddingX : 0;
    const height = Math.max(body.height, bh);
    const width = body.width + gap + bw + outer;
    const gridY = (height - body.height) / 2;
    const badgeY = (height - bh) / 2;
    const left = t.toGo.side === 'left';
    const grid = { x: left ? outer + bw + gap : 0, y: gridY, ...body };
    return {
      width,
      height,
      body: cover ? { x: 0, y: 0, width, height } : { ...grid },
      grid,
      toGo: { x: left ? outer : body.width + gap, y: badgeY, width: bw, height: bh },
    };
  }
  const outer = cover ? t.paddingY : 0;
  const width = Math.max(body.width, bw);
  const height = body.height + gap + bh + outer;
  const gridX = (width - body.width) / 2;
  const badgeX = (width - bw) / 2;
  const top = t.toGo.side === 'top';
  const grid = { x: gridX, y: top ? outer + bh + gap : 0, ...body };
  return {
    width,
    height,
    body: cover ? { x: 0, y: 0, width, height } : { ...grid },
    grid,
    toGo: { x: badgeX, y: top ? outer : body.height + gap, width: bw, height: bh },
  };
}

/** The whole node: body (padding, header and grid) plus the to-go badge (with `coverBadge`, exactly the body). */
export function bingoTicketSize(t: NormalizedBingoTicket): { width: number; height: number } {
  const placed = placeTicket(t);
  return { width: placed.width, height: placed.height };
}

/** The ticket body — what `background` fills (grid + padding; with `coverBadge` also the badge and its outer padding). */
export function bingoTicketBodyRect(t: NormalizedBingoTicket): BingoTicketRect {
  return { ...placeTicket(t).body };
}

/** One cell of the grid. */
export function bingoTicketCellRect(t: NormalizedBingoTicket, row: number, col: number): BingoTicketRect {
  const body = placeTicket(t).grid;
  return {
    x: body.x + t.paddingX + col * (t.cellWidth + t.gapX),
    y: body.y + t.paddingY + headerBlock(t) + row * (t.cellHeight + t.gapY),
    width: t.cellWidth,
    height: t.cellHeight,
  };
}

/** One column's header label box, or null when the header is off. */
export function bingoTicketHeaderRect(t: NormalizedBingoTicket, col: number): BingoTicketRect | null {
  if (!t.header.enabled) return null;
  const body = placeTicket(t).grid;
  return {
    x: body.x + t.paddingX + col * (t.cellWidth + t.gapX),
    y: body.y + t.paddingY,
    width: t.cellWidth,
    height: t.header.height,
  };
}

/** The to-go badge, or null when it is off. */
export function bingoTicketToGoRect(t: NormalizedBingoTicket): BingoTicketRect | null {
  const badge = placeTicket(t).toGo;
  return badge ? { ...badge } : null;
}

/**
 * Corner radii of one cell, `[topLeft, topRight, bottomRight, bottomLeft]`:
 * only the grid's four outer corners are rounded, by `cornerRadius` (capped at
 * half the cell).
 */
export function bingoTicketCellRadii(t: NormalizedBingoTicket, row: number, col: number): [number, number, number, number] {
  const r = Math.min(t.cornerRadius, t.cellWidth / 2, t.cellHeight / 2);
  const top = row === 0;
  const bottom = row === t.rows - 1;
  const left = col === 0;
  const right = col === t.cols - 1;
  return [top && left ? r : 0, top && right ? r : 0, bottom && right ? r : 0, bottom && left ? r : 0];
}

/** Radius of the daub circle. */
export function bingoTicketDabRadius(t: NormalizedBingoTicket): number {
  return (t.dab.radiusFraction * Math.min(t.cellWidth, t.cellHeight)) / 2;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

/** Width of one value band (`byValueColumn`): ceil(numberMax / cols). */
export function bingoTicketColumnBand(t: NormalizedBingoTicket): number {
  return Math.max(1, Math.ceil(t.numberMax / t.cols));
}

/** Grid column of a ticket number: by value band (`byValueColumn`) or by position (`byIndex`). */
export function bingoTicketCellColumn(t: NormalizedBingoTicket, value: number, index: number): number {
  if (t.cellLayout === 'byIndex') {
    const i = Math.max(0, Math.floor(finiteOr(index, 0)));
    return i % t.cols;
  }
  return clamp(Math.floor(finiteOr(value, 0) / bingoTicketColumnBand(t)), 0, t.cols - 1);
}

/** Grid row of the `index`-th number (ticket order): numbersPerTicket / rows numbers per row. */
export function bingoTicketCellRow(t: NormalizedBingoTicket, index: number): number {
  const perRow = t.numbersPerTicket / t.rows;
  return clamp(Math.floor(Math.max(0, finiteOr(index, 0)) / perRow), 0, t.rows - 1);
}

/** Whether a cell is one of the always-daubed free cells. */
export function bingoTicketIsFreeCell(t: NormalizedBingoTicket, row: number, col: number): boolean {
  return t.freeCells.some((cell) => cell.row === row && cell.col === col);
}

function freeMask(t: NormalizedBingoTicket): boolean[][] {
  const mask: boolean[][] = [];
  for (let r = 0; r < t.rows; r += 1) mask.push(new Array<boolean>(t.cols).fill(false));
  for (const cell of t.freeCells) {
    if (cell.row >= 0 && cell.row < t.rows && cell.col >= 0 && cell.col < t.cols) mask[cell.row][cell.col] = true;
  }
  return mask;
}

function emptyGrid(t: NormalizedBingoTicket): number[][] {
  const grid: number[][] = [];
  for (let r = 0; r < t.rows; r += 1) grid.push(new Array<number>(t.cols).fill(0));
  return grid;
}

/**
 * Lay a ticket's numbers (ticket order) into a rows × cols grid, 0 = blank.
 * Each number goes to `bingoTicketCellRow` / `bingoTicketCellColumn`; when that
 * cell is free or taken it moves to the next open cell — down its own column
 * (wrapping) for `byValueColumn`, along the rows (wrapping) for `byIndex` — and
 * is dropped when there is none. Non-positive / non-finite entries are skipped.
 */
export function bingoTicketGridFromNumbers(t: NormalizedBingoTicket, numbers: readonly number[]): number[][] {
  const grid = emptyGrid(t);
  const free = freeMask(t);
  const open = (r: number, c: number): boolean => !free[r][c] && grid[r][c] === 0;
  const list = Array.isArray(numbers) ? numbers : [];
  for (let index = 0; index < list.length; index += 1) {
    const value = Math.floor(finiteOr(list[index], 0));
    if (value <= 0) continue;
    const row = bingoTicketCellRow(t, index);
    const col = bingoTicketCellColumn(t, value, index);
    if (t.cellLayout === 'byValueColumn') {
      for (let step = 0; step < t.rows; step += 1) {
        const r = (row + step) % t.rows;
        if (open(r, col)) {
          grid[r][col] = value;
          break;
        }
      }
    } else {
      const total = t.rows * t.cols;
      const start = row * t.cols + col;
      for (let step = 0; step < total; step += 1) {
        const k = (start + step) % total;
        const r = Math.floor(k / t.cols);
        const c = k % t.cols;
        if (open(r, c)) {
          grid[r][c] = value;
          break;
        }
      }
    }
  }
  return grid;
}

/** Deterministic PRNG (mulberry32) in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = (Math.floor(finiteOr(seed, 0)) >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

/**
 * A valid sample ticket for the layout, in ticket order — the same `seed`
 * always gives the same numbers. Values are unique, 1..numberMax, and sit in
 * their column's value band; free cells get none. `byValueColumn` spreads
 * numbersPerTicket across the rows (as evenly as the free cells allow) and the
 * columns; `byIndex` fills every open cell up to numbersPerTicket. Laying the
 * result out with {@link bingoTicketGridFromNumbers} gives the intended grid.
 */
export function bingoTicketSampleNumbers(t: NormalizedBingoTicket, seed: number): number[] {
  const rand = seededRandom(seed);
  const free = freeMask(t);
  const band = bingoTicketColumnBand(t);
  const bandValues: number[][] = [];
  for (let c = 0; c < t.cols; c += 1) bandValues.push([]);
  for (let v = 1; v <= t.numberMax; v += 1) bandValues[clamp(Math.floor(v / band), 0, t.cols - 1)].push(v);

  // Choose the cells that get a number.
  const chosen: Array<{ row: number; col: number }> = [];
  if (t.cellLayout === 'byIndex') {
    for (let r = 0; r < t.rows; r += 1) {
      for (let c = 0; c < t.cols; c += 1) if (!free[r][c]) chosen.push({ row: r, col: c });
    }
    chosen.length = Math.min(chosen.length, t.numbersPerTicket);
  } else {
    const rowCap = free.map((row) => row.filter((isFree) => !isFree).length);
    const count = Math.min(t.numbersPerTicket, rowCap.reduce((sum, n) => sum + n, 0));
    const base = Math.floor(count / t.rows);
    const targets = rowCap.map((cap) => Math.min(cap, base));
    let remaining = count - targets.reduce((sum, n) => sum + n, 0);
    while (remaining > 0) {
      let placed = false;
      for (let r = 0; r < t.rows && remaining > 0; r += 1) {
        if (targets[r] < rowCap[r]) {
          targets[r] += 1;
          remaining -= 1;
          placed = true;
        }
      }
      if (!placed) break;
    }
    const colUsed = new Array<number>(t.cols).fill(0);
    for (let r = 0; r < t.rows; r += 1) {
      const candidates = shuffled(
        Array.from({ length: t.cols }, (_, c) => c).filter((c) => !free[r][c] && colUsed[c] < bandValues[c].length),
        rand,
      ).sort((a, b) => colUsed[a] - colUsed[b]);
      const picked = candidates.slice(0, targets[r]).sort((a, b) => a - b);
      for (const c of picked) {
        colUsed[c] += 1;
        chosen.push({ row: r, col: c });
      }
    }
  }

  // Values per column: from the column's band, ascending down the column.
  const used = new Set<number>();
  const valueAt = new Map<number, number>();
  for (let c = 0; c < t.cols; c += 1) {
    const cells = chosen.filter((cell) => cell.col === c).sort((a, b) => a.row - b.row);
    if (cells.length === 0) continue;
    const pool = shuffled(bandValues[c], rand).slice(0, cells.length);
    if (pool.length < cells.length) {
      // A narrow band (byIndex with a small numberMax): borrow any unused value.
      const spare = shuffled(
        Array.from({ length: t.numberMax }, (_, i) => i + 1).filter((v) => !pool.includes(v) && !bandValues[c].includes(v)),
        rand,
      );
      for (const v of spare) {
        if (pool.length >= cells.length) break;
        if (!used.has(v)) pool.push(v);
      }
    }
    pool.sort((a, b) => a - b);
    cells.forEach((cell, i) => {
      const v = pool[i];
      if (v === undefined || used.has(v)) return;
      used.add(v);
      valueAt.set(cell.row * BINGO_TICKET_MAX_DIM + cell.col, v);
    });
  }

  const ordered = chosen.slice().sort((a, b) => a.row - b.row || a.col - b.col);
  const numbers: number[] = [];
  for (const cell of ordered) {
    const v = valueAt.get(cell.row * BINGO_TICKET_MAX_DIM + cell.col);
    if (v !== undefined) numbers.push(v);
  }
  return numbers;
}

/** Which visual a cell draws. A free cell counts as daubed. */
export function bingoTicketCellState(
  t: NormalizedBingoTicket,
  value: number,
  called: boolean,
  daubed: boolean,
  winningRow: boolean,
  isFree: boolean,
): BingoTicketCellStateName {
  void t;
  const marked = isFree || daubed;
  if (!isFree && !(finiteOr(value, 0) > 0)) return 'blank';
  if (marked && winningRow) return 'winning';
  if (marked) return 'daubed';
  if (called) return 'called';
  return 'number';
}

/** Badge colour for `toGo` numbers left: colors[min(toGo − 1, last)], or winColor at 0. */
export function bingoTicketToGoColor(t: NormalizedBingoTicket, toGo: number): number {
  const n = Math.floor(finiteOr(toGo, 0));
  if (n <= 0 || t.toGo.colors.length === 0) return t.toGo.winColor;
  return t.toGo.colors[Math.min(n - 1, t.toGo.colors.length - 1)];
}

/** Badge text for `toGo` numbers left: labelFormat with `{n}` filled in, or winText at 0. */
export function bingoTicketToGoLabel(t: NormalizedBingoTicket, toGo: number): string {
  const n = Math.floor(finiteOr(toGo, 0));
  if (n <= 0) return t.toGo.winText;
  return t.toGo.labelFormat.split('{n}').join(String(n));
}

/**
 * Rows whose every number is marked (and that hold at least one number or
 * free cell). `marked` is a rows × cols mask (free cells included), or the
 * marked numbers as an array / set — then pass the ticket's `freeCells` too.
 */
export function bingoTicketCompleteRows(
  grid: readonly (readonly number[])[],
  marked: readonly (readonly boolean[])[] | readonly number[] | { has(value: number): boolean },
  freeCells: readonly BingoTicketFreeCell[] = [],
): number[] {
  const rows: number[] = [];
  if (!Array.isArray(grid)) return rows;
  const isMask = Array.isArray(marked) && marked.length > 0 && Array.isArray(marked[0]);
  const numberSet: { has(value: number): boolean } | null = isMask
    ? null
    : Array.isArray(marked)
      ? new Set(marked as readonly number[])
      : (marked as { has(value: number): boolean });
  grid.forEach((cells, r) => {
    if (!Array.isArray(cells)) return;
    let any = false;
    let complete = true;
    cells.forEach((value, c) => {
      const isFree = freeCells.some((cell) => cell.row === r && cell.col === c);
      const hasNumber = finiteOr(value, 0) > 0;
      const isMarked = isMask
        ? (marked as readonly (readonly boolean[])[])[r]?.[c] === true
        : isFree || (hasNumber && !!numberSet && numberSet.has(value));
      if (hasNumber || (isFree && isMarked) || (isMask && isMarked)) any = true;
      if (hasNumber && !isMarked) complete = false;
    });
    if (any && complete) rows.push(r);
  });
  return rows;
}

/**
 * What a ticket shows when it is not bound to game data: its sample numbers
 * (`previewSeed`), the first `previewCalled` of them daubed, free cells
 * daubed, and the rows that completes.
 */
export function bingoTicketPreview(t: NormalizedBingoTicket): BingoTicketPreview {
  const numbers = bingoTicketSampleNumbers(t, t.previewSeed);
  const grid = bingoTicketGridFromNumbers(t, numbers);
  const called = new Set(numbers.slice(0, t.previewCalled));
  const free = freeMask(t);
  const daubed = grid.map((cells, r) => cells.map((value, c) => free[r][c] || (value > 0 && called.has(value))));
  return { numbers, grid, daubed, winningRows: bingoTicketCompleteRows(grid, daubed) };
}
