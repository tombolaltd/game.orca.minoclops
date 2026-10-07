// Paytable lookups — the two conventions a slot picks between, hoisted so a mechanic states which
// one it wants instead of hand-rolling a `.find()`.
//
// Generalised from the private `pickTier` the source harness' evaluateLines.ts and evaluateWays.ts
// each carried a copy of (3/4/5 only, duplicated per file).
//
// ⚠️ THE CHOICE MOVES RTP. `tieredMultiplier` pays a 5-reel run its 4-of-a-kind prize when no
// 5-of-a-kind is declared; `exactMultiplier` refuses, and the evaluator then falls back to the
// longest run that DOES pay, awarding a shorter — and for ways, a narrower — win. Two mechanics
// declaring "the same" paytable under different lookups do not measure the same RTP. Pick
// deliberately and simulate.

import { PaytableLookup, SymbolTierPaytable } from './types';

/**
 * Highest declared tier at or below `matched` — a run longer than the paytable's top tier still
 * pays that top tier. The source harness' convention.
 */
export function tieredMultiplier(paytable: SymbolTierPaytable): PaytableLookup {
    return (symbol: number, matched: number): number => {
        const tier = paytable[symbol];
        if (tier === undefined || matched <= 0) return 0;
        for (let count = matched; count > 0; count--) {
            const multiplier = tier[count];
            if (typeof multiplier === 'number' && multiplier > 0) return multiplier;
        }
        return 0;
    };
}

/**
 * The `matched` tier and nothing else — an undeclared count simply does not pay. The real engine's
 * convention, and what both bundled slot mechanics use.
 */
export function exactMultiplier(paytable: SymbolTierPaytable): PaytableLookup {
    return (symbol: number, matched: number): number => {
        const tier = paytable[symbol];
        if (tier === undefined || matched <= 0) return 0;
        const multiplier = tier[matched];
        return typeof multiplier === 'number' && multiplier > 0 ? multiplier : 0;
    };
}
