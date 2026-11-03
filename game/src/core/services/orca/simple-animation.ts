// PARITY CONTRACT: byte-identical twin of
//   templates/arcade-base-game-template/game/src/core/services/orca/simple-animation.ts
//   templates/bingo-base-game-template/game/src/core/services/orca/simple-animation.ts
// `npm run check:parity` diffs them (leading imports stripped). The editor's
// timeline scrub and the runtime player must sample a Simple Animation clip
// IDENTICALLY, so every change here lands in ALL THREE files in one commit.
// IMPORT-FREE and Pixi-free on purpose: the animation channel keys used by
// `simpleAnimPropsToChannelWrites` are HARDCODED copies of the keys in
// `animationChannels.ts` / `animation-channels.ts` (`x`, `y`, `scale.x`,
// `scale.y`, `rotation`, `skew.x`, `skew.y`, `alpha`, `visible`, `tint`) — keep
// them in step by hand if a key is ever renamed there.
//
// SIMPLE ANIMATION — Flash-style keyframe / classic-tween animation carried as the
// `simpleAnimation` base-node component. A component holds named CLIPS; a clip
// holds LAYERS; each layer drives ONE target node (the host or a descendant)
// from sparse KEYFRAMES. A keyframe sets any subset of the props below; a
// keyframe whose `tween` is `'classic'` interpolates each prop it defines
// toward the NEXT keyframe that defines the same prop, shaped by `ease`.
//
// UNITS match the authored `SceneNode` fields: `rotation` is DEGREES (like
// `transform.rotation`), `skewX` / `skewY` RADIANS (like `transform.skewX`),
// `tint` a packed 0xRRGGBB number. Frames are 0-based integers.

/** `'none'` holds the keyframe's values until the next key; `'classic'` tweens toward it. */
export type SimpleAnimTweenType = 'none' | 'classic';

/** The props one keyframe may set. Absent = this keyframe does not touch that prop. */
export interface SimpleAnimKeyframeProps {
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  /** DEGREES — same unit as `SceneNode.transform.rotation`. */
  rotation?: number;
  /** RADIANS — same unit as `SceneNode.transform.skewX`. */
  skewX?: number;
  /** RADIANS — same unit as `SceneNode.transform.skewY`. */
  skewY?: number;
  alpha?: number;
  /** Stepped, never interpolated. */
  visible?: boolean;
  /** Packed 0xRRGGBB; tweens per channel. */
  tint?: number;
}

export interface SimpleAnimKeyframe {
  /** 0-based frame index. */
  frame: number;
  props: SimpleAnimKeyframeProps;
  tween: SimpleAnimTweenType;
  /** Flash classic ease: -100 (ease in) … 0 (linear) … 100 (ease out). */
  ease?: number;
}

export interface SimpleAnimLayer {
  id: string;
  name: string;
  /** The host node's id or a descendant's id; `''` = unassigned (not sampled). */
  targetId: string;
  /** Editor-only: hidden from the canvas preview. The runtime samples every layer. */
  hidden?: boolean;
  /** Editor-only: no edits. */
  locked?: boolean;
  /** Sorted by `frame`, frames unique. */
  keyframes: SimpleAnimKeyframe[];
}

export interface SimpleAnimFrameLabel {
  frame: number;
  name: string;
}

export interface SimpleAnimationClip {
  id: string;
  /** Unique within the component. */
  name: string;
  /** >= 1. */
  lengthFrames: number;
  loop: boolean;
  layers: SimpleAnimLayer[];
  labels?: SimpleAnimFrameLabel[];
}

export interface SimpleAnimationComponent {
  /** Defaults to true when omitted. */
  enabled?: boolean;
  /** Frames per second, 1 … 120 (default 24). */
  fps: number;
  /** Name of the clip played when the scene builds; null / absent = none. */
  autoPlay?: string | null;
  clips: SimpleAnimationClip[];
}

