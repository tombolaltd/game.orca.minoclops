import { FlowstateApplicationEventTriggers } from "./application-events";

export const applicationEventTriggers = new FlowstateApplicationEventTriggers();

/**
 * Aggregated event-trigger registry. Pixi pointer-event starters are
 * auto-bound by `Flowstate.bindPixiStarters()` (no per-method object).
 */
export const flowstateEventTriggers = {
    application: applicationEventTriggers,
    pixi: {} as Record<string, never>
};
