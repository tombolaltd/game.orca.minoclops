// Ported from Libraries/Tombola.B2B.Arcade/GameFlowHandlers/GameFlowHandlerBase.cs
// (+ Config/OperatorFlowSettings.cs, Interfaces/IOperatorSettingsProvider.cs and
//    Interfaces/IResumeGameTerritoryPolicy.cs, which its constructor depends on).
//
// The compensation/rollback list is the whole point of this class and is ported verbatim:
// register-if-missing, deregister once a later step supersedes it, run in REVERSE order,
// swallow-and-log a failed compensation, clear once the critical path completes.
//
// MOCK: four C# concerns have no equivalent here and are dropped wholesale —
//   - CancellationToken / OperationCanceledException / ArcadeResultCode.Timeout (no
//     zero-dependency cancellation primitive exists, so nothing can cancel a walk),
//   - the jackpot-api HTTP layer: IJackpotFlowHandler's stage / confirm / cancel round trips
//     are collapsed into the local MockJackpotService, which is OPTIONAL and absent unless
//     the project opts in — with no service injected every jackpot step below is a no-op and
//     the response carries no Jackpot member, exactly as before,
//   - ArcadeConfig (replaced by the injected GameFlowHandlerConfig below),
//   - SQL transaction-log plumbing beyond the storage handler's in-memory append.
// Everything else — branch order, early-return-on-non-Success, result codes — is kept.

import { ArcadeResultCode } from '../core/ArcadeResultCode';
import {
    IAwardPrizeHandler,
    ICancelBetHandler,
    IGameContext,
    IGameFlowHandler,
    IGameSessionHandler,
    ILoggingService,
    IPlaceBetHandler,
} from '../core/interfaces';
import { JackpotDetails, JackpotPotValue } from '../core/models/BaseArcadeResponse';
import { GameMessage } from '../core/models/GameMessage';
import { newGuid } from '../core/models/GameInternalData';
import { PlayMode, Territory, TransactionActionCode } from '../core/models/enums';
import { MockJackpotBuyIn, MockJackpotOutcome, MockJackpotService } from '../jackpot/MockJackpotService';

// MOCK: RNGGameRequest/RNGGameResponse are open maps here (Tombola.RngSerialisation is not ported),
// so the fields the flow reads off them are named constants rather than typed members.
const RNG_DEBUG_RNG = 'DebugRng';
const RNG_SENDER = 'Sender';
const RNG_LOCAL_ID = 'LocalId';
const RNG_RESPONSE_TIME = 'ResponseTime';

export interface OperatorFlowSettings {
    /** Stake options in lowest denomination (for example pence or cents). */
    StakeOptions: number[];
    /** Currency code in ISO 4217 format, for example EUR or GBP. */
    CurrencyCode: string;
    MaxFreeplaysPerStake: number;
}

export interface IOperatorSettingsProvider {
    getSettings(operatorId: string): OperatorFlowSettings;
}

export interface IResumeGameTerritoryPolicy {
    beforePopulateResponseAsync(): Promise<void>;
}

// MOCK: stands in for JackpotApiResult<JackpotDataResponse>; only the fields the flow reads.
export interface JackpotPotValuesResult {
    Success: boolean;
    ErrorType?: string;
    DiagnosticMessage?: string;
    ConfigVersion?: number;
    CurrentPotValues: JackpotPotValue[];
}

// MOCK: the slice of ArcadeConfig the flow actually reads, injected instead of a config service.
export interface GameFlowHandlerConfig {
    /** ArcadeConfig.Cache.PurchaseBlockExpiry for this game type, in ms. 0 disables the block. */
    purchaseBlockExpiry?: number;
    /** ArcadeConfig.Cache.PurchaseBlockSafetyTimeout, in ms. Falls back to purchaseBlockExpiry. */
    purchaseBlockSafetyTimeout?: number;
    /** ArcadeConfig.Cache.Enabled. Demo games throw without it. */
    cacheEnabled?: boolean;
    /** ArcadeConfig.Game.DebugEnabled. Gates the debug handler inside processGameLogic. */
    debugEnabled?: boolean;
    /** ArcadeConfig.Api.ForceCloseDefaultLanguage. */
    forceCloseDefaultLanguage?: string;
}

export interface GameFlowHandlerDependencies {
    context: IGameContext;
    logger: ILoggingService;
    territory: Territory;
    operatorSettingsProvider: IOperatorSettingsProvider;
    gameSessionHandler: IGameSessionHandler;
    placeBetHandler: IPlaceBetHandler;
    cancelBetHandler: ICancelBetHandler;
    awardPrizeHandler: IAwardPrizeHandler;
    resumeGameTerritoryPolicy: IResumeGameTerritoryPolicy;
    /** Absent, or present but disabled, leaves every response's Jackpot member untouched. */
    jackpotService?: MockJackpotService;
    config?: GameFlowHandlerConfig;
}

interface Compensation {
    Name: string;
    Action: () => Promise<void>;
}

export abstract class GameFlowHandlerBase implements IGameFlowHandler {
    private readonly context: IGameContext;
    private readonly gameSessionHandler: IGameSessionHandler;
    protected placeBetHandler: IPlaceBetHandler;
    private readonly cancelBetHandler: ICancelBetHandler;
    private readonly awardPrizeHandler: IAwardPrizeHandler;
    protected readonly logger: ILoggingService;
    protected readonly territory: Territory;
    private readonly operatorSettingsProvider: IOperatorSettingsProvider;
    private readonly resumeGameTerritoryPolicy: IResumeGameTerritoryPolicy;
    protected readonly config: GameFlowHandlerConfig;
    private readonly jackpotService?: MockJackpotService;
    private jackpotBuyIn?: MockJackpotBuyIn;
    private jackpotOutcome?: MockJackpotOutcome;

    constructor(dependencies: GameFlowHandlerDependencies) {
        this.context = dependencies.context;
        this.placeBetHandler = dependencies.placeBetHandler;
        this.cancelBetHandler = dependencies.cancelBetHandler;
        this.awardPrizeHandler = dependencies.awardPrizeHandler;
        this.gameSessionHandler = dependencies.gameSessionHandler;
        this.logger = dependencies.logger;
        this.territory = dependencies.territory;
        this.operatorSettingsProvider = dependencies.operatorSettingsProvider;
        this.resumeGameTerritoryPolicy = dependencies.resumeGameTerritoryPolicy;
        this.jackpotService = dependencies.jackpotService?.enabled === true ? dependencies.jackpotService : undefined;
        this.config = dependencies.config ?? {};
    }

