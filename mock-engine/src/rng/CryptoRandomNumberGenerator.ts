// Ported from Libraries/Tombola.B2B.Arcade/RandomNumberGenerators/CryptoRandomNumberGenerator.cs

import { IRandomNumberGenerator } from '../core/interfaces';
import { assertPositiveBound, assertRange, SeededRandomNumberGenerator, UINT32_RANGE } from './SeededRandomNumberGenerator';

type GetRandomValues = (buffer: Uint32Array) => void;

// MOCK: WebCrypto is feature-detected, never assumed — the mock has to boot in Electron main and in a bundle.
function detectGetRandomValues(): GetRandomValues | undefined {
    const host = globalThis as unknown as { crypto?: { getRandomValues?: unknown } };
    const webCrypto = host.crypto;
    if (webCrypto == null || typeof webCrypto.getRandomValues !== 'function') return undefined;

    const fill = webCrypto.getRandomValues as (buffer: Uint32Array) => unknown;
    return buffer => {
        fill.call(webCrypto, buffer);
    };
}

export class CryptoRandomNumberGenerator implements IRandomNumberGenerator {
    private readonly getRandomValues: GetRandomValues | undefined;
    private readonly fallback: SeededRandomNumberGenerator;
    private readonly buffer = new Uint32Array(1);

    // MOCK: the C# ctor prints a [RNG-CERT] platform trace. There is nothing to certify here, so it is dropped.
    constructor(fallbackSeed?: number) {
        this.getRandomValues = detectGetRandomValues();
        this.fallback = new SeededRandomNumberGenerator(fallbackSeed);
    }

    /** False when the host exposes no WebCrypto and every draw comes from the seeded fallback. */
    get isCryptographic(): boolean {
        return this.getRandomValues !== undefined;
    }

    nextInt32(maxValue: number): number {
        if (this.getRandomValues === undefined) return this.fallback.nextInt32(maxValue);

        assertPositiveBound(maxValue);
        const limit = UINT32_RANGE - (UINT32_RANGE % maxValue);
        do {
            this.getRandomValues(this.buffer);
        } while (this.buffer[0] >= limit);
        return this.buffer[0] % maxValue;
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
