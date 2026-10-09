import { ContainerModule } from 'inversify';

import { container, queryStringParams } from '@game-studio/arcade-base';

import { containerModule as UKModule } from './bindings';
import { containerModule as SpainModule } from './variants/spain/bindings';
import { containerModule as ItalyModule } from './variants/italy/bindings';
import { containerModule as DenmarkModule } from './variants/denmark/bindings';
import { containerModule as SwedenModule } from './variants/sweden/bindings';
import { IGameStrings, SupportedLocale } from '@/src/types';

export type Bindings = { gameBindings: ContainerModule; regionalBindings?: ContainerModule; }

type DIContainer = typeof container;
export interface IGameDIContainer extends DIContainer {
    get strings(): IGameStrings;
}

export const diContainer = container as IGameDIContainer;

export function getBindings(): Bindings {
    const bindings: Bindings = { gameBindings: UKModule };
    const region = queryStringParams.locale as SupportedLocale;

    switch (region) {
        case 'es-es':
            bindings.regionalBindings = SpainModule;
            break;

        case 'it-it':
            bindings.regionalBindings = ItalyModule;
            break;

        case 'dk-dk':
            bindings.regionalBindings = DenmarkModule;
            break;

        case 'se-se':
            bindings.regionalBindings = SwedenModule;
            break;
        default:
            bindings.regionalBindings = undefined;
    }

    return bindings;
}
