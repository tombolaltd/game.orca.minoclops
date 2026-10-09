/**
 * Shared rich/multi-style text compile helper.
 *
 * Turns a text node (base flat style + optional per-run `richText` overrides)
 * into the `{ text, style }` pair consumed by Pixi 8's `HTMLText`: one
 * `tagStyles` entry per distinct run override, with each run's (escaped) text
 * wrapped in the matching generated tag.
 *
 * KEEP IN SYNC with the editor copy at `src/services/pixi/richText.ts`. Both
 * sides are now on Pixi 8 + `HTMLText`, so an authored rich-text node looks
 * identical in the editor viewport and in-game. This copy re-states the text
 * node's field shape locally (it cannot import editor types); the AUTHORED data
 * shape (`richText[]` runs, each with its own `style.fontFamily`) is identical
 * on both sides. Change one, change the other.
 */

import { Assets, Cache } from 'pixi.js';
import type {
  HTMLTextStyleOptions,
  TextStyleAlign,
  TextStyleFontStyle,
  TextStyleFontWeight,
} from 'pixi.js';

/** Per-run style overrides over the text node base style. Omitted keys inherit the base. */
export interface RichTextRunStyle {
  fill?: number;
  fillAlpha?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold' | 'lighter' | 'bolder' | number;
  fontStyle?: 'normal' | 'italic' | 'oblique';
  underline?: boolean;
  stroke?: number;
  strokeAlpha?: number;
  strokeThickness?: number;
  letterSpacing?: number;
}

/** A contiguous run of text sharing one set of overrides. */
export interface RichTextRun {
  text: string;
  style?: RichTextRunStyle;
}

/** A single linear-gradient colour stop. */
interface ColorStop {
  offset: number;
  color: number;
  alpha?: number;
}

/** A linear gradient fill description (renders as a gradient only with >= 2 stops). */
interface GradientFill {
  stops: ColorStop[];
  direction?: 'vertical' | 'horizontal';
}

/**
 * Structural subset of the runtime scene text node consumed by the compiler.
 * Mirrors the editor `TextNode` field shape (required where the editor
 * requires) so the authored contract stays identical across both surfaces.
 */
export interface RichTextNode {
  text: string;
  fontFamily: string;
  fontSize: number;
  fill: number;
  fillAlpha?: number;
  fillGradient?: GradientFill;
  fontWeight: 'normal' | 'bold' | 'lighter' | 'bolder' | number;
  fontStyle: 'normal' | 'italic' | 'oblique';
  align: 'left' | 'center' | 'right';
  wordWrap: boolean;
  wordWrapWidth: number;
  letterSpacing?: number;
  lineHeight?: number;
  stroke: number;
  strokeAlpha?: number;
  strokeThickness: number;
  dropShadow: boolean;
  dropShadowOptions: {
    color: number;
    blur: number;
    angle: number;
    distance: number;
    alpha: number;
  };
  leading?: number;
  richText?: RichTextRun[];
}

export interface CompiledRichText {
  /** HTML markup: escaped run text wrapped in the generated per-style tags. */
  text: string;
  /** Base `HTMLText` style, carrying the generated `tagStyles` map. */
  style: HTMLTextStyleOptions;
}

/** A stroke in the `{ color, width }` shape Pixi 8 expects. */
interface ResolvedStroke {
  color: number | string;
  width: number;
}

/**
 * Convert a `0xRRGGBB` colour + alpha (0..1) into a CSS `rgba(...)` string.
 * Duplicated (not imported) from `Pixi8Adapter.colorToRgba` so this module
 * stays self-contained for the runtime copy.
 */
