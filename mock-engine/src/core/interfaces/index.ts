// Ported from Libraries/Tombola.B2B.Arcade/Interfaces/*.cs
// (+ Models/SimulationGameResult.cs, which IGameDebugHandler returns).

import { ArcadeResultCode } from '../ArcadeResultCode';
import { RequestType, SkinName, TransactionActionCode } from '../models/enums';
import { BaseArcadeRequest } from '../models/BaseArcadeRequest';
import { BaseArcadeResponse } from '../models/BaseArcadeResponse';
import { GameInternalData, RNGGameRequest, RNGGameResponse } from '../models/GameInternalData';
import { GameMessage } from '../models/GameMessage';
import { GameTicketDetails } from '../models/GameTicketDetails';

// MOCK: stands in for Tombola.Logging.Common.LoggingService, reduced to the surface the engine actually calls.
export interface ILoggingService {
    logWarning(message: string): void;
    logError(message: string): void;
}

export interface IArcadeSettings {
    ActiveVersion: string;
    WinMultipliers: number[];
    AnnounceWinnerMultipliers: number[];
    Rtp: number;
}

export interface SimulationGameResult {
    MainPayout: number;
    BonusPayout: number;
    Success: boolean;
}

export interface BonusRoundDetails {
    BonusRoundPrize: number;
    BonusRoundType: number;
}

/**
 * Provides access to game state for handlers without creating circular dependencies.
 */
export interface IGameContext {
    // Game identification
    requestType: RequestType;

    // Core game data
    request: BaseArcadeRequest;
    response: BaseArcadeResponse;
    readonly settings?: IArcadeSettings;
    internalData: GameInternalData;
    ticketDetails: GameTicketDetails;

    // MOCK: ArcadeConfig is not ported; games read what they need off internalData.

    // Game config
    readonly acceptedSkins: readonly SkinName[];
    stakeOptions: number[];
    readonly shouldCacheTickets: boolean;

    setSettings(version: string): void;
    populateResponseGameSettings(): void;

    validateAndSetStakeOptions(stakeOptions: number[]): void;
    validateRequestedStake(): boolean;

    // Access to other handlers
    readonly loggingService: ILoggingService;
    readonly flowHandler: IGameFlowHandler;
    readonly logicHandler: IGameLogicHandler;
    readonly debugHandler?: IGameDebugHandler;
    readonly storageHandler: IGameStorageHandler;
    readonly ticketHelper: IGameTicketHelper;

    // MOCK: IJackpotFlowHandler lives outside Interfaces/ and is not ported.
}

/**
 * Interface defining the contract for game-specific logic handlers.
 * Each game implements this interface to provide its unique gameplay logic.
 */
export interface IGameLogicHandler {
    /** Configures the RNG request based on game-specific requirements. */
    getRngRequest(): RNGGameRequest;

    /** Executes the core game logic and returns the game outcome. */
    playGame(): GameMessage;

    /** Use game logic to continue. */
    continueGame(): GameMessage;

    /** Sets ticket details based on request and game configuration. */
    setTicketDetails(): void;

    /** Checks for wins that need to be announced. */
    shouldAnnounceWin(gameMessage: GameMessage): boolean;

    /** Validates game-specific begin request data before RNG or storage processing. */
    validateBeginRequest(request: BaseArcadeRequest): void;

    /** Validates that the bonus request provided is valid. */
    validateBonusRoundRequest(request: BaseArcadeRequest): void;

    /** Validates that the game can be continued. */
    validateContinue(gameMessage: GameMessage): void;

    /**
     * Legacy method that processes a base RNG request to generate game outcomes.
     * Must now be capable of grabbing its own RNG request from the context.
     */
    processRngRequest(): Promise<RNGGameResponse>;
}

export interface IGameFlowHandler {
    // MOCK: the C# takes a CancellationToken, which has no zero-dependency equivalent here.
    beginGame(): Promise<void>;

    continueGame(): Promise<void>;

    resumeGame(): Promise<void>;

    beginDemoGame(): Promise<void>;

    continueDemoGame(): Promise<void>;

    resumeDemoGame(): Promise<void>;

    forceCloseIncompleteGame(): Promise<void>;

    reviewGame(): Promise<void>;

    // MOCK: JackpotApiResult<JackpotDataResponse> lives in the unported jackpot API layer.
    getJackpotPotValues(): Promise<unknown>;

    playSimGame(version: string): Promise<[number, number]>;
}

export interface IGameStorageHandler {
    // Core game data operations
    beforeBeginLogicAsync(): Promise<boolean>;
    beforeResumeLoadAsync(): Promise<boolean>;
    getRecentGameFromDatabase(): Promise<boolean>;
    getGameByIdFromDatabase(): Promise<boolean>;
    getUserFromDatabase(): Promise<boolean>;
    getGameInPlay(): Promise<void>;
    storeNewGame(): Promise<boolean>;
    insertGameInGameParentGameAsync(): Promise<boolean>;
    continueGame(): Promise<boolean>;
    afterAwardPrizeAsync(): Promise<void>;
    voidGameInDatabase(setContextResultCode?: boolean): Promise<boolean>;
    appendToTransactionLogAsync(transactionId: string, actionCode: TransactionActionCode, setContextResultCode?: boolean): Promise<boolean>;

    // Admin operations
    forceCloseIncompleteGame(): Promise<boolean>;

