import { AssetManager, container, Sound } from "@game-studio/arcade-base";
import { Howler } from "howler";
import { Assets, checkExtension, DOMAdapter, extensions, ExtensionType, LoaderParserPriority } from "pixi.js";
import {
    ORCA_AUDIO_DEFAULT_MUSIC_BUS,
    ORCA_AUDIO_DEFAULT_SFX_BUS,
} from "../generated-audio-mixer";
import {
    applyVoiceRate,
    clampRate,
    effectiveGain,
    effectivePitch,
    enforceVoiceLimit,
    getSoundGroup,
    getVoice,
    noteVoiceEnded,
    noteVoiceStarted,
    refreshAutoDucking,
    registerVoice,
    resolveBus,
    unregisterAllVoices,
    unregisterVoice,
    unregisterVoicesByAlias,
    unregisterVoicesInGroup,
} from "./mixer";

/**
 * Audio Methods for FlowState
 * 
 * Provides comprehensive audio control for sound effects (SFX) and music.
 * Wraps the game-studio/arcade-base sound manager for use in FlowState nodes.
 * 
 * Sound effects and music are managed separately with dedicated controls for:
 * - Playing, pausing, stopping, and resuming
 * - Volume control and fading
 * - Muting/unmuting
 * - Dynamic music playlists
 *
 * Path-aware audio
 * ----------------
 * Sound/music nodes authored in the editor may reference an audio binary by a
 * bucket-relative path (e.g. `sounds/win.mp3` or `assets/win.wav`) instead of a
 * short alias pre-registered via per-skin `data-list.ts`. Such a file is loaded
 * ONCE through the Pixi loader (`Assets`, the `orcaAudio` parser below) and the
 * sound manager plays it from those loaded bytes, so playing it never touches
 * the network. Every file the graphs and the reels name is preloaded while the
 * game loads (`preloadOrcaAudio`); a path met only at play time loads the same
 * way on first use. Plain short aliases are passed straight through,
 * preserving full backward-compatibility with `data-list.ts`.
 *
 * Scope-qualified paths
 * ---------------------
 * Runtime audio paths are SCOPE-QUALIFIED by the editor at export time:
 * `core/<name>` for core graphs and `skins/<skin>/<name>` for skin graphs.
 * Because the alias / dedup key IS the path and the URL is `/assets/<path>`,
 * a same-basename audio file in core vs a skin de-collides automatically with
 * no change here. Legacy bare-path json keeps resolving via the unscoped
 * `/assets` middleware fallback until the graph is re-saved.
 *
 * Mixer routing
 * -------------
 * Every play routes through an Orca audio BUS (see `methods/mixer.ts`). The
 * bus chain's gain is folded into the per-instance volume and its pitch into
 * the playback rate, so `container.soundManager` remains the single authority
 * for gain — we never reach past it to howler's own global controls
 * (`Howler.volume` / `Howler.mute`), which would disagree with the
 * sound-manager's category volumes, auto-pause and active-track bookkeeping.
 *
 * Absence-safety
 * --------------
 * The editor exports node properties POSITIONALLY, and an already-saved graph
 * exports only the properties it was saved with. A newly appended property on
 * an OLD node therefore arrives as `undefined` / `0` / `false` / `''` — the TYPE
 * default, NOT the menu default. Every trailing parameter added below is
 * normalised accordingly (notably `pitch`: `0` means "unset", never "stopped").
 */

/** Audio file extensions that mark a name as a bucket-relative asset path. */
const AUDIO_PATH_EXT_RE = /\.(mp3|wav|ogg|m4a|aac)$/i;

/** The Pixi loader parser that fetches an audio file's bytes (`Assets` caches them). */
const ORCA_AUDIO_PARSER = "orcaAudio";

/** Files loaded (fetched and decoded) at once while preloading. */
const PRELOAD_CONCURRENCY = 6;

let audioParserRegistered = false;

/**
 * Register the `orcaAudio` loader with Pixi once. Loads name it explicitly, so
 * an `.ogg` never reaches Pixi's video loader.
 */
function ensureAudioParser(): void {
    if (audioParserRegistered) return;
    audioParserRegistered = true;
    extensions.add({
        name: ORCA_AUDIO_PARSER,
        id: ORCA_AUDIO_PARSER,
        extension: { type: ExtensionType.LoadParser, priority: LoaderParserPriority.Low, name: ORCA_AUDIO_PARSER },
        test: (url: string): boolean => checkExtension(url, [".mp3", ".wav", ".ogg", ".m4a", ".aac"]),
        async load(url: string): Promise<Blob> {
            const response = await DOMAdapter.get().fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.blob();
        },
    });
}


/**
 * Dedup registry: maps a bucket-relative audio path to an in-flight (or settled)
 * Promise that resolves once the sound manager has finished loading/decoding the
 * alias for that path. The alias IS the path, so it is deterministic and shared
 * across every node that references the same file — guaranteeing the underlying
 * audio binary is fetched and decoded at most once. Awaiting this promise BEFORE
 * the first `play(...)` eliminates the decode race that would otherwise let a
 * play land on a half-loaded `Howl`.
 *
 * The promise resolves to the alias on success, or `null` when the file failed
 * to load. A failure is remembered for the session: the file is not fetched
 * again on every play.
 */
