import { FlowstateApplicationEventTriggers } from "./event-triggers/application-events";

// Re-export types from external packages
export type { CabinetButtonStringOption } from "@game-studio/arcade-base";
export type { ICoreSettings, IReelSettings, ISymbolSettings } from "@game-studio/generic-reels";
export { SpinProfileSequence } from "@game-studio/generic-reels";

// ============================================
// FlowState Server Connection Types
// ============================================

/**
 * Dynamic GameMessage interface - fields populated from server response
 * Auto-generated structure based on Data Browser mappings
 */
export interface IFlowStateGameMessage {
    [key: string]: unknown;
}

/**
 * Dynamic GameSettings interface - fields populated from server response
 * Auto-generated structure based on Data Browser mappings
 */
export interface IFlowStateGameSettings {
    Reels?: number[][];
    BonusSpinReels?: number[][];
    JackpotDetails?: { Version?: number; [key: string]: unknown };
    [key: string]: unknown;
}

/**
 * The server response structure expected by FlowState
 */
export interface IFlowStateServerResponse {
    RequestType: 'Resume' | 'Begin' | 'Continue' | string;
    GameMessage?: IFlowStateGameMessage;
    GameSettings?: IFlowStateGameSettings;
    [key: string]: unknown;
}

// ============================================
// Flowstate-specific types
// ============================================

export interface IFlowstateProperty {
    name: string;
    type: string;
    // Array literals (e.g. a loop `items` source) are baked as REAL arrays
    // on export, so the runtime can iterate them without string parsing.
    value?: number | string | boolean | unknown[];
    // For dynamic property resolution - references a property getter node
    sourceNodeId?: string;
    /**
     * Which named VALUE output of the source node this property reads.
     * Set by the FlowState Editor on export whenever the incoming value link
     * leaves a NAMED output pin. Resolution precedence in the walker
     * (`flowstate.ts` `resolvePropertyValue`):
     *   1. the current walk's STARTER args (e.g. `onApplicationResize` →
     *      `width` / `height`, or a custom event's pass-props);
     *   2. a LOOP node's transient iteration state — `'index'` (current
     *      0-based iteration) or `'item'` (current array element); a loop
     *      source with no `sourceOutputName` resolves to `'item'`;
     *   3. an AUTHOR-DEFINED drill-down output declared in the source node's
     *      `outputs[]` — the source value is resolved, then that entry's
     *      `path` is walked into it (see `IFlowstateNode.outputs`);
     *   4. otherwise a plain key read off an object-returning multi-output
     *      getter (e.g. `getNodePosition` → `x` / `y`).
     */
    sourceOutputName?: string;
}

export interface IFlowstateSubgraph {
    nodes: IFlowstateNode[];
    links: IFlowstateLink[];
}

export interface IFlowstateNode {
    id: string;
    title: string;
    properties?: IFlowstateProperty[];
    isState?: boolean;
    isEntry?: boolean;
    isExit?: boolean;
    subgraph?: IFlowstateSubgraph;
    starterNodeType?: string;
    /**
     * Control-flow discriminator stamped by the FlowState Editor on export.
     * `'branch'` for branch nodes, `'loop'` for loop nodes. Drives the
     * special-case handling in the flow walker (see `isBranchNode` /
     * `isLoopNode`).
     */
    rootType?: string;
    /**
     * AUTHOR-DEFINED named value-OUTPUT pins, each carrying a drill-down
     * `path` into this node's resolved value (currently emitted for
     * `objectOps/parseObject`).
     *
     * RUNTIME CONTRACT: when a consumer property's `sourceOutputName` names an
     * entry here, the walker resolves this node's value and then walks that
     * entry's `path` into it (`methods/object.ts` `resolveValuePath`). The
     * mechanism is keyed purely on the presence of `path` — it is NOT
     * special-cased to `parseObject`, so any future node that exports
     * `outputs[].path` gets drill-down for free.
     *
     * Deliberately ABSENT for fixed, menu-owned multi-output getters (e.g.
     * `getNodePosition` → `x`/`y`) and for starter value outputs (which the
     * runtime supplies as `WalkContext.starterArgs`); the editor does not
     * export those, and they keep their pre-existing resolution behaviour.
     *
     * Typed permissively because this is untrusted on-disk JSON — the walker
     * guards `typeof path === 'string'` before using an entry.
     */
    outputs?: Array<{ name: string; type?: string; path?: string }>;
}

export interface IFlowstateLink {
    id: string;
    from: string;
    to: string;
    propertyType?: string;
    propertyName?: string;
    /**
     * Index of the source node's output pin this link leaves from. Defaults
     * to 0 when omitted. Control-flow nodes with multiple outputs (branch:
     * 0 = true, 1 = false; loop: 0 = body, 1 = complete, 2 = on break) rely
     * on this to pick the correct downstream sub-sequence.
     */
    outIdx?: number;
    /**
     * Named TARGET input of a flow link. Absent = the node's main input. Only
     * `'break'` is recognised: a flow arriving on a loop's Break input stops
     * that loop instead of running it.
     */
    toInput?: string;
}

/**
 * A PER-GRAPH local variable declaration (Unreal-Blueprint style), exported by
 * the FlowState Editor as the third top-level key of each graph JSON.
 *
 * NOT to be confused with `IFlowstateVariable` in `variable-extractor.ts`,
 * which is the unrelated global GameModel property allow-list.
 *
 * RUNTIME CONTRACT: `registerGraph` seeds one `Map<string, unknown>` per
 * registered graph from this list (`defaultValue` when present, else the type
 * default). `getVariable` / `setVariable` nodes are walker-intrinsic reads and
 * writes against that store — they are NOT registered methods.
 */
export interface IFlowstateGraphVariable {
    name: string;
    type: 'int' | 'float' | 'string' | 'bool' | 'StringArray' | 'IntArray' | 'FloatArray' | 'BoolArray' | 'ObjectArray';
    defaultValue?: unknown;
}

export interface IFlowstateData {
    nodes: IFlowstateNode[];
    links: IFlowstateLink[];
    /**
     * Per-graph local variable declarations. ABSENT on every graph exported
     * before the feature landed — the runtime degrades to an empty store.
     */
    variables?: IFlowstateGraphVariable[];
    /**
     * Optional version stamp set by the FlowState Editor when exporting graph data.
     * Not currently consumed by the runtime, but accepted to keep the type in lock-step
     * with the editor's export shape and to allow `loadFlowstateData()` to return a
     * versioned fallback object without tripping excess-property checks.
     */
    version?: string;
}

export interface IFlowstateEventTriggers {
    application: FlowstateApplicationEventTriggers;
    /**
     * Pixi pointer-event starters are auto-bound by `Flowstate.bindPixiStarters()`
     * (called at init() and after every scene load/unload). The `pixi` slot is
     * retained for back-compat but no longer carries a method registry — leave
     * it as an empty object literal.
     */
    pixi: Record<string, never>;
}
