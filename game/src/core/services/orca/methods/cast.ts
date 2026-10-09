/**
 * Type-cast value-function methods for FlowState.
 *
 * Dispatched by `findMethod(flowstateMethods, node.title)`; each receives its
 * node's `properties[]` resolved IN DECLARATION ORDER. Inputs are coerced
 * defensively and never throw — non-finite / unparseable values fall back to
 * a safe default.
 */
export const cast = {
    /** Whole number truncated toward zero; non-finite inputs → 0. e.g. "3.7" → 3, 3.9 → 3, "abc" → 0. */
    toInt(value: unknown): number {
        const n = Number(value);
        return Number.isFinite(n) ? Math.trunc(n) : 0;
    },
    /** Floating-point number; non-finite inputs → 0. */
    toFloat(value: unknown): number {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    },
    /**
     * Boolean coercion.
     * - boolean → passthrough
     * - number → `value !== 0`
     * - string → trim+lowercase; "true"/"1"/"yes"/"on" → true,
     *   "false"/"0"/"no"/"off"/"" → false
     * - otherwise → JS truthiness (`Boolean(value)`)
     */
    toBool(value: unknown): boolean {
        if (typeof value === "boolean") return value;
        if (typeof value === "number") return value !== 0;
        if (typeof value === "string") {
            const s = value.trim().toLowerCase();
            if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
            if (s === "false" || s === "0" || s === "no" || s === "off" || s === "") return false;
        }
        return Boolean(value);
    },
};
