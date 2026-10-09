// PARITY CONTRACT: this file must be byte-identical content (modulo imports)
// to the matching file in the template tree
// (`templates/arcade-base-game-template/game/src/core/services/orca/scene-parent-anchor.ts`).
// If you change one, change both.
//
// "Anchor to parent": a node may pin itself to one of its PARENT's nine
// anchor points (4 corners, 4 edge centres, centre). When anchored, the
// node's `transform.x/y` is an OFFSET from that point rather than a raw
// parent-local position:
//
//     parentLocalPosition = resolveAnchorOffset(point, rect) + transform.x/y
//
// The rect is always DECLARED, never measured — measured bounds are
// circular (children move → bounds change → children move again). See
// AGENTS.md / agent-docs/scene-editor.md for the three declared sources
// (scene root → camera frame, parent `responsiveScaler` → its reference
// rect, parent `canvas` → its resolved logical rect).
//
// Pure module: no framework imports, no reactive state, no I/O.
import type { ParentAnchorPoint } from './scene-manager';

/**
 * A DECLARED anchoring rect, expressed in the anchored node's PARENT-LOCAL
 * coordinate space.
 *
 * `centerX` / `centerY` are the rect's CENTRE — not its top-left. A rect
 * whose parent-local origin sits at its own top-left therefore reports
 * `centerX = width / 2`; one centred on the parent origin reports `0`.
 */
export interface AnchorRect {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

/** The nine anchor points, in reading order (row-major, top row first). */
export const PARENT_ANCHOR_POINTS: readonly ParentAnchorPoint[] = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

/** True when `value` is one of the nine declared anchor points. */
export function isParentAnchorPoint(value: unknown): value is ParentAnchorPoint {
  return typeof value === 'string'
    && (PARENT_ANCHOR_POINTS as readonly string[]).includes(value);
}

function finite(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The anchor point's position in the anchored node's PARENT-LOCAL space.
 *
 * X: `left` → `centerX - width / 2`, `center` → `centerX`,
 *    `right` → `centerX + width / 2`.
 * Y: `top` → `centerY - height / 2`, `middle` → `centerY`,
 *    `bottom` → `centerY + height / 2`.
 *
 * Y grows DOWNWARDS (Pixi convention), so `top` is the smaller value.
 * Non-finite inputs degrade to 0 rather than propagating NaN into a
 * display object's position.
 */
export function resolveAnchorOffset(
  point: ParentAnchorPoint,
  rect: AnchorRect,
): { x: number; y: number } {
  const centerX = finite(rect.centerX);
  const centerY = finite(rect.centerY);
  const halfWidth = finite(rect.width) / 2;
  const halfHeight = finite(rect.height) / 2;

  let x = centerX;
  if (point === 'top-left' || point === 'middle-left' || point === 'bottom-left') {
    x = centerX - halfWidth;
  } else if (point === 'top-right' || point === 'middle-right' || point === 'bottom-right') {
    x = centerX + halfWidth;
  }

  let y = centerY;
  if (point === 'top-left' || point === 'top-center' || point === 'top-right') {
    y = centerY - halfHeight;
  } else if (point === 'bottom-left' || point === 'bottom-center' || point === 'bottom-right') {
    y = centerY + halfHeight;
  }

  return { x, y };
}
