// Ported from Libraries/Games/Scatter/ScatterLogicHandler.cs.
//
// Nothing here is game-specific: every reel strip, winline, symbol prize and bonus rule is read
// off LinesSlotSettings, so a new prototype is a settings object and no new code.

import { ArcadeResultCode } from '../../core/ArcadeResultCode';
import { IGameContext } from '../../core/interfaces';
import { BaseArcadeRequest } from '../../core/models/BaseArcadeRequest';
import { RNGGameRequest, RNGGameResponse } from '../../core/models/GameInternalData';
import { ArcadeGameType } from '../../core/models/enums';
import { evaluateLines } from '../../evaluation';
import { BaseGameLogicHandler } from '../../logic/BaseGameLogicHandler';
import { RandomHelpers } from '../../rng/RandomHelpers';
import { LinesSlotContinueRequest } from './LinesSlotContinueRequest';
import { createEmptyLinesSlotBonusSpin, createEmptyLinesSlotScatterResult, LinesSlotGameMessage } from './LinesSlotGameMessage';
import {
    LinesSlotBonusSpin,
    LinesSlotLineResult,
    LinesSlotPrizeType,
    LinesSlotScatterResult,
    LinesSlotSettings,
    LinesSlotSymbol,
    LinesSlotSymbolPosition,
    LinesSlotSymbolPrize,
} from './LinesSlotSettings';
import { LinesSlotInternalData, LinesSlotTicketDetails } from './LinesSlotTicketHelper';

export interface LinesSlotRngRequest extends RNGGameRequest {
    ReelLengths: number[];
    BonusReelLengths: number[];
    BufferSize: number;
    InitialBonusSpins: number;
}

export interface LinesSlotRngResponse extends RNGGameResponse {
    ReelPositions: number[];
    BonusReelPositions: number[][];
}

export class LinesSlotLogicHandler extends BaseGameLogicHandler {
    constructor(gameContext: IGameContext) {
        super(gameContext);
    }

    override getRngRequest(): LinesSlotRngRequest {
        const settings = this.settings;
        return {
            ReelLengths: settings.Reels.map(reel => reel.length),
            BonusReelLengths: settings.BonusSettings.Reels.map(reel => reel.length),
            BufferSize: settings.BufferSize,
            InitialBonusSpins: settings.BonusSettings.InitialBonusSpins,
        };
    }

    override async processRngRequest(): Promise<LinesSlotRngResponse> {
        const rngRequest = this.getRngRequest();
        this.gameContext.internalData.RngRequest = rngRequest;

        const reelPositions = await drawStops(rngRequest.ReelLengths, rngRequest.BufferSize);

        const bonusReelPositions: number[][] = [];
        for (let spin = 0; spin < rngRequest.InitialBonusSpins; spin++) bonusReelPositions.push(await drawStops(rngRequest.BonusReelLengths, rngRequest.BufferSize));

        return { ReelPositions: reelPositions, BonusReelPositions: bonusReelPositions, Sender: 'mock-engine', ResponseTime: 0 };
    }

    override setTicketDetails(): void {
        const rngResponse = this.gameContext.internalData.RngResponse as LinesSlotRngResponse | undefined;

        const ticket = new LinesSlotTicketDetails();
        ticket.ReelPositions = [...(rngResponse?.ReelPositions ?? [])];
        ticket.BonusReelPositions = (rngResponse?.BonusReelPositions ?? []).map(stops => [...stops]);
        ticket.Symbols = [...ticket.ReelPositions];
        // The cache restores the game by this id, so it has to travel with the ticket.
        ticket.GameIdGuid = this.gameContext.internalData.GesData.GameId;

        this.gameContext.ticketDetails = ticket;
        super.setTicketDetails();
    }

