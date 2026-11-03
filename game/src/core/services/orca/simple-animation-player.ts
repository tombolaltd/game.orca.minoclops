/**
 * SIMPLE ANIMATION PLAYER — the runtime playhead behind a node's `simpleAnimation`
 * component (Flash-style keyframe clips; data + sampling in `simple-animation.ts`).
 *
 * PURE ON PURPOSE: no Pixi, no scene-manager, no FlowState import. The scene
 * manager builds one `SimpleAnimPlayer` per host node and injects the side effects —
 * `write` (the channel writes for one target node, routed through
 * `SceneManager.applyAnimatedValues`), `emit` (the FlowState starters) and
 * `warn`. That keeps the module graph acyclic and lets the editor's Node tests
 * drive the playhead with no renderer at all.
 *
 * PLAYBACK is frame based: `tick(deltaSeconds)` accumulates
 * `deltaSeconds × fps × speed` and steps WHOLE frames. Each step samples the
 * clip at the integer frame (`sampleSimpleAnimClip`) and writes the result. A looping
 * clip wraps to its first frame; a non-looping clip holds its last frame for
 * one frame, then stops there and reports 'complete' (plus the `onComplete`
 * the caller passed to `play`) ONCE.
 *
 * FRAMES on this API are 1-BASED, like Flash (`currentFrame`, `gotoAnd*`
 * numbers, event `frame`); the data in `simple-animation.ts` is 0-based.
 *
 * LABELS: entering a labelled frame reports 'label'. Entering means the
 * playhead ARRIVES while playing — a step, a loop wrap, or the frame
 * `play` / `gotoAndPlay` started on (reported on the next tick, never inside
 * the call, so a 'label' handler that jumps to its own label re-fires at frame
 * rate instead of recursing). `gotoAndStop` never reports a label.
 *
 * AWAITERS (`play(…, { onComplete })`) always settle exactly once: on the
 * natural end, or when the clip is replaced (`play` / `gotoAnd*`), stopped or
 * disposed — so a FlowState walker waiting on one can never deadlock. A
 * looping clip has no end, so its `onComplete` runs straight away.
 *
 * Shared by both game templates (byte-identical copies, every-open delivery).
 */

import {
    SIMPLE_ANIM_DEFAULT_FPS,
    findSimpleAnimClip,
    simpleAnimPropsToChannelWrites,
    normalizeSimpleAnimation,
    resolveSimpleAnimFrame,
    sampleSimpleAnimClip,
    type SimpleAnimationClip,
    type SimpleAnimationComponent,
} from './simple-animation';

export type OrcaSimpleAnimationEvent = 'complete' | 'label';

export interface OrcaSimpleAnimationEventInfo {
    /** The clip's name. */
    animation: string;
    /** The label's name ('label' events only). */
    label?: string;
    /** 1-based frame the event happened on. */
    frame: number;
}

export interface OrcaSimpleAnimationPlayOptions {
    /** Overrides the clip's authored `loop`. */
    loop?: boolean;
    /** Runs once: when the clip ends, or is replaced / stopped / disposed. Straight away for a looping clip. */
    onComplete?: () => void;
}

/**
 * The runtime handle a built node with an `simpleAnimation` component carries as
 * `__orcaSimpleAnimation` (and that `SceneManager.getSimpleAnimation(id)` returns).
 * Inert (every call a no-op, `play` / `gotoAnd*` false) once its node is
 * destroyed.
 */
export interface OrcaSimpleAnimationHandle {
    /** Play `name` (empty / omitted = the current, else the autoPlay, else the first clip) from frame 1. False when there is no such clip. */
    play(name?: string, opts?: OrcaSimpleAnimationPlayOptions): boolean;
    /** Pause at the current frame. */
    stop(): void;
    /**
     * Jump to a 1-BASED frame number or a label name, then play. `opts.onComplete`
     * settles like `play`'s (the FlowState `sequenceNodeOn: 'onComplete'` hook).
     */
    gotoAndPlay(frameOrLabel: number | string, name?: string, opts?: { onComplete?: () => void }): boolean;
    /** Jump to a 1-BASED frame number or a label name, then hold there. */
    gotoAndStop(frameOrLabel: number | string, name?: string): boolean;
    /** Playback-rate multiplier: 1 = authored fps, 0 = frozen. Negative values clamp to 0. */
    setSpeed(multiplier: number): void;
    /** The clip on the playhead, or null before anything has played. */
    readonly currentAnimation: string | null;
    /** 1-based; 0 when no clip is on the playhead. */
    readonly currentFrame: number;
    /** The current clip's length in frames; 0 when none. */
    readonly totalFrames: number;
    readonly isPlaying: boolean;
    /** Every clip name, in authored order. */
    animations(): string[];
    /** Subscribe to 'complete' (a non-looping clip ended) or 'label' (a labelled frame was entered). Returns an unsubscribe. */
    on(event: OrcaSimpleAnimationEvent, cb: (info: OrcaSimpleAnimationEventInfo) => void): () => void;
    isDisposed(): boolean;
}

