// Ported from Libraries/Games/Tap/TapGameMessage.cs and Libraries/Games/MultiScratch/MultiScratchGameMessage.cs.
//
// Field names are the editor's CANONICAL_ARCADE_ENVELOPE (src/services/ServerMappingCodegen.ts).
// Stops / DisplayReels / BonusSpin have no meaning here but are emitted empty so ONE Data Browser
// mapping set works across all three bundled mechanics.

import { GameMessage } from '../../core/models/GameMessage';
import { PlayMode } from '../../core/models/enums';
import { InstantWinBonusSpin, InstantWinResult, InstantWinScatterResult } from './InstantWinSettings';

export interface InstantWinGameMessage extends GameMessage {
    /** The dealt card, one symbol per cell. The mechanic's real payload. */
    Reveals: number[];
    Stops: number[];
    DisplayReels: number[][];
    Results: InstantWinResult[];
    ScatterResult: InstantWinScatterResult;
    BonusSpin: InstantWinBonusSpin;
    TotalPrize: number;
    PlayMode: PlayMode;
}

export function createEmptyInstantWinScatterResult(): InstantWinScatterResult {
    return { Positions: [], OutcomeType: 'None', Count: 0, Symbol: null, Multiplier: 0, Prize: 0, Bonus: false };
}

export function createEmptyInstantWinBonusSpin(): InstantWinBonusSpin {
    return { Stops: [], DisplayReels: [], Number: 0, Remaining: 0, BonusPayout: 0, TotalBonusPayout: 0, Results: [], StackedWildReel: [] };
}
