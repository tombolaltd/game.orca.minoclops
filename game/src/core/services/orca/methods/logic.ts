/**
 * Boolean-logic value-function methods for FlowState.
 *
 * Each method is dispatched by `findMethod(flowstateMethods, node.title)` and
 * receives its node's `properties[]` already resolved IN DECLARATION ORDER.
 * Methods return a plain value (no side effects) for use as a property source.
 *
 * `and` / `or` are variadic: the editor authors them as growable-pin value
 * functions, which export as ordinary positional `part<N>` properties (same
 * shape as `string.stringBuilder`), so they arrive here as a REST param.
 */

/**
 * Loose truth coercion — bool, number (0/non-0), string ('' / '0' / 'false').
 *
 * Deliberately duplicated from `Flowstate.resolveBranchCondition` rather than
 * imported: `flowstate.ts` imports the methods index, so importing back would
 * create a module cycle. Keep the two IN SYNC — an `and`/`or`/`not` feeding a
 * `branch` must agree with a raw literal feeding that same `branch`.
 */
function toBool(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
        if (value === "" || value === "0" || value.toLowerCase() === "false") return false;
        return true;
    }
    return Boolean(value);
}

export const logic = {
    /** Variadic AND — true when EVERY value is truthy; no arguments yields true. */
    and(...values: unknown[]): boolean {
        return values.every(toBool);
    },
    /** Variadic OR — true when ANY value is truthy; no arguments yields false. */
    or(...values: unknown[]): boolean {
        return values.some(toBool);
    },
    /** Negation of the truthiness of `value`. */
    not(value: unknown): boolean {
        return !toBool(value);
    },
    /**
     * True when `value` is actually present — i.e. NOT `null` and NOT
     * `undefined`.
     *
     * Deliberately NOT truthiness: `0`, `''`, `NaN` and `false` are all
     * REAL values and answer `true`. Use `not` / `logic.not` if you want
     * truthiness inversion instead.
     *
     * An unwired input pin exports `value: undefined` (the `T`-typed pin
     * carries no menu `default`), so an unconnected node answers `false`.
     */
    isDefined(value: unknown): boolean {
        return value !== null && value !== undefined;
    },
};