/** One channel write, the shape `SceneManager.applyAnimatedValues` takes. */
export interface SimpleAnimChannelWrite {
    property: string;
    value: number | boolean;
}

/** Side effects the host injects into an {@link SimpleAnimPlayer}. Every hook is guarded — a throw is warned, never propagated. */
export interface SimpleAnimPlayerHooks {
    /** Write sampled channels onto the node with id `targetId`. */
    write(targetId: string, writes: SimpleAnimChannelWrite[]): void;
    /** Called after the handle's own listeners, for every event. */
    emit?(event: OrcaSimpleAnimationEvent, info: OrcaSimpleAnimationEventInfo, player: SimpleAnimPlayer): void;
    warn?(message: string): void;
}

/** Cap on whole frames stepped in one tick (a long stall must not stall the frame that follows it). */
const SIMPLE_ANIM_MAX_STEPS_PER_TICK = 1000;

const SIMPLE_ANIM_EMPTY_COMPONENT: SimpleAnimationComponent = { enabled: false, fps: SIMPLE_ANIM_DEFAULT_FPS, autoPlay: null, clips: [] };

export class SimpleAnimPlayer implements OrcaSimpleAnimationHandle {
    /** Host node id (re-keyed when a DDOL host is rebound). */
    public nodeId: string;
    /** Host node name (the starters' `nodeName`). */
    public nodeName: string;

    private readonly component: SimpleAnimationComponent;
    private readonly hooks: SimpleAnimPlayerHooks;
    private clip: SimpleAnimationClip | null = null;
    /** 0-based. */
    private frame = 0;
    private playing = false;
    private loop = false;
    private speed = 1;
    private accumulator = 0;
    /** The frame `play` / `gotoAndPlay` landed on still owes its 'label' (reported on the next tick). */
    private pendingEnter = false;
    private settle: (() => void) | null = null;
    private disposed = false;
    /** Bumped by every playhead move a listener could make, so a tick notices it was re-entered. */
    private generation = 0;
    private readonly labelsByClip = new Map<SimpleAnimationClip, Map<number, string>>();
    private readonly listeners: Record<OrcaSimpleAnimationEvent, Set<(info: OrcaSimpleAnimationEventInfo) => void>> = {
        complete: new Set(),
        label: new Set(),
    };

    constructor(raw: unknown, hooks: SimpleAnimPlayerHooks, host?: { id?: string; name?: string }) {
        this.component = normalizeSimpleAnimation(raw) ?? SIMPLE_ANIM_EMPTY_COMPONENT;
        this.hooks = hooks;
        this.nodeId = typeof host?.id === 'string' ? host.id : '';
        this.nodeName = typeof host?.name === 'string' ? host.name : '';
    }

    // ── Handle API ──────────────────────────────────────────────────────────

    public play(name?: string, opts?: OrcaSimpleAnimationPlayOptions): boolean {
        if (this.disposed) return false;
        const clip = this.pickClip(name, 'play');
        if (!clip) return false;
        const loop = typeof opts?.loop === 'boolean' ? opts.loop : clip.loop;
        this.place(clip, 0, true, loop, opts?.onComplete);
        return true;
    }

    public stop(): void {
        if (this.disposed) return;
        this.generation += 1;
        this.playing = false;
        this.accumulator = 0;
        this.pendingEnter = false;
        this.settlePending();
    }

    public gotoAndPlay(frameOrLabel: number | string, name?: string, opts?: { onComplete?: () => void }): boolean {
        return this.goto(frameOrLabel, name, true, opts?.onComplete);
    }

    public gotoAndStop(frameOrLabel: number | string, name?: string): boolean {
        return this.goto(frameOrLabel, name, false, undefined);
    }

    public setSpeed(multiplier: number): void {
        if (this.disposed) return;
        const value = Number(multiplier);
        if (!Number.isFinite(value)) {
            this.warn(`setSpeed: ignoring a non-numeric speed (${String(multiplier)}).`);
            return;
        }
        this.speed = Math.max(0, value);
    }

    public get currentAnimation(): string | null {
        return this.clip ? this.clip.name : null;
    }

    public get currentFrame(): number {
        return this.clip ? this.frame + 1 : 0;
    }

    public get totalFrames(): number {
        return this.clip ? this.clip.lengthFrames : 0;
    }

