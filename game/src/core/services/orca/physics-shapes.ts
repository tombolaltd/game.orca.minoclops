// PARITY CONTRACT: byte-identical twin of
//   templates/arcade-base-game-template/game/src/core/services/orca/physics-shapes.ts
// `npm run check:parity` diffs the two (leading imports stripped). The editor
// draws a body's collider gizmo with the SAME outline / polygon decomposition
// the game hands to Rapier, so every change here lands in BOTH files in one
// commit.
//
// RAPIER PHYSICS — pure shape + unit maths shared by the editor and the game
// runtime (`physics-runtime.ts`). Units: Rapier works in METRES and RADIANS.
// 2D scenes are authored in pixels and simulated in SCREEN space (y-down, no
// flip): metres = px / pixelsPerMeter, and a positive angle turns +x towards
// +y exactly as Pixi's `rotation` does. 3D scene units ARE metres; 3D Euler
// rotations are authored in DEGREES, XYZ order (three.js).
//
// A 2D collider is centred on the NODE ORIGIN (local 0,0 — where the node's
// position lands), moved by `offsetX` / `offsetY` (node-local px) and turned by
// `angle` (degrees). The rectangle / circle / polygon geometry is node-local px
// and the offset + angle apply to EVERY shape, polygons included (both default
// to 0, so plain polygon points are used as authored).
//
// Pure: no imports, no state; authored data is never written. Untrusted input
// goes through the normalisers below.

/** Rapier collision groups are 16 bits of membership + 16 bits of filter. */
export const PHYSICS_LAYER_COUNT = 16;

/** "Collides with every layer". */
export const PHYSICS_ALL_LAYERS = 0xffff;

export const PHYSICS_DEFAULT_PIXELS_PER_METER = 100;

/** Points used to draw a circle outline. */
export const PHYSICS_CIRCLE_SEGMENTS = 32;

/** Authored polygon points beyond this are ignored. */
export const PHYSICS_POLYGON_MAX_POINTS = 128;

/** A convex piece produced by {@link decomposePolygon} never grows past this many vertices. */
export const PHYSICS_POLYGON_MAX_PIECE_VERTICES = 16;

const GEOMETRY_EPSILON = 1e-9;

export interface PhysicsPoint {
  x: number;
  y: number;
}

export interface PhysicsVec3 {
  x: number;
  y: number;
  z: number;
}

export interface PhysicsQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A 2D affine matrix in Pixi's layout: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
export interface PhysicsMatrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

/**
 * A matrix split into what a 2D body needs: where local (0,0) lands, the
 * direction of local +x (`rotation`, radians) and the scale. `scaleY` is SIGNED
 * — negative when the matrix mirrors — so mirrored polygons stay mirrored.
 */
