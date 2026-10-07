// Ported from Libraries/Games/Tap/TapLogicHandler.cs (the plant-a-winner-then-fill-with-near-misses
// deal) + Libraries/Games/MultiScratch/MultiScratchLogicHandler.cs (the weighted outcome roll).
//
// Nothing here is game-specific: every cell count, prize, match requirement and weight is read off
// InstantWinSettings, so a new prototype is a settings object and no new code.

import { ArcadeResultCode } from '../../core/ArcadeResultCode';
import { IGameContext } from '../../core/interfaces';
import { BaseArcadeRequest } from '../../core/models/BaseArcadeRequest';
import { RNGGameRequest, RNGGameResponse } from '../../core/models/GameInternalData';
import { ArcadeGameType } from '../../core/models/enums';
import { BaseGameLogicHandler } from '../../logic/BaseGameLogicHandler';
import { RandomHelpers } from '../../rng/RandomHelpers';
import { createEmptyInstantWinBonusSpin, createEmptyInstantWinScatterResult, InstantWinGameMessage } from './InstantWinGameMessage';
import { InstantWinResult, InstantWinSettings, InstantWinSymbolPosition } from './InstantWinSettings';
import { InstantWinTicketDetails } from './InstantWinTicketHelper';

export interface InstantWinRngRequest extends RNGGameRequest {
    RevealCount: number;
    MaxWins: number;
    PrizeSymbols: number[];
    /** Per prize, weighed against LosingWeight; this is what sets the hit rate. */
    PrizeWeights: number[];
    MatchesToWin: number[];
    LosingWeight: number;
    BlankSymbol: number;
}

export interface InstantWinRngResponse extends RNGGameResponse {
    Reveals: number[];
    WinningSymbols: number[];
}

export class InstantWinLogicHandler extends BaseGameLogicHandler {
    constructor(gameContext: IGameContext) {
        super(gameContext);
    }

    override getRngRequest(): InstantWinRngRequest {
        const settings = this.settings;
        return {
            RevealCount: settings.RevealCount,
            MaxWins: settings.MaxWins,
            PrizeSymbols: settings.Prizes.map(prize => prize.Symbol),
            PrizeWeights: settings.Prizes.map(prize => prize.Weight),
            MatchesToWin: settings.Prizes.map(prize => prize.MatchesToWin),
            LosingWeight: settings.LosingWeight,
            BlankSymbol: settings.BlankSymbol,
        };
    }

    override async processRngRequest(): Promise<InstantWinRngResponse> {
        const rngRequest = this.getRngRequest();
        this.gameContext.internalData.RngRequest = rngRequest;

        const winningSymbols = await drawInstantWinSymbols(rngRequest);
        const reveals = await dealInstantWinCard(rngRequest, winningSymbols);

        return { Reveals: reveals, WinningSymbols: winningSymbols, Sender: 'mock-engine', ResponseTime: 0 };
    }

    override setTicketDetails(): void {
        const rngResponse = this.gameContext.internalData.RngResponse as InstantWinRngResponse | undefined;

        const ticket = new InstantWinTicketDetails();
        ticket.Reveals = [...(rngResponse?.Reveals ?? [])];
        ticket.Symbols = [...ticket.Reveals];
        // The cache restores the game by this id, so it has to travel with the ticket.
        ticket.GameIdGuid = this.gameContext.internalData.GesData.GameId;

        this.gameContext.ticketDetails = ticket;
        super.setTicketDetails();
    }

    /** Replays the whole round from the ticket, so it serves begin, resume and review alike. */
    override playGame(): InstantWinGameMessage {
        const request = this.gameContext.request;
        const ticket = this.ticket();
        const stake = ticket.Stake;

        const message: InstantWinGameMessage = {
            ArcadeGameType: ArcadeGameType.InstantWin,
            Stake: stake,
            GameId: this.gameContext.internalData.GesData.GameId,
            Skin: request.Skin,
            Username: this.gameContext.response.PlayerData.Username,
            PlayMode: request.PlayMode,
            WinThisSpin: 0,
            Payout: 0,
            Winner: false,
            GameComplete: true,
            Symbols: [...ticket.Reveals],
            Reveals: [...ticket.Reveals],
            Stops: [],
            DisplayReels: [],
            Results: this.playReveals(ticket.Reveals, stake),
            ScatterResult: createEmptyInstantWinScatterResult(),
            BonusSpin: createEmptyInstantWinBonusSpin(),
            TotalPrize: 0,
        };

        for (const result of message.Results) message.Payout += result.Prize;

        message.TotalPrize = message.Payout;
        message.WinThisSpin = message.Payout;
        message.Winner = message.Payout > 0;
        return message;
    }

