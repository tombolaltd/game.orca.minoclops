/**
 * Array value-function methods for FlowState.
 *
 * Dispatched by `findMethod(flowstateMethods, node.title)`; each receives its
 * node's `properties[]` resolved IN DECLARATION ORDER. All methods are
 * defensive against non-array input and NEVER mutate their inputs (operations
 * that would mutate work on a copy).
 */
export const array = {
    /** Last element, or undefined for non-array / empty input. */
    pop(arr: unknown): unknown {
        return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : undefined;
    },
    /** Sorted COPY. Numeric sort when every element is a number, else lexical. */
    sort(arr: unknown): unknown[] {
        if (!Array.isArray(arr)) return [];
        const copy = [...arr];
        if (copy.every((x) => typeof x === "number")) {
            return copy.sort((a, b) => (a as number) - (b as number));
        }
        return copy.sort();
    },
    /** Reversed COPY. */
    reverse(arr: unknown): unknown[] {
        return Array.isArray(arr) ? [...arr].reverse() : [];
    },
    join(arr: unknown, separator: unknown): string {
        return Array.isArray(arr) ? arr.join(String(separator ?? "")) : "";
    },
    slice(arr: unknown, start: unknown, end: unknown): unknown[] {
        return Array.isArray(arr)
            ? arr.slice(Number(start) || 0, end == null ? undefined : Number(end))
            : [];
    },
    includes(arr: unknown, value: unknown): boolean {
        return Array.isArray(arr) ? arr.includes(value) : false;
    },
    indexOf(arr: unknown, value: unknown): number {
        return Array.isArray(arr) ? arr.indexOf(value) : -1;
    },
    /** Element at `index` (negative counts back from the end). undefined for non-array / out-of-range. */
    at(arr: unknown, index: unknown): unknown {
        if (!Array.isArray(arr)) return undefined;
        let i = Math.trunc(Number(index) || 0);
        if (i < 0) i += arr.length;
        return i >= 0 && i < arr.length ? arr[i] : undefined;
    },
    first(arr: unknown): unknown {
        return Array.isArray(arr) && arr.length ? arr[0] : undefined;
    },
    /** Last element, identical semantics to `pop`. */
    last(arr: unknown): unknown {
        return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : undefined;
    },
    sum(arr: unknown): number {
        return Array.isArray(arr) ? arr.reduce((s: number, x) => s + Number(x), 0) : 0;
    },
    /** Product of elements. Empty array → 0; non-array → 0. */
    product(arr: unknown): number {
        return Array.isArray(arr) && arr.length
            ? arr.reduce((p: number, x) => p * Number(x), 1)
            : 0;
    },
};
