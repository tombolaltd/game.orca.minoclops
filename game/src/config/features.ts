import { IGameFeatures } from '@game-studio/arcade-base';

import { SupportedLocale } from '../types';

const gameFeatures: IGameFeatures = {
    colourBlindMode: false,
    newStyleHTP: true,
    usingLocalAssets: true,
    batchLoadAssets: false,
    enableChat: true,
    canHideChat: false,
    sessionDataJustification: { portrait: 'default', landscape: 'default' },
    enableActionMenu: true,
    enableGameInGame: false,
    enableSettings: false,
    enableLobby: false
}

export const features: Record<SupportedLocale, IGameFeatures> = {
    'en-gb': {
        ...gameFeatures,
        maxAutoBuys: 0,
        engineRequiresSkinParam: false,
    },
    'it-it': {
        ...gameFeatures,
        maxAutoBuys: 10,
        initialBalanceCheck: { shouldCheckBalance: true, minBalance: 200 },
        showSessionStatusInSettings: true
    },
    'es-es': {
        ...gameFeatures,
        maxAutoBuys: 10,
        initialBalanceCheck: { shouldCheckBalance: true, minBalance: 200 },
        enableSessionManager: true
    },
    'dk-dk': {
        ...gameFeatures,
        // TODO: Setup Regional Features When Required
    },
    'se-se': {
        ...gameFeatures,
        // TODO: Setup Regional Features When Required
    }
};
