// PARITY CONTRACT: byte-identical twin of
//   templates/arcade-base-game-template/game/src/core/services/orca/skinned-mesh.ts
// `npm run check:parity` diffs the two (leading imports stripped). The editor
// canvas and the runtime must bend a skinned mesh IDENTICALLY, so every change
// here lands in BOTH files in one commit.
//
// A SKINNED MESH (`skinnedMesh` node): a texture on a grid mesh whose vertices
// follow BONES — other scene nodes — blended by weight, so a limb bends
// smoothly at its joint instead of showing two rigid pieces. Each bone carries
// its bind pose: its transform in the mesh's space at rest. Every frame, after
// the clip and the IK solve wrote the frame, each bone's transform in the
// mesh's space is read off the live display objects, and every vertex goes to
// the weighted blend of where each bone carries it. At rest each bone sits at
// its bind pose, so the mesh shows its texture exactly as it was cut. A bone
// that no longer resolves holds its bind pose. Authored data is never touched.
// A bone may carry a DEPTH (how far in front its part draws): the triangles
// then draw back to front by it, so where a bend folds the mesh over itself
// the part in front covers the one behind on every frame.

/** A 2D affine in the scene's convention: `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`. */
export interface SkinAffine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export interface SkinPoint {
  x: number;
  y: number;
}

/** The fields of a `skinnedMesh` node the mesh is built from (untrusted). */
export interface SkinnedMeshLike {
  width?: unknown;
  height?: unknown;
  offsetX?: unknown;
  offsetY?: unknown;
  cols?: unknown;
  rows?: unknown;
  skinning?: unknown;
}

/** The slice of a display object the skinning needs (a Pixi `Container`). */
export interface SkinDisplayObjectLike {
  toLocal(position: SkinPoint, from?: unknown): SkinPoint;
  destroyed?: boolean;
}

export interface PreparedSkinnedMesh {
  cols: number;
  rows: number;
  vertexCount: number;
  /** Rest positions in the mesh's space, `x, y` per vertex (row-major grid). */
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Empty when the node carries no usable skinning: the mesh then stays at rest. */
  boneIds: string[];
  binds: SkinAffine[];
  /** Per vertex per bone: the vertex in that bone's space at rest (`x, y`). */
  local: Float64Array;
  /** Per vertex per bone, summing to 1. */
  weights: Float32Array;
  /** The bone transforms the vertices were last placed with, or null. */
  last: Float64Array | null;
}

export const SKINNED_MESH_LIMITS = Object.freeze({ maxCells: 64, maxBones: 4 });

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function invertSkinAffine(m: SkinAffine): SkinAffine | null {
  const det = m.a * m.d - m.b * m.c;
  if (!(Math.abs(det) > 1e-12)) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    tx: (m.c * m.ty - m.d * m.tx) / det,
    ty: (m.b * m.tx - m.a * m.ty) / det,
  };
}