export interface PhysicsTransform2D {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export type OrcaPhysicsBodyType = 'static' | 'dynamic' | 'kinematic';
export type OrcaPhysicsShape2D = 'rectangle' | 'circle' | 'polygon';
export type OrcaPhysicsShape3D = 'box' | 'sphere' | 'capsule' | 'objectMesh' | 'mesh';
export type OrcaPhysicsMeshMode = 'convex' | 'trimesh';

export interface OrcaPhysicsBodyCommon {
  enabled: boolean;
  bodyType: OrcaPhysicsBodyType;
  density: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  fixedRotation: boolean;
  ccd: boolean;
  isSensor: boolean;
  /** 0..15. */
  layer: number;
  /** 16-bit mask override; null ⇒ the project's collision matrix row for `layer`. */
  collidesWith: number | null;
}

export interface OrcaPhysicsCollider2D {
  shape: OrcaPhysicsShape2D;
  /** Node-local px. */
  width: number;
  height: number;
  radius: number;
  /** Node-local px. */
  offsetX: number;
  offsetY: number;
  /** Degrees. */
  angle: number;
  /** Node-local px (polygon only). */
  points: PhysicsPoint[];
}

export interface OrcaPhysicsBody2D extends OrcaPhysicsBodyCommon {
  collider: OrcaPhysicsCollider2D;
}

export interface OrcaPhysicsCollider3D {
  shape: OrcaPhysicsShape3D;
  /** Full box size, metres (object-local, before the object's world scale). */
  size: PhysicsVec3;
  radius: number;
  /** Capsule half height of the CYLINDER part, along local Y. */
  halfHeight: number;
  offset: PhysicsVec3;
  /** Bucket-relative `.glb` / `.gltf` (shape 'mesh'); '' when unset. */
  meshSrc: string;
  /** 'trimesh' is only honoured for static bodies. */
  meshMode: OrcaPhysicsMeshMode;
}

export interface OrcaPhysicsBody3D extends OrcaPhysicsBodyCommon {
  collider: OrcaPhysicsCollider3D;
}

/**
 * One primitive Rapier collider in BODY-LOCAL metres / radians, ready for
 * `ColliderDesc.cuboid` / `.ball` / `.capsule` / `.convexHull`.
 */
export type PhysicsColliderPiece2D =
  | { kind: 'cuboid'; halfWidth: number; halfHeight: number; x: number; y: number; rotation: number }
  | { kind: 'ball'; radius: number; x: number; y: number }
  | { kind: 'convex'; points: PhysicsPoint[] };

export type PhysicsColliderPrimitive3D =
  | { kind: 'cuboid'; halfX: number; halfY: number; halfZ: number; offset: PhysicsVec3 }
  | { kind: 'ball'; radius: number; offset: PhysicsVec3 }
  | { kind: 'capsule'; halfHeight: number; radius: number; offset: PhysicsVec3 };

// ── Units ────────────────────────────────────────────────────────────────────

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The project's pixels-per-metre, or the default when unusable. */
export function physicsPixelsPerMeter(value: unknown): number {
  const ppm = finiteOr(value, PHYSICS_DEFAULT_PIXELS_PER_METER);
  return ppm > 0 ? ppm : PHYSICS_DEFAULT_PIXELS_PER_METER;
}

export function pxToMeters(px: number, pixelsPerMeter: number): number {
  return px / physicsPixelsPerMeter(pixelsPerMeter);
}

export function metersToPx(meters: number, pixelsPerMeter: number): number {
  return meters * physicsPixelsPerMeter(pixelsPerMeter);
}

export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** `from` → `to` along the shorter way round, `t` in 0..1. */
export function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  else if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

// ── Quaternions ──────────────────────────────────────────────────────────────

/** Euler DEGREES in three.js 'XYZ' order → unit quaternion (Object3D.rotation ↔ .quaternion). */
export function eulerDegreesToQuaternion(x: number, y: number, z: number): PhysicsQuat {
  const hx = degToRad(finiteOr(x, 0)) / 2;
  const hy = degToRad(finiteOr(y, 0)) / 2;
  const hz = degToRad(finiteOr(z, 0)) / 2;
  const c1 = Math.cos(hx);
  const c2 = Math.cos(hy);
  const c3 = Math.cos(hz);
  const s1 = Math.sin(hx);
  const s2 = Math.sin(hy);
  const s3 = Math.sin(hz);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

export function normalizeQuaternion(q: PhysicsQuat): PhysicsQuat {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(length > GEOMETRY_EPSILON) || !Number.isFinite(length)) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

/** Normalised linear blend along the shorter arc — plenty for per-substep kinematic targets. */
export function nlerpQuaternion(from: PhysicsQuat, to: PhysicsQuat, t: number): PhysicsQuat {
  const dot = from.x * to.x + from.y * to.y + from.z * to.z + from.w * to.w;
  const sign = dot < 0 ? -1 : 1;
  return normalizeQuaternion({
    x: from.x + (to.x * sign - from.x) * t,
    y: from.y + (to.y * sign - from.y) * t,
    z: from.z + (to.z * sign - from.z) * t,
    w: from.w + (to.w * sign - from.w) * t,
  });
}

// ── 2D matrices ──────────────────────────────────────────────────────────────

export function identityMatrix2D(): PhysicsMatrix2D {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
}

/** `outer · inner` — apply `inner` first (child local), then `outer` (its parent). */
export function multiplyMatrix2D(outer: PhysicsMatrix2D, inner: PhysicsMatrix2D): PhysicsMatrix2D {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

/** Null when the matrix is singular (a zero scale). */
export function invertMatrix2D(m: PhysicsMatrix2D): PhysicsMatrix2D | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < GEOMETRY_EPSILON) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    tx: (m.c * m.ty - m.d * m.tx) / det,
    ty: (m.b * m.tx - m.a * m.ty) / det,
  };
}

