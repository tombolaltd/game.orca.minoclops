// MOCK: no C# counterpart. The real engine's simulation client is a separate service; this is
// the prototyping equivalent — a bounded, in-process RTP run over the SAME request pipeline the
// HTTP surface uses.
//
// ⚠️ IT MEASURES A PROTOTYPE. Nothing here certifies anything. The mock is not RNG-certified and
// not audited, and a few thousand rounds is a smoke test of the maths, not a compliance run.
//
// ── One pipeline, deliberately ──────────────────────────────────────────────────────────────
// The reference harness this is modelled on shipped a standalone simulator that re-implemented
// its own copies of the spin/bonus maths; the two drifted ~3.7 % apart on RTP before they were
// merged onto one path. So this drives `MockEngine.begin` / `MockEngine.continue` and reads the
// wire envelope back. There is no second implementation of anything to drift from.
//
// ── What it catches ─────────────────────────────────────────────────────────────────────────
// An agent-GENERATED mechanic is transpiled without type checking and validated by a single
// `begin`, which only proves it does not crash. A bounded run additionally exposes the three
// failure modes that actually show up: a payout path that fills state but never pays (RTP
// collapses), a config field declared but never rolled (a feature's count stays at zero), and
// an ungated `Math.random()` (two runs at one seed disagree).

import { ArcadeResultCode } from '../core/ArcadeResultCode';
import { BaseArcadeResponse } from '../core/models/BaseArcadeResponse';
import { GameMessage } from '../core/models/GameMessage';
import { MockArcadeRequest, MockEngine } from '../MockEngine';
import { GameTypeRegistry } from '../registry/GameTypeRegistry';
import { RandomHelpers } from '../rng/RandomHelpers';
import { DEFAULT_RNG_SEED } from '../rng/SeededRandomNumberGenerator';
import { InMemoryGameStorageHandler, StoredGame } from '../storage/InMemoryGameStorageHandler';

export interface MechanicSimulationOptions {
    /** Catalog key, e.g. `lines-slot`. Used for reporting, and as a game-name fallback. */
    mechanic: string;
    /** The `{game}` segment to drive. Defaults to whatever `mechanic` resolves to in the registry. */
    skin?: string;
    /** Rounds to play. Clamped to [1, {@link SIM_MAX_SPINS}]. */
    spins?: number;
    seed?: number;
    /** Integer minor units. Omitted ⇒ the engine's own lowest stake option. */
    stake?: number;
    currencyCode?: string;
    /** Wall-clock ceiling. Clamped to [100, {@link SIM_MAX_DURATION_MS}]. */
    maxDurationMs?: number;
    /** Bonus-drain guard. Clamped to [1, {@link SIM_MAX_CONTINUES_PER_ROUND}]. */
    maxContinuesPerRound?: number;
}

export interface MechanicSimulationResult {
    mechanic: string;
    /** The `{game}` segment actually driven. */
    game: string;
    requestedSpins: number;
    /** Rounds that completed and were scored. */
    spins: number;
    seed: number;
    /** Minor units staked per round, read back off the first settled round. */
    stake: number;
    totalStake: number;
    totalPayout: number;
    /** `totalPayout / totalStake`. 0 when nothing was staked. */
    rtp: number;
    /** `GameSettings.Rtp` the mechanic declares, as a percentage. 0 when it declares none. */
    declaredRtp: number;
    hitCount: number;
    hitFrequency: number;
    /** Largest single-round payout in stake multiples. */
    maxSinglePayX: number;
    /** Rounds whose begin left a bonus round open. */
    bonusCount: number;
    bonusFrequency: number;
    continueCalls: number;
    failedRounds: number;
    payoutHistogram: { [bucket: string]: number };
    /** Bounded sample of DISTINCT failure reasons. */
    errors: string[];
    truncated: boolean;
    truncatedReason: string;
    elapsedMs: number;
}

/** What the `POST /sim` route answers with. It never throws, so the failure is in-band. */
export interface MechanicSimulationEnvelope {
    ok: boolean;
    result?: MechanicSimulationResult;
    error?: string;
}

export const SIM_DEFAULT_SPINS = 2000;
export const SIM_MAX_SPINS = 200000;
export const SIM_DEFAULT_MAX_DURATION_MS = 15000;
export const SIM_MAX_DURATION_MS = 120000;
export const SIM_MAX_CONTINUES_PER_ROUND = 500;

