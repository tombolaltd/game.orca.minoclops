/**
 * RAPIER PHYSICS — game runtime.
 *
 * The project's physics mode (`generated-physics.ts`, written by the editor
 * from Project Settings → Physics) picks ONE world for the whole game:
 *   - 'off' — this module is inert: nothing is loaded, every call is a no-op.
 *   - '2d'  — Rapier 2D (compat build), bodies on 2D scene nodes.
 *   - '3d'  — Rapier 3D (compat build), bodies on `scene3d` nodes.
 * Rapier is loaded DYNAMICALLY (its own chunk, WASM inlined) through the
 * generated `loadRapierModule()`, which is the ONLY code naming the package:
 * the editor emits the `import(…)` there only for the active mode and only
 * once that package is installed, and `Promise.resolve(null)` otherwise. So
 * the shared runtime builds in every project — including ones whose webpack
 * has no `resolve.fallback` for it — and this file never names the package.
 * null ⇒ the game runs WITHOUT physics (one warning when the mode is on).
 *
 * 2D: the world is in SCREEN orientation (y-down, no flip) and in the scene
 * ROOT's space (the root container `SceneManager` builds per scene, before
 * the camera fit scales / moves it): metres = root-space px / pixelsPerMeter,
 * radians turn the same way as Pixi. A body sits on its node's ORIGIN (local
 * 0,0) with the node's root-space rotation; collider sizes are multiplied by
 * the node's root-space scale (see `collider2DPieces`).
 * 3D: scene units are metres; bodies use the Object3D's WORLD position and
 * quaternion; collider sizes are multiplied by its world scale.
 *
 * Per fixed step (see `step`):
 *   - kinematic bodies FOLLOW their node (its transform this frame, eased
 *     across the frame's substeps) — so `step` must run AFTER everything that
 *     poses nodes (animations, IK, layout);
 *   - dynamic bodies are simulated, then WRITTEN BACK to their node (local
 *     position + rotation; scale untouched). Physics therefore owns a dynamic
 *     node's position / rotation: a layout pass or tween that moves it is
 *     overwritten on the next frame. Use `syncBodyFromNode` to teleport one.
 *   - static bodies are placed once (and re-placed by `syncStaticBodies`, which
 *     SceneManager runs after every layout pass, e.g. a resize).
 *
 * dontDestroyOnLoad (2D): `unregisterScene` keeps a body whose display object
 * survived the teardown (SceneManager re-parents DDOL subtrees instead of
 * destroying them). It is disabled until the next registered scene contains
 * the object again (the DDOL rebind places it at its slot), then re-enabled,
 * teleported to the node and kept, velocity included.
 *
 * Collisions: every collider reports start / stop. Listeners added with
 * `onCollision` receive the two NODE ids; the same payload is emitted on the
 * shared `eventEmitter` (the one FlowState's `fireCustomEvent` uses) as
 * `ORCA_PHYSICS_COLLISION` `{ a, b, started, sensor }`. Rapier reports
 * per COLLIDER pair, but a body may own several colliders (a concave 2D
 * polygon is decomposed into convex pieces), so events are folded per BODY
 * pair: a reference count per (body pair, sensor | solid) — a collider pair is
 * "sensor" when either collider is one — emits started on 0 → 1 and stopped on
 * 1 → 0 only. Sensor and solid contacts of the same two bodies count
 * independently. A body REMOVED (scene unload, reset) or parked as a DDOL
 * survivor while touching emits NO stop: its contacts and counts are dropped
 * silently. The live collider-pair set also answers `isTouching`.
 *
 * FlowState controls (`methods/physics.ts`) go through the exported helpers
 * below (`addForceForOneStep`, `setBodyType`, `setBodyEnabledById`,
 * `teleportBody`, `setGravity`, `isTouching`) so the runtime's own bookkeeping
 * — kinematic follow / dynamic write-back by `data.bodyType`, one-step forces
 * reset after the next substep, a disabled body neither followed nor written
 * back — stays consistent.
 *
 * Import-cycle rule: imported bindings are only touched inside functions.
 */

import { eventEmitter } from '@game-studio/arcade-base';
import { PHYSICS_MODE, PHYSICS_SETTINGS, loadRapierModule } from './generated-physics';
import {
    applyMatrix2D,
    collider2DPieces,
    collider3DPrimitive,
    collisionGroups,
    decomposeMatrix2D,
    flattenPoints2D,
    identityMatrix2D,
    invertMatrix2D,
    lerpAngle,
    multiplyMatrix2D,
    nlerpQuaternion,
    normalizePhysicsBody2D,
    normalizePhysicsBody3D,
    physicsPixelsPerMeter,
} from './physics-shapes';
import type {
    OrcaPhysicsBody2D,
    OrcaPhysicsBody3D,
    OrcaPhysicsBodyCommon,
    PhysicsMatrix2D,
    PhysicsQuat,
    PhysicsVec3,
} from './physics-shapes';

// Rapier and three are typed loosely on purpose (optional packages; three's
// types need TS 5, the game compiles with TS 4.9).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RapierAny = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreeAny = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DisplayObjectAny = any;

export type PhysicsRuntimeMode = 'off' | '2d' | '3d';

/** Event name on the shared `eventEmitter`. */
export const ORCA_PHYSICS_COLLISION_EVENT = 'ORCA_PHYSICS_COLLISION';

export interface PhysicsCollisionEvent {
    a: string;
    b: string;
    started: boolean;
    sensor: boolean;
}

export type PhysicsCollisionListener = (aNodeId: string, bNodeId: string, started: boolean, sensor: boolean) => void;

/** A 2D node to simulate: its id, its built Pixi display object and its raw `physicsBody`. */
export interface PhysicsEntry2D {
    id: string;
    displayObject: DisplayObjectAny;
    data: unknown;
}

/** A `scene3d` node to simulate: its id, its Object3D (holder Group) and its raw `physicsBody`. */
export interface PhysicsEntry3D {
    id: string;
    object3d: ThreeAny;
    data: unknown;
}

/** What the 3D layer lends the runtime for building 3D colliders. */
export interface PhysicsScene3DTools {
    THREE: ThreeAny;
    /** The glTF scene for a bucket-relative `src` — the SAME loader + cache as `model3d`. */
    loadModelScene?: (src: string) => Promise<ThreeAny>;
    /** Resolves once model3d `id`'s glTF is in its holder (false: not a model / failed). */
    whenModelReady?: (id: string) => Promise<boolean>;
}

