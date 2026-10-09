import { queryStringParams } from '@game-studio/arcade-base';

import { ISkinConfigEx, SupportedLocale } from '@/src/types';

import { skinConfig as DenmarkSkinConfig } from './denmark/config';
import { skinConfig as ItalySkinConfig } from './italy/config';
import { skinConfig as SpainSkinConfig } from './spain/config';
import { skinConfig as SwedenSkinConfig } from './sweden/config';
import { skinConfig as DefaultSkinConfig } from './default/config';

export function getSkinConfig(): ISkinConfigEx {
    const supportedRegions = queryStringParams.locale as SupportedLocale;

    switch (supportedRegions) {
        case 'it-it':
            return ItalySkinConfig;
    
        case 'dk-dk':
            return DenmarkSkinConfig;
        
        case 'es-es':
            return SpainSkinConfig;
        
        case 'se-se':
            return SwedenSkinConfig;

        default:
            return DefaultSkinConfig;
    }
}