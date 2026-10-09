import * as PIXI from "pixi.js";
// `spine-pixi-v8` re-exports the whole of `spine-core`, so `Physics` comes from
// the one package that is actually in the manifest.
import { Physics, Spine } from "@esotericsoftware/spine-pixi-v8";
import sceneManager from "../scene-manager";
import type { NodeRefLike } from "./node-ref";
import { describeNodeRef, resolveNode, resolveNodeDeferred } from "./node-ref";
import { describeFlowError, emitFlowConsole } from "./flow-console";

function listNames(items: ReadonlyArray<{ name: string }>): string {
    return items.length > 0 ? items.map(item => item.name).join(', ') : 'none';
}

/**
 * Spine Animation Methods for FlowState
 *
 * Provides control over Spine skeletal animations *as live scene-graph
 * nodes*. Every method takes `target: NodeRefValue` (resolved to the
 * on-stage Spine node) as its first argument.
 *
 * Key concepts:
 * - **Tracks**: Animation layers (0 is base, higher tracks overlay)
 * - **Skins**: Visual variants of the same skeleton
 * - **Mix**: Transition blending between animations
 * - **TimeScale**: Animation playback speed multiplier
 *
 * Resolution failures (target not in current scene tree, or wrong
 * class) are logged via `resolveNode` and the call is a no-op — the
 * flow continues. This matches the editor contract: graphs may be
 * authored before scenes load and must degrade gracefully.
 */
class SpineMethods {
    private getSpine(target: NodeRefLike): Spine | null {
        return resolveNode<Spine>(target, Spine);
    }

    private trackForUpdates(spine: Spine): void {
        spine.autoUpdate = false;
        sceneManager.trackSpineForUpdates(spine);
    }

    /** False (and an attributed error naming the available animations) when the skeleton lacks it. */
    private hasAnimationOrReport(spine: Spine, target: NodeRefLike, animationName: string, method: string): boolean {
        const data = spine.skeleton.data;
        if (data.findAnimation(animationName)) return true;
        emitFlowConsole(
            'error',
            `[FlowState] ${method}: animation '${animationName}' does not exist on '${describeNodeRef(target)}'`
                + ` (available: ${listNames(data.animations)})`,
            { code: 'spine-animation-not-found' },
        );
        return false;
    }

    /**
     * Resolve once `trackEntry` completes, is interrupted or is disposed.
     * State-listener pattern: the per-TrackEntry `listener` field is not
     * honoured reliably here; every other consumer (arcade-base
     * spine-extended, jackpots, sound-manager, bingo-base, etc.) uses
     * `spine.state.addListener({ complete })` and matches on the TrackEntry.
     * Interrupt/dispose also settle so a chained call or a scene swap never
     * leaves the Promise pending.
     */
    private settleOnTrackEnd(spine: Spine, trackEntry: unknown, animationName: string, resolve: () => void): void {
        console.log('[FlowState] spine.onComplete listener attached for', animationName);
        let settled = false;
        const settle = (entry: any, reason: 'complete' | 'interrupt' | 'dispose') => {
            if (settled) return;
            if (entry !== trackEntry) return;
            settled = true;
            try { spine.state.removeListener(listener); } catch { /* swallow */ }
            console.log('[FlowState] spine.onComplete resolved for', animationName, '(reason)', reason);
            resolve();
        };
        const listener = {
            complete: (entry: any) => settle(entry, 'complete'),
            interrupt: (entry: any) => settle(entry, 'interrupt'),
            dispose: (entry: any) => settle(entry, 'dispose'),
        };
        spine.state.addListener(listener);
    }