/** Consecutive failing rounds before the run gives up; a wedged mechanic must not grind on. */
const SIM_MAX_CONSECUTIVE_FAILURES = 25;
/** Distinct failure reasons retained. The rest are counted, not stored. */
const SIM_MAX_ERRORS = 5;
/** Rounds between wallet/storage truncations; keeps a long run's memory flat. */
const SIM_PRUNE_INTERVAL_ROUNDS = 512;
/** Rounds between wall-clock checks. */
const SIM_CLOCK_CHECK_INTERVAL_ROUNDS = 128;

/** £1,000,000 in minor units. Notional: the run tops up rather than ever going dry. */
const SIM_TOP_UP_MINOR_UNITS = 100000000;
const SIM_WALLET_FLOOR_MINOR_UNITS = 1000000;

const HISTOGRAM_BUCKETS: ReadonlyArray<{ label: string; below: number }> = [
    { label: '<1x', below: 1 },
    { label: '1-5x', below: 5 },
    { label: '5-25x', below: 25 },
    { label: '25-100x', below: 100 },
    { label: '100-500x', below: 500 },
    { label: '500-2500x', below: 2500 },
];
const HISTOGRAM_ZERO_BUCKET = '0';
const HISTOGRAM_TOP_BUCKET = '2500x+';

/**
 * Play `spins` rounds at a fixed stake against a freshly built, isolated {@link MockEngine},
 * draining any bonus round through `continue` so the payout it accounts for is the whole round.
 *
 * Settings are NOT re-registered here: the mechanic's tuned settings live in its own per-skin
 * settings registry, which the host populates before it builds an engine, so a simulation
 * automatically measures the same maths the live routes serve.
 *
 * Throws only for an unusable request (no such mechanic). Per-round failures are collected into
 * the result, because a run that half-works is far more diagnostic than an exception.
 */
export async function runMechanicSimulation(options: MechanicSimulationOptions): Promise<MechanicSimulationResult> {
    const mechanic = String(options.mechanic ?? '').trim();
    if (mechanic.length === 0) throw new Error('A simulation needs a mechanic key');

    const game = resolveRegisteredGame(options.skin, mechanic);
    if (game === undefined) {
        const registered = GameTypeRegistry.availableGames;
        throw new Error(
            `No mechanic is registered as "${String(options.skin ?? mechanic)}" (registered: ${registered.length > 0 ? registered.join(', ') : 'none'})`,
        );
    }

    const requestedSpins = clampInteger(options.spins, SIM_DEFAULT_SPINS, 1, SIM_MAX_SPINS);
    const seed = Number.isFinite(options.seed) ? Math.trunc(options.seed as number) : DEFAULT_RNG_SEED;
    const maxDurationMs = clampInteger(options.maxDurationMs, SIM_DEFAULT_MAX_DURATION_MS, 100, SIM_MAX_DURATION_MS);
    const maxContinues = clampInteger(options.maxContinuesPerRound, SIM_MAX_CONTINUES_PER_ROUND, 1, SIM_MAX_CONTINUES_PER_ROUND);
    const requestedStake = Number.isFinite(options.stake) && (options.stake as number) > 0 ? Math.trunc(options.stake as number) : undefined;

    const result = createEmptyResult(mechanic, game, requestedSpins, seed);

    // RandomHelpers is a PROCESS-WIDE singleton and `new MockEngine(...)` reseats it, so without
    // this the host's live engine would silently inherit the simulation's generator for every
    // subsequent request. Captured before the engine is built, restored in `finally`.
    const liveGenerator = RandomHelpers.Generator;

    const startedAt = Date.now();
    try {
        const engine = new MockEngine({
            seed,
            currencyCode: options.currencyCode,
            startingBalance: SIM_TOP_UP_MINOR_UNITS,
            // Jackpots are a separate opt-in overlay, not mechanic maths; leaving them off keeps
            // the measured RTP attributable to the mechanic alone.
        });

        let consecutiveFailures = 0;
        for (let round = 0; round < requestedSpins; round++) {
            if (round % SIM_CLOCK_CHECK_INTERVAL_ROUNDS === 0 && Date.now() - startedAt >= maxDurationMs) {
                truncate(result, `the ${maxDurationMs} ms wall-clock ceiling was reached after ${result.spins} round(s)`);
                break;
            }
            if (round > 0 && round % SIM_PRUNE_INTERVAL_ROUNDS === 0) pruneEngineState(engine);

            topUpWallet(engine, result.stake || requestedStake || 0);

            const outcome = await playRound(engine, game, requestedStake, maxContinues);
            result.continueCalls += outcome.continues;

            if (outcome.failure !== undefined) {
                result.failedRounds += 1;
                recordError(result, outcome.failure);
                consecutiveFailures += 1;
                if (consecutiveFailures >= SIM_MAX_CONSECUTIVE_FAILURES) {
                    truncate(result, `${consecutiveFailures} consecutive rounds failed; the run was abandoned`);
                    break;
                }
                continue;
            }
            consecutiveFailures = 0;

            if (result.stake === 0) result.stake = outcome.stake;
            if (result.declaredRtp === 0 && outcome.declaredRtp > 0) result.declaredRtp = outcome.declaredRtp;

            result.spins += 1;
            result.totalStake += outcome.stake;
            result.totalPayout += outcome.payout;
            if (outcome.payout > 0) result.hitCount += 1;
            if (outcome.bonus) result.bonusCount += 1;

            const payX = outcome.stake > 0 ? outcome.payout / outcome.stake : 0;
            if (payX > result.maxSinglePayX) result.maxSinglePayX = payX;
            const bucket = bucketise(payX);
            result.payoutHistogram[bucket] = (result.payoutHistogram[bucket] ?? 0) + 1;
        }
    } finally {
        RandomHelpers.Reset();
        RandomHelpers.Initialise(liveGenerator);
    }

    result.elapsedMs = Date.now() - startedAt;
    result.rtp = result.totalStake > 0 ? result.totalPayout / result.totalStake : 0;
    result.hitFrequency = result.spins > 0 ? result.hitCount / result.spins : 0;
    result.bonusFrequency = result.spins > 0 ? result.bonusCount / result.spins : 0;
    return result;
}

