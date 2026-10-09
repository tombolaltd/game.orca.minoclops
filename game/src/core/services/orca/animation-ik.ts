// PARITY CONTRACT: byte-identical twin of
//   templates/arcade-base-game-template/game/src/core/services/orca/animation-ik.ts
// `npm run check:parity` diffs the two (leading imports stripped). The editor
// canvas and the runtime must bend an IK chain IDENTICALLY, so every change
// here lands in BOTH files in one commit.
//
// TWO-BONE INVERSE KINEMATICS for an `ik` component. The component lives on a
// HANDLE node (an empty container the animator moves); its `chain` names the
// upper bone, the lower bone and the tip (a hand / foot bone, or any node at
// the end of the lower bone). Every frame the upper and lower bones are turned
// so the tip reaches the handle, blended with their keyed (FK) rotation by
// `mix` — 0 = pure FK, 1 = pure IK — which is keyable (`@ik.mix`).
//
// The solve runs in the UPPER bone's PARENT space, so a mirrored or scaled
// ancestor never flips the bend. It NEVER touches authored data: it reads and
// writes `rotation` on the live display objects only, after the clip wrote the
// frame's FK values. Because the clip does not write every frame, each bone
// keeps its FK value in `__orcaIkFk`: a rotation that differs from the one the
// solver last wrote (`__orcaIkOut`) is a fresh FK write and is adopted.

/** The IK component as authored (`SceneNodeBase.ik`). */
export interface IkComponentLike {
  enabled?: boolean;
  /** `[upper, lower, tip]` node ids. */
  chain?: unknown;
  /** 0 = FK only, 1 = IK only. */
  mix?: unknown;
  /** Which way the middle joint bends: 1 = counter-clockwise on screen, -1 = clockwise. */
  bend?: unknown;
}

export interface IkPoint {
  x: number;
  y: number;
}

/** The slice of a display object the solve needs (a Pixi `Container`). */
export interface IkDisplayObjectLike {
  rotation: number;
  parent: unknown;
  toGlobal(position: IkPoint): IkPoint;
  destroyed?: boolean;
}

export interface NormalizedIk {
  chain: [string, string, string];
  mix: number;
  bend: 1 | -1;
}

/** The chain / mix / bend an `ik` component really asks for, or null when it cannot solve. */
export function normalizeIkComponent(ik: IkComponentLike | null | undefined): NormalizedIk | null {
  if (!ik || typeof ik !== 'object' || ik.enabled === false) return null;
  const chain = Array.isArray(ik.chain) ? ik.chain : [];
  if (chain.length !== 3 || !chain.every((id) => typeof id === 'string' && id.length > 0)) return null;
  if (chain[0] === chain[1] || chain[1] === chain[2] || chain[0] === chain[2]) return null;
  const rawMix = typeof ik.mix === 'number' && Number.isFinite(ik.mix) ? ik.mix : 1;
  return {
    chain: [chain[0], chain[1], chain[2]],
    mix: Math.min(1, Math.max(0, rawMix)),
    bend: ik.bend === -1 ? -1 : 1,
  };
}

/** Shortest signed angle from `a` to `b` (radians, −π…π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

export interface TwoBoneSolution {
  /** Turn to add to the upper bone's current (FK) rotation, radians, in its parent's frame. */
  upper: number;
  /** Turn to add to the lower bone's current (FK) rotation, radians, in its parent's frame. */
  lower: number;
  /** The target was out of reach (the chain straightens toward it). */
  stretched: boolean;
}

/**
 * The two-bone solve in ONE frame (the upper bone's parent space): `a` the
 * upper joint, `b` the middle joint, `c` the tip, all at their FK pose, and
 * `target` the handle. Returns how much to turn each bone. `bend` picks the
 * side the middle joint bends toward; a degenerate chain turns nothing.
 */
