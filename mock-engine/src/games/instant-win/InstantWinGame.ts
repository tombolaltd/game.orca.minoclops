// Ported from Libraries/Games/Tap/{TapGame,TapDebugHandler}.cs.
//
// TapGame.Create is the assembly point that wires the ticket helper, logic handler and debug
// handler; the mock does the same from the constructor because TypeScript has no object initialiser.

import { ArcadeGame } from '../../core/ArcadeGame';
import { IGameContext, IGameDebugHandler, SimulationGameResult } from '../../core/interfaces';
import { BaseArcadeRequest } from '../../core/models/BaseArcadeRequest';
import { GameInternalData, RNGGameResponse } from '../../core/models/GameInternalData';
import { GameType, RequestType, SkinName } from '../../core/models/enums';
import { createDefaultArcadeResponse } from '../../MockEngine';
import { GameSettingsFactory, GameSettingsRegistry } from '../../settings/GameSettingsBase';
import { InstantWinDebugRequest } from './InstantWinContinueRequest';
import { InstantWinGameMessage } from './InstantWinGameMessage';
import { dealInstantWinCard, InstantWinLogicHandler, InstantWinRngRequest, InstantWinRngResponse } from './InstantWinLogicHandler';
import {
    createDefaultInstantWinSettings,
    InstantWinResponseGameSettings,
    InstantWinSettings,
    toInstantWinSymbols,
} from './InstantWinSettings';
import { InstantWinTicketHelper } from './InstantWinTicketHelper';

export const INSTANT_WIN_MECHANIC = 'InstantWin';

export class InstantWinGame extends ArcadeGame {
    // One registry per skin, so one mechanic serves many prototypes with different settings.
    private static readonly settingsBySkin = new Map<SkinName, GameSettingsRegistry<InstantWinSettings>>();

    constructor(request: BaseArcadeRequest, requestType: RequestType) {
        const internalData = new GameInternalData();
        internalData.GameNames = { GameType: GameType.InstantWin, FriendlyGameName: 'Instant Win', EnabledGameName: INSTANT_WIN_MECHANIC };
        internalData.Timestamps = { StartStamp: new Date().toISOString() };

        super(request, createDefaultArcadeResponse(requestType), requestType, internalData);

        // The round completes on begin, so no incomplete ticket ever has to survive in the cache.
        this.shouldCacheTickets = false;
        this.ticketHelper = new InstantWinTicketHelper(this);
        this.logicHandler = new InstantWinLogicHandler(this);
        this.debugHandler = new InstantWinDebugHandler();
    }

    static createDefaultSettings(): InstantWinSettings {
        return createDefaultInstantWinSettings();
    }

    static registerSettings(skin: SkinName, settings: InstantWinSettings | GameSettingsFactory<InstantWinSettings>, version?: string): void {
        const factory: GameSettingsFactory<InstantWinSettings> = typeof settings === 'function' ? settings : () => settings;
        const registry = InstantWinGame.settingsBySkin.get(skin) ?? new GameSettingsRegistry<InstantWinSettings>();

        registry.register(version ?? factory().ActiveVersion, factory);
        InstantWinGame.settingsBySkin.set(skin, registry);
    }

    static get registeredSkins(): readonly SkinName[] {
        return [...InstantWinGame.settingsBySkin.keys()];
    }

    override get acceptedSkins(): readonly SkinName[] {
        return InstantWinGame.registeredSkins;
    }

    override setSettings(version: string): void {
        const registry = InstantWinGame.settingsBySkin.get(this.request.Skin);
        if (registry === undefined) throw new Error(`No instant-win settings are registered for skin ${this.request.Skin}`);

        this.settings = registry.createOrDefault(version);
    }

    override populateResponseGameSettings(): void {
        const settings = this.settings as InstantWinSettings | undefined;

        if (settings !== undefined) {
            const responseSettings = new InstantWinResponseGameSettings();
            responseSettings.Symbols = toInstantWinSymbols(settings);
            responseSettings.RevealCount = settings.RevealCount;
            responseSettings.RTP = settings.Rtp.toFixed(2);
            this.response.GameSettings = responseSettings;
        }

        super.populateResponseGameSettings();
    }
}

/** Port of TapDebugHandler: forces the dealt card, or plants a chosen prize symbol. */
export class InstantWinDebugHandler implements IGameDebugHandler {
    async applyOverridesAsync(context: IGameContext): Promise<void> {
        if (context.requestType !== RequestType.Begin) return;

        const debug = context.request.DebugGameData as InstantWinDebugRequest | undefined;
        const settings = context.settings as InstantWinSettings | undefined;
        const rngRequest = context.internalData.RngRequest as InstantWinRngRequest | undefined;
        const rngResponse = context.internalData.RngResponse as InstantWinRngResponse | undefined;
        if (debug == null || settings === undefined || rngRequest === undefined || rngResponse === undefined) return;

        if (debug.ForceSymbol !== undefined) {
            const forced = debug.ForceSymbol;
            if (!settings.Prizes.some(prize => prize.Symbol === forced))
                context.loggingService.logWarning(`ForceSymbol ${forced} is not in the prize table`);
            else {
                rngResponse.WinningSymbols = [forced];
                rngResponse.Reveals = await dealInstantWinCard(rngRequest, rngResponse.WinningSymbols);
            }
        }

        if (debug.DebugReveals !== undefined) {
            rngResponse.Reveals = fitCard(debug.DebugReveals, settings);
            rngResponse.WinningSymbols = winningSymbolsIn(rngResponse.Reveals, settings);
        }
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

        const message = context.response.GameMessage as InstantWinGameMessage | undefined;
        return { MainPayout: message?.Payout ?? 0, BonusPayout: 0, Success: message !== undefined };
    }

    bumpContinueRequestForSimulation(context: IGameContext): void {
        // The round completes on begin, so a simulation never steps a continue.
        void context;
    }
}

/** Unknown symbols become blanks and the card is padded or truncated, so a debug card is never rejected. */
function fitCard(reveals: readonly number[], settings: InstantWinSettings): number[] {
    const known = new Set(settings.Prizes.map(prize => prize.Symbol));
    const card: number[] = [];

    for (let cell = 0; cell < settings.RevealCount; cell++) {
        const symbol = Math.trunc(reveals[cell] ?? settings.BlankSymbol);
        card.push(known.has(symbol) ? symbol : settings.BlankSymbol);
    }

    return card;
}

function winningSymbolsIn(reveals: readonly number[], settings: InstantWinSettings): number[] {
    return settings.Prizes.filter(
        prize => prize.MatchesToWin > 0 && reveals.filter(symbol => symbol === prize.Symbol).length >= prize.MatchesToWin,
    ).map(prize => prize.Symbol);
}
