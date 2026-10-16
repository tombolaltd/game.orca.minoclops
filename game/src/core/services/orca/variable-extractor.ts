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
    { name: "engineGameId", type: 'number' },
    { name: "realGame", type: 'object' },
    { name: "payout", type: 'number' },
    { name: "isNewPlayer", type: 'boolean' },
    { name: "playMode", type: 'string' },
    { name: "isComplete", type: 'boolean' },
    { name: "hasBonus", type: 'boolean' },
    { name: "gameId", type: 'number' },
    { name: "isInProgress", type: 'boolean' },
    { name: "additionalBeginData", type: 'object' },
    { name: "gameid", type: 'number' },
    { name: "gameComplete", type: 'boolean' },
    { name: "stake", type: 'number' },
    { name: "skin", type: 'string' },
    { name: "arcadeGameType", type: 'string' },
    { name: "bonus", type: 'boolean' },
    { name: "cascadeCount", type: 'number' },
    { name: "initialBonusSpins", type: 'number' },
    { name: "currentBonusSpin", type: 'number' },
    { name: "currentBonus", type: 'object' },
    { name: "currentBonusSpinPayout", type: 'number' },
    { name: "bonusSpinsRemaining", type: 'number' },
    { name: "totalBonusPayout", type: 'number' },
    { name: "isInBonusRound", type: 'boolean' },
    { name: "bonusOnResume", type: 'boolean' },
    { name: "unplayedSpinOutcomes", type: 'object' },
    { name: "playedSpinOutcomes", type: 'object' },
    { name: "winner", type: 'boolean' },
    { name: "bonusRound", type: 'object' },
    { name: "scatterResult", type: 'object' },
    { name: "splitSymbolDetails", type: 'object' },
    { name: "roundBusy", type: 'boolean' },
    { name: "bonusSpinsTotal", type: 'number' },
    { name: "bonusSpinsPlayed", type: 'number' },
    { name: "waysShown", type: 'number' },
    { name: "stepIndex", type: 'number' },
    { name: "isInJackpot", type: 'boolean' },
    { name: "mainGamePayout", type: 'number' },
    { name: "isWildReel", type: 'boolean[]' },
    { name: "shouldReelSlowDown", type: 'boolean[]' },
    { name: "displayReels", type: 'object' },
    { name: "bonusTutorialSeen", type: 'boolean' },
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
