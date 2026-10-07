// Ported from Libraries/Tombola.B2B.Arcade/ArcadeGame.cs

import { ArcadeResultCode } from './ArcadeResultCode';
import {
    IArcadeSettings,
    IGameContext,
    IGameDebugHandler,
    IGameFlowHandler,
    IGameLogicHandler,
    IGameStorageHandler,
    IGameTicketHelper,
    ILoggingService,
} from './interfaces';
import { RequestType, SkinName, Territory } from './models/enums';
import { BaseArcadeRequest } from './models/BaseArcadeRequest';
import { BaseArcadeResponse, GameSettings } from './models/BaseArcadeResponse';
import { GameInternalData, GesData } from './models/GameInternalData';
import { GameTicketDetails } from './models/GameTicketDetails';

export type ArcadeGameFactory = (request: BaseArcadeRequest, requestType: RequestType) => ArcadeGame;

export abstract class ArcadeGame implements IGameContext {
    flowHandler!: IGameFlowHandler;
    logicHandler!: IGameLogicHandler;
    debugHandler?: IGameDebugHandler;
    storageHandler!: IGameStorageHandler;
    ticketHelper!: IGameTicketHelper;

    loggingService!: ILoggingService;

    // MOCK: ArcadeConfig is not ported; games read what they need off internalData.

    // Initialise other fields
    static rngEndPoints: string[] = [];
    static availableGames: string[] = [];
    static rngListGames: string[] = [];
    stakeOptions: number[] = [];
    minStakeDivisor = 5; // Nearly all games will use 5p as the min stake divisor
    ticketDetails: GameTicketDetails = new GameTicketDetails();
    abstract get acceptedSkins(): readonly SkinName[];
    shouldCacheTickets = false;

    requestType: RequestType;
    request: BaseArcadeRequest;
    response: BaseArcadeResponse;
    settings?: IArcadeSettings;
    internalData: GameInternalData;

    constructor(request: BaseArcadeRequest, response: BaseArcadeResponse, requestType: RequestType, internalData: GameInternalData) {
        this.request = request;
        this.response = response;
        this.requestType = requestType;
        this.internalData = internalData;
    }

    // responsible for creating all the specific game instances
    private static readonly gameFactories = new Map<SkinName, ArcadeGameFactory>();

    static registerGameFactory(skin: SkinName, factory: ArcadeGameFactory): void {
        ArcadeGame.gameFactories.set(skin, factory);
    }

    setSettings(version: string): void {
        throw new Error(`SetSettings is not implemented for version ${version}`);
    }

    // MOCK: ITerritoryProvider, ArcadeConfig, the caller IP and the two handler factories have no mock
    // equivalent, so the territory arrives directly and handlers are wired by the game itself.
    static createGame(
        loggingService: ILoggingService,
        request: BaseArcadeRequest,
        territory: Territory,
        requestType: RequestType,
    ): ArcadeGame {
        const factory = ArcadeGame.gameFactories.get(request.Skin);
        if (factory === undefined) throw new Error(`Game not found: ${request.Skin}`);

        // Create game without settings - they will be initialized later
        const game = factory(request, requestType);

        game.loggingService = loggingService;

        // set GES data
        const gesData = new GesData();
        gesData.GepGameType = game.internalData.GameNames.EnabledGameName;
        gesData.GepGameName = `${territory}_${game.internalData.GameNames.EnabledGameName}`;
        gesData.GepSubType = request.Skin;
        game.internalData.GesData = gesData;

        return game;
    }

    populateResponseGameSettings(): void {
        if (this.response.GameSettings == null)
            // could be created in overriden method
            this.response.GameSettings = new GameSettings();

        this.response.PlayerData.CurrencyCode = this.internalData.GesData.CurrencyCode;
        this.populateStakeOptionsSettings();
        this.response.GameSettings.WinMultipliers = this.settings!.WinMultipliers;
        this.response.GameSettings.Version = this.settings!.ActiveVersion;

        this.response.GameSettings.Rtp = this.settings!.Rtp;
    }

    populateStakeOptionsSettings(): void {
        if (this.stakeOptions.length === 0) {
            this.response.GameSettings.StakeOptions = [];
            this.response.GameSettings.DefaultStake = 0;
            return;
        }

        this.response.GameSettings.StakeOptions = this.stakeOptions;
        this.response.GameSettings.DefaultStake = Math.min(...this.stakeOptions);
    }

    /**
     * Applies game rules and authenticated session limits to the available stake options.
     */
    validateAndSetStakeOptions(configuredStakeOptions: number[]): void {
        const minStakeAmount = this.internalData.GesData.MinStakeAmount;
        const maxStakeAmount = this.internalData.GesData.MaxStakeAmount;

        const isValidStakeOption = (stake: number): boolean => {
            if (stake % this.minStakeDivisor !== 0) {
                this.loggingService?.logWarning(
                    `Stake option value: ${stake} for skin: ${this.request.Skin} is invalid, removing from available stake options`,
                );
                return false;
            }

            if ((minStakeAmount !== undefined && stake < minStakeAmount) || (maxStakeAmount !== undefined && stake > maxStakeAmount)) {
                this.loggingService?.logWarning(
                    `Stake option value: ${stake} falls outside session limits ` +
                        `[${minStakeAmount ?? 'unbounded'}, ${maxStakeAmount ?? 'unbounded'}] and was removed`,
                );
                return false;
            }

            return true;
        };

        this.stakeOptions = this.getGameStakeOptions(configuredStakeOptions).filter(isValidStakeOption);

        if (this.stakeOptions.length === 0) this.loggingService?.logError('No stake options available for Request');

        this.response.ResultCode = this.stakeOptions.length === 0 ? ArcadeResultCode.NoStakeOptions : ArcadeResultCode.Success;
    }

    /**
     * Allows a game to replace operator-configured options before shared validation.
     */
    protected getGameStakeOptions(configuredStakeOptions: number[]): number[] {
        return configuredStakeOptions;
    }

    validateRequestedStake(): boolean {
        const requestedStake = this.request.Stake;
        if (this.stakeOptions.includes(requestedStake)) return true;

        this.loggingService?.logWarning(
            `Requested stake ${requestedStake} is not supported for skin ${this.request.Skin}. Supported stakes: [${this.stakeOptions.join(', ')}]`,
        );
        this.response.ResultCode = ArcadeResultCode.InvalidStake;
        return false;
    }
}