const registeredAudioPaths = new Map<string, Promise<string | null>>();

/** True when `name` looks like a bucket-relative audio asset path. */
function looksLikeAudioPath(name: string): boolean {
    if (typeof name !== "string" || name.length === 0) return false;
    const bare = name.split("?")[0].split("#")[0];
    return AUDIO_PATH_EXT_RE.test(bare);
}

/** The editor-generated `<stem>.mp3` beside an `.ogg` path, or `null` for any other file. */
function mp3SiblingOf(name: string): string | null {
    const match = /^([^?#]*)\.ogg([?#].*)?$/i.exec(name);
    return match ? `${match[1]}.mp3${match[2] ?? ""}` : null;
}

let oggPlayable: boolean | undefined;

/** Whether this device decodes Ogg Vorbis (iOS Safari before 17.4 does not). */
function canPlayOgg(): boolean {
    if (oggPlayable !== undefined) return oggPlayable;
    let playable = false;
    try {
        playable = Howler.codecs("ogg");
    } catch {
        playable = false;
    }
    if (!playable && typeof document !== "undefined") {
        try {
            playable = document.createElement("audio").canPlayType('audio/ogg; codecs="vorbis"').replace(/^no$/, "") !== "";
        } catch {
            playable = false;
        }
    }
    oggPlayable = playable;
    return playable;
}

/**
 * Resolve a bucket-relative asset path to its loadable runtime URL.
 *
 * Mirrors `scene-manager.toAbsoluteSceneAssetUrl`: refs are resolved against the
 * page-relative `assets/` directory (NOT a hardcoded absolute `/assets/`) so
 * both dev-server and prod sub-path hosting keep working. Absolute refs
 * (http(s)://, data:, blob:) are preserved because `new URL(absolute, base)`
 * ignores the base.
 */
function toAudioAssetUrl(path: string): string {
    const assetsBase = new URL("assets/", window.location.href);
    const normalized = path.replace(/^\/+/, "");
    return new URL(normalized, assetsBase).toString();
}

/**
 * Deterministic alias for a name: the path itself for path-like names, or the
 * name unchanged for legacy short aliases. Does NOT register/load anything — use
 * for stop/pause/resume-by-name where the track was already registered on play.
 */
function aliasForName(name: string): string {
    return name;
}

/**
 * True when an alias is known to the sound manager (i.e. present in
 * `AssetManager.sounds`). Both group controllers share one underlying registry,
 * so `sfx` is representative for music aliases too.
 */
function audioAliasExists(name: string): boolean {
    return container.soundManager.sfx.exists(name);
}

/**
 * Ensure an audio path is loaded/decoded and return its playable alias.
 *
 * The file's bytes come through the Pixi loader (`Assets.load` with the
 * `orcaAudio` parser, cached by Pixi) and the `Sound` (a howler `Howl`) is
 * built from them through an object URL, so howler decodes the loaded bytes
 * instead of requesting the file itself. Registers the path ONCE under the
 * path as a stable alias and AWAITS the decode, so the buffer is fully ready
 * before the first `play(...)`. Concurrent calls for the same path share the
 * single in-flight promise. Resolves to the alias on success, or `null` on
 * load error (logged once) so callers no-op instead of crashing the flow.
 *
 * Registers straight into `AssetManager.sounds` rather than going through
 * `AssetManager.load(...)`: that loader skips any alias already present (so a
 * re-register is a silent no-op) and demands a whole `IAssetConfig`
 * (baseUrl/skin/version) that is meaningless for a single ad-hoc file, whereas
 * `Sound.load()` hands back exactly the decode promise this registry needs.
 *
 * An `.ogg` keeps its own name as the alias but loads the editor-generated
 * `<stem>.mp3` beside it on a device that cannot play Ogg, and falls back to
 * that `.mp3` once if the `.ogg` itself fails to load or decode.
 */
function ensureAudioRegistered(name: string): Promise<string | null> {
    const alias = name;

    const cached = registeredAudioPaths.get(name);
    if (cached) return cached;

    // Already registered by a data-list load or an earlier path-equal add — fast-path.
    if (audioAliasExists(alias)) {
        const resolved = Promise.resolve<string | null>(alias);
        registeredAudioPaths.set(name, resolved);
        return resolved;
    }

    const loadFrom = async (path: string): Promise<void> => {
        ensureAudioParser();
        const bytes = await Assets.load<Blob>({ src: toAudioAssetUrl(path), parser: ORCA_AUDIO_PARSER });
        const format = (AUDIO_PATH_EXT_RE.exec(path.split("?")[0].split("#")[0])?.[1] ?? "mp3").toLowerCase();
        // The object URL has no extension, so howler needs the format named.
        const sound = new Sound({ name: alias, src: [URL.createObjectURL(bytes)], format: [format] });
        await sound.load();
        AssetManager.sounds[alias] = sound;
    };

    // The alias stays the .ogg name; only the file loaded behind it changes.
    const mp3 = mp3SiblingOf(name);
    const loadPath = mp3 && !canPlayOgg() ? mp3 : name;

    const loadPromise = (async (): Promise<string | null> => {
        try {
            await loadFrom(loadPath);
            return alias;
        } catch (err) {
            if (mp3 && loadPath !== mp3) {
                try {
                    await loadFrom(mp3);
                    return alias;
                } catch (fallbackErr) {
                    console.warn("[FlowState audio] failed to load audio path and its .mp3 fallback, skipping:", name, err, fallbackErr);
                    return null;
                }
            }
            console.warn("[FlowState audio] failed to load audio path, skipping:", loadPath, err);
            return null;
        }
    })();

    registeredAudioPaths.set(name, loadPromise);
    return loadPromise;
}

/**
 * Load every audio file in `paths` through the Pixi loader and decode it, so
 * playing any of them later fetches nothing. Run while the game loads. Never
 * rejects: a file that fails to load is logged and stays silent.
 */
export async function preloadOrcaAudio(paths: Iterable<string>): Promise<void> {
    const queue = Array.from(new Set(paths)).filter(looksLikeAudioPath);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < queue.length) await ensureAudioRegistered(queue[next++]);
    };
    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < Math.min(PRELOAD_CONCURRENCY, queue.length); i++) workers.push(worker());
    await Promise.all(workers);
}

