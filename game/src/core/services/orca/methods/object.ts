/**
 * Structured-object value-function methods for FlowState.
 *
 * Dispatched by `findMethod(flowstateMethods, node.title)`; each receives its
 * node's `properties[]` resolved IN DECLARATION ORDER. Inputs are handled
 * defensively and never throw.
 *
 * NOTE ON NAMING: the exported namespace is `objectOps`, NOT `object` — the
 * latter shadows the built-in type name and reads badly at every call site.
 * The namespace key is irrelevant to dispatch: `findMethod` walks the OWN
 * enumerable properties of `flowstateMethods` recursively and matches on the
 * METHOD key, so what matters is that `parseObject` is a key of this object.
 *
 * `parseObject` is deliberately a TRIVIAL PASSTHROUGH. ALL drill-down work is
 * done by the graph walker: an author-defined value-OUTPUT pin carries a
 * `path` string (`Bonus.Rounds[0].Multiplier`), and `flowstate.ts` walks that
 * path into this method's return value via `resolveValuePath` below. Keeping
 * the path logic OUT of the method is what makes the mechanism general — any
 * future node that exports `outputs[].path` gets drill-down for free.
 */
export const objectOps = {
    /**
     * Pass a chunk of structured data through unchanged so author-defined
     * output pins can drill into it via their `path`.
     *
     * Accepts (and returns) anything — a model field typed
     * `Record<string, any>` / `Record<string, any>[]`, a raw server-response
     * fragment, `undefined`, a primitive. Never throws; a `path` walk into a
     * non-object simply resolves to `undefined`.
     */
    parseObject(source: unknown): unknown {
        return source;
    },

    // "Properties": same passthrough; its per-field output paths are derived by the editor.
    structFields(source: unknown): unknown {
        return source;
    },
};

/**
 * Hard cap on path depth. Author-typed paths are a handful of segments at
 * most; anything beyond this is malformed input, so the walk bails to
 * `undefined` rather than doing unbounded work.
 */
const MAX_PATH_SEGMENTS = 64;

/**
 * Split a dot + bracket path into ordered key segments.
 *
 * Matches the Data Browser's path format:
 *   `Player.Name`                 → ['Player', 'Name']
 *   `Reels[0]`                    → ['Reels', '0']
 *   `Bonus.Rounds[0].Multiplier`  → ['Bonus', 'Rounds', '0', 'Multiplier']
 *   `Multiplier`                  → ['Multiplier']   (leading segment, no dot)
 *
 * Bracket contents are taken verbatim, with matching single/double quotes
 * stripped, so `Map['some key']` works too. Empty segments (`a..b`, `a[]`) are
 * dropped. A malformed unterminated bracket ends the parse — best-effort, the
 * caller resolves what it can and yields `undefined` on the first mismatch.
 *
 * Never throws.
 */
function parseValuePath(path: string): string[] {
    const segments: string[] = [];
    let buffer = '';

    const flush = (): void => {
        const s = buffer.trim();
        buffer = '';
        if (s !== '') segments.push(s);
    };

    for (let i = 0; i < path.length; i++) {
        // Depth guard — stop tokenizing once the path is absurd. The caller
        // treats an over-length path as unresolvable.
        if (segments.length > MAX_PATH_SEGMENTS) break;

        const ch = path[i];

        if (ch === '.') {
            flush();
            continue;
        }

        if (ch === '[') {
            flush();
            const close = path.indexOf(']', i + 1);
            if (close === -1) return segments; // unterminated bracket
            let inner = path.slice(i + 1, close).trim();
            const first = inner.charAt(0);
            const last = inner.charAt(inner.length - 1);
            if (inner.length >= 2 && first === last && (first === '"' || first === "'")) {
                inner = inner.slice(1, -1);
            }
            if (inner !== '') segments.push(inner);
            i = close;
            continue;
        }

        buffer += ch;
    }

    flush();
    return segments;
}

/**
 * Walk a dot + bracket `path` into an already-resolved value.
 *
 * This is the shared drill-down primitive behind AUTHOR-DEFINED value-OUTPUT
 * pins (see `IFlowstateNode.outputs`). It is a PURE function of the resolved
 * value plus the path string — it holds no walk state and knows nothing about
 * which node produced the value.
 *
 * Contract:
 * - An empty / whitespace-only / non-string `path` returns `value` unchanged.
 * - A missing or type-mismatched segment resolves to `undefined` (indexing
 *   into `null` / `undefined` / a primitive is a mismatch, not an error).
 * - Array indices work via ordinary key access (`arr['0'] === arr[0]`).
 * - Depth is capped at `MAX_PATH_SEGMENTS`; deeper paths resolve to `undefined`.
 * - NEVER throws.
 */
export function resolveValuePath(value: unknown, path: string | null | undefined): unknown {
    try {
        if (typeof path !== 'string') return value;

        const trimmed = path.trim();
        if (trimmed === '') return value;

        const segments = parseValuePath(trimmed);
        if (segments.length === 0) return value;
        if (segments.length > MAX_PATH_SEGMENTS) return undefined;

        let current: unknown = value;
        for (const segment of segments) {
            if (current === null || current === undefined) return undefined;
            if (typeof current !== 'object') return undefined;
            current = (current as Record<string, unknown>)[segment];
        }
        return current;
    } catch (err) {
        console.warn(`[FlowState] Failed to resolve object path '${String(path)}'`, err);
        return undefined;
    }
}
