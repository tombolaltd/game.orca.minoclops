import { container, gameConfig, queryStringParams, userModel } from "@game-studio/arcade-base";
import { gameModel } from "@/src/core/models/game-model";

/**
 * Continue-request Methods for FlowState
 *
 * Fires the arcade-base game-server "continue" request from a graph node.
 *
 * Why the payload is author-defined
 * ---------------------------------
 * The continue payload key names differ per game (`BonusSpins` vs `BonusSpin`
 * vs `BonusRound`, plus arbitrary game-specific extras), so the KEY NAMES are
 * authored in the editor rather than hard-coded here. The editor exports the
 * node's `properties[]` in this exact order:
 *
 *   [0] { name: 'propertyNames', type: 'TArray', value: ['GameId', 'BonusSpins'] }
 *   [1] { name: 'part0',         type: 'T',      value: 12345 }
 *   [2] { name: 'part1',         type: 'T',      value: 3 }
 *   ...
 *
 * `Flowstate.executeNode` resolves `properties[]` STRICTLY POSITIONALLY and
 * spreads them into the method (`await method(...params)`) — property NAMES
 * never reach the method — hence the leading `propertyNames` array plus a rest
 * parameter of values, zipped back together BY INDEX below.
 *
 * Response handling mirrors the real arcade-base call site
 * (`views/bonus-cabinet.ts continueRequest()` in the reference game):
 * `gameModel.setData(response)` then `userModel.setData(response.PlayerData,
 * response.RequestType)`. `GameModel.setData` already routes
 * `RequestType === 'Continue'` into `flowstateSetContinueData`, the
 * Data-Browser-generated mappings region — so authors read the resulting
 * fields back with `getGameModelProperty` nodes.
 */

/**
 * The body posted to the game server. Keys are author-defined at graph-edit
 * time, so this is intentionally an open record rather than a fixed interface.
 */
type ContinueRequestPayload = Record<string, unknown>;

/**
 * Narrow structural view of the OPTIONAL arcade-base `container.gameServer`
 * inject.
 *
 * arcade-base types `continueRequest`'s parameter against a fixed per-game
 * payload interface (the reference game's `IContinueAdditonalData` has
 * REQUIRED `BonusSpins` / `GameId` members). A FlowState payload's key set is
 * only known at graph-edit time, so it can never statically satisfy such an
 * interface. Going through this local view keeps OUR call site typed while
 * staying tolerant of whatever concrete signature the installed arcade-base
 * version declares — preferable to a blanket `@ts-ignore`.
 */
interface IContinueCapableGameServer {
    continueRequest(payload: ContinueRequestPayload): Promise<any>;
}

/**
 * Coerce the exported `propertyNames` property into a `string[]`.
 *
 * Normally a real array (the editor bakes array literals as REAL arrays on
 * export), but a JSON string, a comma-separated string, and null/undefined are
 * all tolerated so a hand-edited or legacy graph degrades gracefully rather
 * than throwing mid-walk.
 */
function normalisePropertyNames(propertyNames: unknown): string[] {
    if (Array.isArray(propertyNames)) {
        return propertyNames.map((name) => (name === null || name === undefined ? "" : String(name).trim()));
    }
    if (typeof propertyNames === "string") {
        const raw = propertyNames.trim();
        if (!raw) return [];
        if (raw.charAt(0) === "[") {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return parsed.map((name) => (name === null || name === undefined ? "" : String(name).trim()));
                }
            } catch { /* not JSON — fall through to the comma-separated form */ }
        }
        return raw.split(",").map((name) => name.trim());
    }
    return [];
}

class ContinueMethods {
    /**
     * Send a "continue" request to the game server with an author-defined payload.
     *
     * @param propertyNames - Ordered payload KEY names (exported as a `TArray`).
     * @param values - The matching payload values; `values[i]` pairs with
     *                 `propertyNames[i]` BY INDEX.
     *
     * Pairs with a blank/whitespace name are skipped, as are `undefined` values
     * (an unlinked or unset pin). An EMPTY STRING value is kept — it may be
     * intentional. Later duplicate keys overwrite earlier ones.
     *
     * Never throws: an unconfigured `container.gameServer` warns and no-ops
     * (matching `methods/audio.ts`'s convention for unconfigured resources) and
     * a rejected request is logged and swallowed.
     */
    public async sendContinueRequest(propertyNames: unknown, ...values: unknown[]): Promise<void> {
        const names = normalisePropertyNames(propertyNames);

        const payload: ContinueRequestPayload = {};
        for (let i = 0; i < names.length; i++) {
            const key = names[i];
            if (!key) continue;
            const value = values[i];
            if (value === undefined) continue;
            payload[key] = value;
        }

        // Mirrors the real game call site: some engines require the skin to be
        // echoed back on every request. An explicitly authored `Skin` key wins.
        if (gameConfig.features.engineRequiresSkinParam && !("Skin" in payload)) {
            payload.Skin = queryStringParams.currentSkin;
        }

        const gameServer = (container as unknown as { gameServer?: IContinueCapableGameServer }).gameServer;
        if (!gameServer || typeof gameServer.continueRequest !== "function") {
            console.warn("[FlowState] sendContinueRequest: container.gameServer is not configured — no-op", payload);
            return;
        }

        try {
            const response = await gameServer.continueRequest(payload);
            if (!response) {
                console.warn("[FlowState] sendContinueRequest: server returned an empty response — models not updated");
                return;
            }
            gameModel.setData(response);
            if (response.PlayerData) {
                userModel.setData(response.PlayerData, response.RequestType);
            }
        } catch (err) {
            console.error("[FlowState] sendContinueRequest failed", err);
        }
    }
}

export const continueRequest = new ContinueMethods();