/**
 * Every audio file `data` names in a node property's value (a string, or a
 * list of them for random sounds and playlists), at any depth — graphs,
 * subgraphs and the nodes inside them alike. Added to `out` and returned.
 */
export function collectOrcaAudioPaths(data: unknown, out: Set<string> = new Set<string>()): Set<string> {
    const visit = (value: unknown, depth: number): void => {
        if (depth > 64 || value === null || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1);
            return;
        }
        const record = value as Record<string, unknown>;
        if (Array.isArray(record.properties)) {
            for (const property of record.properties) {
                const raw = property !== null && typeof property === "object" ? (property as { value?: unknown }).value : undefined;
                for (const candidate of Array.isArray(raw) ? raw : [raw]) {
                    if (typeof candidate === "string" && looksLikeAudioPath(candidate)) out.add(candidate);
                }
            }
        }
        for (const key of Object.keys(record)) visit(record[key], depth + 1);
    };
    visit(data, 0);
    return out;
}

/**
 * Resolve a name to a PLAYABLE alias (awaiting load for paths), or `null` when
 * it can't be played.
 *
 * Guards `@game-studio/sound-manager`'s `SoundGroupController.play`, which looks
 * the name up in `AssetManager.sounds` and warns/no-ops for an alias that was
 * never registered.
 *
 * - Empty/whitespace-only/non-string → `null` (nothing to play).
 * - Bucket-relative path → registered ONCE and AWAITED (via
 *   `ensureAudioRegistered`); resolves to the alias once decoded, or `null` on
 *   load error.
 * - Legacy short alias → returned only if `audioAliasExists(alias)`, else `null`
 *   (pre-decoded via `data-list.ts`, so no await needed).
 */
async function resolvePlayableAlias(name: string): Promise<string | null> {
    if (typeof name !== "string" || name.trim().length === 0) return null;
    if (looksLikeAudioPath(name)) return ensureAudioRegistered(name);
    return audioAliasExists(name) ? name : null;
}

// ---------------------------------------------------------------------------
// Parameter normalisers (absence-safe — see the module header)
// ---------------------------------------------------------------------------

/** `volume`: any non-negative number wins; anything else → 1 (full). */
function normaliseVolume(volume: number): number {
    return typeof volume === "number" && volume >= 0 ? volume : 1;
}

/** `pitch`: `0` means UNSET (never "stopped"), so only `> 0` is honoured. */
function normalisePitch(pitch: number): number {
    return typeof pitch === "number" && pitch > 0 ? clampRate(pitch) : 1;
}

/** `fadeIn` / durations: only `> 0` is a real fade. */
function normaliseDuration(seconds: number): number {
    return typeof seconds === "number" && seconds > 0 ? seconds : 0;
}

/** `pan`: `0` is centre, which is also the legacy-absent value. */
function normalisePan(pan: number): number {
    if (typeof pan !== "number" || !Number.isFinite(pan)) return 0;
    return pan < -1 ? -1 : (pan > 1 ? 1 : pan);
}

/** `jitter`: a 0..1 proportion; absent/invalid → 0 (deterministic). */
function normaliseJitter(jitter: number): number {
    if (typeof jitter !== "number" || !Number.isFinite(jitter) || jitter <= 0) return 0;
    return jitter > 1 ? 1 : jitter;
}

/** Symmetric ±proportion jitter: `1 ± random * amount`. */
function jitterFactor(amount: number): number {
    if (amount <= 0) return 1;
    return 1 + (Math.random() * 2 - 1) * amount;
}

// ---------------------------------------------------------------------------
// play() return-shape normalisation
// ---------------------------------------------------------------------------

/**
 * `SoundGroupController.play()` hands back a `SoundInstance | undefined` whose
 * `.id` is the howler instance id — but the FlowState runtime types every id as
 * a bare `number` (`stopSound(soundId: number)`), and older shipped reference
 * games treat the return as an opaque media instance and tween it directly.
 *
 * So normalise defensively and NEVER throw on an unknown shape — the sound
 * still plays, it just isn't tracked (no retro-active fader, no voice-limit
 * accounting).
 */
