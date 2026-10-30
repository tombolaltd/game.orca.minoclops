import { resolveNode, type NodeRefLike } from "./node-ref";
import type { OrcaScrollBarHandle } from "../scene-manager";

/**
 * FlowState methods for the generic `scrollBar` scene node.
 *
 * Every method resolves its `target` through {@link resolveNode} (the shared
 * nodeRef resolver, per-skin refs included). The live control surface is the
 * `__orcaScrollBar` handle `scene-manager.ts` stashes on the built node; a
 * missing handle means the target is not a scroll bar, so the setters warn and
 * no-op and the getter outputs -1. Positions are counted in ITEMS: 0 = the
 * start, `total − visible` = the end (clamped, and stepped when the bar's
 * `step` is 'whole'). Calls from a graph never fire the bar's `changeEvent` —
 * only the player dragging / paging it does.
 *
 * Shared by both game templates (byte-identical copies). METHOD NAMES ARE THE
 * IMMUTABLE RUNTIME KEYS — `src/menu/action/scrollBar.json` and the
 * `getScrollBarPosition` getter dispatch straight onto them.
 */

type ScrollBarDisplayLike = { __orcaScrollBar?: OrcaScrollBarHandle };

/** The target's live scroll bar handle, or null (`warn` names the caller when set). */
function scrollBarHandle(target: NodeRefLike, caller: string | null): OrcaScrollBarHandle | null {
    const obj = resolveNode<ScrollBarDisplayLike>(target);
    if (!obj) return null;
    const handle = obj.__orcaScrollBar;
    if (!handle || handle.isDisposed()) {
        if (caller) console.warn(`[FlowState/scrollBar] ${caller}: the target is not a Scroll Bar node.`);
        return null;
    }
    return handle;
}

/** Tolerate a numeric string from the walker; the handle clamps the rest. */
function toNumber(value: unknown): number {
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    return typeof value === "number" ? value : NaN;
}

class ScrollBarMethods {
    /**
     * Set a scroll bar's content in one go: `total` items, `visible` of them in
     * view at once, scrolled to `position` (items). The thumb's size is
     * visible / total, its place the position.
     */
    public setScrollBarRange(target: NodeRefLike, total: number, visible: number, position: number): void {
        const handle = scrollBarHandle(target, "setScrollBarRange");
        if (!handle) return;
        const p = toNumber(position);
        handle.setRange(toNumber(total), toNumber(visible), Number.isFinite(p) ? p : 0);
    }

    /** Move a scroll bar's thumb to `position` (items); its total / visible stay. */
    public setScrollBarPosition(target: NodeRefLike, position: number): void {
        const handle = scrollBarHandle(target, "setScrollBarPosition");
        if (!handle) return;
        handle.setPosition(toNumber(position));
    }

    /** How far a scroll bar is scrolled (items), or -1 when the target is missing or not a scroll bar. */
    public getScrollBarPosition(target: NodeRefLike): number {
        const handle = scrollBarHandle(target, null);
        return handle ? handle.getPosition() : -1;
    }
}

export const scrollBar = new ScrollBarMethods();
