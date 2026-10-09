/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                             ANIMATION PLAYER                                 ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║ Singleton that registers and plays Animation Timeline clips authored in the  ║
 * ║ Orca editor (`.wave` files, mirrored into the runtime as JSON).              ║
 * ║                                                                              ║
 * ║ Clips live in two trees, exactly like scenes and flowstate graphs:           ║
 * ║   core/animation-data/**\/<name>.json          (always loaded)               ║
 * ║   skins/<skin>/animation-data/**\/<name>.json  (active skin only, via the    ║
 * ║                                                 generated index)             ║
 * ║                                                                              ║
 * ║ A gsap timeline is the CLOCK (play / pause / seek / speed / loop) and fires  ║
 * ║ the event keys. Property tracks are NOT gsap tweens: on every timeline       ║
 * ║ update each track is SAMPLED with `animation-curves.ts` — the byte-identical ║
 * ║ twin of the editor's evaluator — and handed to `SceneManager               ║
 * ║ .applyAnimatedValues`, which resolves the channel with the editor preview's  ║
 * ║ authored semantics (`animation-channels.ts`). So what the editor plots is    ║
 * ║ what the game plays, including Bezier handles, per-channel colour blends,    ║
 * ║ parent-anchored x/y, sized sprites, text / graphics / filter channels.       ║
 * ║                                                                              ║
 * ║ Every failure path is warn-and-continue: a malformed clip, a missing scene   ║
 * ║ node, or an unknown method name degrades to a no-op so a broken clip can     ║
 * ║ never throw into the FlowState walker.                                       ║
 * ║                                                                              ║
 * ║ `@skeleton.state` keys (a skeleton's ROOT clip) are not written to the node: ║
 * ║ when the sampled index changes, the animation at that index in the           ║
 * ║ skeleton's list (`gameData.orcaSkeletal.clips`) starts from its beginning,   ║
 * ║ replacing the one the previous state started. A root clip that ends keeps    ║
 * ║ its last state playing; stopping it stops that animation too.                ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import gsap from 'gsap';
import { ACTIVE_SKIN, ACTIVE_SKIN_NAME } from './active-skin';
import { parseAnimationChannel } from './animation-channels';
import { sampleCurveTrack, type CurveBezierPoints, type CurveHandle } from './animation-curves';
import { SKIN_ANIMATIONS } from './generated-skin-animations';
import { animatedSprite } from './methods/animated-sprite';
import type { NodeRefLike } from './methods/node-ref';
import { nodeRefId, resolveNode } from './methods/node-ref';
import { particles } from './methods/particles';
import { spine } from './methods/spine';
import { text } from './methods/text';
import { video } from './methods/video';
import sceneManager from './scene-manager';

// ─────────────────────────────────────────────────────────────────────────────
// Clip data shape (mirrors the editor's `.wave` authoring format 1:1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Curve leaving a key: `step` holds, `linear` is straight, `bezier` is shaped by
 * the keys' handles (automatic when absent). The CSS-style names are LEGACY
 * presets that still play exactly as they did.
 */
export type AnimationInterpolation =
    | 'linear'
    | 'step'
    | 'ease'
    | 'easeIn'
    | 'easeOut'
    | 'easeInOut'
    | 'bezier';

export interface AnimationKeyframe {
    /** Seconds from the start of the clip. */
    time: number;
    value: number | boolean;
    interpolation?: AnimationInterpolation;
    /** Legacy gsap overshoot knob; kept so old files load, never read. */
    easeStrength?: number;
    /** LEGACY normalised control points; see `animation-curves.ts`. */
    bezier?: CurveBezierPoints;
    /** Incoming Bezier handle `[dt <= 0, dv]`. Absent = automatic. */
    inHandle?: CurveHandle;
    /** Outgoing Bezier handle `[dt >= 0, dv]`. Absent = automatic. */
    outHandle?: CurveHandle;
    broken?: boolean;
}