    public get isPlaying(): boolean {
        return this.playing && !this.disposed;
    }

    public animations(): string[] {
        return this.component.clips.map((clip) => clip.name);
    }

    public on(event: OrcaSimpleAnimationEvent, cb: (info: OrcaSimpleAnimationEventInfo) => void): () => void {
        const set = this.listeners[event];
        if (this.disposed || !set || typeof cb !== 'function') return () => { /* nothing subscribed */ };
        set.add(cb);
        return () => { set.delete(cb); };
    }

    public isDisposed(): boolean {
        return this.disposed;
    }

    // ── Host API (scene manager) ────────────────────────────────────────────

    /** Authored `enabled` (absent = true). A disabled component never auto-plays; flows / code may still play it. */
    public get enabled(): boolean {
        return this.component.enabled !== false;
    }

    /** Authored `fps` (normalised, 1 … 120). */
    public get fps(): number {
        return this.component.fps;
    }

    /** Current speed multiplier. */
    public get speedMultiplier(): number {
        return this.speed;
    }

    /**
     * Start the authored `autoPlay` clip — the scene-build hook. A no-op (false)
     * when disabled or no autoPlay is set; a dangling autoPlay name warns.
     */
    public startAutoPlay(): boolean {
        if (this.disposed || !this.enabled) return false;
        const name = this.component.autoPlay;
        if (!name) return false;
        if (!findSimpleAnimClip(this.component, name)) {
            this.warn(`autoPlay: no animation called "${name}" (available: ${this.describeClips()}).`);
            return false;
        }
        return this.play(name);
    }

    /** Advance the playhead by `deltaSeconds` (scaled by fps × speed). Never throws. */
    public tick(deltaSeconds: number): void {
        if (this.disposed || !this.playing || !this.clip) return;
        const gen = this.generation;
        if (this.pendingEnter) {
            this.pendingEnter = false;
            this.reportLabel(this.frame);
            if (gen !== this.generation || this.disposed || !this.playing) return;
        }
        if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
        const rate = this.component.fps * this.speed;
        if (!(rate > 0)) return;
        this.accumulator += deltaSeconds * rate;
        if (this.accumulator < 1) return;

        const clip = this.clip;
        const length = Math.max(1, clip.lengthFrames);
        let steps = Math.floor(this.accumulator);
        this.accumulator -= steps;
        if (steps > SIMPLE_ANIM_MAX_STEPS_PER_TICK) {
            // Looping: drop whole laps only, so the playhead lands on the same frame. Not looping: it ends either way.
            steps = this.loop ? (steps % length) + length * Math.max(1, Math.floor(SIMPLE_ANIM_MAX_STEPS_PER_TICK / length)) : length;
        }

        let dirty = false;
        for (let i = 0; i < steps; i += 1) {
            let next = this.frame + 1;
            if (next >= length) {
                if (!this.loop) {
                    this.finish();
                    return;
                }
                next = 0;
            }
            this.frame = next;
            dirty = true;
            if (this.labelAt(clip, next) !== null) {
                this.apply();
                dirty = false;
                this.reportLabel(next);
                if (gen !== this.generation || this.disposed || !this.playing) return;
            }
        }
        if (dirty) this.apply();
    }

    /** Re-write the current frame (after a layout pass re-posed the tree). Never throws. */
    public reapply(): void {
        if (this.disposed || !this.clip) return;
        this.apply();
    }

    /** Retire the handle: settle the awaiter, drop listeners; every later call is a no-op. Idempotent. */
    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.generation += 1;
        this.playing = false;
        this.pendingEnter = false;
        this.settlePending();
        this.listeners.complete.clear();
        this.listeners.label.clear();
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private goto(frameOrLabel: number | string, name: string | undefined, play: boolean, onComplete: (() => void) | undefined): boolean {
        const caller = play ? 'gotoAndPlay' : 'gotoAndStop';
        if (this.disposed) return false;
        const clip = this.pickClip(name, caller);
        if (!clip) return false;
        const frame = this.resolveFrame(clip, frameOrLabel);
        if (frame === null) {
            this.warn(typeof frameOrLabel === 'string'
                ? `${caller}: animation "${clip.name}" has no label "${frameOrLabel}".`
                : `${caller}: ${String(frameOrLabel)} is not a frame number.`);
            return false;
        }
        const loop = clip === this.clip ? this.loop : clip.loop;
        this.place(clip, frame, play, loop, onComplete);
        return true;
    }

