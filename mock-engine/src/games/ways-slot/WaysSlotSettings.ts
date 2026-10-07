// Ported from Libraries/Tombola.B2B.Arcade/GameSettings/Mystery243/ + Libraries/Games/TravellingWilds.
//
// The N-ways cousin of lines-slot: no winlines at all. A symbol pays once it appears on
// consecutive reels from reel 0, and the prize scales with the number of distinct ways it forms.

import { GameSettings } from '../../core/models/BaseArcadeResponse';
import { GameSettingsBase } from '../../settings/GameSettingsBase';

export type WaysSlotPrizeType = 'None' | 'StakeMultiplier' | 'Scatter' | 'Bonus';

export type WaysSlotDirection = 'LeftToRight' | 'RightToLeft';

export interface WaysSlotSymbolPosition {
    Reel: number;
    Row: number;
    Symbol: number;
}

export interface WaysSlotSymbolPrize {
    Matched: number;
    /** Stake multiplier PER WAY; the result multiplies it by the number of ways formed. */
    Multiplier: number;
    PrizeType: WaysSlotPrizeType;
}

export interface WaysSlotSymbol {
    Symbol: number;
    IsWild: boolean;
    IsBonus: boolean;
    Scattered: boolean;
    Prizes: WaysSlotSymbolPrize[];
}

export interface WaysSlotWayResult {
    Positions: WaysSlotSymbolPosition[];
    Symbol: number;
    Matched: number;
    /** Distinct symbol paths across the matched reels. */
    Ways: number;
    /** Already multiplied by Ways. */
    Multiplier: number;
    Prize: number;
    OutcomeType: WaysSlotPrizeType;
    Direction: WaysSlotDirection;
}

/** GameMessage.ScatterResult: the scatter pay and the bonus trigger folded into one object. */
export interface WaysSlotScatterResult {
    Positions: WaysSlotSymbolPosition[];
    OutcomeType: WaysSlotPrizeType;
    Count: number;
    Symbol: number;
    Multiplier: number;
    Prize: number;
    Bonus: boolean;
}

/** GameMessage.BonusSpin: the most recent free spin. */
export interface WaysSlotBonusSpin {
    Stops: number[];
    DisplayReels: number[][];
    Number: number;
    Remaining: number;
    BonusPayout: number;
    TotalBonusPayout: number;
    Results: WaysSlotWayResult[];
    /** Per reel: is the whole visible column the wild symbol? The travelling-wild tell. */
    StackedWildReel: boolean[];
}

export interface WaysConfig {
    /** Reels a symbol must reach, counting from the first, before it pays. */
    MinMatch: number;
    /** Also evaluate right-to-left, doubling the way count on a 243-ways board to 1024. */
    PayBothWays: boolean;
}

export interface WaysSlotBonusSettings {
    Reels: number[][];
    InitialBonusSpins: number;
}

export class WaysSlotSettings extends GameSettingsBase {
    ColumnHeight = 3;
    BufferSize = 0;
    Reels: number[][] = [];
    Ways: WaysConfig = { MinMatch: 3, PayBothWays: false };
    Symbols: WaysSlotSymbol[] = [];
    WildSymbol = 1;
    ScatterSymbol = 9;
    BonusSymbol = 10;
    BonusSettings: WaysSlotBonusSettings = { Reels: [], InitialBonusSpins: 0 };
}

/** The GameSettings block on the wire; field names are the editor's canonical arcade envelope. */
export class WaysSlotResponseGameSettings extends GameSettings {
    Reels: number[][] = [];
    BonusSpinReels: number[][] = [];
    Symbols: WaysSlotSymbol[] = [];
    WildSymbol: number | null = null;
    ScatterSymbol: number | null = null;
    BonusSymbol: number | null = null;
    Ways: WaysConfig = { MinMatch: 3, PayBothWays: false };
    /** Total ways the board can form, for a client that wants to print "243 WAYS". */
    TotalWays = 0;
    RTP = '';
}

function symbol(
    id: number,
    prizes: Array<[matched: number, multiplier: number]>,
    flags: { wild?: boolean; bonus?: boolean; scattered?: boolean } = {},
): WaysSlotSymbol {
    const prizeType: WaysSlotPrizeType = flags.bonus === true ? 'Bonus' : flags.scattered === true ? 'Scatter' : 'StakeMultiplier';

    return {
        Symbol: id,
        IsWild: flags.wild === true,
        IsBonus: flags.bonus === true,
        Scattered: flags.scattered === true,
        Prizes: prizes.map(([Matched, Multiplier]) => ({ Matched, Multiplier, PrizeType: prizeType })),
    };
}

