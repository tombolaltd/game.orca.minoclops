import { container } from "@game-studio/arcade-base";
import {
    ORCA_AUDIO_BUSES,
    ORCA_AUDIO_MASTER_BUS,
    OrcaAudioBus,
} from "../generated-audio-mixer";

/**
 * Orca Audio Mixer — runtime bus engine for FlowState audio.
 *
 * Owns the LIVE copy of the authored bus tree (seeded from the auto-generated
 * `generated-audio-mixer.ts`) plus the transient per-voice bookkeeping that the
 * bus faders, voice limits and ducking need.
 *
 * Why module state lives here
 * ---------------------------
 * The FlowState walker is deliberately stateless (see AGENTS.md rule 17 — the
 * only per-walk state is `loopState` and `starterArgs`). Long-lived audio state
 * therefore belongs to the METHOD module, exactly like the audio path/dedup
 * registry in `methods/audio.ts`.
 *
 * Gain authority
 * --------------
 * `container.soundManager` stays the SINGLE authority for gain — every bus
 * fader is folded into a per-instance volume via `effectiveGain()` and applied
 * with the group controller's `fade(id, ...)`. We never reach past it to
 * howler's own globals (`Howler.volume` / `Howler.mute`), because the
 * sound-manager owns visibility auto-pause, iOS unlock and its own
 * `Map<id, ITrack>` bookkeeping, and a global override would silently disagree
 * with it.
 *
 * Failure policy
 * --------------
 * Every method warns and no-ops on failure. A FlowState node must never throw.
 */

/**
 * Hard cap on parent-chain walks. Main-process normalization already guarantees
 * an acyclic tree with resolvable parents; this is a pure defensive backstop.
 */
const MAX_BUS_DEPTH = 32;

/** Duck-ramp step interval (ms). ~20 steps/sec is ample for a gain ramp. */
const RAMP_STEP_MS = 50;

/** Playback-rate clamp shared by bus pitch and per-sound pitch. */
const MIN_RATE = 0.25;
const MAX_RATE = 4;

/** A live, tracked audio instance routed through a bus. */
export interface OrcaVoice {
    /** Numeric instance id handed back by the group controller's `play()`. */
    id: number;
    /** Bus this voice is routed through. */
    busId: string;
    /** Which `container.soundManager` group controller owns the instance. */
    group: 'sfx' | 'music';
    /** Registered sound-manager alias (also the asset path for path-like refs). */
    alias: string;
    /** Author-requested volume BEFORE bus gain is folded in. */
    baseVolume: number;
    /** Author-requested pitch BEFORE bus pitch is folded in. */
    basePitch: number;
    /** `Date.now()` at registration — drives `'oldest'` voice stealing. */
    startedAt: number;
    /**
     * The raw `play()` return when it was object-shaped (a `SoundInstance`-like
     * handle). The id-based group-controller API has no per-instance rate/loop
     * setter, so those two effects are best-effort via this handle and simply
     * no-op when the controller hands back a bare numeric id.
     */
    instance: unknown;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Live, mutable bus tree. Seeded from `ORCA_AUDIO_BUSES`; flow nodes mutate it. */
const buses = new Map<string, OrcaAudioBus>();

/** Transient per-bus duck gain (1 = not ducked). Never persisted. */
const duckMultipliers = new Map<string, number>();

/** Latched auto-duck state per DUCKED bus, so we only ramp on 0↔n transitions. */
const autoDuckActive = new Map<string, boolean>();

/** In-flight ramp timers per bus (step timers + the manual-duck hold timer). */
const rampTimers = new Map<string, Array<ReturnType<typeof setTimeout>>>();

/** Monotonic cancel token per bus — a superseded ramp step bails on mismatch. */
const rampTokens = new Map<string, number>();
let rampCounter = 0;

/** Live voice registry, keyed by group-controller instance id. */
const voices = new Map<number, OrcaVoice>();

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return value < min ? min : (value > max ? max : value);
}

