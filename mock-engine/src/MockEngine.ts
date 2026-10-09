// MOCK: the façade has no single C# counterpart — it collapses ArcadeB2BApi's
// Endpoints/ArcadeB2BEndpoints.{cs,Standard.cs} (TryInitialiseGameAction, request→response
// binding, the endpoint try/catch) and Handlers/{Begin,Continue,Resume}Handler.cs into one
// object that both the editor (Node) and the game (browser) can call directly.
//
// It NEVER throws: the editor and the game both depend on always getting a parseable
// envelope, so every escaping error becomes ArcadeResultCode.UnexpectedError, mirroring the
// endpoints' `initialisedGame?.Response.ResultCode ?? UnexpectedError` fallback.

import { ArcadeGame } from './core/ArcadeGame';
import { ArcadeResultCode } from './core/ArcadeResultCode';
import {
    IArcadeSettings,
    IGameContext,
    IGameDebugHandler,
    IGameFlowHandler,
    IGameLogicHandler,
    IGameStorageHandler,
    IGameTicketHelper,
    ILoggingService,
    IRandomNumberGenerator,
} from './core/interfaces';
import { BaseArcadeRequest } from './core/models/BaseArcadeRequest';
import { BaseArcadeResponse, GameSettings, RngStatus } from './core/models/BaseArcadeResponse';
import { GameInternalData } from './core/models/GameInternalData';
import { GameTicketDetails } from './core/models/GameTicketDetails';
import { PlayMode, RequestType, SkinName, Territory } from './core/models/enums';
import {
    DEFAULT_OPERATOR_FLOW_SETTINGS,
    DefaultGameFlowHandler,
    NoOpResumeGameTerritoryPolicy,
    StaticOperatorSettingsProvider,
} from './flow/DefaultGameFlowHandler';
import {
    GameFlowHandlerConfig,
    GameFlowHandlerDependencies,
    IOperatorSettingsProvider,
    JackpotPotValuesResult,
    OperatorFlowSettings,
} from './flow/GameFlowHandlerBase';
import { GameRegistration, GameTypeRegistry } from './registry/GameTypeRegistry';
import { MockJackpotConfig, MockJackpotService, MockJackpotSnapshot } from './jackpot/MockJackpotService';
import { RandomHelpers } from './rng/RandomHelpers';
import { DEFAULT_RNG_SEED, SeededRandomNumberGenerator } from './rng/SeededRandomNumberGenerator';
import { createDefaultSessionConfig, MockGameSessionHandler, MockSessionConfig } from './session/MockGameSessionHandler';
import { InMemoryGameStorageHandler, InMemoryStorageConfig, StoredGame, TransactionLogEntry } from './storage/InMemoryGameStorageHandler';
import { LedgerEntry, MockWallet } from './wallet/MockWallet';
import { MockAwardPrizeHandler } from './wallet/MockAwardPrizeHandler';
import { MockCancelBetHandler } from './wallet/MockCancelBetHandler';
import { MockPlaceBetHandler } from './wallet/MockPlaceBetHandler';
import { newGameId } from './core/models/GameInternalData';

/** A request body plus the `{game}` URL segment the real API binds separately. */
export type MockArcadeRequest = Partial<BaseArcadeRequest> & { game?: string };

export type MockStorageFactory = (context: IGameContext) => IGameStorageHandler;
export type MockFlowHandlerFactory = (dependencies: GameFlowHandlerDependencies) => IGameFlowHandler;

export interface MockEngineOptions {
    /** Defaults to a SeededRandomNumberGenerator over `seed`. */
    rng?: IRandomNumberGenerator;
    wallet?: MockWallet;
    session?: Partial<MockSessionConfig>;
    storage?: InMemoryStorageConfig | MockStorageFactory;
    seed?: number;
    currencyCode?: string;
    /** Integer minor units. Ignored when an explicit `wallet` is supplied. */
    startingBalance?: number;
    territory?: Territory;
    /** Off unless `enabled` is true; while off no response carries a Jackpot member. */
    jackpot?: MockJackpotConfig;
    operatorSettings?: OperatorFlowSettings | IOperatorSettingsProvider;
    /**
     * Defaults to `{ debugEnabled: true }`: a prototyping engine honours the debug data a
     * request carries (forced stops, a forced bonus), as the real engine does in development.
     */
    flowConfig?: GameFlowHandlerConfig;
    flowHandler?: MockFlowHandlerFactory;
    logger?: ILoggingService;
}

