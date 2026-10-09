/**
 * Tagged FlowState console lines the Orca editor's Console parses into
 * clickable "go to node" entries.
 *
 * WIRE CONTRACT (shared with the editor — do not change unilaterally): ONE
 * console call per message with ONE string argument,
 *   `${humanText} orca-console:${JSON.stringify(payload)}`
 * payload = { v: 1, level, text, color?, graphId?, nodeId?, nodeTitle?, code? }.
 * `graphId` is the runtime registered id (`core/<name>` / `skin/<folder>/<name>`)
 * and `nodeId` the authoring node id. The console method matches `level`.
 *
 * A leaf module with NO imports: the walker, node-ref.ts and method modules
 * all import it, so it must never join their import cycle.
 */

export type FlowConsoleLevel = 'error' | 'warn' | 'info' | 'verbose' | 'log';

export interface FlowNodeContext {
    graphId: string;
    nodeId: string;
    nodeTitle?: string;
}

export interface FlowConsoleExtra {
    color?: unknown;
    code?: string;
    graphId?: string;
    nodeId?: string;
    nodeTitle?: string;
    /** Explicit attribution; `null` = none. Omitted = the current node context. */
    context?: FlowNodeContext | null;
}

interface FlowConsolePayload {
    v: 1;
    level: FlowConsoleLevel;
    text: string;
    color?: string;
    graphId?: string;
    nodeId?: string;
    nodeTitle?: string;
    code?: string;
}

const MARKER = 'orca-console:';
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

let currentContext: FlowNodeContext | null = null;

/**
 * Run `fn` with `ctx` as the executing node. Only the SYNCHRONOUS part of
 * `fn` is covered — use `captureFlowNodeContext` for deferred callbacks.
 */
export function withFlowNodeContext<T>(ctx: FlowNodeContext | null, fn: () => T): T {
    const previous = currentContext;
    currentContext = ctx;
    try {
        return fn();
    } finally {
        currentContext = previous;
    }
}

export function currentFlowNodeContext(): FlowNodeContext | null {
    return currentContext;
}

/** Snapshot for a deferred callback; restore it with `withFlowNodeContext`. */
export function captureFlowNodeContext(): FlowNodeContext | null {
    return currentContext ? { ...currentContext } : null;
}

function normaliseColor(color: unknown): string | undefined {
    if (typeof color === 'number' && Number.isFinite(color)) {
        return `#${(Math.trunc(color) & 0xffffff).toString(16).padStart(6, '0')}`;
    }
    if (typeof color !== 'string') return undefined;
    const trimmed = color.trim();
    if (HEX_COLOR_RE.test(trimmed)) return trimmed;
    if (/^(?:0x)?[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed.replace(/^0x/i, '')}`;
    return undefined;
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

export function emitFlowConsole(level: FlowConsoleLevel, text: string, extra?: FlowConsoleExtra): void {
    const ctx = extra && 'context' in extra ? extra.context ?? null : currentContext;
    const payload: FlowConsolePayload = { v: 1, level, text };
    const color = normaliseColor(extra?.color);
    if (color) payload.color = color;
    const graphId = nonEmpty(extra?.graphId) ?? ctx?.graphId;
    const nodeId = nonEmpty(extra?.nodeId) ?? ctx?.nodeId;
    const nodeTitle = nonEmpty(extra?.nodeTitle) ?? ctx?.nodeTitle;
    if (graphId) payload.graphId = graphId;
    if (nodeId) payload.nodeId = nodeId;
    if (nodeTitle) payload.nodeTitle = nodeTitle;
    const code = nonEmpty(extra?.code);
    if (code) payload.code = code;

    let line: string;
    try {
        line = `${text} ${MARKER}${JSON.stringify(payload)}`;
    } catch {
        line = text;
    }

    switch (level) {
        case 'error': console.error(line); break;
        case 'warn': console.warn(line); break;
        case 'info': console.info(line); break;
        case 'verbose': console.debug(line); break;
        default: console.log(line); break;
    }
}

/** Readable text for any logged value: strings verbatim, else JSON with a fallback. */
export function stringifyFlowValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (value instanceof Error) return value.message || String(value);
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
    try {
        const seen = new WeakSet<object>();
        const json = JSON.stringify(value, (_key, v) => {
            if (typeof v === 'bigint') return String(v);
            if (v !== null && typeof v === 'object') {
                if (seen.has(v)) return '[Circular]';
                seen.add(v);
            }
            return v;
        });
        return json === undefined ? String(value) : json;
    } catch {
        return String(value);
    }
}

const MAX_STACK_FRAMES = 4;

/** Error message plus the top of its stack, for the text tail. */
export function describeFlowError(err: unknown): string {
    if (!(err instanceof Error)) return stringifyFlowValue(err);
    const message = err.message || err.name || 'Error';
    const frames = typeof err.stack === 'string'
        ? err.stack.split('\n').filter(l => /^\s*at\s/.test(l)).slice(0, MAX_STACK_FRAMES)
        : [];
    return frames.length > 0 ? `${message}\n${frames.join('\n')}` : message;
}

const reportedErrors = new WeakSet<object>();

/** Mark an error as already emitted so an outer catch does not report it again. */
export function markFlowErrorReported(err: unknown): unknown {
    const marked = err !== null && (typeof err === 'object' || typeof err === 'function')
        ? err
        : new Error(stringifyFlowValue(err));
    reportedErrors.add(marked as object);
    return marked;
}

export function isFlowErrorReported(err: unknown): boolean {
    return err !== null && (typeof err === 'object' || typeof err === 'function') && reportedErrors.has(err as object);
}