export function applyMatrix2D(m: PhysicsMatrix2D, p: PhysicsPoint): PhysicsPoint {
  return { x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty };
}

/** See {@link PhysicsTransform2D}. Skew is folded into `scaleY` (area-preserving). */
export function decomposeMatrix2D(m: PhysicsMatrix2D): PhysicsTransform2D {
  const scaleX = Math.hypot(m.a, m.b);
  const det = m.a * m.d - m.b * m.c;
  return {
    x: m.tx,
    y: m.ty,
    rotation: scaleX > GEOMETRY_EPSILON ? Math.atan2(m.b, m.a) : 0,
    scaleX,
    scaleY: scaleX > GEOMETRY_EPSILON ? det / scaleX : 0,
  };
}

// ── Collision groups ─────────────────────────────────────────────────────────

/** A layer index clamped to 0..15. */
export function physicsLayer(value: unknown): number {
  const layer = Math.round(finiteOr(value, 0));
  return Math.min(PHYSICS_LAYER_COUNT - 1, Math.max(0, layer));
}

/**
 * Rapier's packed collision groups: membership = `1 << layer` (high 16 bits),
 * filter = `collidesWith` when set, else `matrix[layer]`, else every layer.
 */
export function collisionGroups(layer: unknown, collidesWith: unknown, matrix: unknown): number {
  const index = physicsLayer(layer);
  let filter: number;
  if (typeof collidesWith === 'number' && Number.isFinite(collidesWith)) {
    filter = collidesWith;
  } else if (Array.isArray(matrix) && typeof matrix[index] === 'number' && Number.isFinite(matrix[index])) {
    filter = matrix[index];
  } else {
    filter = PHYSICS_ALL_LAYERS;
  }
  const membership = (1 << index) & PHYSICS_ALL_LAYERS;
  return ((membership << 16) | (Math.trunc(filter) & PHYSICS_ALL_LAYERS)) >>> 0;
}

// ── Normalisers (untrusted scene data) ───────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonNegative(value: unknown, fallback: number): number {
  const n = finiteOr(value, fallback);
  return n >= 0 ? n : fallback;
}

function readVec3(value: unknown, fallback: PhysicsVec3): PhysicsVec3 {
  const v = isRecord(value) ? value : {};
  return { x: finiteOr(v.x, fallback.x), y: finiteOr(v.y, fallback.y), z: finiteOr(v.z, fallback.z) };
}

