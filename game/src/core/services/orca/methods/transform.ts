import * as PIXI from "pixi.js";
import gsap from "gsap";
import { eventEmitter } from "@game-studio/arcade-base";
import sceneManager from "../scene-manager";
import { ACTIVE_SKIN_NAME } from "../active-skin";
import type { NodeRefLike, NodeRefValue } from "./node-ref";
import { isNodeRef, isNodeRefBySkin, nodeRefId, resolveNode } from "./node-ref";

/**
 * Generic scene-node transform controls. Works on any scene-graph
 * node — no type constraint. Use these when you just need to nudge a
 * sprite, container, spine, etc. without per-component imports.
 *
 * Pixi 8 removed `DisplayObject`: every renderable is a `Container`, so
 * that is the universal runtime guard here.
 *
 * Tweens are gsap-backed and return a Promise that resolves on
 * completion (the FlowState walker awaits action Promises, so a tween
 * blocks the flow until done). They early-resolve if the target is
 * missing or destroyed, and snap synchronously when durationMS <= 0.
 */
class TransformMethods {
    private get(target: NodeRefLike): PIXI.Container | null {
        return resolveNode<PIXI.Container>(target, PIXI.Container);
    }

    public setNodePosition(target: NodeRefLike, x: number, y: number): void {
        const o = this.get(target); if (o) { o.x = x; o.y = y; }
    }
    /**
     * Place a node at a SCENE-ROOT-LOCAL (design-space) position — the same
     * coordinate space `getNodeGlobalPosition` returns. Unlike `setNodePosition`
     * (which writes parent-local coords), this compensates for the target's
     * parent chain, so it lands correctly even when the node is nested inside
     * other transformed containers. Pair it with `getNodeGlobalPosition` to copy
     * one node's on-screen position onto another regardless of nesting. No-op if
     * the target is missing.
     */
    public setNodeGlobalPosition(target: NodeRefLike, x: number, y: number): void {
        const o = this.get(target);
        if (!o) return;
        const root = sceneManager.getCurrentContainer();
        const globalPt = root ? root.toGlobal(new PIXI.Point(x, y)) : new PIXI.Point(x, y);
        const local = o.parent ? o.parent.toLocal(globalPt) : globalPt;
        o.position.set(local.x, local.y);
    }
    public setNodeScale(target: NodeRefLike, scaleX: number, scaleY: number): void {
        const o = this.get(target); if (o) o.scale.set(scaleX, scaleY);
    }
    public setNodeRotation(target: NodeRefLike, radians: number): void {
        const o = this.get(target); if (o) o.rotation = radians;
    }
    public setNodeAlpha(target: NodeRefLike, alpha: number): void {
        const o = this.get(target); if (o) o.alpha = alpha;
    }
    public setNodeVisible(target: NodeRefLike, visible: boolean): void {
        const o = this.get(target); if (o) o.visible = visible;
    }
    public showNode(target: NodeRefLike): void {
        const o = this.get(target); if (o) o.visible = true;
    }
    /**
     * Show or hide EVERY direct child of a node in one step (the node itself is
     * untouched) — resetting a panel of overlays, a row of pips, a popup's
     * variants. Walks the authored children, so the runtime's own wrappers and
     * masks are never hidden. No-op if the target is missing.
     */
    public setChildrenVisible(target: NodeRefLike, visible: boolean): void {
        const id = nodeRefId(target);
        const data = id ? (sceneManager.getNodeDataById(id) as { children?: Array<{ id?: string }> } | undefined) : undefined;
        for (const child of data?.children ?? []) {
            if (!child || typeof child.id !== "string") continue;
            const o = this.get({ kind: "nodeRef", nodeId: child.id });
            if (o) o.visible = visible !== false;
        }
    }
    public hideNode(target: NodeRefLike): void {
        const o = this.get(target); if (o) o.visible = false;
    }

