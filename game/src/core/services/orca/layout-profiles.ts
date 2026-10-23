// PARITY CONTRACT: written to be a byte-identical twin of the game runtime's
//   templates/arcade-base-game-template/game/src/core/services/orca/layout-profiles.ts
// (the runtime copy lands with the runtime task; add the pair to
// scripts/check-parity.mjs then). The editor canvas and the runtime must pick
// the SAME profile for the same screen, so every change lands in both files.
//
// ADVANCED LAYOUT MANAGER PROFILES — an ordered list of named layouts, each
// with CONDITIONS on the screen it is shown on. The FIRST enabled profile whose
// conditions ALL hold is active; a profile with no conditions always holds (a
// catch-all); a disabled profile never does; no match means no overrides. Pure:
// no imports, no state; authored data is never written.

export type LayoutProfilePlatform = 'desktop' | 'mobile' | 'tablet' | 'gameInGame';

export type LayoutProfileOrientation = 'portrait' | 'landscape';

export type LayoutProfileConditionField = 'platform' | 'orientation' | 'width' | 'height' | 'aspectRatio';

export type LayoutProfileConditionOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

/** One test on the screen. `value` is a platform / orientation name or a number. */
export interface LayoutProfileCondition {
  id: string;
  field: LayoutProfileConditionField;
  op: LayoutProfileConditionOp;
  value: string | number;
}

/** The screen a profile is chosen for: its platform and size in pixels. */
export interface LayoutProfileEnvironment {
  platform: LayoutProfilePlatform;
  width: number;
  height: number;
}

/** What `resolveActiveLayoutProfile` needs of a profile. */
export interface LayoutProfileLike {
  enabled?: boolean;
  conditions: LayoutProfileCondition[];
}

export const LAYOUT_PROFILE_PLATFORMS: LayoutProfilePlatform[] = ['desktop', 'mobile', 'tablet', 'gameInGame'];

export const LAYOUT_PROFILE_ORIENTATIONS: LayoutProfileOrientation[] = ['portrait', 'landscape'];

export const LAYOUT_PROFILE_CONDITION_FIELDS: LayoutProfileConditionField[] = [
  'platform',
  'orientation',
  'width',
  'height',
  'aspectRatio',
];

export const LAYOUT_PROFILE_CONDITION_OPS: LayoutProfileConditionOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];

/** Whether `field` compares names (platform / orientation) rather than numbers. */
export function isLayoutProfileNameField(field: LayoutProfileConditionField): boolean {
  return field === 'platform' || field === 'orientation';
}

/** The operators `field` accepts: names only compare equal / not equal. */
export function layoutProfileConditionOps(field: LayoutProfileConditionField): LayoutProfileConditionOp[] {
  return isLayoutProfileNameField(field) ? ['eq', 'neq'] : LAYOUT_PROFILE_CONDITION_OPS.slice();
}

export function isLayoutProfileConditionField(value: unknown): value is LayoutProfileConditionField {
  return LAYOUT_PROFILE_CONDITION_FIELDS.indexOf(value as LayoutProfileConditionField) >= 0;
}

export function isLayoutProfileConditionOp(field: LayoutProfileConditionField, value: unknown): value is LayoutProfileConditionOp {
  return layoutProfileConditionOps(field).indexOf(value as LayoutProfileConditionOp) >= 0;
}

/**
 * `value` as `field` stores it, or null when it cannot be: a known platform /
 * orientation name, or a finite number (a numeric string is accepted).
 */
export function coerceLayoutProfileConditionValue(
  field: LayoutProfileConditionField,
  value: unknown,
): string | number | null {
  if (field === 'platform') {
    return LAYOUT_PROFILE_PLATFORMS.indexOf(value as LayoutProfilePlatform) >= 0 ? (value as string) : null;
  }
  if (field === 'orientation') {
    return LAYOUT_PROFILE_ORIENTATIONS.indexOf(value as LayoutProfileOrientation) >= 0 ? (value as string) : null;
  }
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return isFinite(number) ? number : null;
}

/** Portrait when the screen is taller than it is wide, else landscape. */
export function layoutProfileOrientation(env: LayoutProfileEnvironment): LayoutProfileOrientation {
  return env.height > env.width ? 'portrait' : 'landscape';
}

function compareNumbers(op: LayoutProfileConditionOp, actual: number, expected: number): boolean {
  switch (op) {
    case 'eq': return actual === expected;
    case 'neq': return actual !== expected;
    case 'gt': return actual > expected;
    case 'gte': return actual >= expected;
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
    default: return false;
  }
}

/** Whether `cond` holds on `env`. An unknown field or operator, or a bad value, never holds. */
export function evaluateLayoutProfileCondition(
  cond: LayoutProfileCondition,
  env: LayoutProfileEnvironment,
): boolean {
  if (!cond || !env || !isLayoutProfileConditionField(cond.field)) return false;
  const field = cond.field;
  if (!isLayoutProfileConditionOp(field, cond.op)) return false;
  const expected = coerceLayoutProfileConditionValue(field, cond.value);
  if (expected === null) return false;
  if (field === 'platform' || field === 'orientation') {
    const actual = field === 'platform' ? env.platform : layoutProfileOrientation(env);
    return cond.op === 'eq' ? actual === expected : actual !== expected;
  }
  let actual: number;
  if (field === 'width') actual = env.width;
  else if (field === 'height') actual = env.height;
  else actual = env.height > 0 ? env.width / env.height : NaN;
  if (!isFinite(actual)) return false;
  return compareNumbers(cond.op, actual, expected as number);
}

/** Whether `profile` is enabled and every one of its conditions holds (none ⇒ holds). */
export function layoutProfileMatches(profile: LayoutProfileLike, env: LayoutProfileEnvironment): boolean {
  if (!profile || profile.enabled === false) return false;
  const conditions = Array.isArray(profile.conditions) ? profile.conditions : [];
  for (let i = 0; i < conditions.length; i++) {
    if (!evaluateLayoutProfileCondition(conditions[i], env)) return false;
  }
  return true;
}

/** The first profile (list order) that matches `env`, or null. */
export function resolveActiveLayoutProfile<T extends LayoutProfileLike>(
  profiles: T[] | null | undefined,
  env: LayoutProfileEnvironment,
): T | null {
  if (!Array.isArray(profiles)) return null;
  for (let i = 0; i < profiles.length; i++) {
    if (layoutProfileMatches(profiles[i], env)) return profiles[i];
  }
  return null;
}
