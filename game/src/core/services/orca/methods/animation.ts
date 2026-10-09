import animationPlayer from '../animation-player';
import type { AnimationRefLike } from '../animation-player';
import { runTween } from './transform';

/**
 * Animation Timeline Methods for FlowState
 *
 * Play/scrub authored animation clips (`.wave` in the editor, mirrored into
 * the runtime as `core/animation-data/**` and
 * `skins/<skin>/animation-data/**`). A clip drives properties on live scene
 * nodes over time and fires discrete component calls at keyframe times; the
 * heavy lifting lives in `animation-player.ts`.
 *
 * Every method accepts the same THREE authoring shapes accepted for scenes:
 *   - bare string (legacy / dropdown-picked name):  "intro/logo-in"
 *   - structured AnimationRef:                      { scope, skin?, name }
 *   - per-skin wrapper:                             { kind: 'animationRefBySkin', bySkin }
 *
 * Resolution failures (unknown clip, blank per-skin entry) warn and no-op —
 * the flow always continues.
 */
class AnimationMethods {
    /**
     * Play a clip. `sequenceNodeOn === 'onComplete'` blocks the flow until the
     * clip finishes; anything else returns immediately and the clip plays in
     * the background.
     *
     * A looping clip NEVER blocks — waiting on an infinite loop would deadlock
     * the walker — so `loop: true` + `'onComplete'` warns and returns at once.
     */
    public playAnimationClip(clip: AnimationRefLike, loop: boolean, sequenceNodeOn: string): Promise<void> | void {
        const key = animationPlayer.resolveKey(clip);
        if (!key) {
            console.warn('[FlowState] playAnimationClip called without a valid animation clip');
            return;
        }

        if (loop === true) {
            // A looping clip never completes, so nothing waits on it: started
            // in the background, with no completion to report (which is also
            // what keeps the player from warning on every looping play).
            if (sequenceNodeOn === 'onComplete') {
                console.warn(`[FlowState] playAnimationClip '${key}' has loop=true and sequenceNodeOn='onComplete'; a looping clip never completes. Falling through to immediate.`);
            }
            animationPlayer.play(key, true);
            return;
        }

        return runTween(sequenceNodeOn, (onComplete) => {
            // An unplayable clip settles straight away so the walker never
            // waits on a timeline that was never created.
            if (!animationPlayer.play(key, loop, onComplete)) onComplete();
        });
    }

    /** Stop a running clip and discard its timeline. */
    public stopAnimationClip(clip: AnimationRefLike): void {
        const key = animationPlayer.resolveKey(clip);
        if (!key) {
            console.warn('[FlowState] stopAnimationClip called without a valid animation clip');
            return;
        }
        animationPlayer.stop(key);
    }

    /** Freeze a running clip in place (no-op if it isn't playing). */
    public pauseAnimationClip(clip: AnimationRefLike): void {
        const key = animationPlayer.resolveKey(clip);
        if (!key) {
            console.warn('[FlowState] pauseAnimationClip called without a valid animation clip');
            return;
        }
        animationPlayer.pause(key);
    }

    /** Resume a paused clip (no-op if it isn't playing). */
    public resumeAnimationClip(clip: AnimationRefLike): void {
        const key = animationPlayer.resolveKey(clip);
        if (!key) {
            console.warn('[FlowState] resumeAnimationClip called without a valid animation clip');
            return;
        }
        animationPlayer.resume(key);
    }

    /** Scrub a running clip to an absolute time, in SECONDS. */
    public setAnimationClipTime(clip: AnimationRefLike, time: number): void {
        const key = animationPlayer.resolveKey(clip);
        if (!key) {
            console.warn('[FlowState] setAnimationClipTime called without a valid animation clip');
            return;
        }
        animationPlayer.seek(key, time);
    }

    /** Playback-rate multiplier (1 = authored speed, 0 = frozen, <0 = reverse). */
    public setAnimationClipSpeed(clip: AnimationRefLike, speed: number): void {
        const key = animationPlayer.resolveKey(clip);
        if (!key) {
            console.warn('[FlowState] setAnimationClipSpeed called without a valid animation clip');
            return;
        }
        animationPlayer.setSpeed(key, speed);
    }
}

export const animation = new AnimationMethods();
