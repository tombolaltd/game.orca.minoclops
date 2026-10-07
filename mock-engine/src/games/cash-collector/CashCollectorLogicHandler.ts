// Ported from Libraries/Games/CashCollector3/CashCollector3LogicHandler.cs.
//
// Everything random happens in processRngRequest: the main board, every possible free spin, and
// each board's feature data (cash boosts, lock-spin respins, win-blast drops) are drawn once at
// begin and persisted on the ticket, so every continue/resume REPLAYS the same outcome.

import { ArcadeResultCode } from '../../core/ArcadeResultCode';
import { IGameContext } from '../../core/interfaces';
import { BaseArcadeRequest } from '../../core/models/BaseArcadeRequest';
import { RNGGameRequest, RNGGameResponse } from '../../core/models/GameInternalData';
import { ArcadeGameType } from '../../core/models/enums';
import { evaluateWays, exactMultiplier, SymbolTierPaytable } from '../../evaluation';
import { BaseGameLogicHandler } from '../../logic/BaseGameLogicHandler';
import { RandomHelpers } from '../../rng/RandomHelpers';
import { CashCollectorContinueRequest } from './CashCollectorContinueRequest';
import { CashCollectorHandler, CashCollectorOverlayHandler, pickCumulative } from './CashCollectorFeatures';
import {
    CashCollectorBonusSpin,
    CashCollectorGameDetails,
    CashCollectorGameMessage,
    CashCollectorGameState,
    CashCollectorScatterResult,
    CashCollectorStateDetails,
    CashCollectorSymbolPosition,
    CashCollectorWayResult,
    createEmptyBonusSpin,
    createEmptyScatterResult,
} from './CashCollectorGameMessage';
import { CashCollectorSettings, CashCollectorTier } from './CashCollectorSettings';
import { CashCollectorInternalData, CashCollectorTicketDetails } from './CashCollectorTicketHelper';

export interface CashCollectorRngRequest extends RNGGameRequest {
    ReelLengths: number[];
    BufferSize: number;
    BonusReelLengths: number[];
    MaxBonusSpins: number;
}

export interface CashCollectorRngResponse extends RNGGameResponse {
    ReelPositions: number[];
    BonusReelPositions: number[][];
}

/** The slice of InMemoryGameStorageHandler's games table the progression lookup reads. */
interface StoredGameLike {
    gsUserId: number;
    voided: boolean;
    startStamp: string;
    ticketJson: string;
}

export class CashCollectorLogicHandler extends BaseGameLogicHandler {
    constructor(gameContext: IGameContext) {
        super(gameContext);
        this.columnHeight = 4;
    }

    override getRngRequest(): CashCollectorRngRequest {
        const settings = this.settings;
        const tiers = settings.BonusSettings.CollectorTiers;
        return {
            ReelLengths: settings.Reels.map(reel => reel.length),
            BufferSize: settings.BufferSize,
            BonusReelLengths: settings.BonusSettings.Reels.map(reel => reel.length),
            // Every spin the bonus can possibly reach: the base spin, every tier's extras and six scatters.
            MaxBonusSpins: settings.BonusSettings.InitialBaseSpin + tiers.reduce((total, tier) => total + tier.ExtraSpins, 0) + 6,
        };
    }

    override async processRngRequest(): Promise<CashCollectorRngResponse> {
        const request = this.getRngRequest();
        const internalData = this.gameContext.internalData as CashCollectorInternalData;
        internalData.RngRequest = request;

        const reelPositions = await drawStops(request.ReelLengths, request.BufferSize);
        const bonusReelPositions: number[][] = [];
        for (let spin = 0; spin < request.MaxBonusSpins; spin++) bonusReelPositions.push(await drawStops(request.BonusReelLengths, request.BufferSize));

        // MOCK: the C# reads the player's state out of SQL (DBCashCollector3ResumeStateCheck) before
        // begin; the mock reads it off the player's most recent stored game instead.
        const playerState = this.readPlayerState();
        internalData.StartGameState = playerState;

        const settings = this.settings;
        settings.setState(playerState.StateNumber);
        const overlayHandler = new CashCollectorOverlayHandler(settings);
        const collectorHandler = new CashCollectorHandler(settings, overlayHandler);

        internalData.GeneratedMainGameData = await this.getMainGameDisplay(reelPositions, overlayHandler, collectorHandler);
        internalData.GeneratedBonusGameData = [];
        if (this.isBonusTriggered(internalData.GeneratedMainGameData.DisplayResults.Symbols)) {
            for (const positions of bonusReelPositions)
                internalData.GeneratedBonusGameData.push(await this.getBonusGameDisplay(positions, overlayHandler, collectorHandler));
        }

        return { ReelPositions: reelPositions, BonusReelPositions: bonusReelPositions, Sender: 'mock-engine', ResponseTime: 0 };
    }