export interface MockEngineSnapshot {
    wallet: {
        balance: number;
        bonusBalance: number;
        freePlayBalance: number;
        freePlayValue: number;
        currencyCode: string;
        ledger: LedgerEntry[];
    };
    storage: {
        games: StoredGame[];
        transactionLog: TransactionLogEntry[];
        demoVersions: Array<[string, string]>;
    };
    /** Present only while jackpots are enabled; pots accumulate across requests. */
    jackpot?: MockJackpotSnapshot;
    seed?: number;
}

/** The envelope every endpoint starts from; mirrors the C# BaseArcadeResponse member defaults. */
export function createDefaultArcadeResponse(requestType: RequestType): BaseArcadeResponse {
    return {
        RequestType: requestType,
        ResultCode: ArcadeResultCode.Success,
        ServiceDetails: { ServiceB: '', ServiceA: '' },
        PlayerData: {
            Username: 'placeholder',
            CurrencyCode: '',
            NewPlayer: false,
            RewardWallets: [],
        },
        PlayState: {
            BalanceUpdateDelayed: false,
            BetCancelled: false,
            ShouldRefreshBeforeNextBuyIn: false,
            NeedsNicknameToBeSet: false,
            ShouldCloseGame: false,
        },
        RngStatus: RngStatus.Success,
        TimeKeeperLimit: { Value: 0 },
        PromoDetails: [],
        GameSettings: new GameSettings(),
        MiscInfo: '',
    };
}

export class MockEngine {
    readonly wallet: MockWallet;
    readonly rng: IRandomNumberGenerator;
    readonly storageHandler: IGameStorageHandler;
    readonly territory: Territory;
    readonly sessionConfig: MockSessionConfig;
    readonly jackpotService: MockJackpotService;
    readonly logger: ILoggingService;

    private readonly operatorSettingsProvider: IOperatorSettingsProvider;
    private readonly flowConfig: GameFlowHandlerConfig;
    private readonly createFlowHandler: MockFlowHandlerFactory;
    private currentGame: ArcadeGame | undefined;

    constructor(options: MockEngineOptions = {}) {
        this.logger = options.logger ?? createConsoleLoggingService();
        this.territory = options.territory ?? Territory.UK;
        this.rng = options.rng ?? new SeededRandomNumberGenerator(options.seed ?? DEFAULT_RNG_SEED);

        // MOCK: RandomHelpers is a process-wide singleton in the C# too, so the most recently
        // constructed engine owns it. Reset first because Initialise refuses to run twice.
        RandomHelpers.Reset();
        RandomHelpers.Initialise(this.rng);

        const currencyCode = options.currencyCode ?? 'GBP';
        this.wallet = options.wallet ?? new MockWallet({ balance: options.startingBalance, currencyCode });
        this.sessionConfig = createDefaultSessionConfig({ currencyCode, ...options.session });
        this.jackpotService = new MockJackpotService(this.rng, options.jackpot ?? {});

        this.operatorSettingsProvider = resolveOperatorSettingsProvider(options.operatorSettings);
        this.flowConfig = options.flowConfig ?? { debugEnabled: true };
        this.createFlowHandler = options.flowHandler ?? (dependencies => new DefaultGameFlowHandler(dependencies));

        // The store outlives any one request, so it is bound to a context that forwards to
        // whichever game is currently in flight.
        const context = new CurrentGameContext(() => this.currentGame);
        this.storageHandler =
            typeof options.storage === 'function' ? options.storage(context) : new InMemoryGameStorageHandler(context, options.storage);
    }

    begin(request: MockArcadeRequest): Promise<BaseArcadeResponse> {
        return this.execute(RequestType.Begin, request);
    }

    continue(request: MockArcadeRequest): Promise<BaseArcadeResponse> {
        return this.execute(RequestType.Continue, request);
    }

    resume(request: MockArcadeRequest): Promise<BaseArcadeResponse> {
        return this.execute(RequestType.Resume, request);
    }

    potvalues(request: MockArcadeRequest): Promise<BaseArcadeResponse> {
        return this.execute(RequestType.PotValues, request);
    }

    /** Restarts the RNG stream so a prototype run replays identically. */
    reseed(seed: number): void {
        const reseedable = this.rng as { reseed?: (value: number) => void };
        if (typeof reseedable.reseed !== 'function') throw new Error('The configured random number generator cannot be reseeded');
        reseedable.reseed(seed);
    }

