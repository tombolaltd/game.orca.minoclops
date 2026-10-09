/**
 * Misc utility value-function methods for FlowState.
 *
 * Dispatched by `findMethod(flowstateMethods, node.title)`; each receives its
 * node's `properties[]` resolved IN DECLARATION ORDER.
 */
export const util = {
    /** Length of a string/array, key count of an object, 0 for null/undefined/primitive. */
    getLength(value: unknown): number {
        if (value == null) return 0;
        if (typeof value === "string" || Array.isArray(value)) return value.length;
        if (typeof value === "object") return Object.keys(value as object).length;
        return 0;
    },
};