    /** Processes the complete begin game flow including validations, RNG request, gameplay, and storage. */
    async beginGame(): Promise<void> {
        const compensations: Compensation[] = [];
        const request = this.context.request;

        // Authenticate with session manager and assign any necessary information to context
        await this.gameSessionHandler.exchangeAndAssignToContext();
        if (this.context.internalData.GesData.CurrentSessionIsInvalid) {
            await this.failBeginGameAndRunCompensations(
                `Session is invalid for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}. Prompting client to refresh session.`,
                compensations,
                ArcadeResultCode.InvalidSession,
            );
            return;
        } else if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            await this.failBeginGameAndRunCompensations(
                `GEP exchange failed for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}, ResultCode: ${this.context.response.ResultCode.Description}`,
                compensations,
            );
            return;
        }

        // MOCK: the real engine refuses a buy-in while a game is unfinished (GameInPlay) and waits
        // for the client to resume it. A prototype whose bonus flow is broken would then be stuck
        // for the whole cache lifetime, so the unfinished game is abandoned instead.
        if (await this.context.storageHandler.doesGameExistInCache()) {
            await this.context.storageHandler.abandonUnfinishedGame();
            this.logger.logWarning(
                `Abandoned an unfinished game for operatorUserId: ${request.OperatorUserId} so a new one could start. The real engine would refuse this buy-in until the game is resumed.`,
            );
        }

        // Set an initial purchase block to last for the duration of the game processing
        const gsUserId = this.context.internalData.GesData.GSUserId;
        const purchaseBlockExpiry = this.config.purchaseBlockExpiry ?? 0;
        const purchaseBlockEnabled = purchaseBlockExpiry > 0;
        if (purchaseBlockEnabled) {
            const safetyTimeout = this.config.purchaseBlockSafetyTimeout ?? 0;
            const safetyExpiry = safetyTimeout > 0 ? safetyTimeout : purchaseBlockExpiry;

            const blockSet = await this.context.storageHandler.trySetPurchaseBlockAsync(gsUserId, safetyExpiry);
            if (!blockSet) {
                await this.failBeginGameAndRunCompensations(
                    `Failed to set purchase block for gsUserId: ${gsUserId}`,
                    compensations,
                    ArcadeResultCode.PurchaseBlockedDueToSpam,
                );
                return;
            }
        }

        try {
            // Set the game's settings based on the version provided by session manager
            this.initializeSettings(this.context.internalData.GesData.GameVersion);
            if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
                await this.failBeginGameAndRunCompensations(
                    `Failed to initialise settings for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}, ResultCode: ${this.context.response.ResultCode.Description}`,
                    compensations,
                );
                return;
            }

            const operatorFlowSettings = this.getOperatorFlowSettings();
            this.context.validateAndSetStakeOptions(operatorFlowSettings.StakeOptions);
            if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

            if (!this.context.validateRequestedStake()) return;

            if (!this.validateRequestedFreeplays()) return;

            this.context.logicHandler.validateBeginRequest(this.context.request);
            if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

            // MOCK: TryStageJackpotBuyInAsync's jackpot-api round trip becomes a local pot
            // contribution, but its CancelStagedJackpotBuyIn compensation is kept verbatim.
            this.stageJackpotBuyIn(compensations);

            if (!(await this.context.storageHandler.beforeBeginLogicAsync())) {
                await this.failBeginGameAndRunCompensations(
                    `Pre-begin storage policy failed for operatorUserId: ${request.OperatorUserId}, GameId: ${this.context.internalData.GesData.GameId}, ResultCode: ${this.context.response.ResultCode.Description}`,
                    compensations,
                    this.context.response.ResultCode === ArcadeResultCode.Success ? ArcadeResultCode.DatabaseError : undefined,
                );
                return;
            }

