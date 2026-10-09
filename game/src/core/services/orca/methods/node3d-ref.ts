import sceneManager from "../scene-manager";
import { ACTIVE_SKIN_NAME } from "../active-skin";

/**
 * Node3DRefValue is the editor-side reference to a node in a scene's `scene3d`
 * section (AGENTS.md rule 29). It is the 3D sibling of `NodeRefValue`
 * (./node-ref.ts) and resolves to the live three.js Object3D by node id.
 *
 * Authoring shape (FlowState JSON):
 *   { kind: 'node3dRef'; nodeId: string; sceneScope?: 'core'|'skin'; sceneSkin?: string; sceneName?: string }
 *
 * Per-skin shape, keyed by the REAL authoring skin name and collapsed through
 * `ACTIVE_SKIN_NAME` exactly like `nodeRefBySkin` (no entry ⇒ null ⇒ no-op):
 *   { kind: 'node3dRefBySkin'; bySkin: Record<string, Node3DRefValue> }
 *
 * The 3D tree is built asynchronously after a scene loads, and only while the
 * scene's camera background is `clear` and 3D is enabled for the project, so
 * mutating callers use `resolveNode3DDeferred`, which always answers exactly
 * once — with `null` when the node can never resolve — so a flow never hangs.
 *
 * SceneManager is read STRUCTURALLY (optional methods): this file can land in a
 * project before the scene-manager.ts that implements them, and then resolves
 * nothing instead of failing the build.
 */
export interface Node3DRefValue {
    kind: 'node3dRef';
    nodeId: string;
    sceneScope?: 'core' | 'skin';
    sceneSkin?: string;
    sceneName?: string;
}

export interface Node3DRefBySkinValue {
    kind: 'node3dRefBySkin';
    bySkin: Record<string, Node3DRefValue>;
}

export type Node3DRefLike = Node3DRefValue | Node3DRefBySkinValue | null | undefined;

type Scene3DState = 'disabled' | 'inactive' | 'building' | 'ready';

interface Scene3DHost {
    getScene3DState?(): Scene3DState;
    getObject3DById?(id: string): any | null;
    whenScene3DReady?(cb: (ready: boolean) => void): boolean;
    whenModel3DReady?(id: string, cb: (loaded: boolean) => void): boolean;
    getModel3DMixer?(id: string): any | null;
    getModel3DClips?(id: string): any[];
}

export function isNode3DRef(v: any): v is Node3DRefValue {
    return v != null && typeof v === 'object' && v.kind === 'node3dRef' && typeof v.nodeId === 'string' && v.nodeId !== '';
}

export function isNode3DRefBySkin(v: any): v is Node3DRefBySkinValue {
    return v != null && typeof v === 'object' && v.kind === 'node3dRefBySkin'
        && v.bySkin != null && typeof v.bySkin === 'object';
}

function selectActiveSkinRef(target: unknown): Node3DRefValue | null {
    const ref = isNode3DRefBySkin(target) ? target.bySkin[ACTIVE_SKIN_NAME] : target;
    return isNode3DRef(ref) ? ref : null;
}

function host(): Scene3DHost | null {
    const manager = sceneManager as unknown as Scene3DHost | undefined;
    return manager && typeof manager === 'object' ? manager : null;
}

function scene3DState(h: Scene3DHost | null): Scene3DState {
    try {
        return h?.getScene3DState ? h.getScene3DState() : 'inactive';
    } catch {
        return 'inactive';
    }
}

/** One-shot per node id, like node-ref.ts: flows repeat, the log should not. */
const warnedNodeIds = new Set<string>();

function warnUnresolved(ref: Node3DRefValue, reason: string): void {
    if (warnedNodeIds.has(ref.nodeId)) return;
    warnedNodeIds.add(ref.nodeId);
    const scene = typeof ref.sceneName === 'string' && ref.sceneName ? ref.sceneName : '(unknown scene)';
    console.warn(`[FlowState] 3D node not resolved: ${scene} / ${ref.nodeId} — ${reason}`);
}

