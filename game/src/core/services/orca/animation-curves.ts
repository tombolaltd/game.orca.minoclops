// PARITY CONTRACT: byte-identical twin of
//   templates/arcade-base-game-template/game/src/core/services/orca/animation-curves.ts
// `npm run check:parity` diffs the two (leading imports stripped). The curve the
// editor PLOTS and previews must be exactly the curve the runtime PLAYS, so every
// change here lands in BOTH files in the same commit.
//
// Self-contained on purpose: no imports, no editor or runtime state. Keyframes are
// typed STRUCTURALLY so the editor's `AnimationKeyframe` and the runtime's own
// mirror both satisfy these shapes without a shared type module.

/** Keyframe-to-keyframe interpolation. The eased names are LEGACY (pre-handle) presets. */
export type CurveInterpolation = 'linear' | 'step' | 'ease' | 'easeIn' | 'easeOut' | 'easeInOut' | 'bezier';

/** Legacy normalised segment curve in CSS `cubic-bezier(x1, y1, x2, y2)` order. */
export type CurveBezierPoints = [number, number, number, number];

/**
 * A Bezier handle as an offset from its OWN key: `[dt seconds, dv value units]`.
 * An `out` handle has `dt >= 0`, an `in` handle `dt <= 0`. On a colour track `dv`
 * is in PROGRESS units (0..1 of the segment), because a packed colour has no
 * meaningful scalar axis.
 */
export type CurveHandle = [number, number];

export interface CurveKeyframe {
  time: number;
  value: number | boolean;
  interpolation?: string;
  bezier?: CurveBezierPoints;
  inHandle?: CurveHandle;
  outHandle?: CurveHandle;
  broken?: boolean;
}

export interface CurveTrackLike {
  property?: string;
  valueType?: string;
  keyframes: CurveKeyframe[];
}

export type CurveSegmentKind = 'hold' | 'linear' | 'bezier';

/**
 * Resolved control points of one segment. `a` / `b` are the TIME fractions of P1 /
 * P2 across the segment (clamped 0..1, which keeps the curve a function of time);
 * `v1` / `v2` are their values — absolute on a numeric track, progress on a colour
 * track.
 */
export interface CurveSegmentControlPoints {
  a: number;
  b: number;
  v1: number;
  v2: number;
}

/** Canonical control points of the legacy named presets (and the identity for the rest). */
export const BEZIER_PRESETS: Readonly<Record<CurveInterpolation, CurveBezierPoints>> = Object.freeze({
  linear: [0, 0, 1, 1],
  step: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  bezier: [0, 0, 1, 1],
} as Record<CurveInterpolation, CurveBezierPoints>);

const LEGACY_PRESET_NAMES: ReadonlyArray<string> = ['ease', 'easeIn', 'easeOut', 'easeInOut'];

/** Properties that carry a packed `0xRRGGBB` colour even when a track predates `valueType: 'color'`. */
const COLOR_PROPERTY_NAMES: ReadonlyArray<string> = ['tint'];

export function isCurveBezierPoints(value: unknown): value is CurveBezierPoints {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(component => typeof component === 'number' && isFinite(component))
  );
}

export function isCurveHandle(value: unknown): value is CurveHandle {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    isFinite(value[0]) &&
    isFinite(value[1])
  );
}

export function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** Fresh tuple with the TIME axis pinned to 0..1; the value axis stays free (overshoot). */
export function clampBezierControlPoints(points: CurveBezierPoints): CurveBezierPoints {
  return [clamp01(points[0]), points[1], clamp01(points[2]), points[3]];
}

export function isLegacyPresetInterpolation(interpolation: unknown): boolean {
  return typeof interpolation === 'string' && LEGACY_PRESET_NAMES.indexOf(interpolation) >= 0;
}

/**
 * Legacy normalised control points of a keyframe's outgoing segment: the custom
 * `bezier` tuple for `'bezier'`, else the named preset, else linear.
 */
export function resolveKeyframeBezier(
  keyframe: { interpolation?: string; bezier?: CurveBezierPoints } | null | undefined,
): CurveBezierPoints {
  const custom = keyframe ? keyframe.bezier : undefined;
  if (keyframe && keyframe.interpolation === 'bezier' && isCurveBezierPoints(custom)) {
    return clampBezierControlPoints(custom);
  }
  const name = keyframe && typeof keyframe.interpolation === 'string' ? keyframe.interpolation : 'linear';
  const preset = (BEZIER_PRESETS as Record<string, CurveBezierPoints>)[name] || BEZIER_PRESETS.linear;
  return [preset[0], preset[1], preset[2], preset[3]];
}