interface Settings {
    mode: PhysicsRuntimeMode;
    pixelsPerMeter: number;
    timestep: number;
    maxSubsteps: number;
    gravity2d: { x: number; y: number };
    gravity3d: PhysicsVec3;
    collisionMatrix: number[];
}

interface BodyRecord {
    nodeId: string;
    /** null ⇒ a DDOL survivor waiting for its next scene (body disabled). */
    sceneId: string | null;
    dim: 2 | 3;
    body: RapierAny;
    colliderHandles: number[];
    data: OrcaPhysicsBody2D | OrcaPhysicsBody3D;
    /** JSON of `data`, to tell a changed DDOL rebind from the same body. */
    signature: string;
    displayObject?: DisplayObjectAny;
    root?: DisplayObjectAny;
    object3d?: ThreeAny;
}

interface SceneRecord {
    id: string;
    dim: 2 | 3;
    token: number;
    root: DisplayObjectAny;
    pending2D: PhysicsEntry2D[] | null;
    pending3D: PhysicsEntry3D[] | null;
    tools: PhysicsScene3DTools | null;
    records: Set<BodyRecord>;
}

// ── Settings ─────────────────────────────────────────────────────────────────

function finiteOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

let cachedSettings: Settings | null = null;

function settings(): Settings {
    if (cachedSettings) return cachedSettings;
    const raw = (PHYSICS_SETTINGS || {}) as unknown as Record<string, unknown>;
    const mode: PhysicsRuntimeMode = PHYSICS_MODE === '2d' || PHYSICS_MODE === '3d' ? PHYSICS_MODE : 'off';
    const g2 = (raw.gravity2d || {}) as Record<string, unknown>;
    const g3 = (raw.gravity3d || {}) as Record<string, unknown>;
    cachedSettings = {
        mode,
        pixelsPerMeter: physicsPixelsPerMeter(raw.pixelsPerMeter),
        timestep: clamp(finiteOr(raw.timestep, 1 / 60), 1 / 240, 1 / 15),
        maxSubsteps: clamp(Math.round(finiteOr(raw.maxSubsteps, 4)), 1, 16),
        gravity2d: { x: finiteOr(g2.x, 0), y: finiteOr(g2.y, 9.81) },
        gravity3d: { x: finiteOr(g3.x, 0), y: finiteOr(g3.y, -9.81), z: finiteOr(g3.z, 0) },
        collisionMatrix: Array.isArray(raw.collisionMatrix) ? (raw.collisionMatrix as number[]).slice() : [],
    };
    return cachedSettings;
}

/** The project's physics mode ('off' unless physics is on AND a mode is picked). */
export function physicsMode(): PhysicsRuntimeMode {
    return settings().mode;
}

/** True when physics runs in `mode` (or in any mode, when omitted). */
export function isPhysicsEnabled(mode?: '2d' | '3d'): boolean {
    const current = physicsMode();
    return current !== 'off' && (mode === undefined || current === mode);
}

// ── Rapier loading ───────────────────────────────────────────────────────────

let rapierPromise: Promise<RapierAny | null> | null = null;
let rapier: RapierAny | null = null;
const warned = new Set<string>();

function warnOnce(key: string, message: string, err?: unknown): void {
    if (warned.has(key)) return;
    warned.add(key);
    if (err !== undefined) console.warn(message, err);
    else console.warn(message);
}

/**
 * Load + initialise the Rapier build for the project's mode, once. Resolves to
 * the module, or null when physics is off or Rapier cannot load (warned once;
 * the game then runs without physics).
 */
export function loadRapier(): Promise<RapierAny | null> {
    const mode = physicsMode();
    if (mode === 'off') return Promise.resolve(null);
    if (!rapierPromise) {
        rapierPromise = (async (): Promise<RapierAny | null> => {
            try {
                // The ONLY place the Rapier package is named is the generated
                // module (see the header): null ⇒ not installed / physics off.
                const mod: RapierAny = typeof loadRapierModule === 'function' ? await loadRapierModule() : null;
                if (mod === null || mod === undefined) {
                    warnOnce('absent', `[Physics] Physics is '${mode}' but the Rapier package is not installed yet; the game runs without physics.`);
                    return null;
                }
                // Default export (CJS interop / bundler) or the namespace itself.
                const preferred: RapierAny = mod.default ?? mod;
                const candidate: RapierAny = preferred && typeof preferred.init === 'function'
                    ? preferred
                    : typeof mod.init === 'function' ? mod : null;
                if (!candidate || typeof candidate.World !== 'function') {
                    throw new Error(`the Rapier ${mode} module has no init() / World`);
                }
                await candidate.init();
                rapier = candidate;
                return candidate;
            } catch (err) {
                warnOnce('load', `[Physics] Could not load Rapier (${mode}); the game runs without physics.`, err);
                return null;
            }
        })();
    }
    return rapierPromise;
}

/** The initialised Rapier module, or null until `loadRapier` has resolved. */
export function getRapier(): RapierAny | null {
    return rapier;
}

// ── World state ──────────────────────────────────────────────────────────────

let world: RapierAny = null;
let eventQueue: RapierAny = null;
let accumulator = 0;
let tokenSerial = 0;
const scenes = new Map<string, SceneRecord>();
/** DDOL survivors between scenes. */
const persistent = new Set<BodyRecord>();
const byNode = new Map<string, BodyRecord>();
const byCollider = new Map<number, BodyRecord>();
const listeners = new Set<PhysicsCollisionListener>();
/** Live collider-pair contacts (started, not yet stopped), keyed `${lowHandle}:${highHandle}`. */
const contacts = new Map<string, { a: BodyRecord; b: BodyRecord; sensor: boolean; pairKey: string }>();
/** Live collider-pair count per BODY pair + kind, keyed `${lowUid}|${highUid}|s` or `…|c`. */
const bodyPairCounts = new Map<string, { a: BodyRecord; b: BodyRecord; count: number }>();
const recordUids = new WeakMap<BodyRecord, number>();
let recordUidSerial = 0;

function recordUid(record: BodyRecord): number {
    let uid = recordUids.get(record);
    if (uid === undefined) {
        uid = ++recordUidSerial;
        recordUids.set(record, uid);
    }
    return uid;
}

/** Drop `record`'s contacts and body-pair counts WITHOUT emitting stops. */
function forgetContacts(record: BodyRecord): void {
    for (const [key, pair] of Array.from(contacts)) {
        if (pair.a === record || pair.b === record) contacts.delete(key);
    }
    for (const [key, pair] of Array.from(bodyPairCounts)) {
        if (pair.a === record || pair.b === record) bodyPairCounts.delete(key);
    }
}
/** Bodies given a one-step force: their forces reset after the next substep. */
const oneStepForces = new Set<RapierAny>();