    public tweenNodePosition(target: NodeRefLike, x: number, y: number, durationMS: number, ease: string, easeStrength: number, sequenceNodeOn: string): Promise<void> {
        const o = this.get(target);
        if (!o || (o as any).destroyed) return Promise.resolve();
        if (durationMS <= 0) { o.x = x; o.y = y; return Promise.resolve(); }
        return runTween(sequenceNodeOn, onComplete =>
            gsap.to(o, { x, y, duration: durationMS / 1000, ease: resolveEase(ease, easeStrength), onComplete }));
    }
    public tweenNodeAlpha(target: NodeRefLike, alpha: number, durationMS: number, ease: string, easeStrength: number, sequenceNodeOn: string): Promise<void> {
        const o = this.get(target);
        if (!o || (o as any).destroyed) return Promise.resolve();
        if (durationMS <= 0) { o.alpha = alpha; return Promise.resolve(); }
        return runTween(sequenceNodeOn, onComplete =>
            gsap.to(o, { alpha, duration: durationMS / 1000, ease: resolveEase(ease, easeStrength), onComplete }));
    }
    public tweenNodeScale(target: NodeRefLike, scaleX: number, scaleY: number, durationMS: number, ease: string, easeStrength: number, sequenceNodeOn: string): Promise<void> {
        const o = this.get(target);
        if (!o || (o as any).destroyed) return Promise.resolve();
        if (durationMS <= 0) { o.scale.set(scaleX, scaleY); return Promise.resolve(); }
        return runTween(sequenceNodeOn, onComplete =>
            gsap.to(o.scale, { x: scaleX, y: scaleY, duration: durationMS / 1000, ease: resolveEase(ease, easeStrength), onComplete }));
    }
    public tweenNodeRotation(target: NodeRefLike, radians: number, durationMS: number, ease: string, easeStrength: number, sequenceNodeOn: string): Promise<void> {
        const o = this.get(target);
        if (!o || (o as any).destroyed) return Promise.resolve();
        if (durationMS <= 0) { o.rotation = radians; return Promise.resolve(); }
        return runTween(sequenceNodeOn, onComplete =>
            gsap.to(o, { rotation: radians, duration: durationMS / 1000, ease: resolveEase(ease, easeStrength), onComplete }));
    }
    public tweenNodeTransform(target: NodeRefLike, x: number, y: number, scaleX: number, scaleY: number, rotation: number, alpha: number, durationMS: number, ease: string, easeStrength: number, sequenceNodeOn: string): Promise<void> {
        const o = this.get(target);
        if (!o || (o as any).destroyed) return Promise.resolve();
        if (durationMS <= 0) {
            o.x = x; o.y = y; o.scale.set(scaleX, scaleY); o.rotation = rotation; o.alpha = alpha;
            return Promise.resolve();
        }
        return runTween(sequenceNodeOn, onComplete =>
            gsap.to(o, {
                x, y,
                "scale.x": scaleX,
                "scale.y": scaleY,
                rotation,
                alpha,
                duration: durationMS / 1000,
                ease: resolveEase(ease, easeStrength),
                onComplete,
            }));
    }
    /**
     * Fly one node to wherever ANOTHER node is on screen - coins into a meter,
     * a prize into a collector - whatever their parents are. The destination's
     * on-screen point (plus the optional offset, in the destination's space) is
     * converted into the moving node's parent space before the tween starts, so
     * nesting and scaling on either side are honoured. Only the position moves.
     */
    public tweenNodeToNode(
        target: NodeRefLike,
        destination: NodeRefLike,
        offsetX: number,
        offsetY: number,
        durationMS: number,
        ease: string,
        easeStrength: number,
        sequenceNodeOn: string,
    ): Promise<void> {
        const o = this.get(target);
        const d = this.get(destination);
        if (!o || !d || (o as any).destroyed || (d as any).destroyed) return Promise.resolve();
        const global = d.toGlobal(new PIXI.Point(Number(offsetX) || 0, Number(offsetY) || 0));
        const local = o.parent ? o.parent.toLocal(global) : global;
        if (durationMS <= 0) { o.position.set(local.x, local.y); return Promise.resolve(); }
        return runTween(sequenceNodeOn, onComplete =>
            gsap.to(o, { x: local.x, y: local.y, duration: durationMS / 1000, ease: resolveEase(ease, easeStrength), onComplete }));
    }

    public tweenValue(from: number, to: number, durationMS: number, ease: string, easeStrength: number, eventName: string, sequenceNodeOn: string): Promise<void> {
        const emit = eventName
            ? (v: number) => { try { eventEmitter.emit(eventName as any, v); } catch { /* ignored */ } }
            : (_v: number) => { /* no event name: run tween without emitting */ };
        if (durationMS <= 0) { emit(to); return Promise.resolve(); }
        return runTween(sequenceNodeOn, onComplete => {
            const proxy = { v: from };
            emit(from);
            return gsap.to(proxy, {
                v: to,
                duration: durationMS / 1000,
                ease: resolveEase(ease, easeStrength),
                onUpdate: () => emit(proxy.v),
                onComplete,
            });
        });
    }

    // ── Value getters ──────────────────────────────────────────────
    // Read live transform/alpha state off the resolved DisplayObject.
    // All return 0 when the target is missing so flows degrade safely.

