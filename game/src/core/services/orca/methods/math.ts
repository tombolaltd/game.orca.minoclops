/**
 * Math value-function methods for FlowState.
 *
 * Each method is dispatched by `findMethod(flowstateMethods, node.title)` and
 * receives its node's `properties[]` already resolved IN DECLARATION ORDER.
 * Methods return a plain value (no side effects) for use as a property source.
 */
export const math = {
    /** Numeric addition; string concatenation when either operand is a string. */
    add(a: unknown, b: unknown): number | string {
        if (typeof a === "string" || typeof b === "string") {
            return `${a as string | number}${b as string | number}`;
        }
        return Number(a) + Number(b);
    },
    subtract(a: unknown, b: unknown): number {
        return Number(a) - Number(b);
    },
    multiply(a: unknown, b: unknown): number {
        return Number(a) * Number(b);
    },
    /** Divide-by-zero guarded: returns 0 when the divisor is 0. */
    divide(a: unknown, b: unknown): number {
        return Number(b) === 0 ? 0 : Number(a) / Number(b);
    },
    greaterThan(a: unknown, b: unknown): boolean {
        return Number(a) > Number(b);
    },
    greaterThanOrEqual(a: unknown, b: unknown): boolean {
        return Number(a) >= Number(b);
    },
    lessThan(a: unknown, b: unknown): boolean {
        return Number(a) < Number(b);
    },
    lessThanOrEqual(a: unknown, b: unknown): boolean {
        return Number(a) <= Number(b);
    },
    /** Loose value equality: strict OR stringified match. */
    equals(a: unknown, b: unknown): boolean {
        return a === b || String(a) === String(b);
    },
    /** Loose value inequality: negation of the strict-OR-stringified match. */
    notEqual(a: unknown, b: unknown): boolean {
        return !(a === b || String(a) === String(b));
    },
    /** Random value in [0, 1); integer mode rounds to 0 or 1. */
    random(numberType: unknown): number {
        const r = Math.random();
        return numberType === "integer" ? Math.round(r) : r;
    },
    /** Random value between min and max (reversed ranges allowed); integer mode yields an inclusive whole number. */
    randomRange(min: unknown, max: unknown, numberType: unknown): number {
        const a = Number(min);
        const b = Number(max);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (numberType === "integer") {
            const loInt = Math.ceil(lo);
            const hiInt = Math.floor(hi);
            if (hiInt < loInt) {
                return Math.round(lo);
            }
            return Math.floor(Math.random() * (hiInt - loInt + 1)) + loInt;
        }
        return lo + Math.random() * (hi - lo);
    },
    /** Rounds to the nearest whole number. */
    round(value: unknown): number {
        return Math.round(Number(value));
    },
    /** Rounds down to the nearest whole number. */
    floor(value: unknown): number {
        return Math.floor(Number(value));
    },
    /** Rounds up to the nearest whole number. */
    ceil(value: unknown): number {
        return Math.ceil(Number(value));
    },
    /** Absolute value (magnitude, ignoring sign). */
    abs(value: unknown): number {
        return Math.abs(Number(value));
    },
    /** Square root; negative inputs are guarded to 0 to avoid NaN. */
    sqrt(value: unknown): number {
        const v = Number(value);
        return v < 0 ? 0 : Math.sqrt(v);
    },
    /** Sign of the number: -1, 0, or 1. */
    sign(value: unknown): number {
        return Math.sign(Number(value));
    },
    /** Smaller of two numbers. */
    min(a: unknown, b: unknown): number {
        return Math.min(Number(a), Number(b));
    },
    /** Larger of two numbers. */
    max(a: unknown, b: unknown): number {
        return Math.max(Number(a), Number(b));
    },
    /** First number raised to the power of the second. */
    power(a: unknown, b: unknown): number {
        return Math.pow(Number(a), Number(b));
    },
    /** Remainder after division; divide-by-zero guarded to 0. */
    modulo(a: unknown, b: unknown): number {
        return Number(b) === 0 ? 0 : Number(a) % Number(b);
    },
    /** Constrains a value to the inclusive [min, max] range. */
    clamp(value: unknown, min: unknown, max: unknown): number {
        return Math.min(Math.max(Number(value), Number(min)), Number(max));
    },
};
