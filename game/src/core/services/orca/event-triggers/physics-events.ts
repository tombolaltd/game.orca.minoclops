import sceneManager from "../scene-manager";
import { onCollision, physicsMode } from "../physics-runtime";
import { nodeRefId } from "../methods/node-ref";
import { node3DRefId } from "../methods/node3d-ref";

/**
 * Physics collision / trigger starter auto-registration.
 *
 * Eight starters (titles are immutable runtime keys, src/menu/starter/physics.json):
 *   onPhysics{Collision|Trigger}{Enter|Exit}{2D|3D}
 * each with an optional `target` (nodeRef in 2D, node3dRef in 3D).
 *
 * ONE `physics-runtime` `onCollision` subscription serves them all. Per event
 * `(a, b, started, sensor)` the matching title is picked — Trigger when either
 * collider is a sensor, else Collision; Enter on start, Exit on stop; 2D / 3D
 * by the project's physics mode — and every starter with that title fires for
 * each side of the pair its `target` matches, with that side as `self`:
 *   { self: { kind, nodeId }, other: { kind, nodeId }, otherName }
 * (kind 'nodeRef' in 2D, 'node3dRef' in 3D; read through
 * `WalkContext.starterArgs`). An UNSET `target` matches any body, so it fires
 * twice per event — once per side. A per-skin target with no entry for the
 * booting skin never fires (the pixi-starter rule).
 *
 * Targets are resolved LAZILY per event (the subscription does not depend on
 * any loaded scene), so a single bind at `Flowstate.init()` serves every scene;
 * re-binding is idempotent (earlier subscription detached first).
 *
 * The `dispatch` callback is `Flowstate.runFlowsByStarterId` (no circular import).
 */

export const PHYSICS_STARTER_TITLES: readonly string[] = [
    'onPhysicsCollisionEnter2D', 'onPhysicsCollisionExit2D', 'onPhysicsTriggerEnter2D', 'onPhysicsTriggerExit2D',
    'onPhysicsCollisionEnter3D', 'onPhysicsCollisionExit3D', 'onPhysicsTriggerEnter3D', 'onPhysicsTriggerExit3D',
];

interface MinimalStarter {
    id: string;
    title: string;
    properties?: Array<{ name: string; value?: any }>;
}

interface RegisteredGraphLite {
    id: string;
    starterNodes: MinimalStarter[];
}

interface PhysicsStarterTarget {
    graphId: string;
    nodeId: string;
    /** Raw `target` property value (resolved per event). */
    target: unknown;
}

let detach: (() => void) | null = null;

export function detachAllPhysicsStarters(): void {
    if (!detach) return;
    try { detach(); } catch { /* ignored */ }
    detach = null;
}

/** True when a reference value names no node at all (⇒ "any body"). */
function isUnsetRef(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (typeof value === 'object' && 'nodeId' in (value as object)) {
        const id = (value as { nodeId?: unknown }).nodeId;
        return typeof id !== 'string' || id === '';
    }
    return false;
}

/** The authored name of scene node `id` ('' when unknown). Never throws. */
function nodeName(id: string): string {
    try {
        const manager = sceneManager as unknown as {
            getNodeDataById?: (nodeId: string) => { name?: unknown } | undefined;
            getObject3DById?: (nodeId: string) => { name?: unknown } | null;
            getDisplayObjectById?: (nodeId: string) => { label?: unknown; name?: unknown } | null | undefined;
        };
        const data = manager.getNodeDataById ? manager.getNodeDataById(id) : undefined;
        if (data && typeof data.name === 'string' && data.name) return data.name;
        const object3d = manager.getObject3DById ? manager.getObject3DById(id) : null;
        if (object3d && typeof object3d.name === 'string' && object3d.name) return object3d.name;
        const display = manager.getDisplayObjectById ? manager.getDisplayObjectById(id) : null;
        if (display) {
            if (typeof display.label === 'string' && display.label) return display.label;
            if (typeof display.name === 'string' && display.name) return display.name;
        }
    } catch {
        // Diagnostic-only lookup.
    }
    return '';
}

/** The starter title an event maps to, or null when physics is off. */
export function physicsStarterTitle(started: boolean, sensor: boolean, mode: string): string | null {
    if (mode !== '2d' && mode !== '3d') return null;
    return `onPhysics${sensor ? 'Trigger' : 'Collision'}${started ? 'Enter' : 'Exit'}${mode === '2d' ? '2D' : '3D'}`;
}

/**
 * Subscribe once to physics collisions and dispatch every physics starter in
 * `graphs`. Idempotent — the earlier subscription is detached first. No
 * subscription when the graphs hold no physics starter.
 */
export function bindPhysicsStarters(
    graphs: RegisteredGraphLite[],
    dispatch: (graphId: string, starterNodeId: string, args?: Record<string, unknown>) => void,
): void {
    detachAllPhysicsStarters();

    const byTitle = new Map<string, PhysicsStarterTarget[]>();
    for (const graph of graphs) {
        for (const starter of graph.starterNodes) {
            if (!starter || !PHYSICS_STARTER_TITLES.includes(starter.title)) continue;
            const prop = starter.properties?.find(p => p.name === 'target');
            const list = byTitle.get(starter.title) ?? [];
            list.push({ graphId: graph.id, nodeId: starter.id, target: prop?.value });
            byTitle.set(starter.title, list);
        }
    }
    if (byTitle.size === 0) return;

    detach = onCollision((a, b, started, sensor) => {
        const mode = physicsMode();
        const title = physicsStarterTitle(started, sensor, mode);
        const targets = title ? byTitle.get(title) : undefined;
        if (!targets || targets.length === 0) return;
        const kind = mode === '2d' ? 'nodeRef' : 'node3dRef';
        const names = new Map<string, string>();
        const nameOf = (id: string): string => {
            if (!names.has(id)) names.set(id, nodeName(id));
            return names.get(id) as string;
        };
        const fire = (target: PhysicsStarterTarget, self: string, other: string): void => {
            try {
                dispatch(target.graphId, target.nodeId, {
                    self: { kind, nodeId: self },
                    other: { kind, nodeId: other },
                    otherName: nameOf(other),
                });
            } catch (err) {
                console.warn(`[physics-events] ${title} dispatch failed:`, err);
            }
        };
        for (const target of targets) {
            if (isUnsetRef(target.target)) {
                fire(target, a, b);
                fire(target, b, a);
                continue;
            }
            const id = mode === '2d'
                ? nodeRefId(target.target as any)
                : node3DRefId(target.target as any);
            if (!id) continue;
            if (id === a) fire(target, a, b);
            if (id === b) fire(target, b, a);
        }
    });
}
