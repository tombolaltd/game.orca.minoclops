// Ported from Libraries/Games/Scatter/ScatterRegistration.cs.

import { SkinName } from '../../core/models/enums';
import { GameTypeRegistry } from '../../registry/GameTypeRegistry';
import { GameSettingsFactory } from '../../settings/GameSettingsBase';
import { parseLinesSlotContinueRequest, parseLinesSlotDebugRequest } from './LinesSlotContinueRequest';
import { LinesSlotGame } from './LinesSlotGame';
import { LinesSlotSettings } from './LinesSlotSettings';

export const LINES_SLOT_SKIN: SkinName = 'LinesSlot';

export interface LinesSlotRegistrationOptions {
    /** The `{game}` URL segment and the SkinName. Defaults to `LinesSlot`. */
    skin?: SkinName;
    /** Everything that makes this prototype different. Defaults to a playable 5x3, 5-line game. */
    settings?: LinesSlotSettings | GameSettingsFactory<LinesSlotSettings>;
    /** Overrides the settings' own ActiveVersion as the registry key. */
    version?: string;
}

export function registerLinesSlotGame(options: LinesSlotRegistrationOptions = {}): SkinName {
    const skin = (options.skin ?? LINES_SLOT_SKIN).trim();

    LinesSlotGame.registerSettings(skin, options.settings ?? LinesSlotGame.createDefaultSettings(), options.version);
    GameTypeRegistry.register({
        game: skin,
        factory: (request, requestType) => new LinesSlotGame(request, requestType),
        bonusRoundData: parseLinesSlotContinueRequest,
        debugGameData: parseLinesSlotDebugRequest,
    });

    return skin;
}
