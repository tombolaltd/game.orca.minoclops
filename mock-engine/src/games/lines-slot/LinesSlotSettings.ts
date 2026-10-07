// Ported from Libraries/Tombola.B2B.Arcade/GameSettings/Scatter/{ScatterGameSettings,ScatterSettings_95_03}.cs.
//
// Everything a designer would tune lives here: a new lines-slot prototype is a settings object,
// never new code. The model types are declared alongside the settings exactly as the C# declares
// them inside the mechanic's own GameSettings namespace.

import { GameSettings } from '../../core/models/BaseArcadeResponse';
import { GameSettingsBase } from '../../settings/GameSettingsBase';

export type LinesSlotPrizeType = 'None' | 'StakeMultiplier' | 'Scatter' | 'Bonus';

export interface LinesSlotSymbolPosition {
    Reel: number;
    Row: number;
    Symbol: number;
}

export interface LinesSlotSymbolPrize {
    Matched: number;
    /** Stake multiplier. Fractional values are allowed; the payout is truncated to minor units. */
    Multiplier: number;
    PrizeType: LinesSlotPrizeType;
}

export interface LinesSlotSymbol {
    Symbol: number;
    IsWild: boolean;
    IsBonus: boolean;
    Scattered: boolean;
    Prizes: LinesSlotSymbolPrize[];
}

export interface LinesSlotLineResult {
    Positions: LinesSlotSymbolPosition[];
    Symbol: number;
    Matched: number;
    Multiplier: number;
    Prize: number;
    OutcomeType: LinesSlotPrizeType;
    /** 1-based, as the engine sends it. */
    WinLineId: number;
}

/** GameMessage.ScatterResult: the scatter pay and the bonus trigger folded into one object. */
export interface LinesSlotScatterResult {
    /** Every scatter AND bonus symbol on screen — the positions a client highlights. */
    Positions: LinesSlotSymbolPosition[];
    OutcomeType: LinesSlotPrizeType;
    /** Scatter symbols only. */
    Count: number;
    Symbol: number;
    Multiplier: number;
    Prize: number;
    Bonus: boolean;
}

/** GameMessage.BonusSpin: the most recent free spin. */
export interface LinesSlotBonusSpin {
    Stops: number[];
    DisplayReels: number[][];
    /** 1-based spin number; 0 before the first free spin has been requested. */
    Number: number;
    Remaining: number;
    BonusPayout: number;
    TotalBonusPayout: number;
    Results: LinesSlotLineResult[];
    /** Per reel: is the whole visible column the wild symbol? */
    StackedWildReel: boolean[];
}

export interface LinesSlotBonusSettings {
    Reels: number[][];
    InitialBonusSpins: number;
}

export class LinesSlotSettings extends GameSettingsBase {
    ColumnHeight = 3;
    /** Trailing strip positions a stop may not land on. The mock wraps its window, so 0 is safe. */
    BufferSize = 0;
    Reels: number[][] = [];
    /** One entry per winline; each entry is a row index per reel. */
    Winlines: number[][] = [];
    Symbols: LinesSlotSymbol[] = [];
    WildSymbol = 1;
    ScatterSymbol = 9;
    BonusSymbol = 10;
    BonusSettings: LinesSlotBonusSettings = { Reels: [], InitialBonusSpins: 0 };
}

/** The GameSettings block on the wire; field names are the editor's canonical arcade envelope. */
export class LinesSlotResponseGameSettings extends GameSettings {
    Reels: number[][] = [];
    BonusSpinReels: number[][] = [];
    Winlines: number[][] = [];
    Symbols: LinesSlotSymbol[] = [];
    WildSymbol: number | null = null;
    ScatterSymbol: number | null = null;
    BonusSymbol: number | null = null;
    /** The engine sends RTP as a string; the base class's numeric `Rtp` is kept for parity. */
    RTP = '';
}

function symbol(
    id: number,
    prizes: Array<[matched: number, multiplier: number]>,
    flags: { wild?: boolean; bonus?: boolean; scattered?: boolean } = {},
): LinesSlotSymbol {
    const prizeType: LinesSlotPrizeType = flags.bonus === true ? 'Bonus' : flags.scattered === true ? 'Scatter' : 'StakeMultiplier';

    return {
        Symbol: id,
        IsWild: flags.wild === true,
        IsBonus: flags.bonus === true,
        Scattered: flags.scattered === true,
        Prizes: prizes.map(([Matched, Multiplier]) => ({ Matched, Multiplier, PrizeType: prizeType })),
    };
}