function readPoints(value: unknown): PhysicsPoint[] {
  if (!Array.isArray(value)) return [];
  const out: PhysicsPoint[] = [];
  for (const raw of value) {
    if (out.length >= PHYSICS_POLYGON_MAX_POINTS) break;
    if (!isRecord(raw)) continue;
    const x = raw.x;
    const y = raw.y;
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}

function readBodyCommon(raw: Record<string, unknown>): OrcaPhysicsBodyCommon {
  const bodyType = raw.bodyType === 'static' || raw.bodyType === 'kinematic' ? raw.bodyType : 'dynamic';
  const collidesWith = raw.collidesWith;
  return {
    enabled: raw.enabled !== false,
    bodyType,
    density: Math.max(0.0001, nonNegative(raw.density, 1)),
    friction: nonNegative(raw.friction, 0.5),
    restitution: nonNegative(raw.restitution, 0),
    linearDamping: nonNegative(raw.linearDamping, 0),
    angularDamping: nonNegative(raw.angularDamping, 0),
    gravityScale: finiteOr(raw.gravityScale, 1),
    fixedRotation: raw.fixedRotation === true,
    ccd: raw.ccd === true,
    isSensor: raw.isSensor === true,
    layer: physicsLayer(raw.layer),
    collidesWith:
      typeof collidesWith === 'number' && Number.isFinite(collidesWith)
        ? Math.trunc(collidesWith) & PHYSICS_ALL_LAYERS
        : null,
  };
}

/** A 2D node's `physicsBody`, defaulted and clamped; null when absent / not an object. */
export function normalizePhysicsBody2D(raw: unknown): OrcaPhysicsBody2D | null {
  if (!isRecord(raw)) return null;
  const c = isRecord(raw.collider) ? raw.collider : {};
  const shape: OrcaPhysicsShape2D = c.shape === 'circle' || c.shape === 'polygon' ? c.shape : 'rectangle';
  return {
    ...readBodyCommon(raw),
    collider: {
      shape,
      width: nonNegative(c.width, 100),
      height: nonNegative(c.height, 100),
      radius: nonNegative(c.radius, 50),
      offsetX: finiteOr(c.offsetX, 0),
      offsetY: finiteOr(c.offsetY, 0),
      angle: finiteOr(c.angle, 0),
      points: readPoints(c.points),
    },
  };
}

/** A 3D node's `physicsBody`, defaulted and clamped; null when absent / not an object. */
export function normalizePhysicsBody3D(raw: unknown): OrcaPhysicsBody3D | null {
  if (!isRecord(raw)) return null;
  const c = isRecord(raw.collider) ? raw.collider : {};
  const shape: OrcaPhysicsShape3D =
    c.shape === 'sphere' || c.shape === 'capsule' || c.shape === 'objectMesh' || c.shape === 'mesh' ? c.shape : 'box';
  const size = readVec3(c.size, { x: 1, y: 1, z: 1 });
  return {
    ...readBodyCommon(raw),
    collider: {
      shape,
      size: { x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) },
      radius: nonNegative(c.radius, 0.5),
      halfHeight: nonNegative(c.halfHeight, 0.5),
      offset: readVec3(c.offset, { x: 0, y: 0, z: 0 }),
      meshSrc: typeof c.meshSrc === 'string' ? c.meshSrc.trim() : '',
      meshMode: c.meshMode === 'trimesh' ? 'trimesh' : 'convex',
    },
  };
}

// ── Polygons ─────────────────────────────────────────────────────────────────