function toInstanceId(ret: unknown): number | null {
    if (typeof ret === "number") return Number.isFinite(ret) ? ret : null;
    if (ret !== null && typeof ret === "object") {
        const id = (ret as { id?: unknown }).id;
        if (typeof id === "number" && Number.isFinite(id)) return id;
    }
    return null;
}

/** Set once we learn this build's `play()` hands back something untrackable. */
let opaquePlayReturnSeen = false;
let opaquePlayReturnLogged = false;

function noteOpaquePlayReturn(value: unknown): void {
    opaquePlayReturnSeen = true;
    if (opaquePlayReturnLogged) return;
    opaquePlayReturnLogged = true;
    console.debug("[FlowState audio] play() returned an untracked shape; per-instance mixer effects are unavailable:", value);
}

/** Await a promise-shaped `play()` return, then normalise it. */
async function resolvePlayHandle(ret: unknown): Promise<{ id: number | null; instance: unknown }> {
    let value = ret;
    if (value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function") {
        try {
            value = await (value as Promise<unknown>);
        } catch (err) {
            console.warn("[FlowState audio] play() promise rejected:", err);
            return { id: null, instance: null };
        }
    }
    const id = toInstanceId(value);
    const instance = value !== null && typeof value === "object" ? value : null;
    if (id === null && instance === null) noteOpaquePlayReturn(value);
    return { id: id, instance: instance };
}

// ---------------------------------------------------------------------------
// Stereo pan (howler, per-instance)
// ---------------------------------------------------------------------------

/**
 * NOTE: `@pixi/sound` is no longer part of the stack — `@game-studio/sound-manager`
 * is howler-backed, so panning is done through howler's own `stereo(pan, id)`.
 *
 * This is strictly BETTER than the old filter-chain approach: a `SoundInstance`
 * carries the howler instance id (`.id`) alongside its `Howl` (`.sound`), so a
 * pan applies to THAT instance only instead of every instance sharing the alias.
 *
 * Still WebAudio-only — howler warns and no-ops on its HTML5 Audio fallback
 * (older iOS, or a `html5: true` sound), so every call is wrapped and degrades
 * instead of throwing.
 */
function setInstancePan(instance: unknown, pan: number): void {
    if (instance === null || typeof instance !== "object") return;
    try {
        const handle = instance as { id?: unknown; sound?: { stereo?: unknown } };
        const howl = handle.sound;
        if (!howl || typeof howl.stereo !== "function") return;
        if (typeof handle.id !== "number" || !Number.isFinite(handle.id)) return;
        (howl.stereo as (p: number, id: number) => unknown)(pan, handle.id);
    } catch (err) {
        console.warn("[FlowState audio] stereo pan unsupported, skipping:", err);
    }
}

/** Warn ONCE that mono downmix has no howler equivalent. */
let monoUnsupportedLogged = false;

function noteMonoUnsupported(soundName: string): void {
    if (monoUnsupportedLogged) return;
    monoUnsupportedLogged = true;
    console.warn(
        "[FlowState audio] setSoundMono: mono downmix is unavailable — it was a" +
            " `@pixi/sound` filter, and the howler-backed sound manager exposes no" +
            " equivalent. The node is a no-op; author a mono source file instead:",
        soundName
    );
}

// ---------------------------------------------------------------------------
// Shared play path
// ---------------------------------------------------------------------------

interface PlayRequest {
    /** Which `container.soundManager` group controller to play through. */
    group: "sfx" | "music";
    /** Node name for warnings (`playSound` / `playMusic` / `playRandomSound`). */
    label: string;
    name: string;
    volume: number;
    loop: boolean;
    pitch: number;
    fadeIn: number;
    pan: number;
    bus: string;
}