    /**
     * Shared body of playAnimation / addAnimation. `start` queues the
     * animation and returns its TrackEntry. In 'onComplete' mode the Promise
     * ALWAYS settles: an unknown animation, an unresolvable target or a
     * throwing `start` resolves at once (after an attributed error) rather
     * than hanging the flow. A deferred target whose Spine load fails still
     * never calls back, so that case can still hang.
     */
    private runAnimation(
        method: 'playAnimation' | 'addAnimation',
        target: NodeRefLike,
        animationName: string,
        loop: boolean,
        sequenceNodeOn: 'immediate' | 'onComplete',
        start: (spine: Spine, loop: boolean) => unknown,
    ): Promise<void> | void {
        const awaitCompletion = sequenceNodeOn === 'onComplete';
        if (awaitCompletion && loop) {
            emitFlowConsole(
                'warn',
                `[FlowState] ${method} '${animationName}' has loop=true and sequenceNodeOn='onComplete'; a looping animation will never complete. Falling through to immediate.`,
                { code: 'spine-loop-on-complete' },
            );
        }
        if (!awaitCompletion || loop) {
            resolveNodeDeferred<Spine>(target, Spine, (spine) => {
                if (!this.hasAnimationOrReport(spine, target, animationName, method)) return;
                start(spine, loop);
                this.trackForUpdates(spine);
            });
            return;
        }
        return new Promise<void>((resolve) => {
            const outcome = resolveNodeDeferred<Spine>(target, Spine, (spine) => {
                if (!this.hasAnimationOrReport(spine, target, animationName, method)) {
                    resolve();
                    return;
                }
                try {
                    const trackEntry = start(spine, false);
                    this.trackForUpdates(spine);
                    this.settleOnTrackEnd(spine, trackEntry, animationName, resolve);
                } catch (err) {
                    emitFlowConsole('error', `[FlowState] ${method}: ${describeFlowError(err)}`, { code: 'node-error' });
                    resolve();
                }
            });
            if (outcome === 'not-found') resolve();
        });
    }

    public playAnimation(
        target: NodeRefLike,
        animationName: string,
        loop: boolean,
        trackIndex: number = 0,
        sequenceNodeOn: 'immediate' | 'onComplete' = 'immediate',
    ): Promise<void> | void {
        return this.runAnimation('playAnimation', target, animationName, loop, sequenceNodeOn,
            (spine, shouldLoop) => spine.state.setAnimation(trackIndex, animationName, shouldLoop));
    }

    public addAnimation(
        target: NodeRefLike,
        animationName: string,
        loop: boolean,
        delay: number = 0,
        trackIndex: number = 0,
        sequenceNodeOn: 'immediate' | 'onComplete' = 'immediate',
    ): Promise<void> | void {
        // In 'onComplete' mode the queued entry's `complete` is awaited, not the currently-playing one.
        return this.runAnimation('addAnimation', target, animationName, loop, sequenceNodeOn,
            (spine, shouldLoop) => spine.state.addAnimation(trackIndex, animationName, shouldLoop, delay));
    }

    public clearTrack(target: NodeRefLike, trackIndex: number): void {
        const spine = this.getSpine(target);
        if (spine) spine.state.clearTrack(trackIndex);
    }

    public clearTracks(target: NodeRefLike): void {
        const spine = this.getSpine(target);
        if (spine) spine.state.clearTracks();
    }

    public setAnimationMix(target: NodeRefLike, fromAnimation: string, toAnimation: string, duration: number): void {
        const spine = this.getSpine(target);
        if (spine) spine.state.data.setMix(fromAnimation, toAnimation, duration);
    }

    public setDefaultMix(target: NodeRefLike, duration: number): void {
        const spine = this.getSpine(target);
        if (spine) spine.state.data.defaultMix = duration;
    }

    public setTimeScale(target: NodeRefLike, timeScale: number): void {
        const spine = this.getSpine(target);
        if (spine) spine.state.timeScale = timeScale;
    }

    public setTrackTimeScale(target: NodeRefLike, trackIndex: number, timeScale: number): void {
        const spine = this.getSpine(target);
        if (spine && spine.state.tracks[trackIndex]) {
            spine.state.tracks[trackIndex]!.timeScale = timeScale;
        }
    }

    public setSkin(target: NodeRefLike, skinName: string): void {
        if (typeof skinName !== 'string' || !skinName.trim()) return;
        resolveNodeDeferred<Spine>(target, Spine, (spine) => {
            const data = spine.skeleton.data;
            if (!data.findSkin(skinName)) {
                emitFlowConsole(
                    'error',
                    `[FlowState] setSkin: skin '${skinName}' does not exist on '${describeNodeRef(target)}' (available: ${listNames(data.skins)})`,
                    { code: 'spine-skin-not-found' },
                );
                return;
            }
            try {
                spine.skeleton.setSkinByName(skinName);
            } catch (error) {
                emitFlowConsole('error', `[FlowState] setSkin: could not apply skin '${skinName}': ${describeFlowError(error)}`, { code: 'node-error' });
                return;
            }
            spine.skeleton.setSlotsToSetupPose();
            // Refresh attachments even when no animation is ticking; do not start playback.
            try {
                spine.update(0);
            } catch (error) {
                emitFlowConsole('warn', `[FlowState] setSkin: could not refresh skin '${skinName}': ${describeFlowError(error)}`, { code: 'node-error' });
            }
        });
    }

