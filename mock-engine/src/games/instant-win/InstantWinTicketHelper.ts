// Ported from Libraries/Games/Tap/{TapTicketHelper,TapGame}.cs (TapTicketDetails is declared
// alongside the game there) + Libraries/Games/MultiScratch/MultiScratchTicketHelper.cs.

import { ArcadeResultCode } from '../../core/ArcadeResultCode';
import { BonusRoundDetails, IGameContext, IGameTicketHelper } from '../../core/interfaces';
import { GameTicketDetails } from '../../core/models/GameTicketDetails';

export class InstantWinTicketDetails extends GameTicketDetails {
    /** The dealt card, one symbol per cell. The whole round replays from it. */
    Reveals: number[] = [];
}

export class InstantWinTicketHelper implements IGameTicketHelper {
    constructor(private readonly context: IGameContext) {
        if (context == null) throw new Error('context is required');
    }

    setTicketDetails(
        dbMainTicket: Uint8Array,
        dbBonusTicket: Uint8Array,
        dbPlayerChoicesBegin: Uint8Array,
        dbPlayerChoicesContinue: Uint8Array,
    ): void {
        // The card is the whole ticket: there is no bonus round and no player choice.
        void dbBonusTicket;
        void dbPlayerChoicesBegin;
        void dbPlayerChoicesContinue;

        const ticket = new InstantWinTicketDetails();
        ticket.Reveals = this.context.storageHandler.convertFromVarbinaryToIntArray(dbMainTicket);
        ticket.Symbols = [...ticket.Reveals];

        this.context.ticketDetails = ticket;
    }

    prepareTicketForDatabase(): number[] {
        return [...this.ticket().Reveals];
    }

    prepareBonusTicketForDatabase(): number[] {
        return [];
    }

    preparePlayerChoicesForDatabase(): number[] {
        return [];
    }

    prepareJackpotTicket(): string {
        return 'not used';
    }

    getBonusRoundDetails(): BonusRoundDetails[] {
        return [];
    }

    setTicketFetcherDetails(): void {
        // The dealt card already travels on the message, so there is nothing extra to attach.
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

        return Object.assign(new InstantWinTicketDetails(), JSON.parse(cachedTicketJSON) as Partial<InstantWinTicketDetails>);
    }

    private ticket(): InstantWinTicketDetails {
        const ticket = this.context.ticketDetails as InstantWinTicketDetails | undefined;
        return ticket instanceof InstantWinTicketDetails ? ticket : new InstantWinTicketDetails();
    }
}
