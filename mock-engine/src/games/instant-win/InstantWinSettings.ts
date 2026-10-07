// Ported from Libraries/Tombola.B2B.Arcade/GameSettings/{Tap,MultiScratch}/ + Libraries/Games/Tap.
//
// No reels: a card of RevealCount cells is dealt, and a prize symbol that lands MatchesToWin times
// pays its stake multiplier. Hit rate is set by the prize weights, not by the deal, exactly as
// TapLogicHandler.ProcessRngRequest plants a winner first and fills the rest with near misses.

import { GameSettings } from '../../core/models/BaseArcadeResponse';
import { GameSettingsBase } from '../../settings/GameSettingsBase';

export type InstantWinPrizeType = 'None' | 'StakeMultiplier';

export interface InstantWinSymbolPosition {
    /** The card cell index. Named Reel so the position shape matches the slot mechanics. */
    Reel: number;
    Row: number;
    Symbol: number;
}

export interface InstantWinSymbolPrize {
    Matched: number;
    Multiplier: number;
    PrizeType: InstantWinPrizeType;
}

/** The wire shape of a prize, mirroring a slot's symbol payout table. */
export interface InstantWinSymbol {
    Symbol: number;
    Label: string;
    IsWild: boolean;
    IsBonus: boolean;
    Scattered: boolean;
    Prizes: InstantWinSymbolPrize[];
}

export interface InstantWinResult {
    Positions: InstantWinSymbolPosition[];
    Symbol: number;
    Label: string;
    Matched: number;
    Multiplier: number;
    Prize: number;
    OutcomeType: InstantWinPrizeType;
    WinLineId: number;
}

/** Emitted zeroed so the canonical envelope's ScatterResult path resolves on every response. */
export interface InstantWinScatterResult {
    Positions: InstantWinSymbolPosition[];
    OutcomeType: InstantWinPrizeType;
    Count: number;
    Symbol: number | null;
    Multiplier: number;
    Prize: number;
    Bonus: boolean;
}

/** Emitted zeroed: the mechanic always completes on begin, so there is never a bonus spin. */
export interface InstantWinBonusSpin {
    Stops: number[];
    DisplayReels: number[][];
    Number: number;
    Remaining: number;
    BonusPayout: number;
    TotalBonusPayout: number;
    Results: InstantWinResult[];
    StackedWildReel: boolean[];
}

export interface InstantWinPrizeDefinition {
    Symbol: number;
    Label: string;
    /** Stake multiplier awarded when MatchesToWin copies land. */
    Multiplier: number;
    MatchesToWin: number;
    /** Relative chance of being planted, weighed against LosingWeight. */
    Weight: number;
}

export class InstantWinSettings extends GameSettingsBase {
    /** Cells on the card. */
    RevealCount = 9;
    /** How many prizes may be planted on one card. */
    MaxWins = 1;
    /** Weight of "no prize planted", against the sum of every prize Weight. */
    LosingWeight = 6000;
    /** Fills a card the near-miss pool cannot; never appears in the prize table. */
    BlankSymbol = 0;
    Prizes: InstantWinPrizeDefinition[] = [];
}

/** The GameSettings block on the wire; field names are the editor's canonical arcade envelope. */
export class InstantWinResponseGameSettings extends GameSettings {
    /** Always empty: the mechanic has no reels. Present so the canonical response paths resolve. */
    Reels: number[][] = [];
    BonusSpinReels: number[][] = [];
    Symbols: InstantWinSymbol[] = [];
    WildSymbol: number | null = null;
    ScatterSymbol: number | null = null;
    RevealCount = 0;
    RTP = '';
}

/** The prize table as symbol payout data, so `symbolPayoutData` maps the same way as a slot's. */
export function toInstantWinSymbols(settings: InstantWinSettings): InstantWinSymbol[] {
    return settings.Prizes.map(prize => ({
        Symbol: prize.Symbol,
        Label: prize.Label,
        IsWild: false,
        IsBonus: false,
        Scattered: false,
        Prizes: [{ Matched: prize.MatchesToWin, Multiplier: prize.Multiplier, PrizeType: 'StakeMultiplier' as InstantWinPrizeType }],
    }));
}

/** A playable 9-cell, match-3 scratch default with an 8-prize ladder. */
export function createDefaultInstantWinSettings(): InstantWinSettings {
    const settings = new InstantWinSettings();

    settings.ActiveVersion = '95.00';
    settings.Rtp = 95;
    settings.StakeOptions = [25, 50, 100, 200, 500];
    settings.DefaultStake = 25;
    settings.WinMultipliers = [500, 100, 50, 20, 10, 5, 2, 1];
    settings.AnnounceWinnerMultipliers = [500];

    settings.RevealCount = 9;
    settings.MaxWins = 1;
    settings.LosingWeight = 6000;
    settings.BlankSymbol = 0;

    settings.Prizes = [
        { Symbol: 1, Label: 'Jackpot', Multiplier: 500, MatchesToWin: 3, Weight: 1 },
        { Symbol: 2, Label: 'Diamond', Multiplier: 100, MatchesToWin: 3, Weight: 8 },
        { Symbol: 3, Label: 'Crown', Multiplier: 50, MatchesToWin: 3, Weight: 25 },
        { Symbol: 4, Label: 'Ruby', Multiplier: 20, MatchesToWin: 3, Weight: 80 },
        { Symbol: 5, Label: 'Bell', Multiplier: 10, MatchesToWin: 3, Weight: 200 },
        { Symbol: 6, Label: 'Star', Multiplier: 5, MatchesToWin: 3, Weight: 500 },
        { Symbol: 7, Label: 'Cherry', Multiplier: 2, MatchesToWin: 3, Weight: 1200 },
        { Symbol: 8, Label: 'Coin', Multiplier: 1, MatchesToWin: 3, Weight: 2000 },
    ];

    return settings;
}