    public setToSetupPose(target: NodeRefLike): void {
        const spine = this.getSpine(target);
        if (spine) spine.skeleton.setToSetupPose();
    }

    public setBonesToSetupPose(target: NodeRefLike): void {
        const spine = this.getSpine(target);
        if (spine) spine.skeleton.setBonesToSetupPose();
    }

    public setSlotsToSetupPose(target: NodeRefLike): void {
        const spine = this.getSpine(target);
        if (spine) spine.skeleton.setSlotsToSetupPose();
    }

    public setSlotAttachmentVisibility(target: NodeRefLike, slotName: string, visible: boolean): void {
        const spine = this.getSpine(target);
        if (!spine) return;
        const slot = spine.skeleton.findSlot(slotName);
        if (slot) slot.color.a = visible ? 1 : 0;
    }

    public setSlotColor(target: NodeRefLike, slotName: string, r: number, g: number, b: number, a: number): void {
        const spine = this.getSpine(target);
        if (!spine) return;
        const slot = spine.skeleton.findSlot(slotName);
        if (slot) slot.color.set(r, g, b, a);
    }

    public setSlotAttachment(target: NodeRefLike, slotName: string, attachmentName: string): void {
        const spine = this.getSpine(target);
        if (spine) spine.skeleton.setAttachment(slotName, attachmentName || '');
    }

    public hasAnimation(target: NodeRefLike, animationName: string): boolean {
        const spine = this.getSpine(target);
        if (!spine) return false;
        return spine.skeleton.data.findAnimation(animationName) !== null;
    }

    public getAnimationDuration(target: NodeRefLike, animationName: string): number {
        const spine = this.getSpine(target);
        if (!spine) return 0;
        const animation = spine.skeleton.data.findAnimation(animationName);
        return animation ? animation.duration : 0;
    }

    public getTrackTime(target: NodeRefLike, trackIndex: number): number {
        const spine = this.getSpine(target);
        if (spine && spine.state.tracks[trackIndex]) {
            return spine.state.tracks[trackIndex]!.trackTime;
        }
        return 0;
    }

    public setTrackTime(target: NodeRefLike, trackIndex: number, time: number): void {
        const spine = this.getSpine(target);
        if (spine && spine.state.tracks[trackIndex]) {
            spine.state.tracks[trackIndex]!.trackTime = time;
        }
    }

    public setAlpha(target: NodeRefLike, alpha: number): void {
        const spine = this.getSpine(target);
        if (spine) spine.alpha = alpha;
    }

    public setAutoUpdate(target: NodeRefLike, autoUpdate: boolean): void {
        const spine = this.getSpine(target);
        if (spine) {
            spine.autoUpdate = autoUpdate;
            if (autoUpdate) {
                sceneManager.untrackSpineForUpdates(spine);
            }
        }
    }

    public updateSpine(target: NodeRefLike, delta: number): void {
        const spine = this.getSpine(target);
        if (spine) spine.update(delta);
    }

    /**
     * Position of a named bone in SCENE-ROOT-LOCAL (design-space) coords —
     * the same space `getNodeGlobalPosition` returns. The bone's
     * `worldX`/`worldY` are in skeleton space; we convert through the Spine
     * container's `toGlobal` and then back into the scene root's local space
     * so the result is assignable via `setNodePosition` (for a direct child of
     * the scene root) or `setNodeGlobalPosition` (for any nesting). Returns
     * { x: 0, y: 0 } if the spine or bone is missing.
     *
     * NOTE: rigs with a negative `skeleton.scaleY` invert the Y axis;
     * this uses the straightforward `worldX`/`worldY` → `toGlobal`
     * conversion without extra sign handling.
     */
    public getSpineBonePositionGlobal(target: NodeRefLike, boneName: string): { x: number; y: number } {
        const s = resolveNode<Spine>(target, Spine); if (!s) return { x: 0, y: 0 };
        const bone = s.skeleton.findBone(boneName); if (!bone) return { x: 0, y: 0 };
        // Bone worldX/worldY are only valid after the skeleton's world transform
        // has been computed. These spines run autoUpdate=false (ticked by
        // sceneManager), so refresh before reading. `Physics.update` is the
        // neutral mode: it does not advance physics-constrained bones.
        s.skeleton.updateWorldTransform(Physics.update);
        const global = s.toGlobal(new PIXI.Point(bone.worldX, bone.worldY));
        const root = sceneManager.getCurrentContainer();
        const p = root ? root.toLocal(global) : global;
        return { x: p.x, y: p.y };
    }
}

export const spine = new SpineMethods();
