/**
 * String value-function methods for FlowState.
 *
 * Dispatched by `findMethod(flowstateMethods, node.title)`; each receives its
 * node's `properties[]` resolved IN DECLARATION ORDER. Inputs are coerced with
 * `String(...)` defensively.
 */
export const string = {
    toUpperCase(value: unknown): string {
        return String(value).toUpperCase();
    },
    toLowerCase(value: unknown): string {
        return String(value).toLowerCase();
    },
    concat(a: unknown, b: unknown): string {
        return `${a as string | number}${b as string | number}`;
    },
    substring(value: unknown, start: unknown, end: unknown): string {
        return String(value).substring(Number(start) || 0, end == null ? undefined : Number(end));
    },
    split(value: unknown, separator: unknown): string[] {
        return String(value).split(String(separator ?? ""));
    },
    /** Global replace via split/join — avoids regex surprises. */
    replace(value: unknown, search: unknown, replacement: unknown): string {
        return String(value).split(String(search)).join(String(replacement));
    },
    trim(value: unknown): string {
        return String(value).trim();
    },
    charAt(value: unknown, index: unknown): string {
        return String(value).charAt(Number(index) || 0);
    },
    toString(value: unknown): string {
        return String(value);
    },
    /** Variadic concatenation with no separator; null/undefined parts contribute "". */
    stringBuilder(...parts: unknown[]): string {
        return parts.map((p) => (p == null ? "" : String(p))).join("");
    },
};
