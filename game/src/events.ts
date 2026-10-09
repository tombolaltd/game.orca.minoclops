import EventEmitter from 'eventemitter3';

/**
 * Game-specific events emitted by FlowState method nodes and game code.
 *
 * The pre-declared keys cover the events fired by the bundled FlowState
 * `game-state` method node. The string index signature keeps the emitter
 * permissive so the FlowState graph editor can wire ad-hoc events from new
 * method nodes without forcing every game to predeclare them up front.
 *
 * Add typed entries below as your game grows for better inference at
 * `gameEventEmitter.on('MY_EVENT', ...)` call sites.
 *
 * The general event emitter for arcade-base shared events is imported
 * separately via `import { eventEmitter } from '@game-studio/arcade-base'`.
 */
export interface IGameSpecificEvents {
    // FlowState built-in game-state events (see core/services/orca/methods/game-state.ts)
    GAME_ON_BONUS_TRIGGERED: () => void;
    GAME_ON_BONUS_ENDED: () => void;
    GAME_ON_COMPLETE: () => void;
    GAME_START_SPIN: () => void;
    GAME_SHOW_WINS: () => void;
    GAME_TEASE_REEL: (reelIndex: number) => void;
    GAME_MAKE_REEL_WILD: (reelIndex: number) => void;
    GAME_SHOW_PRIZE: (amount: number) => void;
    // Permissive index signature for ad-hoc events fired from the FlowState editor.
    [eventName: string]: (...args: any[]) => void;
}

export class GameEventEmitter extends EventEmitter<IGameSpecificEvents> {}
export const gameEventEmitter = new GameEventEmitter();

/* Example: define typed events for your game and bonus
export interface IGameEvents {
    GAME_ON_SPIN_END: () => void;
}
export interface IBonusEvents {
    BONUS_ON_CARD_REVEALED: (symbol: number) => void;
}
*/


