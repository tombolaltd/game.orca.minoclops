import { enterJackpotsRuntime } from '../../jackpots/jackpots-runtime';

/**
 * Jackpots Methods for FlowState
 *
 * A single ACTION — `enterJackpot` — that plays the jackpot round the game
 * won, if it has not played yet. `endCabinetGame` already plays it before the
 * cabinet ends the game, so most graphs never need this node; use it to play
 * the round at another point (it plays once either way).
 *
 * The round dispatches the `onEnterJackpot` fan-out starter as it starts —
 * not before, and not when there is nothing to play. It is a no-op for a
 * non-jackpot skin, before jackpots initialise, and when no jackpot was won.
 *
 * This module imports ONLY the host glue (`enterJackpotsRuntime`) — NEVER
 * `@game-studio/jackpots` directly — so it does NOT pull the package into the
 * main (non-jackpot) bundle: the glue keeps the package behind its gated
 * dynamic import.
 */
class JackpotsMethods {
    /**
     * Play the jackpot round the game won, if it has not played yet; resolves
     * once the game is back.
     */
    public async enterJackpot(): Promise<void> {
        await enterJackpotsRuntime();
    }
}

export const jackpots = new JackpotsMethods();