/** Polynomial form of one axis of a unit cubic bezier: `a·u³ + b·u² + c·u`. */
function bezierAxis(u: number, c1: number, c2: number): number {
  return (((1 - 3 * c2 + 3 * c1) * u + (3 * c2 - 6 * c1)) * u + 3 * c1) * u;
}

function bezierAxisSlope(u: number, c1: number, c2: number): number {
  return 3 * (1 - 3 * c2 + 3 * c1) * u * u + 2 * (3 * c2 - 6 * c1) * u + 3 * c1;
}

const NEWTON_ITERATIONS = 8;
const NEWTON_MIN_SLOPE = 1e-3;
const SOLVE_EPSILON = 1e-7;
const BISECTION_ITERATIONS = 32;

/**
 * Invert the time axis: the parametric `u` where `x(u) === x`. Newton-Raphson with a
 * bisection fallback, both iteration-capped so degenerate control points cannot spin.
 */
export function solveBezierParametric(x: number, x1: number, x2: number): number {
  let u = x;
  for (let i = 0; i < NEWTON_ITERATIONS; i += 1) {
    const error = bezierAxis(u, x1, x2) - x;
    if (Math.abs(error) < SOLVE_EPSILON) return u;
    const slope = bezierAxisSlope(u, x1, x2);
    if (!(Math.abs(slope) >= NEWTON_MIN_SLOPE)) break;
    u -= error / slope;
  }

  let low = 0;
  let high = 1;
  u = x;
  for (let i = 0; i < BISECTION_ITERATIONS; i += 1) {
    const current = bezierAxis(u, x1, x2);
    if (Math.abs(current - x) < SOLVE_EPSILON) break;
    if (current > x) high = u;
    else low = u;
    u = (low + high) / 2;
  }
  return u;
}

/**
 * Evaluate a unit cubic bezier `cubic-bezier(x1, y1, x2, y2)` at normalised time `t`.
 * Exact at the endpoints; unclamped in between so `y` outside 0..1 overshoots.
 */
export function cubicBezierEase(t: number, x1: number, y1: number, x2: number, y2: number): number {
  const at = isFinite(t) ? t : 0;
  if (at <= 0) return 0;
  if (at >= 1) return 1;
  if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return at;
  const cx1 = clamp01(x1);
  const cx2 = clamp01(x2);
  if (cx1 === y1 && cx2 === y2) return at;
  return bezierAxis(solveBezierParametric(at, cx1, cx2), y1, y2);
}

/** Cubic Bernstein value at parameter `u`. */
export function bezierValueAt(u: number, v0: number, v1: number, v2: number, v3: number): number {
  const inv = 1 - u;
  return inv * inv * inv * v0 + 3 * inv * inv * u * v1 + 3 * inv * u * u * v2 + u * u * u * v3;
}

export function isColorCurveTrack(track: CurveTrackLike | null | undefined): boolean {
  if (!track) return false;
  if (track.valueType === 'color') return true;
  return typeof track.property === 'string' && COLOR_PROPERTY_NAMES.indexOf(track.property) >= 0;
}

export function isBooleanCurveTrack(track: CurveTrackLike | null | undefined): boolean {
  return !!track && track.valueType === 'boolean';
}

/** How the segment LEAVING `left` interpolates. */
export function segmentKindForKeyframe(left: CurveKeyframe | null | undefined): CurveSegmentKind {
  const interpolation = left ? left.interpolation : undefined;
  if (interpolation === 'step') return 'hold';
  if (interpolation === 'bezier' || isLegacyPresetInterpolation(interpolation)) return 'bezier';
  return 'linear';
}

function numericValue(value: number | boolean | undefined): number {
  return typeof value === 'number' && isFinite(value) ? value : 0;
}

/**
 * Clamped automatic tangent slope at `index` (value units per second): Steffen's
 * monotone method, so an automatic curve never overshoots its keys and is flat at
 * every local extremum. The first and last keys are flat (Spine 4.3 behaviour).
 */
