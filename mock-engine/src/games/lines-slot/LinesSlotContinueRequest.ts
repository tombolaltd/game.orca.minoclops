// Ported from Libraries/Games/Scatter/{ScatterContinueRequest,ScatterDebugRequest}.cs.
//
// MOCK: the C# registers a `Type` and lets JsonSerializer bind it. TypeScript has no runtime type,
// so each shape ships the parser GameTypeRegistry stores in its place.

export interface LinesSlotContinueRequest {
    /** 1-based free spin the client is asking for; must be exactly PlayedBonusSpins + 1. */
    BonusSpin: number;
}

export interface LinesSlotDebugRequest {
    /** One stop per reel. Out-of-range values are wrapped, never rejected. */
    DebugStops?: number[];
    /** One stop array per free spin. */
    DebugBonusStops?: number[][];
    /** Overrides DebugStops with the first stops that put the bonus symbol in view. */
    ForceBonus?: boolean;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function asIntArray(raw: unknown): number[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw.map(value => Math.trunc(Number(value))).filter(value => Number.isFinite(value));
}

export function parseLinesSlotContinueRequest(raw: unknown): LinesSlotContinueRequest | undefined {
    const record = asRecord(raw);
    if (record === undefined) return undefined;

    const bonusSpin = Math.trunc(Number(record.BonusSpin));
    return Number.isFinite(bonusSpin) ? { BonusSpin: bonusSpin } : undefined;
}

export function parseLinesSlotDebugRequest(raw: unknown): LinesSlotDebugRequest | undefined {
    const record = asRecord(raw);
    if (record === undefined) return undefined;

    const debug: LinesSlotDebugRequest = {};

    const stops = asIntArray(record.DebugStops);
    if (stops !== undefined) debug.DebugStops = stops;

    if (Array.isArray(record.DebugBonusStops)) {
        const bonusStops = record.DebugBonusStops.map(asIntArray).filter((entry): entry is number[] => entry !== undefined);
        if (bonusStops.length > 0) debug.DebugBonusStops = bonusStops;
    }

    if (record.ForceBonus === true) debug.ForceBonus = true;

    return debug;
}