function ensureWorld(): RapierAny {
    if (world || !rapier) return world;
    const s = settings();
    try {
        world = new rapier.World(s.mode === '2d' ? { ...s.gravity2d } : { ...s.gravity3d });
        world.timestep = s.timestep;
        eventQueue = new rapier.EventQueue(true);
    } catch (err) {
        warnOnce('world', '[Physics] Creating the Rapier world failed; the game runs without physics.', err);
        world = null;
        eventQueue = null;
    }
    return world;
}

/** The Rapier `World`, once Rapier has loaded and the first step ran (null otherwise). */
export function getWorld(): RapierAny | null {
    return world;
}

/** The Rapier `RigidBody` simulating node `nodeId`, or null. */
export function getBody(nodeId: string): RapierAny | null {
    const record = byNode.get(nodeId);
    return record ? record.body : null;
}

/** Listen for collision start / stop between two physics nodes. Returns an unsubscribe. */
export function onCollision(cb: PhysicsCollisionListener): () => void {
    if (typeof cb !== 'function') return () => undefined;
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Simulate a 2D scene's physics nodes. `root` is the scene's root container
 * (the physics space); bodies are created on the next `step` once Rapier is
 * ready, from the nodes' transforms AT THAT POINT (after layout). Re-using a
 * `sceneId` replaces it. No-op unless the mode is '2d'.
 */
export function registerScene2D(sceneId: string, root: DisplayObjectAny, entries: PhysicsEntry2D[]): void {
    if (!isPhysicsEnabled('2d') || !root) return;
    unregisterScene(sceneId);
    scenes.set(sceneId, {
        id: sceneId,
        dim: 2,
        token: ++tokenSerial,
        root,
        pending2D: Array.isArray(entries) ? entries.slice() : [],
        pending3D: null,
        tools: null,
        records: new Set(),
    });
    void loadRapier();
}

/**
 * Simulate a `scene3d` section's physics nodes (world space). Mesh colliders
 * may load asynchronously via `tools`. Re-using a `sceneId` replaces it.
 * No-op unless the mode is '3d'.
 */
export function registerScene3D(sceneId: string, entries: PhysicsEntry3D[], tools: PhysicsScene3DTools): void {
    if (!isPhysicsEnabled('3d') || !tools || !tools.THREE) return;
    unregisterScene(sceneId);
    scenes.set(sceneId, {
        id: sceneId,
        dim: 3,
        token: ++tokenSerial,
        root: null,
        pending2D: null,
        pending3D: Array.isArray(entries) ? entries.slice() : [],
        tools,
        records: new Set(),
    });
    void loadRapier();
}

/**
 * Drop a scene's bodies. A 2D body whose display object is still alive (a
 * dontDestroyOnLoad survivor — call this AFTER the scene container is
 * destroyed) is disabled and kept for the next scene instead.
 */
export function unregisterScene(sceneId: string): void {
    const scene = scenes.get(sceneId);
    if (!scene) return;
    scenes.delete(sceneId);
    for (const record of Array.from(scene.records)) {
        if (record.dim === 2 && isAlive(record.displayObject)) {
            record.sceneId = null;
            record.root = null;
            setBodyEnabled(record, false);
            forgetContacts(record);
            persistent.add(record);
        } else {
            removeRecord(record);
        }
    }
    scene.records.clear();
    if (scenes.size === 0 && persistent.size === 0) accumulator = 0;
}

/** Remove every scene and body (the world itself is kept). */
export function resetPhysics(): void {
    for (const id of Array.from(scenes.keys())) unregisterScene(id);
    for (const record of Array.from(persistent)) removeRecord(record);
    persistent.clear();
    accumulator = 0;
}

function isAlive(obj: DisplayObjectAny): boolean {
    return !!obj && obj.destroyed !== true;
}

function setBodyEnabled(record: BodyRecord, enabled: boolean): void {
    try {
        if (typeof record.body?.setEnabled === 'function') record.body.setEnabled(enabled);
    } catch {
        // Body already gone.
    }
}

function removeRecord(record: BodyRecord): void {
    persistent.delete(record);
    if (byNode.get(record.nodeId) === record) byNode.delete(record.nodeId);
    for (const handle of record.colliderHandles) {
        if (byCollider.get(handle) === record) byCollider.delete(handle);
    }
    record.colliderHandles = [];
    forgetContacts(record);
    if (record.body) oneStepForces.delete(record.body);
    if (world && record.body) {
        try {
            world.removeRigidBody(record.body);
        } catch (err) {
            warnOnce('remove', '[Physics] Removing a rigid body failed.', err);
        }
    }
    record.body = null;
}

// ── Body construction ────────────────────────────────────────────────────────

function createBodyDesc(data: OrcaPhysicsBodyCommon): RapierAny {
    const R = rapier;
    const desc = data.bodyType === 'static'
        ? R.RigidBodyDesc.fixed()
        : data.bodyType === 'kinematic'
            ? R.RigidBodyDesc.kinematicPositionBased()
            : R.RigidBodyDesc.dynamic();
    desc.setLinearDamping(data.linearDamping);
    desc.setAngularDamping(data.angularDamping);
    desc.setGravityScale(data.gravityScale);
    desc.setCcdEnabled(data.ccd);
    if (data.fixedRotation) desc.lockRotations();
    return desc;
}

function finishColliderDesc(desc: RapierAny, data: OrcaPhysicsBodyCommon): RapierAny {
    const R = rapier;
    desc.setDensity(data.density);
    desc.setFriction(data.friction);
    desc.setRestitution(data.restitution);
    desc.setSensor(data.isSensor);
    desc.setCollisionGroups(collisionGroups(data.layer, data.collidesWith, settings().collisionMatrix));
    desc.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    return desc;
}

function attachCollider(record: BodyRecord, desc: RapierAny): void {
    const collider = world.createCollider(finishColliderDesc(desc, record.data), record.body);
    const handle = collider.handle as number;
    record.colliderHandles.push(handle);
    byCollider.set(handle, record);
}

function bindRecord(record: BodyRecord, scene: SceneRecord): void {
    record.sceneId = scene.id;
    scene.records.add(record);
    const previous = byNode.get(record.nodeId);
    if (previous && previous !== record) {
        warnOnce(`dup:${record.nodeId}`, `[Physics] Two bodies claim node "${record.nodeId}"; getBody returns the newer.`);
    }
    byNode.set(record.nodeId, record);
}

// ── 2D ───────────────────────────────────────────────────────────────────────

function readLocalMatrix(obj: DisplayObjectAny): PhysicsMatrix2D {
    if (typeof obj.updateLocalTransform === 'function') obj.updateLocalTransform();
    const m = obj.localTransform;
    if (!m) return identityMatrix2D();
    return { a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx, ty: m.ty };
}

/** `obj`'s transform in `root`'s space; null when `obj` is not under `root`. */
function matrixRelativeTo(obj: DisplayObjectAny, root: DisplayObjectAny): PhysicsMatrix2D | null {
    let m = identityMatrix2D();
    let cursor = obj;
    let guard = 0;
    while (cursor && cursor !== root) {
        if (guard++ > 512) return null;
        m = multiplyMatrix2D(readLocalMatrix(cursor), m);
        cursor = cursor.parent;
    }
    return cursor === root ? m : null;
}

function create2DRecord(entry: PhysicsEntry2D, data: OrcaPhysicsBody2D, root: DisplayObjectAny): BodyRecord | null {
    const m = matrixRelativeTo(entry.displayObject, root);
    if (!m) return null;
    const s = settings();
    const t = decomposeMatrix2D(m);
    const pieces = collider2DPieces(data.collider, t.scaleX, t.scaleY, s.pixelsPerMeter);
    if (pieces.length === 0) {
        warnOnce(`empty:${entry.id}`, `[Physics] Node "${entry.id}" has a ${data.collider.shape} collider with no area; it gets no body.`);
        return null;
    }
    const desc = createBodyDesc(data);
    desc.setTranslation(t.x / s.pixelsPerMeter, t.y / s.pixelsPerMeter);
    desc.setRotation(t.rotation);
    const record: BodyRecord = {
        nodeId: entry.id,
        sceneId: null,
        dim: 2,
        body: world.createRigidBody(desc),
        colliderHandles: [],
        data,
        signature: JSON.stringify(data),
        displayObject: entry.displayObject,
        root,
    };
    const R = rapier;
    for (const piece of pieces) {
        let cd: RapierAny = null;
        if (piece.kind === 'cuboid') {
            cd = R.ColliderDesc.cuboid(piece.halfWidth, piece.halfHeight);
            cd.setTranslation(piece.x, piece.y);
            cd.setRotation(piece.rotation);
        } else if (piece.kind === 'ball') {
            cd = R.ColliderDesc.ball(piece.radius);
            cd.setTranslation(piece.x, piece.y);
        } else {
            cd = R.ColliderDesc.convexHull(new Float32Array(flattenPoints2D(piece.points)));
        }
        if (!cd) {
            warnOnce(`hull:${entry.id}`, `[Physics] A polygon piece on node "${entry.id}" is degenerate; it is skipped.`);
            continue;
        }
        attachCollider(record, cd);
    }
    if (record.colliderHandles.length === 0) {
        removeRecord(record);
        return null;
    }
    return record;
}

/** Teleport a 2D body onto its node's current root-space transform. */
function place2DBody(record: BodyRecord): boolean {
    const m = matrixRelativeTo(record.displayObject, record.root);
    if (!m || !record.body) return false;
    const t = decomposeMatrix2D(m);
    const ppm = settings().pixelsPerMeter;
    record.body.setTranslation({ x: t.x / ppm, y: t.y / ppm }, true);
    record.body.setRotation(t.rotation, true);
    return true;
}

function isUnder(obj: DisplayObjectAny, root: DisplayObjectAny): boolean {
    let cursor = obj;
    let guard = 0;
    while (cursor && guard++ < 512) {
        if (cursor === root) return true;
        cursor = cursor.parent;
    }
    return false;
}

function flushScene2D(scene: SceneRecord): void {
    const entries = scene.pending2D || [];
    scene.pending2D = null;
    const claimed = new Set<BodyRecord>();
    for (const entry of entries) {
        if (!entry || typeof entry.id !== 'string' || !isAlive(entry.displayObject)) continue;
        const data = normalizePhysicsBody2D(entry.data);
        if (!data || !data.enabled) continue;
        // A DDOL survivor rebound into this scene keeps its body (and velocity)
        // when its physics data is unchanged.
        let survivor: BodyRecord | null = null;
        for (const record of persistent) {
            if (record.displayObject === entry.displayObject) {
                survivor = record;
                break;
            }
        }
        if (survivor) {
            persistent.delete(survivor);
            if (survivor.signature === JSON.stringify(data)) {
                if (byNode.get(survivor.nodeId) === survivor) byNode.delete(survivor.nodeId);
                survivor.nodeId = entry.id;
                survivor.root = scene.root;
                if (place2DBody(survivor)) {
                    setBodyEnabled(survivor, true);
                    bindRecord(survivor, scene);
                    claimed.add(survivor);
                    continue;
                }
            }
            removeRecord(survivor);
        }
        try {
            const record = create2DRecord(entry, data, scene.root);
            if (record) bindRecord(record, scene);
        } catch (err) {
            warnOnce(`build:${entry.id}`, `[Physics] Building the body for node "${entry.id}" failed; it is skipped.`, err);
        }
    }
    // DDOL descendants are not rebuilt (their DDOL ancestor is rebound whole):
    // adopt every survivor now under this scene; drop destroyed ones.
    for (const record of Array.from(persistent)) {
        if (!isAlive(record.displayObject)) {
            removeRecord(record);
            continue;
        }
        if (claimed.has(record) || !isUnder(record.displayObject, scene.root)) continue;
        persistent.delete(record);
        record.root = scene.root;
        if (place2DBody(record)) {
            setBodyEnabled(record, true);
            bindRecord(record, scene);
        } else {
            removeRecord(record);
        }
    }
}

interface Kinematic2DTarget {
    record: BodyRecord;
    fromX: number;
    fromY: number;
    fromAngle: number;
    toX: number;
    toY: number;
    toAngle: number;
}

function collectKinematic2D(record: BodyRecord, out: Kinematic2DTarget[]): void {
    const m = matrixRelativeTo(record.displayObject, record.root);
    if (!m) return;
    const t = decomposeMatrix2D(m);
    const ppm = settings().pixelsPerMeter;
    const from = record.body.translation();
    out.push({
        record,
        fromX: from.x,
        fromY: from.y,
        fromAngle: record.body.rotation(),
        toX: t.x / ppm,
        toY: t.y / ppm,
        toAngle: t.rotation,
    });
}

/** Write a dynamic body's pose into its node's LOCAL position + rotation (scale, pivot, skew kept). */
function writeBack2D(record: BodyRecord): void {
    const obj = record.displayObject;
    const parent = obj.parent;
    if (!parent) return;
    const parentMatrix = parent === record.root ? identityMatrix2D() : matrixRelativeTo(parent, record.root);
    const inverse = parentMatrix ? invertMatrix2D(parentMatrix) : null;
    if (!inverse) return;
    const ppm = settings().pixelsPerMeter;
    const p = record.body.translation();
    const angle = record.body.rotation();
    const local = applyMatrix2D(inverse, { x: p.x * ppm, y: p.y * ppm });
    // Direction of the body's +x in the parent's space, compared with where the
    // node's own +x points now: turning `rotation` by the difference honours a
    // mirrored node / parent as well as a plain one.
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dirX = inverse.a * cos + inverse.c * sin;
    const dirY = inverse.b * cos + inverse.d * sin;
    const before = readLocalMatrix(obj);
    const delta = lerpAngle(Math.atan2(before.b, before.a), Math.atan2(dirY, dirX), 1) - Math.atan2(before.b, before.a);
    if (Math.abs(delta) > 1e-9) obj.rotation = obj.rotation + delta;
    // localTransform maps local (0,0) to (tx, ty) = position − pivot terms.
    const after = readLocalMatrix(obj);
    const nx = local.x + (obj.position.x - after.tx);
    const ny = local.y + (obj.position.y - after.ty);
    if (Math.abs(nx - obj.position.x) > 1e-6 || Math.abs(ny - obj.position.y) > 1e-6) obj.position.set(nx, ny);
}

// ── 3D ───────────────────────────────────────────────────────────────────────

const MAX_MESH_VERTICES = 200000;

interface WorldPose3D {
    position: PhysicsVec3;
    quaternion: PhysicsQuat;
    scale: PhysicsVec3;
}

function readWorldPose3D(THREE: ThreeAny, object: ThreeAny): WorldPose3D {
    object.updateWorldMatrix(true, false);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    object.matrixWorld.decompose(position, quaternion, scale);
    return {
        position: { x: position.x, y: position.y, z: position.z },
        quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
        scale: { x: scale.x, y: scale.y, z: scale.z },
    };
}

/**
 * Every mesh vertex / triangle under `source`, through `toBody` (Matrix4 from
 * `source`'s world space into the body's). Null when there is no geometry or
 * the vertex budget is exceeded.
 */
function collectGeometry(
    THREE: ThreeAny,
    source: ThreeAny,
    toBody: ThreeAny,
    label: string,
): { vertices: Float32Array; indices: Uint32Array } | null {
    source.updateWorldMatrix(true, true);
    const vertices: number[] = [];
    const indices: number[] = [];
    const v = new THREE.Vector3();
    const m = new THREE.Matrix4();
    let overflow = false;
    source.traverse((child: ThreeAny) => {
        if (overflow || !child || !child.isMesh || !child.geometry) return;
        const position = child.geometry.attributes && child.geometry.attributes.position;
        if (!position || !(position.count > 0)) return;
        if (vertices.length / 3 + position.count > MAX_MESH_VERTICES) {
            overflow = true;
            return;
        }
        m.multiplyMatrices(toBody, child.matrixWorld);
        const base = vertices.length / 3;
        for (let i = 0; i < position.count; i++) {
            v.fromBufferAttribute(position, i).applyMatrix4(m);
            vertices.push(v.x, v.y, v.z);
        }
        const index = child.geometry.index;
        if (index && index.count > 0) {
            for (let i = 0; i + 2 < index.count; i += 3) {
                indices.push(base + index.getX(i), base + index.getX(i + 1), base + index.getX(i + 2));
            }
        } else {
            for (let i = 0; i + 2 < position.count; i += 3) indices.push(base + i, base + i + 1, base + i + 2);
        }
    });
    if (overflow) {
        warnOnce(`mesh-size:${label}`, `[Physics] The mesh collider for "${label}" has more than ${MAX_MESH_VERTICES} vertices; it is skipped.`);
        return null;
    }
    if (vertices.length < 12) return null;
    return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

async function meshColliderDesc(
    scene: SceneRecord,
    entry: PhysicsEntry3D,
    data: OrcaPhysicsBody3D,
    pose: WorldPose3D,
): Promise<RapierAny | null> {
    const tools = scene.tools as PhysicsScene3DTools;
    const THREE = tools.THREE;
    const c = data.collider;
    let geometry: { vertices: Float32Array; indices: Uint32Array } | null = null;
    if (c.shape === 'objectMesh') {
        if (tools.whenModelReady) await tools.whenModelReady(entry.id);
        if (!isSceneCurrent(scene)) return null;
        // From the object's world space into the body frame (position + rotation, no scale).
        const bodyFrame = new THREE.Matrix4().compose(
            new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z),
            new THREE.Quaternion(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w),
            new THREE.Vector3(1, 1, 1),
        );
        geometry = collectGeometry(THREE, entry.object3d, bodyFrame.invert(), entry.id);
    } else {
        if (!c.meshSrc) {
            warnOnce(`mesh-src:${entry.id}`, `[Physics] Node "${entry.id}" has a mesh collider without a model; it gets no body.`);
            return null;
        }
        if (!tools.loadModelScene) return null;
        let source: ThreeAny;
        try {
            source = await tools.loadModelScene(c.meshSrc);
        } catch (err) {
            warnOnce(`mesh-load:${c.meshSrc}`, `[Physics] Loading the collider model "${c.meshSrc}" failed.`, err);
            return null;
        }
        if (!isSceneCurrent(scene) || !source) return null;
        // The model's own space, scaled like the node, is the body frame.
        source.updateWorldMatrix(true, true);
        const rootInverse = source.matrixWorld.clone().invert();
        const scaled = new THREE.Matrix4().makeScale(Math.abs(pose.scale.x), Math.abs(pose.scale.y), Math.abs(pose.scale.z));
        geometry = collectGeometry(THREE, source, scaled.multiply(rootInverse), entry.id);
    }
    if (!geometry) {
        warnOnce(`mesh-empty:${entry.id}`, `[Physics] Node "${entry.id}" has no mesh geometry for its collider; it gets no body.`);
        return null;
    }
    const R = rapier;
    if (c.meshMode === 'trimesh') {
        if (data.bodyType === 'static') return R.ColliderDesc.trimesh(geometry.vertices, geometry.indices);
        warnOnce(`trimesh:${entry.id}`, `[Physics] Node "${entry.id}": a triangle-mesh collider needs a static body; using its convex hull.`);
    }
    const hull = R.ColliderDesc.convexHull(geometry.vertices);
    if (!hull) warnOnce(`hull3d:${entry.id}`, `[Physics] Node "${entry.id}": the convex hull of its mesh is degenerate; it gets no body.`);
    return hull || null;
}

function isSceneCurrent(scene: SceneRecord): boolean {
    const live = scenes.get(scene.id);
    return !!live && live.token === scene.token && !!world;
}

async function create3DRecord(scene: SceneRecord, entry: PhysicsEntry3D, data: OrcaPhysicsBody3D): Promise<void> {
    const THREE = (scene.tools as PhysicsScene3DTools).THREE;
    const c = data.collider;
    const pose = readWorldPose3D(THREE, entry.object3d);
    let colliderDesc: RapierAny = null;
    if (c.shape === 'objectMesh' || c.shape === 'mesh') {
        colliderDesc = await meshColliderDesc(scene, entry, data, pose);
    } else {
        const primitive = collider3DPrimitive(c, pose.scale);
        if (!primitive) {
            warnOnce(`empty:${entry.id}`, `[Physics] Node "${entry.id}" has a ${c.shape} collider with no size; it gets no body.`);
            return;
        }
        const R = rapier;
        colliderDesc = primitive.kind === 'cuboid'
            ? R.ColliderDesc.cuboid(primitive.halfX, primitive.halfY, primitive.halfZ)
            : primitive.kind === 'ball'
                ? R.ColliderDesc.ball(primitive.radius)
                : R.ColliderDesc.capsule(primitive.halfHeight, primitive.radius);
    }
    if (!colliderDesc || !isSceneCurrent(scene)) return;
    const s = Math.abs;
    colliderDesc.setTranslation(c.offset.x * s(pose.scale.x), c.offset.y * s(pose.scale.y), c.offset.z * s(pose.scale.z));
    // Re-read: a model may have moved while its geometry loaded.
    const now = readWorldPose3D(THREE, entry.object3d);
    const desc = createBodyDesc(data);
    desc.setTranslation(now.position.x, now.position.y, now.position.z);
    desc.setRotation(now.quaternion);
    const record: BodyRecord = {
        nodeId: entry.id,
        sceneId: null,
        dim: 3,
        body: world.createRigidBody(desc),
        colliderHandles: [],
        data,
        signature: '',
        object3d: entry.object3d,
    };
    attachCollider(record, colliderDesc);
    bindRecord(record, scene);
}

function flushScene3D(scene: SceneRecord): void {
    const entries = scene.pending3D || [];
    scene.pending3D = null;
    for (const entry of entries) {
        if (!entry || typeof entry.id !== 'string' || !entry.object3d) continue;
        const data = normalizePhysicsBody3D(entry.data);
        if (!data || !data.enabled) continue;
        create3DRecord(scene, entry, data).catch((err: unknown) => {
            warnOnce(`build:${entry.id}`, `[Physics] Building the body for node "${entry.id}" failed; it is skipped.`, err);
        });
    }
}

interface Kinematic3DTarget {
    record: BodyRecord;
    from: PhysicsVec3;
    fromRotation: PhysicsQuat;
    to: PhysicsVec3;
    toRotation: PhysicsQuat;
}

function collectKinematic3D(THREE: ThreeAny, record: BodyRecord, out: Kinematic3DTarget[]): void {
    const pose = readWorldPose3D(THREE, record.object3d);
    const t = record.body.translation();
    const r = record.body.rotation();
    out.push({
        record,
        from: { x: t.x, y: t.y, z: t.z },
        fromRotation: { x: r.x, y: r.y, z: r.z, w: r.w },
        to: pose.position,
        toRotation: pose.quaternion,
    });
}

/** Write a dynamic body's pose into its Object3D's local position + quaternion (scale kept). */
function writeBack3D(THREE: ThreeAny, record: BodyRecord): void {
    const object = record.object3d;
    const parent = object.parent;
    if (!parent) return;
    const t = record.body.translation();
    const r = record.body.rotation();
    const worldScale = new THREE.Vector3();
    object.getWorldScale(worldScale);
    const worldMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(t.x, t.y, t.z),
        new THREE.Quaternion(r.x, r.y, r.z, r.w),
        worldScale,
    );
    parent.updateWorldMatrix(true, false);
    const local = parent.matrixWorld.clone().invert().multiply(worldMatrix);
    const ignoredScale = new THREE.Vector3();
    local.decompose(object.position, object.quaternion, ignoredScale);
}