async function playOnBus(req: PlayRequest): Promise<void> {
    const alias = await resolvePlayableAlias(req.name);
    if (alias === null) {
        console.warn(`[FlowState audio] ${req.label}: unknown/empty name, skipping:`, req.name);
        return;
    }

    const defaultBus = req.group === "music" ? ORCA_AUDIO_DEFAULT_MUSIC_BUS : ORCA_AUDIO_DEFAULT_SFX_BUS;
    const busId = resolveBus(req.bus, defaultBus);
    if (!enforceVoiceLimit(busId)) return;

    const baseVolume = req.volume;
    const basePitch = req.pitch;
    const gain = effectiveGain(busId);
    const rate = clampRate(basePitch * effectivePitch(busId));
    const targetVolume = baseVolume * gain;

    // Start silent for a fade-in — but only when a previous play proved we can
    // recover a trackable instance, otherwise the sound would stay inaudible.
    const fadeIn = req.fadeIn;
    const startSilent = fadeIn > 0 && !opaquePlayReturnSeen;

    let completed = false;
    let voiceId: number | null = null;
    const onComplete = (): void => {
        completed = true;
        if (voiceId !== null) unregisterVoice(voiceId);
        noteVoiceEnded(busId);
    };

    // Built as `any` on purpose: the wrapper's play-option type is narrower on
    // some builds, so an object literal would risk an excess-property error.
    // The direct `.rate` assignment below is the fallback.
    const options: any = {
        volume: startSilent ? 0 : targetVolume,
        loop: req.loop,
    };
    options.rate = rate;

    const group = getSoundGroup(req.group);
    let ret: unknown;
    try {
        ret = group.play(alias, options);
    } catch (err) {
        console.warn(`[FlowState audio] ${req.label}: play failed, skipping:`, req.name, err);
        return;
    }

    const handle = await resolvePlayHandle(ret);

    // The sound manager has no `complete` play-option — a `SoundInstance` is an
    // EventEmitter that fires `end` (non-looping playback finished) and
    // `dispose` (released/stopped). Either ends the voice exactly once.
    if (handle.instance !== null) {
        try {
            const emitter = handle.instance as {
                once?: (event: string, fn: () => void) => unknown;
            };
            if (typeof emitter.once === "function") {
                const endVoice = (): void => {
                    if (completed) return;
                    onComplete();
                };
                emitter.once("end", endVoice);
                emitter.once("dispose", endVoice);
            }
        } catch (err) {
            console.warn(`[FlowState audio] ${req.label}: end-of-voice hook failed:`, req.name, err);
        }
    }

    if (handle.id !== null && !completed) {
        voiceId = handle.id;
        registerVoice({
            id: handle.id,
            busId: busId,
            group: req.group,
            alias: alias,
            baseVolume: baseVolume,
            basePitch: basePitch,
            instance: handle.instance,
        });
        noteVoiceStarted(busId);
    }

    // Per-instance stereo pan (howler). Applied AFTER the handle resolves
    // because it is keyed by the live instance, not the alias.
    if (req.pan !== 0) setInstancePan(handle.instance, req.pan);

    // Belt-and-braces: apply the playback rate straight onto the instance in
    // case the wrapper dropped the `rate` play-option.
    if (rate !== 1 && handle.instance !== null) {
        try {
            (handle.instance as { rate?: number }).rate = rate;
        } catch (err) {
            console.warn(`[FlowState audio] ${req.label}: playback rate unsupported:`, req.name, err);
        }
    }

    if (fadeIn > 0 && !completed) {
        if (voiceId !== null) {
            try {
                group.fade(voiceId, { toVolume: targetVolume, duration: fadeIn });
            } catch (err) {
                console.warn(`[FlowState audio] ${req.label}: fade-in failed:`, req.name, err);
            }
        } else if (handle.instance !== null) {
            // Untracked instance — no tween available, so land on the target
            // volume immediately rather than leaving the sound silent.
            try {
                (handle.instance as { volume?: number }).volume = targetVolume;
            } catch (err) {
                console.warn(`[FlowState audio] ${req.label}: fade-in unsupported:`, req.name, err);
            }
        }
    }
}

/** The members of a sound-manager music instance this module relies on. */
interface MusicInstanceHandle {
    id: number;
    isDisposed?: boolean;
}

/** Every live instance of a music track, oldest first. */
function liveMusicInstances(name: string): MusicInstanceHandle[] {
    if (typeof name !== "string" || name.trim().length === 0) return [];
    let list: unknown;
    try {
        list = container.soundManager.music.getAllInstancesOf(aliasForName(name));
    } catch {
        return [];
    }
    return (Array.isArray(list) ? list : []).filter(
        (instance): instance is MusicInstanceHandle =>
            !!instance && typeof (instance as MusicInstanceHandle).id === "number" && (instance as MusicInstanceHandle).isDisposed !== true
    );
}

/** Fade music instances to silence, then stop them (a faded loop keeps playing silently). */
function fadeOutAndStopMusic(instances: MusicInstanceHandle[], seconds: number): void {
    const music = container.soundManager.music;
    for (const instance of instances) {
        const stop = (): void => {
            try {
                music.stop(instance.id);
            } catch {
                /* already stopped */
            }
        };
        let timeline: { eventCallback?(type: string, callback: () => void): unknown } | undefined;
        if (seconds > 0) {
            try {
                timeline = music.fade(instance.id, { toVolume: 0, duration: seconds });
            } catch {
                timeline = undefined;
            }
        }
        if (timeline && typeof timeline.eventCallback === "function") timeline.eventCallback("onComplete", stop);
        else stop();
    }
}

/**
 * Play a one-shot SFX cue by SCOPE-QUALIFIED bucket-relative path.
 *
 * The narrow seam for NON-node runtime components that own an authored audio
 * ref (currently per-symbol reels win audio). It deliberately reuses this
 * module's single `registeredAudioPaths` registry and the same bus-routed play
 * path as `playSound` — a second registry over the same alias space would
 * silently drift, and bypassing the bus would leave the mixer's gain, pitch,
 * voice-limit and auto-ducking bookkeeping wrong.
 *
 * `path` is expected to be scope-qualified by the CALLER (`core/<ref>` or
 * `skins/<skin>/<ref>`), because the alias / dedup key IS the path and two
 * same-basename files in core vs a skin must not collide.
 *
 * Absence-safe (see the module header): `opts` and every field on it were
 * appended later, so each is normalised from the TYPE default, and an
 * empty/non-string path is a silent no-op rather than a warning — an unset
 * per-symbol cue is the common case, not an error. Never throws.
 */
