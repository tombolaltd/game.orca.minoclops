// Ported from Libraries/Tombola.B2B.Arcade/Models/GameInternalData.cs

import { GameFlowType, GameType, PlayMode } from './enums';

// MOCK: RNG payloads live in Tombola.RngSerialisation, which is not ported; games declare their own shapes.
export interface RNGGameRequest {
    [key: string]: unknown;
}

export interface RNGGameResponse {
    [key: string]: unknown;
}

// MOCK: ported from the GEP V2 contracts so GesData's amount builders survive intact.
export enum AmountType {
    REAL = 'REAL',
    BONUS = 'BONUS',
    JACKPOT = 'JACKPOT',
}

export interface Amount {
    Type: AmountType;
    Value: number;
}

// MOCK: not cryptographically random — this is a prototyping stand-in for Guid.NewGuid().
export function newGuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
        const random = Math.floor(Math.random() * 16);
        const value = char === 'x' ? random : (random % 4) + 8;
        return value.toString(16);
    });
}

let lastGameId = 1000000;

// Real engine game ids are numbers and clients coerce them with Number(), which turns a GUID into NaN.
export function newGameId(): string {
    lastGameId += 1;
    return String(lastGameId);
}

export interface ReviewData {
    PlayMode: PlayMode;
}

export interface GameNames {
    GameType: GameType;
    FriendlyGameName: string;
    EnabledGameName: string;
}

export interface Timestamps {
    StartStamp: string;
    EndStamp?: string;
    CompletedStamp?: string;
}

export class StoredProcedureConfig {
    Name: string;
    SchemaName?: string;

    constructor(name: string, schemaName?: string) {
        this.Name = name;
        this.SchemaName = schemaName;
    }

    fullyQualify(defaultSchemaName: string): string {
        return `${this.SchemaName ?? defaultSchemaName}.${this.Name}`;
    }
}

// MOCK: retained for shape only — the mock engine has no database.
export class GameDatabaseConfig {
    DatabaseName = '';
    SchemaName = '';
    PlayGameStoredProcedure = new StoredProcedureConfig('usp_PlayGame');
    GetGameRecentStoredProcedure = new StoredProcedureConfig('usp_GetGame_Recent');
    GetGameByIdStoredProcedure = new StoredProcedureConfig('usp_GetGame_Id');
    ContinueGameStoredProcedure = new StoredProcedureConfig('usp_ContinueGame');

    get PlayGameStoredProcedureName(): string {
        return this.PlayGameStoredProcedure.fullyQualify(this.SchemaName);
    }

    get GetGameRecentStoredProcedureName(): string {
        return this.GetGameRecentStoredProcedure.fullyQualify(this.SchemaName);
    }

    get GetGameByIdStoredProcedureName(): string {
        return this.GetGameByIdStoredProcedure.fullyQualify(this.SchemaName);
    }

    get ContinueGameStoredProcedureName(): string {
        return this.ContinueGameStoredProcedure.fullyQualify(this.SchemaName);
    }
}

export interface RequestMetadata {
    IP: string;
    RawRequest: string;
    RawUrl: string;
    Headers: string;
}

export interface TopPrizeData {
    /** should be stake * multiplier which has triggered the prize */
    AnnounceWinPrizeTriggers: number[];
    ShareWinsPublically: boolean;
    PopulateWinners: boolean;
}

export class GesData {
    GSUserId = 0;
    Nickname = '';
    NetworkSessionToken = '';
    AuthToken = '';
    CurrentSessionIsInvalid = false;
    NeedsNicknameToBeSet = false;
    TransactionIdBuyIn: string = newGuid();
    TransactionIdWin: string = newGuid();
    GameId: string = newGameId();
    GameVersion = '';
    GamingSessionTokenFromStorage = '';
    AttemptedToAwardPrize = false;
    BonusWalletSpend = 0;
    CurrencyCode = '';
    MinStakeAmount?: number;
    MaxStakeAmount?: number;
    AllowAutoplay?: boolean;
    JackpotPrize = 0;
    JackpotPotId?: number;
    JackpotImmediatePayout = false;
    JackpotNetworkName = '';
    JackpotContributionPercentage = 0;

