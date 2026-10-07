// Ported from Libraries/Games/CashCollector3/{CashCollector3ContinueRequest,CashCollector3DebugRequest}.cs.

export interface CashCollectorContinueRequest {
    /** 1-based free spin the client is asking for; must be exactly PlayedBonusSpins + 1. */
    BonusSpin: number;
}

export interface CashCollectorDebugRequest {
    DebugStops?: number[];
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

export function parseCashCollectorContinueRequest(raw: unknown): CashCollectorContinueRequest | undefined {
    const record = asRecord(raw);
    if (record === undefined) return undefined;

    // `BonusSpins` is accepted as an alias so the shared simulator (and a client written for the
    // other slot mechanics) can drive this one too.
    const candidate = record.BonusSpin ?? record.BonusSpins;
    if (candidate === undefined || candidate === null || candidate === '') return undefined;
    const bonusSpin = Math.trunc(Number(candidate));
    return Number.isFinite(bonusSpin) ? { BonusSpin: bonusSpin } : undefined;
}

export function parseCashCollectorDebugRequest(raw: unknown): CashCollectorDebugRequest | undefined {
    const record = asRecord(raw);
    if (record === undefined) return undefined;

    const debug: CashCollectorDebugRequest = {};
    if (Array.isArray(record.DebugStops)) {
        debug.DebugStops = record.DebugStops.map(value => Math.trunc(Number(value))).filter(value => Number.isFinite(value));
    }
    return debug;
}