export async function playOrcaAudioPath(
    path: string,
    opts?: { volume?: number; pitch?: number; bus?: string; label?: string }
): Promise<void> {
    if (typeof path !== "string" || path.trim().length === 0) return;
    const label = typeof opts?.label === "string" && opts.label.trim().length > 0
        ? opts.label.trim()
        : "playOrcaAudioPath";
    try {
        await playOnBus({
            group: "sfx",
            label: label,
            name: path,
            volume: normaliseVolume(opts?.volume as number),
            loop: false,
            pitch: normalisePitch(opts?.pitch as number),
            fadeIn: 0,
            pan: 0,
            bus: typeof opts?.bus === "string" ? opts.bus : "",
        });
    } catch (err) {
        console.warn(`[FlowState audio] ${label}: play failed, skipping:`, path, err);
    }
}


class AudioMethods {
    /**
     * Play a sound effect by name or bucket-relative path.
     *
     * Every parameter after `volume` was appended later, so all of them are
     * absence-safe: a legacy graph exports `false` / `0` / `''` for them.
     */
    async playSound(
        soundName: string,
        volume: number,
        loop: boolean,
        pitch: number,
        fadeIn: number,
        pan: number,
        bus: string
    ): Promise<void> {
        await playOnBus({
            group: "sfx",
            label: "playSound",
            name: soundName,
            volume: normaliseVolume(volume),
            loop: loop === true,
            pitch: normalisePitch(pitch),
            fadeIn: normaliseDuration(fadeIn),
            pan: normalisePan(pan),
            bus: bus,
        });
    }

    /**
     * Play one of up to five sound effects at random, with optional volume and
     * pitch variation. Both jitters default to 0, so an unset node is
     * deterministic.
     */
    async playRandomSound(
        sound1: string,
        sound2: string,
        sound3: string,
        sound4: string,
        sound5: string,
        volume: number,
        volumeJitter: number,
        pitchJitter: number,
        bus: string
    ): Promise<void> {
        const candidates = [sound1, sound2, sound3, sound4, sound5]
            .filter((name) => typeof name === "string" && name.trim().length > 0);
        if (candidates.length === 0) {
            console.warn("[FlowState audio] playRandomSound: no sounds configured, skipping.");
            return;
        }

        const picked = candidates[Math.floor(Math.random() * candidates.length)];
        const baseVolume = normaliseVolume(volume);
        const jitteredVolume = baseVolume * jitterFactor(normaliseJitter(volumeJitter));

        await playOnBus({
            group: "sfx",
            label: "playRandomSound",
            name: picked,
            volume: jitteredVolume > 0 ? jitteredVolume : 0,
            loop: false,
            pitch: clampRate(jitterFactor(normaliseJitter(pitchJitter))),
            fadeIn: 0,
            pan: 0,
            bus: bus,
        });
    }
    
    /** Stop a specific sound effect by its instance ID */
    stopSound(soundId: number): void {
        container.soundManager.sfx.stop(soundId);
        unregisterVoice(soundId);
        noteVoiceEnded(ORCA_AUDIO_DEFAULT_SFX_BUS);
    }
    
    /** Stop all currently playing sound effects */
    stopAllSounds(): void {
        container.soundManager.sfx.stopAll();
        unregisterVoicesInGroup("sfx");
        refreshAutoDucking();
    }
    
    /** Pause a specific sound effect by its instance ID */
    pauseSound(soundId: number): void {
        container.soundManager.sfx.pause(soundId);
    }
    
    /** Pause all currently playing sound effects */
    pauseAllSounds(): void {
        container.soundManager.sfx.pauseAll();
    }
    
    /**
     * Play a music track by name or bucket-relative path.
     *
     * Every parameter after `volume` was appended later and is absence-safe.
     */
    async playMusic(
        musicName: string,
        volume: number,
        loop: boolean,
        pitch: number,
        fadeIn: number,
        bus: string
    ): Promise<void> {
        await playOnBus({
            group: "music",
            label: "playMusic",
            name: musicName,
            volume: normaliseVolume(volume),
            loop: loop === true,
            pitch: normalisePitch(pitch),
            fadeIn: normaliseDuration(fadeIn),
            pan: 0,
            bus: bus,
        });
    }
    
    /** Pause a specific music track by its instance ID */
    pauseMusic(musicId: number): void {
        container.soundManager.music.pause(musicId);
    }
    
    /** Pause all currently playing music tracks */
    pauseAllMusic(): void {
        container.soundManager.music.pauseAll();
    }
    
    /** Stop a specific music track by its instance ID */
    stopMusic(musicId: number): void {
        container.soundManager.music.stop(musicId);
        unregisterVoice(musicId);
        noteVoiceEnded(ORCA_AUDIO_DEFAULT_MUSIC_BUS);
    }
    
    /** Stop all currently playing music tracks */
    stopAllMusic(): void {
        container.soundManager.music.stopAll();
        unregisterVoicesInGroup("music");
        refreshAutoDucking();
    }
    