/** Clamp a playback rate into the audible 0.25..4 range; non-positive → 1. */
export function clampRate(rate: number): number {
    if (!Number.isFinite(rate) || rate <= 0) return 1;
    return rate < MIN_RATE ? MIN_RATE : (rate > MAX_RATE ? MAX_RATE : rate);
}

// ---------------------------------------------------------------------------
// Bus tree
// ---------------------------------------------------------------------------

function seedBuses(): void {
    buses.clear();
    for (const bus of ORCA_AUDIO_BUSES) {
        if (!bus || typeof bus.id !== 'string' || bus.id.length === 0) continue;
        buses.set(bus.id, { ...bus });
    }
    if (!buses.has(ORCA_AUDIO_MASTER_BUS)) {
        buses.set(ORCA_AUDIO_MASTER_BUS, {
            id: ORCA_AUDIO_MASTER_BUS,
            name: 'Master',
            parent: null,
            volume: 1,
            pitch: 1,
            mute: false,
            solo: false,
            maxVoices: 0,
            voiceStealing: 'oldest',
            duckedBy: null,
            duckAmount: 0.35,
            duckAttack: 0.15,
            duckRelease: 0.4,
        });
    }
}

seedBuses();

/** The bus and every ancestor up to master, nearest-first. Depth-capped. */
function busChain(busId: string): OrcaAudioBus[] {
    const chain: OrcaAudioBus[] = [];
    let cursor: string | null = busId;
    let depth = 0;
    while (cursor !== null && depth < MAX_BUS_DEPTH) {
        const bus = buses.get(cursor);
        if (!bus) break;
        chain.push(bus);
        cursor = bus.parent;
        depth += 1;
    }
    return chain;
}

function chainIncludes(busId: string, ancestorId: string): boolean {
    for (const bus of busChain(busId)) {
        if (bus.id === ancestorId) return true;
    }
    return false;
}

function anyBusSoloed(): boolean {
    for (const bus of buses.values()) {
        if (bus.solo === true) return true;
    }
    return false;
}

/**
 * Resolve an authored bus id to a real one.
 *
 * Empty / whitespace / unknown → `fallback` (and `fallback` itself falls back to
 * master if it has been deleted). Absence-safe: legacy graphs export `''` for a
 * newly-appended `bus` property.
 */
export function resolveBus(requested: string | undefined, fallback: string): string {
    if (typeof requested === 'string') {
        const trimmed = requested.trim();
        if (trimmed.length > 0) {
            if (buses.has(trimmed)) return trimmed;
            console.warn(`[FlowState mixer] unknown bus '${trimmed}', falling back to '${fallback}'.`);
        }
    }
    return buses.has(fallback) ? fallback : ORCA_AUDIO_MASTER_BUS;
}

// ---------------------------------------------------------------------------
// Gain / pitch resolution
// ---------------------------------------------------------------------------

/**
 * Product of every `volume` and duck multiplier from `busId` up to master.
 * `0` when any bus in the chain is muted, or when something is soloed and this
 * chain contains no soloed bus.
 */
export function effectiveGain(busId: string): number {
    const chain = busChain(busId);
    if (chain.length === 0) return 1;

    const soloing = anyBusSoloed();
    let gain = 1;
    let soloedInChain = false;

    for (const bus of chain) {
        if (bus.mute === true) return 0;
        if (bus.solo === true) soloedInChain = true;
        gain *= (typeof bus.volume === 'number' && bus.volume >= 0) ? bus.volume : 1;
        gain *= duckMultipliers.get(bus.id) ?? 1;
    }

    if (soloing && !soloedInChain) return 0;
    return gain > 0 ? gain : 0;
}

/** Product of every `pitch` from `busId` up to master, clamped 0.25..4. */
export function effectivePitch(busId: string): number {
    let rate = 1;
    for (const bus of busChain(busId)) {
        rate *= (typeof bus.pitch === 'number' && bus.pitch > 0) ? bus.pitch : 1;
    }
    return clampRate(rate);
}

// ---------------------------------------------------------------------------
// Group-controller access
// ---------------------------------------------------------------------------