// ── Stepping ─────────────────────────────────────────────────────────────────

/**
 * Advance physics by a frame of `deltaSeconds`: fixed `timestep` substeps from
 * an accumulator, at most `maxSubsteps` per frame (excess time is dropped, so
 * a hitch never snowballs). Builds pending bodies first, eases kinematic
 * bodies to their nodes across the substeps, and writes dynamic bodies back
 * afterwards. Call AFTER the frame's animation / IK / layout. A no-op while
 * physics is off or Rapier is still loading.
 */
export function step(deltaSeconds: number): void {
    if (!rapier || !(deltaSeconds > 0) || !Number.isFinite(deltaSeconds)) return;
    if (!ensureWorld()) return;
    const s = settings();

    for (const scene of Array.from(scenes.values())) {
        try {
            if (scene.pending2D) flushScene2D(scene);
            if (scene.pending3D) flushScene3D(scene);
        } catch (err) {
            warnOnce(`flush:${scene.id}`, '[Physics] Building a scene\'s bodies failed.', err);
        }
    }

    accumulator += deltaSeconds;
    let steps = Math.floor(accumulator / s.timestep);
    if (steps > s.maxSubsteps) {
        steps = s.maxSubsteps;
        accumulator = 0;
    } else {
        accumulator -= steps * s.timestep;
    }
    if (steps <= 0) return;

    const kinematic2D: Kinematic2DTarget[] = [];
    const kinematic3D: Kinematic3DTarget[] = [];
    const dynamic: BodyRecord[] = [];
    let THREE: ThreeAny = null;
    for (const scene of scenes.values()) {
        if (scene.dim === 3 && scene.tools) THREE = scene.tools.THREE;
        for (const record of scene.records) {
            if (!record.body || !isBodyEnabled(record)) continue;
            const type = record.data.bodyType;
            if (record.dim === 2) {
                if (!isAlive(record.displayObject)) continue;
                if (type === 'kinematic') collectKinematic2D(record, kinematic2D);
                else if (type === 'dynamic') dynamic.push(record);
            } else if (scene.tools) {
                if (type === 'kinematic') collectKinematic3D(scene.tools.THREE, record, kinematic3D);
                else if (type === 'dynamic') dynamic.push(record);
            }
        }
    }

    try {
        for (let i = 0; i < steps; i++) {
            const t = (i + 1) / steps;
            for (const k of kinematic2D) {
                k.record.body.setNextKinematicTranslation({
                    x: k.fromX + (k.toX - k.fromX) * t,
                    y: k.fromY + (k.toY - k.fromY) * t,
                });
                k.record.body.setNextKinematicRotation(lerpAngle(k.fromAngle, k.toAngle, t));
            }
            for (const k of kinematic3D) {
                k.record.body.setNextKinematicTranslation({
                    x: k.from.x + (k.to.x - k.from.x) * t,
                    y: k.from.y + (k.to.y - k.from.y) * t,
                    z: k.from.z + (k.to.z - k.from.z) * t,
                });
                k.record.body.setNextKinematicRotation(nlerpQuaternion(k.fromRotation, k.toRotation, t));
            }
            world.step(eventQueue);
            clearOneStepForces();
            drainEvents();
        }
    } catch (err) {
        warnOnce('step', '[Physics] A physics step failed.', err);
        clearOneStepForces();
        return;
    }

    for (const record of dynamic) {
        if (!record.body) continue;
        try {
            if (typeof record.body.isSleeping === 'function' && record.body.isSleeping()) continue;
            if (record.dim === 2) writeBack2D(record);
            else if (THREE) writeBack3D(THREE, record);
        } catch (err) {
            warnOnce(`write:${record.nodeId}`, `[Physics] Moving node "${record.nodeId}" from its body failed.`, err);
        }
    }
}

