// evaluateWays — "ways" evaluator (a.k.a. "243 ways", "1024 ways"). No winlines: a symbol pays
// once it appears on consecutive reels from the leading one, and the prize scales with the number
// of distinct paths it forms.
//
// Ported from the game-studio prototyping harness' `proto-design-system/src/evaluation/
// evaluateWays.ts`, generalised so the rules the real engine adds are options rather than a second
// copy of the walk (see `wildLead` / `paysOnWays` / `direction`).
//
// Rules:
//   - Candidate leading symbols come from the leading reel; see {@link WildLeadPolicy} for what a
//     wild sitting there is allowed to start.
//   - For each candidate, walk the reels in order and collect every cell equal to the candidate OR
//     to the wild. Stop at the first reel with no hit.
//   - Award the LONGEST run that actually pays, at `multiplierFor(candidate, matched)` times the
//     product of the hit counts across those `matched` reels.
//   - Each candidate pays once. Wilds do not double-count as their own way — industry convention,
//     and why `paysOnWays` excludes the wild by default.
//
// Pay-both-ways is two calls, one per `direction`; the source harness only ever ran left to right.

import { SymbolPosition, WaysEvaluation, WaysEvaluationOptions, WaysWin, WildLeadPolicy } from './types';

const DEFAULT_MIN_MATCH = 3;

export function evaluateWays(options: WaysEvaluationOptions): WaysEvaluation {
    const { reels, multiplierFor, wildSymbol } = options;
    const paysOnWays = options.paysOnWays ?? ((symbol: number): boolean => symbol !== wildSymbol);
    const wildLead = options.wildLead ?? 'wild-only';
    const minMatch = options.minMatch ?? DEFAULT_MIN_MATCH;
    const direction = options.direction ?? 'LeftToRight';
    const multiplier = options.multiplier ?? 1;

    const wins: WaysWin[] = [];
    let totalMultiplier = 0;

    const order = reels.map((_, index) => index);
    if (direction === 'RightToLeft') order.reverse();
    if (order.length === 0) return { Wins: wins, TotalMultiplier: totalMultiplier };

    const candidates = leadingCandidates(reels[order[0]], wildSymbol, paysOnWays, wildLead, options.payingSymbols);

    for (const candidate of candidates) {
        const hitsPerReel: SymbolPosition[][] = [];

        for (const reel of order) {
            const column = reels[reel];
            const hits: SymbolPosition[] = [];
            for (let row = 0; row < column.length; row++) {
                const symbol = column[row];
                if (symbol === candidate || symbol === wildSymbol) hits.push({ Reel: reel, Row: row, Symbol: symbol });
            }

            if (hits.length === 0) break;
            hitsPerReel.push(hits);
        }

        // Longest PAYING run wins: a 5-reel run with no 5-of-a-kind prize still pays its 4 or 3.
        // Under `tieredMultiplier` the full run always pays, so this trims nothing and the product
        // spans every reel of the run — the source harness' behaviour.
        for (let matched = hitsPerReel.length; matched >= minMatch; matched--) {
            const tierMultiplier = multiplierFor(candidate, matched) * multiplier;
            if (tierMultiplier <= 0) continue;

            const covered = hitsPerReel.slice(0, matched);
            const ways = covered.reduce((total, hits) => total * hits.length, 1);

            wins.push({
                Positions: covered.reduce<SymbolPosition[]>((all, hits) => all.concat(hits), []),
                Symbol: candidate,
                Matched: matched,
                Ways: ways,
                Multiplier: tierMultiplier * ways,
                Direction: direction,
            });
            totalMultiplier += tierMultiplier * ways;
            break;
        }
    }

    return { Wins: wins, TotalMultiplier: totalMultiplier };
}

/** Insertion-ordered, so `Wins` order is the grid scan order then `payingSymbols` order. */
function leadingCandidates(
    leadingReel: readonly number[],
    wildSymbol: number,
    paysOnWays: (symbol: number) => boolean,
    wildLead: WildLeadPolicy,
    payingSymbols: readonly number[] | undefined,
): number[] {
    const candidates = new Set<number>();
    for (const symbol of leadingReel) if (paysOnWays(symbol)) candidates.add(symbol);

    if (wildLead === 'any-paying-symbol') {
        if (leadingReel.indexOf(wildSymbol) !== -1) for (const symbol of payingSymbols ?? []) if (paysOnWays(symbol)) candidates.add(symbol);
    } else if (leadingReel.length > 0 && leadingReel.every(symbol => symbol === wildSymbol)) {
        candidates.add(wildSymbol);
    }

    return Array.from(candidates);
}
