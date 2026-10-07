// Ported from Libraries/Games/Mystery243/Mystery243GameMessage.cs.
//
// Field names are the editor's CANONICAL_ARCADE_ENVELOPE (src/services/ServerMappingCodegen.ts).

import { GameMessage } from '../../core/models/GameMessage';
import { PlayMode } from '../../core/models/enums';
import { WaysSlotBonusSpin, WaysSlotScatterResult, WaysSlotWayResult } from './WaysSlotSettings';

export interface WaysSlotGameMessage extends GameMessage {
    Stops: number[];
    DisplayReels: number[][];
    Results: WaysSlotWayResult[];
    ScatterResult: WaysSlotScatterResult;
    BonusSpin: WaysSlotBonusSpin;
    PlayMode: PlayMode;
}

// MOCK: as with lines-slot, the mock always emits both so their response paths always resolve.
export function createEmptyWaysSlotScatterResult(scatterSymbol: number): WaysSlotScatterResult {
    return { Positions: [], OutcomeType: 'None', Count: 0, Symbol: scatterSymbol, Multiplier: 0, Prize: 0, Bonus: false };
}

export function createEmptyWaysSlotBonusSpin(reelCount: number): WaysSlotBonusSpin {
    return {
        Stops: [],
        DisplayReels: [],
        Number: 0,
        Remaining: 0,
        BonusPayout: 0,
        TotalBonusPayout: 0,
        Results: [],
        StackedWildReel: new Array<boolean>(reelCount).fill(false),
    };
}
