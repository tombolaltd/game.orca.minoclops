import type * as PIXI from "pixi.js";
import type { FlowstateReelsWinlinePlayer } from "../components/reels";
import { resolveNode, type NodeRefLike } from "./node-ref";

/**
 * Per-instance Reels winline methods for FlowState.
 *
 * These methods target a specific Reels scene-graph node (resolved via
 * `nodeRef`) rather than the global `reelService`. The Reels component
 * (`components/reels.ts → buildFlowstateReelsDisplay`) attaches a
 * `FlowstateReelsWinlinePlayer` instance onto the reels root container as
 * `_flowstateReelsWinlinePlayer`. This methods file resolves the target,
 * pulls the player, parses the JSON-stringified `lines` payload, and
 * dispatches.
 *
 * Style + behaviour fields (`winningSymbolBehavior`,
 * `nonWinningSymbolBehavior`, `winlineColor`, `winlineThickness`,
 * `winlineAlpha`, `winlineLeadLength`) live on the Reels scene node and
 * were captured by the player at construction time.
 */

type ReelsRootLike = PIXI.Container & {
    _flowstateReelsWinlinePlayer?: FlowstateReelsWinlinePlayer;
};

function getPlayer(target: NodeRefLike): FlowstateReelsWinlinePlayer | null {
    // The reels root is a plain PIXI.Container, so no Ctor is passed —
    // `resolveNode` returns the raw DisplayObject.
    const obj = resolveNode<ReelsRootLike>(target);
    if (!obj) return null;
    const player = (obj as ReelsRootLike)._flowstateReelsWinlinePlayer;
    if (!player) {
        console.warn(`[FlowState/reels] target node is not a Reels container (missing _flowstateReelsWinlinePlayer)`);
        return null;
    }
    return player;
}

class ReelsWinlineMethods {
    public playWinline(target: NodeRefLike, lines: unknown): void {
        const player = getPlayer(target);
        if (!player) return;

        let parsed: unknown = lines;
        if (!Array.isArray(lines)) {
            try {
                parsed = JSON.parse(String(lines ?? '').trim());
            } catch (err) {
                console.warn('[FlowState/reels] playWinline: lines is not valid JSON', err);
                return;
            }
        }
        if (!Array.isArray(parsed)) {
            console.warn('[FlowState/reels] playWinline: parsed lines is not an array');
            return;
        }
        if (!parsed.every((row) => Array.isArray(row) && row.every((n) => typeof n === 'number'))) {
            console.warn('[FlowState/reels] playWinline: expected an array of number arrays, got', lines);
            return;
        }
        player.playWinline((parsed as number[][]).map((row) => row.slice()));
    }

    public clearWinline(target: NodeRefLike): void {
        const player = getPlayer(target);
        if (!player) return;
        player.clearWinline();
    }
}

export const reelsWinline = new ReelsWinlineMethods();
