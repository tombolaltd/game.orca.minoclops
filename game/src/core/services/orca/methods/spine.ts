import * as PIXI from "pixi.js";
// `spine-pixi-v8` re-exports the whole of `spine-core`, so `Physics` comes from
// the one package that is actually in the manifest.
import { Physics, Spine } from "@esotericsoftware/spine-pixi-v8";
import sceneManager from "../scene-manager";
import type { NodeRefLike } from "./node-ref";
import { resolveNode, resolveNodeDeferred } from "./node-ref";

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

    public playAnimation(
        target: NodeRefLike,
        animationName: string,
        loop: boolean,
        trackIndex: number = 0,
        sequenceNodeOn: 'immediate' | 'onComplete' = 'immediate',
    ): Promise<void> | void {
        if (sequenceNodeOn !== 'onComplete') {
            resolveNodeDeferred<Spine>(target, Spine, (spine) => {
                spine.state.setAnimation(trackIndex, animationName, loop);
                this.trackForUpdates(spine);
            });
            return;
        }
        if (loop) {
            console.warn(`[FlowState] playAnimation '${animationName}' has loop=true and sequenceNodeOn='onComplete'; a looping animation will never complete. Falling through to immediate.`);
            resolveNodeDeferred<Spine>(target, Spine, (spine) => {
                spine.state.setAnimation(trackIndex, animationName, loop);
                this.trackForUpdates(spine);
            });
            return;
        }
        // State-listener pattern: the per-TrackEntry `listener` field is not
        // honoured reliably here; every other consumer (arcade-base
        // spine-extended, jackpots, sound-manager, bingo-base, etc.)
        // uses `spine.state.addListener({ complete })` and matches on the
        // TrackEntry returned by setAnimation. We do the same, and additionally
        // resolve on `interrupt`/`dispose` so a chained playAnimation that
        // interrupts the running track (or a scene swap) doesn't leave the
        // Promise pending forever.
        // NOTE: if the target never resolves (scene unloaded, wrong type, etc.)
        // resolveNodeDeferred never invokes the callback and this Promise hangs.
        // Same hazard as the sync no-op contract; left as-is intentionally.
        return new Promise<void>((resolve) => {
            resolveNodeDeferred<Spine>(target, Spine, (spine) => {
                const trackEntry = spine.state.setAnimation(trackIndex, animationName, false);
                this.trackForUpdates(spine);
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
            });
        });
    }

    public addAnimation(
        target: NodeRefLike,
        animationName: string,
        loop: boolean,
        delay: number = 0,
        trackIndex: number = 0,
        sequenceNodeOn: 'immediate' | 'onComplete' = 'immediate',
    ): Promise<void> | void {
        if (sequenceNodeOn !== 'onComplete') {
            resolveNodeDeferred<Spine>(target, Spine, (spine) => {
                spine.state.addAnimation(trackIndex, animationName, loop, delay);
                this.trackForUpdates(spine);
            });
            return;
        }
        if (loop) {
            console.warn(`[FlowState] addAnimation '${animationName}' has loop=true and sequenceNodeOn='onComplete'; a looping animation will never complete. Falling through to immediate.`);
            resolveNodeDeferred<Spine>(target, Spine, (spine) => {
                spine.state.addAnimation(trackIndex, animationName, loop, delay);
                this.trackForUpdates(spine);
            });
            return;
        }
        // State-listener pattern (see playAnimation): match on the queued
        // TrackEntry returned by addAnimation. Resolve on complete /
        // interrupt / dispose so chained calls or scene swaps don't strand
        // the Promise.
        // NOTE: same target-never-resolves hazard as playAnimation; the queued
        // TrackEntry's `complete` is what we await (not the currently-playing one).
        return new Promise<void>((resolve) => {
            resolveNodeDeferred<Spine>(target, Spine, (spine) => {
                const trackEntry = spine.state.addAnimation(trackIndex, animationName, false, delay);
                this.trackForUpdates(spine);
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
            });
        });
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
            try {
                spine.skeleton.setSkinByName(skinName);
            } catch (error) {
                console.warn(`[FlowState] setSkin: could not apply skin '${skinName}'.`, error);
                return;
            }
            spine.skeleton.setSlotsToSetupPose();
            // Refresh attachments even when no animation is ticking; do not start playback.
            try {
                spine.update(0);
            } catch (error) {
                console.warn(`[FlowState] setSkin: could not refresh skin '${skinName}'.`, error);
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