/**
 * A playable 5x3, 5-line default: symbol 1 is wild, 9 scatters, 10 triggers 8 free spins.
 * Self-consistent, so `new MockEngine()` spins sensibly with no configuration at all.
 */
export function createDefaultLinesSlotSettings(): LinesSlotSettings {
    const settings = new LinesSlotSettings();

    settings.ActiveVersion = '95.00';
    settings.Rtp = 95;
    settings.StakeOptions = [25, 50, 100, 200, 500];
    settings.DefaultStake = 25;
    settings.WinMultipliers = [250, 50, 40, 25, 20, 15, 10, 5];
    settings.AnnounceWinnerMultipliers = [500];

    settings.Reels = [
        [2, 5, 3, 7, 1, 4, 6, 8, 2, 9, 5, 3, 10, 6, 4, 7, 2, 8, 5, 3, 6, 1, 4, 7, 10, 2, 8, 5, 9, 3],
        [6, 3, 8, 2, 5, 1, 7, 4, 9, 3, 2, 6, 10, 5, 8, 3, 7, 1, 4, 2, 9, 6, 5, 3, 10, 8, 7, 4, 2, 6],
        [4, 7, 2, 6, 3, 8, 1, 5, 9, 2, 7, 4, 10, 3, 6, 8, 5, 2, 1, 7, 9, 4, 3, 6, 10, 5, 8, 2, 7, 3],
        [8, 2, 5, 3, 7, 6, 4, 1, 9, 8, 3, 2, 10, 7, 5, 4, 6, 3, 8, 1, 9, 2, 7, 5, 10, 3, 6, 4, 8, 2],
        [3, 6, 4, 8, 2, 7, 5, 1, 9, 6, 4, 3, 10, 8, 2, 5, 7, 6, 3, 1, 9, 8, 4, 2, 10, 7, 5, 6, 3, 8],
    ];

    settings.Winlines = [
        [1, 1, 1, 1, 1],
        [0, 0, 0, 0, 0],
        [2, 2, 2, 2, 2],
        [0, 1, 2, 1, 0],
        [2, 1, 0, 1, 2],
    ];

    settings.Symbols = [
        symbol(1, [[3, 10], [4, 50], [5, 250]], { wild: true }),
        symbol(2, [[3, 2], [4, 10], [5, 50]]),
        symbol(3, [[3, 1.5], [4, 8], [5, 40]]),
        symbol(4, [[3, 1], [4, 5], [5, 25]]),
        symbol(5, [[3, 0.8], [4, 4], [5, 20]]),
        symbol(6, [[3, 0.6], [4, 3], [5, 15]]),
        symbol(7, [[3, 0.4], [4, 2], [5, 10]]),
        symbol(8, [[3, 0.2], [4, 1], [5, 5]]),
        symbol(9, [[3, 2], [4, 10], [5, 50]], { scattered: true }),
        symbol(10, [[3, 0], [4, 0], [5, 0]], { bonus: true }),
    ];

    settings.BonusSettings = {
        InitialBonusSpins: 8,
        // No bonus symbol on the free-spin strips, so a bonus round cannot retrigger itself.
        Reels: [
            [1, 4, 2, 6, 3, 8, 5, 7, 9, 2, 1, 4, 6, 3, 5, 8, 2, 7, 9, 3, 1, 6, 4, 5, 8, 2, 7, 3, 6, 4],
            [5, 1, 3, 7, 2, 6, 4, 8, 9, 5, 3, 1, 7, 2, 4, 6, 8, 5, 9, 2, 3, 1, 6, 7, 4, 8, 5, 2, 3, 6],
            [2, 6, 1, 4, 8, 3, 7, 5, 9, 6, 2, 4, 1, 8, 3, 5, 7, 6, 9, 4, 2, 8, 1, 3, 5, 7, 6, 4, 2, 8],
            [7, 3, 5, 1, 6, 2, 8, 4, 9, 3, 5, 7, 2, 1, 6, 4, 8, 3, 9, 5, 7, 2, 4, 1, 6, 8, 3, 5, 7, 2],
            [4, 8, 6, 2, 1, 5, 3, 7, 9, 8, 6, 2, 4, 5, 1, 3, 7, 8, 9, 6, 4, 2, 5, 3, 1, 7, 8, 6, 4, 2],
        ],
    };

    return settings;
}
