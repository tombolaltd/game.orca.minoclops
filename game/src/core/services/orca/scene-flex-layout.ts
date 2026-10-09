// PARITY CONTRACT: this file must be byte-identical content (modulo imports)
// to the matching file in the template tree
// (`templates/arcade-base-game-template/game/src/core/services/orca/scene-flex-layout.ts`).
// If you change one, change both.
//
// Flex Layout: an optional base-node component that hands the node to
// `@pixi/layout` (Yoga flexbox, https://layout.pixijs.io/). The authored
// `style` is a CURATED, ALLOW-LISTED subset of the library's `LayoutStyles`;
// `resolveFlexLayoutStyle` is the only gate between authored scene data and
// `container.layout = …` on BOTH the editor canvas and the runtime, so an
// unknown key or an out-of-range value can never reach Yoga.
//
// A laid-out node's `transform.x/y` reads as an OFFSET from where the flex
// pass places it (the library composes position on top of its own result),
// so the authored transform keeps meaning something on both sides.
//
// Pure module: no framework imports, no reactive state, no I/O.

export type FlexLayoutFieldKind = 'enum' | 'number' | 'length' | 'position';

export type FlexLayoutFieldGroup = 'size' | 'container' | 'item' | 'content';

export interface FlexLayoutFieldSpec {
  kind: FlexLayoutFieldKind;
  group: FlexLayoutFieldGroup;
  label: string;
  /** `enum` only — the accepted values, first one is the library default. */
  options?: readonly string[];
  /** `number` / `length`: smallest accepted numeric value. */
  min?: number;
  /** `length` only: keywords accepted besides numbers and percentages. */
  keywords?: readonly string[];
}

const SIZE_KEYWORDS = ['auto', 'intrinsic'] as const;
const ALIGN = ['flex-start', 'center', 'flex-end', 'stretch', 'baseline'] as const;

export const FLEX_LAYOUT_FIELDS: Readonly<Record<string, FlexLayoutFieldSpec>> = {
  width: { kind: 'length', group: 'size', label: 'Width', min: 0, keywords: SIZE_KEYWORDS },
  height: { kind: 'length', group: 'size', label: 'Height', min: 0, keywords: SIZE_KEYWORDS },
  minWidth: { kind: 'length', group: 'size', label: 'Min Width', min: 0 },
  minHeight: { kind: 'length', group: 'size', label: 'Min Height', min: 0 },
  maxWidth: { kind: 'length', group: 'size', label: 'Max Width', min: 0 },
  maxHeight: { kind: 'length', group: 'size', label: 'Max Height', min: 0 },
  aspectRatio: { kind: 'number', group: 'size', label: 'Aspect Ratio', min: 0 },

  flexDirection: { kind: 'enum', group: 'container', label: 'Direction', options: ['row', 'column', 'row-reverse', 'column-reverse'] },
  flexWrap: { kind: 'enum', group: 'container', label: 'Wrap', options: ['nowrap', 'wrap', 'wrap-reverse'] },
  justifyContent: { kind: 'enum', group: 'container', label: 'Justify Content', options: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] },
  alignItems: { kind: 'enum', group: 'container', label: 'Align Items', options: ALIGN },
  alignContent: { kind: 'enum', group: 'container', label: 'Align Content', options: ['flex-start', 'center', 'flex-end', 'stretch', 'space-between', 'space-around', 'space-evenly'] },
  gap: { kind: 'length', group: 'container', label: 'Gap', min: 0 },
  rowGap: { kind: 'length', group: 'container', label: 'Row Gap', min: 0 },
  columnGap: { kind: 'length', group: 'container', label: 'Column Gap', min: 0 },
  padding: { kind: 'length', group: 'container', label: 'Padding', min: 0 },
  paddingTop: { kind: 'length', group: 'container', label: 'Padding Top', min: 0 },
  paddingRight: { kind: 'length', group: 'container', label: 'Padding Right', min: 0 },
  paddingBottom: { kind: 'length', group: 'container', label: 'Padding Bottom', min: 0 },
  paddingLeft: { kind: 'length', group: 'container', label: 'Padding Left', min: 0 },

  alignSelf: { kind: 'enum', group: 'item', label: 'Align Self', options: ['auto', ...ALIGN] },
  flexGrow: { kind: 'number', group: 'item', label: 'Grow', min: 0 },
  flexShrink: { kind: 'number', group: 'item', label: 'Shrink', min: 0 },
  flexBasis: { kind: 'length', group: 'item', label: 'Basis', min: 0, keywords: ['auto'] },
  margin: { kind: 'length', group: 'item', label: 'Margin', keywords: ['auto'] },
  marginTop: { kind: 'length', group: 'item', label: 'Margin Top', keywords: ['auto'] },
  marginRight: { kind: 'length', group: 'item', label: 'Margin Right', keywords: ['auto'] },
  marginBottom: { kind: 'length', group: 'item', label: 'Margin Bottom', keywords: ['auto'] },
  marginLeft: { kind: 'length', group: 'item', label: 'Margin Left', keywords: ['auto'] },
  position: { kind: 'enum', group: 'item', label: 'Position', options: ['relative', 'absolute'] },
  top: { kind: 'length', group: 'item', label: 'Top' },
  right: { kind: 'length', group: 'item', label: 'Right' },
  bottom: { kind: 'length', group: 'item', label: 'Bottom' },
  left: { kind: 'length', group: 'item', label: 'Left' },
  display: { kind: 'enum', group: 'item', label: 'Display', options: ['flex', 'none'] },

  objectFit: { kind: 'enum', group: 'content', label: 'Object Fit', options: ['fill', 'contain', 'cover', 'none', 'scale-down'] },
  objectPosition: { kind: 'position', group: 'content', label: 'Object Position' },
  transformOrigin: { kind: 'position', group: 'content', label: 'Transform Origin' },
};

