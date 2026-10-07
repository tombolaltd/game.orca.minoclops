// Ported from Libraries/Games/CashCollector3/CashCollector3GameRegistration.cs.

import { SkinName } from '../../core/models/enums';
import { GameTypeRegistry } from '../../registry/GameTypeRegistry';
import { GameSettingsFactory } from '../../settings/GameSettingsBase';
import { parseCashCollectorContinueRequest, parseCashCollectorDebugRequest } from './CashCollectorContinueRequest';
import { CashCollectorGame } from './CashCollectorGame';
import { CashCollectorSettings } from './CashCollectorSettings';

export const CASH_COLLECTOR_SKIN: SkinName = 'CashCollector';

export interface CashCollectorRegistrationOptions {
    skin?: SkinName;
    /** Defaults to the 95.00 Cash Collector 3 maths. */
    settings?: CashCollectorSettings | GameSettingsFactory<CashCollectorSettings>;
    version?: string;
}

export function registerCashCollectorGame(options: CashCollectorRegistrationOptions = {}): SkinName {
    const skin = (options.skin ?? CASH_COLLECTOR_SKIN).trim();

    CashCollectorGame.registerSettings(skin, options.settings ?? CashCollectorGame.createDefaultSettings(), options.version);
    GameTypeRegistry.register({
        game: skin,
        factory: (request, requestType) => new CashCollectorGame(request, requestType),
        bonusRoundData: parseCashCollectorContinueRequest,
        debugGameData: parseCashCollectorDebugRequest,
    });

    return skin;
}