export function autoTangentSlope(keyframes: CurveKeyframe[], index: number): number {
  if (index <= 0 || index >= keyframes.length - 1) return 0;
  const previous = keyframes[index - 1];
  const current = keyframes[index];
  const next = keyframes[index + 1];
  if (typeof previous.value !== 'number' || typeof current.value !== 'number' || typeof next.value !== 'number') {
    return 0;
  }
  const spanLeft = current.time - previous.time;
  const spanRight = next.time - current.time;
  if (!(spanLeft > 0) || !(spanRight > 0)) return 0;
  const slopeLeft = (current.value - previous.value) / spanLeft;
  const slopeRight = (next.value - current.value) / spanRight;
  if (!(slopeLeft * slopeRight > 0)) return 0;
  const weighted = (slopeLeft * spanRight + slopeRight * spanLeft) / (spanLeft + spanRight);
  const magnitude = Math.min(2 * Math.abs(slopeLeft), 2 * Math.abs(slopeRight), Math.abs(weighted));
  return slopeLeft > 0 ? magnitude : -magnitude;
}

/** The automatic handle for one side of a key (numeric tracks). */
export function autoHandle(keyframes: CurveKeyframe[], index: number, side: 'in' | 'out'): CurveHandle {
  const key = keyframes[index];
  const neighbour = keyframes[side === 'out' ? index + 1 : index - 1];
  if (!key || !neighbour) return [0, 0];
  const span = Math.abs(neighbour.time - key.time);
  const slope = autoTangentSlope(keyframes, index);
  const dt = (side === 'out' ? span : -span) / 3;
  return [dt, slope * dt];
}

/** A colour track's automatic handle reproduces a straight (linear) progress curve. */
function autoColorHandle(keyframes: CurveKeyframe[], index: number, side: 'in' | 'out'): CurveHandle {
  const key = keyframes[index];
  const neighbour = keyframes[side === 'out' ? index + 1 : index - 1];
  if (!key || !neighbour) return [0, 0];
  const span = Math.abs(neighbour.time - key.time);
  return side === 'out' ? [span / 3, 1 / 3] : [-span / 3, -1 / 3];
}

/** Scale a handle so its time extent fits `span`, preserving its angle. */
function fitHandle(handle: CurveHandle, span: number, side: 'in' | 'out'): CurveHandle {
  let dt = side === 'out' ? Math.max(0, handle[0]) : Math.min(0, handle[0]);
  let dv = handle[1];
  const extent = Math.abs(dt);
  if (extent > span && extent > 0) {
    const factor = span / extent;
    dt *= factor;
    dv *= factor;
  }
  return [dt, dv];
}

function legacySegmentPoints(
  tuple: CurveBezierPoints,
  v0: number,
  v3: number,
  progress: boolean,
): CurveSegmentControlPoints {
  const clamped = clampBezierControlPoints(tuple);
  if (progress) return { a: clamped[0], b: clamped[2], v1: clamped[1], v2: clamped[3] };
  const delta = v3 - v0;
  return { a: clamped[0], b: clamped[2], v1: v0 + clamped[1] * delta, v2: v0 + clamped[3] * delta };
}

/**
 * Control points of the segment `keyframes[index] → keyframes[index + 1]`, or null
 * when it is not a Bezier segment.
 *
 * Precedence: a legacy named preset; then a legacy normalised `bezier` tuple, but
 * only while NEITHER end carries an explicit handle; otherwise the left key's `out`
 * handle and the right key's `in` handle, each falling back to its automatic handle
 * when absent.
 */
export function resolveSegmentControlPoints(
  keyframes: CurveKeyframe[],
  index: number,
  progress: boolean,
): CurveSegmentControlPoints | null {
  const left = keyframes[index];
  const right = keyframes[index + 1];
  if (!left || !right) return null;
  if (segmentKindForKeyframe(left) !== 'bezier') return null;
  const span = right.time - left.time;
  if (!(span > 0)) return null;

  const v0 = progress ? 0 : numericValue(left.value);
  const v3 = progress ? 1 : numericValue(right.value);

  if (isLegacyPresetInterpolation(left.interpolation)) {
    return legacySegmentPoints(resolveKeyframeBezier(left), v0, v3, progress);
  }
  if (isCurveBezierPoints(left.bezier) && !isCurveHandle(left.outHandle) && !isCurveHandle(right.inHandle)) {
    return legacySegmentPoints(left.bezier, v0, v3, progress);
  }

  const outRaw = isCurveHandle(left.outHandle)
    ? left.outHandle
    : (progress ? autoColorHandle(keyframes, index, 'out') : autoHandle(keyframes, index, 'out'));
  const inRaw = isCurveHandle(right.inHandle)
    ? right.inHandle
    : (progress ? autoColorHandle(keyframes, index + 1, 'in') : autoHandle(keyframes, index + 1, 'in'));
  const outHandle = fitHandle(outRaw, span, 'out');
  const inHandle = fitHandle(inRaw, span, 'in');

  return {
    a: clamp01(outHandle[0] / span),
    b: clamp01(1 + inHandle[0] / span),
    v1: v0 + outHandle[1],
    v2: v3 + inHandle[1],
  };
}

