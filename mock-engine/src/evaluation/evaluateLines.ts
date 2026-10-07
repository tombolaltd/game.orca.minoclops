// evaluateLines — left-to-right payline evaluator with wild substitution.
//
// Ported from the game-studio prototyping harness' `proto-design-system/src/evaluation/
// evaluateLines.ts`, generalised so the two rules the real engine adds are options rather than a
// second copy of the walk (see `wildRunPays` / `paysOnLine`).
//
// Rules:
//   - Each payline picks one cell per reel: `reels[reel][winline[reel]]`.
//   - Walk left to right. The line symbol starts as the leftmost cell; a wild-led line ADOPTS the
//     first paying symbol it reaches.
//   - Count the leading run of cells equal to the line symbol OR to the wild.
//   - `multiplierFor(lineSymbol, matched)` decides whether that run pays, and how much.
//   - With `wildRunPays`, the leading run of wilds is ALSO priced as a wild win and the better of
//     the two is awarded — the engine's rule, and the reason a 3-wild opener can out-pay the
//     5-of-a-kind it adopted.

import { LineEvaluation, LineEvaluationOptions, LineWin, SymbolPosition } from './types';

/** Stand-in for a cell a ragged winline points off the grid. Matches nothing, so the run just ends. */
const MISSING_SYMBOL = -1;

/**
 * MOCK: the source throws when a payline's length disagrees with the grid. A hand-authored
 * prototype's settings are routinely ragged mid-edit, so a short winline is simply evaluated over
 * the reels it does cover and an over-long one runs into {@link MISSING_SYMBOL} and stops.
 */
export function evaluateLines(options: LineEvaluationOptions): LineEvaluation {
    const { reels, winlines, multiplierFor, wildSymbol } = options;
    const paysOnLine = options.paysOnLine ?? ((): boolean => true);
    const wildRunPays = options.wildRunPays === true;
    const multiplier = options.multiplier ?? 1;

    const wins: LineWin[] = [];
    let totalMultiplier = 0;

    for (let winlineIndex = 0; winlineIndex < winlines.length; winlineIndex++) {
        const winline = winlines[winlineIndex];
        const line: number[] = [];
        for (let reel = 0; reel < winline.length; reel++) line.push(reels[reel]?.[winline[reel]] ?? MISSING_SYMBOL);
        if (line.length === 0) continue;

        let lineSymbol = line[0];
        if (!paysOnLine(lineSymbol)) continue;

        let wildCount = 0;
        let wildRunBroken = false;
        let matched = 0;

        for (const symbol of line) {
            if (!wildRunBroken) {
                if (lineSymbol === wildSymbol && symbol === wildSymbol) wildCount++;
                else wildRunBroken = true;
            }

            // A wild-led line adopts the first real symbol it reaches.
            if (lineSymbol !== symbol && lineSymbol === wildSymbol && paysOnLine(symbol)) lineSymbol = symbol;

            if (symbol === wildSymbol || symbol === lineSymbol) matched++;
            else break;
        }

        const wildMultiplier = wildRunPays ? multiplierFor(wildSymbol, wildCount) * multiplier : 0;
        const symbolMultiplier = multiplierFor(lineSymbol, matched) * multiplier;

        if (wildMultiplier > symbolMultiplier && wildMultiplier > 0) {
            wins.push(buildLineWin(winline, line, wildSymbol, wildCount, wildMultiplier, winlineIndex + 1));
            totalMultiplier += wildMultiplier;
        } else if (symbolMultiplier > 0) {
            wins.push(buildLineWin(winline, line, lineSymbol, matched, symbolMultiplier, winlineIndex + 1));
            totalMultiplier += symbolMultiplier;
        }
    }

    return { Wins: wins, TotalMultiplier: totalMultiplier };
}

function buildLineWin(
    winline: readonly number[],
    line: readonly number[],
    symbol: number,
    matched: number,
    multiplier: number,
    winLineId: number,
): LineWin {
    const positions: SymbolPosition[] = [];
    for (let reel = 0; reel < matched; reel++) positions.push({ Reel: reel, Row: winline[reel], Symbol: line[reel] });

    return { Positions: positions, Symbol: symbol, Matched: matched, Multiplier: multiplier, WinLineId: winLineId };
}
