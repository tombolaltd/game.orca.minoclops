// Ported from Libraries/Games/Tap/TapDebugRequest.cs (+ the DebugTicket the Tap debug handler reads).
//
// MOCK: the C# registers a `Type` and lets JsonSerializer bind it. TypeScript has no runtime type,
// so each shape ships the parser GameTypeRegistry stores in its place.

/**
 * InstantWinSettings models no bonus stage, so a continue carries no payload. The shape and its
 * parser exist so the registration matches the other two mechanics.
 */
export type InstantWinContinueRequest = Record<string, never>;

export interface InstantWinDebugRequest {
    /** The card verbatim, one symbol per cell. Unknown symbols become blanks, never a rejection. */
    DebugReveals?: number[];
    /** Deals a fresh card with this prize symbol planted MatchesToWin times. */
    ForceSymbol?: number;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function asIntArray(raw: unknown): number[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw.map(value => Math.trunc(Number(value))).filter(value => Number.isFinite(value));
}

export function parseInstantWinContinueRequest(raw: unknown): InstantWinContinueRequest | undefined {
    return asRecord(raw) === undefined ? undefined : {};
}

export function parseInstantWinDebugRequest(raw: unknown): InstantWinDebugRequest | undefined {
    const record = asRecord(raw);
    if (record === undefined) return undefined;

    const debug: InstantWinDebugRequest = {};

    const reveals = asIntArray(record.DebugReveals);
    if (reveals !== undefined) debug.DebugReveals = reveals;

    const forced = Math.trunc(Number(record.ForceSymbol));
    if (Number.isFinite(forced)) debug.ForceSymbol = forced;

    return debug;
}
