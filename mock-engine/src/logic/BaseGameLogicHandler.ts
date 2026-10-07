// Ported from Libraries/Tombola.B2B.Arcade/BaseGameLogicHandler.cs
// (+ the GetDisplayedReels/GetDisplayReels helper every slot mechanic in Libraries/Games
//    re-implements privately — Spin5LogicHandler.cs, TravellingWildsLogicHandler.cs,
//    Scatter2LogicHandler.cs, FluffyLogicHandler.cs — hoisted here once).

import { ArcadeResultCode } from '../core/ArcadeResultCode';
import { IGameContext, IGameLogicHandler } from '../core/interfaces';
import { BaseArcadeRequest } from '../core/models/BaseArcadeRequest';
import { GameMessage } from '../core/models/GameMessage';
import { RNGGameRequest, RNGGameResponse } from '../core/models/GameInternalData';

/**
 * Base implementation of IGameLogicHandler that provides common functionality
 * for all game logic handlers.
 */
export abstract class BaseGameLogicHandler implements IGameLogicHandler {
    protected readonly gameContext: IGameContext;

    /** MOCK: the C# reads ColumnHeight off each game's settings; a mechanic overrides this. */
    protected columnHeight = 3;

    constructor(gameContext: IGameContext) {
        if (gameContext == null) throw new Error('gameContext is required');
        this.gameContext = gameContext;
    }

    abstract getRngRequest(): RNGGameRequest;

    abstract playGame(): GameMessage;

    abstract continueGame(): GameMessage;

    setTicketDetails(): void {
        if (this.gameContext.ticketDetails == null) return;

        this.gameContext.ticketDetails.Version = this.gameContext.settings?.ActiveVersion ?? '';
        this.gameContext.ticketDetails.Skin = String(this.gameContext.request.Skin);
        this.gameContext.ticketDetails.Stake = this.gameContext.request.Stake;
        this.gameContext.ticketDetails.PlayMode = String(this.gameContext.request.PlayMode ?? 'Unset');
        this.gameContext.ticketDetails.GamingSessionToken = this.gameContext.request.GamingSessionToken;
    }

    shouldAnnounceWin(gameMessage: GameMessage): boolean {
        // The C# integer division throws on a zero stake; the mock guards instead.
        if (!gameMessage.GameComplete || gameMessage.Stake <= 0) return false;
        return Math.trunc(gameMessage.Payout / gameMessage.Stake) >= 500;
    }

    validateBeginRequest(request: BaseArcadeRequest): void {
        void request;
    }

    validateBonusRoundRequest(request: BaseArcadeRequest): void {
        void request;
        throw new Error(`Validate Bonus Round not implemented for ${this.constructor.name}`);
    }

    validateContinue(gameMessage: GameMessage): void {
        void gameMessage;
        if (this.gameContext.ticketDetails == null || !this.gameContext.ticketDetails.BonusTriggered) {
            this.gameContext.response.ResultCode = ArcadeResultCode.NoBonusGame;
            this.gameContext.response.PlayState.ShouldRefreshBeforeNextBuyIn = true;
        }
    }

    processRngRequest(): Promise<RNGGameResponse> {
        throw new Error(`processRngRequest not implemented for ${this.constructor.name}`);
    }

    /**
     * The window of symbols each reel shows: `reels[reel][stop + row]`, one column per stop.
     *
     * MOCK: the engine's reel strips carry a tail buffer so `stop + row` never overruns; a
     * hand-authored prototype strip does not, so the read wraps instead of throwing.
     */
    protected getDisplayedReels(
        reels: readonly (readonly number[])[],
        stops: readonly number[],
        columnHeight: number = this.columnHeight,
    ): number[][] {
        const displayedReels: number[][] = [];

        for (let reelIndex = 0; reelIndex < reels.length; reelIndex++) {
            const reel = reels[reelIndex];
            if (reel.length === 0) throw new RangeError(`Reel ${reelIndex} is empty`);

            const stop = stops[reelIndex] ?? 0;
            const column: number[] = [];
            for (let rowIndex = 0; rowIndex < columnHeight; rowIndex++) column.push(reel[(stop + rowIndex) % reel.length]);

            displayedReels.push(column);
        }

        return displayedReels;
    }
}
