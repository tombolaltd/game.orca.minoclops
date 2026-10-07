// The mechanic catalog barrel. Importing it registers every bundled mechanic with
// GameTypeRegistry, and MECHANIC_CATALOG lets a consumer enumerate the blocks from one array.

import { ArcadeGameType, SkinName } from '../core/models/enums';
import { GameSettingsBase } from '../settings/GameSettingsBase';
import { createDefaultInstantWinSettings } from './instant-win/InstantWinSettings';
import { registerInstantWinGame } from './instant-win/register';
import { createDefaultLinesSlotSettings } from './lines-slot/LinesSlotSettings';
import { registerLinesSlotGame } from './lines-slot/register';
import { createDefaultWaysSlotSettings } from './ways-slot/WaysSlotSettings';
import { registerWaysSlotGame } from './ways-slot/register';
import { createDefaultCashCollectorSettings } from './cash-collector/CashCollectorSettings';
import { registerCashCollectorGame } from './cash-collector/register';

export * from './lines-slot/LinesSlotSettings';
export * from './lines-slot/LinesSlotGameMessage';
export * from './lines-slot/LinesSlotContinueRequest';
export * from './lines-slot/LinesSlotTicketHelper';
export * from './lines-slot/LinesSlotLogicHandler';
export * from './lines-slot/LinesSlotGame';
export * from './lines-slot/register';

export * from './ways-slot/WaysSlotSettings';
export * from './ways-slot/WaysSlotGameMessage';
export * from './ways-slot/WaysSlotContinueRequest';
export * from './ways-slot/WaysSlotTicketHelper';
export * from './ways-slot/WaysSlotLogicHandler';
export * from './ways-slot/WaysSlotGame';
export * from './ways-slot/register';

export * from './cash-collector/CashCollectorSettings';
export * from './cash-collector/CashCollectorGameMessage';
export * from './cash-collector/CashCollectorContinueRequest';
export * from './cash-collector/CashCollectorFeatures';
export * from './cash-collector/CashCollectorTicketHelper';
export * from './cash-collector/CashCollectorLogicHandler';
export * from './cash-collector/CashCollectorGame';
export * from './cash-collector/register';

export * from './instant-win/InstantWinSettings';
export * from './instant-win/InstantWinGameMessage';
export * from './instant-win/InstantWinContinueRequest';
export * from './instant-win/InstantWinTicketHelper';
export * from './instant-win/InstantWinLogicHandler';
export * from './instant-win/InstantWinGame';
export * from './instant-win/register';

/** The slice of every register* options object the catalog needs; each mechanic's own type is wider. */
export interface MechanicRegistrationOptions {
    /** The `{game}` URL segment and the SkinName. Defaults to the mechanic's own. */
    skin?: SkinName;
    /** Overrides the settings' own ActiveVersion as the registry key. */
    version?: string;
}

export interface MechanicCatalogEntry {
    /** Stable id, matching the folder under src/games. */
    key: string;
    friendlyName: string;
    arcadeGameType: ArcadeGameType;
    description: string;
    settingsTypeName: string;
    createDefaultSettings: () => GameSettingsBase;
    register: (options?: MechanicRegistrationOptions) => SkinName;
}

export const MECHANIC_CATALOG: readonly MechanicCatalogEntry[] = [
    {
        key: 'lines-slot',
        friendlyName: 'Lines Slot',
        arcadeGameType: ArcadeGameType.Spin,
        description: 'Reel slot paying fixed left-to-right paylines, with wilds, scatters and a free-spin bonus round.',
        settingsTypeName: 'LinesSlotSettings',
        createDefaultSettings: createDefaultLinesSlotSettings,
        register: registerLinesSlotGame,
    },
    {
        key: 'ways-slot',
        friendlyName: 'Ways Slot',
        arcadeGameType: ArcadeGameType.Spin,
        description: 'Reel slot paying every adjacent symbol path (243 ways by default), with wilds, scatters and a free-spin bonus round.',
        settingsTypeName: 'WaysSlotSettings',
        createDefaultSettings: createDefaultWaysSlotSettings,
        register: registerWaysSlotGame,
    },
    {
        key: 'cash-collector',
        friendlyName: 'Cash Collector',
        arcadeGameType: ArcadeGameType.Spin,
        description: 'A 6x4 ways slot where collector symbols bank on-screen cash values. Collector kinds (Standard, Lock & Spin, Cash Boost, Win Blast) unlock as cash symbols fill a persistent meter; 3+ scatters start free spins with a rising cash multiplier.',
        settingsTypeName: 'CashCollectorSettings',
        createDefaultSettings: createDefaultCashCollectorSettings,
        register: registerCashCollectorGame,
    },
    {
        key: 'instant-win',
        friendlyName: 'Instant Win',
        arcadeGameType: ArcadeGameType.InstantWin,
        description: 'Scratch card of reveal cells where a symbol landing MatchesToWin times pays its stake multiplier.',
        settingsTypeName: 'InstantWinSettings',
        createDefaultSettings: createDefaultInstantWinSettings,
        register: registerInstantWinGame,
    },
];

/** Registers every catalogued mechanic under its own default skin; re-runnable after GameTypeRegistry.clear(). */
export function registerBundledMechanics(): readonly SkinName[] {
    return MECHANIC_CATALOG.map(entry => entry.register());
}

registerBundledMechanics();