    override setTicketDetails(): void {
        const rngResponse = this.gameContext.internalData.RngResponse as CashCollectorRngResponse | undefined;
        const internalData = this.gameContext.internalData as CashCollectorInternalData;
        const state = internalData.StartGameState ?? { StateNumber: 1, CollectedSymbols: 0 };

        const ticket = new CashCollectorTicketDetails();
        ticket.ReelPositions = [...(rngResponse?.ReelPositions ?? [])];
        ticket.BonusReelPositions = (rngResponse?.BonusReelPositions ?? []).map(stops => [...stops]);
        ticket.MainGameData = internalData.GeneratedMainGameData ?? null;
        ticket.BonusGameData = [...internalData.GeneratedBonusGameData];
        ticket.GameState = { StateNumber: state.StateNumber, CollectedSymbols: state.CollectedSymbols };
        ticket.CurrentState = state.StateNumber;
        ticket.CurrentCashSymbolCount = state.CollectedSymbols;
        ticket.Symbols = [...ticket.ReelPositions];
        ticket.GameIdGuid = this.gameContext.internalData.GesData.GameId;

        this.gameContext.ticketDetails = ticket;
        super.setTicketDetails();
    }

    override playGame(): CashCollectorGameMessage {
        const ticket = this.ticket();
        const settings = this.settings;
        const internalData = this.gameContext.internalData as CashCollectorInternalData;
        internalData.BonusSpins = [];

        settings.setState(ticket.GameState.StateNumber);
        const overlayHandler = new CashCollectorOverlayHandler(settings);
        const collectorHandler = new CashCollectorHandler(settings, overlayHandler);

        const mainData = ticket.MainGameData;
        if (mainData == null) throw new Error('Cash collector main game data must be generated before playGame is called.');

        const message = this.initialiseGameMessage(ticket);
        message.Stops = [...ticket.ReelPositions];
        message.Symbols = [...ticket.ReelPositions];
        message.DisplayResults = mainData.DisplayResults;
        message.Results = this.getWinResults(message.DisplayResults.Symbols, ticket.Stake);
        message.Payout += sum(message.Results.map(result => result.Prize));

        message.CashCollectionResult = collectorHandler.getCashCollectionResult(message.Stops, mainData, ticket.Stake);
        message.Payout += message.CashCollectionResult.CashPrize;

        message.ScatterResult = this.getScatterResults(message.DisplayResults.Symbols, ticket);
        message.Payout += message.ScatterResult.Prize;

        this.checkGameState(message.GameState, message.DisplayResults.Symbols, message.CashCollectionResult.FeatureTriggered, collectorHandler);
        ticket.EndState = message.GameState.EndStateNumber;
        ticket.EndCashSymbolCount = message.GameState.TotalCashSymbolCount;

        message.WinThisSpin = message.Payout;

        if (ticket.BonusTriggered) {
            message.GameComplete = false;
            internalData.BonusSpins = this.playBonus(message, ticket, collectorHandler);
        }

        message.Winner = message.Payout > 0;
        return message;
    }

    override continueGame(): CashCollectorGameMessage {
        return this.playGame();
    }