    /** Replays the whole round from the ticket, so it serves begin, continue and resume alike. */
    override playGame(): LinesSlotGameMessage {
        const settings = this.settings;
        const request = this.gameContext.request;
        const ticket = this.ticket();
        const stake = ticket.Stake;

        const displayReels = this.getDisplayedReels(settings.Reels, ticket.ReelPositions, settings.ColumnHeight);

        const message: LinesSlotGameMessage = {
            ArcadeGameType: ArcadeGameType.Spin,
            Stake: stake,
            GameId: this.gameContext.internalData.GesData.GameId,
            Skin: request.Skin,
            Username: this.gameContext.response.PlayerData.Username,
            PlayMode: request.PlayMode,
            WinThisSpin: 0,
            Payout: 0,
            Winner: false,
            GameComplete: true,
            Symbols: [...ticket.ReelPositions],
            Stops: [...ticket.ReelPositions],
            DisplayReels: displayReels,
            Results: [],
            ScatterResult: createEmptyLinesSlotScatterResult(settings.ScatterSymbol),
            BonusSpin: createEmptyLinesSlotBonusSpin(settings.Reels.length),
        };

        message.Results = this.playLines(displayReels, 1);
        for (const result of message.Results) {
            result.Prize = Math.trunc(stake * result.Multiplier);
            message.Payout += result.Prize;
        }

        message.ScatterResult = this.playScatter(displayReels, stake);
        message.Payout += message.ScatterResult.Prize;

        if (message.ScatterResult.Bonus) {
            message.GameComplete = false;
            ticket.BonusTriggered = true;
            message.BonusSpin.Remaining = ticket.BonusReelPositions.length;

            const requestedSpins = this.requestedBonusSpins(ticket);
            if (requestedSpins > ticket.BonusReelPositions.length) {
                this.gameContext.response.ResultCode = ArcadeResultCode.InvalidRequestInput;
                return message;
            }

            this.playBonus(ticket, message, requestedSpins);
        }

        message.Winner = message.Payout > 0;
        message.WinThisSpin = message.BonusSpin.Number > 0 ? message.BonusSpin.BonusPayout : message.Payout;
        return message;
    }

    override continueGame(): LinesSlotGameMessage {
        return this.playGame();
    }

    /** Port of ScatterLogicHandler.ValidateBonusRoundRequest, including the out-of-sync check. */
    override validateBonusRoundRequest(request: BaseArcadeRequest): void {
        const bonusData = request.BonusRoundData as LinesSlotContinueRequest | undefined;
        const ticket = this.ticket();

        if (bonusData == null || !Number.isInteger(bonusData.BonusSpin)) {
            this.gameContext.response.ResultCode = ArcadeResultCode.InvalidRequestInput;
            return;
        }

        if (bonusData.BonusSpin < 1 || bonusData.BonusSpin > ticket.BonusReelPositions.length) {
            this.gameContext.response.ResultCode = ArcadeResultCode.InvalidRequestInput;
            return;
        }

        if (bonusData.BonusSpin !== ticket.PlayedBonusSpins + 1) this.gameContext.response.ResultCode = ArcadeResultCode.OutOfSync;
    }

    // ------------------------------------------------------------------ play

    /** The run maths lives in `src/evaluation`; this only states the engine's rules and re-wraps. */
    private playLines(displayReels: number[][], multiplier: number): LinesSlotLineResult[] {
        const settings = this.settings;

        const evaluation = evaluateLines({
            reels: displayReels,
            winlines: settings.Winlines,
            multiplierFor: (symbol, matched) => this.stakeMultiplierFor(symbol, matched),
            wildSymbol: settings.WildSymbol,
            paysOnLine: symbol => this.paysOnLines(symbol),
            // A wild-led line pays the better of "N wilds" and "N of the symbol it adopted".
            wildRunPays: true,
            multiplier,
        });

        return evaluation.Wins.map((win): LinesSlotLineResult => ({
            Positions: win.Positions,
            Symbol: win.Symbol,
            Matched: win.Matched,
            Multiplier: win.Multiplier,
            Prize: 0,
            OutcomeType: 'StakeMultiplier',
            WinLineId: win.WinLineId,
        }));
    }

    private playScatter(displayReels: number[][], stake: number): LinesSlotScatterResult {
        const settings = this.settings;
        const scatterPositions: LinesSlotSymbolPosition[] = [];
        const bonusPositions: LinesSlotSymbolPosition[] = [];

        for (let reel = 0; reel < displayReels.length; reel++)
            for (let row = 0; row < displayReels[reel].length; row++) {
                const symbol = displayReels[reel][row];
                if (symbol === settings.ScatterSymbol) scatterPositions.push({ Reel: reel, Row: row, Symbol: symbol });
                if (symbol === settings.BonusSymbol) bonusPositions.push({ Reel: reel, Row: row, Symbol: symbol });
            }

        const scatterMultiplier = this.prizeFor(settings.ScatterSymbol, scatterPositions.length, 'Scatter')?.Multiplier ?? 0;
        const bonus = this.prizeFor(settings.BonusSymbol, bonusPositions.length, 'Bonus') !== undefined && settings.BonusSettings.InitialBonusSpins > 0;

        const outcomeType: LinesSlotPrizeType = bonus ? 'Bonus' : scatterMultiplier > 0 ? 'Scatter' : 'None';

        return {
            Positions: [...scatterPositions, ...bonusPositions],
            OutcomeType: outcomeType,
            Count: scatterPositions.length,
            Symbol: settings.ScatterSymbol,
            Multiplier: scatterMultiplier,
            Prize: Math.trunc(stake * scatterMultiplier),
            Bonus: bonus,
        };
    }

