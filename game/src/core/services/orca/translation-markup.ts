// PARITY CONTRACT: this file must be byte-identical content (modulo imports)
// to the matching file in the template tree
// (`templates/arcade-base-game-template/game/src/core/services/orca/translation-markup.ts`).
// If you change one, change both.
//
// Translation values (`main.orca.translations`) and Game Rules text may carry
// sanitized markup from `@game-studio/htp-rich-text-editor`. Stored allow-list:
// b, strong, i, em, u, br, div, p, span, font; `font[color]`; `span[class]` in
// rte-size-small|medium|large; `span[style]` with only `color:` and
// `font-size: <N>em`. A value carrying no allow-listed tag is plain text.
//
// Everything is RE-VALIDATED here: the write-time sanitizer is not trusted, and
// anything outside the allow-list is dropped (tags) or escaped (text).
//
// Pure module: no DOM, no pixi, no I/O.

type InlineTag = 'b' | 'strong' | 'i' | 'em' | 'u' | 'span';

type MarkupOp =
  | { kind: 'text'; value: string }
  | { kind: 'open'; tag: InlineTag; style: string }
  | { kind: 'close'; tag: InlineTag }
  | { kind: 'break' };

const MARKUP_TAG_RE = /<\s*\/?\s*(?:b|strong|i|em|u|br|div|p|span|font)(?=[\s/>])[^>]*>/i;
const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g;
const SAFE_COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/+-]+\)|[a-z]{3,30})$/i;
const EM_SIZE_RE = /^(?:\d{1,3}(?:\.\d{1,4})?|\.\d{1,4})em$/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

const RTE_SIZE_CLASSES: Record<string, string> = {
  'rte-size-small': '0.8em',
  'rte-size-medium': '1em',
  'rte-size-large': '1.4em',
};

const SIMPLE_INLINE_TAGS = new Set<string>(['b', 'strong', 'i', 'em', 'u']);
const BLOCK_TAGS = new Set<string>(['div', 'p']);
// Never rendered, and their CONTENT is not text either.
const DROP_CONTENT_TAGS = new Set<string>([
  'script', 'style', 'template', 'textarea', 'title', 'iframe', 'object',
  'noscript', 'svg', 'math', 'xmp', 'noembed', 'noframes', 'select',
]);

function coerceValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (whole, body: string) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

function readAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(raw); m; m = ATTR_RE.exec(raw)) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (!Object.prototype.hasOwnProperty.call(out, name)) out[name] = decodeEntities(value);
  }
  return out;
}

function safeColor(value: string | undefined): string {
  const v = (value ?? '').trim();
  return SAFE_COLOR_RE.test(v) ? v : '';
}

function buildInlineStyle(color: string, fontSize: string): string {
  const parts: string[] = [];
  if (color) parts.push(`color:${color}`);
  if (fontSize) parts.push(`font-size:${fontSize}`);
  return parts.join(';');
}

function spanStyle(attrs: Record<string, string>): string {
  let color = '';
  let fontSize = '';
  for (const cls of (attrs.class ?? '').split(/\s+/)) {
    if (Object.prototype.hasOwnProperty.call(RTE_SIZE_CLASSES, cls)) fontSize = RTE_SIZE_CLASSES[cls];
  }
  for (const decl of (attrs.style ?? '').split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (prop === 'color') {
      const c = safeColor(value);
      if (c) color = c;
    } else if (prop === 'font-size') {
      const size = value.replace(/\s+/g, '');
      if (EM_SIZE_RE.test(size)) fontSize = size.toLowerCase();
    }
  }
  return buildInlineStyle(color, fontSize);
}

/**
 * Walk the markup into a flat, balanced op list. Blocks (`div` / `p`) and `br`
 * become line breaks with contenteditable semantics: a block starts a new line
 * only when the current one has content, and a trailing `br` in the last line
 * renders nothing.
 */
