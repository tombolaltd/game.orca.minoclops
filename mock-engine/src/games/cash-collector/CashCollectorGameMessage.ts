// Ported from Libraries/Tombola.B2B.Arcade/GameSettings/CashCollector3/CashCollector3Models.cs
// (the wire shapes: CashCollector3GameMessage and everything it carries).
//
// Field names are the real engine's, so a client written against this mock reads the same
// paths. MOCK additions are marked; they are presentation helpers a client would otherwise
// have to re-derive from the maths tables.

import { GameMessage } from '../../core/models/GameMessage';
import { PlayMode } from '../../core/models/enums';
import { CashCollectorFeature, CashCollectorTier } from './CashCollectorSettings';

export interface CashCollectorSymbolPosition {
    Reel: number;
    Row: number;
}

export interface CashCollectorCashValueDetails {
    /** Stake multiplier the cash symbol carries. */
    Value: number;
    Position: CashCollectorSymbolPosition;
}

export interface CashCollectorDisplayResults {
    /** Visible grid, column-major: `Symbols[reel][row]`. */
    Symbols: number[][];
    CashValues: CashCollectorCashValueDetails[];
}

export interface CashCollectorWayPosition extends CashCollectorSymbolPosition {
    Symbol: number;
}

/**
 * One paying symbol. MOCK: the C# emits one Result per way combination; this mock reports each
 * symbol ONCE with its `Ways` count (the shared `evaluateWays` block), so `Positions` holds every
 * contributing cell and `Multiplier` is already multiplied by `Ways`.
 */
export interface CashCollectorWayResult {
    Positions: CashCollectorWayPosition[];
    Matched: number;
    Symbol: number;
    Ways: number;
    Multiplier: number;
    Prize: number;
}

export interface CashCollectorScatterResult {
    Positions: CashCollectorSymbolPosition[];
    Count: number;
    Symbol: number;
    Multiplier: number;
    Prize: number;
    Bonus: boolean;
    /** MOCK: free spins the bonus starts with (InitialBaseSpin + Count), 0 when it did not trigger. */
    BonusSpinsAwarded: number;
}

export interface CashCollectorCollectorDetails {
    /** `[reel, row]`. */
    Position: number[];
    Type: CashCollectorFeature;
}

export interface CashCollectorCashCollectorDetails extends CashCollectorCollectorDetails {
    CashCollected: number;
}

export interface CashCollectorCashSymbolPosition {
    /** `[reel, row]`. */
    Position: number[];
    Symbol: number;
    /** Minor units: `Value * stake`, truncated. */
    CashValue: number;
    StakeMultiplier: number;
    /** Bonus tier multiplier times any cash boost. */
    Multiplier: number;
    /** Minor units: `CashValue * Multiplier`. */
    TotalValue: number;
}

export interface CashCollectorCashBoostDetails {
    Multipliers: number[];
}

export interface CashCollectorLockSpinResult {
    DisplayResults: CashCollectorDisplayResults;
    CashSymbolPositions: CashCollectorCashSymbolPosition[];
}

export interface CashCollectorLockSpinDetails {
    CollectorCount: number;
    /** `Spins[0]` is the locked starting board; every later entry is one respin. */
    Spins: CashCollectorLockSpinResult[];
    TotalRespins: number;
    RespinPrize: number;
}

export interface CashCollectorWinBlastResult {
    DisplayResults: CashCollectorDisplayResults;
    CashSymbolPositions: CashCollectorCashSymbolPosition[];
    Prize: number;
}

export interface CashCollectorWinBlastDetails {
    /** One entry per blast: the fresh board that drops in, and the cash it collects. */
    Results: CashCollectorWinBlastResult[];
    TotalPrize: number;
}

export interface CashCollectorCashCollectionResult {
    CollectorPositions: CashCollectorCashCollectorDetails[];
    FeatureTriggered: boolean;
    CashSymbolPositions: CashCollectorCashSymbolPosition[];
    CashPrize: number;
    CashMultiplier: number;
    InitialSpinPrize: number;
    LockSpinDetails: CashCollectorLockSpinDetails | null;
    WinBlastDetails: CashCollectorWinBlastDetails | null;
    CashBoostDetails: CashCollectorCashBoostDetails | null;
    /** MOCK: the distinct collector kinds on screen, e.g. `['Standard', 'LockSpin']`. */
    FeatureTypes: CashCollectorFeature[];
}