    /** Captures wallet + storage so a run can be rewound and replayed. */
    snapshot(): MockEngineSnapshot {
        const storage = this.storageHandler instanceof InMemoryGameStorageHandler ? this.storageHandler : undefined;
        if (storage === undefined) this.logger.logWarning('Storage handler is not in-memory; only the wallet was captured');

        return clone({
            wallet: {
                balance: this.wallet.balance,
                bonusBalance: this.wallet.bonusBalance,
                freePlayBalance: this.wallet.freePlayBalance,
                freePlayValue: this.wallet.freePlayValue,
                currencyCode: this.wallet.currencyCode,
                ledger: this.wallet.ledger,
            },
            storage: {
                games: storage === undefined ? [] : [...storage.games.values()],
                transactionLog: storage === undefined ? [] : storage.transactionLog,
                demoVersions: storage === undefined ? [] : [...storage.demoVersions.entries()],
            },
            ...(this.jackpotService.enabled ? { jackpot: this.jackpotService.snapshot() } : {}),
            seed: (this.rng as { seed?: number }).seed,
        });
    }

    // MOCK: the in-flight ticket caches are private to InMemoryGameStorageHandler and are NOT
    // captured, so a snapshot taken mid-bonus-round restores the stored game but not its cache entry.
    restore(snapshot: MockEngineSnapshot): void {
        const restored = clone(snapshot);

        this.wallet.balance = restored.wallet.balance;
        this.wallet.bonusBalance = restored.wallet.bonusBalance;
        this.wallet.freePlayBalance = restored.wallet.freePlayBalance;
        this.wallet.freePlayValue = restored.wallet.freePlayValue;
        this.wallet.currencyCode = restored.wallet.currencyCode;
        this.wallet.ledger.length = 0;
        this.wallet.ledger.push(...restored.wallet.ledger);

        if (this.storageHandler instanceof InMemoryGameStorageHandler) {
            this.storageHandler.games.clear();
            for (const game of restored.storage.games) this.storageHandler.games.set(game.gameId, game);

            this.storageHandler.transactionLog.length = 0;
            this.storageHandler.transactionLog.push(...restored.storage.transactionLog);

            this.storageHandler.demoVersions.clear();
            for (const [key, version] of restored.storage.demoVersions) this.storageHandler.demoVersions.set(key, version);
        }

        if (restored.jackpot !== undefined) this.jackpotService.restore(restored.jackpot);

        if (restored.seed !== undefined) this.reseed(restored.seed);
    }

    private async execute(requestType: RequestType, raw: MockArcadeRequest): Promise<BaseArcadeResponse> {
        let response = createDefaultArcadeResponse(requestType);
        let game: ArcadeGame | undefined;

        try {
            const requestedGame = (raw.game ?? raw.Skin ?? '').trim();
            const registration = GameTypeRegistry.tryGet(requestedGame);
            if (registration === undefined) {
                this.logger.logError(`Attempted access to invalid game: ${requestedGame.length === 0 ? '<missing>' : requestedGame}`);
                response.ResultCode = ArcadeResultCode.GameUnavailable;
                return response;
            }

            const request = this.buildRequest(registration, raw, requestType);
            game = ArcadeGame.createGame(this.logger, request, this.territory, requestType);
            this.currentGame = game;
            this.attachHandlers(game);

            response = game.response;
            response.RequestType = requestType;

            await this.dispatch(game, requestType, request.PlayMode);
            return game.response;
        } catch (error) {
            this.logger.logError(`Unhandled exception while processing ${requestType} request. ${describeError(error)}`);

            const current = game?.response ?? response;
            if (current.ResultCode === ArcadeResultCode.Success) current.ResultCode = ArcadeResultCode.UnexpectedError;
            return current;
        }
    }

    /** Mirrors BeginHandler/ContinueHandler/ResumeHandler's play-mode switch. */
    private async dispatch(game: ArcadeGame, requestType: RequestType, playMode: PlayMode): Promise<void> {
        const isDemo = playMode === PlayMode.UnauthDemo;

        switch (requestType) {
            case RequestType.Begin:
                await (isDemo ? game.flowHandler.beginDemoGame() : game.flowHandler.beginGame());
                return;
            case RequestType.Continue:
                await (isDemo ? game.flowHandler.continueDemoGame() : game.flowHandler.continueGame());
                return;
            case RequestType.Resume:
                await (isDemo ? game.flowHandler.resumeDemoGame() : game.flowHandler.resumeGame());
                return;
            case RequestType.PotValues:
                applyJackpotPotValues(game.response, (await game.flowHandler.getJackpotPotValues()) as JackpotPotValuesResult);
                return;
            default:
                throw new Error(`Unsupported request type: ${requestType}`);
        }
    }

