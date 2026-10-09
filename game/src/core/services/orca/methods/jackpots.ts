import { enterJackpotsRuntime } from '../../jackpots/jackpots-runtime';
import { Flowstate } from '../flowstate';

/**
 * Jackpots Methods for FlowState
 *
 * A single ACTION — `enterJackpot` — that an author drops to ENTER the (gated)
 * jackpot round. It is the author-driven counterpart to the host's
 * `application.enterJackpot()`.
 *
 * Firing it:
 *   1. dispatches the `onEnterJackpot` fan-out starter, so any flows the author
 *      wired to "on enter jackpot" run — without this the starter would be dead;
 *   2. calls the gated `enterJackpotsRuntime()` host glue, which is a no-op for
 *      a non-jackpot skin, when jackpots never initialised, or when the player
 *      has no active jackpot (`jackpotGameModel.hasJackpot`). Offline in the
 *      editor (no live server) the `hasJackpot` gate makes it a safe no-op —
 *      that is expected/safe.
 *
 * This module imports ONLY the host glue (`enterJackpotsRuntime`) — NEVER
 * `@game-studio/jackpots` directly — so it does NOT pull the package into the
 * main (non-jackpot) bundle: the glue keeps the package behind its gated
 * dynamic import. (`Flowstate` is imported at call-time only, exactly like
 * `methods/scene.ts`, so the methods↔flowstate cycle stays benign.)
 */
class JackpotsMethods {
    /**
     * Enter the jackpot round. Fires `onEnterJackpot` first (so author flows
     * react regardless of whether the gated runtime actually enters), then
     * enters the gated runtime (no-op when not applicable).
     */
    public async enterJackpot(): Promise<void> {
        void Flowstate.runFlowsByStarterType('onEnterJackpot');
        await enterJackpotsRuntime();
    }
}

export const jackpots = new JackpotsMethods();
