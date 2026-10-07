// Ported from Libraries/Games/Mystery243/Mystery243LogicHandler.cs (GetWinResults/GetPositions)
// and Libraries/Games/TravellingWilds/TravellingWildsLogicHandler.cs (the free spin loop).

import { ArcadeResultCode } from '../../core/ArcadeResultCode';
import { IGameContext } from '../../core/interfaces';
import { BaseArcadeRequest } from '../../core/models/BaseArcadeRequest';
import { RNGGameRequest, RNGGameResponse } from '../../core/models/GameInternalData';
import { ArcadeGameType } from '../../core/models/enums';
import { evaluateWays } from '../../evaluation';
import { BaseGameLogicHandler } from '../../logic/BaseGameLogicHandler';
import { RandomHelpers } from '../../rng/RandomHelpers';
import { WaysSlotContinueRequest } from './WaysSlotContinueRequest';
import { createEmptyWaysSlotBonusSpin, createEmptyWaysSlotScatterResult, WaysSlotGameMessage } from './WaysSlotGameMessage';
import {
    WaysSlotBonusSpin,
    WaysSlotDirection,
    WaysSlotPrizeType,
    WaysSlotScatterResult,
    WaysSlotSettings,
    WaysSlotSymbol,
    WaysSlotSymbolPosition,
    WaysSlotSymbolPrize,
    WaysSlotWayResult,
} from './WaysSlotSettings';
import { WaysSlotInternalData, WaysSlotTicketDetails } from './WaysSlotTicketHelper';

export interface WaysSlotRngRequest extends RNGGameRequest {
    ReelLengths: number[];
    BonusReelLengths: number[];
    BufferSize: number;
    InitialBonusSpins: number;
}

export interface WaysSlotRngResponse extends RNGGameResponse {
    ReelPositions: number[];
    BonusReelPositions: number[][];
}

export class WaysSlotLogicHandler extends BaseGameLogicHandler {
    constructor(gameContext: IGameContext) {
        super(gameContext);
    }

    override getRngRequest(): WaysSlotRngRequest {
        const settings = this.settings;
        return {
            ReelLengths: settings.Reels.map(reel => reel.length),
            BonusReelLengths: settings.BonusSettings.Reels.map(reel => reel.length),
            BufferSize: settings.BufferSize,
            InitialBonusSpins: settings.BonusSettings.InitialBonusSpins,
        };
    }

    override async processRngRequest(): Promise<WaysSlotRngResponse> {
        const rngRequest = this.getRngRequest();
        this.gameContext.internalData.RngRequest = rngRequest;

        const reelPositions = await drawStops(rngRequest.ReelLengths, rngRequest.BufferSize);

        const bonusReelPositions: number[][] = [];
        for (let spin = 0; spin < rngRequest.InitialBonusSpins; spin++) bonusReelPositions.push(await drawStops(rngRequest.BonusReelLengths, rngRequest.BufferSize));

        return { ReelPositions: reelPositions, BonusReelPositions: bonusReelPositions, Sender: 'mock-engine', ResponseTime: 0 };
    }

    override setTicketDetails(): void {
        const rngResponse = this.gameContext.internalData.RngResponse as WaysSlotRngResponse | undefined;

        const ticket = new WaysSlotTicketDetails();
        ticket.ReelPositions = [...(rngResponse?.ReelPositions ?? [])];
        ticket.BonusReelPositions = (rngResponse?.BonusReelPositions ?? []).map(stops => [...stops]);
        ticket.Symbols = [...ticket.ReelPositions];
        ticket.GameIdGuid = this.gameContext.internalData.GesData.GameId;

        this.gameContext.ticketDetails = ticket;
        super.setTicketDetails();
    }

