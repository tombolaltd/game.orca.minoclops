import type { OrcaSimpleAnimationHandle } from "../simple-animation-player";
import { emitFlowConsole } from "./flow-console";
import { describeNodeRef, resolveNode, type NodeRefLike } from "./node-ref";
import { runTween } from "./transform";

/**
 * FlowState methods for the `simpleAnimation` scene-node component (Flash-style
 * keyframe clips; the playhead lives in `../simple-animation-player.ts`).
 *
 * Every method resolves its `target` through {@link resolveNode} (the shared
 * nodeRef resolver, per-skin refs included) and drives the `__orcaSimpleAnimation`
 * handle `scene-manager.ts` stashes on the built node. A node without one is
 * reported to the Flow Console and the call no-ops (getters: 0 / false / '').
 *
 * An empty `animationName` means the current clip, else the autoPlay clip,
 * else the first one. Frame numbers are 1-BASED, like Flash; a non-empty
 * `label` wins over `frame`.
 *
 * The `simpleAnimationComplete` / `simpleAnimationLabel` STARTERS are not here: the
 * scene manager fires them (by title, through `Flowstate.runFlowsByStarterType`)
 * for every Simple Animation, whoever started the clip.
 *
 * Shared by both game templates (byte-identical copies). METHOD NAMES ARE THE
 * IMMUTABLE RUNTIME KEYS — the editor's Simple Animation action / getter menu
 * entries dispatch straight onto them.
 */

type SimpleAnimationDisplayLike = { __orcaSimpleAnimation?: OrcaSimpleAnimationHandle };

/** The target's live Simple Animation handle, or null (reported when `caller` is set). */
function simpleAnimHandle(target: NodeRefLike, caller: string | null): OrcaSimpleAnimationHandle | null {
    const obj = resolveNode<SimpleAnimationDisplayLike>(target);
    if (!obj) return null; // resolveNode already reported a missing node.
    const handle = obj.__orcaSimpleAnimation;
    if (!handle || handle.isDisposed()) {
        if (caller) {
            emitFlowConsole('warn', `[FlowState] ${caller}: '${describeNodeRef(target)}' has no Simple Animation component.`, { code: 'simple-animation-missing' });
        }
        return null;
    }
    return handle;
}

/** The trimmed clip name, '' for "current / autoPlay / first"; null (reported) when the node has no such clip. */
function clipName(handle: OrcaSimpleAnimationHandle, target: NodeRefLike, animationName: unknown, caller: string): string | null {
    const name = typeof animationName === "string" ? animationName.trim() : "";
    if (!name) return "";
    const names = handle.animations();
    if (names.includes(name)) return name;
    emitFlowConsole(
        'error',
        `[FlowState] ${caller}: animation '${name}' does not exist on '${describeNodeRef(target)}'`
            + ` (available: ${names.length > 0 ? names.map((n) => `'${n}'`).join(', ') : 'none'})`,
        { code: 'simple-animation-not-found' },
    );
    return null;
}

/** Tolerate a numeric string from the walker. */
function toNumber(value: unknown): number {
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    return typeof value === "number" ? value : NaN;
}

/** `label` when non-empty, else the 1-based `frame` (rounded); null (reported) when neither is usable. */
function frameOrLabel(frame: unknown, label: unknown, target: NodeRefLike, caller: string): number | string | null {
    const named = typeof label === "string" ? label.trim() : "";
    if (named) return named;
    const n = toNumber(frame);
    if (Number.isFinite(n)) return Math.round(n);
    emitFlowConsole('error', `[FlowState] ${caller}: '${describeNodeRef(target)}' needs a frame number or a label.`, { code: 'simple-animation-bad-frame' });
    return null;
}

class SimpleAnimationMethods {
    /**
     * Play a clip from frame 1. `loopMode`: 'loop' / 'once' override the clip's
     * authored loop, anything else ('default') keeps it. With
     * `sequenceNodeOn === 'onComplete'` the flow waits for the clip to end — or
     * to be replaced / stopped / torn down; a looping clip never ends, so it
     * continues at once.
     */
    public playSimpleAnimation(target: NodeRefLike, animationName: string, loopMode: string, sequenceNodeOn: string): Promise<void> | void {
        const handle = simpleAnimHandle(target, "playSimpleAnimation");
        if (!handle) return;
        const name = clipName(handle, target, animationName, "playSimpleAnimation");
        if (name === null) return;
        const loop = loopMode === "loop" ? true : loopMode === "once" ? false : undefined;
        if (loop === true && sequenceNodeOn === "onComplete") {
            console.warn(`[FlowState] playSimpleAnimation: a looping clip never completes; '${describeNodeRef(target)}' continues immediately.`);
        }
        return runTween(sequenceNodeOn, (onComplete) => {
            if (!handle.play(name, { loop, onComplete })) onComplete();
        });
    }

    /** Pause the playhead where it is. */
    public stopSimpleAnimation(target: NodeRefLike): void {
        const handle = simpleAnimHandle(target, "stopSimpleAnimation");
        if (handle) handle.stop();
    }

    /** Jump to a 1-based frame (or a label, which wins when set) and play from there. */
    public gotoAndPlaySimpleAnimation(target: NodeRefLike, animationName: string, frame: number, label: string, sequenceNodeOn: string): Promise<void> | void {
        const handle = simpleAnimHandle(target, "gotoAndPlaySimpleAnimation");
        if (!handle) return;
        const name = clipName(handle, target, animationName, "gotoAndPlaySimpleAnimation");
        if (name === null) return;
        const at = frameOrLabel(frame, label, target, "gotoAndPlaySimpleAnimation");
        if (at === null) return;
        return runTween(sequenceNodeOn, (onComplete) => {
            if (!handle.gotoAndPlay(at, name, { onComplete })) onComplete();
        });
    }

    /** Jump to a 1-based frame (or a label, which wins when set) and hold there. */
    public gotoAndStopSimpleAnimation(target: NodeRefLike, animationName: string, frame: number, label: string): void {
        const handle = simpleAnimHandle(target, "gotoAndStopSimpleAnimation");
        if (!handle) return;
        const name = clipName(handle, target, animationName, "gotoAndStopSimpleAnimation");
        if (name === null) return;
        const at = frameOrLabel(frame, label, target, "gotoAndStopSimpleAnimation");
        if (at === null) return;
        handle.gotoAndStop(at, name);
    }

    /** Playback-rate multiplier: 1 = authored fps, 0 = frozen (negative clamps to 0). */
    public setSimpleAnimationSpeed(target: NodeRefLike, speed: number): void {
        const handle = simpleAnimHandle(target, "setSimpleAnimationSpeed");
        if (handle) handle.setSpeed(toNumber(speed));
    }

    /** The playhead's 1-based frame; 0 when nothing has played or the target has no Simple Animation. */
    public getSimpleAnimationFrame(target: NodeRefLike): number {
        const handle = simpleAnimHandle(target, null);
        return handle ? handle.currentFrame : 0;
    }

    /** True while a clip is advancing. */
    public isSimpleAnimationPlaying(target: NodeRefLike): boolean {
        const handle = simpleAnimHandle(target, null);
        return handle ? handle.isPlaying : false;
    }

    /** The clip on the playhead; '' when none. */
    public getSimpleAnimationName(target: NodeRefLike): string {
        const handle = simpleAnimHandle(target, null);
        return handle?.currentAnimation ?? "";
    }
}

export const simpleAnimation = new SimpleAnimationMethods();