function drainEvents(): void {
    if (!eventQueue) return;
    eventQueue.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
        const a = byCollider.get(h1);
        const b = byCollider.get(h2);
        if (!a || !b) return;
        let sensor = false;
        try {
            const c1 = world.getCollider(h1);
            const c2 = world.getCollider(h2);
            sensor = !!((c1 && c1.isSensor()) || (c2 && c2.isSensor()));
        } catch {
            sensor = a.data.isSensor || b.data.isSensor;
        }
        if (a === b) return; // two colliders of one body
        const key = h1 < h2 ? `${h1}:${h2}` : `${h2}:${h1}`;
        if (started) {
            if (contacts.has(key)) return; // duplicate start
            const ua = recordUid(a);
            const ub = recordUid(b);
            const pairKey = `${Math.min(ua, ub)}|${Math.max(ua, ub)}|${sensor ? 's' : 'c'}`;
            contacts.set(key, { a, b, sensor, pairKey });
            const entry = bodyPairCounts.get(pairKey);
            if (entry) {
                entry.count += 1;
                return;
            }
            bodyPairCounts.set(pairKey, { a, b, count: 1 });
            emitCollision(a.nodeId, b.nodeId, true, sensor);
        } else {
            const contact = contacts.get(key);
            if (!contact) return; // never started, or forgotten with a removed / parked body
            contacts.delete(key);
            const entry = bodyPairCounts.get(contact.pairKey);
            if (!entry) return;
            entry.count -= 1;
            if (entry.count > 0) return;
            bodyPairCounts.delete(contact.pairKey);
            emitCollision(a.nodeId, b.nodeId, false, contact.sensor);
        }
    });
}