    override playGame(): WaysSlotGameMessage {
        const settings = this.settings;
        const request = this.gameContext.request;
        const ticket = this.ticket();
        const stake = ticket.Stake;

        const displayReels = this.getDisplayedReels(settings.Reels, ticket.ReelPositions, settings.ColumnHeight);

        const message: WaysSlotGameMessage = {
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
            ScatterResult: createEmptyWaysSlotScatterResult(settings.ScatterSymbol),
            BonusSpin: createEmptyWaysSlotBonusSpin(settings.Reels.length),
        };

        message.Results = this.playWays(displayReels);
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

    override continueGame(): WaysSlotGameMessage {
        return this.playGame();
    }

    override validateBonusRoundRequest(request: BaseArcadeRequest): void {
        const bonusData = request.BonusRoundData as WaysSlotContinueRequest | undefined;
        const ticket = this.ticket();

        if (bonusData == null || !Number.isInteger(bonusData.BonusSpins)) {
            this.gameContext.response.ResultCode = ArcadeResultCode.InvalidRequestInput;
            return;
        }

        if (bonusData.BonusSpins < 1 || bonusData.BonusSpins > ticket.BonusReelPositions.length) {
            this.gameContext.response.ResultCode = ArcadeResultCode.InvalidRequestInput;
            return;
        }

        if (bonusData.BonusSpins !== ticket.PlayedBonusSpins + 1) this.gameContext.response.ResultCode = ArcadeResultCode.OutOfSync;
    }

    // ------------------------------------------------------------------ play

    private playWays(displayReels: number[][]): WaysSlotWayResult[] {
        const results = this.playWaysInDirection(displayReels, 'LeftToRight');
        if (this.settings.Ways.PayBothWays) results.push(...this.playWaysInDirection(displayReels, 'RightToLeft'));
        return results;
    }

    /** The run maths lives in `src/evaluation`; this only states the engine's rules and re-wraps. */
    private playWaysInDirection(displayReels: number[][], direction: WaysSlotDirection): WaysSlotWayResult[] {
        const settings = this.settings;

        const evaluation = evaluateWays({
            reels: displayReels,
            multiplierFor: (symbol, matched) => this.stakeMultiplierFor(symbol, matched),
            wildSymbol: settings.WildSymbol,
            paysOnWays: symbol => this.paysOnWays(symbol),
            // A wild in the leading reel can start every paying symbol, not just a wild run.
            wildLead: 'any-paying-symbol',
            payingSymbols: settings.Symbols.map(definition => definition.Symbol),
            minMatch: settings.Ways.MinMatch,
            direction,
        });

        return evaluation.Wins.map((win): WaysSlotWayResult => ({
            Positions: win.Positions,
            Symbol: win.Symbol,
            Matched: win.Matched,
            Ways: win.Ways,
            Multiplier: win.Multiplier,
            Prize: 0,
            OutcomeType: 'StakeMultiplier',
            Direction: direction,
        }));
    }

    private playScatter(displayReels: number[][], stake: number): WaysSlotScatterResult {
        const settings = this.settings;
        const scatterPositions: WaysSlotSymbolPosition[] = [];
        const bonusPositions: WaysSlotSymbolPosition[] = [];

        for (let reel = 0; reel < displayReels.length; reel++)
            for (let row = 0; row < displayReels[reel].length; row++) {
                const symbol = displayReels[reel][row];
                if (symbol === settings.ScatterSymbol) scatterPositions.push({ Reel: reel, Row: row, Symbol: symbol });
                if (symbol === settings.BonusSymbol) bonusPositions.push({ Reel: reel, Row: row, Symbol: symbol });
            }

        const scatterMultiplier = this.prizeFor(settings.ScatterSymbol, scatterPositions.length, 'Scatter')?.Multiplier ?? 0;
        const bonus = this.prizeFor(settings.BonusSymbol, bonusPositions.length, 'Bonus') !== undefined && settings.BonusSettings.InitialBonusSpins > 0;

        const outcomeType: WaysSlotPrizeType = bonus ? 'Bonus' : scatterMultiplier > 0 ? 'Scatter' : 'None';

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

    private playBonus(ticket: WaysSlotTicketDetails, message: WaysSlotGameMessage, requestedSpins: number): void {
        const settings = this.settings;
        const internalData = this.gameContext.internalData as WaysSlotInternalData;
        const totalSpins = ticket.BonusReelPositions.length;

        internalData.BonusSpins = [];
        let totalBonusPayout = 0;

        for (let index = 0; index < requestedSpins; index++) {
            const stops = ticket.BonusReelPositions[index];
            const displayReels = this.getDisplayedReels(settings.BonusSettings.Reels, stops, settings.ColumnHeight);
            const results = this.playWays(displayReels);

            let bonusPayout = 0;
            for (const result of results) {
                result.Prize = Math.trunc(ticket.Stake * result.Multiplier);
                bonusPayout += result.Prize;
            }
            totalBonusPayout += bonusPayout;

            const spin: WaysSlotBonusSpin = {
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

    private get settings(): WaysSlotSettings {
        const settings = this.gameContext.settings as WaysSlotSettings | undefined;
        if (settings == null) throw new Error('Ways slot settings have not been initialised');
        return settings;
    }

    private ticket(): WaysSlotTicketDetails {
        return this.gameContext.ticketDetails as WaysSlotTicketDetails;
    }

    private requestedBonusSpins(ticket: WaysSlotTicketDetails): number {
        const bonusData = this.gameContext.request.BonusRoundData as WaysSlotContinueRequest | undefined;
        return bonusData == null ? ticket.PlayedBonusSpins : bonusData.BonusSpins;
    }

    private symbolFor(symbol: number): WaysSlotSymbol | undefined {
        return this.settings.Symbols.find(entry => entry.Symbol === symbol);
    }

    private paysOnWays(symbol: number): boolean {
        const definition = this.symbolFor(symbol);
        return definition !== undefined && !definition.Scattered && !definition.IsBonus && !definition.IsWild;
    }

    private prizeFor(symbol: number, matched: number, prizeType: WaysSlotPrizeType): WaysSlotSymbolPrize | undefined {
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