export function solveTwoBone(a: IkPoint, b: IkPoint, c: IkPoint, target: IkPoint, bend: 1 | -1): TwoBoneSolution {
  const l1 = Math.hypot(b.x - a.x, b.y - a.y);
  const l2 = Math.hypot(c.x - b.x, c.y - b.y);
  const dx = target.x - a.x;
  const dy = target.y - a.y;
  const reach = Math.hypot(dx, dy);
  if (!(l1 > 1e-6) || !(l2 > 1e-6) || !(reach > 1e-6)) return { upper: 0, lower: 0, stretched: false };
  const clamped = Math.min(l1 + l2 - 1e-6, Math.max(Math.abs(l1 - l2) + 1e-6, reach));
  // Interior angle at the upper joint between the reach line and the upper bone.
  const cosA = (l1 * l1 + clamped * clamped - l2 * l2) / (2 * l1 * clamped);
  const angleA = Math.acos(Math.min(1, Math.max(-1, cosA)));
  const toTarget = Math.atan2(dy, dx);
  // `bend` 1 bends counter-clockwise on screen (y down) — the upper bone turns clockwise of the reach line.
  const upperAngle = toTarget - bend * angleA;
  const bx = a.x + Math.cos(upperAngle) * l1;
  const by = a.y + Math.sin(upperAngle) * l1;
  const lowerAngle = Math.atan2(target.y - by, target.x - bx);
  const fkUpper = Math.atan2(b.y - a.y, b.x - a.x);
  const fkLower = Math.atan2(c.y - b.y, c.x - b.x);
  const upper = angleDelta(fkUpper, upperAngle);
  // The lower bone rides on the upper one: its own turn is relative to that.
  const lower = angleDelta(fkLower - fkUpper, lowerAngle - upperAngle);
  return { upper, lower, stretched: reach > l1 + l2 };
}

type Tagged = IkDisplayObjectLike & { __orcaIkFk?: number; __orcaIkOut?: number };

/** A bone's keyed (FK) rotation: adopt a fresh write, else keep the last one. */
function fkRotation(bone: Tagged): number {
  const current = bone.rotation;
  if (bone.__orcaIkOut === undefined || bone.__orcaIkFk === undefined || Math.abs(current - bone.__orcaIkOut) > 1e-9) {
    bone.__orcaIkFk = current;
  }
  return bone.__orcaIkFk;
}

function writeRotation(bone: Tagged, rotation: number): void {
  bone.rotation = rotation;
  bone.__orcaIkOut = bone.rotation;
}

/** `p` (global) in `space`'s local frame via its inverse; null when degenerate. */
function toLocalOf(space: IkDisplayObjectLike, p: IkPoint): IkPoint | null {
  const o = space.toGlobal({ x: 0, y: 0 });
  const ux = space.toGlobal({ x: 1, y: 0 });
  const uy = space.toGlobal({ x: 0, y: 1 });
  const ax = ux.x - o.x;
  const ay = ux.y - o.y;
  const bx = uy.x - o.x;
  const by = uy.y - o.y;
  const det = ax * by - bx * ay;
  if (!(Math.abs(det) > 1e-12)) return null;
  const px = p.x - o.x;
  const py = p.y - o.y;
  return { x: (px * by - bx * py) / det, y: (ax * py - px * ay) / det };
}

function isLive(obj: IkDisplayObjectLike | null | undefined): obj is IkDisplayObjectLike {
  return !!obj && obj.destroyed !== true && typeof obj.toGlobal === 'function';
}

/**
 * Bend one chain toward its handle. `resolve` maps a node id to its live
 * display object. Returns false (and leaves every bone at its FK rotation)
 * when the chain cannot be solved this frame.
 *
 * The upper bone is solved in ITS PARENT's frame (the triangle), the lower
 * bone in the UPPER bone's frame (aimed at the handle) — `rotation` turns a
 * bone within its parent's frame whatever that parent's scale or mirror, so
 * both turns are exact there. Each bone then blends FK → IK by `mix`.
 */