            // Process main game logic, resulting in a complete game message being assigned to the context
            await this.processGameLogic();
            if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
                await this.failBeginGameAndRunCompensations(
                    `Failed to process game logic for operatorUserId: ${request.OperatorUserId}, ResultCode: ${this.context.response.ResultCode.Description}`,
                    compensations,
                );
                return;
            }

            // Log the buy-in transaction before placing the bet
            const buyInLogged = await this.context.storageHandler.appendToTransactionLogAsync(
                this.context.internalData.GesData.TransactionIdBuyIn,
                TransactionActionCode.BuyIn,
            );
            if (!buyInLogged) {
                await this.failBeginGameAndRunCompensations(
                    `Failed to log buy-in transaction for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}`,
                    compensations,
                    ArcadeResultCode.DatabaseError,
                );
                return;
            }

            if (!(await this.tryPlaceBet(compensations))) return;

            // MOCK: TryConfirmJackpotAsync settles against the local pots instead of jackpot-api.
            this.confirmJackpotBuyIn(compensations);

            if (!(await this.tryStoreNewGame(compensations))) return;

            // Cache incomplete game for bonus rounds, only when successful
            if (this.context.response.GameMessage?.GameComplete === false) {
                await this.context.storageHandler.cacheIncompleteGame();

                this.registerCompensationIfMissing(compensations, 'InvalidateGameCache', async () => {
                    this.logger.logWarning(
                        `Compensating after an incomplete game was cached for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}. Proceeding to invalidate game cache.`,
                    );

                    await this.context.storageHandler.invalidateGameCache();
                });
            }

            // Populate response game settings
            this.context.populateResponseGameSettings();

            if (!(await this.tryAwardPrize(compensations))) return;

            // At this point, the critical path has been completed successfully
            compensations.length = 0;
        } catch (error) {
            this.deregisterCancelAndVoidAfterAwardAttempt(compensations);
            await this.runCompensations(compensations);
            throw error;
        } finally {
            // Reset the purchase block TTL so the full cooldown starts from now
            if (purchaseBlockEnabled) {
                await this.context.storageHandler.setPurchaseBlockExpiryAsync(gsUserId, purchaseBlockExpiry);

                // If the flow did not complete successfully, delete the purchase block so the player can retry immediately
                if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
                    try {
                        // because we don't want to lose the original error if this fails
                        await this.context.storageHandler.deletePurchaseBlockAsync(gsUserId);
                    } catch (error) {
                        this.logger.logError(`Failed to delete purchase block during cleanup for gsUserId: ${gsUserId}. ${describeError(error)}`);
                    }
                }
            }
        }
    }

    private async failBeginGameAndRunCompensations(
        message: string,
        compensations: Compensation[],
        resultCode?: ArcadeResultCode,
        error?: unknown,
        logAsWarning = false,
    ): Promise<void> {
        if (resultCode != null) this.context.response.ResultCode = resultCode;

        if (error === undefined) {
            if (logAsWarning) this.logger.logWarning(message);
            else this.logger.logError(message);
        } else this.logger.logError(`${message} ${describeError(error)}`);

        if (
            this.context.internalData.GesData.AttemptedToAwardPrize &&
            this.context.response.ResultCode !== ArcadeResultCode.AwardPrizeNonRetriableGepError
        ) {
            this.deregisterCancelAndVoidAfterAwardAttempt(compensations);
        }

        if (compensations.length > 0) await this.runCompensations(compensations);
    }

    private deregisterCancelAndVoidAfterAwardAttempt(compensations: Compensation[]): void {
        if (!this.context.internalData.GesData.AttemptedToAwardPrize) return;

        this.deregisterCompensation(compensations, 'CancelBet');
        this.deregisterCompensation(compensations, 'CancelBetAndVoidGame');
    }

    private async tryPlaceBet(compensations: Compensation[]): Promise<boolean> {
        const request = this.context.request;

        await this.placeBetHandler.placeBet();
        if (this.context.response.ResultCode === ArcadeResultCode.ShouldCancelBet) {
            this.registerCompensationIfMissing(compensations, 'CancelBet', () =>
                this.cancelBetHandler.cancelBet(this.context.internalData.GesData.TransactionIdBuyIn),
            );

            await this.failBeginGameAndRunCompensations(
                `Place Bet requires reconciliation for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}. Proceeding to cancel bet.`,
                compensations,
                undefined,
                undefined,
                true,
            );
            return false;
        }

        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            await this.failBeginGameAndRunCompensations(
                `Place Bet failed for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}, ResultCode: ${this.context.response.ResultCode.Description}`,
                compensations,
            );
            return false;
        }

        // Queued in the event of a later failure
        this.registerCompensationIfMissing(compensations, 'CancelBet', () =>
            this.cancelBetHandler.cancelBet(this.context.internalData.GesData.TransactionIdBuyIn),
        );

        return true;
    }

    /** Merges into response.Jackpot, leaving every field the caller did not set omitted. */
    private setJackpotDetails(patch: Partial<JackpotDetails>): void {
        this.context.response.Jackpot = { ...(this.context.response.Jackpot ?? { CurrentPotValues: [] }), ...patch };
    }

    /**
     * Contributes this bet's stake to every pot and reports the config version. Begin never
     * returns CurrentPotValues, so the member is left as the empty default.
     */
    private stageJackpotBuyIn(compensations: Compensation[]): void {
        const service = this.jackpotService;
        if (service === undefined) return;

        const buyIn = service.buyIn(this.context.request.Stake);
        this.jackpotBuyIn = buyIn;

        const gesData = this.context.internalData.GesData;
        gesData.JackpotNetworkName = service.networkName;
        gesData.JackpotContributionPercentage = service.totalContributionPercent;
        this.setJackpotDetails({ ConfigVersion: buyIn.ConfigVersion });

        this.registerCompensationIfMissing(compensations, 'CancelStagedJackpotBuyIn', async () => service.rollback(buyIn));
    }

    private async checkJackpotWin(): Promise<void> {
        const service = this.jackpotService;
        if (service === undefined || this.jackpotBuyIn === undefined) return;

        const outcome = await service.evaluate(this.context.request.DebugJackpotData);
        if (outcome.ValidationError !== undefined) {
            this.context.response.ResultCode = ArcadeResultCode.InvalidRequestInput;
            this.logger.logWarning(`Invalid jackpot debug request: ${outcome.ValidationError}`);
            return;
        }

        this.jackpotOutcome = outcome;
        if (!outcome.JackpotWin) return;

        this.context.ticketDetails.JackpotWin = outcome.Tier;
        this.context.ticketDetails.GemLayouts = outcome.GemLayouts;
    }

    private confirmJackpotBuyIn(compensations: Compensation[]): void {
        const service = this.jackpotService;
        const outcome = this.jackpotOutcome;
        if (service === undefined || outcome === undefined) return;

        service.confirm(outcome);
        this.deregisterCompensation(compensations, 'CancelStagedJackpotBuyIn');

        const gesData = this.context.internalData.GesData;
        gesData.JackpotPrize = outcome.JackpotPrize ?? 0;
        gesData.JackpotPotId = outcome.WinningPot?.TierId;
        gesData.JackpotImmediatePayout = outcome.WinningDetails?.ImmediateWin ?? false;

        if (!outcome.JackpotWin) {
            this.setJackpotDetails({ ConfigVersion: service.configVersion, JackpotWin: false });
            return;
        }

        this.setJackpotDetails({
            ConfigVersion: service.configVersion,
            JackpotWin: true,
            JackpotPrize: outcome.JackpotPrize,
            WinningPot: outcome.WinningPot,
            WinningTicket: outcome.WinningTicket,
            WinningDetails: outcome.WinningDetails,
        });
    }

    private async tryStoreNewGame(compensations: Compensation[]): Promise<boolean> {
        const request = this.context.request;

        let storeSuccess: boolean;
        try {
            storeSuccess = await this.context.storageHandler.storeNewGame();
        } catch (error) {
            await this.failBeginGameAndRunCompensations(
                `Exception storing new game for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}. Proceeding to run compensations.`,
                compensations,
                undefined,
                error,
            );
            return false;
        }

        if (!storeSuccess) {
            await this.failBeginGameAndRunCompensations(
                `Failed to store new game for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}. Proceeding to run compensations.`,
                compensations,
            );
            return false;
        }

        this.deregisterCompensation(compensations, 'CancelBet');
        this.registerCompensationIfMissing(compensations, 'CancelBetAndVoidGame', () => this.cancelBetAndVoidGame());

        this.queueGameInGameParentInsert();

        return true;
    }

    private queueGameInGameParentInsert(): void {
        const parentGameName = this.context.request.Parent?.gameName;
        if (parentGameName === undefined || parentGameName.trim().length === 0) return;

        const request = this.context.request;
        try {
            // Deliberately not awaited, exactly as the C# fire-and-forget continuation.
            void this.context.storageHandler.insertGameInGameParentGameAsync().then(undefined, error => {
                this.logger.logWarning(
                    `Game-in-game parent insert failed for operatorUserId: ${request.OperatorUserId}, GameId: ${this.context.internalData.GesData.GameId}. ${describeError(error)}`,
                );
            });
        } catch (error) {
            this.logger.logWarning(
                `Failed to queue game-in-game parent insert for operatorUserId: ${request.OperatorUserId}, GameId: ${this.context.internalData.GesData.GameId}. Continuing without blocking main flow. ${describeError(error)}`,
            );
        }
    }

    private async tryAwardPrize(compensations: Compensation[]): Promise<boolean> {
        const request = this.context.request;

        if (this.context.response.GameMessage?.GameComplete !== true) return true;

        const endWagerLogged = await this.context.storageHandler.appendToTransactionLogAsync(
            this.context.internalData.GesData.TransactionIdWin,
            TransactionActionCode.EndWager,
        );
        if (!endWagerLogged) {
            await this.failBeginGameAndRunCompensations(
                `Failed to log end wager transaction for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}`,
                compensations,
                ArcadeResultCode.DatabaseError,
            );
            return false;
        }

        await this.awardPrizeHandler.awardPrize();
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            await this.failBeginGameAndRunCompensations(
                `Failed to award prize for operatorUserId: ${request.OperatorUserId}, ResultCode: ${this.context.response.ResultCode.Description}`,
                compensations,
            );
            return false;
        }

        await this.runAfterAwardPrize();

        return true;
    }

    private async runAfterAwardPrize(): Promise<void> {
        try {
            await this.context.storageHandler.afterAwardPrizeAsync();
        } catch (error) {
            this.logger.logWarning(
                `Post-award storage extension failed for operatorUserId: ${this.context.request.OperatorUserId}, GameId: ${this.context.internalData.GesData.GameId}. Continuing because the prize was already awarded. ${describeError(error)}`,
            );
        }
    }

    private registerCompensationIfMissing(compensations: Compensation[], name: string, action: () => Promise<void>): void {
        if (compensations.some(compensation => compensation.Name === name)) return;

        compensations.push({ Name: name, Action: action });
    }

    private deregisterCompensation(compensations: Compensation[], name: string): void {
        for (let i = compensations.length - 1; i >= 0; i--) if (compensations[i].Name === name) compensations.splice(i, 1);
    }

    private async runCompensations(compensations: Compensation[]): Promise<void> {
        for (let i = compensations.length - 1; i >= 0; i--) {
            try {
                await compensations[i].Action();
            } catch (error) {
                this.logger.logError(
                    `Compensation '${compensations[i].Name}' failed for operatorUserId: ${this.context.request.OperatorUserId}, SessionToken: ${this.context.request.GamingSessionToken}. ${describeError(error)}`,
                );
            }
        }
        compensations.length = 0;
    }

    /** Core game logic processing: RNG request, outcome calculation, and prize determination. */
    private async processGameLogic(): Promise<void> {
        const request = this.context.request;

        this.context.internalData.RngResponse = await this.context.logicHandler.processRngRequest();

        if (this.context.internalData.RngResponse == null) {
            this.logger.logError(
                `Failed to get RNG response for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}`,
            );
            this.context.response.ResultCode = ArcadeResultCode.RngError;
            return;
        }

        // Handle debug mode if enabled
        if (this.config.debugEnabled === true && request.DebugGameData != null) {
            if (this.context.debugHandler != null) {
                await this.context.debugHandler.applyOverridesAsync(this.context);

                if (this.context.internalData.RngRequest?.[RNG_DEBUG_RNG] === true) {
                    const debugRngResponse = await this.context.logicHandler.processRngRequest();
                    await this.context.debugHandler.applyRngResponseAsync(this.context, debugRngResponse);
                }
            }
        }

        // Set ticket details based on RNG response
        this.context.logicHandler.setTicketDetails();

        if (this.context.internalData.RngResponse == null) {
            this.logger.logError(
                `Failed to get RNG response for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}`,
            );
            this.context.response.ResultCode = ArcadeResultCode.RngError;
            return;
        }

        // Set response details from RNG
        this.setResponseDetailsFromRng();

        // Play the main game and assign any remaining values
        this.context.response.GameMessage = this.context.logicHandler.playGame();
        this.context.response.GameMessage.GameId = this.context.internalData.GesData.GameId;

        // MOCK: CheckJackpotWin reads the local pots instead of a staged jackpot-api buy-in.
        await this.checkJackpotWin();
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

        // Check for wins that need announcements; the storage handler acts on it during storeNewGame.
        this.context.logicHandler.shouldAnnounceWin(this.context.response.GameMessage);
    }

    /** Continues the game for multi-phase gameplay (bonus rounds). */
    async continueGame(): Promise<void> {
        const request = this.context.request;

        await this.gameSessionHandler.exchangeAndAssignToContext();
        if (
            this.context.response.ResultCode !== ArcadeResultCode.Success &&
            this.context.response.ResultCode !== ArcadeResultCode.InvalidSession
        ) {
            this.logger.logError(
                `GEP exchange failed for operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}, ResultCode: ${this.context.response.ResultCode.Description}`,
            );
            return;
        }

        const gameId = parseGameId(request.GameId);
        if (gameId === undefined) {
            this.context.response.ResultCode = ArcadeResultCode.GameNotFound;
            return;
        }

        this.context.internalData.GesData.GameId = gameId;

        const operatorFlowSettings = this.getOperatorFlowSettings();
        this.context.validateAndSetStakeOptions(operatorFlowSettings.StakeOptions);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

        // Get game from cache or database
        const gameFound = await this.context.storageHandler.getGameFromCacheOrDatabase();
        if (!gameFound) {
            this.context.response.ResultCode = ArcadeResultCode.GameNotFound;
            this.logger.logWarning(
                `Game not found for continueGame - UserId: ${request.OperatorUserId}, GameId: ${request.GameId}, SessionToken: ${request.GamingSessionToken}`,
            );
            return;
        }

        this.validateCachedGame();
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

        // Settings were already determined and assigned from the stored game.

        // Validate that the game can be continued
        this.context.logicHandler.validateContinue(this.context.response.GameMessage as GameMessage);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            this.logger.logError(
                `Game validation failed for continueGame - UserId: ${request.OperatorUserId}, ResultCode: ${this.context.response.ResultCode.Description}, SessionToken: ${request.GamingSessionToken}`,
            );
            return;
        }

        // Check the bonus request provided is valid
        this.context.logicHandler.validateBonusRoundRequest(this.context.request);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            this.logger.logError(
                `Bonus round validation failed - UserId: ${request.OperatorUserId}, ResultCode: ${this.context.response.ResultCode.Description}, SessionToken: ${request.GamingSessionToken}`,
            );
            return;
        }

        // Execute the bonus round logic
        const gameMessage = this.context.logicHandler.continueGame();
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

        // Set additional game message properties
        gameMessage.Stake = this.context.ticketDetails.Stake;
        gameMessage.Skin = this.context.request.Skin;
        this.context.response.GameMessage = gameMessage;
        this.context.response.GameMessage.GameId = this.context.internalData.GesData.GameId;

        let storeSuccess: boolean;
        try {
            storeSuccess = await this.context.storageHandler.continueGame();
        } catch (error) {
            this.logger.logError(
                `Exception storing continued game for UserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}. ${describeError(error)}`,
            );
            // Result code is set by the storage handler.
            return;
        }

        if (!storeSuccess) {
            this.logger.logError(
                `Failed to store continued game for UserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}.`,
            );
            // Result code is set by the storage handler.
            return;
        }

        // Update or invalidate cache based on game completion
        if (gameMessage.GameComplete) await this.context.storageHandler.invalidateGameCache();
        else await this.context.storageHandler.cacheIncompleteGame(true);

        this.context.populateResponseGameSettings();

        // Award winnings with GEP
        if (this.context.response.GameMessage.GameComplete) {
            // Log the end wager transaction before awarding the prize
            const endWagerLogged = await this.context.storageHandler.appendToTransactionLogAsync(
                this.context.internalData.GesData.TransactionIdWin,
                TransactionActionCode.EndWager,
            );
            if (!endWagerLogged) {
                this.logger.logError(
                    `Failed to log end wager transaction for UserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}`,
                );
                this.context.response.ResultCode = ArcadeResultCode.DatabaseError;
                return;
            }

            // Check if we need to fetch a valid network session token for awarding the prize
            let networkSessionToken: string | undefined = this.context.internalData.GesData.NetworkSessionToken;
            if (this.context.internalData.GesData.GamingSessionTokenFromStorage !== request.GamingSessionToken) {
                // Exchange the stored gaming session token for one that is valid for awarding the prize.
                const tempExchangeToken = (await this.gameSessionHandler.exchange(
                    this.context.internalData.GesData.GamingSessionTokenFromStorage,
                )) as { NetworkSessionToken?: string } | undefined;
                networkSessionToken = tempExchangeToken?.NetworkSessionToken;
            }

            // Award the prize using the (potentially new) network session token
            await this.awardPrizeHandler.awardPrize(networkSessionToken);
            if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
                if (this.context.response.ResultCode === ArcadeResultCode.AwardPrizeNonRetriableGepError) await this.cancelBetAndVoidGame();

                this.logger.logError(
                    `Failed to award prize for UserId: ${request.OperatorUserId}, ResultCode: ${this.context.response.ResultCode.Description}`,
                );
                return;
            }

            await this.runAfterAwardPrize();

            // Instruct client to refresh if the session is invalid
            this.context.response.PlayState.ShouldRefreshBeforeNextBuyIn =
                this.context.internalData.GesData.CurrentSessionIsInvalid ||
                this.context.internalData.GesData.GameVersion !== this.context.response.GameSettings.Version;
        }
    }

    private async cancelBetAndVoidGame(): Promise<void> {
        const request = this.context.request;

        this.logger.logWarning(
            `Proceeding to cancel the bet before marking the game as refunded for operatorUserId: ${request.OperatorUserId}, GameId: ${this.context.internalData.GesData.GameId}, SessionToken: ${request.GamingSessionToken}.`,
        );

        await this.cancelBetHandler.cancelBet(this.context.internalData.GesData.TransactionIdBuyIn);
        if (!this.context.response.PlayState.BetCancelled) {
            this.logger.logError(
                `Bet cancellation was not confirmed; game will not be marked as refunded for operatorUserId: ${request.OperatorUserId}, GameId: ${this.context.internalData.GesData.GameId}, SessionToken: ${request.GamingSessionToken}, ResultCode: ${this.context.response.ResultCode.Description}`,
            );
            return;
        }

        try {
            const voided = await this.context.storageHandler.voidGameInDatabase(false);
            if (!voided) {
                this.logger.logError(
                    `Failed to mark game as refunded after confirmed cancellation for operatorUserId: ${request.OperatorUserId}, GameId: ${this.context.internalData.GesData.GameId}, SessionToken: ${request.GamingSessionToken}, ResultCode: ${this.context.response.ResultCode.Description}`,
                );

                await this.recordVoidFailure();
            }
        } catch (error) {
            this.logger.logError(
                `Exception marking game as refunded after confirmed cancellation for operatorUserId: ${request.OperatorUserId}, GameId: ${this.context.internalData.GesData.GameId}, SessionToken: ${request.GamingSessionToken}. ${describeError(error)}`,
            );

            await this.recordVoidFailure();
            throw error;
        }
    }

    private async recordVoidFailure(): Promise<void> {
        const transactionId = newGuid();
        try {
            const recorded = await this.context.storageHandler.appendToTransactionLogAsync(
                transactionId,
                TransactionActionCode.VoidFailure,
                false,
            );
            if (!recorded) {
                this.logger.logError(
                    `Failed to append void failure to the transaction log. GameId: ${this.context.internalData.GesData.GameId}, TransactionId: ${transactionId}, ActionCode: ${TransactionActionCode.VoidFailure}`,
                );
            }
        } catch (error) {
            this.logger.logError(
                `Exception appending void failure to the transaction log. GameId: ${this.context.internalData.GesData.GameId}, TransactionId: ${transactionId}, ActionCode: ${TransactionActionCode.VoidFailure}. ${describeError(error)}`,
            );
        }
    }

    /** Validates the cached game data. */
    private validateCachedGame(): void {
        // Check if the game is already complete
        if (this.context.response.GameMessage?.GameComplete === true) {
            this.context.response.ResultCode = ArcadeResultCode.GameAlreadyComplete;
            return;
        }

        // Ensure ticket details exist
        if (this.context.ticketDetails == null) {
            this.context.response.ResultCode = ArcadeResultCode.TicketNotFound;
            return;
        }

        this.context.response.ResultCode = ArcadeResultCode.Success;
    }

    private validateRequestedFreeplays(): boolean {
        const request = this.context.request;
        const operatorFlowSettings = this.getOperatorFlowSettings();

        if (request.PlayMode === PlayMode.FreePlay) {
            if (request.FreeplaysUsed <= 0) {
                this.logger.logWarning(`Invalid number of FreeplaysUsed requested. FreeplaysUsed: ${request.FreeplaysUsed}`);
                this.context.response.ResultCode = ArcadeResultCode.InvalidStake;
                return false;
            }

            if (request.FreeplaysUsed > operatorFlowSettings.MaxFreeplaysPerStake) {
                this.logger.logWarning(
                    `Requested FreeplaysUsed ${request.FreeplaysUsed} exceeds max allowed ${operatorFlowSettings.MaxFreeplaysPerStake} for operator ${request.OperatorId}.`,
                );
                this.context.response.ResultCode = ArcadeResultCode.InvalidStake;
                return false;
            }
        } else if (request.FreeplaysUsed !== 0) {
            this.logger.logWarning(`Invalid number of FreeplaysUsed requested. FreeplaysUsed: ${request.FreeplaysUsed}`);
            this.context.response.ResultCode = ArcadeResultCode.InvalidStake;
            return false;
        }

        return true;
    }

    private getOperatorFlowSettings(): OperatorFlowSettings {
        return this.operatorSettingsProvider.getSettings(this.context.request.OperatorId);
    }

    // MOCK: without a jackpot service every skin fails the configuration check, exactly as a
    // non-jackpot skin does in the C#. The session exchange still runs so the envelope is honest.
    async getJackpotPotValues(): Promise<JackpotPotValuesResult> {
        const request = this.context.request;

        await this.gameSessionHandler.exchangeAndAssignToContext();
        if (this.context.internalData.GesData.CurrentSessionIsInvalid) {
            this.context.response.ResultCode = ArcadeResultCode.InvalidSession;
            this.logger.logWarning(
                `Session is invalid for jackpot pot values request. operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}.`,
            );
            return { Success: false, ErrorType: 'Domain', DiagnosticMessage: 'Gaming session token is invalid.', CurrentPotValues: [] };
        }

        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            this.logger.logError(
                `GEP exchange failed for jackpot pot values request. operatorUserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}, ResultCode: ${this.context.response.ResultCode.Description}`,
            );
            return { Success: false, ErrorType: 'Domain', DiagnosticMessage: 'Gaming session token exchange failed.', CurrentPotValues: [] };
        }

        if (this.jackpotService !== undefined) {
            return {
                Success: true,
                ConfigVersion: this.jackpotService.configVersion,
                CurrentPotValues: this.jackpotService.currentPotValues(),
            };
        }

        this.context.response.ResultCode = ArcadeResultCode.GameUnavailable;
        this.logger.logWarning(`Jackpot pot values requested for non-jackpot skin ${request.Skin}.`);
        return {
            Success: false,
            ErrorType: 'Configuration',
            DiagnosticMessage: 'Requested skin is not configured as a jackpot skin.',
            CurrentPotValues: [],
        };
    }

    /** Sets response details from the RNG response. */
    private setResponseDetailsFromRng(): void {
        const rngResponse = this.context.internalData.RngResponse;

        this.context.response.ServiceDetails.ServiceB = rngResponse == null ? 'Unknown' : String(rngResponse);
        this.context.internalData.RngSender = asString(rngResponse?.[RNG_SENDER]);
        this.context.internalData.RngLocalId = asString(rngResponse?.[RNG_LOCAL_ID]);
        this.context.internalData.RngResponseTime = asNumber(rngResponse?.[RNG_RESPONSE_TIME]);
    }

    /** Processes the complete resume game flow, retrieving a previously played game. */
    async resumeGame(): Promise<void> {
        const request = this.context.request;

        await this.gameSessionHandler.authorize();
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            this.logger.logError(
                `GEP Auth failed for UserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}, ResultCode: ${this.context.response.ResultCode.Description}`,
            );
            return;
        }

        const operatorFlowSettings = this.getOperatorFlowSettings();
        this.context.validateAndSetStakeOptions(operatorFlowSettings.StakeOptions);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

        // MOCK: TryPopulateResumeJackpotDetailsAsync reads the local pots rather than jackpot-api,
        // so it can never fail with a jackpot service error result code. Resume evaluates no
        // outcome, so JackpotWin stays omitted.
        if (this.jackpotService !== undefined) {
            this.setJackpotDetails({
                ConfigVersion: this.jackpotService.configVersion,
                CurrentPotValues: this.jackpotService.currentPotValues(),
            });
        }

        if (!(await this.context.storageHandler.beforeResumeLoadAsync())) return;

        // Try cache first, then database
        const gameFound =
            !this.context.internalData.GesData.NeedsNicknameToBeSet && (await this.context.storageHandler.getGameFromCacheOrDatabase());

        if (gameFound && !this.context.internalData.ForceClosed) {
            this.context.response.GameMessage = this.context.logicHandler.playGame();
            this.context.response.GameMessage.GameId = this.context.internalData.GesData.GameId;
            this.queueGameInGameParentInsert();
        } else if (this.context.internalData.GesData.GameVersion.length > 0) {
            this.initializeSettings(this.context.internalData.GesData.GameVersion);
        } else throw new Error('We had no version for a new player resuming their game.');

        if (this.context.response.GameMessage?.GameComplete === false) this.context.response.PlayState.ShouldCloseGame = false;

        await this.resumeGameTerritoryPolicy.beforePopulateResponseAsync();
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

        this.context.populateResponseGameSettings();

        if (this.context.internalData.GesData.NeedsNicknameToBeSet && this.context.response.ResultCode === ArcadeResultCode.Success) {
            this.context.response.PlayerData.NewPlayer = true;
            this.context.response.PlayState.NeedsNicknameToBeSet = true;
        }
    }

    /** Initializes the game settings using a version retrieved from the GEP. */
    private initializeSettings(requestVersion: string): void {
        try {
            this.context.setSettings(requestVersion);
        } catch (error) {
            this.logger.logError(
                `Failed to initialize settings with version: ${requestVersion} for UserId: ${this.context.request.OperatorUserId}, SessionToken: ${this.context.request.GamingSessionToken}. ${describeError(error)}`,
            );
            this.context.response.ResultCode = ArcadeResultCode.VersionInvalid;
        }
    }

    async beginDemoGame(): Promise<void> {
        const request = this.context.request;

        if (this.config.cacheEnabled === false) throw new Error('Demo games require caching to be enabled.');

        const operatorFlowSettings = this.getOperatorFlowSettings();
        this.context.internalData.GesData.CurrencyCode = operatorFlowSettings.CurrencyCode;
        this.context.validateAndSetStakeOptions(operatorFlowSettings.StakeOptions);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

        if (this.context.response.Tokens == null) this.context.response.Tokens = { GamingSessionToken: request.GamingSessionToken };

        // There must be a demo account
        if (!(await this.context.storageHandler.checkIfDemoSessionExists())) {
            this.context.response.ResultCode = ArcadeResultCode.DemoGameNotFound;
            return;
        }

        // Read the demo version from cache
        const demoVersion = await this.getDemoVersion();
        if (demoVersion === undefined || demoVersion.length === 0) {
            this.context.response.ResultCode = ArcadeResultCode.VersionInvalid;
            return;
        }

        this.initializeSettings(demoVersion);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            this.logger.logError(
                `Failed to initialize settings for UserId: ${request.OperatorUserId}, SessionToken: ${request.GamingSessionToken}, ResultCode: ${this.context.response.ResultCode.Description}`,
            );
            return;
        }

        this.context.logicHandler.validateBeginRequest(this.context.request);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

        // MOCK: abandon rather than refuse, for the same reason as beginGame.
        if (await this.context.storageHandler.getDemoGameFromCache()) {
            await this.context.storageHandler.deleteDemoGameFromCache();
            this.logger.logWarning(
                `Abandoned an unfinished demo game for UserId: ${request.OperatorUserId} so a new one could start. The real engine would refuse this buy-in until the game is resumed.`,
            );
        }

        // Process main game logic
        await this.processGameLogic();
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            this.logger.logError(
                `Failed to process game logic for UserId: ${request.OperatorUserId}, ResultCode: ${this.context.response.ResultCode.Description}`,
            );
            return;
        }

        // Cache incomplete game for bonus rounds, only when successful
        if (this.context.response.GameMessage?.GameComplete === false) await this.context.storageHandler.cacheIncompleteDemoGame();

        // Populate response game settings
        this.context.populateResponseGameSettings();

        // Set default nickname
        this.context.response.PlayerData.Username = 'Demo Player';

        // Update balance and cache against token
        await this.context.storageHandler.cacheDemoBalance();
    }

    async continueDemoGame(): Promise<void> {
        const request = this.context.request;

        if (this.config.cacheEnabled === false) throw new Error('Demo games require caching to be enabled.');

        const operatorFlowSettings = this.getOperatorFlowSettings();
        this.context.internalData.GesData.CurrencyCode = operatorFlowSettings.CurrencyCode;

        if (this.context.response.Tokens == null) this.context.response.Tokens = { GamingSessionToken: request.GamingSessionToken };

        // There must be a demo account
        if (!(await this.context.storageHandler.checkIfDemoSessionExists())) {
            this.context.response.ResultCode = ArcadeResultCode.DemoGameNotFound;
            return;
        }

        // There must be an existing game in play
        if (!(await this.context.storageHandler.getDemoGameFromCache())) {
            this.context.response.ResultCode = ArcadeResultCode.DemoGameNotFound;
            return;
        }

        // Validate that the game can be continued
        this.context.logicHandler.validateContinue(this.context.response.GameMessage as GameMessage);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            this.logger.logError(
                `Game validation failed for continueDemoGame - UserId: ${request.OperatorUserId}, ResultCode: ${this.context.response.ResultCode.Description}, SessionToken: ${request.GamingSessionToken}`,
            );
            return;
        }

        // Check the bonus request provided is valid
        this.context.logicHandler.validateBonusRoundRequest(this.context.request);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            this.logger.logError(
                `Bonus round validation failed - UserId: ${request.OperatorUserId}, ResultCode: ${this.context.response.ResultCode.Description}, SessionToken: ${request.GamingSessionToken}`,
            );
            return;
        }

        // Execute the bonus round logic
        const gameMessage = this.context.logicHandler.continueGame();
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

        // Set additional game message properties
        gameMessage.Stake = this.context.ticketDetails.Stake;
        gameMessage.Skin = this.context.request.Skin;
        this.context.response.GameMessage = gameMessage;
        this.context.response.GameMessage.GameId = this.context.internalData.GesData.GameId;

        // Cache incomplete game, or delete if we're finished
        if (!this.context.response.GameMessage.GameComplete) await this.context.storageHandler.cacheIncompleteDemoGame();
        else await this.context.storageHandler.deleteDemoGameFromCache();

        this.context.populateResponseGameSettings();

        // Set default nickname
        this.context.response.PlayerData.Username = 'Demo Player';

        // Update balance and cache against token
        await this.context.storageHandler.cacheDemoBalance();
    }

    async resumeDemoGame(): Promise<void> {
        if (this.config.cacheEnabled === false) throw new Error('Demo games require caching to be enabled.');

        const operatorFlowSettings = this.getOperatorFlowSettings();
        this.context.internalData.GesData.CurrencyCode = operatorFlowSettings.CurrencyCode;
        this.context.validateAndSetStakeOptions(operatorFlowSettings.StakeOptions);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) return;

        // Generate token
        if (this.context.response.Tokens == null) this.context.response.Tokens = { GamingSessionToken: newGuid() };

        // Initialise balance (which acts as the demo account)
        await this.context.storageHandler.cacheDemoBalance();

        // Read the demo version from cache
        const demoVersion = await this.getDemoVersion();
        if (demoVersion === undefined || demoVersion.length === 0) {
            this.context.response.ResultCode = ArcadeResultCode.VersionInvalid;
            return;
        }

        this.initializeSettings(demoVersion);

        // Set as new player
        this.context.response.PlayerData.NewPlayer = true;

        // Set default nickname
        this.context.response.PlayerData.Username = 'Demo Player';

        // Finally populate the response with settings and return
        this.context.populateResponseGameSettings();
    }

    private async getDemoVersion(): Promise<string | undefined> {
        const territoryCode = String(this.territory);
        const operatorId = this.context.request.OperatorId;
        const mechanic = this.context.internalData.GameNames.EnabledGameName;
        const skin = String(this.context.request.Skin);

        const demoVersion = await this.context.storageHandler.getDemoVersionAsync(territoryCode, operatorId, mechanic, skin);
        if (demoVersion === undefined || demoVersion.length === 0) {
            this.logger.logError(
                `No demo version found in cache for Territory: ${territoryCode}, Operator: ${operatorId}, Mechanic: ${mechanic}, Skin: ${skin}`,
            );
        }
        return demoVersion;
    }

    async forceCloseIncompleteGame(): Promise<void> {
        // No auth required for force close; protected by API key

        const gameId = parseGameId(this.context.request.GameId);
        if (gameId === undefined) {
            this.context.response.ResultCode = ArcadeResultCode.GameNotFound;
            return;
        }

        // MOCK: the C# rejects jackpot skins here; there is no JackpotHandler to reject.

        const requestedSkin = this.context.request.Skin;
        this.context.internalData.GesData.GameId = gameId;
        if (this.context.response.GameMessage != null) this.context.response.GameMessage.GameId = gameId;

        const gameFound = await this.context.storageHandler.getGameByIdFromDatabase();
        if (!gameFound) {
            this.context.response.ResultCode = ArcadeResultCode.GameNotFound;
            this.logger.logWarning(`Game not found for force close - GameId: ${gameId}, OperatorId: ${this.context.request.OperatorId}`);
            return;
        }

        if (this.context.response.GameMessage?.GameComplete !== false) {
            this.context.response.ResultCode = ArcadeResultCode.GameAlreadyComplete;
            this.logger.logWarning(`Game is already complete and cannot be force closed - GameId: ${gameId}`);
            return;
        }

        if (this.context.request.Skin !== requestedSkin) {
            this.context.response.ResultCode = ArcadeResultCode.CouldNotProcessIncomplete;
            this.logger.logError(
                `Stored skin ${this.context.request.Skin} did not match requested skin ${requestedSkin} for force close - GameId: ${gameId}`,
            );
            return;
        }

        const playMode = this.context.internalData.ReviewData?.PlayMode ?? PlayMode.Unknown;
        const storedGamingSessionToken = this.context.internalData.GesData.GamingSessionTokenFromStorage;
        const storedGsUserId = this.context.internalData.GesData.GSUserId;

        this.context.request = {
            ...this.context.request,
            GamingSessionToken: storedGamingSessionToken,
            Language: this.config.forceCloseDefaultLanguage ?? this.context.request.Language,
            PlayMode: playMode,
            Stake: this.context.response.GameMessage.Stake,
        };

        const userFound = await this.context.storageHandler.getUserFromDatabase();
        if (!userFound) {
            this.logger.logError(`User not found while preparing force close - GSUserId: ${storedGsUserId}, GameId: ${gameId}`);
            return;
        }

        await this.gameSessionHandler.exchangeAndAssignToContext(storedGamingSessionToken);
        const invalidStoredSession = this.context.internalData.GesData.CurrentSessionIsInvalid;
        if (this.context.response.ResultCode !== ArcadeResultCode.Success && !invalidStoredSession) {
            this.logger.logError(
                `Session exchange failed while preparing force close - GSUserId: ${storedGsUserId}, GameId: ${gameId}, ResultCode: ${this.context.response.ResultCode.Description}`,
            );
            return;
        }

        if (this.context.internalData.GesData.GSUserId !== storedGsUserId) {
            this.context.response.ResultCode = ArcadeResultCode.CouldNotProcessIncomplete;
            this.logger.logError(
                `Session user did not match stored game user while preparing force close - StoredGSUserId: ${storedGsUserId}, ExchangedGSUserId: ${this.context.internalData.GesData.GSUserId}, GameId: ${gameId}`,
            );
            return;
        }

        const awardContextError = this.getForceCloseAwardContextError();
        if (awardContextError !== undefined) {
            this.context.response.ResultCode = ArcadeResultCode.CouldNotProcessIncomplete;
            this.logger.logError(`Cannot award force-closed game - GameId: ${gameId}, Reason: ${awardContextError}`);
            return;
        }

        if (invalidStoredSession) this.context.response.ResultCode = ArcadeResultCode.Success;

        // Force complete the game
        const successfullyClosed = await this.context.storageHandler.forceCloseIncompleteGame();
        if (!successfullyClosed) {
            this.context.response.ResultCode = ArcadeResultCode.CouldNotProcessIncomplete;
            this.logger.logError(
                `Failed to force close incomplete game for UserId: ${this.context.request.OperatorUserId}, GameId: ${this.context.request.GameId}`,
            );
            return;
        }

        this.context.response.GameMessage.GameComplete = true;

        // Invalidate cache so any future requests for this game id are blocked
        await this.context.storageHandler.invalidateGameCache();

        // Award winnings with GEP
        await this.awardPrizeHandler.awardPrize(this.context.internalData.GesData.NetworkSessionToken);
        if (this.context.response.ResultCode !== ArcadeResultCode.Success) {
            this.logger.logError(
                `Failed to award prize for UserId: ${this.context.request.OperatorUserId}, ResultCode: ${this.context.response.ResultCode.Description}`,
            );
            return;
        }

        await this.runAfterAwardPrize();
    }

    private getForceCloseAwardContextError(): string | undefined {
        const errors: string[] = [];
        const request = this.context.request;
        const gesData = this.context.internalData.GesData;

        if (request.PlayMode !== PlayMode.Wallet && request.PlayMode !== PlayMode.FunBonus && request.PlayMode !== PlayMode.FreePlay)
            errors.push(`unsupported play mode ${request.PlayMode}`);
        if (isBlank(request.OperatorId)) errors.push('operator ID is missing');
        if (isBlank(request.OperatorUserId)) errors.push('operator user ID is missing');
        if (isBlank(gesData.Nickname)) errors.push('nickname is missing');
        if (isBlank(gesData.NetworkSessionToken)) errors.push('network session token is missing');
        if (isBlank(gesData.GepGameName) || isBlank(gesData.GepGameType) || isBlank(gesData.GepSubType))
            errors.push('GEP game identity is incomplete');
        if (isBlank(gesData.GameId)) errors.push('game ID is missing');
        if (isBlank(gesData.TransactionIdWin)) errors.push('win transaction ID is missing');
        if (gesData.GSUserId <= 0) errors.push('GS user ID is missing');
        if ((this.context.response.GameMessage?.Payout ?? 0) < 0) errors.push('payout is negative');

        if (this.territory === Territory.UK) {
            if (isBlank(gesData.AuthToken)) errors.push('auth token is missing');
            if (!/^[A-Za-z]{3}$/.test(gesData.CurrencyCode)) errors.push('currency code is invalid');
        }

        if (this.territory === Territory.IT && isBlank(request.Language)) errors.push('language is missing');

        return errors.length === 0 ? undefined : errors.join('; ');
    }

    async reviewGame(): Promise<void> {
        // No auth required for review; protected by API key

        const gameId = parseGameId(this.context.request.GameId);
        if (gameId === undefined) {
            this.context.response.ResultCode = ArcadeResultCode.GameNotFound;
            return;
        }

        // Set in both for usage when needed
        this.context.internalData.GesData.GameId = gameId;
        if (this.context.response.GameMessage != null) this.context.response.GameMessage.GameId = gameId;

        const gameFound = await this.context.storageHandler.getGameByIdFromDatabase();
        if (!gameFound) {
            this.context.response.ResultCode = ArcadeResultCode.GameNotFound;
            this.logger.logWarning(
                `Game not found for reviewGame - UserId: ${this.context.request.OperatorUserId}, GameId: ${this.context.request.GameId}`,
            );
            return;
        }

        const userFound = await this.context.storageHandler.getUserFromDatabase();
        if (userFound && !isBlank(this.context.internalData.GesData.Nickname))
            this.context.response.PlayerData.Username = this.context.internalData.GesData.Nickname;

        if (this.context.response.GameMessage != null) {
            this.context.response.GameMessage.Payout = 0;
            this.context.response.GameMessage.WinThisSpin = 0;
        }
        this.context.response.GameMessage = this.context.logicHandler.playGame();
        this.context.response.GameMessage.GameId = this.context.internalData.GesData.GameId;
        this.context.storageHandler.setTicketFetcherDetails();
        this.context.populateResponseGameSettings();
    }

    async playSimGame(version: string): Promise<[number, number]> {
        if (this.context.debugHandler == null) return [-1, -1];

        const result = await this.context.debugHandler.playSimulationGameAsync(this.context, version, requestVersion =>
            this.tryInitializeSettings(requestVersion),
        );
        return result.Success ? [result.MainPayout, result.BonusPayout] : [-1, -1];
    }

    private tryInitializeSettings(requestVersion: string): boolean {
        this.initializeSettings(requestVersion);
        return this.context.response.ResultCode === ArcadeResultCode.Success;
    }
}

/** MOCK: Guid.TryParse becomes a non-empty check — mock game ids are opaque strings. */
function parseGameId(gameId: string | undefined): string | undefined {
    const trimmed = (gameId ?? '').trim();
    return trimmed.length === 0 ? undefined : trimmed;
}

function isBlank(value: string | undefined): boolean {
    return value === undefined || value.trim().length === 0;
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The mock logger takes a message only, so an exception has to be folded into one. */
function describeError(error: unknown): string {
    if (error instanceof Error) return `Exception: ${error.message}`;
    return `Exception: ${String(error)}`;
}