function cross3(o: PhysicsPoint, a: PhysicsPoint, b: PhysicsPoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Shoelace area: positive when the points turn +x towards +y. */
export function polygonArea(points: PhysicsPoint[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

/** Area centroid; the vertex mean for a degenerate polygon; (0,0) when empty. */
export function polygonCentroid(points: PhysicsPoint[]): PhysicsPoint {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0 };
  const area = polygonArea(points);
  if (Math.abs(area) < GEOMETRY_EPSILON) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

function polygonScale(points: PhysicsPoint[]): number {
  let max = 0;
  for (const p of points) max = Math.max(max, Math.abs(p.x), Math.abs(p.y));
  return Math.max(1, max);
}

/**
 * Finite points only, at most {@link PHYSICS_POLYGON_MAX_POINTS}, with repeated
 * and collinear vertices removed, turned so {@link polygonArea} is positive.
 * Empty when fewer than 3 vertices / no area remain.
 */
export function cleanPolygon(points: PhysicsPoint[]): PhysicsPoint[] {
  const input = Array.isArray(points) ? points : [];
  let pts: PhysicsPoint[] = [];
  for (const p of input) {
    if (pts.length >= PHYSICS_POLYGON_MAX_POINTS) break;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    pts.push({ x: p.x, y: p.y });
  }
  const eps = polygonScale(pts) * 1e-7;
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const next: PhysicsPoint[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = next.length > 0 ? next[next.length - 1] : pts[pts.length - 1];
      const cur = pts[i];
      const after = pts[(i + 1) % pts.length];
      const duplicate = Math.abs(cur.x - prev.x) <= eps && Math.abs(cur.y - prev.y) <= eps;
      // Straight-through AND spike (doubling-back) vertices add no area.
      const span = Math.hypot(cur.x - prev.x, cur.y - prev.y) * Math.hypot(after.x - cur.x, after.y - cur.y);
      const collinear = Math.abs(cross3(prev, cur, after)) <= span * 1e-9;
      if (duplicate || collinear) {
        changed = true;
        continue;
      }
      next.push(cur);
    }
    pts = next;
  }
  if (pts.length < 3) return [];
  const area = polygonArea(pts);
  if (Math.abs(area) <= eps * eps * 1e4) return [];
  return area < 0 ? pts.reverse() : pts;
}

/**
 * True for a simple convex polygon (either winding, ≥ 3 vertices, collinear
 * vertices allowed): every turn has the same sign and the turns add to one
 * full revolution.
 */
export function isConvexPolygon(points: PhysicsPoint[]): boolean {
  if (!Array.isArray(points) || points.length < 3) return false;
  const n = points.length;
  let sign = 0;
  let turning = 0;
  for (let i = 0; i < n; i++) {
    const a = points[(i + n - 1) % n];
    const b = points[i];
    const c = points[(i + 1) % n];
    if (!a || !b || !c || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;
    const turn = cross3(a, b, c);
    if (Math.abs(turn) > GEOMETRY_EPSILON) {
      const s = turn > 0 ? 1 : -1;
      if (sign !== 0 && s !== sign) return false;
      sign = s;
    }
    const inAngle = Math.atan2(b.y - a.y, b.x - a.x);
    const outAngle = Math.atan2(c.y - b.y, c.x - b.x);
    let delta = outAngle - inAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    turning += delta;
  }
  return sign !== 0 && Math.abs(Math.abs(turning) - Math.PI * 2) < 1e-6;
}

function pointInTriangle(p: PhysicsPoint, a: PhysicsPoint, b: PhysicsPoint, c: PhysicsPoint): boolean {
  // Inclusive of the edges: a reflex vertex touching the ear's edge blocks it.
  return cross3(a, b, p) >= -GEOMETRY_EPSILON && cross3(b, c, p) >= -GEOMETRY_EPSILON && cross3(c, a, p) >= -GEOMETRY_EPSILON;
}

/** Ear-clip a cleaned (positive-area) polygon into vertex-index triangles. */
function triangulate(pts: PhysicsPoint[]): number[][] {
  const remaining = pts.map((_, i) => i);
  const triangles: number[][] = [];
  let guard = pts.length * pts.length + 8;
  while (remaining.length > 3 && guard-- > 0) {
    const n = remaining.length;
    let ear = -1;
    let fallback = -1;
    for (let i = 0; i < n; i++) {
      const ia = remaining[(i + n - 1) % n];
      const ib = remaining[i];
      const ic = remaining[(i + 1) % n];
      const a = pts[ia];
      const b = pts[ib];
      const c = pts[ic];
      if (cross3(a, b, c) <= GEOMETRY_EPSILON) continue;
      if (fallback < 0) fallback = i;
      let blocked = false;
      for (const j of remaining) {
        if (j === ia || j === ib || j === ic) continue;
        const p = pts[j];
        if ((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y) || (p.x === c.x && p.y === c.y)) continue;
        if (pointInTriangle(p, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        ear = i;
        break;
      }
    }
    // A self-intersecting outline can leave no clean ear: clip the first
    // convex corner anyway (or any corner) so the loop always terminates.
    const pick = ear >= 0 ? ear : fallback >= 0 ? fallback : 0;
    const n2 = remaining.length;
    triangles.push([remaining[(pick + n2 - 1) % n2], remaining[pick], remaining[(pick + 1) % n2]]);
    remaining.splice(pick, 1);
  }
  if (remaining.length === 3) triangles.push(remaining.slice());
  // Drop slivers / inverted triangles a forced clip may have produced.
  return triangles.filter((t) => cross3(pts[t[0]], pts[t[1]], pts[t[2]]) > GEOMETRY_EPSILON);
}

function isConvexIndexed(pts: PhysicsPoint[], poly: number[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    if (cross3(pts[poly[(i + n - 1) % n]], pts[poly[i]], pts[poly[(i + 1) % n]]) < -GEOMETRY_EPSILON) return false;
  }
  return true;
}

/** Merge two index polygons across their shared edge, or null when they share none. */
function mergeAcrossEdge(a: number[], b: number[]): number[] | null {
  for (let i = 0; i < a.length; i++) {
    const u = a[i];
    const v = a[(i + 1) % a.length];
    const j = b.indexOf(v);
    if (j < 0 || b[(j + 1) % b.length] !== u) continue;
    // a rotated to run v … u, then b's vertices strictly between u and v.
    const out: number[] = [];
    for (let k = 0; k < a.length; k++) out.push(a[(i + 1 + k) % a.length]);
    for (let k = 2; k < b.length; k++) out.push(b[(j + k) % b.length]);
    return out;
  }
  return null;
}

/**
 * Split a simple polygon into CONVEX pieces Rapier can use directly: ear-clip
 * triangulation, then a Hertel–Mehlhorn pass greedily merging neighbours while
 * the result stays convex and within `maxPieceVertices`. The input is cleaned
 * first ({@link cleanPolygon}); a convex input comes back as ONE piece. Every
 * piece has positive {@link polygonArea}. Degenerate input ⇒ [].
 */
export function decomposePolygon(
  points: PhysicsPoint[],
  maxPieceVertices: number = PHYSICS_POLYGON_MAX_PIECE_VERTICES,
): PhysicsPoint[][] {
  const pts = cleanPolygon(points);
  if (pts.length < 3) return [];
  const cap = Math.max(3, Math.floor(finiteOr(maxPieceVertices, PHYSICS_POLYGON_MAX_PIECE_VERTICES)));
  if (pts.length <= cap && isConvexPolygon(pts)) return [pts];

  const pieces: number[][] = triangulate(pts);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < pieces.length && !merged; i++) {
      for (let j = i + 1; j < pieces.length && !merged; j++) {
        const candidate = mergeAcrossEdge(pieces[i], pieces[j]);
        if (!candidate || candidate.length > cap || !isConvexIndexed(pts, candidate)) continue;
        pieces[i] = candidate;
        pieces.splice(j, 1);
        merged = true;
      }
    }
  }
  const out: PhysicsPoint[][] = [];
  for (const piece of pieces) {
    const poly = cleanPolygon(piece.map((index) => pts[index]));
    if (poly.length >= 3) out.push(poly);
  }
  return out;
}

// ── 2D collider geometry ─────────────────────────────────────────────────────

function rotateOffset(points: PhysicsPoint[], angleRad: number, ox: number, oy: number): PhysicsPoint[] {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return points.map((p) => ({ x: p.x * cos - p.y * sin + ox, y: p.x * sin + p.y * cos + oy }));
}

/**
 * The collider's outline in NODE-LOCAL px, for drawing: rectangle corners
 * (top-left, top-right, bottom-right, bottom-left before the turn), a circle
 * as `segments` points, or the polygon's points — each turned by `angle` and
 * moved by the offset. Accepts raw (untrusted) collider data.
 */
export function colliderOutline2D(collider: unknown, segments: number = PHYSICS_CIRCLE_SEGMENTS): PhysicsPoint[] {
  const body = normalizePhysicsBody2D({ collider });
  if (!body) return [];
  const c = body.collider;
  const angle = degToRad(c.angle);
  if (c.shape === 'circle') {
    const count = Math.max(3, Math.min(256, Math.floor(finiteOr(segments, PHYSICS_CIRCLE_SEGMENTS))));
    const ring: PhysicsPoint[] = [];
    for (let i = 0; i < count; i++) {
      const t = (i / count) * Math.PI * 2;
      ring.push({ x: Math.cos(t) * c.radius, y: Math.sin(t) * c.radius });
    }
    return rotateOffset(ring, angle, c.offsetX, c.offsetY);
  }
  if (c.shape === 'polygon') return rotateOffset(c.points, angle, c.offsetX, c.offsetY);
  const hw = c.width / 2;
  const hh = c.height / 2;
  return rotateOffset(
    [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }],
    angle,
    c.offsetX,
    c.offsetY,
  );
}

/**
 * The Rapier colliders for a 2D collider on a node whose transform relative to
 * the physics root has the given SIGNED scale, in body-local METRES / radians
 * (the body sits on the node origin, turned by the node's rotation).
 * Rectangle → one cuboid, circle → one ball (radius × the larger |scale|),
 * polygon → one convex piece per {@link decomposePolygon} piece. Empty when the
 * shape has no area.
 */
export function collider2DPieces(
  collider: unknown,
  scaleX: number,
  scaleY: number,
  pixelsPerMeter: number,
): PhysicsColliderPiece2D[] {
  const body = normalizePhysicsBody2D({ collider });
  if (!body) return [];
  const c = body.collider;
  const ppm = physicsPixelsPerMeter(pixelsPerMeter);
  const sx = finiteOr(scaleX, 1);
  const sy = finiteOr(scaleY, 1);
  const ax = Math.abs(sx);
  const ay = Math.abs(sy);
  const x = (c.offsetX * sx) / ppm;
  const y = (c.offsetY * sy) / ppm;
  // A mirror (one negative axis) turns the authored angle the other way.
  const mirrored = sx * sy < 0;
  const rotation = degToRad(c.angle) * (mirrored ? -1 : 1);
  if (c.shape === 'circle') {
    const radius = (c.radius * Math.max(ax, ay)) / ppm;
    return radius > GEOMETRY_EPSILON ? [{ kind: 'ball', radius, x, y }] : [];
  }
  if (c.shape === 'polygon') {
    const local = rotateOffset(c.points, degToRad(c.angle), c.offsetX, c.offsetY)
      .map((p) => ({ x: (p.x * sx) / ppm, y: (p.y * sy) / ppm }));
    return decomposePolygon(local).map((points) => ({ kind: 'convex', points }));
  }
  const halfWidth = (c.width * ax) / 2 / ppm;
  const halfHeight = (c.height * ay) / 2 / ppm;
  if (!(halfWidth > GEOMETRY_EPSILON) || !(halfHeight > GEOMETRY_EPSILON)) return [];
  return [{ kind: 'cuboid', halfWidth, halfHeight, x, y, rotation }];
}

/** `[x0, y0, x1, y1, …]` for `ColliderDesc.convexHull`. */
export function flattenPoints2D(points: PhysicsPoint[]): number[] {
  const out: number[] = [];
  for (const p of points) out.push(p.x, p.y);
  return out;
}

// ── 3D collider geometry ─────────────────────────────────────────────────────

/**
 * The primitive Rapier collider for a box / sphere / capsule on an object with
 * the given world scale (absolute values used), in body-local metres. Box →
 * cuboid of HALF sizes; sphere → ball (radius × the largest |scale|); capsule
 * (along local Y) → radius × max(|sx|, |sz|), half height × |sy|. The offset is
 * scaled per axis. Null for 'objectMesh' / 'mesh' (geometry comes from the
 * scene) and for a shape with no extent.
 */
export function collider3DPrimitive(collider: unknown, scale: PhysicsVec3 | null | undefined): PhysicsColliderPrimitive3D | null {
  const body = normalizePhysicsBody3D({ collider });
  if (!body) return null;
  const c = body.collider;
  const sx = Math.abs(finiteOr(scale?.x, 1));
  const sy = Math.abs(finiteOr(scale?.y, 1));
  const sz = Math.abs(finiteOr(scale?.z, 1));
  const offset = { x: c.offset.x * sx, y: c.offset.y * sy, z: c.offset.z * sz };
  if (c.shape === 'box') {
    const halfX = (c.size.x * sx) / 2;
    const halfY = (c.size.y * sy) / 2;
    const halfZ = (c.size.z * sz) / 2;
    if (!(halfX > GEOMETRY_EPSILON && halfY > GEOMETRY_EPSILON && halfZ > GEOMETRY_EPSILON)) return null;
    return { kind: 'cuboid', halfX, halfY, halfZ, offset };
  }
  if (c.shape === 'sphere') {
    const radius = c.radius * Math.max(sx, sy, sz);
    return radius > GEOMETRY_EPSILON ? { kind: 'ball', radius, offset } : null;
  }
  if (c.shape === 'capsule') {
    const radius = c.radius * Math.max(sx, sz);
    const halfHeight = c.halfHeight * sy;
    if (!(radius > GEOMETRY_EPSILON)) return null;
    return { kind: 'capsule', halfHeight, radius, offset };
  }
  return null;
}
