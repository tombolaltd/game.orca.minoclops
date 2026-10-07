// Win-evaluation types, ported from the game-studio prototyping harness'
// `proto-design-system/src/evaluation/types.ts`.
//
// The single architectural rule this module encodes:
//
//     PRIZES MUST BE A FUNCTION OF THE VISIBLE GRID.
//
// The harness' first quad-meter shipped a fake correlation — the prize was rolled independently of
// the symbols and the highlight code drew the middle row regardless — and a player reads that
// disconnect inside seconds. Every evaluator here is a pure function of grid + paytable, and every
// win's `Positions` is a non-empty subset of the visible grid.
//
// ⚠️ PROTOTYPING ONLY, like the rest of this engine: not RNG-certified, not audited. These are
// correct, reusable building blocks — they are not a certified maths model.
//
// MOCK: two deliberate deviations from the source.
//   - Symbols are numeric ids, not the harness' string `SymbolId`, matching every wire shape here.
//   - `ReelStripSpec` is NOT ported: it describes strips for a browser reel component
//     (`SpinningReelSet.attachStrips()`), and the engine's strips live on each mechanic's settings
//     as `Reels: number[][]`. Keeping the browser types out is why the source barrel was importable
//     server-side in the first place, and that discipline is preserved here.

/** One contributing cell of a win. `Reel` is the column, `Row` the position within it. */
export interface SymbolPosition {
    Reel: number;
    Row: number;
    Symbol: number;
}

/**
 * Stake multiplier for `matched` of `symbol`. Return 0 (or any non-positive value) for "no pay" —
 * every evaluator treats that as "this symbol does not pay at this count".
 *
 * Injected rather than fixed, so a mechanic keeps its own paytable shape and there is exactly one
 * copy of the RUN-DETECTION maths. {@link tieredMultiplier} and {@link exactMultiplier} build one
 * from a plain record.
 */
export type PaytableLookup = (symbol: number, matched: number) => number;

/** `paytable[symbol][matched] = stake multiplier`. The declarative form a prototype usually wants. */
export interface SymbolTierPaytable {
    readonly [symbol: number]: { readonly [matched: number]: number } | undefined;
}

/** A single paying payline. */
export interface LineWin {
    /** Non-empty subset of the visible grid — the cells a client highlights. */
    Positions: SymbolPosition[];
    Symbol: number;
    /** Contributing reels, counting from the first. */
    Matched: number;
    /** Stake multiplier awarded. */
    Multiplier: number;
    /** 1-based, as the engine sends it. */
    WinLineId: number;
}

export interface LineEvaluation {
    Wins: LineWin[];
    /** Sum of `Multiplier` across every win. */
    TotalMultiplier: number;
}

export type WaysDirection = 'LeftToRight' | 'RightToLeft';

/** What a wild in the LEADING reel is allowed to start. */
export type WildLeadPolicy =
    /** A wild anywhere in the leading reel can start any of `payingSymbols`. The engine's own rule. */
    | 'any-paying-symbol'
    /** Only an ALL-wild leading reel leads, and only as the wild itself. The source harness' rule. */
    | 'wild-only';

/** A single paying symbol path set. */
export interface WaysWin {
    /** Non-empty subset of the visible grid — the cells a client highlights. */
    Positions: SymbolPosition[];
    Symbol: number;
    /** Consecutive reels covered, counting from the leading one. */
    Matched: number;
    /** Distinct symbol paths across the matched reels. */
    Ways: number;
    /** Stake multiplier awarded, ALREADY multiplied by `Ways`. */
    Multiplier: number;
    Direction: WaysDirection;
}

export interface WaysEvaluation {
    Wins: WaysWin[];
    /** Sum of `Multiplier` across every win. */
    TotalMultiplier: number;
}

export interface LineEvaluationOptions {
    /** The visible grid, column-major: `reels[reel][row]`. A mechanic's `getDisplayedReels()` output. */
    reels: readonly (readonly number[])[];
    /** One entry per winline; each entry is a row index per reel. */
    winlines: readonly (readonly number[])[];
    multiplierFor: PaytableLookup;
    wildSymbol: number;
    /**
     * Can this symbol carry a line win at all? Scatters and bonus symbols answer false, so they
     * neither lead a line nor get adopted by a wild run. Default: every symbol.
     */
    paysOnLine?: (symbol: number) => boolean;
    /**
     * Pay the better of "N wilds" and "N of the symbol the wild run adopted", the engine's rule.
     * Default false — the wild run only ever pays as its adopted symbol.
     */
    wildRunPays?: boolean;
    /** Multiplies every awarded multiplier, e.g. a global free-spin multiplier. Default 1. */
    multiplier?: number;
}

export interface WaysEvaluationOptions {
    /** The visible grid, column-major: `reels[reel][row]`. A mechanic's `getDisplayedReels()` output. */
    reels: readonly (readonly number[])[];
    multiplierFor: PaytableLookup;
    wildSymbol: number;
    /**
     * Can this symbol lead and carry a way? Scatters, bonus symbols and (by the engine's
     * convention) the wild itself answer false. Default: every symbol except `wildSymbol`.
     */
    paysOnWays?: (symbol: number) => boolean;
    /**
     * Every symbol a wild in the leading reel may stand in for. REQUIRED by
     * `wildLead: 'any-paying-symbol'` — the grid alone cannot reveal the symbol universe — and
     * unused by `'wild-only'`. Order is the candidate order, hence the `Wins` order.
     */
    payingSymbols?: readonly number[];
    /** Default `'wild-only'`, the source harness' behaviour. */
    wildLead?: WildLeadPolicy;
    /** Reels a symbol must reach before it pays. Default 3. */
    minMatch?: number;
    /** Default `'LeftToRight'`. Evaluate twice to pay both ways. */
    direction?: WaysDirection;
    /** Multiplies every awarded multiplier, e.g. a global free-spin multiplier. Default 1. */
    multiplier?: number;
}
