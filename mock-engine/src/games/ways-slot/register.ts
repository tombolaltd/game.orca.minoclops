// Ported from Libraries/Games/Mystery243/Mystery243Registration.cs.

import { SkinName } from '../../core/models/enums';
import { GameTypeRegistry } from '../../registry/GameTypeRegistry';
import { GameSettingsFactory } from '../../settings/GameSettingsBase';
import { parseWaysSlotContinueRequest, parseWaysSlotDebugRequest } from './WaysSlotContinueRequest';
import { WaysSlotGame } from './WaysSlotGame';
import { WaysSlotSettings } from './WaysSlotSettings';

export const WAYS_SLOT_SKIN: SkinName = 'WaysSlot';

export interface WaysSlotRegistrationOptions {
    skin?: SkinName;
    /** Everything that makes this prototype different. Defaults to a playable 5x3 243-ways game. */
    settings?: WaysSlotSettings | GameSettingsFactory<WaysSlotSettings>;
    version?: string;
}

export function registerWaysSlotGame(options: WaysSlotRegistrationOptions = {}): SkinName {
    const skin = (options.skin ?? WAYS_SLOT_SKIN).trim();

    WaysSlotGame.registerSettings(skin, options.settings ?? WaysSlotGame.createDefaultSettings(), options.version);
    GameTypeRegistry.register({
        game: skin,
        factory: (request, requestType) => new WaysSlotGame(request, requestType),
        bonusRoundData: parseWaysSlotContinueRequest,
        debugGameData: parseWaysSlotDebugRequest,
    });

    return skin;
}
