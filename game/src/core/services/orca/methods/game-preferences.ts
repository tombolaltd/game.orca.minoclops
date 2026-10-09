import { readOrcaGamePreference, toGamePreferenceChecked, toGamePreferenceNumber } from "../game-preferences";

/**
 * Game Preference Methods for FlowState
 *
 * Read the player's current value of a custom game preference authored in the
 * Orca editor (Project Settings) and exposed in the in-game settings menu.
 * Unknown / unconfigured / button preferences read as unchecked / 0.
 */

/** Preferences already warned about — one console line per key, ever. */
const warnedUnknownKeys = new Set<string>();

class GamePreferenceMethods {
    private warnUnknownOnce(preference: string): void {
        if (warnedUnknownKeys.has(preference)) return;
        warnedUnknownKeys.add(preference);
        console.warn(`[GamePreferences] No stored value for preference "${preference}" on this skin — reading 0.`);
    }

    /**
     * Whether a preference is switched on.
     * @param preference the authored preference key
     * @returns true when the value is `true` or a non-zero number
     */
    public getGamePreferenceChecked(preference: string): boolean {
        return toGamePreferenceChecked(readOrcaGamePreference(preference));
    }

    /**
     * A preference's value as a number (booleans read as 1 / 0).
     * @param preference the authored preference key
     * @returns the stored value, or 0 when it is unknown
     */
    public getGamePreferenceValue(preference: string): number {
        const value = toGamePreferenceNumber(readOrcaGamePreference(preference));
        if (value !== null) return value;
        this.warnUnknownOnce(typeof preference === 'string' ? preference : String(preference));
        return 0;
    }
}

export const gamePreferences = new GamePreferenceMethods();
