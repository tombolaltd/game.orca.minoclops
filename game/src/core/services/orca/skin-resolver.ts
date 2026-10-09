// HAND-MAINTAINED — this file is NOT auto-generated (unlike its importer
// `active-skin.ts`). Keep it dependency-light and side-effect free.
import { queryStringParams } from '@game-studio/arcade-base';

/**
 * Pick the runtime skin folder for THIS boot.
 *
 * A production bundle now carries EVERY skin (see `SKIN_TABLE` in the
 * generated `active-skin.ts`); the shell decides which one runs by launching
 * the game with `?skin=<gameId>`, which arcade-base parses into
 * `queryStringParams.currentSkin`.
 *
 * `queryStringParams` is a module-level const populated at module-eval time —
 * strictly before `main.ts`, `game.initialise()`, `Flowstate.init()` and
 * `sceneManager.buildScenes()` — so reading it at module scope here is safe
 * and needs no async plumbing.
 *
 * The read is wrapped in try/catch because the arcade-base module throws at
 * import time when `?skin=` is absent; falling back keeps a non-shell host
 * (plain `index.html`, a test harness) bootable.
 *
 * @param table   The generated skin table, keyed by effective skin folder.
 * @param fallback The default skin folder to use when the query string names
 *                 no known skin.
 */
export function resolveSkinFolder(table: Record<string, unknown>, fallback: string): string {
    try {
        const requested = queryStringParams.currentSkin;
        if (typeof requested === 'string' && requested
            && Object.prototype.hasOwnProperty.call(table, requested)) {
            return requested;
        }
    } catch (err) {
        // arcade-base throws when the host supplied no `?skin=` — fall back.
    }
    return fallback;
}
