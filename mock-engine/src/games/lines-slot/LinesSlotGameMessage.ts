// Ported from Libraries/Games/Scatter/ScatterGameMessage.cs.
//
// Field names are the editor's CANONICAL_ARCADE_ENVELOPE (src/services/ServerMappingCodegen.ts):
// changing one silently breaks the Data Browser → Server tab's seeded mappings.

import { GameMessage } from '../../core/models/GameMessage';
import { PlayMode } from '../../core/models/enums';
import { LinesSlotBonusSpin, LinesSlotLineResult, LinesSlotScatterResult } from './LinesSlotSettings';

export interface LinesSlotGameMessage extends GameMessage {
    Stops: number[];
    DisplayReels: number[][];
    Results: LinesSlotLineResult[];
    ScatterResult: LinesSlotScatterResult;
    BonusSpin: LinesSlotBonusSpin;
    PlayMode: PlayMode;
}

// MOCK: the C# leaves ScatterResult/BonusSpin null when nothing happened. The mock always emits
// them so `GameMessage.ScatterResult.Bonus` and the BonusSpin paths resolve on every response.
export function createEmptyLinesSlotScatterResult(scatterSymbol: number): LinesSlotScatterResult {
    return { Positions: [], OutcomeType: 'None', Count: 0, Symbol: scatterSymbol, Multiplier: 0, Prize: 0, Bonus: false };
}

export function createEmptyLinesSlotBonusSpin(reelCount: number): LinesSlotBonusSpin {
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
