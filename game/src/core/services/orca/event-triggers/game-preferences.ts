import { eventEmitter } from "@game-studio/arcade-base";
import {
    ORCA_GAME_PREFERENCE_CHANGED,
    toGamePreferenceChecked,
    toGamePreferenceNumber,
} from "../game-preferences";

/**
 * `onGamePreferenceChanged` starter auto-registration.
 *
 * `game-preferences.ts` re-emits every settings-menu click of an Orca custom
 * game preference as `ORCA_GAME_PREFERENCE_CHANGED` with `{ key, value }`. This
 * binder attaches ONE listener for that event and dispatches every starter
 * whose `preference` property is '' (any preference) or equals `key`, with
 * starter args `{ key, checked, value }` read through `WalkContext.starterArgs`.
 *
 * Modelled on `custom-events.ts`: idempotent, detaches before every sweep.
 */

export const GAME_PREFERENCE_STARTER_TITLE = 'onGamePreferenceChanged';

interface MinimalStarter {
    id: string;
    title: string;
    properties?: Array<{ name: string; value?: any }>;
}

interface RegisteredGraphLite {
    id: string;
    starterNodes: MinimalStarter[];
}

let attachedHandler: ((payload?: unknown) => void) | null = null;

export function detachAllGamePreferenceStarters(): void {
    if (!attachedHandler) return;
    try { eventEmitter.off(ORCA_GAME_PREFERENCE_CHANGED as any, attachedHandler); } catch { /* ignored */ }
    attachedHandler = null;
}

export function bindGamePreferenceStarters(
    graphs: RegisteredGraphLite[],
    dispatch: (graphId: string, starterNodeId: string, args?: Record<string, unknown>) => void,
): void {
    detachAllGamePreferenceStarters();

    const targets: Array<{ graphId: string; nodeId: string; preference: string }> = [];
    for (const graph of graphs) {
        for (const starter of graph.starterNodes) {
            if (starter.title !== GAME_PREFERENCE_STARTER_TITLE) continue;
            const prop = starter.properties?.find(p => p.name === 'preference');
            const preference = typeof prop?.value === 'string' ? prop.value.trim() : '';
            targets.push({ graphId: graph.id, nodeId: starter.id, preference });
        }
    }
    if (targets.length === 0) return;

    const handler = (payload?: unknown) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        const key = (payload as { key?: unknown }).key;
        if (typeof key !== 'string' || !key) return;
        const raw = (payload as { value?: unknown }).value;
        const checked = toGamePreferenceChecked(raw);
        const value = toGamePreferenceNumber(raw) ?? 0;
        for (const target of targets) {
            if (target.preference && target.preference !== key) continue;
            dispatch(target.graphId, target.nodeId, { key, checked, value });
        }
    };
    eventEmitter.on(ORCA_GAME_PREFERENCE_CHANGED as any, handler);
    attachedHandler = handler;
}