    /** Replays free spins 1..requestedSpins and reports the latest, mirroring ScatterLogicHandler.PlayBonus. */
    private playBonus(ticket: LinesSlotTicketDetails, message: LinesSlotGameMessage, requestedSpins: number): void {
        const settings = this.settings;
        const internalData = this.gameContext.internalData as LinesSlotInternalData;
        const totalSpins = ticket.BonusReelPositions.length;

        internalData.BonusSpins = [];
        let totalBonusPayout = 0;

        for (let index = 0; index < requestedSpins; index++) {
            const stops = ticket.BonusReelPositions[index];
            const displayReels = this.getDisplayedReels(settings.BonusSettings.Reels, stops, settings.ColumnHeight);
            const results = this.playLines(displayReels, 1);

            let bonusPayout = 0;
            for (const result of results) {
                result.Prize = Math.trunc(ticket.Stake * result.Multiplier);
                bonusPayout += result.Prize;
            }
            totalBonusPayout += bonusPayout;

            const spin: LinesSlotBonusSpin = {
                Stops: [...stops],
                DisplayReels: displayReels,
                Number: index + 1,
                Remaining: totalSpins - (index + 1),
                BonusPayout: bonusPayout,
                TotalBonusPayout: totalBonusPayout,
                Results: results,
                StackedWildReel: displayReels.map(column => column.length > 0 && column.every(symbol => symbol === settings.WildSymbol)),
            };
            internalData.BonusSpins.push(spin);
        }

        if (requestedSpins <= 0) return;

        const latest = internalData.BonusSpins[requestedSpins - 1];
        message.BonusSpin = latest;
        message.Payout += latest.TotalBonusPayout;
        ticket.PlayedBonusSpins = requestedSpins;
        if (latest.Number === totalSpins) message.GameComplete = true;
    }

    // ------------------------------------------------------------------ settings lookups

    private get settings(): LinesSlotSettings {
        const settings = this.gameContext.settings as LinesSlotSettings | undefined;
        if (settings == null) throw new Error('Lines slot settings have not been initialised');
        return settings;
    }

    private ticket(): LinesSlotTicketDetails {
        return this.gameContext.ticketDetails as LinesSlotTicketDetails;
    }

    /** A begin request carries no bonus data, so the ticket's own progress stands in. */
    private requestedBonusSpins(ticket: LinesSlotTicketDetails): number {
        const bonusData = this.gameContext.request.BonusRoundData as LinesSlotContinueRequest | undefined;
        return bonusData == null ? ticket.PlayedBonusSpins : bonusData.BonusSpin;
    }

    private symbolFor(symbol: number): LinesSlotSymbol | undefined {
        return this.settings.Symbols.find(entry => entry.Symbol === symbol);
    }

    private paysOnLines(symbol: number): boolean {
        const definition = this.symbolFor(symbol);
        return definition !== undefined && !definition.Scattered && !definition.IsBonus;
    }

    private prizeFor(symbol: number, matched: number, prizeType: LinesSlotPrizeType): LinesSlotSymbolPrize | undefined {
        if (matched <= 0) return undefined;
        return this.symbolFor(symbol)?.Prizes.find(prize => prize.Matched === matched && prize.PrizeType === prizeType);
    }

    private stakeMultiplierFor(symbol: number, matched: number): number {
        return this.prizeFor(symbol, matched, 'StakeMultiplier')?.Multiplier ?? 0;
    }
}

async function drawStops(reelLengths: readonly number[], bufferSize: number): Promise<number[]> {
    const stops: number[] = [];
    for (const length of reelLengths) stops.push(await RandomHelpers.GetRandomValueAsync(Math.max(1, length - bufferSize)));
    return stops;
}
