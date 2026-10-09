/**
 * FlowState Variable Extractor
 * 
 * Explicitly defines which GameModel properties to expose to the FlowState editor
 * with their correct types. This avoids reflection which would include methods,
 * inherited properties, and other unwanted data.
 */

import { gameModel } from "../../models/game-model";

export type FlowstateVariableType = 'number' | 'string' | 'boolean' | 'number[]' | 'boolean[]' | 'object';

export interface IFlowstateVariable {
    name: string;
    type: FlowstateVariableType;
    description?: string;
    readOnly?: boolean;
}

/**
 * Defines the GameModel properties exposed to the FlowState editor.
 * Add or remove properties here to control what the editor can access.
 */
export const gameModelVariables: IFlowstateVariable[] = [
    { name: "payout", type: 'number' },
    { name: "isNewPlayer", type: 'boolean' },
    { name: "playMode", type: 'string' },
    { name: "isComplete", type: 'boolean' },
    { name: "hasBonus", type: 'boolean' },
    { name: "gameId", type: 'number' },
    { name: "isInProgress", type: 'boolean' },
    { name: "isInBonusRound", type: 'boolean' },
    { name: "freeSpinsRemaining", type: 'number' },
    { name: "isFreeSpinning", type: 'boolean' },
    { name: "currentBonusSpin", type: 'number' },
    { name: "isInJackpot", type: 'boolean' },
    { name: "winner", type: 'boolean' },
    { name: "totalGamePayout", type: 'number' },
    { name: "totalBonusPayout", type: 'number' },
    { name: "mainGamePayout", type: 'number' },
    { name: "currentBonusSpinPayout", type: 'number' },
    { name: "winAmountSoFar", type: 'number' },
    { name: "reelStoppingPositions", type: 'number[]' },
    { name: "isWildReel", type: 'boolean[]' },
    { name: "shouldReelSlowDown", type: 'boolean[]' },
    { name: "dummyMessage", type: 'object' },
    { name: "additionalBeginData", type: 'object' },
    { name: "engineGameId", type: 'number' },
    { name: "realGame", type: 'object' },
    { name: "reelSymbols", type: 'object' },
    { name: "steps", type: 'object' },
    { name: "step", type: 'object' },
    { name: "hotspot", type: 'object' },
    { name: "teaseBonus", type: 'boolean' },
    { name: "roundInfo", type: 'object' },
    { name: "bonusSpin", type: 'object' },
    { name: "bonusTutorialSeen", type: 'boolean' },
    { name: "tutorialSeen", type: 'boolean' },
    { name: "teaseHintCount", type: 'number' },
    { name: "persistHintCount", type: 'number' },
    { name: "splitHintCount", type: 'number' },
    { name: "roundBusy", type: 'boolean' },
    { name: "inBonus", type: 'boolean' },
    { name: "bonusSpinsTotal", type: 'number' },
    { name: "bonusSpinsPlayed", type: 'number' },
    { name: "waysShown", type: 'number' },
    { name: "stepIndex", type: 'number' },
];

/**
 * Get the current value of a GameModel variable
 */
export function getVariableValue(name: string): unknown {
    if (name in gameModel) {
        return (gameModel as any)[name];
    }
    return undefined;
}

/**
 * Set the value of a GameModel variable (if not read-only)
 */
export function setVariableValue(name: string, value: unknown): boolean {
    const varDef = gameModelVariables.find(v => v.name === name);
    
    if (!varDef) {
        console.warn(`[FlowState] Variable not found: ${name}`);
        return false;
    }
    
    if (varDef.readOnly) {
        console.warn(`[FlowState] Variable is read-only: ${name}`);
        return false;
    }
    
    if (name in gameModel) {
        (gameModel as any)[name] = value;
        return true;
    }
    
    return false;
}

/**
 * Get all variables with their current values for the editor
 */
export function getVariablesSnapshot(): Array<IFlowstateVariable & { value: unknown }> {
    return gameModelVariables.map(variable => ({
        ...variable,
        value: getVariableValue(variable.name)
    }));
}

/**
 * Get variable definitions for the editor (without values)
 */
export function getVariableDefinitions(): IFlowstateVariable[] {
    return [...gameModelVariables];
}