/** One sampled layer: the props to write onto `targetId` at a frame. */
export interface SimpleAnimSampledTarget {
  targetId: string;
  props: SimpleAnimKeyframeProps;
}

export const SIMPLE_ANIM_DEFAULT_FPS = 24;
export const SIMPLE_ANIM_MIN_FPS = 1;
export const SIMPLE_ANIM_MAX_FPS = 120;
export const SIMPLE_ANIM_DEFAULT_LENGTH_FRAMES = 24;
/** Upper bound on a clip's length — a guard against junk, not a creative limit. */
export const SIMPLE_ANIM_MAX_LENGTH_FRAMES = 100000;
export const SIMPLE_ANIM_MIN_EASE = -100;
export const SIMPLE_ANIM_MAX_EASE = 100;

/** Every prop a keyframe may carry, in a fixed order. */
export const SIMPLE_ANIM_PROP_KEYS: ReadonlyArray<keyof SimpleAnimKeyframeProps> = [
  'x', 'y', 'scaleX', 'scaleY', 'rotation', 'skewX', 'skewY', 'alpha', 'visible', 'tint',
];

function simpleAnimIsRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function simpleAnimIsFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function simpleAnimClamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function simpleAnimNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A name not yet in `taken`: `base`, else `base 2`, `base 3`, … */
function simpleAnimUniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/** Keep only the known props, each with a usable value. */
function simpleAnimNormalizeProps(raw: unknown): SimpleAnimKeyframeProps {
  const out: SimpleAnimKeyframeProps = {};
  if (!simpleAnimIsRecord(raw)) return out;
  for (const key of SIMPLE_ANIM_PROP_KEYS) {
    const value = raw[key];
    if (key === 'visible') {
      if (typeof value === 'boolean') out.visible = value;
      continue;
    }
    if (!simpleAnimIsFiniteNumber(value)) continue;
    if (key === 'tint') {
      out.tint = simpleAnimClamp(Math.round(value), 0, 0xffffff);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Keyframes, frames rounded + clamped into `[0, lengthFrames - 1]`, sorted,
 * one per frame (a later entry for the same frame wins).
 */
function simpleAnimNormalizeKeyframes(raw: unknown, lengthFrames: number): SimpleAnimKeyframe[] {
  if (!Array.isArray(raw)) return [];
  const byFrame = new Map<number, SimpleAnimKeyframe>();
  for (const entry of raw) {
    if (!simpleAnimIsRecord(entry)) continue;
    const frame = simpleAnimIsFiniteNumber(entry.frame) ? simpleAnimClamp(Math.round(entry.frame), 0, lengthFrames - 1) : 0;
    const keyframe: SimpleAnimKeyframe = {
      frame,
      props: simpleAnimNormalizeProps(entry.props),
      tween: entry.tween === 'classic' ? 'classic' : 'none',
    };
    if (simpleAnimIsFiniteNumber(entry.ease)) keyframe.ease = simpleAnimClamp(entry.ease, SIMPLE_ANIM_MIN_EASE, SIMPLE_ANIM_MAX_EASE);
    byFrame.set(frame, keyframe);
  }
  return Array.from(byFrame.values()).sort((a, b) => a.frame - b.frame);
}

function simpleAnimMaxKeyframeFrame(rawLayers: unknown): number {
  let max = -1;
  if (!Array.isArray(rawLayers)) return max;
  for (const layer of rawLayers) {
    if (!simpleAnimIsRecord(layer) || !Array.isArray(layer.keyframes)) continue;
    for (const keyframe of layer.keyframes) {
      if (simpleAnimIsRecord(keyframe) && simpleAnimIsFiniteNumber(keyframe.frame)) max = Math.max(max, Math.round(keyframe.frame));
    }
  }
  return max;
}

function simpleAnimNormalizeClip(raw: Record<string, unknown>, index: number, takenIds: Set<string>, takenNames: Set<string>): SimpleAnimationClip {
  let id = simpleAnimNonEmptyString(raw.id) ?? `clip-${index + 1}`;
  id = simpleAnimUniqueName(id, takenIds);
  takenIds.add(id);
  const name = simpleAnimUniqueName(simpleAnimNonEmptyString(raw.name) ?? `Animation ${index + 1}`, takenNames);
  takenNames.add(name);

  let lengthFrames: number;
  if (simpleAnimIsFiniteNumber(raw.lengthFrames)) {
    lengthFrames = Math.round(raw.lengthFrames);
  } else {
    const maxFrame = simpleAnimMaxKeyframeFrame(raw.layers);
    lengthFrames = maxFrame >= 0 ? maxFrame + 1 : SIMPLE_ANIM_DEFAULT_LENGTH_FRAMES;
  }
  lengthFrames = simpleAnimClamp(lengthFrames, 1, SIMPLE_ANIM_MAX_LENGTH_FRAMES);

  const layers: SimpleAnimLayer[] = [];
  const layerIds = new Set<string>();
  if (Array.isArray(raw.layers)) {
    for (const rawLayer of raw.layers) {
      if (!simpleAnimIsRecord(rawLayer)) continue;
      let layerId = simpleAnimNonEmptyString(rawLayer.id) ?? `layer-${layers.length + 1}`;
      layerId = simpleAnimUniqueName(layerId, layerIds);
      layerIds.add(layerId);
      const layer: SimpleAnimLayer = {
        id: layerId,
        name: simpleAnimNonEmptyString(rawLayer.name) ?? `Layer ${layers.length + 1}`,
        // Dangling target ids are kept verbatim (shown "(missing)" by the editor).
        targetId: typeof rawLayer.targetId === 'string' ? rawLayer.targetId : '',
        keyframes: simpleAnimNormalizeKeyframes(rawLayer.keyframes, lengthFrames),
      };
      if (rawLayer.hidden === true) layer.hidden = true;
      if (rawLayer.locked === true) layer.locked = true;
      layers.push(layer);
    }
  }

  const clip: SimpleAnimationClip = { id, name, lengthFrames, loop: raw.loop !== false, layers };

  if (Array.isArray(raw.labels)) {
    const byFrame = new Map<number, string>();
    for (const entry of raw.labels) {
      if (!simpleAnimIsRecord(entry)) continue;
      const labelName = simpleAnimNonEmptyString(entry.name);
      if (!labelName) continue;
      const frame = simpleAnimIsFiniteNumber(entry.frame) ? simpleAnimClamp(Math.round(entry.frame), 0, lengthFrames - 1) : 0;
      byFrame.set(frame, labelName);
    }
    const labelNames = new Set<string>();
    const labels: SimpleAnimFrameLabel[] = [];
    for (const frame of Array.from(byFrame.keys()).sort((a, b) => a - b)) {
      const labelName = byFrame.get(frame) as string;
      if (labelNames.has(labelName)) continue;
      labelNames.add(labelName);
      labels.push({ frame, name: labelName });
    }
    if (labels.length > 0) clip.labels = labels;
  }
  return clip;
}

/**
 * Defensive coercion of an authored (untrusted) `simpleAnimation` value. Returns
 * null for anything that is not an object. Idempotent. Unknown keys are
 * dropped; fps is clamped to 1 … 120; clip ids / names and layer ids are made
 * unique (a repeated clip name gains a " 2", " 3", … suffix); keyframe frames
 * are rounded and clamped into the clip, sorted, and deduped (last wins).
 * Dangling `targetId`s and a dangling `autoPlay` name are KEPT verbatim.
 */
export function normalizeSimpleAnimation(raw: unknown): SimpleAnimationComponent | null {
  if (!simpleAnimIsRecord(raw)) return null;
  const fps = simpleAnimIsFiniteNumber(raw.fps) ? simpleAnimClamp(raw.fps, SIMPLE_ANIM_MIN_FPS, SIMPLE_ANIM_MAX_FPS) : SIMPLE_ANIM_DEFAULT_FPS;
  const clips: SimpleAnimationClip[] = [];
  const takenIds = new Set<string>();
  const takenNames = new Set<string>();
  if (Array.isArray(raw.clips)) {
    for (const rawClip of raw.clips) {
      if (!simpleAnimIsRecord(rawClip)) continue;
      clips.push(simpleAnimNormalizeClip(rawClip, clips.length, takenIds, takenNames));
    }
  }
  return {
    enabled: raw.enabled !== false,
    fps,
    autoPlay: simpleAnimNonEmptyString(raw.autoPlay),
    clips,
  };
}

/**
 * Flash classic-tween ease. `t` is the 0 … 1 progress (clamped); `ease` is
 * -100 (ease in) … 0 (linear) … 100 (ease out). A quadratic blend:
 * `t + e·t·(1 − t)` with `e = ease / 100` — e = 1 is the quad ease-out
 * `1 − (1 − t)²`, e = −1 the quad ease-in `t²`.
 */
export function simpleAnimEase(t: number, ease: number): number {
  const p = simpleAnimIsFiniteNumber(t) ? simpleAnimClamp(t, 0, 1) : 0;
  const e = simpleAnimIsFiniteNumber(ease) ? simpleAnimClamp(ease, SIMPLE_ANIM_MIN_EASE, SIMPLE_ANIM_MAX_EASE) / 100 : 0;
  return p + e * p * (1 - p);
}

function simpleAnimLerpTint(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = simpleAnimClamp(Math.round(ar + (br - ar) * t), 0, 255);
  const g = simpleAnimClamp(Math.round(ag + (bg - ag) * t), 0, 255);
  const bl = simpleAnimClamp(Math.round(ab + (bb - ab) * t), 0, 255);
  return (r << 16) | (g << 8) | bl;
}

function simpleAnimSortedKeyframes(layer: SimpleAnimLayer): SimpleAnimKeyframe[] {
  const keyframes = Array.isArray(layer.keyframes) ? layer.keyframes : [];
  for (let i = 1; i < keyframes.length; i += 1) {
    if (keyframes[i].frame < keyframes[i - 1].frame) {
      return keyframes.slice().sort((a, b) => a.frame - b.frame);
    }
  }
  return keyframes;
}

/**
 * The props a layer sets at `frame` (fractional frames are fine). Per prop:
 * the last keyframe at or before `frame` that defines it rules (before the
 * first such keyframe, the first one's value holds); a prop no keyframe
 * defines is omitted. When the ruling keyframe tweens (`'classic'`) and a
 * LATER keyframe defines the same prop, the value interpolates toward that
 * later keyframe through `simpleAnimEase`. `visible` is always stepped; `tint`
 * tweens per channel.
 */
export function sampleSimpleAnimLayer(layer: SimpleAnimLayer, frame: number): SimpleAnimKeyframeProps {
  const out: SimpleAnimKeyframeProps = {};
  if (!layer) return out;
  const keyframes = simpleAnimSortedKeyframes(layer);
  if (keyframes.length === 0) return out;
  const at = simpleAnimIsFiniteNumber(frame) ? frame : 0;
  for (const key of SIMPLE_ANIM_PROP_KEYS) {
    let rulingIndex = -1;
    let firstIndex = -1;
    for (let i = 0; i < keyframes.length; i += 1) {
      const props = keyframes[i].props;
      if (!props || props[key] === undefined) continue;
      if (firstIndex === -1) firstIndex = i;
      if (keyframes[i].frame <= at) rulingIndex = i;
      else break;
    }
    if (firstIndex === -1) continue;
    if (rulingIndex === -1) {
      (out as Record<string, unknown>)[key] = keyframes[firstIndex].props[key];
      continue;
    }
    const k0 = keyframes[rulingIndex];
    const v0 = k0.props[key];
    if (key === 'visible' || k0.tween !== 'classic') {
      (out as Record<string, unknown>)[key] = v0;
      continue;
    }
    let k1: SimpleAnimKeyframe | null = null;
    for (let i = rulingIndex + 1; i < keyframes.length; i += 1) {
      if (keyframes[i].props && keyframes[i].props[key] !== undefined) {
        k1 = keyframes[i];
        break;
      }
    }
    if (!k1 || k1.frame <= k0.frame || typeof v0 !== 'number') {
      (out as Record<string, unknown>)[key] = v0;
      continue;
    }
    const v1 = k1.props[key] as number;
    const t = simpleAnimEase((at - k0.frame) / (k1.frame - k0.frame), k0.ease ?? 0);
    (out as Record<string, unknown>)[key] = key === 'tint' ? simpleAnimLerpTint(v0, v1, t) : v0 + (v1 - v0) * t;
  }
  return out;
}

/**
 * Sample every layer of a clip at `frame`, in layer order. Layers with an
 * empty `targetId` are skipped; `hidden` is editor-only and NOT honoured here.
 * Two layers may target the same node — apply in order, the later one wins.
 */
export function sampleSimpleAnimClip(clip: SimpleAnimationClip, frame: number): SimpleAnimSampledTarget[] {
  const out: SimpleAnimSampledTarget[] = [];
  if (!clip || !Array.isArray(clip.layers)) return out;
  for (const layer of clip.layers) {
    if (!layer || typeof layer.targetId !== 'string' || layer.targetId.length === 0) continue;
    out.push({ targetId: layer.targetId, props: sampleSimpleAnimLayer(layer, frame) });
  }
  return out;
}

/**
 * A frame number, or a frame label's name, → a frame index within the clip.
 * Numbers are rounded and clamped into `[0, lengthFrames - 1]`; an unknown
 * label (or a non-finite number) is null.
 */
export function resolveSimpleAnimFrame(clip: SimpleAnimationClip, frameOrLabel: number | string): number | null {
  if (!clip) return null;
  const last = Math.max(1, Math.round(simpleAnimIsFiniteNumber(clip.lengthFrames) ? clip.lengthFrames : 1)) - 1;
  if (typeof frameOrLabel === 'number') {
    return simpleAnimIsFiniteNumber(frameOrLabel) ? simpleAnimClamp(Math.round(frameOrLabel), 0, last) : null;
  }
  if (typeof frameOrLabel !== 'string') return null;
  const labels = Array.isArray(clip.labels) ? clip.labels : [];
  for (const label of labels) {
    if (label && label.name === frameOrLabel && simpleAnimIsFiniteNumber(label.frame)) {
      return simpleAnimClamp(Math.round(label.frame), 0, last);
    }
  }
  return null;
}

/** The clip called `name`, or null. */
export function findSimpleAnimClip(component: SimpleAnimationComponent | null | undefined, name: string): SimpleAnimationClip | null {
  if (!component || !Array.isArray(component.clips)) return null;
  for (const clip of component.clips) {
    if (clip && clip.name === name) return clip;
  }
  return null;
}

/**
 * Sampled props → animation CHANNEL writes (the keys of
 * `animation-channels.ts`, hardcoded — see the contract header). `rotation`
 * converts from the authored DEGREES to the channel's RADIANS; skew is
 * radians on both sides.
 */
export function simpleAnimPropsToChannelWrites(props: SimpleAnimKeyframeProps): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  if (!props) return out;
  if (props.x !== undefined) out['x'] = props.x;
  if (props.y !== undefined) out['y'] = props.y;
  if (props.scaleX !== undefined) out['scale.x'] = props.scaleX;
  if (props.scaleY !== undefined) out['scale.y'] = props.scaleY;
  if (props.rotation !== undefined) out['rotation'] = (props.rotation * Math.PI) / 180;
  if (props.skewX !== undefined) out['skew.x'] = props.skewX;
  if (props.skewY !== undefined) out['skew.y'] = props.skewY;
  if (props.alpha !== undefined) out['alpha'] = props.alpha;
  if (props.visible !== undefined) out['visible'] = props.visible;
  if (props.tint !== undefined) out['tint'] = props.tint;
  return out;
}