function describe(state: Scene3DState): string {
    switch (state) {
        case 'disabled': return '3D is disabled for this project (Project Settings).';
        case 'inactive': return 'no 3D section is active (the loaded scene has no scene3d, or its camera background is not "clear").';
        case 'building': return 'the 3D section is still building.';
        default: return 'the node is not in the loaded scene\'s 3D section.';
    }
}

/** The collapsed node id, or null (per-skin ref with no active-skin entry, or not a node3dRef). */
export function node3DRefId(target: Node3DRefLike): string | null {
    return selectActiveSkinRef(target)?.nodeId ?? null;
}

/** The node's live Object3D right now, or null (warned once per id). */
export function resolveNode3D(target: Node3DRefLike): any | null {
    const ref = selectActiveSkinRef(target);
    if (!ref) return null;
    const h = host();
    let object: any = null;
    try {
        object = h?.getObject3DById ? h.getObject3DById(ref.nodeId) : null;
    } catch {
        object = null;
    }
    if (!object) warnUnresolved(ref, describe(scene3DState(h)));
    return object ?? null;
}

/**
 * Hand `callback` the node's Object3D once the 3D layer is built — immediately
 * when it already is. With `waitForModel`, additionally waits for a model3d's
 * glTF (and so its mixer). `callback` is called EXACTLY once; `null` means the
 * node cannot resolve (missing, 3D disabled, layer inactive, scene swapped,
 * load failed), and the caller must still complete.
 */
export function resolveNode3DDeferred(
    target: Node3DRefLike,
    callback: (object: any | null) => void,
    options: { waitForModel?: boolean } = {},
): 'resolved' | 'deferred' | 'not-found' {
    const ref = selectActiveSkinRef(target);
    if (!ref) {
        callback(null);
        return 'not-found';
    }
    const h = host();
    let settled = false;
    const finish = (object: any | null): void => {
        if (settled) return;
        settled = true;
        callback(object);
    };

    const onLayerReady = (ready: boolean): void => {
        try {
            resolveWhenReady(ready);
        } catch (err) {
            console.warn(`[FlowState] Resolving 3D node ${ref.nodeId} failed`, err);
            finish(null);
        }
    };

    const resolveWhenReady = (ready: boolean): void => {
        if (!ready) {
            warnUnresolved(ref, 'the 3D section was unloaded or failed to build before the node resolved.');
            finish(null);
            return;
        }
        const object = h?.getObject3DById ? h.getObject3DById(ref.nodeId) : null;
        if (!object) {
            warnUnresolved(ref, describe('ready'));
            finish(null);
            return;
        }
        if (!options.waitForModel) {
            finish(object);
            return;
        }
        const waiting = h?.whenModel3DReady
            ? h.whenModel3DReady(ref.nodeId, (loaded) => {
                if (!loaded) warnUnresolved(ref, 'the model failed to load, or the 3D section was unloaded first.');
                finish(loaded ? object : null);
            })
            : false;
        if (!waiting) {
            warnUnresolved(ref, 'the node is not a model3d.');
            finish(null);
        }
    };

    let queued = false;
    try {
        queued = h?.whenScene3DReady ? h.whenScene3DReady(onLayerReady) : false;
    } catch (err) {
        console.warn('[FlowState] Waiting for the 3D section failed', err);
        queued = false;
    }
    if (!queued) {
        warnUnresolved(ref, describe(scene3DState(h)));
        finish(null);
        return 'not-found';
    }
    return settled ? 'resolved' : 'deferred';
}

/** The model3d's three `AnimationMixer`, or null before its glTF loads. */
export function getModel3DMixer(id: string): any | null {
    const h = host();
    return h?.getModel3DMixer ? h.getModel3DMixer(id) ?? null : null;
}

/** The model3d's glTF clips; empty before load or when it has none. */
export function getModel3DClips(id: string): any[] {
    const h = host();
    const clips = h?.getModel3DClips ? h.getModel3DClips(id) : [];
    return Array.isArray(clips) ? clips : [];
}
