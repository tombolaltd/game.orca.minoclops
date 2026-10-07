// Ported from Libraries/Tombola.B2B.Arcade/RandomHelpers/RandomHelpers.cs
// The C# PascalCase method names are kept verbatim so ported game maths reads identically.

import { IRandomNumberGenerator } from '../core/interfaces';
import { SeededRandomNumberGenerator } from './SeededRandomNumberGenerator';

export class RandomHelpers {
    private static generator: IRandomNumberGenerator | undefined;
    private static explicitlyInitialised = false;

    static Initialise(generator: IRandomNumberGenerator): void {
        if (RandomHelpers.explicitlyInitialised) throw new Error('RandomHelpers has already been initialised');
        if (generator == null) throw new Error('generator is required');

        RandomHelpers.generator = generator;
        RandomHelpers.explicitlyInitialised = true;
    }

    // MOCK: the C# throws when uninitialised. A generated game must work with no wiring, so an
    // uninitialised mock lazily falls back to a seeded generator instead.
    static get Generator(): IRandomNumberGenerator {
        if (RandomHelpers.generator === undefined) RandomHelpers.generator = new SeededRandomNumberGenerator();
        return RandomHelpers.generator;
    }

    /** MOCK: not in the C#; lets a prototype swap or reseed the generator between replays. */
    static Reset(): void {
        RandomHelpers.generator = undefined;
        RandomHelpers.explicitlyInitialised = false;
    }

    static GetRandomValueAsync(maxValue: number): Promise<number> {
        return RandomHelpers.Generator.getInt32(maxValue);
    }

    /** maxIndex is INCLUSIVE, matching the C# call through to GetInt32(0, maxIndex + 1, count). */
    static GetRandomValuesAsync(maxIndex: number, count: number): Promise<number[]> {
        return RandomHelpers.Generator.getInt32Range(0, maxIndex + 1, count);
    }

    /** Fisher-Yates; shuffles in place and returns the same list, as the C# does. */
    static async GetShuffledListAsync<T>(list: T[]): Promise<T[]> {
        for (let i = list.length - 1; i > 0; i--) {
            const j = await RandomHelpers.Generator.getInt32(i + 1);
            const swap = list[i];
            list[i] = list[j];
            list[j] = swap;
        }
        return list;
    }

    // MOCK: the four helpers below are NOT in RandomHelpers.cs. The real engine receives weighted
    // picks and reel stops pre-drawn from the certified RNG service, which the mock has to stand in for.

    /** Picks an index in proportion to integer weights. */
    static async GetWeightedIndexAsync(weights: readonly number[]): Promise<number> {
        let total = 0;
        for (const weight of weights) {
            if (!Number.isInteger(weight) || weight < 0) throw new RangeError(`Weights must be non-negative integers, got ${weight}`);
            total += weight;
        }
        if (total <= 0) throw new RangeError('Weights must sum to a positive total');

        let draw = await RandomHelpers.Generator.getInt32(total);
        for (let i = 0; i < weights.length; i++) {
            draw -= weights[i];
            if (draw < 0) return i;
        }
        return weights.length - 1;
    }

    static async GetWeightedValueAsync<T>(items: readonly T[], weights: readonly number[]): Promise<T> {
        if (items.length !== weights.length) throw new RangeError(`items (${items.length}) and weights (${weights.length}) must be the same length`);
        return items[await RandomHelpers.GetWeightedIndexAsync(weights)];
    }

    /** One stop per reel, each in [0, reelLength). */
    static async GetReelPositionsAsync(reelLengths: readonly number[]): Promise<number[]> {
        const positions: number[] = [];
        for (const length of reelLengths) positions.push(await RandomHelpers.Generator.getInt32(length));
        return positions;
    }

    /** count distinct values drawn from [0, maxIndex]; used for keno/pick style draws. */
    static async GetDistinctValuesAsync(maxIndex: number, count: number): Promise<number[]> {
        const pool: number[] = [];
        for (let i = 0; i <= maxIndex; i++) pool.push(i);
        if (count > pool.length) throw new RangeError(`Cannot draw ${count} distinct values from ${pool.length}`);

        await RandomHelpers.GetShuffledListAsync(pool);
        return pool.slice(0, count);
    }
}