    // Cache operations
    deleteCachedGame(): Promise<void>;
    getGameFromCacheOrDatabase(): Promise<boolean>;
    cacheIncompleteGame(preserveExistingTtl?: boolean): Promise<void>;
    invalidateGameCache(): Promise<void>;
    doesGameExistInCache(): Promise<boolean>;
    abandonUnfinishedGame(): Promise<void>;

    // Demo cache operations
    cacheDemoBalance(): Promise<void>;
    checkIfDemoSessionExists(): Promise<boolean>;
    getDemoGameFromCache(): Promise<boolean>;
    cacheIncompleteDemoGame(): Promise<void>;
    deleteDemoGameFromCache(): Promise<void>;

    // Ticket operations
    setJackpotTicketDetails(dbJackpotTicket: string): void;
    setPreviousGameState(resultCode: ArcadeResultCode, dbTicket: Uint8Array): void;
    setTicketFetcherDetails(): void;

    // Ticket string conversion
    ticketToByteArray(): Uint8Array;
    bonusTicketToByteArray(): Uint8Array;
    playerChoiceToByteArray(): Uint8Array;
    convertFromVarbinaryToIntArray(input: Uint8Array): number[];
    convertIntArrayToVarbinary(array: number[]): Uint8Array;

    // Serialization
    deserialiseCachedTicket(cachedTicketJSON: string): GameTicketDetails;

    // Bonus game operations
    getBonusRoundDetails(): BonusRoundDetails[];

    // Utility methods
    getDBSkinName(): string;
    getDBResultCode(status: number): ArcadeResultCode;

    // MOCK: the SqlParameter/DataTable/SqlDataReader members are dropped — there is no SQL Server here.

    // Session and purchase operations
    checkMultiplePurchaseStatus(): Promise<void>;
    checkAwardedFreeplays(): Promise<void>;
    checkSessionCache(): Promise<void>;

    // Purchase blocking (expiry is milliseconds, standing in for TimeSpan)
    trySetPurchaseBlockAsync(gsUserId: number, expiry: number): Promise<boolean>;
    setPurchaseBlockExpiryAsync(gsUserId: number, expiry: number): Promise<void>;
    deletePurchaseBlockAsync(gsUserId: number): Promise<void>;

    // Demo version lookup
    getDemoVersionAsync(territoryCode: string, operatorId: string, mechanic: string, skin: string): Promise<string | undefined>;

    // Properties
    readonly cacheTickets: boolean;
    readonly skinSpecificResume: boolean;
}

/**
 * Interface for game-specific storage helper operations
 */
export interface IGameTicketHelper {
    /** Creates game-specific ticket details from database ticket and player choices */
    setTicketDetails(
        dbMainTicket: Uint8Array,
        dbBonusTicket: Uint8Array,
        dbPlayerChoicesBegin: Uint8Array,
        dbPlayerChoicesContinue: Uint8Array,
    ): void;

    /** Prepares main game ticket data for storage in database */
    prepareTicketForDatabase(): number[];

    /** Prepares bonus ticket data for storage in database */
    prepareBonusTicketForDatabase(): number[];

    /** Prepares ticket data for storage in database */
    preparePlayerChoicesForDatabase(): number[];

    /** Prepares jackpot ticket for database storage */
    prepareJackpotTicket(): string;

    /** Gets bonus round details for the game */
    getBonusRoundDetails(): BonusRoundDetails[];

    /** Sets ticket fetcher details for review mode */
    setTicketFetcherDetails(): void;

    /** Sets previous game state */
    setPreviousGameState(resultCode: ArcadeResultCode, dbTicket: string): void;

    /** Serialises ticket details to JSON */
    serialiseCachedTicket(ticket: GameTicketDetails): string;

    /** Deserialises cached ticket JSON */
    deserialiseCachedTicket(cachedTicketJSON: string): GameTicketDetails;
}

export interface IGameDebugHandler {
    applyOverridesAsync(context: IGameContext): Promise<void>;
    applyRngResponseAsync(context: IGameContext, rngResponse: RNGGameResponse): Promise<void>;
    playSimulationGameAsync(context: IGameContext, version: string, initializeSettings: (version: string) => boolean): Promise<SimulationGameResult>;
    bumpContinueRequestForSimulation(context: IGameContext): void;
}

/**
 * Interface for territory-specific random number generators
 */
export interface IRandomNumberGenerator {
    /** Returns a random integer between 0 (inclusive) and maxValue (exclusive) */
    getInt32(maxValue: number): Promise<number>;

    /** Returns an array (of length count) of random integers between 0 (inclusive) and maxValue (exclusive) */
    getInt32Range(minValue: number, maxValue: number, count: number): Promise<number[]>;
}

export interface IPlaceBetHandler {
    placeBet(): Promise<void>;
}

export interface IAwardPrizeHandler {
    awardPrize(networkSessionToken?: string): Promise<void>;
}

export interface ICancelBetHandler {
    cancelBet(originalBetTransactionId: string): Promise<void>;
}

export interface IGameSessionHandler {
    authorize(): Promise<void>;
    exchangeAndAssignToContext(gamingSessionToken?: string): Promise<void>;
    // MOCK: ExchangeTokenResponse lives in Tombola.GesInterface, which is not ported.
    exchange(gamingSessionToken?: string): Promise<unknown>;
}
