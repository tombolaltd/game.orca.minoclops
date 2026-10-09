import { GRService } from "@game-studio/generic-reels";

/**
 * Default reel-service singleton used as a fallback by the FlowState
 * `reels` method module for the non-dispatched getter/setter helpers that
 * don't take a per-instance target. The dispatched node methods
 * (spinReels, setSpinSequence, stepSpinSequence, completeSpinSequence,
 * setReelSpinComplete, setOnScreenReels, useMainGameReels, useBonusReels)
 * resolve a per-instance `FlowstateInjectedReelService` attached to a
 * targeted Reels scene-node root and bypass this singleton entirely.
 *
 * Real games are encouraged to extend `GRService` with game-specific
 * configuration; the trim template just exposes the base service so the
 * FlowState method API resolves at compile time and runtime.
 *
 * CONSTRUCTION IS DEFERRED, AND THAT IS LOAD-BEARING. The Orca runtime under
 * `game/src` contains import cycles (flowstate -> methods/index ->
 * methods/generic-reels -> models/game-model -> ... -> flowstate, and this
 * module hangs off methods/generic-reels). A development build tolerates them,
 * but a PRODUCTION build scope-hoists and wraps modules in lazy
 * `__webpack_require__.cw` factories, which can run this module body before the
 * `@game-studio/generic-reels` namespace binding has been assigned. Touching
 * `GRService` at module scope — `class X extends GRService`, or a bare
 * `new GRService()` — then dies with `Cannot read properties of undefined`
 * before the game boots. Keep every reference to `GRService` inside a function.
 * A game replacing this singleton with its own subclass must do the same.
 */
export type ReelService = GRService;

let instance: GRService | null = null;

function reelService(): GRService {
    if (!instance) instance = new GRService();
    return instance;
}

export default new Proxy({} as unknown as GRService, {
    get(_target, prop) {
        const target = reelService() as unknown as Record<PropertyKey, unknown>;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, prop, value) {
        (reelService() as unknown as Record<PropertyKey, unknown>)[prop] = value;
        return true;
    },
});