function colorToRgba(color: number, alpha: number): string {
  const c = Math.max(0, Math.min(0xffffff, Math.round(color)));
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Fold an optional alpha into the colour, matching the flat text-node path. */
function colorWithAlpha(color: number, alpha: number | undefined): number | string {
  return (typeof alpha === 'number' && alpha < 1) ? colorToRgba(color, alpha) : color;
}

/**
 * `HTMLText` rasterises through an SVG `foreignObject`, so literal text must be
 * XML-escaped or a stray `&`/`<` breaks the whole node (and user markup would
 * otherwise be interpreted). Escaping also makes the generated run tags
 * collision-proof against user text.
 */
function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * True when a text node carries authoritative rich-text runs that actually
 * differ from the flat single-style rendering — i.e. there are 2+ runs OR a
 * single run carrying real style overrides. A lone run with no overrides
 * renders identically to the legacy flat node, so it is NOT "rich".
 */
export function hasRichText(node: RichTextNode): boolean {
  const runs = node.richText;
  return (
    Array.isArray(runs)
    && runs.length > 0
    && runs.some((r) => (r.style && Object.keys(r.style).length > 0) || runs.length > 1)
  );
}

/** The node's base stroke, or undefined when it has no visible stroke. */
function buildBaseStroke(node: RichTextNode): ResolvedStroke | undefined {
  if (!(node.strokeThickness > 0)) return undefined;
  return { color: colorWithAlpha(node.stroke, node.strokeAlpha), width: node.strokeThickness };
}

/**
 * Map a single run's overrides into a partial `HTMLTextStyleOptions` carrying
 * ONLY keys `HTMLText` honours inside a `tagStyles` entry. `underline` is
 * deliberately absent — CSS `text-decoration` is not a tag-style key, so
 * `compileRichText` expresses it with a native `<u>` wrapper instead.
 */
export function richRunStyleToTextStyle(
  style: RichTextRunStyle,
  resolveFont: (family: string) => string,
  baseStroke?: ResolvedStroke,
): HTMLTextStyleOptions {
  const out: HTMLTextStyleOptions = {};
  if (typeof style.fill === 'number') {
    out.fill = colorWithAlpha(style.fill, style.fillAlpha);
  }
  if (typeof style.fontFamily === 'string' && style.fontFamily) {
    out.fontFamily = resolveFont(style.fontFamily);
  }
  if (typeof style.fontSize === 'number') out.fontSize = style.fontSize;
  if (style.fontWeight !== undefined) {
    out.fontWeight = String(style.fontWeight) as TextStyleFontWeight;
  }
  if (typeof style.fontStyle === 'string') {
    out.fontStyle = style.fontStyle as TextStyleFontStyle;
  }
  if (typeof style.letterSpacing === 'number') out.letterSpacing = style.letterSpacing;

  // Pixi 8 models a stroke as { color, width }, so a run overriding only one
  // half still needs the other — inherit it from the node's base stroke.
  if (typeof style.stroke === 'number' || typeof style.strokeThickness === 'number') {
    const width = typeof style.strokeThickness === 'number'
      ? style.strokeThickness
      : (baseStroke?.width ?? 0);
    if (width > 0) {
      out.stroke = {
        color: typeof style.stroke === 'number'
          ? colorWithAlpha(style.stroke, style.strokeAlpha)
          : (baseStroke?.color ?? 0x000000),
        width,
      };
    }
  }
  return out;
}

/**
 * Build the base `HTMLText` style from a text node's flat fields, so the
 * un-overridden runs render like a legacy single-style text node.
 */
function buildBaseStyle(
  node: RichTextNode,
  resolveFont: (family: string) => string,
): HTMLTextStyleOptions {
  const style: HTMLTextStyleOptions = {
    fontFamily: resolveFont(node.fontFamily),
    fontSize: node.fontSize,
    fontWeight: String(node.fontWeight) as TextStyleFontWeight,
    fontStyle: node.fontStyle as TextStyleFontStyle,
    align: node.align as TextStyleAlign,
    wordWrap: node.wordWrap,
    wordWrapWidth: node.wordWrapWidth,
  };

  // HTMLText only ever emits a flat CSS `color:`, so a gradient fill degrades
  // to its first stop.
  const grad = node.fillGradient;
  if (grad && Array.isArray(grad.stops) && grad.stops.length >= 2) {
    const first = [...grad.stops].sort((a, b) => a.offset - b.offset)[0];
    style.fill = colorWithAlpha(first.color, first.alpha);
  } else {
    style.fill = colorWithAlpha(node.fill, node.fillAlpha);
  }

  const stroke = buildBaseStroke(node);
  if (stroke) style.stroke = stroke;

  if (typeof node.letterSpacing === 'number') style.letterSpacing = node.letterSpacing;
  if (typeof node.lineHeight === 'number') style.lineHeight = node.lineHeight;

  if (node.dropShadow) {
    const ds = node.dropShadowOptions;
    style.dropShadow = ds
      ? {
        color: ds.color,
        blur: ds.blur,
        angle: (ds.angle * Math.PI) / 180,
        distance: ds.distance,
        alpha: ds.alpha,
      }
      : true;
  }

  return style;
}

/**
 * Compile a text node's flat base + per-run overrides into an `HTMLText`
 * `{ text, style }`. Deterministic and collision-safe:
 *  - the base style is the node's flat style; run overrides become `tagStyles`.
 *  - run text is XML-escaped, so a generated `<r0>` tag can never collide with
 *    (or be forged by) user text.
 *  - distinct override styles are deduped by a stable JSON signature.
 *  - runs with no expressible overrides are appended as plain escaped text.
 */
export function compileRichText(
  node: RichTextNode,
  resolveFont: (family: string) => string,
): CompiledRichText {
  const style = buildBaseStyle(node, resolveFont);
  const baseStroke = buildBaseStroke(node);
  const tagStyles: Record<string, HTMLTextStyleOptions> = {};

  const runs = Array.isArray(node.richText) ? node.richText : [];
  const sigToTag = new Map<string, string>();
  let tagCount = 0;
  let out = '';

  for (const run of runs) {
    const raw = typeof run.text === 'string' ? run.text : '';
    if (!raw) continue;

    let body = escapeHtmlText(raw);
    const runStyle = run.style;
    const mapped = runStyle ? richRunStyleToTextStyle(runStyle, resolveFont, baseStroke) : {};

    if (runStyle && runStyle.underline) body = `<u>${body}</u>`;

    if (Object.keys(mapped).length > 0) {
      const sig = JSON.stringify(mapped);
      let tag = sigToTag.get(sig);
      if (!tag) {
        tag = `r${tagCount}`;
        tagCount += 1;
        sigToTag.set(sig, tag);
        tagStyles[tag] = mapped;
      }
      body = `<${tag}>${body}</${tag}>`;
    }

    out += body;
  }

  if (tagCount > 0) style.tagStyles = tagStyles;

  return { text: out, style };
}

/** In-flight / settled font registrations, keyed by family + url. */
const htmlTextFontRegistrations = new Map<string, Promise<void>>();

/**
 * Register a scene font with Pixi's asset cache so `HTMLText` can inline it.
 *
 * REQUIRED for custom fonts: `HTMLText` rasterises through an SVG
 * `foreignObject` loaded as an image, which is an isolated document — neither
 * `document.fonts` (what `SceneManager.ensureSceneFontLoaded` populates) nor a
 * page `@font-face` from `static/fonts/fonts-v2.css` is visible to it. Pixi
 * base64-inlines an `@font-face` into the SVG instead, but ONLY for families
 * present in its `Cache` under `` `${family}-and-url` `` — and that entry is
 * written exclusively by the `loadWebFont` asset parser. So the hashed family
 * must additionally be loaded through `Assets`, which this does.
 *
 * Caller must catch: a rejection is not cached, so the load can be retried.
 */
export function registerHtmlTextFont(familyName: string, url: string): Promise<void> {
  const key = `${familyName}\u0000${url}`;
  const existing = htmlTextFontRegistrations.get(key);
  if (existing) return existing;

  const pending = (async () => {
    if (Cache.has(`${familyName}-and-url`)) return;
    await Assets.load({ src: url, data: { family: familyName } });
  })();

  htmlTextFontRegistrations.set(key, pending);
  pending.catch(() => htmlTextFontRegistrations.delete(key));
  return pending;
}