interface RoundOutcome {
    failure?: string;
    stake: number;
    payout: number;
    bonus: boolean;
    continues: number;
    declaredRtp: number;
}

/**
 * One begin, plus however many continues it takes to settle. The round's payout is read off the
 * SETTLING response, mirroring `MockAwardPrizeHandler`: the engine credits `GameMessage.Payout`
 * exactly once, when `GameComplete` first turns true.
 */
async function playRound(engine: MockEngine, game: string, stake: number | undefined, maxContinues: number): Promise<RoundOutcome> {
    const outcome: RoundOutcome = { stake: 0, payout: 0, bonus: false, continues: 0, declaredRtp: 0 };

    const beginRequest: MockArcadeRequest = { game };
    if (stake !== undefined) beginRequest.Stake = stake;

    const begin = await engine.begin(beginRequest);
    const beginFailure = describeEnvelopeFailure(begin, 'begin');
    if (beginFailure !== undefined) return { ...outcome, failure: beginFailure };

    let message = begin.GameMessage as GameMessage | undefined;
    if (message === undefined) return { ...outcome, failure: 'begin returned no GameMessage' };

    outcome.stake = Number.isFinite(message.Stake) && message.Stake > 0 ? message.Stake : (stake ?? 0);
    outcome.declaredRtp = Number.isFinite(begin.GameSettings?.Rtp) ? Number(begin.GameSettings?.Rtp) : 0;
    outcome.bonus = message.GameComplete === false;

    while (message.GameComplete === false) {
        if (outcome.continues >= maxContinues) {
            return { ...outcome, failure: `a round did not settle within ${maxContinues} continue request(s)` };
        }
        const spin = outcome.continues + 1;
        const next = await engine.continue({
            game,
            GameId: message.GameId,
            // Both bundled slot mechanics spell the free-spin index differently; sending both keeps
            // one request shape working across every mechanic, as the HTTP client already does.
            BonusRoundData: { BonusSpin: spin, BonusSpins: spin },
        });
        outcome.continues += 1;

        const continueFailure = describeEnvelopeFailure(next, 'continue');
        if (continueFailure !== undefined) return { ...outcome, failure: continueFailure };

        const nextMessage = next.GameMessage as GameMessage | undefined;
        if (nextMessage === undefined) return { ...outcome, failure: 'continue returned no GameMessage' };
        message = nextMessage;
    }

    const payout = Number(message.Payout);
    if (!Number.isFinite(payout) || payout < 0) return { ...outcome, failure: `a round reported a non-numeric payout (${String(message.Payout)})` };
    if (outcome.stake <= 0) return { ...outcome, failure: 'a round settled with no stake, so it cannot be scored' };

    outcome.payout = payout;
    return outcome;
}

