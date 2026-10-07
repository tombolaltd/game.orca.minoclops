// Ported from Libraries/Games/CashCollector3/{CashCollector3Game,CashCollector3DebugHandler}.cs.

import { ArcadeGame } from '../../core/ArcadeGame';
import { IGameContext, IGameDebugHandler, SimulationGameResult } from '../../core/interfaces';
import { BaseArcadeRequest } from '../../core/models/BaseArcadeRequest';
import { RNGGameResponse } from '../../core/models/GameInternalData';
import { GameType, RequestType, SkinName } from '../../core/models/enums';
import { createDefaultArcadeResponse } from '../../MockEngine';
import { GameSettingsFactory, GameSettingsRegistry } from '../../settings/GameSettingsBase';
import { CashCollectorContinueRequest, CashCollectorDebugRequest } from './CashCollectorContinueRequest';
import { CashCollectorGameMessage } from './CashCollectorGameMessage';
import { CashCollectorLogicHandler } from './CashCollectorLogicHandler';
import { CashCollectorResponseGameSettings, CashCollectorSettings, createDefaultCashCollectorSettings } from './CashCollectorSettings';
import { CashCollectorInternalData, CashCollectorTicketHelper } from './CashCollectorTicketHelper';

export const CASH_COLLECTOR_MECHANIC = 'CashCollector';

export class CashCollectorGame extends ArcadeGame {
    private static readonly settingsBySkin = new Map<SkinName, GameSettingsRegistry<CashCollectorSettings>>();

    constructor(request: BaseArcadeRequest, requestType: RequestType) {
        const internalData = new CashCollectorInternalData();
        internalData.GameNames = { GameType: GameType.Spin, FriendlyGameName: 'Cash Collector', EnabledGameName: CASH_COLLECTOR_MECHANIC };
        internalData.Timestamps = { StartStamp: new Date().toISOString() };

        super(request, createDefaultArcadeResponse(requestType), requestType, internalData);

        this.shouldCacheTickets = true;
        this.ticketHelper = new CashCollectorTicketHelper(this);
        this.logicHandler = new CashCollectorLogicHandler(this);
        this.debugHandler = new CashCollectorDebugHandler();
    }

    static createDefaultSettings(): CashCollectorSettings {
        return createDefaultCashCollectorSettings();
    }

    static registerSettings(skin: SkinName, settings: CashCollectorSettings | GameSettingsFactory<CashCollectorSettings>, version?: string): void {
        const factory: GameSettingsFactory<CashCollectorSettings> = typeof settings === 'function' ? settings : () => settings;
        const registry = CashCollectorGame.settingsBySkin.get(skin) ?? new GameSettingsRegistry<CashCollectorSettings>();

        registry.register(version ?? factory().ActiveVersion, factory);
        CashCollectorGame.settingsBySkin.set(skin, registry);
    }

    static get registeredSkins(): readonly SkinName[] {
        return [...CashCollectorGame.settingsBySkin.keys()];
    }

    override get acceptedSkins(): readonly SkinName[] {
        return CashCollectorGame.registeredSkins;
    }

    override setSettings(version: string): void {
        const registry = CashCollectorGame.settingsBySkin.get(this.request.Skin);
        if (registry === undefined) throw new Error(`No cash-collector settings are registered for skin ${this.request.Skin}`);

        // setState() re-points the state-dependent fields in place, so every game works on its own
        // copy — a registration holding one settings OBJECT must never carry a state between games.
        this.settings = cloneSettings(registry.createOrDefault(version));
    }

    /**
     * The C#'s SetDefaultSettings keeps only the game's OWN stakes that divide by 10, so every cash
     * value (a stake multiple of 0.1) is a whole number of pence. Continue/resume validate stakes
     * before the stored game's settings are loaded, so they read the skin's default registration.
     */
    protected override getGameStakeOptions(configuredStakeOptions: number[]): number[] {
        const settings = (this.settings as CashCollectorSettings | undefined) ?? CashCollectorGame.defaultSettingsFor(this.request.Skin);
        if (settings === undefined) return configuredStakeOptions;
        return settings.StakeOptions.filter(stake => stake % 10 === 0);
    }

    private static defaultSettingsFor(skin: SkinName): CashCollectorSettings | undefined {
        const registry = CashCollectorGame.settingsBySkin.get(skin);
        const version = registry?.defaultVersion;
        return version === undefined ? undefined : registry?.tryCreate(version);
    }

    override populateResponseGameSettings(): void {
        const settings = this.settings as CashCollectorSettings | undefined;

        if (settings !== undefined) {
            const responseSettings = new CashCollectorResponseGameSettings();
            responseSettings.Symbols = settings.Symbols;
            responseSettings.SpecialSymbols = {
                WildSymbol: settings.WildSymbol,
                BonusSymbol: settings.ScatterSymbol,
                CashSymbol: settings.CashSymbol,
                CollectorSymbol: settings.CollectorSymbol,
            };
            responseSettings.StateProgressionThresholds = [...settings.StateProgressionThresholds];
            responseSettings.MaxGameState = settings.MaxGameState;
            responseSettings.CollectorTiers = settings.BonusSettings.CollectorTiers.map(tier => ({ ...tier }));
            responseSettings.RTP = settings.Rtp.toFixed(2);
            this.response.GameSettings = responseSettings;
        }

        super.populateResponseGameSettings();
    }
}

function cloneSettings(settings: CashCollectorSettings): CashCollectorSettings {
    return Object.assign(new CashCollectorSettings(), JSON.parse(JSON.stringify(settings)) as Partial<CashCollectorSettings>);
}

export class CashCollectorDebugHandler implements IGameDebugHandler {
    // MOCK: the C# debug handler rebuilds whole boards from forced reel stops and feature picks.
    // The mock draws every overlay from the RNG in processRngRequest, so a forced stop would
    // desynchronise the pre-drawn feature data; debug requests are logged and ignored instead.
    async applyOverridesAsync(context: IGameContext): Promise<void> {
        if (context.requestType !== RequestType.Begin) return;
        const debug = context.request.DebugGameData as CashCollectorDebugRequest | undefined;
        if (debug?.DebugStops !== undefined) context.loggingService.logWarning('cash-collector ignores DebugStops: its boards are generated, not read off reel stops');
    }

    async applyRngResponseAsync(context: IGameContext, rngResponse: RNGGameResponse): Promise<void> {
        void context;
        void rngResponse;
    }

    // MOCK: the C# simulation client is not ported; this reports the round already on the context.
    async playSimulationGameAsync(
        context: IGameContext,
        version: string,
        initializeSettings: (version: string) => boolean,
    ): Promise<SimulationGameResult> {
        if (!initializeSettings(version)) return { MainPayout: 0, BonusPayout: 0, Success: false };

        const message = context.response.GameMessage as CashCollectorGameMessage | undefined;
        const bonusPayout = message?.BonusSpin?.TotalBonusPayout ?? 0;
        return { MainPayout: (message?.Payout ?? 0) - bonusPayout, BonusPayout: bonusPayout, Success: message !== undefined };
    }

    bumpContinueRequestForSimulation(context: IGameContext): void {
        const bonusData = context.request.BonusRoundData as CashCollectorContinueRequest | undefined;
        context.request.BonusRoundData = { BonusSpin: (bonusData?.BonusSpin ?? 0) + 1 };
    }
}
