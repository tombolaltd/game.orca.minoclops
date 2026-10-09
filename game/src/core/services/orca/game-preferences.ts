import { eventEmitter, userPreferences } from '@game-studio/arcade-base';
import { ACTIVE_SKIN_NAME } from './active-skin';
import { ORCA_GAME_PREFERENCES, OrcaGamePreferenceEntry } from './generated-game-preferences';

/**
 * Custom game preferences authored in the Orca editor, mirrored into
 * `./generated-game-preferences.ts` (auto-generated — never hand-edit).
 *
 * main.ts feeds `getOrcaGamePreferences()` into `GamePreferences` (storage) and
 * `getOrcaAdditionalSettings()` into `AdditionalSettingsGetter` (settings-menu
 * UI). A menu click writes storage and calls the item's `onClick` but emits no
 * arcade-base event, so `onClick` re-emits `ORCA_GAME_PREFERENCE_CHANGED`.
 *
 * Imported by main.ts: must never import flowstate / scene-manager / methods,
 * and every imported binding is only read inside a function.
 */

export const ORCA_GAME_PREFERENCE_CHANGED = 'ORCA_GAME_PREFERENCE_CHANGED';

export interface OrcaGamePreferenceChange {
    key: string;
    value: boolean | number;
}

// Loose view of arcade-base's `userPreferences` so an upstream signature drift can't fail the build.
interface LooseUserPreferences {
    getGamePref(name: string): unknown;
    updateGamePref(name: string, value: string | number | boolean): void;
}

function prefs(): LooseUserPreferences | null {
    const candidate = userPreferences as unknown as LooseUserPreferences | undefined;
    return candidate && typeof candidate.getGamePref === 'function' ? candidate : null;
}

function isUsableEntry(entry: OrcaGamePreferenceEntry): boolean {
    if (!entry || typeof entry.key !== 'string' || !entry.key) return false;
    if (entry.kind === 'options') return Array.isArray(entry.options) && entry.options.length > 0;
    return entry.kind === 'checkbox' || entry.kind === 'button';
}

function defaultFor(entry: OrcaGamePreferenceEntry): boolean | number {
    if (entry.kind === 'options') {
        const value = entry.defaultValue;
        const known = typeof value === 'number' && entry.options.some((o) => o.value === value);
        return known ? (value as number) : entry.options[0].value;
    }
    return typeof entry.defaultValue === 'boolean' ? entry.defaultValue : true;
}

/** Entries that apply to the booting skin (`skins: []` = every skin). */
export function getActiveSkinGamePreferences(): OrcaGamePreferenceEntry[] {
    const all = Array.isArray(ORCA_GAME_PREFERENCES) ? ORCA_GAME_PREFERENCES : [];
    return all.filter((entry) => {
        if (!isUsableEntry(entry)) return false;
        const skins = Array.isArray(entry.skins) ? entry.skins : [];
        return skins.length === 0 || skins.includes(ACTIVE_SKIN_NAME);
    });
}

/** arcade-base `GamePreferences` config — storage-bearing entries only (buttons have none). */
export function getOrcaGamePreferences(): Record<string, { default: string | number | boolean }> {
    const out: Record<string, { default: string | number | boolean }> = {};
    for (const entry of getActiveSkinGamePreferences()) {
        if (entry.kind === 'button') continue;
        out[entry.key] = { default: defaultFor(entry) };
    }
    return out;
}

function emitChange(key: string, value: boolean | number): void {
    const payload: OrcaGamePreferenceChange = { key, value };
    eventEmitter.emit(ORCA_GAME_PREFERENCE_CHANGED as any, payload as any);
}

// The settings menu falls back to options[0] for a multi-checkbox, so persist the authored default first.
function seedOptionsDefault(key: string): void {
    const api = prefs();
    if (!api || typeof api.updateGamePref !== 'function') return;
    try {
        const current = api.getGamePref(key);
        if (typeof current === 'number' || typeof current === 'boolean' || typeof current === 'string') {
            api.updateGamePref(key, current);
        }
    } catch (err) {
        console.warn(`[GamePreferences] Could not seed default for "${key}"`, err);
    }
}

/** arcade-base `AdditionalSettingsGetter` items, one per active-skin entry. */
export function getOrcaAdditionalSettings(): any[] {
    const items: any[] = [];
    for (const entry of getActiveSkinGamePreferences()) {
        const key = entry.key;
        const name = typeof entry.label === 'string' && entry.label ? entry.label : key;
        // Sections are cosmetic in the pinned build (items group by type); 1 = links, 2 = toggles.
        if (entry.kind === 'checkbox') {
            items.push({
                sectionId: 2,
                index: items.length,
                item: {
                    type: 'checkbox',
                    name,
                    toggle: key,
                    default: defaultFor(entry) as boolean,
                    onClick: (val: boolean) => emitChange(key, val === true),
                },
            });
        } else if (entry.kind === 'options') {
            seedOptionsDefault(key);
            items.push({
                sectionId: 2,
                index: items.length,
                item: {
                    type: 'multi-checkbox',
                    name,
                    toggle: key,
                    options: entry.options.map((o) => ({ label: String(o.label), value: Number(o.value) })),
                    onClick: (val: number) => emitChange(key, Number(val)),
                },
            });
        } else {
            items.push({
                sectionId: 1,
                index: items.length,
                item: {
                    type: 'external-link',
                    name,
                    onClick: () => emitChange(key, true),
                },
            });
        }
    }
    return items;
}

function coerceStored(value: unknown): boolean | number | null {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (text === 'true') return true;
        if (text === 'false') return false;
        const parsed = Number(text);
        return text !== '' && Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** Stored value for a configured storage-bearing preference, else null (never throws). */
export function readOrcaGamePreference(key: string): boolean | number | null {
    if (typeof key !== 'string' || !key) return null;
    if (!Object.prototype.hasOwnProperty.call(getOrcaGamePreferences(), key)) return null;
    const api = prefs();
    if (!api) return null;
    try {
        return coerceStored(api.getGamePref(key));
    } catch (err) {
        return null;
    }
}

/** true iff the value is `true` or a non-zero number. */
export function toGamePreferenceChecked(value: unknown): boolean {
    return value === true || (typeof value === 'number' && Number.isFinite(value) && value !== 0);
}

/** The value as a number (booleans → 1/0), or null when it isn't one. */
export function toGamePreferenceNumber(value: unknown): number | null {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return null;
}