export function applyTwoBoneIk(
  handle: IkDisplayObjectLike,
  ik: NormalizedIk,
  resolve: (nodeId: string) => IkDisplayObjectLike | null | undefined,
): boolean {
  const upper = resolve(ik.chain[0]) as Tagged | null | undefined;
  const lower = resolve(ik.chain[1]) as Tagged | null | undefined;
  const tip = resolve(ik.chain[2]);
  if (!isLive(upper) || !isLive(lower) || !isLive(tip) || !isLive(handle)) return false;
  // Always restart from the keyed pose, so the solve never feeds on itself.
  const fkUpper = fkRotation(upper);
  const fkLower = fkRotation(lower);
  writeRotation(upper, fkUpper);
  writeRotation(lower, fkLower);
  if (!(ik.mix > 0)) return true;
  const space = upper.parent as IkDisplayObjectLike | null;
  if (!isLive(space)) return false;
  const origin = { x: 0, y: 0 };
  const a = toLocalOf(space, upper.toGlobal(origin));
  const b = toLocalOf(space, lower.toGlobal(origin));
  const c = toLocalOf(space, tip.toGlobal(origin));
  const target = toLocalOf(space, handle.toGlobal(origin));
  if (!a || !b || !c || !target) return false;
  const solved = solveTwoBone(a, b, c, target, ik.bend);
  // Full IK on the upper bone, then aim the lower bone at the handle from there.
  writeRotation(upper, fkUpper + solved.upper);
  const bl = toLocalOf(upper, lower.toGlobal(origin));
  const cl = toLocalOf(upper, tip.toGlobal(origin));
  const tl = toLocalOf(upper, handle.toGlobal(origin));
  let lowerTurn = 0;
  if (bl && cl && tl && Math.hypot(cl.x - bl.x, cl.y - bl.y) > 1e-6 && Math.hypot(tl.x - bl.x, tl.y - bl.y) > 1e-6) {
    lowerTurn = angleDelta(Math.atan2(cl.y - bl.y, cl.x - bl.x), Math.atan2(tl.y - bl.y, tl.x - bl.x));
  }
  writeRotation(upper, fkUpper + solved.upper * ik.mix);
  writeRotation(lower, fkLower + lowerTurn * ik.mix);
  return true;
}

/** How many ancestors a display object has (bounded). */
function depthOf(obj: IkDisplayObjectLike): number {
  let depth = 0;
  let cursor = obj.parent as IkDisplayObjectLike | null;
  while (cursor && depth < 64) {
    depth += 1;
    cursor = cursor.parent as IkDisplayObjectLike | null;
  }
  return depth;
}

/**
 * Every chain in `handles`, outermost first — a chain inside another chain's
 * bones is solved after it, so it bends from where the outer one put it.
 * Returns how many chains were solved.
 */
export function applyIkHandles(
  handles: ReadonlyArray<{ handle: IkDisplayObjectLike; ik: NormalizedIk }>,
  resolve: (nodeId: string) => IkDisplayObjectLike | null | undefined,
): number {
  const ordered = handles
    .map((entry) => {
      const upper = resolve(entry.ik.chain[0]);
      return { entry, depth: isLive(upper) ? depthOf(upper) : 0 };
    })
    .sort((x, y) => x.depth - y.depth);
  let solved = 0;
  for (const { entry } of ordered) {
    if (applyTwoBoneIk(entry.handle, entry.ik, resolve)) solved += 1;
  }
  return solved;
}

/**
 * The bend (1 / -1) that keeps a chain bending the way its rest pose does:
 * the side of the upper→tip line its middle joint sits on. `a`, `b`, `c` are
 * the upper, middle and tip joints in one frame; a straight chain gets `fallback`.
 */
export function restBendOf(a: IkPoint, b: IkPoint, c: IkPoint, fallback: 1 | -1 = 1): 1 | -1 {
  const cross = (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
  const scale = Math.max(1e-9, Math.hypot(c.x - a.x, c.y - a.y) * Math.hypot(b.x - a.x, b.y - a.y));
  if (Math.abs(cross) / scale < 0.02) return fallback;
  return cross > 0 ? -1 : 1;
}