    private place(clip: SimpleAnimationClip, frame: number, play: boolean, loop: boolean, onComplete: (() => void) | undefined): void {
        const previous = this.settle;
        this.settle = null;
        this.generation += 1;
        this.clip = clip;
        this.frame = frame;
        this.playing = play;
        this.loop = loop;
        this.accumulator = 0;
        this.pendingEnter = play;
        this.apply();
        if (previous) this.safeCall(previous, 'onComplete');
        if (!onComplete) return;
        if (play && !loop) this.settle = onComplete;
        else this.safeCall(onComplete, 'onComplete');
    }

    private finish(): void {
        const clip = this.clip;
        if (!clip) return;
        this.frame = Math.max(1, clip.lengthFrames) - 1;
        this.playing = false;
        this.accumulator = 0;
        this.pendingEnter = false;
        this.apply();
        const settle = this.settle;
        this.settle = null;
        this.emit('complete', { animation: clip.name, frame: this.frame + 1 });
        if (settle) this.safeCall(settle, 'onComplete');
    }

    private reportLabel(frame: number): void {
        const clip = this.clip;
        if (!clip) return;
        const label = this.labelAt(clip, frame);
        if (label === null) return;
        this.emit('label', { animation: clip.name, label, frame: frame + 1 });
    }

    private emit(event: OrcaSimpleAnimationEvent, info: OrcaSimpleAnimationEventInfo): void {
        for (const cb of Array.from(this.listeners[event])) {
            try {
                cb({ ...info });
            } catch (err) {
                this.warn(`a '${event}' listener threw: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (!this.hooks.emit) return;
        try {
            this.hooks.emit(event, { ...info }, this);
        } catch (err) {
            this.warn(`'${event}' dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private apply(): void {
        const clip = this.clip;
        if (!clip) return;
        let samples: ReturnType<typeof sampleSimpleAnimClip>;
        try {
            samples = sampleSimpleAnimClip(clip, this.frame);
        } catch (err) {
            this.warn(`sampling "${clip.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        for (const sample of samples) {
            const record = simpleAnimPropsToChannelWrites(sample.props);
            const writes: SimpleAnimChannelWrite[] = [];
            for (const property of Object.keys(record)) writes.push({ property, value: record[property] });
            if (writes.length === 0) continue;
            try {
                this.hooks.write(sample.targetId, writes);
            } catch (err) {
                this.warn(`writing layer target "${sample.targetId}" failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    /** `name` when non-empty, else the current, else the autoPlay, else the first clip. */
    private pickClip(name: string | undefined, caller: string): SimpleAnimationClip | null {
        const wanted = typeof name === 'string' ? name.trim() : '';
        if (wanted) {
            const clip = findSimpleAnimClip(this.component, wanted);
            if (!clip) this.warn(`${caller}: no animation called "${wanted}" (available: ${this.describeClips()}).`);
            return clip;
        }
        const autoPlay = this.component.autoPlay ? findSimpleAnimClip(this.component, this.component.autoPlay) : null;
        const clip = this.clip ?? autoPlay ?? this.component.clips[0] ?? null;
        if (!clip) this.warn(`${caller}: this Simple Animation has no animations.`);
        return clip;
    }

    /** A 1-based frame number or a label name → a 0-based frame, or null. */
    private resolveFrame(clip: SimpleAnimationClip, frameOrLabel: number | string): number | null {
        if (typeof frameOrLabel === 'number') {
            return Number.isFinite(frameOrLabel) ? resolveSimpleAnimFrame(clip, Math.round(frameOrLabel) - 1) : null;
        }
        if (typeof frameOrLabel !== 'string') return null;
        return resolveSimpleAnimFrame(clip, frameOrLabel.trim());
    }

    private labelAt(clip: SimpleAnimationClip, frame: number): string | null {
        let byFrame = this.labelsByClip.get(clip);
        if (!byFrame) {
            byFrame = new Map();
            for (const label of clip.labels ?? []) {
                if (label && typeof label.name === 'string' && !byFrame.has(label.frame)) byFrame.set(label.frame, label.name);
            }
            this.labelsByClip.set(clip, byFrame);
        }
        return byFrame.get(frame) ?? null;
    }

    private settlePending(): void {
        const settle = this.settle;
        this.settle = null;
        if (settle) this.safeCall(settle, 'onComplete');
    }

    private safeCall(fn: () => void, what: string): void {
        try {
            fn();
        } catch (err) {
            this.warn(`${what} threw: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private describeClips(): string {
        const names = this.animations();
        return names.length > 0 ? names.map((n) => `"${n}"`).join(', ') : 'none';
    }

    private warn(message: string): void {
        const text = `[SimpleAnimation] ${this.nodeName ? `"${this.nodeName}": ` : ''}${message}`;
        try {
            if (this.hooks.warn) this.hooks.warn(text);
            else console.warn(text);
        } catch { /* a broken warn hook must not throw into the game loop */ }
    }
}
