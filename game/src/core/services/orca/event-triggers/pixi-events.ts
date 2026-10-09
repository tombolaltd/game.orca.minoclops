import sceneManager from "../scene-manager";
import { nodeRefId, type NodeRefLike } from "../methods/node-ref";

/**
 * Pixi pointer-event starter auto-registration.
 *
 * The editor's `Action / pixi` starter nodes carry a `target: nodeRef`
 * property. At runtime, after every scene load (or on initial init),
 * we walk every loaded graph's starters; whenever a starter title
 * matches a known pointer event AND its `target` resolves to a live
 * DisplayObject, we attach a listener that invokes the supplied
 * `dispatch(graphId, nodeId)` callback. A per-skin `nodeRefBySkin` target
 * collapses to the booting skin's entry via `nodeRefId` (none → unbound).
 *
 * The callback is provided by `flowstate.ts` (`runFlowsByStarterId`)
 * to avoid a circular import.
 */

const PIXI_EVENT_MAP: Record<string, string> = {
    onPointerDown: 'pointerdown',
    onPointerUp: 'pointerup',
    onPointerUpOutside: 'pointerupoutside',
    onPointerMove: 'pointermove',
    onPointerOver: 'pointerover',
    onPointerOut: 'pointerout',
    onPointerEnter: 'pointerenter',
    onPointerLeave: 'pointerleave',
    onPointerCancel: 'pointercancel',
    onPointerTap: 'pointertap',
    onGlobalPointerMove: 'globalpointermove',
};

interface MinimalStarter {
    id: string;
    title: string;
    properties?: Array<{ name: string; value?: any }>;
}

interface RegisteredGraphLite {
    id: string;
    starterNodes: MinimalStarter[];
}

/**
 * Bookkeeping: track listeners we've attached so we can detach them on
 * the next sweep (e.g. after `unloadScene` rebuilds the tree). Keyed
 * by `${graphId}:${nodeId}`.
 */
const attached = new Map<string, () => void>();

export function detachAllPixiStarters(): void {
    for (const detach of attached.values()) {
        try { detach(); } catch { /* ignored */ }
    }
    attached.clear();
}

/**
 * Attach pointer listeners for every pixi starter in `graphs` whose
 * `target` resolves to a live DisplayObject.
 *
 * Idempotent — earlier bindings are detached first.
 */
export function bindPixiStarters(
    graphs: RegisteredGraphLite[],
    dispatch: (graphId: string, starterNodeId: string) => void,
): void {
    detachAllPixiStarters();

    for (const graph of graphs) {
        for (const starter of graph.starterNodes) {
            const eventName = PIXI_EVENT_MAP[starter.title];
            if (!eventName) continue;

            const targetProp = starter.properties?.find(p => p.name === 'target');
            const nodeId = nodeRefId(targetProp?.value as NodeRefLike);
            if (!nodeId) continue;

            const displayObject = sceneManager.getDisplayObjectById(nodeId);
            if (!displayObject) continue;

            // Pixi 8 drives interactivity entirely off `eventMode` —
            // `interactive` is gone. Safe to set on every node; it's a no-op if
            // already 'static'. Gated behind the per-starter `setInteractive`
            // flag (default true when absent) so authors can attach a handler
            // without forcing interactivity.
            const interactiveProp = starter.properties?.find(p => p.name === 'setInteractive');
            const setInteractive = interactiveProp?.value !== false;
            if (setInteractive) {
                displayObject.eventMode = 'static';
            }

            const handler = () => dispatch(graph.id, starter.id);
            displayObject.on(eventName as any, handler);

            const key = `${graph.id}:${starter.id}`;
            attached.set(key, () => {
                try { displayObject.off(eventName as any, handler); } catch { /* ignored */ }
            });
        }
    }
}
