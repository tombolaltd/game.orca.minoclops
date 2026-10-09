/**
 * Jackpot starter auto-binding — the inbound half of the FlowState ⇄
 * `@game-studio/jackpots` bridge.
 *
 * Three host-fired fan-out starters react to the package's
 * `JackpotRound.events` lifecycle. Unlike pixi / custom-event starters these
 * are NOT bound from `Flowstate.init()`: the `JackpotRound.events` emitter only
 * exists AFTER the GATED dynamic `import('@game-studio/jackpots')` inside
 * `initJackpotsRuntime` (jackpots-runtime.ts) succeeds — so a non-jackpot skin
 * (which never imports the package) never binds these and never references the
 * emitter.
 *
 *   ON_JACKPOT_ROUND_READY              → 'onJackpotRoundReady'
 *       (enter transition finished / reels round ready)
 *   ON_JACKPOT_EXIT_TRANSITION_COMPLETE → 'onJackpotEnd'
 *       (the LAST event — its package listener re-shows the cabinet = base
 *        game resumed)
 *   GAME_JACKPOT_WIN(value)             → 'onJackpotWin'
 *       (numeric win value → exposed as the `value` starter-value output pin)
 *
 * `dispatch` is supplied by the host (`application.ts`) as
 * `(type, args) => Flowstate.runFlowsByStarterType(type, args)`, so this helper
 * neither imports `Flowstate` (no module cycle) nor the package (the `events`
 * emitter is passed in, typed structurally so the file COMPILES when the
 * package is uninstalled for a clean-disabled / non-jackpot project).
 *
 * Idempotent — earlier bindings are detached first (mirrors
 * `bindCustomEventStarters`), so a re-init (e.g. editor hot-reload) can't stack
 * duplicate listeners on the package's STATIC `JackpotRound.events` singleton.
 */

/** Dispatch a fan-out starter by title, optionally seeding starter-value args. */
export type JackpotStarterDispatch = (
    starterType: string,
    args?: Record<string, unknown>,
) => void;

/**
 * Minimal structural view of `JackpotRound.events` (an eventemitter3 instance).
 * Kept LOCAL — never imported from `@game-studio/jackpots` — so this file
 * compiles without the package installed (the IS_JACKPOT gate keeps it from
 * ever running in that state).
 */
interface JackpotEventsLike {
    on(event: string, fn: (...args: any[]) => void): unknown;
    off(event: string, fn: (...args: any[]) => void): unknown;
}

/**
 * Map of package event name → (FlowState starter title, optional arg builder).
 * The event names mirror `IJackpotRoundEvents` in the reference package
 * (`rounds/jackpot-round.ts`). `ON_JACKPOT_ENTER_SWAP` is declared there but
 * NEVER emitted, so it is intentionally absent.
 */
const STARTER_BINDINGS: ReadonlyArray<{
    event: string;
    starter: string;
    buildArgs?: (...payload: any[]) => Record<string, unknown> | undefined;
}> = [
    { event: 'ON_JACKPOT_ROUND_READY', starter: 'onJackpotRoundReady' },
    { event: 'ON_JACKPOT_EXIT_TRANSITION_COMPLETE', starter: 'onJackpotEnd' },
    {
        event: 'GAME_JACKPOT_WIN',
        starter: 'onJackpotWin',
        // The package emits the numeric win value; expose it as the `value`
        // starter-value output pin (read via WalkContext.starterArgs).
        buildArgs: (value: number) => ({ value }),
    },
];

/** Bookkeeping so a re-bind detaches prior listeners first. */
let boundEvents: JackpotEventsLike | null = null;
const attached: Array<{ event: string; handler: (...args: any[]) => void }> = [];

export function detachJackpotStarters(): void {
    if (boundEvents) {
        for (const { event, handler } of attached) {
            try { boundEvents.off(event, handler); } catch { /* ignored */ }
        }
    }
    attached.length = 0;
    boundEvents = null;
}

/**
 * Subscribe the three jackpot fan-out starters to `events`, dispatching each to
 * its FlowState starter title via `dispatch`. Idempotent (detaches first).
 */
export function bindJackpotStarters(
    events: JackpotEventsLike,
    dispatch: JackpotStarterDispatch,
): void {
    detachJackpotStarters();
    boundEvents = events;

    for (const { event, starter, buildArgs } of STARTER_BINDINGS) {
        const handler = (...payload: any[]) => {
            dispatch(starter, buildArgs ? buildArgs(...payload) : undefined);
        };
        try {
            events.on(event, handler);
            attached.push({ event, handler });
        } catch {
            // A malformed emitter degrades to "no jackpot starters" — never crash.
        }
    }
}
