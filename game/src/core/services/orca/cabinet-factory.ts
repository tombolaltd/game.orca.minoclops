import { BaseCabinet, ICasinoCabinetOptions } from '@game-studio/arcade-base';

import * as activeSkinExports from './active-skin';
import { EmptyCabinet } from './empty-cabinet';
import { OrcaCasinoCabinet } from './orca-casino-cabinet';

export type OrcaCabinetMode = 'standard' | 'none' | 'casino';

// Namespace read so an active-skin.ts generated before CABINET_MODE existed still compiles.
export function getOrcaCabinetMode(): OrcaCabinetMode {
    const mode = (activeSkinExports as unknown as { CABINET_MODE?: unknown }).CABINET_MODE;
    return mode === 'none' || mode === 'casino' ? mode : 'standard';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// Namespace read so an active-skin.ts generated before CABINET_OPTIONS existed still compiles.
export function getOrcaCabinetOptions(): ICasinoCabinetOptions {
    const options = (activeSkinExports as unknown as { CABINET_OPTIONS?: unknown }).CABINET_OPTIONS;
    return isPlainObject(options) ? (options as ICasinoCabinetOptions) : {};
}

function mergeShallow<T>(base: T | undefined, over: T): T {
    return isPlainObject(base) && isPlainObject(over) ? ({ ...base, ...over } as T) : over;
}

/**
 * Project settings first, then `overrides` (bindings.ts) win per top-level key. Not arcade-base
 * `deepMerge`: it throws merging an object over a truthy primitive (`canSingleReveal: true`).
 */
export function mergeOrcaCabinetOptions(project: ICasinoCabinetOptions, overrides: ICasinoCabinetOptions): ICasinoCabinetOptions {
    const merged: ICasinoCabinetOptions = { ...project };
    for (const key of Object.keys(overrides) as Array<keyof ICasinoCabinetOptions>) {
        const value = overrides[key];
        if (value === undefined) continue;
        if (key === 'floatingLayoutOptions' || key === 'revealMode') {
            (merged as Record<string, unknown>)[key] = mergeShallow(project[key], value);
        } else if (key === 'chipSelectorConfig') {
            const chip = mergeShallow(project.chipSelectorConfig, overrides.chipSelectorConfig!);
            // Keep the project's complete targetScales under a partial override.
            const scales = mergeShallow(project.chipSelectorConfig?.targetScales, chip.targetScales);
            if (scales !== undefined) chip.targetScales = scales;
            merged.chipSelectorConfig = chip;
        } else {
            (merged as Record<string, unknown>)[key] = value;
        }
    }
    return merged;
}

/** Builds the cabinet chosen in Orca's Project Settings ▸ Cabinet. */
export function createOrcaCabinet(options: ICasinoCabinetOptions): BaseCabinet {
    const mode = getOrcaCabinetMode();
    const merged = mergeOrcaCabinetOptions(getOrcaCabinetOptions(), options);
    if (mode === 'casino') return new OrcaCasinoCabinet(merged);
    const baseOptions: ICasinoCabinetOptions = { ...merged };
    delete baseOptions.chipSelectorConfig;
    delete baseOptions.showChipSelector;
    return mode === 'none' ? new EmptyCabinet(baseOptions) : new BaseCabinet(baseOptions);
}
