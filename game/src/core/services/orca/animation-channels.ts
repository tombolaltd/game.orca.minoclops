// PARITY CONTRACT: byte-identical twin of
//   templates/arcade-base-game-template/game/src/core/services/orca/animation-channels.ts
// `npm run check:parity` diffs the two (leading imports stripped). The editor's
// scrub preview and the runtime player must resolve every animation channel key to
// the SAME authored field, so every change here lands in BOTH files in one commit.
//
// A property track's `property` is a CHANNEL KEY. The original keys are dotted PIXI
// paths (`x`, `scale.x`, `alpha`, `tint`, …); newer ones are `@`-namespaced:
//
//   @text.<field>                 text style (`@text.fontSize`, `@text.dropShadowBlur`)
//   @graphics.<index>.<field>     one graphics command (`@graphics.0.fill`)
//   @filter.<index>.<Type>.<key>  one filter setting, `key` `enabled` = the toggle
//   @spine.timeScale / @video.playbackRate
//   @ik.mix                       an IK handle's strength, 0 (FK) … 1 (IK)
//   @skeleton.state               a skeleton's animation state: the index of the animation it plays
//
// A filter channel names its filter TYPE as well as its index, so a reordered or
// retyped filter stack makes the channel inert instead of writing into a stranger.

export type AnimationTransformField =
  | 'x'
  | 'y'
  | 'scaleX'
  | 'scaleY'
  | 'rotation'
  | 'skewX'
  | 'skewY'
  | 'pivotX'
  | 'pivotY';

export type AnimationChannel =
  /** `radians`: the channel value is radians, the authored field degrees. `anchor`: sprite anchor (0..1). */
  | { kind: 'transform'; field: AnimationTransformField; radians: boolean; anchor: boolean }
  | { kind: 'display'; field: 'alpha' | 'visible' | 'tint' | 'width' | 'height' }
  /** A flat authored node field mirrored onto one native property. */
  | { kind: 'field'; field: string }
  | { kind: 'text'; field: string; path: string[] }
  | { kind: 'graphics'; index: number; field: string }
  | { kind: 'filter'; index: number; filterType: string; key: string }
  /** Animated-sprite frame index — no authored field, the native frame only. */
  | { kind: 'frame' }
  /** An IK handle's strength (`@ik.mix`), 0 … 1. */
  | { kind: 'ik'; field: 'mix' }
  /** A skeleton's animation state (`@skeleton.state`): which of its animations plays, held between keys. */
  | { kind: 'state' }
  /** Anything else is a raw dotted PIXI path, applied verbatim at runtime. */
  | { kind: 'unknown'; path: string };

const TRANSFORM_CHANNELS: Readonly<Record<string, { field: AnimationTransformField; radians: boolean; anchor: boolean }>> = {
  'x': { field: 'x', radians: false, anchor: false },
  'y': { field: 'y', radians: false, anchor: false },
  'scale.x': { field: 'scaleX', radians: false, anchor: false },
  'scale.y': { field: 'scaleY', radians: false, anchor: false },
  'rotation': { field: 'rotation', radians: true, anchor: false },
  'skew.x': { field: 'skewX', radians: false, anchor: false },
  'skew.y': { field: 'skewY', radians: false, anchor: false },
  'pivot.x': { field: 'pivotX', radians: false, anchor: false },
  'pivot.y': { field: 'pivotY', radians: false, anchor: false },
  'anchor.x': { field: 'pivotX', radians: false, anchor: true },
  'anchor.y': { field: 'pivotY', radians: false, anchor: true },
};

const DISPLAY_CHANNELS: ReadonlyArray<string> = ['alpha', 'visible', 'tint', 'width', 'height'];

const FIELD_CHANNELS: Readonly<Record<string, string>> = {
  'animationSpeed': 'animationSpeed',
  'tilePosition.x': 'tilePositionX',
  'tilePosition.y': 'tilePositionY',
  'tileScale.x': 'tileScaleX',
  'tileScale.y': 'tileScaleY',
  'leftWidth': 'leftWidth',
  'topHeight': 'topHeight',
  'rightWidth': 'rightWidth',
  'bottomHeight': 'bottomHeight',
  '@spine.timeScale': 'timeScale',
  '@video.playbackRate': 'playbackRate',
};