    public getNodePosition(target: NodeRefLike): { x: number; y: number } {
        const o = this.get(target);
        return o ? { x: o.x, y: o.y } : { x: 0, y: 0 };
    }
    public getNodeGlobalPosition(target: NodeRefLike): { x: number; y: number } {
        const o = this.get(target);
        if (!o) return { x: 0, y: 0 };
        const global = o.toGlobal(new PIXI.Point(0, 0));
        const root = sceneManager.getCurrentContainer();
        const p = root ? root.toLocal(global) : global;
        return { x: p.x, y: p.y };
    }
    public getNodeRotation(target: NodeRefLike): number {
        const o = this.get(target); return o ? o.rotation : 0;
    }
    public getNodeScaleX(target: NodeRefLike): number {
        const o = this.get(target); return o ? o.scale.x : 0;
    }
    public getNodeScaleY(target: NodeRefLike): number {
        const o = this.get(target); return o ? o.scale.y : 0;
    }
    public getNodeAlpha(target: NodeRefLike): number {
        const o = this.get(target); return o ? o.alpha : 0;
    }

    /**
     * The target's DIRECT authored children, in authored order, as nodeRefs —
     * only those currently built. Returns [] when the target is missing.
     */
    public getChildNodes(target: NodeRefLike): NodeRefValue[] {
        const id = nodeRefId(target);
        const children = id ? sceneManager.getNodeDataById(id)?.children : undefined;
        if (!Array.isArray(children)) return [];
        // Inherit the parent's scene context so a later miss names the right scene.
        const parent = isNodeRefBySkin(target) ? target.bySkin[ACTIVE_SKIN_NAME] : target;
        const context = isNodeRef(parent)
            ? { sceneScope: parent.sceneScope, sceneSkin: parent.sceneSkin, sceneName: parent.sceneName }
            : {};
        return children
            .filter(child => child && typeof child.id === 'string' && sceneManager.getDisplayObjectById(child.id) !== undefined)
            .map((child): NodeRefValue => ({ kind: 'nodeRef', nodeId: child.id, ...context }));
    }

    /**
     * Toggle a node's interactivity. Mirrors the pointer-starter binder:
     * Pixi 8 drives this entirely off `eventMode` — `'static'` to receive
     * pointer events, `'auto'` to opt back out (still hit-tested for an
     * interactive ancestor, but emits nothing). No-op if the target is
     * missing.
     */
    public setNodeInteractive(target: NodeRefLike, interactive: boolean): void {
        const o = this.get(target);
        if (o) o.eventMode = interactive ? 'static' : 'auto';
    }

    /** Immediately stop/kill ALL currently-active gsap tweens globally. */
    public killAllTweens(): void {
        gsap.globalTimeline.clear();
        gsap.killTweensOf("*");
    }

    /** Immediately stop/kill all in-flight gsap tweens targeting a single resolved node. */
    public killTweensOfNode(target: NodeRefLike): void {
        const o = this.get(target);
        if (!o) return;
        gsap.killTweensOf(o);
        if (o.scale) gsap.killTweensOf(o.scale);
    }
}

/**
 * Shared tween-sequencing helper. Always CREATES the gsap tween via
 * `start(onComplete)`. When `sequenceNodeOn === 'onComplete'` the returned
 * Promise blocks the FlowState walker until the tween's onComplete fires;
 * for any other value (including `'immediate'`, undefined or empty) the
 * tween still runs on gsap's ticker but the Promise resolves immediately so
 * the walker advances right away.
 *
 * Exported so other timing-driven modules (e.g. animation-player clips) share
 * one sequencing contract rather than re-implementing it.
 */
export function runTween(sequenceNodeOn: string, start: (onComplete: () => void) => void): Promise<void> {
    const blockUntilComplete = sequenceNodeOn === 'onComplete';
    if (blockUntilComplete) {
        return new Promise<void>(resolve => { start(resolve); });
    }
    start(() => { /* tween runs to completion in the background */ });
    return Promise.resolve();
}

/**
 * Resolve a FlowState ease name + strength into a gsap-compatible ease.
 *
 * Behaviour: falsy / `'none'` → `'none'`. For the two configurable-strength
 * gsap eases (`back`, `elastic`) a finite `strength > 0` is applied via
 * gsap's inline config string form (e.g. `back.out(2)`, `elastic.out(1.5)`),
 * validated with `gsap.parseEase`; everything else passes through verbatim.
 * Anything that fails validation falls back to `'power2.out'`. Ease
 * resolution never throws, so a bad ease name can't crash a tween.
 *
 * Exported so animation-clip keyframe eases resolve through the same path.
 */
export function resolveEase(ease: string, strength: number): string {
    try {
        if (!ease || ease === 'none') return 'none';
        const base = ease.split('.')[0];
        if ((base === 'back' || base === 'elastic') && Number.isFinite(strength) && strength > 0) {
            const configured = `${ease}(${strength})`;
            if (typeof gsap.parseEase(configured) === 'function') return configured;
        }
        if (typeof gsap.parseEase(ease) === 'function') return ease;
        return 'power2.out';
    } catch {
        return 'power2.out';
    }
}

export const transform = new TransformMethods();
