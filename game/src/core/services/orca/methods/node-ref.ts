import sceneManager from "../scene-manager";
import { ACTIVE_SKIN_NAME } from "../active-skin";
import { captureFlowNodeContext, currentFlowNodeContext, describeFlowError, emitFlowConsole, withFlowNodeContext } from "./flow-console";

/**
 * NodeRefValue is the editor-side primitive representing a drag-and-drop
 * reference to a scene-graph node. The runtime uses it to look up the
 * live Pixi DisplayObject by UUID.
 *
 * Authoring shape (FlowState JSON):
 *   { kind: 'nodeRef'; nodeId: string; sceneScope?: 'core'|'skin'; sceneSkin?: string; sceneName?: string }
 *
 * Back-compat: legacy graphs may still use a bare `string` (e.g. spineName).
 * Method modules should accept the union type and call `resolveNode()`.
 */
export interface NodeRefValue {
    kind: 'nodeRef';
    nodeId: string;
    sceneScope?: 'core' | 'skin';
    sceneSkin?: string;
    sceneName?: string;
}

/**
 * NodeRefBySkinValue is a PER-SKIN reference: it carries a distinct
 * NodeRefValue for each skin, keyed by the REAL authoring skin name
 * (`main.orca.skins[i].name`, NOT the effective runtime folder). At
 * resolution time the runtime selects the entry for `ACTIVE_SKIN_NAME`, so
 * the SAME exported graph — including a CORE graph whose single runtime
 * JSON is shared across every skin — resolves to a DIFFERENT scene node
 * per skin.
 *
 * Authoring shape (FlowState JSON):
 *   { kind: 'nodeRefBySkin'; bySkin: Record<string, NodeRefValue> }
 *
 * A skin with no entry resolves to `null` (blank — the consumer node
 * no-ops), matching the editor's "blank when this skin has no entry" UX.
 */
export interface NodeRefBySkinValue {
    kind: 'nodeRefBySkin';
    bySkin: Record<string, NodeRefValue>;
}

export type NodeRefLike = NodeRefValue | NodeRefBySkinValue | string | null | undefined;

type ResolvedDisplayObjectWrapper = { __orcaResolvedDisplayObject?: unknown };

/**
 * True when `v` looks like a NodeRefValue object (kind === 'nodeRef').
 */
export function isNodeRef(v: any): v is NodeRefValue {
    return v != null && typeof v === 'object' && v.kind === 'nodeRef' && typeof v.nodeId === 'string';
}

/**
 * True when `v` looks like a NodeRefBySkinValue object
 * (kind === 'nodeRefBySkin' carrying a `bySkin` map).
 */
export function isNodeRefBySkin(v: any): v is NodeRefBySkinValue {
    return v != null && typeof v === 'object' && v.kind === 'nodeRefBySkin'
        && v.bySkin != null && typeof v.bySkin === 'object';
}

/**
 * Collapse a per-skin reference down to the concrete NodeRefValue for the
 * active skin (keyed by the REAL authoring skin name `ACTIVE_SKIN_NAME`).
 * Plain nodeRefs, legacy bare strings, and null/undefined pass through
 * unchanged. A per-skin ref with no entry for the active skin returns
 * `null` (blank) so the consumer node no-ops.
 */
function selectActiveSkinRef(target: NodeRefLike): NodeRefValue | string | null | undefined {
    if (isNodeRefBySkin(target)) {
        return target.bySkin[ACTIVE_SKIN_NAME] || null;
    }
    return target;
}

/**
 * Node ids already reported by `warnNodeNotInTree`. A flow that misses is
 * usually driven by a repeatable user action (a click, a spin), so the same
 * warning would otherwise repeat dozens of times per session and bury the
 * rest of the log. Same one-shot convention as the `scratchableItem`
 * component's wire / first-mask diagnostics.
 */
const warnedMissingNodeIds = new Set<string>();

/**
 * The scene SceneManager currently has loaded, or null when nothing is loaded
 * (or the manager predates the accessor / is mid-load). Never throws — this is
 * diagnostic-only and must not be able to turn a missed lookup into a crash.
 */
function loadedSceneRef(): { name: string; scope: 'core' | 'skin' } | null {
    try {
        const manager = sceneManager as unknown as {
            getCurrentScene?: () => { name?: unknown; origin?: unknown } | null;
        };
        const scene = manager.getCurrentScene ? manager.getCurrentScene() : null;
        if (!scene || typeof scene.name !== 'string' || !scene.name) return null;
        return { name: scene.name, scope: scene.origin === 'skin' ? 'skin' : 'core' };
    } catch {
        return null;
    }
}

