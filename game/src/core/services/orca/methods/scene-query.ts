import sceneManager from "../scene-manager";
import { nodeRefId, type NodeRefLike, type NodeRefValue } from "./node-ref";

/**
 * Scene-graph lookups that turn one node reference into ANOTHER — a named
 * child, the Nth child, a child count — so a flow can address a whole family
 * of look-alike nodes (a grid of cells, a row of meter pips, a list of pop-up
 * variants) from ONE authored reference instead of wiring every node by hand.
 *
 * Every lookup walks the AUTHORED scene data (`sceneManager.getNodeDataById`),
 * not the Pixi display list, so the answer is independent of the runtime
 * wrappers, masks and slot containers the scene manager inserts, and matches
 * what the author sees in the Hierarchy panel. The results are ordinary
 * `nodeRef` values, accepted by every node that takes a scene-node `target`.
 *
 * Missing / unresolvable input degrades to `null` (every consumer node no-ops
 * on a null target) with a one-shot console warning — a flow never throws.
 */

type AuthoredNode = { id: string; name?: string; children?: AuthoredNode[] };

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(message);
}

function authoredNode(target: NodeRefLike): AuthoredNode | null {
    const id = nodeRefId(target);
    if (!id) return null;
    const node = sceneManager.getNodeDataById(id) as AuthoredNode | undefined;
    return node ?? null;
}

function childrenOf(node: AuthoredNode): AuthoredNode[] {
    return Array.isArray(node.children) ? node.children.filter((child) => child && typeof child.id === "string") : [];
}

function toRef(node: AuthoredNode, like: NodeRefLike): NodeRefValue {
    // Carry the parent reference's scene context so the missing-node warning can
    // still name the scene it expected.
    const base = like && typeof like === "object" && (like as NodeRefValue).kind === "nodeRef" ? (like as NodeRefValue) : undefined;
    return {
        kind: "nodeRef",
        nodeId: node.id,
        ...(base?.sceneScope ? { sceneScope: base.sceneScope } : {}),
        ...(base?.sceneSkin ? { sceneSkin: base.sceneSkin } : {}),
        ...(base?.sceneName ? { sceneName: base.sceneName } : {}),
    };
}

/** Direct child by exact name, else the first descendant (breadth-first) with that name. */
function findByName(parent: AuthoredNode, name: string): AuthoredNode | null {
    const direct = childrenOf(parent).find((child) => child.name === name);
    if (direct) return direct;
    const queue = [...childrenOf(parent)];
    while (queue.length > 0) {
        const next = queue.shift() as AuthoredNode;
        for (const child of childrenOf(next)) {
            if (child.name === name) return child;
            queue.push(child);
        }
    }
    return null;
}

class SceneQueryMethods {
    /**
     * The child of `parent` named `path`. A `/`-separated path walks one level
     * per segment (`Cell_2_3/CashValue`); each segment matches a DIRECT child
     * first and otherwise the nearest descendant of that name.
     */
    public findChildNode(parent: NodeRefLike, path: string): NodeRefValue | null {
        const root = authoredNode(parent);
        if (!root) {
            warnOnce(`find:${String(nodeRefId(parent))}`, "[FlowState] findChildNode: the parent node is not in the loaded scene");
            return null;
        }
        const segments = String(path ?? "").split("/").map((s) => s.trim()).filter((s) => s !== "");
        if (segments.length === 0) return toRef(root, parent);
        let current: AuthoredNode | null = root;
        for (const segment of segments) {
            current = current ? findByName(current, segment) : null;
            if (!current) {
                warnOnce(`find:${root.id}:${path}`, `[FlowState] findChildNode: no child "${path}" under "${root.name ?? root.id}"`);
                return null;
            }
        }
        return toRef(current as AuthoredNode, parent);
    }

    /** The `index`-th direct child of `parent` in Hierarchy order; a negative index counts from the end. */
    public getChildNode(parent: NodeRefLike, index: number): NodeRefValue | null {
        const root = authoredNode(parent);
        if (!root) return null;
        const children = childrenOf(root);
        const i = Math.trunc(Number(index));
        if (!Number.isFinite(i)) return null;
        const child = children[i < 0 ? children.length + i : i];
        if (!child) {
            warnOnce(`child:${root.id}:${i}`, `[FlowState] getChildNode: "${root.name ?? root.id}" has no child ${i} (it has ${children.length})`);
            return null;
        }
        return toRef(child, parent);
    }

    /** How many direct children `parent` has (0 when it is missing). */
    public getChildCount(parent: NodeRefLike): number {
        const root = authoredNode(parent);
        return root ? childrenOf(root).length : 0;
    }
}

export const sceneQuery = new SceneQueryMethods();