function readBind(raw: unknown): SkinAffine | null {
  if (!Array.isArray(raw) || raw.length !== 6 || !raw.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return { a: raw[0], b: raw[1], c: raw[2], d: raw[3], tx: raw[4], ty: raw[5] };
}

/** The triangles (two a cell) of `cells` — row-major cell numbers — in that order. */
function cellIndices(cols: number, cells: readonly number[]): Uint32Array {
  const indices = new Uint32Array(cells.length * 6);
  let k = 0;
  for (const cell of cells) {
    const v = Math.floor(cell / cols) * (cols + 1) + (cell % cols);
    indices[k++] = v;
    indices[k++] = v + 1;
    indices[k++] = v + cols + 1;
    indices[k++] = v + 1;
    indices[k++] = v + cols + 2;
    indices[k++] = v + cols + 1;
  }
  return indices;
}

/**
 * The mesh a `skinnedMesh` node describes — its rest grid, UVs, triangles and
 * each bone's hold on every vertex — or null when the grid is malformed. A
 * node whose skinning is malformed still draws, at rest.
 */
export function prepareSkinnedMesh(node: SkinnedMeshLike): PreparedSkinnedMesh | null {
  const width = finite(node.width, 0);
  const height = finite(node.height, 0);
  const cols = Math.round(finite(node.cols, 1));
  const rows = Math.round(finite(node.rows, 1));
  const max = SKINNED_MESH_LIMITS.maxCells;
  if (!(width > 0) || !(height > 0) || cols < 1 || rows < 1 || cols > max || rows > max) return null;
  const ox = finite(node.offsetX, 0);
  const oy = finite(node.offsetY, 0);
  const vertexCount = (cols + 1) * (rows + 1);
  const positions = new Float32Array(vertexCount * 2);
  const uvs = new Float32Array(vertexCount * 2);
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      const v = j * (cols + 1) + i;
      positions[v * 2] = ox + (i / cols) * width;
      positions[v * 2 + 1] = oy + (j / rows) * height;
      uvs[v * 2] = i / cols;
      uvs[v * 2 + 1] = j / rows;
    }
  }
  const gridCells: number[] = [];
  for (let c = 0; c < cols * rows; c += 1) gridCells.push(c);
  const indices = cellIndices(cols, gridCells);
  const prepared: PreparedSkinnedMesh = {
    cols,
    rows,
    vertexCount,
    positions,
    uvs,
    indices,
    boneIds: [],
    binds: [],
    local: new Float64Array(0),
    weights: new Float32Array(0),
    last: null,
  };
  const skinning = node.skinning && typeof node.skinning === 'object' ? node.skinning as { bones?: unknown; weights?: unknown } : null;
  const rawBones = Array.isArray(skinning?.bones) ? skinning!.bones as unknown[] : [];
  const rawWeights = Array.isArray(skinning?.weights) ? skinning!.weights as unknown[] : [];
  const n = rawBones.length;
  if (n < 1 || n > SKINNED_MESH_LIMITS.maxBones || rawWeights.length !== vertexCount * n) return prepared;
  const ids: string[] = [];
  const binds: SkinAffine[] = [];
  const inverses: SkinAffine[] = [];
  for (const raw of rawBones) {
    const bone = raw && typeof raw === 'object' ? raw as { id?: unknown; bind?: unknown } : null;
    const bind = readBind(bone?.bind);
    const inverse = bind ? invertSkinAffine(bind) : null;
    if (!bone || typeof bone.id !== 'string' || !bone.id || !bind || !inverse) return prepared;
    ids.push(bone.id);
    binds.push(bind);
    inverses.push(inverse);
  }
  const local = new Float64Array(vertexCount * n * 2);
  const weights = new Float32Array(vertexCount * n);
  for (let v = 0; v < vertexCount; v += 1) {
    const x = positions[v * 2];
    const y = positions[v * 2 + 1];
    let sum = 0;
    for (let b = 0; b < n; b += 1) {
      const w = Math.max(0, finite(rawWeights[v * n + b], 0));
      weights[v * n + b] = w;
      sum += w;
      const m = inverses[b];
      local[(v * n + b) * 2] = m.a * x + m.c * y + m.tx;
      local[(v * n + b) * 2 + 1] = m.b * x + m.d * y + m.ty;
    }
    if (sum > 0) {
      for (let b = 0; b < n; b += 1) weights[v * n + b] /= sum;
    } else {
      weights[v * n] = 1;
    }
  }
  prepared.boneIds = ids;
  prepared.binds = binds;
  prepared.local = local;
  prepared.weights = weights;
  // Back to front by the depth of the bones each cell follows (a bone with no
  // depth sits at 0); with no depths at all the grid order stands.
  const depths = rawBones.map((raw) => (raw as { depth?: unknown }).depth);
  if (depths.some((d) => typeof d === 'number' && Number.isFinite(d))) {
    const cellDepth: number[] = [];
    for (let c = 0; c < cols * rows; c += 1) {
      const v = Math.floor(c / cols) * (cols + 1) + (c % cols);
      let sum = 0;
      for (const corner of [v, v + 1, v + cols + 1, v + cols + 2]) {
        for (let b = 0; b < n; b += 1) sum += weights[corner * n + b] * finite(depths[b], 0);
      }
      cellDepth.push(sum / 4);
    }
    const order = gridCells.slice().sort((a, b) => (cellDepth[a] - cellDepth[b]) || (a - b));
    prepared.indices = cellIndices(cols, order);
  }
  return prepared;
}