export const FLEX_LAYOUT_GROUPS: ReadonlyArray<{ id: FlexLayoutFieldGroup; label: string }> = [
  { id: 'size', label: 'Size' },
  { id: 'container', label: 'Children (as flex container)' },
  { id: 'item', label: 'Self (as flex item)' },
  { id: 'content', label: 'Content' },
];

export type FlexLayoutValue = number | string;

const PERCENT_RE = /^-?\d+(?:\.\d+)?%$/;
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;
const POSITION_TOKEN_RE = /^(?:center|top|bottom|left|right|-?\d+(?:\.\d+)?%?)$/;
const MAX_POSITION_TOKENS = 4;

/**
 * One field value → its canonical stored form, or `undefined` when it is not
 * acceptable for `key` (which also means "clear the field"). Numeric strings
 * are coerced to numbers so an Inspector text box can hand its raw text in.
 */
export function sanitizeFlexLayoutValue(key: string, value: unknown): FlexLayoutValue | undefined {
  if (!Object.prototype.hasOwnProperty.call(FLEX_LAYOUT_FIELDS, key)) return undefined;
  const spec = FLEX_LAYOUT_FIELDS[key];
  const text = typeof value === 'string' ? value.trim() : null;
  const asNumber = typeof value === 'number'
    ? value
    : (text !== null && NUMERIC_RE.test(text) ? Number(text) : NaN);
  const numberOk = Number.isFinite(asNumber) && (spec.min === undefined || asNumber >= spec.min);

  switch (spec.kind) {
    case 'enum':
      return text !== null && (spec.options ?? []).includes(text) ? text : undefined;
    case 'number':
      return numberOk ? asNumber : undefined;
    case 'length':
      if (numberOk) return asNumber;
      if (text === null) return undefined;
      if ((spec.keywords ?? []).includes(text)) return text;
      if (PERCENT_RE.test(text) && (spec.min === undefined || parseFloat(text) >= spec.min)) return text;
      return undefined;
    case 'position': {
      if (Number.isFinite(asNumber)) return asNumber;
      if (text === null || text.length === 0) return undefined;
      const tokens = text.split(/\s+/);
      if (tokens.length > MAX_POSITION_TOKENS) return undefined;
      return tokens.every((token) => POSITION_TOKEN_RE.test(token)) ? tokens.join(' ') : undefined;
    }
    default:
      return undefined;
  }
}

/** Keep only allow-listed keys with acceptable values. Never throws. */
export function sanitizeFlexLayoutStyle(raw: unknown): Record<string, FlexLayoutValue> {
  const style: Record<string, FlexLayoutValue> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return style;
  for (const key of Object.keys(FLEX_LAYOUT_FIELDS)) {
    const value = sanitizeFlexLayoutValue(key, (raw as Record<string, unknown>)[key]);
    if (value !== undefined) style[key] = value;
  }
  return style;
}

/**
 * The `container.layout` value for an authored component, or `null` when the
 * node must stay OUT of flex layout (absent, malformed or disabled). An empty
 * style is a real answer — it is `layout: true`, i.e. "participate with the
 * library's defaults".
 */
export function resolveFlexLayoutStyle(component: unknown): Record<string, FlexLayoutValue> | null {
  if (!component || typeof component !== 'object' || Array.isArray(component)) return null;
  const record = component as { enabled?: unknown; style?: unknown };
  if (record.enabled === false) return null;
  return sanitizeFlexLayoutStyle(record.style);
}
