import { BaseCabinet, CasinoCabinet, ICabinetOptions } from '@game-studio/arcade-base';

import * as activeSkinExports from './active-skin';
import { EmptyCabinet } from './empty-cabinet';

export type OrcaCabinetMode = 'standard' | 'none' | 'casino';

// Namespace read so an active-skin.ts generated before CABINET_MODE existed still compiles.
export function getOrcaCabinetMode(): OrcaCabinetMode {
    const mode = (activeSkinExports as unknown as { CABINET_MODE?: unknown }).CABINET_MODE;
    return mode === 'none' || mode === 'casino' ? mode : 'standard';
}

/** Builds the cabinet chosen in Orca's Project Settings ▸ Cabinet. */
export function createOrcaCabinet(options: ICabinetOptions): BaseCabinet {
    switch (getOrcaCabinetMode()) {
        case 'none':
            return new EmptyCabinet(options);
        case 'casino':
            return new CasinoCabinet(options);
        default:
            return new BaseCabinet(options);
    }
}