/** Value (numeric) or progress (colour) of a Bezier segment at normalised time `tn`. */
export function evaluateSegmentPoints(points: CurveSegmentControlPoints, tn: number, v0: number, v3: number): number {
  if (tn <= 0) return v0;
  if (tn >= 1) return v3;
  const u = solveBezierParametric(tn, points.a, points.b);
  return bezierValueAt(u, v0, points.v1, points.v2, v3);
}

function clampChannel(value: number): number {
  const rounded = Math.round(value);
  return rounded <= 0 ? 0 : rounded >= 255 ? 255 : rounded;
}

/** Per-channel blend of two packed `0xRRGGBB` colours; `progress` may overshoot (channels clamp). */
export function interpolatePackedColor(from: number, to: number, progress: number): number {
  const a = Math.max(0, Math.min(0xffffff, Math.round(from))) | 0;
  const b = Math.max(0, Math.min(0xffffff, Math.round(to))) | 0;
  const r = clampChannel(((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * progress);
  const g = clampChannel(((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * progress);
  const bl = clampChannel((a & 0xff) + ((b & 0xff) - (a & 0xff)) * progress);
  return (r << 16) | (g << 8) | bl;
}

/** Index of the last key with `time <= at` (keys sorted ascending), or -1 before the first. */
export function findSegmentIndex(keyframes: CurveKeyframe[], at: number): number {
  let low = 0;
  let high = keyframes.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (keyframes[middle].time <= at) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Evaluate a property track at `time` (seconds). Keys MUST be sorted by time.
 *
 * - Before the first / after the last key the value clamps to that key.
 * - Boolean tracks, `step` segments and any non-numeric pair hold the LEFT key.
 * - Colour tracks blend per channel; Bezier shapes their progress, not a channel.
 * - `stepped` holds every segment (the editor's pose-to-pose preview).
 * - null for an empty track.
 */
export function sampleCurveTrack(
  track: CurveTrackLike | null | undefined,
  time: number,
  stepped?: boolean,
): number | boolean | null {
  const keyframes = track ? track.keyframes : undefined;
  if (!keyframes || keyframes.length === 0) return null;

  const at = isFinite(time) ? time : 0;
  const first = keyframes[0];
  if (at <= first.time) return first.value;
  const last = keyframes[keyframes.length - 1];
  if (at >= last.time) return last.value;

  const index = findSegmentIndex(keyframes, at);
  if (index < 0) return first.value;
  const left = keyframes[index];
  const right = keyframes[index + 1];
  if (!right) return left.value;

  if (
    stepped === true ||
    isBooleanCurveTrack(track) ||
    typeof left.value !== 'number' ||
    typeof right.value !== 'number'
  ) {
    return left.value;
  }

  const kind = segmentKindForKeyframe(left);
  if (kind === 'hold') return left.value;

  const span = right.time - left.time;
  if (!(span > 0)) return right.value;
  const tn = (at - left.time) / span;
  const color = isColorCurveTrack(track);

  let progressOrValue: number;
  if (kind === 'linear') {
    progressOrValue = color ? tn : left.value + (right.value - left.value) * tn;
  } else {
    const points = resolveSegmentControlPoints(keyframes, index, color);
    if (!points) {
      progressOrValue = color ? tn : left.value + (right.value - left.value) * tn;
    } else if (color) {
      progressOrValue = evaluateSegmentPoints(points, tn, 0, 1);
    } else {
      progressOrValue = evaluateSegmentPoints(points, tn, left.value, right.value);
    }
  }

  return color ? interpolatePackedColor(left.value, right.value, progressOrValue) : progressOrValue;
}