function emitCollision(a: string, b: string, started: boolean, sensor: boolean): void {
    for (const cb of Array.from(listeners)) {
        try {
            cb(a, b, started, sensor);
        } catch (err) {
            warnOnce('listener', '[Physics] A collision listener threw.', err);
        }
    }
    try {
        const payload: PhysicsCollisionEvent = { a, b, started, sensor };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (eventEmitter as any).emit(ORCA_PHYSICS_COLLISION_EVENT, payload);
    } catch (err) {
        warnOnce('emit', '[Physics] Emitting a collision event failed.', err);
    }
}

// ── Teleports ────────────────────────────────────────────────────────────────

/**
 * Teleport node `nodeId`'s body onto the node's current transform (keeps the
 * velocity unless `resetVelocity`). Use after moving a DYNAMIC node yourself —
 * otherwise the next step writes the body's pose back over it. Returns false
 * when the node has no body.
 */
export function syncBodyFromNode(nodeId: string, resetVelocity = false): boolean {
    const record = byNode.get(nodeId);
    if (!record || !record.body || record.sceneId === null) return false;
    let placed = false;
    if (record.dim === 2) {
        placed = place2DBody(record);
    } else {
        const scene = scenes.get(record.sceneId);
        if (scene && scene.tools) {
            const pose = readWorldPose3D(scene.tools.THREE, record.object3d);
            record.body.setTranslation(pose.position, true);
            record.body.setRotation(pose.quaternion, true);
            placed = true;
        }
    }
    if (placed && resetVelocity) {
        record.body.setLinvel(record.dim === 2 ? { x: 0, y: 0 } : { x: 0, y: 0, z: 0 }, true);
        record.body.setAngvel(record.dim === 2 ? 0 : { x: 0, y: 0, z: 0 }, true);
    }
    return placed;
}