/**
 * ONE-SHOT per node id. Reports BOTH halves of the answer — the scene the ref
 * was captured in AND the scene that is actually loaded — because the common
 * cause is a pinned entry scene (or a `loadScene` action) naming a different
 * scene from the one the author built, and a message that states only the
 * ref's own scene reads like a missing node rather than a wrong scene.
 */
function warnNodeNotInTree(ref: NodeRefValue): void {
    // One-shot per (flow node, scene node) so each referencing flow node gets its own link.
    const ctx = currentFlowNodeContext();
    const key = ctx ? `${ctx.graphId}\u0000${ctx.nodeId}\u0000${ref.nodeId}` : ref.nodeId;
    if (warnedMissingNodeIds.has(key)) return;
    warnedMissingNodeIds.add(key);

    const refScene = typeof ref.sceneName === 'string' ? ref.sceneName : '';
    const loaded = loadedSceneRef();
    const loadedLabel = loaded ? `${loaded.scope}:${loaded.name}` : '(no scene loaded)';
    const name = sceneNodeName(ref.nodeId);
    let message = `[FlowState] Scene node not in current tree: ${refScene || '(unknown scene)'} / ${name ? `"${name}"` : ref.nodeId}`
        + ` — currently loaded scene is ${loadedLabel}.`;

    const scopeDiffers = !!ref.sceneScope && !!loaded && ref.sceneScope !== loaded.scope;
    if (refScene && (!loaded || refScene !== loaded.name || scopeDiffers)) {
        message += ` That node belongs to "${refScene}", which is not the loaded scene`
            + ` — the skin's entry scene, or a loadScene action, may be pointing at the wrong scene.`;
    }

    emitFlowConsole('warn', message, { code: 'node-not-in-tree', ...sceneNodeExtra(ref, false) });
}

/** Authored name of a built scene node, or undefined — never throws. */
function sceneNodeName(nodeId: string): string | undefined {
    try {
        const manager = sceneManager as unknown as { getNodeDataById?: (id: string) => { name?: unknown } | undefined };
        const name = manager.getNodeDataById ? manager.getNodeDataById(nodeId)?.name : undefined;
        return typeof name === 'string' && name ? name : undefined;
    } catch {
        return undefined;
    }
}

/** `Scene node "Name"`, or `Scene node <id>` when the name is unknown. */
function sceneNodeLabel(nodeId: string): string {
    const name = sceneNodeName(nodeId);
    return name ? `Scene node "${name}"` : `Scene node ${nodeId}`;
}

/** Structured scene-node reference for the console payload. */
function sceneNodeExtra(ref: NodeRefValue, fallBackToLoaded: boolean): {
    sceneNodeId: string;
    sceneNodeName?: string;
    sceneName?: string;
    sceneScope?: 'core' | 'skin';
} {
    const loaded = fallBackToLoaded ? loadedSceneRef() : null;
    const sceneName = typeof ref.sceneName === 'string' && ref.sceneName ? ref.sceneName : loaded?.name;
    const sceneScope = ref.sceneScope === 'core' || ref.sceneScope === 'skin' ? ref.sceneScope : loaded?.scope;
    return {
        sceneNodeId: ref.nodeId,
        sceneNodeName: sceneNodeName(ref.nodeId),
        sceneName,
        sceneScope,
    };
}

/** The authored scene-node name for a reference, else its id — for messages only. */
export function describeNodeRef(target: NodeRefLike): string {
    const id = nodeRefId(target);
    if (!id) return '(no target)';
    try {
        const manager = sceneManager as unknown as { getNodeDataById?: (nodeId: string) => { name?: unknown } | undefined };
        const name = manager.getNodeDataById ? manager.getNodeDataById(id)?.name : undefined;
        return typeof name === 'string' && name ? name : id;
    } catch {
        return id;
    }
}

/**
 * Resolve a NodeRef (or legacy bare-string) to its live DisplayObject.
 * Returns `null` if the reference is invalid, the node hasn't been
 * built (e.g. its scene is not loaded), or the cast fails.
 *
 * The optional `Constructor` lets callers narrow the return type and
 * skip nodes whose live DisplayObject isn't of the expected kind.
 *
 * Usage:
 *   const spine = resolveNode<Spine>(target, Spine);
 *   if (!spine) return;
 */