    /** The mock's IGameFlowHandlerFactory + IGameStorageHandlerFactory, inlined. */
    private attachHandlers(game: ArcadeGame): void {
        game.storageHandler = this.storageHandler;
        game.flowHandler = this.createFlowHandler({
            context: game,
            logger: this.logger,
            territory: this.territory,
            operatorSettingsProvider: this.operatorSettingsProvider,
            // MOCK: GEP mints a fresh game id per buy-in, so only that field varies per request.
            gameSessionHandler: new MockGameSessionHandler(game, this.wallet, { ...this.sessionConfig, gameId: newGameId() }),
            placeBetHandler: new MockPlaceBetHandler(game, this.wallet),
            cancelBetHandler: new MockCancelBetHandler(game, this.wallet),
            awardPrizeHandler: new MockAwardPrizeHandler(game, this.wallet),
            resumeGameTerritoryPolicy: new NoOpResumeGameTerritoryPolicy(),
            jackpotService: this.jackpotService,
            config: this.flowConfig,
        });
    }

    /**
     * Fills a partial body out to a full BaseArcadeRequest, mirroring the C# request records'
     * MapXRequestToBase plus TryValidateUrlGameString parsing `{game}` into the skin.
     *
     * MOCK: arcade-base's `continueRequest(payload)` merges the payload into the TOP LEVEL of the
     * body (`{ ..., BonusSpin: 3 }`), where the C# request binder reads a `BonusRoundData` member.
     * A continue body carrying no `BonusRoundData` is therefore handed to the mechanic's own
     * continue parser WHOLE, but only for a mechanic that declares one — the passthrough default
     * would otherwise turn every field of the body into bonus data.
     */
    private buildRequest(registration: GameRegistration, raw: MockArcadeRequest, requestType?: RequestType): BaseArcadeRequest {
        const operatorId = raw.OperatorId ?? 'MOCK';
        const stakeOptions = this.operatorSettingsProvider.getSettings(operatorId).StakeOptions;
        const bonusRoundSource =
            raw.BonusRoundData === undefined && requestType === RequestType.Continue && registration.bonusRoundData !== undefined
                ? raw
                : raw.BonusRoundData;

        return {
            OperatorUserId: raw.OperatorUserId ?? '123',
            Stake: raw.Stake ?? (stakeOptions.length > 0 ? Math.min(...stakeOptions) : 0),
            ClientTypeId: raw.ClientTypeId ?? 0,
            OperatorId: operatorId,
            Language: raw.Language ?? 'en-GB',
            SiteId: raw.SiteId ?? 0,
            // Clients send the id back as a number, the way their models store it.
            GameId: raw.GameId === undefined || raw.GameId === null ? '' : String(raw.GameId),
            ApiKey: raw.ApiKey ?? '',
            ApiVersion: raw.ApiVersion ?? '',
            Skin: (raw.Skin ?? registration.game) as SkinName,
            PlayMode: raw.PlayMode ?? PlayMode.Wallet,
            FreeplaysUsed: raw.FreeplaysUsed ?? 0,
            JackpotConfigVersion: raw.JackpotConfigVersion,
            BingoParentGame: raw.BingoParentGame ?? '',
            Parent: raw.Parent,
            BeginGameData: (registration.beginGameData ?? passthrough)(raw.BeginGameData),
            ContextPassthrough: raw.ContextPassthrough,
            DebugGameData: GameTypeRegistry.getDebugDataType(registration.game)(raw.DebugGameData ?? topLevelDebugData(raw)),
            BonusRoundData: (registration.bonusRoundData ?? passthrough)(bonusRoundSource),
            AuthToken: raw.AuthToken ?? this.sessionConfig.authToken,
            GamingSessionToken: raw.GamingSessionToken ?? this.sessionConfig.gamingSessionToken,
        };
    }
}

/**
 * Forwards IGameContext to whichever game is in flight, so one storage handler (and therefore
 * one set of games, caches and transaction logs) survives across requests.
 */
class CurrentGameContext implements IGameContext {
    constructor(private readonly resolveGame: () => ArcadeGame | undefined) {}

    private get game(): ArcadeGame {
        const game = this.resolveGame();
        if (game === undefined) throw new Error('No game is currently in flight');
        return game;
    }

    get requestType(): RequestType {
        return this.game.requestType;
    }
    set requestType(value: RequestType) {
        this.game.requestType = value;
    }

