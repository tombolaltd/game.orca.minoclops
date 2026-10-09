// ─────────────────────────────────────────────────────────────────────────────
// Loop control-flow helpers
// ─────────────────────────────────────────────────────────────────────────────
//
// The `loop` node (node.rootType === 'loop') is a top-level control-flow node
// like `branch`. It is NOT a registered method in `flowstateMethods` — it is
// special-cased directly in the flow walker (flowstate.ts), because a method
// can only await + return; it cannot drive the walker to re-run a downstream
// body sub-sequence per iteration.
//
// Output convention (must match the editor + menu agents):
//   outIdx 0 = "loop body"     sub-sequence (walked once per iteration)
//   outIdx 1 = "loop complete" sub-sequence (followed after all iterations)
//   outIdx 2 = "on break"      sub-sequence (followed INSTEAD of complete when
//                              a flow arrives on the loop's Break input,
//                              i.e. a link carrying `toInput: 'break'`)
//
// The loop carries an optional input property `items` (type AnyArray) plus a
// `count` (int) property. The iteration count is the resolved array length
// when `items` resolves to a REAL array (count is ignored); otherwise it falls
// back to the `count` property (clamped to a non-negative integer). Iteration
// count is therefore strictly bounded — there is no infinite-loop hazard.
//
// The loop also exposes two named VALUE outputs read by body nodes during
// iteration: `index` (current 0-based iteration) and `item` (current array
// element, or the index when iterating by `count`). These are transient
// per-walk state held by the walker (flowstate.ts `loopState`), NOT methods.
// ─────────────────────────────────────────────────────────────────────────────

/** Best-effort loop-node detection — editor stamps `rootType: 'loop'`. */
export function isLoopNode(node: { rootType?: string }): boolean {
    return (node as { rootType?: string }).rootType === 'loop';
}

/**
 * Number of body iterations to run for a resolved `items` value. Array →
 * length; anything else → 0 (the walker then falls back to the loop node's
 * `count` property).
 */
export function loopIterationCount(items: unknown): number {
    return Array.isArray(items) ? items.length : 0;
}