/** `@text.<channel>` → the path of the authored TextNode field it drives. */
export const TEXT_CHANNEL_PATHS: Readonly<Record<string, string[]>> = {
  fontSize: ['fontSize'],
  fill: ['fill'],
  fillAlpha: ['fillAlpha'],
  stroke: ['stroke'],
  strokeAlpha: ['strokeAlpha'],
  strokeThickness: ['strokeThickness'],
  letterSpacing: ['letterSpacing'],
  lineHeight: ['lineHeight'],
  leading: ['leading'],
  wordWrapWidth: ['wordWrapWidth'],
  dropShadow: ['dropShadow'],
  dropShadowColor: ['dropShadowOptions', 'color'],
  dropShadowAlpha: ['dropShadowOptions', 'alpha'],
  dropShadowBlur: ['dropShadowOptions', 'blur'],
  dropShadowAngle: ['dropShadowOptions', 'angle'],
  dropShadowDistance: ['dropShadowOptions', 'distance'],
};

/** Authored graphics-command fields a `@graphics.<index>.<field>` channel may drive. */
export const GRAPHICS_CHANNEL_FIELDS: ReadonlyArray<string> = [
  'x',
  'y',
  'width',
  'height',
  'radius',
  'x1',
  'y1',
  'x2',
  'y2',
  'fill',
  'fillAlpha',
  'stroke',
  'strokeAlpha',
  'strokeWidth',
];

const CHANNEL_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function parseIndex(raw: string): number {
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : -1;
}

export function parseAnimationChannel(property: string): AnimationChannel {
  const key = typeof property === 'string' ? property.trim() : '';
  const transform = TRANSFORM_CHANNELS[key];
  if (transform) return { kind: 'transform', field: transform.field, radians: transform.radians, anchor: transform.anchor };
  if (DISPLAY_CHANNELS.indexOf(key) >= 0) {
    return { kind: 'display', field: key as 'alpha' | 'visible' | 'tint' | 'width' | 'height' };
  }
  const field = FIELD_CHANNELS[key];
  if (field) return { kind: 'field', field };
  if (key === 'currentFrame') return { kind: 'frame' };
  if (key === IK_MIX_CHANNEL) return { kind: 'ik', field: 'mix' };
  if (key === SKELETON_STATE_CHANNEL) return { kind: 'state' };

  const parts = key.split('.');
  if (parts[0] === '@text' && parts.length === 2) {
    const path = TEXT_CHANNEL_PATHS[parts[1]];
    if (path) return { kind: 'text', field: parts[1], path: path.slice() };
  }
  if (parts[0] === '@graphics' && parts.length === 3) {
    const index = parseIndex(parts[1]);
    if (index >= 0 && GRAPHICS_CHANNEL_FIELDS.indexOf(parts[2]) >= 0) {
      return { kind: 'graphics', index, field: parts[2] };
    }
  }
  if (parts[0] === '@filter' && parts.length === 4) {
    const index = parseIndex(parts[1]);
    if (index >= 0 && CHANNEL_IDENTIFIER.test(parts[2]) && CHANNEL_IDENTIFIER.test(parts[3])) {
      return { kind: 'filter', index, filterType: parts[2], key: parts[3] };
    }
  }
  return { kind: 'unknown', path: key };
}

/** The keyable strength of an IK handle. */
export const IK_MIX_CHANNEL = '@ik.mix';

/**
 * A skeleton's animation state: the index (0-based) of the animation in the
 * skeleton's list it plays. Held between keys; a new value starts that
 * animation from its beginning.
 */
export const SKELETON_STATE_CHANNEL = '@skeleton.state';

export function textChannelKey(field: string): string {
  return `@text.${field}`;
}

export function graphicsChannelKey(index: number, field: string): string {
  return `@graphics.${index}.${field}`;
}

export function filterChannelKey(index: number, filterType: string, key: string): string {
  return `@filter.${index}.${filterType}.${key}`;
}

/** Case/punctuation-insensitive filter type comparison (`BlurFilter` ≡ `blurfilter`). */
export function sameFilterType(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const normalize = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalize(a) !== '' && normalize(a) === normalize(b);
}