export interface AnimationPropertyTrack {
    kind: 'property';
    id: string;
    /** Channel key (`x`, `scale.x`, `@text.fontSize`, `@filter.0.BlurFilter.strength`, …). */
    property: string;
    label?: string;
    valueType: 'number' | 'boolean' | 'color';
    keyframes: AnimationKeyframe[];
}

export interface AnimationEventKeyframe {
    /** Seconds from the start of the clip. */
    time: number;
    method: string;
    args: (string | number | boolean)[];
}

export interface AnimationEventTrack {
    kind: 'event';
    id: string;
    component: 'spine' | 'particles' | 'animatedSprite' | 'video' | 'text';
    label?: string;
    keyframes: AnimationEventKeyframe[];
}

export type AnimationTrack = AnimationPropertyTrack | AnimationEventTrack;

export interface AnimationTargetGroup {
    id: string;
    /**
     * Typed `NodeRefLike` (rather than `NodeRefValue`) so a per-skin
     * `nodeRefBySkin` authored via `skinNodeReference` passes straight through
     * to `resolveNode`, which owns the ACTIVE_SKIN_NAME collapse.
     */
    target: NodeRefLike;
    label?: string;
    tracks: AnimationTrack[];
}

export interface AnimationClipFile {
    version: 1;
    clipId: string;
    name: string;
    /** Total clip length in SECONDS (trailing dead time included). */
    duration: number;
    frameRate: number;
    loop: boolean;
    targets: AnimationTargetGroup[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Clip references — the three authoring shapes, mirroring methods/scene.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-skin animation reference (from the `skinAnimationReference` provider).
 * Keyed by the REAL authoring skin name (`main.orca.skins[i].name`, NOT the
 * effective runtime folder) and collapsed to the active skin's entry via
 * `ACTIVE_SKIN_NAME`. A skin with no entry collapses to `null` (blank → the
 * consumer node no-ops). Mirrors `SceneRefBySkinIn` in methods/scene.ts.
 */
export interface AnimationRefBySkinIn {
    kind: 'animationRefBySkin';
    bySkin: Record<string, { scope?: 'core' | 'skin'; skin?: string; name: string }>;
}

export type AnimationRefLike =
    | string
    | { scope?: 'core' | 'skin'; skin?: string; name: string }
    | AnimationRefBySkinIn
    | null
    | undefined;

interface NormalisedAnimationRef {
    scope?: 'core' | 'skin';
    skin?: string;
    name: string;
}

/** True when `arg` looks like a per-skin wrapper carrying a `bySkin` map. */
function isAnimationRefBySkin(arg: any): arg is AnimationRefBySkinIn {
    return arg != null && typeof arg === 'object' && arg.kind === 'animationRefBySkin'
        && arg.bySkin != null && typeof arg.bySkin === 'object';
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type GsapTimeline = ReturnType<typeof gsap.timeline>;

type AnimationClipModule = AnimationClipFile | { default?: AnimationClipFile };
type AnimationClipContext = {
    keys(): string[];
    (key: string): AnimationClipModule;
};

/** Discrete component modules an event track may dispatch to. */
const EVENT_MODULES: Record<string, Record<string, unknown>> = {
    spine: spine as unknown as Record<string, unknown>,
    particles: particles as unknown as Record<string, unknown>,
    animatedSprite: animatedSprite as unknown as Record<string, unknown>,
    video: video as unknown as Record<string, unknown>,
    text: text as unknown as Record<string, unknown>,
};

function unwrapClip(moduleValue: AnimationClipModule): AnimationClipFile {
    return ((moduleValue as { default?: AnimationClipFile }).default ?? (moduleValue as AnimationClipFile));
}

/** One target node's property tracks, resolved once when the clip starts. */
interface PreparedTarget {
    nodeId: string;
    tracks: AnimationPropertyTrack[];
    /** `@skeleton.state` tracks — they switch the skeleton's animation instead of writing a value. */
    stateTracks: AnimationPropertyTrack[];
}

/** A running clip plus its (at most one) pending flow-completion callback. */
interface RunningClip {
    key: string;
    timeline: GsapTimeline;
    targets: PreparedTarget[];
    settle: (() => void) | null;
    /** Unsubscribe from SceneManager's after-draw hook. */
    detach: (() => void) | null;
    /** Per skeleton node: the state index last applied and the animation it started. */
    states: Map<string, { index: number; key: string | null }>;
}

// ─────────────────────────────────────────────────────────────────────────────

class AnimationPlayer {
    /** Scope-qualified key (`core/<name>` | `skins/<skin>/<name>`) → clip. */
    private clips: Map<string, AnimationClipFile> = new Map();

    /** Scope-qualified key → the live gsap timeline currently playing it. */
    private running: Map<string, RunningClip> = new Map();

    // ── Registry ────────────────────────────────────────────────────

    /**
     * Build the clip registry from the core `require.context` and the
     * generated active-skin index. Safe to call more than once — any running
     * timelines are stopped and the registry is rebuilt from scratch.
     */
    public init(): void {
        this.stopAll();
        this.clips.clear();

        try {
            const coreCtx = (require as any).context('../../animation-data', true, /\.json$/i) as AnimationClipContext;
            const keys = coreCtx.keys().sort((a, b) => a.localeCompare(b));
            for (const key of keys) {
                const m = key.match(/^\.\/(.+)\.json$/i);
                if (!m) continue;
                const [, relName] = m;
                this.register(`core/${relName}`, unwrapClip(coreCtx(key)), key);
            }
        } catch (err) {
            console.warn('[Animation] No core/animation-data folder found', err);
        }

        try {
            for (const [relName, raw] of Object.entries(SKIN_ANIMATIONS)) {
                this.register(
                    `skins/${ACTIVE_SKIN}/${relName}`,
                    raw as AnimationClipFile,
                    `skin/${ACTIVE_SKIN}/animation-data/${relName}.json`,
                );
            }
        } catch (err) {
            console.warn('[Animation] Failed to load skin animation clips', err);
        }
    }

    private register(key: string, clip: AnimationClipFile, sourceLabel: string): void {
        if (!this.isClipData(clip)) {
            console.warn(`[Animation] Ignoring invalid animation clip file: ${sourceLabel}`);
            return;
        }
        this.clips.set(key, clip);
    }

    private isClipData(value: unknown): value is AnimationClipFile {
        if (!value || typeof value !== 'object') return false;
        const clip = value as Partial<AnimationClipFile>;
        return Number.isFinite(clip.duration) && Array.isArray(clip.targets);
    }

    /**
     * Collapse any of the three authoring shapes down to the scope-qualified
     * registry key, or `null` when the clip is unknown / the active skin has
     * no entry. A scope-less (legacy bare string) name resolves skin-first,
     * then core.
     */
    public resolveKey(arg: AnimationRefLike): string | null {
        const ref = this.normaliseAnimationArg(arg);
        if (!ref) return null;

        if (ref.scope === 'skin') {
            // Sandbox: a skin-scoped ref must target the active skin.
            if (ref.skin && ref.skin !== ACTIVE_SKIN) {
                console.warn(
                    `[Animation] Clip ref targets skin "${ref.skin}" but active skin is "${ACTIVE_SKIN}"`,
                );
                return null;
            }
            const skinKey = `skins/${ACTIVE_SKIN}/${ref.name}`;
            return this.clips.has(skinKey) ? skinKey : null;
        }

        if (ref.scope === 'core') {
            const coreKey = `core/${ref.name}`;
            return this.clips.has(coreKey) ? coreKey : null;
        }

        const skinKey = `skins/${ACTIVE_SKIN}/${ref.name}`;
        if (this.clips.has(skinKey)) return skinKey;
        const coreKey = `core/${ref.name}`;
        return this.clips.has(coreKey) ? coreKey : null;
    }

    private normaliseAnimationArg(arg: AnimationRefLike): NormalisedAnimationRef | null {
        if (arg === null || arg === undefined) return null;

        // Per-skin wrapper collapses FIRST — select THIS skin's entry, keyed by
        // the REAL authoring skin name, exactly as the editor bakes it. As in
        // methods/scene.ts the per-entry `skin` is deliberately DROPPED: the
        // selected entry is by construction already the active skin's ref, so
        // the sandbox above must not compare a real skin name against the
        // EFFECTIVE runtime folder (rule 14 gameId/tileName overrides).
        if (isAnimationRefBySkin(arg)) {
            const entry = arg.bySkin[ACTIVE_SKIN_NAME];
            if (!entry || !entry.name) return null;
            return { scope: entry.scope, name: entry.name };
        }

        if (typeof arg === 'string') {
            return arg ? { name: arg } : null;
        }
        if (typeof arg === 'object' && typeof (arg as { name?: unknown }).name === 'string') {
            const a = arg as { scope?: 'core' | 'skin'; skin?: string; name: string };
            if (!a.name) return null;
            return { scope: a.scope, skin: a.skin, name: a.name };
        }
        return null;
    }

    // ── Playback ────────────────────────────────────────────────────

    /**
     * Start (or restart) a clip. Returns false when the clip is unknown or its
     * timeline could not be built, so a blocking caller can settle immediately
     * instead of awaiting a tween that will never run.
     *
     * `loop` falls back to the clip's authored `loop` flag when omitted. A
     * looping clip never completes, so `onComplete` is invoked right away
     * (with a warn) rather than being held forever.
     */
    public play(key: string, loop?: boolean, onComplete?: () => void): boolean {
        const clip = this.clips.get(key);
        if (!clip) {
            console.warn(`[Animation] Unknown animation clip "${key}"`);
            return false;
        }

        // Re-playing an already-running clip kills the previous timeline first
        // (and settles whoever was awaiting it, so the walker can't deadlock).
        this.stop(key);

        const shouldLoop = typeof loop === 'boolean' ? loop : clip.loop === true;
        const entry: RunningClip = { key, timeline: null as unknown as GsapTimeline, targets: [], settle: null, detach: null, states: new Map() };
        const timeline = gsap.timeline({
            paused: true,
            repeat: shouldLoop ? -1 : 0,
            onUpdate: () => { this.applyAt(entry, timeline.time()); },
            onComplete: () => { this.finish(key); },
        });
        entry.timeline = timeline;

        try {
            entry.targets = this.buildTimeline(timeline, clip);
        } catch (err) {
            console.warn(`[Animation] Failed to build timeline for clip "${key}"`, err);
            try { timeline.kill(); } catch { /* ignored */ }
            return false;
        }

        if (shouldLoop && onComplete) {
            console.warn(
                `[Animation] Clip "${key}" loops forever; the flow will not be blocked on its completion.`,
            );
        }

        entry.settle = shouldLoop ? null : (onComplete ?? null);
        // A resize / orientation change re-poses the tree; re-assert what this clip owns.
        if (entry.targets.length > 0) {
            entry.detach = sceneManager.onAfterDraw(() => { this.applyAt(entry, timeline.time()); });
        }
        this.running.set(key, entry);
        // Pose frame 0 immediately so the first rendered frame is already the clip's.
        this.applyAt(entry, 0);
        timeline.play();
        if (shouldLoop && onComplete) onComplete();
        return true;
    }

    /** Kill a running clip's timeline and settle any pending awaiter. */
    public stop(key: string): void {
        const entry = this.running.get(key);
        if (!entry) return;
        this.running.delete(key);
        try { entry.timeline.kill(); } catch { /* ignored */ }
        this.release(entry, true);
    }

    public pause(key: string): void {
        const entry = this.running.get(key);
        if (!entry) return;
        try { entry.timeline.pause(); } catch (err) { console.warn(`[Animation] pause failed for "${key}"`, err); }
    }

    public resume(key: string): void {
        const entry = this.running.get(key);
        if (!entry) return;
        try { entry.timeline.resume(); } catch (err) { console.warn(`[Animation] resume failed for "${key}"`, err); }
    }

    /** Scrub a running clip to an absolute time in seconds. */
    public seek(key: string, seconds: number): void {
        const entry = this.running.get(key);
        if (!entry) return;
        if (!Number.isFinite(seconds)) {
            console.warn(`[Animation] setAnimationClipTime ignored: "${seconds}" is not a finite time`);
            return;
        }
        try {
            entry.timeline.seek(Math.max(0, seconds));
            this.applyAt(entry, entry.timeline.time());
        } catch (err) {
            console.warn(`[Animation] seek failed for "${key}"`, err);
        }
    }

    /** Playback-rate multiplier (1 = authored speed, 0 = frozen, <0 = reverse). */
    public setSpeed(key: string, multiplier: number): void {
        const entry = this.running.get(key);
        if (!entry) return;
        if (!Number.isFinite(multiplier)) {
            console.warn(`[Animation] setAnimationClipSpeed ignored: "${multiplier}" is not a finite multiplier`);
            return;
        }
        try { entry.timeline.timeScale(multiplier); } catch (err) { console.warn(`[Animation] setSpeed failed for "${key}"`, err); }
    }

    /**
     * Kill every running timeline. Called by SceneManager on scene teardown so
     * timelines can never touch a destroyed DisplayObject.
     */
    public stopAll(): void {
        for (const key of Array.from(this.running.keys())) {
            this.stop(key);
        }
    }

    // ── Timeline construction ───────────────────────────────────────

    /** Adds the event calls + duration pad, and returns the property targets to sample. */
    private buildTimeline(timeline: GsapTimeline, clip: AnimationClipFile): PreparedTarget[] {
        const groups = Array.isArray(clip.targets) ? clip.targets : [];
        const prepared: PreparedTarget[] = [];

        for (const group of groups) {
            if (!group || !Array.isArray(group.tracks)) continue;

            // Resolve ONCE per group — `resolveNode` / `nodeRefId` own the per-skin collapse.
            const obj = resolveNode<any>(group.target);
            const nodeId = nodeRefId(group.target);
            if (!obj || !nodeId) {
                console.warn(
                    `[Animation] Clip "${clip.name}" target "${group.label ?? group.id}" is not in the current scene tree; skipping its tracks.`,
                );
                continue;
            }

            const tracks: AnimationPropertyTrack[] = [];
            const stateTracks: AnimationPropertyTrack[] = [];
            for (const track of group.tracks) {
                if (!track) continue;
                if (track.kind === 'event') {
                    this.addEventTrack(timeline, group, track);
                    continue;
                }
                const property = typeof track.property === 'string' ? track.property.trim() : '';
                if (!property) {
                    console.warn(`[Animation] Clip "${clip.name}" has a property track with no channel; skipping.`);
                    continue;
                }
                const keyframes = (Array.isArray(track.keyframes) ? track.keyframes : [])
                    .filter((kf): kf is AnimationKeyframe => !!kf && Number.isFinite(kf.time))
                    .slice()
                    .sort((a, b) => a.time - b.time);
                if (keyframes.length === 0) continue;
                const shaped: AnimationPropertyTrack = { ...(track as AnimationPropertyTrack), property, keyframes };
                if (parseAnimationChannel(property).kind === 'state') stateTracks.push(shaped);
                else tracks.push(shaped);
            }
            if (tracks.length > 0 || stateTracks.length > 0) prepared.push({ nodeId, tracks, stateTracks });
        }

        // Pin the total duration so trailing dead time (and a clip whose last
        // keyframe lands early) is honoured. gsap's duration() setter RESCALES
        // the timeline, so pad with an empty tween instead.
        const duration = Number.isFinite(clip.duration) ? Math.max(0, clip.duration) : 0;
        if (duration > 0) timeline.to({}, { duration }, 0);
        return prepared;
    }

    /** Sample every property track at `time` and push the values to the scene. */
    private applyAt(entry: RunningClip, time: number): void {
        const at = Number.isFinite(time) ? time : 0;
        for (const target of entry.targets) {
            const writes: Array<{ property: string; value: number | boolean }> = [];
            for (const track of target.tracks) {
                const value = sampleCurveTrack(track, at);
                if (value !== null) writes.push({ property: track.property, value });
            }
            if (writes.length > 0) sceneManager.applyAnimatedValues(target.nodeId, writes);
            for (const track of target.stateTracks) {
                const value = sampleCurveTrack(track, at, true);
                if (typeof value === 'number') this.applyState(entry, target.nodeId, value);
            }
        }
    }

    /**
     * A skeleton's state changed: start the animation at `index` in its list
     * (from the start), stopping the one the previous state started.
     */
    private applyState(entry: RunningClip, nodeId: string, value: number): void {
        const index = Math.floor(value);
        const current = entry.states.get(nodeId);
        if (current && current.index === index) return;
        if (current?.key && current.key !== entry.key) this.stop(current.key);
        const marker = (sceneManager.getNodeDataById(nodeId) as { gameData?: Record<string, unknown> } | undefined)
            ?.gameData?.orcaSkeletal as { clips?: Array<{ scope?: 'core' | 'skin'; name?: string }> } | undefined;
        const ref = Array.isArray(marker?.clips) && index >= 0 ? marker!.clips[index] : undefined;
        // The per-entry skin is dropped (as for per-skin refs): the list was authored for the skin that plays it.
        const key = ref && typeof ref.name === 'string' ? this.resolveKey({ scope: ref.scope, name: ref.name }) : null;
        entry.states.set(nodeId, { index, key: key && key !== entry.key ? key : null });
        if (!ref) return;
        if (!key) {
            console.warn(`[Animation] Skeleton state ${index} names clip "${ref.name ?? '?'}", which is not loaded.`);
            return;
        }
        if (key !== entry.key) this.play(key);
    }

    private addEventTrack(timeline: GsapTimeline, group: AnimationTargetGroup, track: AnimationEventTrack): void {
        const mod = EVENT_MODULES[track.component];
        if (!mod) {
            console.warn(`[Animation] Unknown event-track component "${track.component}"; skipping track.`);
            return;
        }

        const keyframes = (Array.isArray(track.keyframes) ? track.keyframes : [])
            .filter((kf): kf is AnimationEventKeyframe => !!kf && Number.isFinite(kf.time) && typeof kf.method === 'string');

        for (const kf of keyframes) {
            if (typeof mod[kf.method] !== 'function') {
                console.warn(`[Animation] ${track.component} has no method "${kf.method}"; skipping keyframe.`);
                continue;
            }
            const args = Array.isArray(kf.args) ? kf.args : [];
            timeline.call(() => {
                try {
                    // Called off the module so `this` stays bound to the instance.
                    (mod as Record<string, (...a: unknown[]) => unknown>)[kf.method](group.target, ...args);
                } catch (err) {
                    console.warn(`[Animation] ${track.component}.${kf.method} threw`, err);
                }
            }, undefined, Math.max(0, kf.time));
        }
    }

    // ── Internals ───────────────────────────────────────────────────

    /** Natural end of a non-looping timeline: drop it and settle its awaiter (its last state keeps playing). */
    private finish(key: string): void {
        const entry = this.running.get(key);
        if (!entry) return;
        this.running.delete(key);
        this.release(entry, false);
    }

    private release(entry: RunningClip, stopStates: boolean): void {
        entry.detach?.();
        entry.detach = null;
        if (stopStates) {
            for (const state of entry.states.values()) {
                if (state.key) this.stop(state.key);
            }
        }
        entry.states.clear();
        const callback = entry.settle;
        entry.settle = null;
        if (!callback) return;
        try { callback(); } catch (err) { console.warn('[Animation] clip completion callback threw', err); }
    }
}

export default new AnimationPlayer();
