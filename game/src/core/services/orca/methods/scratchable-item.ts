import { resolveNode, type NodeRefLike } from "./node-ref";
import { runTween } from "./transform";
import type { OrcaScratchHandle } from "../components/scratchable-item";

/**
 * FlowState methods for the `scratchableItem` scene node (scratch cards).
 *
 * Every method resolves its `target` through {@link resolveNode}, which
 * transparently collapses the per-skin `nodeRefBySkin` variant down to the
 * active skin's entry. The live control surface is the `__orcaScratchHandle`
 * object that `components/scratchable-item.ts` stashes on the built sprite;
 * a missing handle means the target is not a scratchable item (or its scratch
 * wiring was skipped — e.g. no host renderer registered), so every method
 * no-ops with a `console.warn` rather than throwing.
 *
 * METHOD NAMES ARE THE IMMUTABLE RUNTIME KEYS — the matching menu JSON's
 * node `name` fields dispatch straight onto them (AGENTS.md rule 7).
 */

type ScratchableDisplayLike = { __orcaScratchHandle?: OrcaScratchHandle };

/**
 * Resolve `target` to its scratch control handle. Warns (naming the caller)
 * and returns `null` when the node is missing or is not a scratchable item.
 */
function getScratchHandle(target: NodeRefLike, caller: string): OrcaScratchHandle | null {
    const obj = resolveNode<ScratchableDisplayLike>(target);
    if (!obj) {
        console.warn(`[FlowState/scratchableItem] ${caller}: target did not resolve to a scene node`);
        return null;
    }
    const handle = obj.__orcaScratchHandle;
    if (!handle) {
        console.warn(
            `[FlowState/scratchableItem] ${caller}: target node is not a scratchable item (missing __orcaScratchHandle)`,
        );
        return null;
    }
    return handle;
}

/** Tolerate a numeric string from the walker; the handle validates the rest. */
function toNumber(value: unknown): number {
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    return typeof value === "number" ? value : NaN;
}

class ScratchableItemMethods {
    /**
     * Re-cover the panel: rebuild/re-prime the scratch mask, clear the
     * progress grid, and re-arm the `scratchComplete` starter so a subsequent
     * full scratch fires it again.
     *
     * @param target - NodeRef to a scratchableItem scene node
     */
    public resetScratch(target: NodeRefLike): void {
        const handle = getScratchHandle(target, "resetScratch");
        if (!handle) return;
        handle.reset();
    }

    /**
     * Fully reveal the panel immediately (as if it had been scratched past
     * its `revealThreshold`). Fires the `scratchComplete` starter if it has
     * not already fired for this node since the last reset.
     *
     * @param target - NodeRef to a scratchableItem scene node
     */
    public revealScratch(target: NodeRefLike): void {
        const handle = getScratchHandle(target, "revealScratch");
        if (!handle) return;
        handle.revealAll();
    }

    /**
     * Enable / disable pointer scratching. A disabled panel still renders (and
     * keeps whatever has already been scratched away) but ignores input and
     * does not swallow pointerdown from nodes beneath it.
     *
     * @param target - NodeRef to a scratchableItem scene node
     * @param enabled - true to allow scratching
     */
    public setScratchEnabled(target: NodeRefLike, enabled: boolean): void {
        const handle = getScratchHandle(target, "setScratchEnabled");
        if (!handle) return;
        handle.setEnabled(enabled === true);
    }

    /**
     * Change the brush DIAMETER, in DISPLAY pixels — the same unit as the
     * node's authored Brush Size / Width / Height, NOT source-texture texels.
     * Takes effect on the next stroke.
     *
     * @param target - NodeRef to a scratchableItem scene node
     * @param size - positive brush diameter, in display px
     */
    public setScratchBrushSize(target: NodeRefLike, size: number): void {
        const handle = getScratchHandle(target, "setScratchBrushSize");
        if (!handle) return;
        handle.setBrushSize(size);
    }

    /**
     * Drag a scripted "fake touch" along one of the node's authored scratch
     * paths at constant speed. Works while pointer scratching is disabled; fires
     * `scratchStarted` / `scratchStopped` and completes the panel exactly like a
     * real stroke. A later `autoScratch`, `resetScratch`, `revealScratch` or a
     * real press cancels it (a cancelled stroke never reveals).
     *
     * When the path ends naturally with `revealOnFinish` (anything but `false`)
     * and the panel is not already complete, the panel is fully revealed as by
     * `revealScratch` — firing `scratchComplete`, not `scratchStopped`.
     *
     * `sequenceNodeOn === 'onComplete'` blocks the flow until the path ends —
     * and any finish reveal's animation with it — or is cancelled; anything
     * else continues immediately — the `runTween` contract shared with the
     * transform tweens.
     *
     * @param target - NodeRef to a scratchableItem scene node
     * @param pathIndex - 0-based index into the node's authored paths
     * @param durationMS - time to traverse the path; `<= 0` scratches it at once
     * @param revealOnFinish - fully reveal the panel when the path ends
     * @param sequenceNodeOn - `'immediate'` | `'onComplete'`
     */
    public autoScratch(
        target: NodeRefLike,
        pathIndex: number,
        durationMS: number,
        revealOnFinish: boolean,
        sequenceNodeOn: string,
    ): Promise<void> {
        const handle = getScratchHandle(target, "autoScratch");
        if (!handle) return Promise.resolve();
        const index = toNumber(pathIndex);
        const duration = toNumber(durationMS);
        return runTween(sequenceNodeOn, (onComplete) => {
            try {
                handle.autoScratch(index, duration, revealOnFinish !== false).then(onComplete, onComplete);
            } catch (err) {
                console.warn("[FlowState/scratchableItem] autoScratch failed", err);
                onComplete();
            }
        });
    }

    /**
     * Multi-value getter describing the panel's scratch state.
     *
     * `progress` is the fraction (0..1) of the panel scratched away, derived
     * from a coarse occupancy grid sized to the node's DISPLAY extent (8..128
     * cells per axis, never a GPU pixel read-back), and
     * `complete` is true once the panel has passed its `revealThreshold` (or
     * was revealed via `revealScratch`).
     *
     * The two keys match the menu node's `outputs[].name` exactly. Returns
     * zero / `false` when the target is missing or is not a scratchable item.
     *
     * @param target - NodeRef to a scratchableItem scene node
     */
    public getScratchInfo(target: NodeRefLike): { progress: number; complete: boolean } {
        const handle = getScratchHandle(target, "getScratchInfo");
        if (!handle) return { progress: 0, complete: false };
        const progress = handle.getProgress();
        return {
            progress: typeof progress === "number" && Number.isFinite(progress) ? progress : 0,
            complete: handle.isComplete() === true,
        };
    }
}

export const scratchableItem = new ScratchableItemMethods();