/** A bone's transform in the mesh's space right now, off the live display objects. */
export function boneInMeshSpace(mesh: SkinDisplayObjectLike, bone: unknown): SkinAffine {
  const o = mesh.toLocal({ x: 0, y: 0 }, bone);
  const ex = mesh.toLocal({ x: 1, y: 0 }, bone);
  const ey = mesh.toLocal({ x: 0, y: 1 }, bone);
  return { a: ex.x - o.x, b: ex.y - o.y, c: ey.x - o.x, d: ey.y - o.y, tx: o.x, ty: o.y };
}

/** Every vertex placed for these bone transforms (`null` = that bone holds its bind pose), into `out` (`x, y` per vertex). */
export function deformSkinnedMesh(
  prepared: PreparedSkinnedMesh,
  bones: ReadonlyArray<SkinAffine | null>,
  out: { [index: number]: number; length: number },
): void {
  const n = prepared.boneIds.length;
  const count = Math.min(prepared.vertexCount, Math.floor(out.length / 2));
  if (n === 0) {
    for (let i = 0; i < count * 2; i += 1) out[i] = prepared.positions[i];
    return;
  }
  const mats = prepared.binds.map((bind, b) => bones[b] ?? bind);
  for (let v = 0; v < count; v += 1) {
    let x = 0;
    let y = 0;
    for (let b = 0; b < n; b += 1) {
      const w = prepared.weights[v * n + b];
      if (w === 0) continue;
      const m = mats[b];
      const lx = prepared.local[(v * n + b) * 2];
      const ly = prepared.local[(v * n + b) * 2 + 1];
      x += w * (m.a * lx + m.c * ly + m.tx);
      y += w * (m.b * lx + m.d * ly + m.ty);
    }
    out[v * 2] = x;
    out[v * 2 + 1] = y;
  }
}

/**
 * Re-place a skinned mesh's vertices (`vertices`, the mesh's own position
 * buffer) from its bones' live transforms, when any bone moved since the last
 * time. Returns whether they changed — the caller uploads the buffer then.
 * Never throws.
 */
export function updateSkinnedMesh(
  mesh: SkinDisplayObjectLike,
  prepared: PreparedSkinnedMesh,
  vertices: { [index: number]: number; length: number },
  resolve: (id: string) => unknown,
): boolean {
  const n = prepared.boneIds.length;
  if (n === 0) {
    if (prepared.last) return false;
    prepared.last = new Float64Array(0);
    deformSkinnedMesh(prepared, [], vertices);
    return true;
  }
  const now = new Float64Array(n * 6);
  const live: Array<SkinAffine | null> = [];
  for (let b = 0; b < n; b += 1) {
    let m: SkinAffine | null = null;
    const bone = resolve(prepared.boneIds[b]);
    if (bone && !(bone as { destroyed?: boolean }).destroyed) {
      try {
        m = boneInMeshSpace(mesh, bone);
      } catch {
        m = null;
      }
      if (m && ![m.a, m.b, m.c, m.d, m.tx, m.ty].every(Number.isFinite)) m = null;
    }
    const use = m ?? prepared.binds[b];
    now.set([use.a, use.b, use.c, use.d, use.tx, use.ty], b * 6);
    live.push(m);
  }
  const last = prepared.last;
  if (last && last.length === now.length) {
    let same = true;
    for (let i = 0; i < now.length; i += 1) {
      if (Math.abs(now[i] - last[i]) > 1e-6) {
        same = false;
        break;
      }
    }
    if (same) return false;
  }
  prepared.last = now;
  deformSkinnedMesh(prepared, live, vertices);
  return true;
}