function describeEnvelopeFailure(response: BaseArcadeResponse, action: string): string | undefined {
    const code = response.ResultCode;
    if (code !== undefined && code !== null && code.ResultCode === ArcadeResultCode.Success.ResultCode) return undefined;
    const description = code?.Description ?? 'unknown error';
    return `${action} failed: ${description} (code ${code?.ResultCode ?? -1})`;
}

/**
 * Match a mechanic key or skin against the registry. The registry is already case-insensitive;
 * the second pass strips separators so `lines-slot` finds `LinesSlot` WITHOUT re-implementing the
 * mechanic→skin naming convention here (which lives in each mechanic's own `register.ts`).
 */
function resolveRegisteredGame(...candidates: Array<string | undefined>): string | undefined {
    const available = GameTypeRegistry.availableGames;
    for (const candidate of candidates) {
        const trimmed = String(candidate ?? '').trim();
        if (trimmed.length === 0) continue;

        const exact = GameTypeRegistry.tryGet(trimmed);
        if (exact !== undefined) return exact.game;

        const key = normaliseGameKey(trimmed);
        if (key.length === 0) continue;
        for (const name of available) if (normaliseGameKey(name) === key) return name;
    }
    return undefined;
}

function normaliseGameKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A simulation must never end early because the notional wallet ran dry. */
function topUpWallet(engine: MockEngine, stake: number): void {
    const floor = Math.max(SIM_WALLET_FLOOR_MINOR_UNITS, stake * 100);
    if (engine.wallet.balance >= floor) return;
    engine.wallet.balance += SIM_TOP_UP_MINOR_UNITS;
}

/**
 * The ledger, transaction log and stored-game map each grow by a few entries per round and
 * nothing in a long run reads them back, so they are truncated at round boundaries. Only ever
 * called between settled rounds, never mid-bonus.
 */
function pruneEngineState(engine: MockEngine): void {
    engine.wallet.ledger.length = 0;
    const storage = engine.storageHandler;
    if (storage instanceof InMemoryGameStorageHandler) {
        // Each player's MOST RECENT game survives the prune: a stateful mechanic (cash-collector's
        // unlock meter) reads the player's progression off it, and clearing it would silently reset
        // every simulated player to their starting state every few hundred rounds.
        const latest = new Map<number, StoredGame>();
        for (const stored of storage.games.values()) {
            const previous = latest.get(stored.gsUserId);
            if (previous === undefined || stored.startStamp >= previous.startStamp) latest.set(stored.gsUserId, stored);
        }
        storage.games.clear();
        for (const stored of latest.values()) storage.games.set(stored.gameId, stored);
        storage.transactionLog.length = 0;
    }
}

function createEmptyResult(mechanic: string, game: string, requestedSpins: number, seed: number): MechanicSimulationResult {
    return {
        mechanic,
        game,
        requestedSpins,
        spins: 0,
        seed,
        stake: 0,
        totalStake: 0,
        totalPayout: 0,
        rtp: 0,
        declaredRtp: 0,
        hitCount: 0,
        hitFrequency: 0,
        maxSinglePayX: 0,
        bonusCount: 0,
        bonusFrequency: 0,
        continueCalls: 0,
        failedRounds: 0,
        payoutHistogram: {},
        errors: [],
        truncated: false,
        truncatedReason: '',
        elapsedMs: 0,
    };
}

function truncate(result: MechanicSimulationResult, reason: string): void {
    if (result.truncated) return;
    result.truncated = true;
    result.truncatedReason = reason;
}

function recordError(result: MechanicSimulationResult, reason: string): void {
    if (result.errors.length >= SIM_MAX_ERRORS || result.errors.indexOf(reason) !== -1) return;
    result.errors.push(reason);
}

function bucketise(payX: number): string {
    if (!(payX > 0)) return HISTOGRAM_ZERO_BUCKET;
    for (const bucket of HISTOGRAM_BUCKETS) if (payX < bucket.below) return bucket.label;
    return HISTOGRAM_TOP_BUCKET;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value as number)));
}