/** Re-place every 2D STATIC body on its node — run after a layout pass (resize / orientation). */
export function syncStaticBodies(): void {
    if (!world) return;
    for (const scene of scenes.values()) {
        if (scene.dim !== 2) continue;
        for (const record of scene.records) {
            if (record.data.bodyType !== 'static' || !isAlive(record.displayObject)) continue;
            try {
                place2DBody(record);
            } catch (err) {
                warnOnce(`static:${record.nodeId}`, `[Physics] Re-placing static body "${record.nodeId}" failed.`, err);
            }
        }
    }
}

// ── FlowState controls ───────────────────────────────────────────────────────
// Used by `methods/physics.ts`. Every helper takes a NODE id, answers false /
// null / 0 when the node has no live body (physics off, Rapier not loaded yet,
// no body, a DDOL survivor waiting for its scene) and never throws.

export type PhysicsBodyTypeName = 'static' | 'dynamic' | 'kinematic';

/** A body bound to a live scene (not a DDOL survivor between scenes). */
function liveRecord(nodeId: string): BodyRecord | null {
    if (typeof nodeId !== 'string' || !nodeId) return null;
    const record = byNode.get(nodeId);
    return record && record.body && record.sceneId !== null ? record : null;
}

function isBodyEnabled(record: BodyRecord): boolean {
    try {
        return typeof record.body?.isEnabled === 'function' ? record.body.isEnabled() !== false : true;
    } catch {
        return false;
    }
}