    // MOCK: TapLogicHandler.ContinueGame throws NotSupportedException. The mock reports the result
    // code the flow would have set instead, because the façade must always return an envelope.
    override continueGame(): InstantWinGameMessage {
        this.gameContext.response.ResultCode = ArcadeResultCode.NoBonusGame;
        return this.playGame();
    }

    override validateBonusRoundRequest(request: BaseArcadeRequest): void {
        void request;
        this.gameContext.response.ResultCode = ArcadeResultCode.NoBonusGame;
    }

    // ------------------------------------------------------------------ play

    private playReveals(reveals: readonly number[], stake: number): InstantWinResult[] {
        const results: InstantWinResult[] = [];

        for (const prize of this.settings.Prizes) {
            if (prize.MatchesToWin <= 0) continue;

            const positions: InstantWinSymbolPosition[] = [];
            for (let cell = 0; cell < reveals.length; cell++)
                if (reveals[cell] === prize.Symbol) positions.push({ Reel: cell, Row: 0, Symbol: prize.Symbol });

            if (positions.length < prize.MatchesToWin) continue;

            results.push({
                Positions: positions,
                Symbol: prize.Symbol,
                Label: prize.Label,
                Matched: positions.length,
                Multiplier: prize.Multiplier,
                Prize: Math.trunc(stake * prize.Multiplier),
                OutcomeType: 'StakeMultiplier',
                WinLineId: results.length + 1,
            });
        }

        return results;
    }

    // ------------------------------------------------------------------ settings lookups

    private get settings(): InstantWinSettings {
        const settings = this.gameContext.settings as InstantWinSettings | undefined;
        if (settings == null) throw new Error('Instant win settings have not been initialised');
        return settings;
    }

    private ticket(): InstantWinTicketDetails {
        const ticket = this.gameContext.ticketDetails as InstantWinTicketDetails | undefined;
        return ticket instanceof InstantWinTicketDetails ? ticket : new InstantWinTicketDetails();
    }
}

/** One weighted roll per allowed win, each prize weighed against LosingWeight, mirroring MultiScratch. */
export async function drawInstantWinSymbols(request: InstantWinRngRequest): Promise<number[]> {
    const weights = [...request.PrizeWeights, request.LosingWeight].map(weight => Math.max(0, Math.trunc(weight)));
    if (weights.reduce((total, weight) => total + weight, 0) <= 0) return [];

    const winningSymbols: number[] = [];
    let plantedCells = 0;

    for (let roll = 0; roll < request.MaxWins; roll++) {
        const index = await RandomHelpers.GetWeightedIndexAsync(weights);
        if (index >= request.PrizeSymbols.length) continue;

        const symbol = request.PrizeSymbols[index];
        const matches = request.MatchesToWin[index];
        if (matches <= 0 || winningSymbols.includes(symbol) || plantedCells + matches > request.RevealCount) continue;

        winningSymbols.push(symbol);
        plantedCells += matches;
    }

    return winningSymbols;
}

/**
 * Plants each winner MatchesToWin times, then fills with near misses — one copy SHORT of a win for
 * every symbol that did not land — so a filler can never pay by accident. Port of TapLogicHandler.
 */
export async function dealInstantWinCard(request: InstantWinRngRequest, winningSymbols: readonly number[]): Promise<number[]> {
    const reveals: number[] = [];

    for (const symbol of winningSymbols) {
        const matches = request.MatchesToWin[request.PrizeSymbols.indexOf(symbol)] ?? 0;
        if (matches <= 0 || reveals.length + matches > request.RevealCount) continue;

        for (let copy = 0; copy < matches; copy++) reveals.push(symbol);
    }

    const nearMisses: number[] = [];
    for (let index = 0; index < request.PrizeSymbols.length; index++) {
        const symbol = request.PrizeSymbols[index];
        if (winningSymbols.includes(symbol)) continue;

        for (let copy = 0; copy < request.MatchesToWin[index] - 1; copy++) nearMisses.push(symbol);
    }
    await RandomHelpers.GetShuffledListAsync(nearMisses);

    for (const symbol of nearMisses) {
        if (reveals.length >= request.RevealCount) break;
        reveals.push(symbol);
    }
    while (reveals.length < request.RevealCount) reveals.push(request.BlankSymbol);

    await RandomHelpers.GetShuffledListAsync(reveals);
    return reveals.slice(0, request.RevealCount);
}