    override validateBonusRoundRequest(request: BaseArcadeRequest): void {
        const bonusRequest = request.BonusRoundData as CashCollectorContinueRequest | undefined;
        if (bonusRequest == null || !Number.isInteger(bonusRequest.BonusSpin)) {
            this.gameContext.response.ResultCode = ArcadeResultCode.InvalidRequestInput;
            return;
        }

        const ticket = this.gameContext.ticketDetails as CashCollectorTicketDetails | undefined;
        if (ticket == null || !ticket.BonusTriggered) {
            this.gameContext.response.ResultCode = ArcadeResultCode.NoBonusGame;
            return;
        }

        const requestedSpin = bonusRequest.BonusSpin;
        if (requestedSpin < 1 || requestedSpin > ticket.BonusReelPositions.length) {
            this.gameContext.response.ResultCode = ArcadeResultCode.InvalidRequestInput;
            return;
        }

        if (requestedSpin > ticket.BonusGameData.length) {
            this.gameContext.response.ResultCode = ArcadeResultCode.TicketNotFound;
            return;
        }

        if (requestedSpin !== ticket.PlayedBonusSpins + 1) {
            this.gameContext.response.ResultCode = ArcadeResultCode.OutOfSync;
            return;
        }

        this.gameContext.response.ResultCode = ArcadeResultCode.Success;
    }

    // ------------------------------------------------------------------ play

    private initialiseGameMessage(ticket: CashCollectorTicketDetails): CashCollectorGameMessage {
        const settings = this.settings;
        const request = this.gameContext.request;
        const state = ticket.GameState;
        const maxTier = state.StateNumber >= settings.MaxGameState;

        const gameState: CashCollectorGameState = {
            Number: state.StateNumber,
            TotalCashSymbolCount: state.CollectedSymbols,
            TotalCashSymbolsForTierUpgrade: maxTier ? 0 : settings.StateProgressionThresholds[state.StateNumber - 1] ?? 0,
            TierUpgraded: false,
            CashSymbolsAdded: 0,
            EndStateNumber: state.StateNumber,
            StartProgress: 0,
            EndProgress: 0,
            CashSymbolsToNextUnlock: 0,
        };

        return {
            ArcadeGameType: ArcadeGameType.Spin,
            Stake: ticket.Stake,
            GameId: this.gameContext.internalData.GesData.GameId,
            Skin: request.Skin,
            Username: this.gameContext.response.PlayerData.Username,
            PlayMode: request.PlayMode,
            WinThisSpin: 0,
            Payout: 0,
            Winner: false,
            GameComplete: true,
            Symbols: [],
            Stops: [],
            DisplayResults: { Symbols: [], CashValues: [] },
            Results: [],
            ScatterResult: createEmptyScatterResult(settings.ScatterSymbol),
            CashCollectionResult: {
                CollectorPositions: [],
                FeatureTriggered: false,
                CashSymbolPositions: [],
                CashPrize: 0,
                CashMultiplier: 1,
                InitialSpinPrize: 0,
                LockSpinDetails: null,
                WinBlastDetails: null,
                CashBoostDetails: null,
                FeatureTypes: [],
            },
            BonusSpin: createEmptyBonusSpin(settings.BonusSettings.CollectorTiers[0] ?? { Tier: 0, MinCashSymbols: 0, CashMultiplier: 1, ExtraSpins: 0 }, 0),
            GameState: gameState,
        };
    }

    private playBonus(message: CashCollectorGameMessage, ticket: CashCollectorTicketDetails, collectorHandler: CashCollectorHandler): CashCollectorBonusSpin[] {
        const settings = this.settings;
        const tiers = settings.BonusSettings.CollectorTiers;
        const bonusSpins: CashCollectorBonusSpin[] = [];
        const requestedSpins = this.requestedBonusSpins(ticket);

        let currentMaxFreeSpins = settings.BonusSettings.InitialBaseSpin + message.ScatterResult.Count;
        let spinsRemaining = currentMaxFreeSpins;
        let totalBonusPayout = 0;
        let cashSymbolCount = 0;
        let finishingTier = tiers.find(tier => tier.Tier === 0) ?? tiers[0];
        const topTierCash = tiers.length > 0 ? tiers[tiers.length - 1].MinCashSymbols : 0;

        // Before the first free spin the message still reports what the bonus starts with.
        message.BonusSpin = createEmptyBonusSpin(finishingTier, currentMaxFreeSpins);

        for (let i = 0; i < requestedSpins; i++) {
            const startingTier = finishingTier;
            spinsRemaining--;
            const spin = this.playBonusSpin(i, startingTier, ticket, collectorHandler);
            cashSymbolCount += collectorHandler.getCashSymbolCount(spin.DisplayResults.Symbols);
            finishingTier = lastTierReached(tiers, cashSymbolCount) ?? finishingTier;

            if (startingTier.Tier !== finishingTier.Tier) {
                currentMaxFreeSpins += finishingTier.ExtraSpins;
                spinsRemaining += finishingTier.ExtraSpins;
            }

            spin.CashSymbolCount = cashSymbolCount;
            spin.MaxSpins = currentMaxFreeSpins;
            spin.RemainingSpins = spinsRemaining;
            totalBonusPayout += spin.Payout;
            spin.TotalBonusPayout = totalBonusPayout;
            spin.EndCollectorTier = { ...finishingTier };
            spin.TierUpgraded = startingTier.Tier !== finishingTier.Tier;
            spin.TrailProgress = topTierCash > 0 ? Math.min(1, cashSymbolCount / topTierCash) : 0;
            bonusSpins.push(spin);

            message.GameComplete = i === currentMaxFreeSpins - 1;

            if (i === requestedSpins - 1) {
                message.BonusSpin = spin;
                message.Payout += spin.TotalBonusPayout;
                message.WinThisSpin = spin.Payout;
                ticket.PlayedBonusSpins = requestedSpins;
            }
        }

        return bonusSpins;
    }

