import './styles.css';

import { BaseGame, IEngineConfig, queryStringParams } from '@game-studio/arcade-base';

import packageConfig from '@/package.json';
import configJson from '@/config.json';
import { getBindings } from '@/src/core/inversify';
import { getAdditionalSettings } from '@/src/core/settings';
import { SupportedLocale } from './types';
import { features } from './config/features';
import { engineName } from './config/engine-name';
import { ACTIVE_SKIN } from '@/src/core/services/orca/active-skin';
import { installDevChatPlaceholder } from './core/dev/chat-placeholder';
import { getOrcaAdditionalSettings, getOrcaGamePreferences } from '@/src/core/services/orca/game-preferences';
import { orcaLoadingScreenPlugin } from '@/src/core/services/orca/loading-screen';

// Dev-only: replace arcade-base's chat iframe `src` with an inline placeholder
// page so the chat panel is visually recognisable inside the Orca / Flowstate
// editor's embedded game-emulator <webview>, where the real chat URL is
// unreachable. No-op in production builds.
installDevChatPlaceholder();

const region = queryStringParams.locale as SupportedLocale;

// `engine-name.ts` rows are keyed by EFFECTIVE skin folder, which a Skin
// override lets differ from the raw `?skin=` launcher tile id.
function resolveEngineName(): string | undefined {
    const rows: Record<string, string> | undefined = engineName[region];
    if (!rows) {
        console.warn(`engine-name: no block for locale "${region}" — EngineName left unset.`);
        return undefined;
    }

    let requested = '';
    try {
        // arcade-base throws when the host supplied no `?skin=` — see `skin-resolver.ts`.
        const raw = queryStringParams.currentSkin;
        requested = typeof raw === 'string' ? raw : '';
    } catch (err) {
        requested = '';
    }

    if (requested && Object.prototype.hasOwnProperty.call(rows, requested)) {
        return rows[requested];
    }
    if (Object.prototype.hasOwnProperty.call(rows, ACTIVE_SKIN)) {
        console.warn(`engine-name: no entry for launcher skin "${requested}" — using resolved skin folder "${ACTIVE_SKIN}".`);
        return rows[ACTIVE_SKIN];
    }

    console.warn(`engine-name: no entry for launcher skin "${requested}" or resolved skin folder "${ACTIVE_SKIN}" — EngineName left unset.`);
    return undefined;
}

// `AssetFolder` is a LOCAL path segment (`static/assets/<folder>/…`), and the
// editor keys those folders by EFFECTIVE skin folder, so `ACTIVE_SKIN` is the
// only value that names a folder that exists. `ACTIVE_SKIN` is already
// `resolveSkinFolder(SKIN_TABLE, DEFAULT_SKIN)`, so it equals the raw `?skin=`
// whenever that is a real skin folder — this diverges only on a Skin override.
function resolveAssetFolder(): string {
    let requested = '';
    try {
        // arcade-base throws when the host supplied no `?skin=` — see `skin-resolver.ts`.
        const raw = queryStringParams.currentSkin;
        requested = typeof raw === 'string' ? raw : '';
    } catch (err) {
        requested = '';
    }

    if (requested && requested !== ACTIVE_SKIN) {
        console.warn(`asset-folder: launcher skin "${requested}" is not a bundled skin folder — serving assets from "${ACTIVE_SKIN}".`);
    }
    return ACTIVE_SKIN;
}

const engineConfig: IEngineConfig = {
    GameCategory: 'slots', // only refers to the userPrefsName now

    // Scaffold placeholder. Only read by @game-studio/game-in-game, which is
    // inert while Features.enableGameInGame is false — replace with the real
    // guid from the config portal if you enable that feature.
    GameGuid: 'GAME_GUID',

    EngineName: resolveEngineName(),
    LoggingName: configJson.friendlyName,
    AssetFolder: resolveAssetFolder(),

    // The game name used in the call to the recent winners API.
    RecentWinnersName: 'slots',

    Version: packageConfig.version,
    Features: features[region],
    HeightRatio: 0.67, // height relative to width on mobile portrait views

    AdditionalSettingsGetter: () => getAdditionalSettings().concat(getOrcaAdditionalSettings()),
    GamePreferences: getOrcaGamePreferences(),
    VuePlugin: orcaLoadingScreenPlugin,

    CdnFolderName: 'template', // only relevant if the feature usingLocalAssets = false or undefined, ignored otherwise
    AutoRun: true // set this to false if you'd like to interject after initialising to do something before the game runs
};

const game = new BaseGame();
const bindings = getBindings();

game.initialise(engineConfig, bindings.gameBindings, bindings.regionalBindings);
// Example using AutoRun: false to run a skin different from the launcher name
// game.initialise(engineConfig, bindings.gameBindings, bindings.regionalBindings).then(() => {
//     // could show a popup here to pick a skin to launch i.e. jackpots or non-jackpots
//     queryStringParams.currentSkin = 'bubble';
//     game.run();
// });
