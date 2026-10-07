// Ported from Libraries/Games/Scatter/ScatterTicketHelper.cs
// (+ ScatterTicketDetails / ScatterInternalData, which ScatterGame.cs declares alongside the game).

import { ArcadeResultCode } from '../../core/ArcadeResultCode';
import { BonusRoundDetails, IGameContext, IGameTicketHelper } from '../../core/interfaces';
import { GameInternalData } from '../../core/models/GameInternalData';
import { GameTicketDetails } from '../../core/models/GameTicketDetails';
import { LinesSlotGameMessage } from './LinesSlotGameMessage';
import { LinesSlotBonusSpin } from './LinesSlotSettings';

export class LinesSlotTicketDetails extends GameTicketDetails {
    ReelPositions: number[] = [];
    /** One pre-drawn stop array per free spin; its length IS the free spin count. */
    BonusReelPositions: number[][] = [];
    PlayedBonusSpins = 0;
}

export class LinesSlotInternalData extends GameInternalData {
    /** Every free spin played so far. Not sent to the client; the ticket fetcher reads it. */
    BonusSpins: LinesSlotBonusSpin[] = [];
}

export class LinesSlotTicketHelper implements IGameTicketHelper {
    constructor(private readonly context: IGameContext) {
        if (context == null) throw new Error('context is required');
    }

    setTicketDetails(
        dbMainTicket: Uint8Array,
        dbBonusTicket: Uint8Array,
        dbPlayerChoicesBegin: Uint8Array,
        dbPlayerChoicesContinue: Uint8Array,
    ): void {
        void dbPlayerChoicesBegin;

        const storage = this.context.storageHandler;
        const reelPositions = storage.convertFromVarbinaryToIntArray(dbMainTicket);
        const bonusValues = storage.convertFromVarbinaryToIntArray(dbBonusTicket);
        const reelCount = reelPositions.length;

        const ticket = new LinesSlotTicketDetails();
        ticket.ReelPositions = reelPositions;

        if (reelCount > 0) {
            if (bonusValues.length % reelCount !== 0) throw new Error('Ticket length incorrect');
            for (let offset = 0; offset < bonusValues.length; offset += reelCount) ticket.BonusReelPositions.push(bonusValues.slice(offset, offset + reelCount));
        }

        ticket.BonusTriggered = ticket.BonusReelPositions.length > 0;
        ticket.PlayedBonusSpins = storage.convertFromVarbinaryToIntArray(dbPlayerChoicesContinue).length;

        this.context.ticketDetails = ticket;
    }

    prepareTicketForDatabase(): number[] {
        return [...this.ticket().ReelPositions];
    }

    prepareBonusTicketForDatabase(): number[] {
        const bonusTicket: number[] = [];
        for (const stops of this.ticket().BonusReelPositions) bonusTicket.push(...stops);
        return bonusTicket;
    }

    preparePlayerChoicesForDatabase(): number[] {
        return new Array<number>(this.ticket().PlayedBonusSpins).fill(1);
    }

    prepareJackpotTicket(): string {
        return 'not used';
    }

    getBonusRoundDetails(): BonusRoundDetails[] {
        const message = this.context.response.GameMessage as LinesSlotGameMessage | undefined;
        return [{ BonusRoundPrize: message?.BonusSpin?.TotalBonusPayout ?? 0, BonusRoundType: 1 }];
    }

    setTicketFetcherDetails(): void {
        const message = this.context.response.GameMessage as (LinesSlotGameMessage & { BonusSpinsTicketFetcher?: LinesSlotBonusSpin[] }) | undefined;
        if (message === undefined) return;

        message.BonusSpinsTicketFetcher = (this.context.internalData as LinesSlotInternalData).BonusSpins ?? [];
    }

    setPreviousGameState(resultCode: ArcadeResultCode, dbTicket: string): void {
        void dbTicket;
        this.context.response.ResultCode = resultCode;
    }

    serialiseCachedTicket(ticket: GameTicketDetails): string {
        return JSON.stringify(ticket);
    }

    deserialiseCachedTicket(cachedTicketJSON: string): GameTicketDetails {
        if (cachedTicketJSON == null || cachedTicketJSON.length === 0) throw new Error('Cached ticket JSON cannot be null or empty');

        return Object.assign(new LinesSlotTicketDetails(), JSON.parse(cachedTicketJSON) as Partial<LinesSlotTicketDetails>);
    }

    private ticket(): LinesSlotTicketDetails {
        const ticket = this.context.ticketDetails as LinesSlotTicketDetails | undefined;
        return ticket instanceof LinesSlotTicketDetails ? ticket : new LinesSlotTicketDetails();
    }
}