    private playBonusSpin(index: number, tier: CashCollectorTier, ticket: CashCollectorTicketDetails, collectorHandler: CashCollectorHandler): CashCollectorBonusSpin {
        const data = ticket.BonusGameData[index];
        if (data === undefined) throw new Error('Cash collector bonus game data must be generated before continueGame is called.');

        const stops = ticket.BonusReelPositions[index] ?? [];
        const results = this.getWinResults(data.DisplayResults.Symbols, ticket.Stake);
        const cashCollectionResult = collectorHandler.getCashCollectionResult(stops, data, ticket.Stake, true, tier.CashMultiplier);

        return {
            Number: index + 1,
            Stops: [...stops],
            CollectorTier: { ...tier },
            DisplayResults: data.DisplayResults,
            Results: results,
            CashCollectionResult: cashCollectionResult,
            Payout: sum(results.map(result => result.Prize)) + cashCollectionResult.CashPrize,
            CashSymbolCount: 0,
            MaxSpins: 0,
            RemainingSpins: 0,
            TotalBonusPayout: 0,
            EndCollectorTier: { ...tier },
            TierUpgraded: false,
            TrailProgress: 0,
        };
    }

    private checkGameState(gameState: CashCollectorGameState, displayReels: number[][], featureTriggered: boolean, collectorHandler: CashCollectorHandler): void {
        const settings = this.settings;
        const thresholds = settings.StateProgressionThresholds;
        const startCount = gameState.TotalCashSymbolCount;

        if (gameState.Number <= thresholds.length && !featureTriggered) {
            const unusedCashSymbols = collectorHandler.getCashSymbolCount(displayReels);
            gameState.TotalCashSymbolCount = Math.min(gameState.TotalCashSymbolCount + unusedCashSymbols, thresholds[thresholds.length - 1] ?? 0);
            gameState.TierUpgraded = gameState.TotalCashSymbolCount >= gameState.TotalCashSymbolsForTierUpgrade;
        }

        // MOCK presentation helpers.
        gameState.CashSymbolsAdded = gameState.TotalCashSymbolCount - startCount;
        gameState.EndStateNumber = gameState.TierUpgraded ? gameState.Number + 1 : gameState.Number;
        gameState.StartProgress = stateProgress(thresholds, gameState.Number, startCount);
        gameState.EndProgress = stateProgress(thresholds, gameState.EndStateNumber, gameState.TotalCashSymbolCount);
        const nextThreshold = thresholds[gameState.EndStateNumber - 1];
        gameState.CashSymbolsToNextUnlock = nextThreshold === undefined ? 0 : Math.max(0, nextThreshold - gameState.TotalCashSymbolCount);
    }

    private getScatterResults(displayReels: number[][], ticket: CashCollectorTicketDetails): CashCollectorScatterResult {
        const settings = this.settings;
        const positions: CashCollectorSymbolPosition[] = [];
        for (let reel = 0; reel < displayReels.length; reel++)
            for (let row = 0; row < displayReels[reel].length; row++)
                if (displayReels[reel][row] === settings.ScatterSymbol) positions.push({ Reel: reel, Row: row });

        const result = createEmptyScatterResult(settings.ScatterSymbol);
        result.Positions = positions;
        result.Count = positions.length;

        const outcome = this.symbolFor(settings.ScatterSymbol)?.Prizes.find(prize => prize.Matched === positions.length);
        if (outcome === undefined) return result;

        result.Multiplier = outcome.Multiplier;
        result.Prize = Math.trunc(outcome.Multiplier * ticket.Stake);
        result.Bonus = outcome.OutcomeType === 'Bonus';
        if (result.Bonus) {
            ticket.BonusTriggered = true;
            result.BonusSpinsAwarded = settings.BonusSettings.InitialBaseSpin + result.Count;
        }

        return result;
    }