    /**
     * Crossfade between two music tracks (name or bucket-relative path) over a
     * duration (seconds).
     *
     * Built on this module's own play path instead of the package `crossfade`,
     * which fades ONE outgoing instance and never stops it: the silent loop it
     * left behind was taken as the outgoing track of the next crossfade, so the
     * audible copy never faded and every round trip stacked another copy.
     *
     * Every live instance of the outgoing track (and any earlier copy of the
     * incoming one) fades out and stops, so exactly one copy of the target is
     * left playing. The target fades in on the outgoing track's bus at its
     * authored volume, or at full volume when nothing was playing.
     */
    async crossfadeMusic(fromMusicName: string, toMusicName: string, duration: number): Promise<void> {
        if ((await resolvePlayableAlias(toMusicName)) === null) {
            console.warn("[FlowState audio] crossfadeMusic: target music failed to load, skipping:", toMusicName);
            return;
        }
        const seconds = normaliseDuration(duration);
        const outgoing = liveMusicInstances(fromMusicName);
        const lead = outgoing.length > 0 ? getVoice(outgoing[outgoing.length - 1].id) : undefined;
        const retiring = [...outgoing, ...liveMusicInstances(toMusicName).filter((i) => !outgoing.includes(i))];
        // Out of the mixer first: a voice limit would otherwise steal them
        // outright, and a bus gain change would undo the fade.
        for (const instance of retiring) unregisterVoice(instance.id);
        await playOnBus({
            group: "music",
            label: "crossfadeMusic",
            name: toMusicName,
            volume: lead ? lead.baseVolume : 1,
            loop: true,
            pitch: lead ? lead.basePitch : 1,
            fadeIn: seconds,
            pan: 0,
            bus: lead ? lead.busId : "",
        });
        fadeOutAndStopMusic(retiring, seconds);
    }
    /** Resume a paused sound effect by its instance ID */
    resumeSound(soundId: number): void {
        container.soundManager.sfx.resume(soundId);
    }
    
    /** Resume all paused sound effects */
    resumeAllSounds(): void {
        container.soundManager.sfx.resumeAll();
    }
    
    /** Resume a paused music track by its instance ID */
    resumeMusic(musicId: number): void {
        container.soundManager.music.resume(musicId);
    }
    
    /** Resume all paused music tracks */
    resumeAllMusic(): void {
        container.soundManager.music.resumeAll();
    }
    
    /** Mute all sound effects */
    muteSounds(): void {
        container.soundManager.sfx.mute();
    }
    
    /** Unmute all sound effects */
    unmuteSounds(): void {
        container.soundManager.sfx.unmute();
    }
    
    /** Mute all music */
    muteMusic(): void {
        container.soundManager.music.mute();
    }
    
    /** Unmute all music */
    unmuteMusic(): void {
        container.soundManager.music.unmute();
    }
    
    /** Fade a sound effect to a target volume over a duration (seconds) */
    fadeSound(soundId: number, toVolume: number, duration: number): void {
        container.soundManager.sfx.fade(soundId, { toVolume: toVolume, duration: duration });
    }
    
    /** Fade a music track to a target volume over a duration (seconds) */
    fadeMusic(musicId: number, toVolume: number, duration: number): void {
        container.soundManager.music.fade(musicId, { toVolume: toVolume, duration: duration });
    }

    /**
     * Set a live sound's volume, optionally ramping over `duration` seconds.
     *
     * Updates the tracked voice's BASE volume so later bus-fader moves stay
     * relative to it. An untracked instance id falls back to a raw SFX fade.
     */
    setSoundVolume(soundId: number, volume: number, duration: number): void {
        const target = normaliseVolume(volume);
        const seconds = normaliseDuration(duration);
        const voice = getVoice(soundId);
        if (!voice) {
            try {
                container.soundManager.sfx.fade(soundId, { toVolume: target, duration: seconds > 0 ? seconds : 0.01 });
            } catch (err) {
                console.warn("[FlowState audio] setSoundVolume: untracked sound, fade failed:", soundId, err);
            }
            return;
        }
        voice.baseVolume = target;
        try {
            getSoundGroup(voice.group).fade(soundId, {
                toVolume: target * effectiveGain(voice.busId),
                duration: seconds > 0 ? seconds : 0.01,
            });
        } catch (err) {
            console.warn("[FlowState audio] setSoundVolume failed:", soundId, err);
        }
    }

    /**
     * Set a live sound's pitch (playback rate), folded with its bus pitch.
     * Requires a trackable instance handle; warns and no-ops otherwise.
     */
    setSoundPitch(soundId: number, pitch: number): void {
        const voice = getVoice(soundId);
        if (!voice) {
            console.warn("[FlowState audio] setSoundPitch: untracked sound id, skipping:", soundId);
            return;
        }
        voice.basePitch = normalisePitch(pitch);
        applyVoiceRate(voice);
    }

    /**
     * Pan a live sound left (-1) to right (+1).
     *
     * PER-INSTANCE (howler `stereo`) and WebAudio-only: it pans just this sound
     * id, and no-ops on the HTMLAudio/iOS fallback.
     */
    setSoundPan(soundId: number, pan: number): void {
        const voice = getVoice(soundId);
        if (!voice) {
            console.warn("[FlowState audio] setSoundPan: untracked sound id, skipping:", soundId);
            return;
        }
        setInstancePan(voice.instance, normalisePan(pan));
    }