    /** The game mechanic e.g. Spin5 */
    GepGameType = '';

    /** The {territory code}_{game mechanic} e.g. IT_Spin5 */
    GepGameName = '';

    /** the game skin e.g. Cosmos */
    GepSubType = '';

    /** Creates the bet amount based on the play mode and stake. */
    static betAmount(playMode: PlayMode, stake: number, freeplaysUsed?: number): Amount {
        let amountType = AmountType.REAL;
        let value = stake;

        switch (playMode) {
            case PlayMode.UnauthDemo:
                throw new Error('Demo play mode is not supported for amount calculation.');
            case PlayMode.Wallet:
                break;
            case PlayMode.FunBonus:
                amountType = AmountType.BONUS;
                break;
            case PlayMode.FreePlay:
                if (freeplaysUsed === undefined || freeplaysUsed === null || freeplaysUsed <= 0)
                    throw new Error('Free plays used cannot be null or <= 0 for the FreePlay PlayMode.');
                amountType = AmountType.BONUS;
                value = stake * freeplaysUsed;
                break;
        }

        return { Type: amountType, Value: value };
    }

    /** Creates a list of bet amounts, including any jackpot contribution. */
    static betAmounts(playMode: PlayMode, stake: number, freeplaysUsed?: number, jackpotContribution?: number): Amount[] {
        const amounts: Amount[] = [GesData.betAmount(playMode, stake, freeplaysUsed)];

        // Decide on jackpot contribution amount
        if (jackpotContribution !== undefined && jackpotContribution !== null) {
            let adjustedContribution = 0;
            if (playMode === PlayMode.Wallet) adjustedContribution = Math.trunc(jackpotContribution * 10000);

            amounts.push({ Type: AmountType.JACKPOT, Value: adjustedContribution });
        }

        return amounts;
    }

    /** Creates a list of prize amounts based on the play mode and prize won. */
    static prizeAmounts(playMode: PlayMode, prize: number, jackpotPrize?: number): Amount[] {
        const amounts: Amount[] = [];

        // Decide on amount type based on play mode
        let amountType: AmountType;
        switch (playMode) {
            case PlayMode.Wallet:
                amountType = AmountType.REAL;
                break;
            case PlayMode.FunBonus:
                amountType = AmountType.BONUS;
                break;
            case PlayMode.FreePlay:
                amountType = AmountType.BONUS;
                break;
            default:
                throw new Error(`Unsupported play mode: ${playMode}`);
        }

        // Add the main prize amount
        if (prize > 0) amounts.push({ Type: amountType, Value: prize });

        // Add jackpot prize if applicable
        if (jackpotPrize !== undefined && jackpotPrize > 0) amounts.push({ Type: AmountType.JACKPOT, Value: jackpotPrize });

        return amounts;
    }
}

export class GameInternalData {
    GameNames!: GameNames;
    DatabaseConfig!: GameDatabaseConfig;
    RequestMetadata!: RequestMetadata;
    TopPrizeData!: TopPrizeData;
    RngResponse!: RNGGameResponse;
    RngRequest!: RNGGameRequest;
    GesData: GesData = new GesData();
    Timestamps!: Timestamps;
    ReviewData?: ReviewData;
    GameIdGuid = '';
    SessionId = '';
    FlowType: GameFlowType = GameFlowType.None;
    ConnectionId = 0;
    RngSender = '';
    RngLocalId = '';
    RngResponseTime = 0;
    ProcessingTime = 0;
    LoggingRequestTime: string;
    PlayNewDBRequestTime = 0;
    UpdateDBRequestTime = 0;
    StoreBonusDBRequestTime = 0;
    GetGameDBRequestTime = 0;
    MinStakeDivisor = 0;
    GameHasContinues = false;
    ForceClosed = false;

    constructor() {
        this.LoggingRequestTime = new Date().toISOString();
    }
}
