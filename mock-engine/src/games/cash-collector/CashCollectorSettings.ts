// Ported from Libraries/Tombola.B2B.Arcade/GameSettings/CashCollector3/CashCollector3Settings_95_00.cs
// (+ the settings shapes in CashCollector3Models.cs and ICashCollector3Settings.cs).
//
// Cash Collector: a 6x4 ways slot where CASH symbols carry a stake-multiplied value and a
// COLLECTOR symbol on reel 1 or 6 banks every cash value on screen. Collectors come in four
// kinds — Standard, Lock & Spin, Cash Boost and Win Blast — and the kinds a player can land
// are UNLOCKED over time: every cash symbol that lands WITHOUT a collector fills a
// persistent progression meter (StateProgressionThresholds, cumulative), and each threshold
// crossed moves the player to the next state (StateVariations). 3+ scatters start a
// free-spin bonus whose collector tiers raise a cash multiplier and add spins.
//
// The reel strips, weights and tier tables are the 95.00 data, extracted verbatim.
//
// MOCK: two deliberate deviations from the C# 95.00 file.
//   - The six-scatter top prize is 500x (the game specification's figure); the C# carries 1000.
//   - Every (Weighting, Values) pair keeps the C# CUMULATIVE-threshold convention — draw
//     random(last) and take the first index whose threshold is above the draw — rather than
//     RandomHelpers.GetWeightedIndexAsync's per-entry weights, so the numbers stay comparable.
//
// ⚠️ PROTOTYPING ONLY, like the rest of this engine: not RNG-certified, not audited.

import { GameSettings } from '../../core/models/BaseArcadeResponse';
import { GameSettingsBase } from '../../settings/GameSettingsBase';

/** CollectorFeature, serialised by NAME as the real engine's JSON does. */
export type CashCollectorFeature = 'None' | 'Standard' | 'LockSpin' | 'CashBoost' | 'WinBlast';

export type CashCollectorOutcomeType = 'StakeMultiplier' | 'Bonus';

export interface CashCollectorSymbolPrize {
    Matched: number;
    OutcomeType: CashCollectorOutcomeType;
    /** Stake multiplier PER WAY for StakeMultiplier prizes; the scatter pay for Bonus ones. */
    Multiplier: number;
}

export interface CashCollectorSymbol {
    Symbol: number;
    IsWild?: boolean;
    Scattered?: boolean;
    Prizes: CashCollectorSymbolPrize[];
}

export interface CashCollectorNumCashSymbolWeights {
    NoFeatureWeighting: number[];
    StandardFeatureWeighting: number[];
}

export interface CashCollectorCashValueSettings {
    /** Stake multipliers a cash symbol can carry. */
    Values: number[];
    NoFeatureWeighting: number[];
    StandardFeatureWeighting: number[];
}

export interface CashCollectorCashBoostSettings {
    Multipliers: number[];
    Weighting: number[];
}

export interface CashCollectorLockRespinSettings {
    FinalNumSymbolChanceOneCollector: number[];
    FinalNumSymbolChanceTwoCollectors: number[];
    MinNumSymbols: number;
    MinSymbolsPerSpin: number;
    MaxSymbolsPerSpin: number;
}

export interface CashCollectorWinBlastSettings {
    MinCascades: number;
    CascadeChance: number[];
    WinBlastNumCashWeighting: number[];
    PositionJump: number;
}

export interface CashCollectorCollectionSettings {
    /** Percent chance (out of 100) that a spin carries collectors at all. */
    FeatureTriggerProbability: number;
    CollectorSymbolReels: number[];
    /** Cumulative thresholds over CashCollectorFeatures; set per state by setState(). */
    FeatureChances: number[];
    NoOfCashSymbolsChance: CashCollectorNumCashSymbolWeights;
    CashBoostSettings: CashCollectorCashBoostSettings;
    LockRespinSettings: CashCollectorLockRespinSettings;
    WinBlastSettings: CashCollectorWinBlastSettings;
}

export interface CashCollectorTier {
    Tier: number;
    MinCashSymbols: number;
    CashMultiplier: number;
    ExtraSpins: number;
}