    /**
     * Turn looping on/off for a live sound. Requires a trackable instance
     * handle; warns and no-ops otherwise.
     */
    setSoundLoop(soundId: number, loop: boolean): void {
        const voice = getVoice(soundId);
        if (!voice || voice.instance === null || typeof voice.instance !== "object") {
            console.warn("[FlowState audio] setSoundLoop: untracked sound id, skipping:", soundId);
            return;
        }
        try {
            (voice.instance as { loop?: boolean }).loop = loop === true;
        } catch (err) {
            console.warn("[FlowState audio] setSoundLoop failed:", soundId, err);
        }
    }

    /**
     * Downmix a sound to mono (or back to stereo) by alias.
     *
     * UNSUPPORTED — this was a `@pixi/sound` `MonoFilter`, and `@pixi/sound` is
     * no longer part of the stack. The howler-backed sound manager exposes no
     * mono downmix, so the node warns ONCE and no-ops rather than pretending to
     * work. The node surface is kept so existing graphs keep loading unchanged;
     * author a mono source file if a mono mix is genuinely needed.
     */
    setSoundMono(soundName: string, mono: boolean): void {
        void mono;
        noteMonoUnsupported(soundName);
    }
    
    /** Stop all instances of a sound effect by name or bucket-relative path */
    stopAllInstancesOfSound(soundName: string): void {
        if (!audioAliasExists(soundName)) {
            console.warn("[FlowState audio] stopAllInstancesOfSound: unknown sound name, skipping:", soundName);
            return;
        }
        container.soundManager.sfx.stopAllInstancesOf(soundName);
        unregisterVoicesByAlias(soundName);
        refreshAutoDucking();
    }
    
    /** Stop all instances of a music track by name */
    stopAllInstancesOfMusic(musicName: string): void {
        if (!audioAliasExists(musicName)) {
            console.warn("[FlowState audio] stopAllInstancesOfMusic: unknown music name, skipping:", musicName);
            return;
        }
        container.soundManager.music.stopAllInstancesOf(musicName);
        unregisterVoicesByAlias(musicName);
        refreshAutoDucking();
    }
    
    /** Pause all instances of a sound effect by name or bucket-relative path */
    pauseAllInstancesOfSound(soundName: string): void {
        if (!audioAliasExists(soundName)) {
            console.warn("[FlowState audio] pauseAllInstancesOfSound: unknown sound name, skipping:", soundName);
            return;
        }
        container.soundManager.sfx.pauseAllInstancesOf(soundName);
    }
    
    /** Pause all instances of a music track by name */
    pauseAllInstancesOfMusic(musicName: string): void {
        if (!audioAliasExists(musicName)) {
            console.warn("[FlowState audio] pauseAllInstancesOfMusic: unknown music name, skipping:", musicName);
            return;
        }
        container.soundManager.music.pauseAllInstancesOf(musicName);
    }
    
    /** Resume all instances of a sound effect by name or bucket-relative path */
    resumeAllInstancesOfSound(soundName: string): void {
        if (!audioAliasExists(soundName)) {
            console.warn("[FlowState audio] resumeAllInstancesOfSound: unknown sound name, skipping:", soundName);
            return;
        }
        container.soundManager.sfx.resumeAllInstancesOf(soundName);
    }
    
    /** Resume all instances of a music track by name */
    resumeAllInstancesOfMusic(musicName: string): void {
        if (!audioAliasExists(musicName)) {
            console.warn("[FlowState audio] resumeAllInstancesOfMusic: unknown music name, skipping:", musicName);
            return;
        }
        container.soundManager.music.resumeAllInstancesOf(musicName);
    }
    
    /** Play a dynamic music playlist with optional random order */
    playDynamicMusic(trackNames: string[], random: boolean): void {
        container.soundManager.music.playDynamic(trackNames, { randomPlayOrder: random });
    }
    
    /** Stop the dynamic music playlist */
    stopDynamicMusic(): void {
        container.soundManager.music.stopDynamic();
    }
    
    /** Seek a sound effect to a specific position (seconds) */
    seekSound(soundId: number, start: number): void {
        container.soundManager.sfx.seek(soundId, start);
    }
    
    /** Seek a music track to a specific position (seconds) */
    seekMusic(musicId: number, start: number): void {
        container.soundManager.music.seek(musicId, start);
    }
    
    /** Resume the sound manager after suspension */
    resumeSoundManager(): void {
        container.soundManager.resume();
    }
    
    /** Suspend the sound manager (pause all audio processing) */
    suspendSoundManager(): void {
        container.soundManager.suspend();
    }
    
    /** Stop all audio (both SFX and music) */
    stopAllAudio(): void {
        container.soundManager.stopAll();
        unregisterAllVoices();
        refreshAutoDucking();
    }
    
    /** Reset the sound manager to its initial state */
    resetSoundManager(): void {
        // The sound manager has no `reset()`, so this is composed from the
        // documented API: stop every track (dynamic playlist included), then
        // restore the default mute/volume state. Loaded sounds are deliberately
        // NOT released — that is what `releaseAudio` is for.
        container.soundManager.music.stopDynamic();
        container.soundManager.stopAll();
        container.soundManager.sfx.unmute();
        container.soundManager.music.unmute();
        container.soundManager.globalVolume = 1;
        unregisterAllVoices();
        refreshAutoDucking();
    }
    
    /** Release audio resources by key to free memory */
    releaseAudio(...keys: string[]): void {
        container.soundManager.release(...keys);
    }
}

export const audio = new AudioMethods();