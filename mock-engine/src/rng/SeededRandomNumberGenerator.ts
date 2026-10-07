// MOCK: no C# counterpart. The real engine ships CryptoRandomNumberGenerator and a gRPC-backed
// generator, neither of which can replay a run. Determinism is the single most valuable property for
// prototyping: the same seed produces the same game, every time, on every machine.

import { IRandomNumberGenerator } from '../core/interfaces';

/** 2^32 — the size of the raw draw, used for rejection sampling. */
export const UINT32_RANGE = 0x100000000;

export const DEFAULT_RNG_SEED = 0x5eed;

export class SeededRandomNumberGenerator implements IRandomNumberGenerator {
    private currentSeed: number;
    private state: number;

    constructor(seed: number = DEFAULT_RNG_SEED) {
        this.currentSeed = seed >>> 0;
        this.state = this.currentSeed;
    }

    get seed(): number {
        return this.currentSeed;
    }

    /** Restarts the stream so a prototype run can be replayed exactly. */
    reseed(seed: number): void {
        this.currentSeed = seed >>> 0;
        this.state = this.currentSeed;
    }

    /** mulberry32 — 32 bits of state, one multiply-xorshift round, no dependency. */
    nextUInt32(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (t ^ (t >>> 14)) >>> 0;
    }

    nextFloat(): number {
        return this.nextUInt32() / UINT32_RANGE;
    }

    /** Synchronous core of getInt32; rejection-sampled so a non-power-of-two bound stays uniform. */
    nextInt32(maxValue: number): number {
        assertPositiveBound(maxValue);
        const limit = UINT32_RANGE - (UINT32_RANGE % maxValue);
        let draw = this.nextUInt32();
        while (draw >= limit) draw = this.nextUInt32();
        return draw % maxValue;
    }

    nextInt32InRange(minValue: number, maxValue: number): number {
        return minValue + this.nextInt32(assertRange(minValue, maxValue));
    }

    getInt32(maxValue: number): Promise<number> {
        return Promise.resolve(this.nextInt32(maxValue));
    }

    getInt32Range(minValue: number, maxValue: number, count: number): Promise<number[]> {
        const result: number[] = [];
        for (let i = 0; i < count; i++) result.push(this.nextInt32InRange(minValue, maxValue));
        return Promise.resolve(result);
    }
}

export function assertPositiveBound(maxValue: number): void {
    if (!Number.isInteger(maxValue) || maxValue <= 0) throw new RangeError(`maxValue must be a positive integer, got ${maxValue}`);
}

export function assertRange(minValue: number, maxValue: number): number {
    if (!Number.isInteger(minValue)) throw new RangeError(`minValue must be an integer, got ${minValue}`);
    if (maxValue <= minValue) throw new RangeError(`maxValue (${maxValue}) must be greater than minValue (${minValue})`);
    return maxValue - minValue;
}