function clearOneStepForces(): void {
    if (oneStepForces.size === 0) return;
    for (const body of oneStepForces) {
        try {
            body.resetForces(true);
        } catch {
            // Body already gone.
        }
    }
    oneStepForces.clear();
}

/** Pixels per metre of the 2D world (scene-root px ↔ metres). */
export function pixelsPerMeter(): number {
    return settings().pixelsPerMeter;
}

/** The Rapier body of `nodeId` when it is in a live scene (null otherwise). */
export function getLiveBody(nodeId: string): RapierAny | null {
    const record = liveRecord(nodeId);
    return record ? record.body : null;
}

/** Which world `nodeId`'s live body is in (null: no live body). */
export function bodyDimension(nodeId: string): 2 | 3 | null {
    const record = liveRecord(nodeId);
    return record ? record.dim : null;
}

/**
 * Add `force` (Newtons, world axes) to `nodeId`'s body for ONE physics step:
 * it is reset right after the next substep. Repeat each frame for a sustained
 * push. False when the node has no live body.
 */
export function addForceForOneStep(nodeId: string, force: { x: number; y: number; z?: number }): boolean {
    const record = liveRecord(nodeId);
    if (!record) return false;
    try {
        record.body.addForce(force, true);
        oneStepForces.add(record.body);
        return true;
    } catch (err) {
        warnOnce(`force:${nodeId}`, `[Physics] Adding a force to node "${nodeId}" failed.`, err);
        return false;
    }
}

/**
 * Switch `nodeId`'s body between static / dynamic / kinematic. The runtime's
 * own bookkeeping follows: kinematic bodies follow their node from the next
 * step, dynamic ones are written back to it, static ones are re-placed after
 * layout passes.
 */
export function setBodyType(nodeId: string, bodyType: PhysicsBodyTypeName): boolean {
    const record = liveRecord(nodeId);
    const R = rapier;
    if (!record || !R) return false;
    if (bodyType !== 'static' && bodyType !== 'dynamic' && bodyType !== 'kinematic') return false;
    if (record.data.bodyType === bodyType) return true;
    try {
        const T = R.RigidBodyType || {};
        const rapierType = bodyType === 'static' ? T.Fixed : bodyType === 'kinematic' ? T.KinematicPositionBased : T.Dynamic;
        if (rapierType === undefined) return false;
        record.body.setBodyType(rapierType, true);
        // A copy: `data` may be the normalised object another record compares against.
        record.data = { ...record.data, bodyType } as OrcaPhysicsBody2D | OrcaPhysicsBody3D;
        if (bodyType !== 'dynamic') oneStepForces.delete(record.body);
        return true;
    } catch (err) {
        warnOnce(`type:${nodeId}`, `[Physics] Changing the body type of node "${nodeId}" failed.`, err);
        return false;
    }
}

/**
 * Enable / disable `nodeId`'s body. A disabled body takes no part in the
 * simulation and is neither followed nor written back, so its node can be
 * moved freely; re-enabling teleports the body onto the node first (velocity
 * kept).
 */
export function setBodyEnabledById(nodeId: string, enabled: boolean): boolean {
    const record = liveRecord(nodeId);
    if (!record) return false;
    const on = enabled !== false;
    if (on && !isBodyEnabled(record)) syncBodyFromNode(nodeId, false);
    setBodyEnabled(record, on);
    return true;
}

/**
 * Teleport `nodeId`'s body to `position` — metres in the scene ROOT's space
 * (2D, y-down) or world space (3D) — reset its linear + angular velocity, and
 * move the node onto it (rotation kept).
 */
export function teleportBody(nodeId: string, position: { x: number; y: number; z?: number }): boolean {
    const record = liveRecord(nodeId);
    if (!record) return false;
    try {
        const body = record.body;
        if (record.dim === 2) {
            body.setTranslation({ x: position.x, y: position.y }, true);
            body.setLinvel({ x: 0, y: 0 }, true);
            body.setAngvel(0, true);
            if (isAlive(record.displayObject)) writeBack2D(record);
        } else {
            body.setTranslation({ x: position.x, y: position.y, z: position.z ?? 0 }, true);
            body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            const scene = record.sceneId !== null ? scenes.get(record.sceneId) : undefined;
            if (scene && scene.tools && record.object3d) writeBack3D(scene.tools.THREE, record);
        }
        return true;
    } catch (err) {
        warnOnce(`teleport:${nodeId}`, `[Physics] Teleporting node "${nodeId}" failed.`, err);
        return false;
    }
}

/**
 * Set the world's gravity (m/s²; 2D screen y-down). Applies to the live world
 * and to one created later (Rapier still loading). False when physics is off.
 */
export function setGravity(gravity: { x: number; y: number; z?: number }): boolean {
    const s = settings();
    if (s.mode === 'off') return false;
    const x = finiteOr(gravity.x, 0);
    const y = finiteOr(gravity.y, 0);
    if (s.mode === '2d') s.gravity2d = { x, y };
    else s.gravity3d = { x, y, z: finiteOr(gravity.z, 0) };
    if (world) {
        try {
            world.gravity = s.mode === '2d' ? { ...s.gravity2d } : { ...s.gravity3d };
        } catch (err) {
            warnOnce('gravity', '[Physics] Setting the world gravity failed.', err);
            return false;
        }
    }
    return true;
}

/**
 * True while `nodeId`'s body is in contact (solid or sensor) with `otherNodeId`'s
 * body — or with ANY body when `otherNodeId` is empty. Both bodies must be enabled.
 */
export function isTouching(nodeId: string, otherNodeId?: string | null): boolean {
    const record = liveRecord(nodeId);
    if (!record || !isBodyEnabled(record)) return false;
    const other = otherNodeId ? liveRecord(otherNodeId) : null;
    if (otherNodeId && !other) return false;
    for (const pair of contacts.values()) {
        const partner: BodyRecord | null = pair.a === record ? pair.b : pair.b === record ? pair.a : null;
        if (!partner || partner === record || !partner.body || !isBodyEnabled(partner)) continue;
        if (!other || partner === other) return true;
    }
    return false;
}