/**
 * The `container.soundManager` group controller for a group.
 *
 * Typed `any` on purpose: `@game-studio/sound-manager` ships no `.d.ts` in this
 * repo (VPN-gated registry) and the two controllers are distinct nominal types,
 * so a union would not be callable. Only members with shipped call sites are
 * used: `play` / `stop` / `fade`.
 */
export function getSoundGroup(group: 'sfx' | 'music'): any {
    return group === 'music' ? container.soundManager.music : container.soundManager.sfx;
}

// ---------------------------------------------------------------------------
// Voice registry
// ---------------------------------------------------------------------------

export function registerVoice(voice: Omit<OrcaVoice, 'startedAt'>): void {
    if (typeof voice.id !== 'number' || !Number.isFinite(voice.id)) return;
    voices.set(voice.id, { ...voice, startedAt: Date.now() });
}

/** Idempotent — safe to call from both a manual stop and the `complete` callback. */
export function unregisterVoice(id: number): void {
    voices.delete(id);
}

/** Drop every tracked voice on one group controller (a `stopAll` on that group). */
export function unregisterVoicesInGroup(group: 'sfx' | 'music'): void {
    for (const voice of Array.from(voices.values())) {
        if (voice.group === group) voices.delete(voice.id);
    }
}

/** Drop every tracked voice playing a given alias (a `stopAllInstancesOf`). */
export function unregisterVoicesByAlias(alias: string): void {
    for (const voice of Array.from(voices.values())) {
        if (voice.alias === alias) voices.delete(voice.id);
    }
}

/** Drop the whole registry (a global stop/reset of the sound manager). */
export function unregisterAllVoices(): void {
    voices.clear();
}

export function getVoice(id: number): OrcaVoice | undefined {
    return voices.get(id);
}

function voicesUnder(busId: string): OrcaVoice[] {
    const out: OrcaVoice[] = [];
    for (const voice of voices.values()) {
        if (chainIncludes(voice.busId, busId)) out.push(voice);
    }
    return out;
}

/**
 * Gate a new play against the nearest non-zero `maxVoices` in the bus chain.
 *
 * Returns `false` when the play must be SKIPPED. Policy `'oldest'` stops the
 * longest-running voice under the limiting bus and allows the play; `'skip'`
 * denies it.
 */
export function enforceVoiceLimit(busId: string): boolean {
    let limitBus: OrcaAudioBus | null = null;
    for (const bus of busChain(busId)) {
        if (typeof bus.maxVoices === 'number' && bus.maxVoices > 0) {
            limitBus = bus;
            break;
        }
    }
    if (limitBus === null) return true;

    const live = voicesUnder(limitBus.id);
    if (live.length < limitBus.maxVoices) return true;

    if (limitBus.voiceStealing === 'skip') {
        console.warn(`[FlowState mixer] voice limit (${limitBus.maxVoices}) reached on bus '${limitBus.id}', skipping play.`);
        return false;
    }

    if (live.length === 0) return true;
    let oldest = live[0];
    for (const voice of live) {
        if (voice.startedAt < oldest.startedAt) oldest = voice;
    }
    try {
        getSoundGroup(oldest.group).stop(oldest.id);
    } catch (err) {
        console.warn("[FlowState mixer] failed to steal oldest voice:", oldest.id, err);
    }
    unregisterVoice(oldest.id);
    refreshAutoDucking();
    return true;
}

// ---------------------------------------------------------------------------
// Applying gain / rate to live voices
// ---------------------------------------------------------------------------

function fadeVoiceToCurrentGain(voice: OrcaVoice, durationSec: number): void {
    // A zero-length fade can divide by zero inside a tween implementation, so
    // floor it at one frame rather than passing 0 through.
    const duration = typeof durationSec === 'number' && durationSec > 0 ? durationSec : 0.01;
    const target = voice.baseVolume * effectiveGain(voice.busId);
    try {
        getSoundGroup(voice.group).fade(voice.id, { toVolume: target, duration: duration });
    } catch (err) {
        console.warn("[FlowState mixer] failed to apply bus gain to voice:", voice.id, err);
    }
}

