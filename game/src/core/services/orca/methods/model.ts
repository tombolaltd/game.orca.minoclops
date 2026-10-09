/**
 * Model property access methods
 * These methods provide read/write access to game and settings model properties
 * Method names match the flowstate node titles for automatic lookup
 */

import { gameModel as gameModelInstance } from '@/src/core/models/game-model';
import { gameSettings as gameSettingsInstance } from '@/src/core/models/game-settings';

/**
 * Get a property value from the game model
 */
export function getGameModelProperty(propertyName: keyof typeof gameModelInstance): any {
    if (propertyName in gameModelInstance) {
        return gameModelInstance[propertyName];
    }
    console.warn(`[GameModel] Property '${String(propertyName)}' not found`);
    return undefined;
}

/**
 * Set a property value on the game model
 */
export function setGameModelProperty<K extends keyof typeof gameModelInstance>(
    propertyName: K, 
    value: typeof gameModelInstance[K]
): void {
    if (propertyName in gameModelInstance) {
        (gameModelInstance as any)[propertyName] = value;
    } else {
        console.warn(`[GameModel] Property '${String(propertyName)}' not found`);
    }
}

/**
 * Get a property value from the settings model
 */
export function getSettingsModelProperty(propertyName: keyof typeof gameSettingsInstance): any {
    if (propertyName in gameSettingsInstance) {
        return gameSettingsInstance[propertyName];
    }
    console.warn(`[SettingsModel] Property '${String(propertyName)}' not found`);
    return undefined;
}

/**
 * Set a property value on the settings model
 */
export function setSettingsModelProperty<K extends keyof typeof gameSettingsInstance>(
    propertyName: K, 
    value: typeof gameSettingsInstance[K]
): void {
    if (propertyName in gameSettingsInstance) {
        (gameSettingsInstance as any)[propertyName] = value;
    } else {
        console.warn(`[SettingsModel] Property '${String(propertyName)}' not found`);
    }
}
