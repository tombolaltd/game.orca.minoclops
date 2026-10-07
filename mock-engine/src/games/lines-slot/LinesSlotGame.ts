// Ported from Libraries/Games/Scatter/{ScatterGame,ScatterDebugHandler}.cs.
//
// ScatterGame.Create is the assembly point that wires the ticket helper, logic handler and debug
// handler; the mock does the same from the constructor because TypeScript has no object initialiser.

import { ArcadeGame } from '../../core/ArcadeGame';
import { IGameContext, IGameDebugHandler, SimulationGameResult } from '../../core/interfaces';
import { BaseArcadeRequest } from '../../core/models/BaseArcadeRequest';
import { RNGGameResponse } from '../../core/models/GameInternalData';
import { GameType, RequestType, SkinName } from '../../core/models/enums';
import { createDefaultArcadeResponse } from '../../MockEngine';
import { GameSettingsFactory, GameSettingsRegistry } from '../../settings/GameSettingsBase';
import { LinesSlotContinueRequest, LinesSlotDebugRequest } from './LinesSlotContinueRequest';
import { LinesSlotGameMessage } from './LinesSlotGameMessage';
import { LinesSlotLogicHandler, LinesSlotRngResponse } from './LinesSlotLogicHandler';
import { createDefaultLinesSlotSettings, LinesSlotResponseGameSettings, LinesSlotSettings } from './LinesSlotSettings';
import { LinesSlotInternalData, LinesSlotTicketHelper } from './LinesSlotTicketHelper';

export const LINES_SLOT_MECHANIC = 'LinesSlot';

export class LinesSlotGame extends ArcadeGame {
    // One registry per skin, so one mechanic serves many prototypes with different settings.
    private static readonly settingsBySkin = new Map<SkinName, GameSettingsRegistry<LinesSlotSettings>>();

    constructor(request: BaseArcadeRequest, requestType: RequestType) {
        const internalData = new LinesSlotInternalData();
        internalData.GameNames = { GameType: GameType.Spin, FriendlyGameName: 'Lines Slot', EnabledGameName: LINES_SLOT_MECHANIC };
        internalData.Timestamps = { StartStamp: new Date().toISOString() };

        super(request, createDefaultArcadeResponse(requestType), requestType, internalData);

        // The bonus round spans requests, so the incomplete ticket has to survive in the cache.
        this.shouldCacheTickets = true;
        this.ticketHelper = new LinesSlotTicketHelper(this);
        this.logicHandler = new LinesSlotLogicHandler(this);
        this.debugHandler = new LinesSlotDebugHandler();
    }

    static createDefaultSettings(): LinesSlotSettings {
        return createDefaultLinesSlotSettings();
    }

    static registerSettings(skin: SkinName, settings: LinesSlotSettings | GameSettingsFactory<LinesSlotSettings>, version?: string): void {
        const factory: GameSettingsFactory<LinesSlotSettings> = typeof settings === 'function' ? settings : () => settings;
        const registry = LinesSlotGame.settingsBySkin.get(skin) ?? new GameSettingsRegistry<LinesSlotSettings>();

        registry.register(version ?? factory().ActiveVersion, factory);
        LinesSlotGame.settingsBySkin.set(skin, registry);
    }

    static get registeredSkins(): readonly SkinName[] {
        return [...LinesSlotGame.settingsBySkin.keys()];
    }

    override get acceptedSkins(): readonly SkinName[] {
        return LinesSlotGame.registeredSkins;
    }

    override setSettings(version: string): void {
        const registry = LinesSlotGame.settingsBySkin.get(this.request.Skin);
        if (registry === undefined) throw new Error(`No lines-slot settings are registered for skin ${this.request.Skin}`);

        this.settings = registry.createOrDefault(version);
    }

    override populateResponseGameSettings(): void {
        const settings = this.settings as LinesSlotSettings | undefined;

        if (settings !== undefined) {
            const responseSettings = new LinesSlotResponseGameSettings();
            responseSettings.Reels = settings.Reels;
            responseSettings.BonusSpinReels = settings.BonusSettings.Reels;
            responseSettings.Winlines = settings.Winlines;
            responseSettings.Symbols = settings.Symbols;
            responseSettings.WildSymbol = settings.WildSymbol;
            responseSettings.ScatterSymbol = settings.ScatterSymbol;
            responseSettings.BonusSymbol = settings.BonusSymbol;
            responseSettings.RTP = settings.Rtp.toFixed(2);
            this.response.GameSettings = responseSettings;
        }

        super.populateResponseGameSettings();
    }
}

/** Port of ScatterDebugHandler: forces stops, forced bonus stops, or the bonus trigger itself. */
export class LinesSlotDebugHandler implements IGameDebugHandler {
    async applyOverridesAsync(context: IGameContext): Promise<void> {
        if (context.requestType !== RequestType.Begin) return;

        const debug = context.request.DebugGameData as LinesSlotDebugRequest | undefined;
        const settings = context.settings as LinesSlotSettings | undefined;
        const rngResponse = context.internalData.RngResponse as LinesSlotRngResponse | undefined;
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

    // MOCK: the C# runs a full headless play loop through the simulation client, which is not ported.
    async playSimulationGameAsync(
        context: IGameContext,
        version: string,
        initializeSettings: (version: string) => boolean,
    ): Promise<SimulationGameResult> {
        if (!initializeSettings(version)) return { MainPayout: 0, BonusPayout: 0, Success: false };

        const message = context.response.GameMessage as LinesSlotGameMessage | undefined;
        const bonusPayout = message?.BonusSpin?.TotalBonusPayout ?? 0;
        return { MainPayout: (message?.Payout ?? 0) - bonusPayout, BonusPayout: bonusPayout, Success: message !== undefined };
    }

    bumpContinueRequestForSimulation(context: IGameContext): void {
        const bonusData = context.request.BonusRoundData as LinesSlotContinueRequest | undefined;
        context.request.BonusRoundData = { BonusSpin: (bonusData?.BonusSpin ?? 0) + 1 };
    }
}

function wrapStops(stops: readonly number[], reels: readonly (readonly number[])[]): number[] {
    return reels.map((reel, index) => {
        const stop = Math.trunc(stops[index] ?? 0);
        return reel.length === 0 ? 0 : ((stop % reel.length) + reel.length) % reel.length;
    });
}

/** The lowest stop on each reel that puts the bonus symbol in view, so a forced bonus is repeatable. */
function findBonusTriggerStops(settings: LinesSlotSettings): number[] | undefined {
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
