// Ported from Libraries/Games/Tap/TapGameRegistration.cs.

import { SkinName } from '../../core/models/enums';
import { GameTypeRegistry } from '../../registry/GameTypeRegistry';
import { GameSettingsFactory } from '../../settings/GameSettingsBase';
import { parseInstantWinContinueRequest, parseInstantWinDebugRequest } from './InstantWinContinueRequest';
import { InstantWinGame } from './InstantWinGame';
import { InstantWinSettings } from './InstantWinSettings';

export const INSTANT_WIN_SKIN: SkinName = 'InstantWin';

export interface InstantWinRegistrationOptions {
    /** The `{game}` URL segment and the SkinName. Defaults to `InstantWin`. */
    skin?: SkinName;
    /** Everything that makes this prototype different. Defaults to a playable 9-cell match-3 card. */
    settings?: InstantWinSettings | GameSettingsFactory<InstantWinSettings>;
    /** Overrides the settings' own ActiveVersion as the registry key. */
    version?: string;
}

export function registerInstantWinGame(options: InstantWinRegistrationOptions = {}): SkinName {
    const skin = (options.skin ?? INSTANT_WIN_SKIN).trim();

    InstantWinGame.registerSettings(skin, options.settings ?? InstantWinGame.createDefaultSettings(), options.version);
    GameTypeRegistry.register({
        game: skin,
        factory: (request, requestType) => new InstantWinGame(request, requestType),
        bonusRoundData: parseInstantWinContinueRequest,
        debugGameData: parseInstantWinDebugRequest,
    });

    return skin;
}