    private async getMainGameDisplay(
        reelPositions: number[],
        overlayHandler: CashCollectorOverlayHandler,
        collectorHandler: CashCollectorHandler,
    ): Promise<CashCollectorGameDetails> {
        const settings = this.settings;
        let baseDisplayReels = this.getDisplayedReels(settings.Reels, reelPositions, settings.ColumnHeight);
        const noOfScatters = Math.max(0, await pickCumulative(settings.ScatterSymbolChance));
        if (noOfScatters > 0) baseDisplayReels = await overlayHandler.overlayScatter(baseDisplayReels, noOfScatters);

        const features = await collectorHandler.getCashCollectorFeature();
        const overlaid = await overlayHandler.overlayCollectorFeatures(baseDisplayReels, features);
        const gameDetails: CashCollectorGameDetails = {
            CollectorDetails: collectorHandler.getCollectorPositions(overlaid, features),
            DisplayResults: overlaid,
            CashBoostDetails: null,
            LockSpinDetails: null,
            WinBlastDetails: null,
        };

        await collectorHandler.populateCashCollectionFeatureData(reelPositions, gameDetails, this.gameContext.request.Stake);
        return gameDetails;
    }

    private async getBonusGameDisplay(
        positions: number[],
        overlayHandler: CashCollectorOverlayHandler,
        collectorHandler: CashCollectorHandler,
    ): Promise<CashCollectorGameDetails> {
        const settings = this.settings;
        const baseDisplayReels = this.getDisplayedReels(settings.BonusSettings.Reels, positions, settings.ColumnHeight);
        const features = await collectorHandler.getCashCollectorFeature(true);
        const overlaid = await overlayHandler.overlayCollectorFeatures(baseDisplayReels, features);
        const gameDetails: CashCollectorGameDetails = {
            CollectorDetails: collectorHandler.getCollectorPositions(overlaid, features),
            DisplayResults: overlaid,
            CashBoostDetails: null,
            LockSpinDetails: null,
            WinBlastDetails: null,
        };

        await collectorHandler.populateCashCollectionFeatureData(positions, gameDetails, this.gameContext.request.Stake, true);
        return gameDetails;
    }

    private isBonusTriggered(displayReels: number[][]): boolean {
        const settings = this.settings;
        let count = 0;
        for (const column of displayReels) for (const symbol of column) if (symbol === settings.ScatterSymbol) count++;
        return this.symbolFor(settings.ScatterSymbol)?.Prizes.find(prize => prize.Matched === count)?.OutcomeType === 'Bonus';
    }

    /** The run maths lives in `src/evaluation`; this only states the engine's rules and re-wraps. */
    private getWinResults(displayReels: number[][], stake: number): CashCollectorWayResult[] {
        const settings = this.settings;
        const paytable: Record<number, Record<number, number>> = {};
        const payingSymbols: number[] = [];
        for (const definition of settings.Symbols) {
            const pays = definition.Prizes.filter(prize => prize.OutcomeType === 'StakeMultiplier');
            if (definition.IsWild === true || definition.Scattered === true || pays.length === 0) continue;
            paytable[definition.Symbol] = {};
            for (const prize of pays) paytable[definition.Symbol][prize.Matched] = prize.Multiplier;
            payingSymbols.push(definition.Symbol);
        }

        const evaluation = evaluateWays({
            reels: displayReels,
            multiplierFor: exactMultiplier(paytable as SymbolTierPaytable),
            wildSymbol: settings.WildSymbol,
            paysOnWays: symbol => payingSymbols.includes(symbol),
            // A wild in the leading reel can start every paying symbol, not just a wild run.
            wildLead: 'any-paying-symbol',
            payingSymbols,
            // High symbols pay from two of a kind; the exact lookup refuses a run the paytable lacks.
            minMatch: 2,
        });

        return evaluation.Wins.map((win): CashCollectorWayResult => ({
            Positions: win.Positions.map(position => ({ Reel: position.Reel, Row: position.Row, Symbol: position.Symbol })),
            Matched: win.Matched,
            Symbol: win.Symbol,
            Ways: win.Ways,
            Multiplier: roundMultiplier(win.Multiplier),
            Prize: Math.trunc(roundMultiplier(win.Multiplier) * stake),
        }));
    }