export interface CashCollectorStateVariation {
    StateNumber: number;
    Reels: number[][];
    CollectorSymbolReels: number[];
    CashSymbolValueFeatureWeighting: number[];
    BaseGameFeatureChance: number[];
    BonusGameFeatureChance: number[];
}

export interface CashCollectorBonusSettings {
    Reels: number[][];
    CashCollectorSettings: CashCollectorCollectionSettings;
    CollectorTiers: CashCollectorTier[];
    /** Free spins before the scatter count is added. */
    InitialBaseSpin: number;
}

export class CashCollectorSettings extends GameSettingsBase {
    ColumnHeight = 4;
    BufferSize = 3;
    Reels: number[][] = [];
    Symbols: CashCollectorSymbol[] = [];
    WildSymbol = 1;
    ScatterSymbol = 2;
    CollectorSymbol = 14;
    CashSymbol = 15;
    /** Cumulative thresholds out of the last entry; the matching index IS the scatter count. */
    ScatterSymbolChance: number[] = [];
    MaxGameState = 5;
    /** Cumulative cash symbols needed to reach states 2..MaxGameState. */
    StateProgressionThresholds: number[] = [];
    CashValueSettings: CashCollectorCashValueSettings = { Values: [], NoFeatureWeighting: [], StandardFeatureWeighting: [] };
    CashCollectorSettings: CashCollectorCollectionSettings = emptyCollectionSettings();
    /** The collector combinations FeatureChances picks between. */
    CashCollectorFeatures: CashCollectorFeature[][] = [];
    StateVariations: CashCollectorStateVariation[] = [];
    BonusSettings: CashCollectorBonusSettings = { Reels: [], CashCollectorSettings: emptyCollectionSettings(), CollectorTiers: [], InitialBaseSpin: 1 };

    /** Port of SetState(): points the state-dependent fields at the given state's variation. */
    setState(state: number): void {
        const details = this.StateVariations.find(variation => variation.StateNumber === state);
        if (details === undefined) return;

        this.Reels = details.Reels;
        this.CashCollectorSettings.CollectorSymbolReels = details.CollectorSymbolReels;
        this.CashCollectorSettings.FeatureChances = details.BaseGameFeatureChance;
        this.CashValueSettings.StandardFeatureWeighting = details.CashSymbolValueFeatureWeighting;
        this.BonusSettings.CashCollectorSettings.FeatureChances = details.BonusGameFeatureChance;
    }
}

/** The GameSettings block on the wire. */
export class CashCollectorResponseGameSettings extends GameSettings {
    Symbols: CashCollectorSymbol[] = [];
    SpecialSymbols = { WildSymbol: 1, BonusSymbol: 2, CashSymbol: 15, CollectorSymbol: 14 };
    // MOCK: the next three are not sent by the real engine. They let a client draw the
    // progression meter and the bonus trail without hard-coding the maths.
    StateProgressionThresholds: number[] = [];
    MaxGameState = 5;
    CollectorTiers: CashCollectorTier[] = [];
    RTP = '';
}

function emptyCollectionSettings(): CashCollectorCollectionSettings {
    return {
        FeatureTriggerProbability: 0,
        CollectorSymbolReels: [],
        FeatureChances: [],
        NoOfCashSymbolsChance: { NoFeatureWeighting: [], StandardFeatureWeighting: [] },
        CashBoostSettings: { Multipliers: [], Weighting: [] },
        LockRespinSettings: {
            FinalNumSymbolChanceOneCollector: [],
            FinalNumSymbolChanceTwoCollectors: [],
            MinNumSymbols: 0,
            MinSymbolsPerSpin: 1,
            MaxSymbolsPerSpin: 1,
        },
        WinBlastSettings: { MinCascades: 0, CascadeChance: [], WinBlastNumCashWeighting: [], PositionJump: 0 },
    };
}

function paying(symbol: number, prizes: Array<[matched: number, multiplier: number]>): CashCollectorSymbol {
    return { Symbol: symbol, Prizes: prizes.map(([Matched, Multiplier]) => ({ Matched, OutcomeType: 'StakeMultiplier', Multiplier })) };
}

