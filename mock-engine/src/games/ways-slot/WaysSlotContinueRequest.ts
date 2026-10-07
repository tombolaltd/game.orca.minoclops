// Ported from Libraries/Games/Mystery243/{Mystery243ContinueRequest,Mystery243DebugRequest}.cs.

export interface WaysSlotContinueRequest {
    /** 1-based free spin the client is asking for; must be exactly PlayedBonusSpins + 1. */
    BonusSpins: number;
}

export interface WaysSlotDebugRequest {
    DebugStops?: number[];
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

export function parseWaysSlotContinueRequest(raw: unknown): WaysSlotContinueRequest | undefined {
    const record = asRecord(raw);
    if (record === undefined) return undefined;

    // `BonusSpin` is accepted as an alias so one client can drive either slot mechanic.
    const bonusSpins = Math.trunc(Number(record.BonusSpins ?? record.BonusSpin));
    return Number.isFinite(bonusSpins) ? { BonusSpins: bonusSpins } : undefined;
}

export function parseWaysSlotDebugRequest(raw: unknown): WaysSlotDebugRequest | undefined {
    const record = asRecord(raw);
    if (record === undefined) return undefined;

    const debug: WaysSlotDebugRequest = {};

    const stops = asIntArray(record.DebugStops);
    if (stops !== undefined) debug.DebugStops = stops;

    if (Array.isArray(record.DebugBonusStops)) {
        const bonusStops = record.DebugBonusStops.map(asIntArray).filter((entry): entry is number[] => entry !== undefined);
        if (bonusStops.length > 0) debug.DebugBonusStops = bonusStops;
    }

    if (record.ForceBonus === true) debug.ForceBonus = true;

    return debug;
}