/** Re-fade every tracked voice routed through `busId` to its current gain. */
export function applyBusGainToLiveVoices(busId: string, durationSec: number): void {
    for (const voice of voicesUnder(busId)) {
        fadeVoiceToCurrentGain(voice, durationSec);
    }
}

/**
 * Re-fade EVERY tracked voice. Used by solo/reset, which change gain for chains
 * that may not include the edited bus.
 */
function applyGainToAllVoices(durationSec: number): void {
    for (const voice of voices.values()) {
        fadeVoiceToCurrentGain(voice, durationSec);
    }
}

/**
 * Best-effort per-instance playback rate. Only lands when `play()` handed back
 * an instance object — the id-based controller API exposes no rate setter.
 */
export function applyVoiceRate(voice: OrcaVoice): void {
    const instance = voice.instance;
    if (instance === null || typeof instance !== 'object') return;
    const rate = clampRate(voice.basePitch * effectivePitch(voice.busId));
    try {
        (instance as { rate?: number }).rate = rate;
    } catch (err) {
        console.warn("[FlowState mixer] failed to set playback rate on voice:", voice.id, err);
    }
}

// ---------------------------------------------------------------------------
// Duck ramps
// ---------------------------------------------------------------------------

function cancelRamp(busId: string): number {
    const timers = rampTimers.get(busId);
    if (timers) {
        for (const timer of timers) clearTimeout(timer);
    }
    rampTimers.delete(busId);
    rampCounter += 1;
    rampTokens.set(busId, rampCounter);
    return rampCounter;
}

function trackTimer(busId: string, timer: ReturnType<typeof setTimeout>): void {
    const list = rampTimers.get(busId);
    if (list) list.push(timer);
    else rampTimers.set(busId, [timer]);
}

/**
 * Linearly ramp a bus's duck multiplier with a dependency-free `setTimeout`
 * stepper, re-applying gain to live voices on each step. Starting a ramp
 * supersedes any in-flight ramp (including a manual duck's hold phase) on the
 * same bus.
 */
function rampDuckMultiplier(busId: string, target: number, durationSec: number, onDone?: () => void): void {
    const token = cancelRamp(busId);
    const from = duckMultipliers.get(busId) ?? 1;
    const to = clamp(target, 0, 1);
    const durationMs = typeof durationSec === 'number' && durationSec > 0 ? durationSec * 1000 : 0;

    if (durationMs <= 0 || from === to) {
        duckMultipliers.set(busId, to);
        applyBusGainToLiveVoices(busId, 0);
        if (onDone) onDone();
        return;
    }

    const startedAt = Date.now();
    const step = (): void => {
        if (rampTokens.get(busId) !== token) return;
        const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
        duckMultipliers.set(busId, from + (to - from) * progress);
        applyBusGainToLiveVoices(busId, RAMP_STEP_MS / 1000);
        if (progress >= 1) {
            rampTimers.delete(busId);
            if (onDone) onDone();
            return;
        }
        trackTimer(busId, setTimeout(step, RAMP_STEP_MS));
    };
    trackTimer(busId, setTimeout(step, RAMP_STEP_MS));
}

/**
 * Re-evaluate every AUTO-duck relationship (`bus.duckedBy`) and ramp on 0↔n
 * live-voice transitions of the trigger bus. Idempotent: latched per ducked bus,
 * so repeated calls with unchanged voice counts do nothing.
 */
export function refreshAutoDucking(): void {
    for (const bus of buses.values()) {
        const trigger = bus.duckedBy;
        if (typeof trigger !== 'string' || trigger.length === 0) continue;
        if (trigger === bus.id) continue;
        if (!buses.has(trigger)) continue;

        const active = voicesUnder(trigger).length > 0;
        if ((autoDuckActive.get(bus.id) === true) === active) continue;
        autoDuckActive.set(bus.id, active);

        if (active) rampDuckMultiplier(bus.id, clamp(bus.duckAmount, 0, 1), bus.duckAttack);
        else rampDuckMultiplier(bus.id, 1, bus.duckRelease);
    }
}

/** Call AFTER `registerVoice` so the trigger's voice count is already up to date. */
export function noteVoiceStarted(busId: string): void {
    void busId;
    refreshAutoDucking();
}