    get request(): BaseArcadeRequest {
        return this.game.request;
    }
    set request(value: BaseArcadeRequest) {
        this.game.request = value;
    }

    get response(): BaseArcadeResponse {
        return this.game.response;
    }
    set response(value: BaseArcadeResponse) {
        this.game.response = value;
    }

    get internalData(): GameInternalData {
        return this.game.internalData;
    }
    set internalData(value: GameInternalData) {
        this.game.internalData = value;
    }

    get ticketDetails(): GameTicketDetails {
        return this.game.ticketDetails;
    }
    set ticketDetails(value: GameTicketDetails) {
        this.game.ticketDetails = value;
    }

    get stakeOptions(): number[] {
        return this.game.stakeOptions;
    }
    set stakeOptions(value: number[]) {
        this.game.stakeOptions = value;
    }

    get settings(): IArcadeSettings | undefined {
        return this.game.settings;
    }
    get acceptedSkins(): readonly SkinName[] {
        return this.game.acceptedSkins;
    }
    get shouldCacheTickets(): boolean {
        return this.game.shouldCacheTickets;
    }
    get loggingService(): ILoggingService {
        return this.game.loggingService;
    }
    get flowHandler(): IGameFlowHandler {
        return this.game.flowHandler;
    }
    get logicHandler(): IGameLogicHandler {
        return this.game.logicHandler;
    }
    get debugHandler(): IGameDebugHandler | undefined {
        return this.game.debugHandler;
    }
    get storageHandler(): IGameStorageHandler {
        return this.game.storageHandler;
    }
    get ticketHelper(): IGameTicketHelper {
        return this.game.ticketHelper;
    }

    setSettings(version: string): void {
        this.game.setSettings(version);
    }
    populateResponseGameSettings(): void {
        this.game.populateResponseGameSettings();
    }
    validateAndSetStakeOptions(stakeOptions: number[]): void {
        this.game.validateAndSetStakeOptions(stakeOptions);
    }
    validateRequestedStake(): boolean {
        return this.game.validateRequestedStake();
    }
}

// MOCK: the C# potvalues endpoint returns its own JackpotValuesResponse; the mock folds the
// same fields into the shared envelope so every entry point returns one shape.
function applyJackpotPotValues(response: BaseArcadeResponse, result: JackpotPotValuesResult): void {
    if (!result.Success) return;

    response.Jackpot = {
        ...(response.Jackpot ?? { CurrentPotValues: [] }),
        ConfigVersion: result.ConfigVersion,
        CurrentPotValues: result.CurrentPotValues,
    };
}

function resolveOperatorSettingsProvider(settings: MockEngineOptions['operatorSettings']): IOperatorSettingsProvider {
    if (settings === undefined) return new StaticOperatorSettingsProvider(DEFAULT_OPERATOR_FLOW_SETTINGS);
    if (typeof (settings as IOperatorSettingsProvider).getSettings === 'function') return settings as IOperatorSettingsProvider;
    return new StaticOperatorSettingsProvider(settings as OperatorFlowSettings);
}

const passthrough = (raw: unknown): unknown => raw;

/** Request flags arcade-base adds in debug builds; they are not game debug data. */
const CLIENT_DEBUG_FLAGS = new Set(['DebugGameData', 'DebugNotification', 'DebugVersion']);

/**
 * The arcade client merges its debug data into the TOP LEVEL of the request body
 * (arcade-base assigns `debugModel.debugServerData` onto it: `DebugStops`, `ForceBonus`, …),
 * where the C# binder's shape is a `DebugGameData` member. With no `DebugGameData`, the
 * `Debug…` / `Force…` fields of the body are the debug data.
 */
function topLevelDebugData(raw: MockArcadeRequest): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    let found = false;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!/^(Debug|Force)/.test(key) || CLIENT_DEBUG_FLAGS.has(key) || value === undefined) continue;
        out[key] = value;
        found = true;
    }
    return found ? out : undefined;
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function describeError(error: unknown): string {
    return error instanceof Error ? `Exception: ${error.message}` : `Exception: ${String(error)}`;
}

/** `console` is ambient rather than guaranteed, so it is feature-detected. */
function createConsoleLoggingService(): ILoggingService {
    const sink = typeof console === 'undefined' ? undefined : console;
    return {
        logWarning: message => sink?.warn?.(`[mock-engine] ${message}`),
        logError: message => sink?.error?.(`[mock-engine] ${message}`),
    };
}
