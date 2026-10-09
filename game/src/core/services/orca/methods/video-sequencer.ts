import * as PIXI from "pixi.js";
import type { NodeRefLike } from "./node-ref";
import { resolveNode } from "./node-ref";

interface VideoSequencerHandle {
    readonly index: number;
    readonly count: number;
    setIndex(next: number): void;
}

function handleFor(target: NodeRefLike): { sprite: PIXI.Sprite; seq: VideoSequencerHandle; el: HTMLVideoElement | null } | null {
    const sprite = resolveNode<PIXI.Sprite>(target, PIXI.Sprite);
    if (!sprite) return null;
    const seq = (sprite as any).__videoSequencer as VideoSequencerHandle | undefined;
    if (!seq) {
        console.warn('[FlowState] videoSequencer target has no __videoSequencer handle (rebuild required)');
        return null;
    }
    return { sprite, seq, el: (sprite as any).__videoEl ?? null };
}

/**
 * VideoSequencer controls. Targets a scene-graph node of type
 * 'videoSequencer'. Drives the playlist exposed on `__videoSequencer`.
 */
class VideoSequencerMethods {
    public playVideoSequencer(target: NodeRefLike): void {
        handleFor(target)?.el?.play().catch(() => { /* ignored */ });
    }
    public pauseVideoSequencer(target: NodeRefLike): void {
        handleFor(target)?.el?.pause();
    }
    public stopVideoSequencer(target: NodeRefLike): void {
        const h = handleFor(target);
        if (!h?.el) return;
        h.el.pause();
        try { h.el.currentTime = 0; } catch { /* ignored */ }
    }
    public nextVideoSequencerClip(target: NodeRefLike): void {
        const h = handleFor(target);
        if (h) h.seq.setIndex(h.seq.index + 1);
    }
    public previousVideoSequencerClip(target: NodeRefLike): void {
        const h = handleFor(target);
        if (h) h.seq.setIndex(h.seq.index - 1);
    }
    public setVideoSequencerIndex(target: NodeRefLike, index: number): void {
        const h = handleFor(target);
        if (h) h.seq.setIndex(index | 0);
    }
}

export const videoSequencer = new VideoSequencerMethods();