function parseMarkup(source: string): MarkupOp[] {
  const ops: MarkupOp[] = [];
  const stack: InlineTag[] = [];
  let lineHasContent = false;
  let pendingBreak = false;

  const flush = (): void => {
    if (pendingBreak) {
      ops.push({ kind: 'break' });
      pendingBreak = false;
    }
  };
  const pushText = (raw: string): void => {
    if (!raw) return;
    // Serializer formatting whitespace between blocks, not authored text.
    if (!lineHasContent && /^\s*$/.test(raw) && raw.indexOf('\n') !== -1) return;
    flush();
    ops.push({ kind: 'text', value: decodeEntities(raw) });
    lineHasContent = true;
  };
  const openInline = (tag: InlineTag, style: string): void => {
    flush();
    ops.push({ kind: 'open', tag, style });
    stack.push(tag);
  };
  const closeInline = (tag: InlineTag): void => {
    const idx = stack.lastIndexOf(tag);
    if (idx < 0) return;
    while (stack.length > idx) ops.push({ kind: 'close', tag: stack.pop() as InlineTag });
  };

  let cursor = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(source); m; m = TOKEN_RE.exec(source)) {
    pushText(source.slice(cursor, m.index));
    cursor = TOKEN_RE.lastIndex;
    if (m[2] === undefined) continue; // comment

    const closing = m[1] === '/';
    const name = m[2].toLowerCase();

    if (DROP_CONTENT_TAGS.has(name)) {
      if (closing) continue;
      const end = source.toLowerCase().indexOf(`</${name}`, cursor);
      if (end < 0) {
        cursor = source.length;
        break;
      }
      const gt = source.indexOf('>', end);
      cursor = gt < 0 ? source.length : gt + 1;
      TOKEN_RE.lastIndex = cursor;
      continue;
    }

    if (name === 'br') {
      flush();
      ops.push({ kind: 'break' });
      lineHasContent = false;
    } else if (BLOCK_TAGS.has(name)) {
      if (!closing && lineHasContent) {
        ops.push({ kind: 'break' });
        lineHasContent = false;
      } else if (closing && lineHasContent) {
        pendingBreak = true;
        lineHasContent = false;
      }
    } else if (SIMPLE_INLINE_TAGS.has(name)) {
      if (closing) closeInline(name as InlineTag);
      else openInline(name as InlineTag, '');
    } else if (name === 'span' || name === 'font') {
      if (closing) {
        closeInline('span');
      } else {
        const attrs = readAttributes(m[3]);
        openInline('span', name === 'font' ? buildInlineStyle(safeColor(attrs.color), '') : spanStyle(attrs));
      }
    }
    // Any other tag is dropped; its content still flows as text.
  }
  pushText(source.slice(cursor));
  while (stack.length > 0) ops.push({ kind: 'close', tag: stack.pop() as InlineTag });

  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (op.kind === 'close') continue;
    if (op.kind === 'break') ops.splice(i, 1);
    break;
  }
  return ops;
}

/** True when `value` is a string carrying at least one allow-listed rich-text tag. */
export function hasTranslationMarkup(value: unknown): boolean {
  return typeof value === 'string' && value.indexOf('<') !== -1 && MARKUP_TAG_RE.test(value);
}

/**
 * `HTMLText`-ready markup. Plain text is XML-escaped verbatim; markup is
 * re-validated against the allow-list, `font[color]` / `rte-size-*` become
 * inline `span` styles, and blocks become `<br/>` line breaks.
 */
export function translationMarkupToHtmlText(value: unknown): string {
  const source = coerceValue(value);
  if (!hasTranslationMarkup(source)) return escapeXml(source);
  let out = '';
  for (const op of parseMarkup(source)) {
    if (op.kind === 'text') out += escapeXml(op.value);
    else if (op.kind === 'break') out += '<br/>';
    else if (op.kind === 'close') out += `</${op.tag}>`;
    else out += op.style ? `<${op.tag} style="${op.style}">` : `<${op.tag}>`;
  }
  return out;
}

/**
 * Plain text for surfaces that cannot render markup: tags stripped, `br` and
 * block boundaries become `\n`, entities decoded. Plain text is returned as-is.
 */
export function translationMarkupToPlainText(value: unknown): string {
  const source = coerceValue(value);
  if (!hasTranslationMarkup(source)) return source;
  let out = '';
  for (const op of parseMarkup(source)) {
    if (op.kind === 'text') out += op.value;
    else if (op.kind === 'break') out += '\n';
  }
  return out;
}