    // ------------------------------------------------------------------ lookups

    /**
     * MOCK: the player's progression, from their most recent stored game's end state. The C# keeps
     * it in a SQL table; the mock's storage keeps every game, so the latest ticket is the record.
     */
    private readPlayerState(): CashCollectorStateDetails {
        const fallback: CashCollectorStateDetails = { StateNumber: 1, CollectedSymbols: 0 };
        const games = (this.gameContext.storageHandler as unknown as { games?: Map<string, StoredGameLike> }).games;
        if (!(games instanceof Map)) return fallback;

        const gsUserId = this.gameContext.internalData.GesData.GSUserId;
        let latest: { stamp: string; state: CashCollectorStateDetails } | undefined;
        for (const stored of games.values()) {
            if (stored.gsUserId !== gsUserId || stored.voided) continue;
            let parsed: Partial<CashCollectorTicketDetails> | undefined;
            try {
                parsed = JSON.parse(stored.ticketJson) as Partial<CashCollectorTicketDetails>;
            } catch {
                continue;
            }
            if (typeof parsed?.EndState !== 'number' || typeof parsed.EndCashSymbolCount !== 'number' || parsed.EndState < 1) continue;
            if (latest === undefined || stored.startStamp >= latest.stamp) {
                latest = { stamp: stored.startStamp, state: { StateNumber: parsed.EndState, CollectedSymbols: parsed.EndCashSymbolCount } };
            }
        }

        if (latest === undefined) return fallback;
        const settings = this.settings;
        return {
            StateNumber: Math.min(Math.max(1, Math.trunc(latest.state.StateNumber)), settings.MaxGameState),
            CollectedSymbols: Math.max(0, Math.trunc(latest.state.CollectedSymbols)),
        };
    }

    private get settings(): CashCollectorSettings {
        const settings = this.gameContext.settings as CashCollectorSettings | undefined;
        if (settings == null) throw new Error('Cash collector settings have not been initialised');
        return settings;
    }

    private ticket(): CashCollectorTicketDetails {
        return this.gameContext.ticketDetails as CashCollectorTicketDetails;
    }

    private requestedBonusSpins(ticket: CashCollectorTicketDetails): number {
        const bonusData = this.gameContext.request.BonusRoundData as CashCollectorContinueRequest | undefined;
        return bonusData == null ? ticket.PlayedBonusSpins : bonusData.BonusSpin;
    }

    private symbolFor(symbol: number) {
        return this.settings.Symbols.find(entry => entry.Symbol === symbol);
    }
}

/** Highest tier whose MinCashSymbols has been reached (the C#'s LastOrDefault). */
function lastTierReached(tiers: readonly CashCollectorTier[], cashSymbolCount: number): CashCollectorTier | undefined {
    let reached: CashCollectorTier | undefined;
    for (const tier of tiers) if (tier.MinCashSymbols <= cashSymbolCount) reached = tier;
    return reached;
}

/** Meter fill for `state` at `count` cumulative cash symbols: 0..1 between that state's bounds. */
function stateProgress(thresholds: readonly number[], state: number, count: number): number {
    const upper = thresholds[state - 1];
    if (upper === undefined) return 1;
    const lower = state >= 2 ? thresholds[state - 2] ?? 0 : 0;
    if (upper <= lower) return 1;
    return Math.min(1, Math.max(0, (count - lower) / (upper - lower)));
}

/** Fixes binary drift from the per-way multiplication (0.3 * 4 = 1.2000000000000002). */
function roundMultiplier(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

async function drawStops(reelLengths: readonly number[], bufferSize: number): Promise<number[]> {
    const stops: number[] = [];
    for (const length of reelLengths) stops.push(await RandomHelpers.GetRandomValueAsync(Math.max(1, length - bufferSize)));
    return stops;
}