/** A playable 5x3 243-ways default: symbol 1 is wild, 9 scatters, 10 triggers 10 free spins. */
export function createDefaultWaysSlotSettings(): WaysSlotSettings {
    const settings = new WaysSlotSettings();

    settings.ActiveVersion = '95.00';
    settings.Rtp = 95;
    settings.StakeOptions = [25, 50, 100, 200, 500];
    settings.DefaultStake = 25;
    settings.WinMultipliers = [50, 20, 15, 10, 6, 4, 2, 1];
    settings.AnnounceWinnerMultipliers = [500];
    settings.Ways = { MinMatch: 3, PayBothWays: false };

    settings.Reels = [
        [3, 6, 2, 8, 1, 5, 4, 7, 2, 9, 6, 3, 10, 8, 5, 2, 7, 4, 6, 3, 8, 1, 5, 2, 10, 7, 4, 6, 9, 3],
        [7, 2, 5, 3, 8, 1, 6, 4, 9, 2, 5, 7, 10, 3, 8, 6, 4, 2, 1, 5, 9, 7, 3, 8, 10, 6, 2, 4, 5, 7],
        [5, 8, 3, 6, 2, 7, 1, 4, 9, 8, 3, 5, 10, 6, 2, 4, 7, 8, 1, 3, 9, 5, 6, 2, 10, 4, 7, 8, 3, 5],
        [2, 4, 7, 5, 3, 8, 6, 1, 9, 4, 7, 2, 10, 5, 3, 8, 6, 4, 1, 7, 9, 2, 5, 3, 10, 8, 6, 7, 4, 2],
        [8, 5, 6, 2, 7, 3, 4, 1, 9, 5, 2, 8, 10, 7, 6, 3, 4, 5, 1, 2, 9, 8, 7, 6, 10, 3, 4, 2, 5, 8],
    ];

    settings.Symbols = [
        symbol(1, [[3, 4], [4, 20], [5, 100]], { wild: true }),
        symbol(2, [[3, 1.6], [4, 6], [5, 30]]),
        symbol(3, [[3, 1.2], [4, 4], [5, 20]]),
        symbol(4, [[3, 0.8], [4, 3], [5, 15]]),
        symbol(5, [[3, 0.6], [4, 2], [5, 10]]),
        symbol(6, [[3, 0.4], [4, 1.6], [5, 8]]),
        symbol(7, [[3, 0.3], [4, 1.2], [5, 6]]),
        symbol(8, [[3, 0.2], [4, 0.8], [5, 4]]),
        symbol(9, [[3, 2], [4, 10], [5, 50]], { scattered: true }),
        symbol(10, [[3, 0], [4, 0], [5, 0]], { bonus: true }),
    ];

    settings.BonusSettings = {
        InitialBonusSpins: 10,
        // Wild-heavy strips, so stacked wild reels actually show up during the feature.
        Reels: [
            [1, 1, 5, 3, 7, 2, 6, 8, 9, 4, 1, 1, 3, 5, 2, 7, 8, 6, 9, 4, 1, 1, 2, 3, 5, 6, 7, 8, 4, 2],
            [4, 1, 1, 6, 2, 8, 3, 5, 9, 7, 2, 1, 1, 4, 6, 3, 5, 8, 9, 2, 7, 1, 1, 6, 3, 4, 5, 8, 2, 6],
            [6, 3, 1, 1, 8, 5, 2, 4, 9, 7, 3, 6, 1, 1, 2, 8, 4, 5, 9, 3, 7, 6, 1, 1, 8, 2, 4, 5, 3, 7],
            [8, 5, 2, 1, 1, 6, 4, 3, 9, 2, 5, 8, 7, 1, 1, 4, 6, 3, 9, 5, 2, 8, 7, 1, 1, 6, 4, 3, 5, 2],
            [2, 7, 4, 6, 1, 1, 8, 5, 9, 3, 7, 2, 4, 6, 1, 1, 5, 8, 9, 7, 3, 2, 4, 6, 1, 1, 8, 5, 7, 3],
        ],
    };

    return settings;
}
