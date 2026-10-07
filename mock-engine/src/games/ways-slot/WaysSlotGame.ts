// Ported from Libraries/Games/Mystery243/{Mystery243Game,Mystery243DebugHandler}.cs.

import { ArcadeGame } from '../../core/ArcadeGame';
import { IGameContext, IGameDebugHandler, SimulationGameResult } from '../../core/interfaces';
import { BaseArcadeRequest } from '../../core/models/BaseArcadeRequest';
import { RNGGameResponse } from '../../core/models/GameInternalData';
import { GameType, RequestType, SkinName } from '../../core/models/enums';
import { createDefaultArcadeResponse } from '../../MockEngine';
import { GameSettingsFactory, GameSettingsRegistry } from '../../settings/GameSettingsBase';
import { WaysSlotContinueRequest, WaysSlotDebugRequest } from './WaysSlotContinueRequest';
import { WaysSlotGameMessage } from './WaysSlotGameMessage';
import { WaysSlotLogicHandler, WaysSlotRngResponse } from './WaysSlotLogicHandler';
import { createDefaultWaysSlotSettings, WaysSlotResponseGameSettings, WaysSlotSettings } from './WaysSlotSettings';
import { WaysSlotInternalData, WaysSlotTicketHelper } from './WaysSlotTicketHelper';

export const WAYS_SLOT_MECHANIC = 'WaysSlot';

export class WaysSlotGame extends ArcadeGame {
    private static readonly settingsBySkin = new Map<SkinName, GameSettingsRegistry<WaysSlotSettings>>();

    constructor(request: BaseArcadeRequest, requestType: RequestType) {
        const internalData = new WaysSlotInternalData();
        internalData.GameNames = { GameType: GameType.Spin, FriendlyGameName: 'Ways Slot', EnabledGameName: WAYS_SLOT_MECHANIC };
        internalData.Timestamps = { StartStamp: new Date().toISOString() };

        super(request, createDefaultArcadeResponse(requestType), requestType, internalData);

        this.shouldCacheTickets = true;
        this.ticketHelper = new WaysSlotTicketHelper(this);
        this.logicHandler = new WaysSlotLogicHandler(this);
        this.debugHandler = new WaysSlotDebugHandler();
    }

    static createDefaultSettings(): WaysSlotSettings {
        return createDefaultWaysSlotSettings();
    }

    static registerSettings(skin: SkinName, settings: WaysSlotSettings | GameSettingsFactory<WaysSlotSettings>, version?: string): void {
        const factory: GameSettingsFactory<WaysSlotSettings> = typeof settings === 'function' ? settings : () => settings;
        const registry = WaysSlotGame.settingsBySkin.get(skin) ?? new GameSettingsRegistry<WaysSlotSettings>();

        registry.register(version ?? factory().ActiveVersion, factory);
        WaysSlotGame.settingsBySkin.set(skin, registry);
    }

    static get registeredSkins(): readonly SkinName[] {
        return [...WaysSlotGame.settingsBySkin.keys()];
    }

    override get acceptedSkins(): readonly SkinName[] {
        return WaysSlotGame.registeredSkins;
    }

    override setSettings(version: string): void {
        const registry = WaysSlotGame.settingsBySkin.get(this.request.Skin);
        if (registry === undefined) throw new Error(`No ways-slot settings are registered for skin ${this.request.Skin}`);

        this.settings = registry.createOrDefault(version);
    }

    override populateResponseGameSettings(): void {
        const settings = this.settings as WaysSlotSettings | undefined;

        if (settings !== undefined) {
            const responseSettings = new WaysSlotResponseGameSettings();
            responseSettings.Reels = settings.Reels;
            responseSettings.BonusSpinReels = settings.BonusSettings.Reels;
            responseSettings.Symbols = settings.Symbols;
            responseSettings.WildSymbol = settings.WildSymbol;
            responseSettings.ScatterSymbol = settings.ScatterSymbol;
            responseSettings.BonusSymbol = settings.BonusSymbol;
            responseSettings.Ways = settings.Ways;
            responseSettings.TotalWays = countTotalWays(settings);
            responseSettings.RTP = settings.Rtp.toFixed(2);
            this.response.GameSettings = responseSettings;
        }

        super.populateResponseGameSettings();
    }
}

export class WaysSlotDebugHandler implements IGameDebugHandler {
    async applyOverridesAsync(context: IGameContext): Promise<void> {
        if (context.requestType !== RequestType.Begin) return;

        const debug = context.request.DebugGameData as WaysSlotDebugRequest | undefined;
        const settings = context.settings as WaysSlotSettings | undefined;
        const rngResponse = context.internalData.RngResponse as WaysSlotRngResponse | undefined;
        if (debug == null || settings === undefined || rngResponse === undefined) return;

        if (debug.ForceBonus === true) {
            const forced = findBonusTriggerStops(settings);
            if (forced === undefined) context.loggingService.logWarning('ForceBonus was requested but no reel strip carries the bonus symbol');
            else rngResponse.ReelPositions = forced;
        }

        if (debug.DebugStops !== undefined) rngResponse.ReelPositions = wrapStops(debug.DebugStops, settings.Reels);

        if (debug.DebugBonusStops !== undefined)
            rngResponse.BonusReelPositions = debug.DebugBonusStops.map(stops => wrapStops(stops, settings.BonusSettings.Reels));
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

        const message = context.response.GameMessage as WaysSlotGameMessage | undefined;
        const bonusPayout = message?.BonusSpin?.TotalBonusPayout ?? 0;
        return { MainPayout: (message?.Payout ?? 0) - bonusPayout, BonusPayout: bonusPayout, Success: message !== undefined };
    }

    bumpContinueRequestForSimulation(context: IGameContext): void {
        const bonusData = context.request.BonusRoundData as WaysSlotContinueRequest | undefined;
        context.request.BonusRoundData = { BonusSpins: (bonusData?.BonusSpins ?? 0) + 1 };
    }
}

function countTotalWays(settings: WaysSlotSettings): number {
    if (settings.Reels.length === 0) return 0;

    const ways = Math.pow(settings.ColumnHeight, settings.Reels.length);
    return settings.Ways.PayBothWays ? ways * 2 : ways;
}

function wrapStops(stops: readonly number[], reels: readonly (readonly number[])[]): number[] {
    return reels.map((reel, index) => {
        const stop = Math.trunc(stops[index] ?? 0);
        return reel.length === 0 ? 0 : ((stop % reel.length) + reel.length) % reel.length;
    });
}

function findBonusTriggerStops(settings: WaysSlotSettings): number[] | undefined {
    const stops: number[] = [];
    let reelsShowingBonus = 0;

    for (const reel of settings.Reels) {
        let chosen = 0;
        for (let stop = 0; stop < reel.length; stop++) {
            let showsBonus = false;
            for (let row = 0; row < settings.ColumnHeight; row++) if (reel[(stop + row) % reel.length] === settings.BonusSymbol) showsBonus = true;

            if (showsBonus) {
                chosen = stop;
                reelsShowingBonus++;
                break;
            }
        }
        stops.push(chosen);
    }

    const trigger = settings.Symbols.find(entry => entry.Symbol === settings.BonusSymbol)?.Prizes.filter(prize => prize.PrizeType === 'Bonus') ?? [];
    const minimumMatched = trigger.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...trigger.map(prize => prize.Matched));

    return reelsShowingBonus >= minimumMatched ? stops : undefined;
}
