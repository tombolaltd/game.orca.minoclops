import * as PIXI from "pixi.js";
import type { NodeRefLike } from "./node-ref";
import { resolveNode } from "./node-ref";

/**
 * Get the underlying HTMLVideoElement attached by SceneManager.buildVideoSprite.
 * Returns null when the target isn't a video node, hasn't been built, or
 * its texture resource was rebuilt and the back-ref dropped.
 */
function videoElementFor(target: NodeRefLike): HTMLVideoElement | null {
    const sprite = resolveNode<PIXI.Sprite>(target, PIXI.Sprite);
    if (!sprite) return null;
    const el = (sprite as any).__videoEl as HTMLVideoElement | undefined;
    return el ?? null;
}

/**
 * Video controls. Targets a scene-graph node of type 'video' (rendered
 * by SceneManager as a PIXI.Sprite backed by an HTMLVideoElement).
 */
class VideoMethods {
    public playVideo(target: NodeRefLike): void {
        const el = videoElementFor(target);
        el?.play().catch(err => console.warn('[FlowState] video.play() rejected:', err));
    }
    public pauseVideo(target: NodeRefLike): void {
        videoElementFor(target)?.pause();
    }
    public stopVideo(target: NodeRefLike): void {
        const el = videoElementFor(target);
        if (!el) return;
        el.pause();
        try { el.currentTime = 0; } catch { /* ignored: detached element */ }
    }
    public seekVideo(target: NodeRefLike, seconds: number): void {
        const el = videoElementFor(target);
        if (!el) return;
        try { el.currentTime = Math.max(0, seconds); } catch { /* ignored */ }
    }
    public setVideoLoop(target: NodeRefLike, loop: boolean): void {
        const el = videoElementFor(target); if (el) el.loop = loop;
    }
    public setVideoVolume(target: NodeRefLike, volume: number): void {
        const el = videoElementFor(target);
        if (el) el.volume = Math.max(0, Math.min(1, volume));
    }
    public setVideoMuted(target: NodeRefLike, muted: boolean): void {
        const el = videoElementFor(target); if (el) el.muted = muted;
    }
}

export const video = new VideoMethods();