/** Call AFTER `unregisterVoice` so the trigger's voice count is already up to date. */
export function noteVoiceEnded(busId: string): void {
    void busId;
    refreshAutoDucking();
}

// ---------------------------------------------------------------------------
// FlowState-callable methods
// ---------------------------------------------------------------------------

class MixerMethods {
    /** Set a bus's fader, optionally ramping live voices over `duration` seconds. */
    setBusVolume(busId: string, volume: number, duration: number): void {
        const id = resolveBus(busId, ORCA_AUDIO_MASTER_BUS);
        const bus = buses.get(id);
        if (!bus) return;
        bus.volume = typeof volume === 'number' && volume >= 0 ? volume : 0;
        applyBusGainToLiveVoices(id, typeof duration === 'number' && duration > 0 ? duration : 0);
    }

    /** Mute a bus (and everything routed through it). */
    muteBus(busId: string): void {
        const id = resolveBus(busId, ORCA_AUDIO_MASTER_BUS);
        const bus = buses.get(id);
        if (!bus) return;
        bus.mute = true;
        applyBusGainToLiveVoices(id, 0);
    }

    /** Unmute a bus. */
    unmuteBus(busId: string): void {
        const id = resolveBus(busId, ORCA_AUDIO_MASTER_BUS);
        const bus = buses.get(id);
        if (!bus) return;
        bus.mute = false;
        applyBusGainToLiveVoices(id, 0);
    }

    /** Solo a bus — every chain without a soloed bus in it drops to silence. */
    soloBus(busId: string): void {
        const id = resolveBus(busId, ORCA_AUDIO_MASTER_BUS);
        const bus = buses.get(id);
        if (!bus) return;
        bus.solo = true;
        applyGainToAllVoices(0);
    }

    /** Clear solo on every bus. */
    clearBusSolo(): void {
        for (const bus of buses.values()) bus.solo = false;
        applyGainToAllVoices(0);
    }

    /** Set a bus's pitch multiplier (0.25..4 after the whole chain is folded in). */
    setBusPitch(busId: string, pitch: number): void {
        const id = resolveBus(busId, ORCA_AUDIO_MASTER_BUS);
        const bus = buses.get(id);
        if (!bus) return;
        bus.pitch = typeof pitch === 'number' && pitch > 0 ? pitch : 1;
        for (const voice of voicesUnder(id)) applyVoiceRate(voice);
    }

    /**
     * One-shot manual duck: ramp down to `toVolume` over `attack`, hold, then
     * ramp back to 1 over `release` (all seconds). Composes with auto-ducking —
     * whichever transition happens last wins, because both share the per-bus
     * ramp token.
     */
    duckBus(busId: string, toVolume: number, attack: number, hold: number, release: number): void {
        const id = resolveBus(busId, ORCA_AUDIO_MASTER_BUS);
        if (!buses.has(id)) return;

        const target = Number.isFinite(toVolume) ? clamp(toVolume, 0, 1) : 0.35;
        const attackSec = typeof attack === 'number' && attack > 0 ? attack : 0;
        const holdMs = typeof hold === 'number' && hold > 0 ? hold * 1000 : 0;
        const releaseSec = typeof release === 'number' && release > 0 ? release : 0;

        rampDuckMultiplier(id, target, attackSec, () => {
            const token = rampTokens.get(id);
            const startRelease = (): void => {
                if (rampTokens.get(id) !== token) return;
                rampDuckMultiplier(id, 1, releaseSec);
            };
            if (holdMs <= 0) {
                startRelease();
                return;
            }
            trackTimer(id, setTimeout(startRelease, holdMs));
        });
    }

    /** Re-seed every bus from the authored setup and clear all solos and ducks. */
    resetMixer(): void {
        for (const id of Array.from(rampTimers.keys())) cancelRamp(id);
        duckMultipliers.clear();
        autoDuckActive.clear();
        seedBuses();
        applyGainToAllVoices(0);
        for (const voice of voices.values()) applyVoiceRate(voice);
        refreshAutoDucking();
    }
}

export const mixer = new MixerMethods();