export interface CashCollectorGameState {
    /** The player's state (1..MaxGameState) at the START of this game. */
    Number: number;
    /** Cumulative cash symbols the start state needs to unlock the next one; 0 at the top state. */
    TotalCashSymbolsForTierUpgrade: number;
    /** Cumulative cash symbols after this game. */
    TotalCashSymbolCount: number;
    TierUpgraded: boolean;
    // MOCK presentation helpers — everything below is derived from the four fields above.
    /** Cash symbols this game added to the meter (0 when a collector banked them). */
    CashSymbolsAdded: number;
    /** State after this game. */
    EndStateNumber: number;
    /** Meter fill (0..1) at the start of this game, within the start state. */
    StartProgress: number;
    /** Meter fill (0..1) after this game, within the END state; 1 at the top state. */
    EndProgress: number;
    /** Cash symbols still needed from the end state; 0 at the top state. */
    CashSymbolsToNextUnlock: number;
}

export interface CashCollectorBonusSpin {
    Stops: number[];
    DisplayResults: CashCollectorDisplayResults;
    Results: CashCollectorWayResult[];
    CashCollectionResult: CashCollectorCashCollectionResult;
    /** The tier this spin PLAYED at (its cash multiplier applies to this spin). */
    CollectorTier: CashCollectorTier;
    /** Cash symbols landed across the bonus so far. */
    CashSymbolCount: number;
    Number: number;
    MaxSpins: number;
    RemainingSpins: number;
    Payout: number;
    TotalBonusPayout: number;
    // MOCK presentation helpers.
    /** The tier the NEXT spin plays at. */
    EndCollectorTier: CashCollectorTier;
    TierUpgraded: boolean;
    /** Trail fill (0..1): CashSymbolCount over the top tier's MinCashSymbols. */
    TrailProgress: number;
}

export interface CashCollectorGameMessage extends GameMessage {
    PlayMode: PlayMode;
    Stops: number[];
    DisplayResults: CashCollectorDisplayResults;
    Results: CashCollectorWayResult[];
    ScatterResult: CashCollectorScatterResult;
    CashCollectionResult: CashCollectorCashCollectionResult;
    /** MOCK: always present — `Number` 0 until a free spin has been played (see createEmptyBonusSpin). */
    BonusSpin: CashCollectorBonusSpin;
    GameState: CashCollectorGameState;
}

/**
 * The pre-drawn outcome of one board (the main game, or one free spin), persisted on the ticket
 * so every continue/resume replays exactly what the RNG produced at begin.
 */
export interface CashCollectorGameDetails {
    DisplayResults: CashCollectorDisplayResults;
    CollectorDetails: CashCollectorCollectorDetails[];
    CashBoostDetails: CashCollectorCashBoostDetails | null;
    LockSpinDetails: CashCollectorDisplayResults[] | null;
    WinBlastDetails: CashCollectorDisplayResults[] | null;
}

/** GameStateDetails: the player's progression, persisted across games. */
export interface CashCollectorStateDetails {
    StateNumber: number;
    CollectedSymbols: number;
}

// MOCK: the C# returns null for a spin with fewer than three scatters. The mock always emits a
// ScatterResult, so a mapped response path never keeps a previous spin's value.
export function createEmptyScatterResult(scatterSymbol: number): CashCollectorScatterResult {
    return { Positions: [], Count: 0, Symbol: scatterSymbol, Multiplier: 0, Prize: 0, Bonus: false, BonusSpinsAwarded: 0 };
}

/**
 * MOCK: the C# leaves BonusSpin null until a free spin has been played. The mock always emits one
 * (Number 0 = "no free spin played yet"), so a mapped BonusSpin path never keeps the previous
 * round's value, and a begin that triggers the bonus already reports the spins it starts with.
 */
export function createEmptyBonusSpin(tier: CashCollectorTier, spins: number): CashCollectorBonusSpin {
    return {
        Stops: [],
        DisplayResults: { Symbols: [], CashValues: [] },
        Results: [],
        CashCollectionResult: {
            CollectorPositions: [],
            FeatureTriggered: false,
            CashSymbolPositions: [],
            CashPrize: 0,
            CashMultiplier: tier.CashMultiplier,
            InitialSpinPrize: 0,
            LockSpinDetails: null,
            WinBlastDetails: null,
            CashBoostDetails: null,
            FeatureTypes: [],
        },
        CollectorTier: { ...tier },
        CashSymbolCount: 0,
        Number: 0,
        MaxSpins: spins,
        RemainingSpins: spins,
        Payout: 0,
        TotalBonusPayout: 0,
        EndCollectorTier: { ...tier },
        TierUpgraded: false,
        TrailProgress: 0,
    };
}
