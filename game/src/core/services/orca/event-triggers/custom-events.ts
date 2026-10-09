import { eventEmitter } from "@game-studio/arcade-base";

/**
 * Event-name starter auto-registration (custom AND built-in).
 *
 * Two editor starter nodes carry a plain-string `eventName` property:
 *   - `onCustomEvent`  — a project-defined custom event name.
 *   - `onEventFire`    — a BUILT-IN event name (the same names the
 *                        Fire Event nodes send, e.g. `GAME_COMPLETE`).
 *
 * Both listen the same way, because `fireCustomEvent` and every built-in
 * fire-event method go through the SAME `eventEmitter`. At runtime we
 * walk every loaded graph's starters; whenever a starter title is one of
 * those two AND its `eventName` resolves to a non-empty string, we
 * register an `eventEmitter.on(eventName, …)` listener that invokes the
 * supplied `dispatch(graphId, nodeId, args?)` callback. This is the
 * inbound half of the event bridge — the outbound half is
 * `methods/fireEvent.ts` which `eventEmitter.emit`s the same names.
 *
 * Payload pass-through
 * --------------------
 * A project custom event may declare ordered `passProps`; the editor
 * grows the `fireCustomEvent` node one value INPUT pin per prop and the
 * `onCustomEvent` starter one value OUTPUT pin per prop.
 * `fireCustomEvent` zips those pins into a `Record<string, unknown>`
 * keyed by prop NAME and emits it as the event's single argument. This
 * binder forwards that object to `dispatch` as `args`, which the walker
 * seeds as `WalkContext.starterArgs` so the starter's output pins
 * resolve by name.
 *
 * The forward is guarded to PLAIN OBJECTS only. `onEventFire` shares
 * this binder, and BUILT-IN fire-events emit scalar arguments (e.g.
 * `GAME_JACKPOT_WIN` emits a `number`) — those must never be mistaken
 * for a starter-args bag, so anything non-object (or an array) forwards
 * `undefined` instead.
 *
 * The callback is provided by `flowstate.ts` (`runFlowsByStarterId`)
 * to avoid a circular import.
 *
 * Unlike pixi starters, these listeners do not depend on any live
 * DisplayObject, so a single bind sweep at init is sufficient; re-binds
 * (after loadScene/unloadScene) are still safe because every sweep
 * detaches previously-registered listeners first.
 */

const EVENT_STARTER_TITLES = new Set(['onCustomEvent', 'onEventFire']);

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
 * the next sweep, preventing duplicate `eventEmitter.on` handlers from
 * stacking across repeated binds. Keyed by `${graphId}:${nodeId}`.
 */
const attached = new Map<string, { eventName: string; handler: (payload?: unknown) => void }>();

export function detachAllCustomEventStarters(): void {
    for (const { eventName, handler } of attached.values()) {
        try { eventEmitter.off(eventName as any, handler); } catch { /* ignored */ }
    }
    attached.clear();
}

/**
 * Attach `eventEmitter` listeners for every `onCustomEvent` /
 * `onEventFire` starter in `graphs` whose `eventName` property is a
 * non-empty string.
 *
 * Idempotent — earlier bindings are detached first.
 */
export function bindCustomEventStarters(
    graphs: RegisteredGraphLite[],
    dispatch: (graphId: string, starterNodeId: string, args?: Record<string, unknown>) => void,
): void {
    detachAllCustomEventStarters();

    for (const graph of graphs) {
        for (const starter of graph.starterNodes) {
            if (!EVENT_STARTER_TITLES.has(starter.title)) continue;

            const nameProp = starter.properties?.find(p => p.name === 'eventName');
            const eventName = typeof nameProp?.value === 'string' ? nameProp.value.trim() : '';
            if (!eventName) continue;

            // Only a PLAIN OBJECT payload becomes starter args — built-in
            // fire-events (via the shared `onEventFire` starter) emit scalars.
            const handler = (payload?: unknown) => {
                const args =
                    payload && typeof payload === 'object' && !Array.isArray(payload)
                        ? (payload as Record<string, unknown>)
                        : undefined;
                dispatch(graph.id, starter.id, args);
            };
            eventEmitter.on(eventName as any, handler);

            const key = `${graph.id}:${starter.id}`;
            attached.set(key, { eventName, handler });
        }
    }
}