/** The 95.00 settings, already pointed at state 1 (a brand-new player). */
export function createDefaultCashCollectorSettings(): CashCollectorSettings {
    const settings = new CashCollectorSettings();

    settings.ActiveVersion = '95.00';
    settings.Rtp = 95;
    settings.StakeOptions = [10, 20, 50, 100];
    settings.DefaultStake = 10;
    settings.WinMultipliers = [];
    settings.AnnounceWinnerMultipliers = [500];

    settings.ColumnHeight = 4;
    settings.BufferSize = 3;
    settings.WildSymbol = 1;
    settings.ScatterSymbol = 2;
    settings.CollectorSymbol = 14;
    settings.CashSymbol = 15;
    settings.ScatterSymbolChance = [547530, 897530, 987530, 999110, 999940, 999980, 1000000];
    settings.MaxGameState = 5;
    settings.StateProgressionThresholds = [15, 65, 190, 390];

    settings.Symbols = [
        { Symbol: 1, IsWild: true, Prizes: [] },
        {
            Symbol: 2,
            Scattered: true,
            Prizes: [
                { Matched: 3, OutcomeType: 'Bonus', Multiplier: 0 },
                { Matched: 4, OutcomeType: 'Bonus', Multiplier: 0 },
                { Matched: 5, OutcomeType: 'Bonus', Multiplier: 0 },
                // Top prize. MOCK: 500x per the game specification (the C# 95.00 file carries 1000).
                { Matched: 6, OutcomeType: 'Bonus', Multiplier: 500 },
            ],
        },
        paying(3, [[2, 0.5], [3, 1], [4, 2], [5, 2.5], [6, 5]]),
        paying(4, [[2, 0.4], [3, 0.8], [4, 1.5], [5, 2], [6, 2.5]]),
        paying(5, [[2, 0.3], [3, 0.8], [4, 1.5], [5, 2], [6, 2.5]]),
        paying(6, [[2, 0.2], [3, 0.6], [4, 1.2], [5, 1.5], [6, 2]]),
        paying(7, [[2, 0.1], [3, 0.6], [4, 1.2], [5, 1.5], [6, 2]]),
        paying(8, [[3, 0.5], [4, 1], [5, 1.2], [6, 1.5]]),
        paying(9, [[3, 0.5], [4, 1], [5, 1.2], [6, 1.5]]),
        paying(10, [[3, 0.4], [4, 0.8], [5, 1], [6, 1.2]]),
        paying(11, [[3, 0.4], [4, 0.8], [5, 1], [6, 1.2]]),
        paying(12, [[3, 0.2], [4, 0.4], [5, 0.8], [6, 1]]),
        paying(13, [[3, 0.1], [4, 0.2], [5, 0.6], [6, 1]]),
    ];

    settings.CashValueSettings = {
        Values: [0.1, 0.2, 0.4, 0.6, 0.8, 1, 2],
        NoFeatureWeighting: [500, 800, 950, 980, 990, 997, 1000],
        StandardFeatureWeighting: [5355, 7355, 8355, 9155, 9655, 9900, 10000],
    };

    settings.CashCollectorFeatures = [
        ['Standard'],
        ['LockSpin'],
        ['CashBoost'],
        ['WinBlast'],
        ['Standard', 'Standard'],
        ['Standard', 'LockSpin'],
        ['Standard', 'CashBoost'],
        ['Standard', 'WinBlast'],
        ['LockSpin', 'LockSpin'],
        ['LockSpin', 'CashBoost'],
        ['LockSpin', 'WinBlast'],
        ['CashBoost', 'CashBoost'],
        ['CashBoost', 'WinBlast'],
        ['WinBlast', 'WinBlast'],
    ];

    settings.CashCollectorSettings = {
        FeatureTriggerProbability: 18,
        CollectorSymbolReels: [5],
        FeatureChances: [],
        NoOfCashSymbolsChance: {
            StandardFeatureWeighting: [50, 250, 700, 810, 880, 940, 980, 990, 996, 999, 1000],
            NoFeatureWeighting: [400, 620, 780, 900, 950, 980, 995, 1000],
        },
        CashBoostSettings: { Multipliers: [2, 3, 4], Weighting: [500, 850, 1000] },
        LockRespinSettings: {
            MinNumSymbols: 4,
            MaxSymbolsPerSpin: 4,
            MinSymbolsPerSpin: 1,
            FinalNumSymbolChanceOneCollector: [1, 4, 10, 20, 40, 70, 120, 200, 300, 420, 560, 710, 810, 890, 950, 990, 1000],
            FinalNumSymbolChanceTwoCollectors: [1, 4, 10, 20, 40, 100, 180, 280, 400, 550, 750, 900, 1000],
        },
        WinBlastSettings: {
            MinCascades: 2,
            CascadeChance: [250, 750, 1000],
            WinBlastNumCashWeighting: [1, 10, 40, 160, 340, 570, 740, 860, 940, 990, 1000],
            PositionJump: 11,
        },
    };

    settings.BonusSettings = {
        InitialBaseSpin: 1,
        CollectorTiers: [
            { Tier: 0, MinCashSymbols: 0, CashMultiplier: 1, ExtraSpins: 0 },
            { Tier: 1, MinCashSymbols: 15, CashMultiplier: 2, ExtraSpins: 3 },
            { Tier: 2, MinCashSymbols: 30, CashMultiplier: 3, ExtraSpins: 3 },
            { Tier: 3, MinCashSymbols: 45, CashMultiplier: 4, ExtraSpins: 3 },
            { Tier: 4, MinCashSymbols: 60, CashMultiplier: 5, ExtraSpins: 3 },
        ],
        Reels: [
            [
                13, 12, 4, 12, 11, 10, 3, 12, 11, 6, 13, 12, 10, 10, 13, 5, 11, 10, 9, 8, 9, 8, 11, 10,
                9, 8, 13, 11, 9, 11, 10, 9, 8, 7, 13, 8, 11, 10, 9, 8, 13, 12, 4
            ],
            [
                13, 4, 11, 12, 13, 5, 11, 10, 10, 13, 11, 12, 12, 8, 13, 4, 11, 3, 10, 8, 7, 13, 12, 11,
                10, 9, 8, 7, 6, 13, 12, 11, 10, 12, 8, 7, 6, 5, 11, 13, 13, 4, 11
            ],
            [
                6, 12, 11, 10, 9, 13, 12, 13, 10, 9, 8, 13, 10, 12, 5, 10, 8, 7, 13, 12, 11, 4, 10, 9,
                9, 7, 6, 5, 12, 3, 10, 5, 8, 7, 6, 1, 11, 11, 12, 6, 6, 12, 11
            ],
            [
                13, 12, 11, 10, 9, 8, 13, 12, 3, 10, 9, 8, 7, 13, 12, 11, 10, 9, 8, 7, 6, 13, 4, 3,
                10, 9, 11, 9, 7, 6, 5, 13, 12, 11, 3, 9, 8, 7, 1, 6, 13, 12, 11
            ],
            [
                13, 12, 11, 10, 9, 8, 7, 13, 12, 11, 10, 9, 10, 7, 6, 13, 12, 11, 10, 9, 1, 8, 7, 6,
                5, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 13, 12, 3, 11, 10, 13, 12, 11
            ],
            [
                13, 12, 11, 10, 9, 8, 7, 6, 13, 12, 11, 10, 9, 8, 7, 6, 5, 13, 12, 11, 1, 10, 9, 8,
                7, 6, 5, 4, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 5, 3, 13, 12, 11
            ],
        ],
        CashCollectorSettings: {
            FeatureTriggerProbability: 70,
            CollectorSymbolReels: [5],
            FeatureChances: [],
            NoOfCashSymbolsChance: {
                StandardFeatureWeighting: [10, 106, 266, 506, 706, 856, 956, 986, 996, 999, 1000],
                NoFeatureWeighting: [150, 350, 610, 830, 910, 960, 985, 1000],
            },
            CashBoostSettings: { Multipliers: [3, 4, 5], Weighting: [500, 850, 1000] },
            LockRespinSettings: {
                MinNumSymbols: 7,
                MaxSymbolsPerSpin: 4,
                MinSymbolsPerSpin: 1,
                FinalNumSymbolChanceOneCollector: [10, 30, 70, 120, 200, 300, 400, 500, 620, 750, 890, 950, 990, 1000],
                FinalNumSymbolChanceTwoCollectors: [0, 20, 80, 160, 260, 380, 530, 730, 880, 1000],
            },
            WinBlastSettings: {
                MinCascades: 3,
                CascadeChance: [250, 750, 1000],
                WinBlastNumCashWeighting: [1, 10, 20, 50, 170, 350, 580, 750, 870, 950, 1000],
                PositionJump: 11,
            },
        },
    };

    settings.StateVariations = [
        {
            StateNumber: 1,
            CollectorSymbolReels: [5],
            CashSymbolValueFeatureWeighting: [5355, 7355, 8355, 9155, 9655, 9900, 10000],
            BaseGameFeatureChance: [10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000],
            BonusGameFeatureChance: [10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000],
            Reels: [
                [
                    13, 12, 4, 9, 6, 10, 3, 9, 11, 10, 10, 8, 11, 10, 8, 7, 11, 10, 9, 8, 10, 9, 8, 10,
                    9, 8, 6, 10, 12, 7, 10, 9, 8, 7, 6, 9, 8, 10, 9, 8, 7, 6, 7, 12, 7, 10, 9, 8,
                    7, 6, 5, 13, 12, 11, 10, 9, 8, 11, 13, 12, 4
                ],
                [
                    9, 10, 9, 10, 10, 5, 11, 8, 9, 8, 11, 10, 10, 8, 9, 4, 7, 10, 12, 8, 7, 13, 10, 10,
                    11, 9, 8, 7, 6, 9, 3, 7, 10, 3, 8, 7, 6, 5, 11, 9, 3, 11, 12, 9, 8, 13, 7, 6,
                    5, 12, 13, 12, 11, 10, 4, 8, 7, 6, 5, 3, 9, 8, 11, 4, 9, 8, 7, 6, 13, 4, 9, 10,
                    9
                ],
                [
                    6, 8, 5, 10, 9, 9, 12, 13, 10, 9, 8, 11, 10, 11, 13, 10, 8, 7, 5, 9, 11, 13, 10, 9,
                    8, 7, 6, 11, 11, 3, 10, 7, 8, 7, 6, 1, 10, 10, 12, 6, 10, 9, 8, 7, 6, 5, 7, 12,
                    13, 12, 7, 10, 9, 8, 7, 6, 5, 4, 6, 8, 5
                ],
                [
                    10, 12, 11, 10, 9, 8, 13, 12, 3, 10, 13, 8, 7, 10, 12, 8, 10, 9, 8, 7, 6, 13, 4, 3,
                    10, 9, 12, 13, 7, 6, 5, 10, 7, 11, 3, 9, 8, 7, 1, 6, 5, 4, 7, 6, 11, 10, 9, 8,
                    7, 6, 5, 4, 3, 6, 7, 11, 10, 9, 11, 10, 10, 12, 11
                ],
                [
                    13, 12, 11, 10, 9, 8, 7, 6, 12, 11, 10, 9, 10, 7, 6, 13, 12, 11, 10, 9, 1, 8, 7, 6,
                    5, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 6, 12, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 13,
                    12, 11, 13, 12, 11
                ],
                [
                    13, 12, 11, 10, 9, 8, 7, 6, 13, 12, 9, 10, 9, 8, 7, 6, 5, 13, 12, 8, 1, 10, 9, 8,
                    7, 6, 5, 4, 13, 12, 8, 10, 9, 8, 7, 6, 5, 4, 12, 3, 13, 12, 11, 10, 9, 8, 7, 6,
                    11, 13, 12, 11
                ],
            ],
        },
        {
            StateNumber: 2,
            CollectorSymbolReels: [0, 5],
            CashSymbolValueFeatureWeighting: [5321, 7321, 8321, 9121, 9621, 9900, 10000],
            BaseGameFeatureChance: [9000, 9000, 9000, 9000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000],
            BonusGameFeatureChance: [5900, 5900, 5900, 5900, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000],
            Reels: [
                [
                    13, 12, 4, 9, 11, 10, 3, 9, 11, 10, 10, 8, 11, 10, 8, 7, 11, 10, 9, 8, 10, 9, 8, 10,
                    9, 8, 13, 10, 12, 7, 10, 9, 8, 7, 13, 9, 8, 10, 9, 8, 7, 6, 7, 12, 11, 10, 9, 8,
                    7, 6, 5, 13, 12, 11, 10, 9, 8, 11, 13, 12, 4
                ],
                [
                    9, 10, 9, 10, 10, 5, 11, 8, 9, 8, 11, 10, 10, 8, 9, 4, 7, 10, 12, 8, 7, 13, 10, 10,
                    11, 9, 8, 7, 6, 9, 3, 7, 10, 3, 8, 7, 6, 5, 11, 9, 3, 11, 12, 9, 8, 13, 7, 6,
                    5, 12, 13, 12, 11, 10, 4, 8, 7, 6, 5, 3, 9, 8, 11, 4, 9, 8, 7, 6, 13, 4, 9, 10,
                    11
                ],
                [
                    6, 8, 5, 10, 9, 9, 12, 13, 10, 9, 8, 11, 10, 11, 13, 10, 8, 7, 5, 9, 11, 13, 10, 9,
                    8, 7, 6, 11, 11, 3, 10, 7, 8, 7, 6, 1, 10, 10, 12, 6, 10, 9, 8, 7, 6, 5, 7, 12,
                    13, 12, 7, 10, 9, 8, 7, 6, 5, 4, 6, 8, 5
                ],
                [
                    10, 12, 11, 10, 9, 8, 13, 12, 3, 10, 13, 8, 7, 10, 12, 8, 10, 9, 8, 7, 6, 13, 4, 3,
                    10, 9, 12, 13, 7, 6, 5, 10, 7, 11, 3, 9, 8, 7, 1, 6, 5, 4, 7, 12, 11, 10, 9, 8,
                    7, 6, 5, 4, 3, 13, 7, 11, 10, 9, 11, 10, 10, 12, 11
                ],
                [
                    13, 12, 11, 10, 9, 8, 7, 13, 12, 11, 10, 9, 10, 7, 6, 13, 12, 11, 10, 9, 1, 8, 7, 6,
                    5, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 13, 12, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 13,
                    12, 11, 13, 12, 11
                ],
                [
                    13, 12, 11, 10, 9, 8, 7, 6, 13, 12, 9, 10, 9, 8, 7, 6, 5, 13, 12, 8, 1, 10, 9, 8,
                    7, 6, 5, 4, 13, 12, 8, 10, 9, 8, 7, 6, 5, 4, 12, 3, 13, 12, 11, 10, 9, 8, 7, 6,
                    11, 13, 12, 11
                ],
            ],
        },
        {
            StateNumber: 3,
            CollectorSymbolReels: [0, 5],
            CashSymbolValueFeatureWeighting: [5300, 7200, 8300, 9100, 9600, 9900, 10000],
            BaseGameFeatureChance: [6100, 9000, 9000, 9000, 9625, 9945, 9945, 9945, 10000, 10000, 10000, 10000, 10000, 10000],
            BonusGameFeatureChance: [2275, 7000, 7000, 7000, 7415, 8770, 8770, 8770, 10000, 10000, 10000, 10000, 10000, 10000],
            Reels: [
                [
                    13, 12, 4, 12, 11, 10, 3, 12, 11, 10, 13, 12, 11, 10, 13, 12, 11, 10, 9, 8, 13, 12, 11, 10,
                    9, 8, 13, 10, 12, 11, 10, 9, 8, 7, 13, 12, 11, 10, 9, 8, 7, 6, 13, 12, 11, 10, 9, 8,
                    7, 6, 5, 13, 12, 11, 10, 9, 8, 11, 13, 12, 4
                ],
                [
                    13, 4, 11, 10, 13, 5, 11, 12, 9, 12, 11, 10, 10, 8, 13, 4, 11, 10, 12, 8, 7, 13, 3, 11,
                    4, 9, 8, 7, 6, 13, 3, 11, 10, 3, 8, 7, 6, 5, 11, 13, 3, 11, 12, 9, 8, 13, 7, 6,
                    5, 4, 13, 3, 11, 10, 4, 8, 7, 6, 5, 3, 13, 12, 11, 4, 9, 8, 7, 6, 13, 4, 13, 4,
                    11
                ],
                [
                    6, 12, 5, 10, 9, 13, 12, 5, 10, 9, 8, 11, 10, 12, 5, 10, 8, 7, 5, 12, 11, 13, 10, 9,
                    8, 7, 6, 11, 12, 3, 10, 11, 8, 7, 6, 1, 5, 5, 12, 6, 10, 9, 8, 7, 6, 5, 7, 12,
                    13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 6, 12, 5
                ],
                [
                    13, 12, 11, 10, 9, 8, 13, 12, 3, 10, 13, 8, 7, 13, 12, 11, 10, 9, 8, 7, 6, 13, 4, 3,
                    10, 9, 12, 13, 7, 6, 5, 13, 12, 11, 3, 9, 8, 7, 1, 6, 5, 4, 13, 12, 11, 10, 9, 8,
                    7, 6, 5, 4, 3, 13, 12, 11, 10, 9, 11, 10, 13, 12, 11
                ],
                [
                    13, 12, 11, 10, 9, 8, 7, 13, 12, 11, 10, 9, 10, 7, 6, 13, 12, 11, 10, 9, 1, 8, 7, 6,
                    5, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 13, 12, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 13,
                    12, 11, 13, 12, 11
                ],
                [
                    13, 12, 11, 10, 9, 8, 7, 6, 13, 12, 11, 10, 9, 8, 7, 6, 5, 13, 12, 11, 1, 10, 9, 8,
                    7, 6, 5, 4, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 12, 3, 13, 12, 11, 10, 9, 8, 7, 6,
                    11, 13, 12, 11
                ],
            ],
        },
        {
            StateNumber: 4,
            CollectorSymbolReels: [0, 5],
            CashSymbolValueFeatureWeighting: [5326, 7300, 8300, 9100, 9600, 9900, 10000],
            BaseGameFeatureChance: [5200, 7200, 9000, 9000, 9610, 9740, 9920, 9920, 9950, 9975, 9975, 10000, 10000, 10000],
            BonusGameFeatureChance: [1500, 3900, 7000, 7000, 7415, 7615, 8515, 8515, 8815, 9575, 9575, 10000, 10000, 10000],
            Reels: [
                [
                    13, 12, 4, 12, 11, 10, 3, 12, 11, 10, 13, 12, 11, 10, 13, 12, 11, 10, 9, 8, 13, 12, 11, 10,
                    9, 8, 13, 10, 12, 11, 10, 9, 8, 7, 13, 12, 11, 10, 9, 8, 7, 6, 13, 12, 11, 10, 9, 8,
                    7, 6, 5, 13, 12, 11, 10, 9, 8, 11, 13, 12, 4
                ],
                [
                    13, 4, 11, 3, 13, 5, 11, 12, 9, 12, 11, 4, 3, 8, 13, 4, 11, 10, 12, 8, 7, 13, 3, 11,
                    4, 9, 8, 7, 6, 13, 3, 11, 10, 3, 8, 7, 6, 5, 11, 13, 3, 11, 12, 9, 8, 13, 7, 6,
                    5, 4, 13, 3, 11, 10, 4, 8, 7, 6, 5, 3, 13, 12, 11, 4, 9, 8, 7, 6, 13, 4, 13, 4,
                    11
                ],
                [
                    6, 12, 5, 10, 9, 13, 12, 5, 10, 9, 8, 5, 10, 12, 5, 10, 8, 7, 5, 12, 11, 13, 10, 9,
                    8, 7, 6, 5, 12, 3, 10, 5, 8, 7, 6, 1, 5, 5, 12, 6, 10, 9, 8, 7, 6, 5, 7, 12,
                    13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 6, 12, 5
                ],
                [
                    13, 12, 11, 10, 9, 8, 13, 12, 3, 10, 13, 8, 7, 13, 12, 11, 10, 9, 8, 7, 6, 13, 4, 3,
                    10, 9, 12, 13, 7, 6, 5, 13, 12, 11, 3, 9, 8, 7, 1, 6, 5, 4, 13, 12, 11, 10, 9, 8,
                    7, 6, 5, 4, 3, 13, 12, 11, 10, 9, 11, 10, 13, 12, 11
                ],
                [
                    13, 12, 11, 10, 9, 8, 7, 13, 12, 11, 10, 9, 10, 7, 6, 13, 12, 11, 10, 9, 1, 8, 7, 6,
                    5, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 13, 12, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 13,
                    12, 11, 13, 12, 11
                ],
                [
                    13, 12, 11, 10, 9, 8, 7, 6, 13, 12, 11, 10, 9, 8, 7, 6, 5, 13, 12, 11, 1, 10, 9, 8,
                    7, 6, 5, 4, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 12, 3, 13, 12, 11, 10, 9, 8, 7, 6,
                    11, 13, 12, 11
                ],
            ],
        },
        {
            StateNumber: 5,
            CollectorSymbolReels: [0, 5],
            CashSymbolValueFeatureWeighting: [5280, 7300, 8300, 9100, 9600, 9900, 10000],
            BaseGameFeatureChance: [5300, 6500, 8200, 9000, 9620, 9670, 9850, 9930, 9950, 9970, 9975, 9980, 9995, 10000],
            BonusGameFeatureChance: [1600, 3400, 5700, 7000, 7417, 7617, 7817, 8517, 8817, 9417, 9577, 9700, 9860, 10000],
            Reels: [
                [
                    13, 12, 4, 12, 11, 10, 3, 12, 11, 10, 13, 12, 11, 10, 13, 12, 11, 10, 9, 8, 13, 12, 11, 10,
                    9, 8, 13, 10, 12, 11, 10, 9, 8, 7, 13, 12, 11, 10, 9, 8, 7, 6, 13, 12, 11, 10, 9, 8,
                    7, 6, 5, 13, 12, 11, 10, 9, 8, 11, 13, 12, 4
                ],
                [
                    13, 4, 11, 3, 13, 5, 11, 4, 13, 12, 11, 4, 3, 8, 13, 4, 11, 3, 4, 8, 7, 13, 3, 11,
                    4, 9, 8, 7, 6, 13, 3, 11, 10, 3, 8, 7, 6, 5, 11, 13, 3, 11, 4, 9, 8, 13, 7, 6,
                    5, 4, 13, 3, 11, 10, 4, 8, 7, 6, 5, 3, 13, 12, 11, 4, 9, 8, 7, 6, 13, 4, 13, 4,
                    11
                ],
                [
                    6, 12, 5, 10, 9, 13, 12, 5, 10, 9, 8, 5, 10, 12, 5, 10, 8, 7, 5, 12, 11, 13, 10, 9,
                    8, 7, 6, 5, 12, 3, 10, 5, 8, 7, 6, 1, 5, 5, 12, 6, 10, 9, 8, 7, 6, 5, 7, 12,
                    13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 6, 12, 5
                ],
                [
                    13, 12, 11, 10, 9, 8, 13, 12, 3, 10, 9, 8, 7, 13, 12, 11, 10, 9, 8, 7, 6, 13, 4, 3,
                    10, 9, 12, 9, 7, 6, 5, 13, 12, 11, 3, 9, 8, 7, 1, 6, 5, 4, 13, 12, 11, 10, 9, 8,
                    7, 6, 5, 4, 3, 13, 12, 11, 10, 9, 11, 10, 13, 12, 11
                ],
                [
                    13, 12, 11, 10, 9, 8, 7, 13, 12, 11, 10, 9, 10, 7, 6, 13, 12, 11, 10, 9, 1, 8, 7, 6,
                    5, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 13, 12, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 13,
                    12, 11, 13, 12, 11
                ],
                [
                    13, 12, 11, 10, 9, 8, 7, 6, 13, 12, 11, 10, 9, 8, 7, 6, 5, 13, 12, 11, 1, 10, 9, 8,
                    7, 6, 5, 4, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 12, 3, 13, 12, 11, 10, 9, 8, 7, 6,
                    11, 13, 12, 11
                ],
            ],
        },
    ];

    settings.setState(1);
    return settings;
}
