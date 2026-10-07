import { getRegion, Region } from '@arcade-client/base-ticketfetcher-package';
import { ContainerModule } from 'inversify';
import { DenmarkModule } from './variants/denmark/bindings';
import { ItalyModule } from './variants/italy/bindings';
import { NetherlandsModule } from './variants/netherlands/bindings';
import { SpainModule } from './variants/spain/bindings';
import { SwedenModule } from './variants/sweden/bindings';

export function getVarientBindings(): ContainerModule | undefined {
    const region: Region = getRegion();

    switch (region) {
        case 'es':
            return SpainModule;
        case 'it':
            return ItalyModule;
        case 'dk':
            return DenmarkModule;
        case 'se':
            return SwedenModule;
        case 'nl':
            return NetherlandsModule;
        default:
            return undefined;
    }
}