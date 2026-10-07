// Ported from Libraries/Games/CashCollector3/CashCollector3TicketHelper.cs
// (+ CashCollector3TicketDetails / CashCollector3InternalData, declared alongside the game in the C#).

import { ArcadeResultCode } from '../../core/ArcadeResultCode';
import { BonusRoundDetails, IGameContext, IGameTicketHelper } from '../../core/interfaces';
import { GameInternalData } from '../../core/models/GameInternalData';
import { GameTicketDetails } from '../../core/models/GameTicketDetails';
import { CashCollectorBonusSpin, CashCollectorGameDetails, CashCollectorGameMessage, CashCollectorStateDetails } from './CashCollectorGameMessage';

export class CashCollectorTicketDetails extends GameTicketDetails {
    ReelPositions: number[] = [];
    /** One pre-drawn stop array per free spin the bonus could reach. */
    BonusReelPositions: number[][] = [];
    /** The player's progression at the START of this game. */
    GameState: CashCollectorStateDetails = { StateNumber: 1, CollectedSymbols: 0 };
    MainGameData: CashCollectorGameDetails | null = null;
    /** Only generated when the main game triggered the bonus. */
    BonusGameData: CashCollectorGameDetails[] = [];
    PlayedBonusSpins = 0;
    CurrentState = 0;
    CurrentCashSymbolCount = 0;
    /** The player's progression after this game — what the next game starts from. */
    EndState = 0;
    EndCashSymbolCount = 0;
}

export class CashCollectorInternalData extends GameInternalData {
    BonusSpins: CashCollectorBonusSpin[] = [];
    StartGameState: CashCollectorStateDetails | undefined;
    GeneratedMainGameData: CashCollectorGameDetails | undefined;
    GeneratedBonusGameData: CashCollectorGameDetails[] = [];
}

export class CashCollectorTicketHelper implements IGameTicketHelper {
    constructor(private readonly context: IGameContext) {
        if (context == null) throw new Error('context is required');
    }

    // MOCK: the C# decodes SQL varbinary columns here. The mock only ever stores JSON tickets
    // (serialiseCachedTicket), so the main ticket column is read back as that JSON.
    setTicketDetails(
        dbMainTicket: Uint8Array,
        dbBonusTicket: Uint8Array,
        dbPlayerChoicesBegin: Uint8Array,
        dbPlayerChoicesContinue: Uint8Array,
    ): void {
        void dbBonusTicket;
        void dbPlayerChoicesBegin;
        void dbPlayerChoicesContinue;

        // Serialised tickets are ASCII JSON, so a byte-wise decode is exact (and
        // needs no DOM / Node typings — the mock compiles against ES2019 only).
        let json = '';
        try {
            for (let i = 0; i < dbMainTicket.length; i += 1) json += String.fromCharCode(dbMainTicket[i]);
        } catch {
            json = '';
        }
        this.context.ticketDetails = json.length > 0 ? this.deserialiseCachedTicket(json) : new CashCollectorTicketDetails();
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
        const message = this.context.response.GameMessage as CashCollectorGameMessage | undefined;
        return [{ BonusRoundPrize: message?.BonusSpin?.TotalBonusPayout ?? 0, BonusRoundType: 1 }];
    }

    setTicketFetcherDetails(): void {
        const message = this.context.response.GameMessage as (CashCollectorGameMessage & { BonusSpinsTicketFetcher?: CashCollectorBonusSpin[] }) | undefined;
        if (message === undefined) return;

        message.BonusSpinsTicketFetcher = (this.context.internalData as CashCollectorInternalData).BonusSpins ?? [];
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

        return Object.assign(new CashCollectorTicketDetails(), JSON.parse(cachedTicketJSON) as Partial<CashCollectorTicketDetails>);
    }

    private ticket(): CashCollectorTicketDetails {
        const ticket = this.context.ticketDetails as CashCollectorTicketDetails | undefined;
        return ticket instanceof CashCollectorTicketDetails ? ticket : new CashCollectorTicketDetails();
    }
}