export function resolveNode<T = any>(target: NodeRefLike, Ctor?: abstract new (...args: any[]) => T): T | null {
    // A per-skin reference collapses to its active-skin entry first; a skin
    // with no entry yields `null` here → the consumer node no-ops (blank).
    const ref = selectActiveSkinRef(target);
    if (!ref) return null;

    if (isNodeRef(ref)) {
        const obj = sceneManager.getDisplayObjectById(ref.nodeId);
        if (!obj) {
            warnNodeNotInTree(ref);
            return null;
        }
        const resolvedObj = Ctor && !(obj instanceof Ctor)
            ? (obj as ResolvedDisplayObjectWrapper).__orcaResolvedDisplayObject
            : obj;

        if (!resolvedObj) {
            emitFlowConsole('warn', `[FlowState] ${sceneNodeLabel(ref.nodeId)} has no resolved ${Ctor?.name ?? 'DisplayObject'} target`, { code: 'node-unresolved', ...sceneNodeExtra(ref, true) });
            return null;
        }

        if (Ctor && !(resolvedObj instanceof Ctor)) {
            emitFlowConsole('warn', `[FlowState] ${sceneNodeLabel(ref.nodeId)} is not a ${Ctor.name}`, { code: 'node-wrong-type', ...sceneNodeExtra(ref, true) });
            return null;
        }
        return resolvedObj as unknown as T;
    }

    // Legacy string fallback — caller is responsible for handling.
    return null;
}

/**
 * Like `resolveNode`, but handles the async spine-loading case where the
 * node's display object is a wrapper Container that hasn't yet resolved to
 * the real Spine. If the wrapper has a pending callback queue, the callback
 * is deferred until the async load completes.
 *
 * Returns:
 *   'resolved'  — callback was called immediately
 *   'deferred'  — callback queued for when the async load finishes
 *   'not-found' — target missing or wrong type with no pending queue
 */
export function resolveNodeDeferred<T = any>(
    target: NodeRefLike,
    Ctor: abstract new (...args: any[]) => T,
    callback: (obj: T) => void,
): 'resolved' | 'deferred' | 'not-found' {
    // Collapse a per-skin reference to its active-skin entry first.
    const ref = selectActiveSkinRef(target);
    if (!ref || !isNodeRef(ref)) return 'not-found';

    const obj = sceneManager.getDisplayObjectById(ref.nodeId);
    if (!obj) {
        warnNodeNotInTree(ref);
        return 'not-found';
    }

    if (obj instanceof Ctor) {
        callback(obj as unknown as T);
        return 'resolved';
    }

    const wrapper = obj as ResolvedDisplayObjectWrapper & { __orcaPendingCallbacks?: Array<(o: unknown) => void> };

    if (wrapper.__orcaResolvedDisplayObject instanceof Ctor) {
        callback(wrapper.__orcaResolvedDisplayObject as unknown as T);
        return 'resolved';
    }

    if (Array.isArray(wrapper.__orcaPendingCallbacks)) {
        // The flow node has moved on by the time this runs, so carry its
        // context, and never let one callback break the rest of the queue.
        const ctx = captureFlowNodeContext();
        wrapper.__orcaPendingCallbacks.push((loaded) => {
            withFlowNodeContext(ctx, () => {
                if (!(loaded instanceof Ctor)) {
                    emitFlowConsole('warn', `[FlowState] ${sceneNodeLabel(ref.nodeId)} is not a ${Ctor.name}`, { code: 'node-wrong-type', ...sceneNodeExtra(ref, true) });
                    return;
                }
                try {
                    callback(loaded as unknown as T);
                } catch (err) {
                    const title = ctx?.nodeTitle ? `${ctx.nodeTitle}: ` : '';
                    emitFlowConsole('error', `[FlowState] ${title}${describeFlowError(err)}`, { code: 'node-error' });
                }
            });
        });
        return 'deferred';
    }

    emitFlowConsole('warn', `[FlowState] ${sceneNodeLabel(ref.nodeId)} is not a ${Ctor.name}`, { code: 'node-wrong-type', ...sceneNodeExtra(ref, true) });
    return 'not-found';
}

/**
 * Variant that returns the unwrapped node ID string from either form.
 * Useful for caches keyed by node ID across both old and new graphs.
 */
export function nodeRefId(target: NodeRefLike): string | null {
    const ref = selectActiveSkinRef(target);
    if (!ref) return null;
    if (isNodeRef(ref)) return ref.nodeId;
    return typeof ref === 'string' ? ref : null;
}
