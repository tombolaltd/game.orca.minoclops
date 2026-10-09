import gsap from "gsap";
import type { Node3DRefLike } from "./node3d-ref";
import { getModel3DClips, getModel3DMixer, node3DRefId, resolveNode3D, resolveNode3DDeferred } from "./node3d-ref";
import { resolveEase, runTween } from "./transform";

/**
 * FlowState controls for `scene3d` nodes (AGENTS.md rule 29). Every target is a
 * `node3dRef` / `node3dRefBySkin` (./node3d-ref.ts).
 *
 * three.js is never imported here: the objects come from the 3D layer, and the
 * two loop-mode values are three's stable constants.
 *
 * Contract:
 * - Changes are RUNTIME-ONLY; the authored `scene3d` transform is never written back.
 * - Rotation is in DEGREES, like the authored data; three receives radians.
 * - Tweens mirror `transform.tweenNodePosition` exactly: `durationMS`,
 *   `resolveEase(ease, easeStrength)`, `runTween(sequenceNodeOn, …)`; a duration
 *   <= 0 snaps.
 * - Mutations wait for the 3D tree to build (it builds asynchronously after a
 *   scene loads). A target that cannot resolve — missing, 3D disabled, layer
 *   inactive, scene swapped — is a no-op, and a SEQUENCED call completes at once
 *   so the flow never hangs.
 */

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// three's LoopOnce / LoopRepeat.
const LOOP_ONCE = 2200;
const LOOP_REPEAT = 2201;
// Must match SCENE3D_MIXER_DISPOSED_EVENT in ../scene-3d.ts.
const MIXER_DISPOSED_EVENT = 'orcaMixerDisposed';

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(message);
}

function finiteOr(value: unknown, fallback: number): number {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Degree proxy per object, so a rotation tween targets one stable gsap object like 2D's `o`. */
const rotationProxies = new WeakMap<object, { x: number; y: number; z: number }>();
function rotationProxyOf(o: any): { x: number; y: number; z: number } {
    let proxy = rotationProxies.get(o);
    if (!proxy) {
        proxy = { x: 0, y: 0, z: 0 };
        rotationProxies.set(o, proxy);
    }
    if (!gsap.isTweening(proxy)) {
        proxy.x = o.rotation.x * RAD_TO_DEG;
        proxy.y = o.rotation.y * RAD_TO_DEG;
        proxy.z = o.rotation.z * RAD_TO_DEG;
    }
    return proxy;
}

function applyRotationDegrees(o: any, x: number, y: number, z: number): void {
    o.rotation.set(x * DEG_TO_RAD, y * DEG_TO_RAD, z * DEG_TO_RAD);
}

/** Run `body` with the resolved object; a throw is logged, never propagated into the resolver. */
function withNode3D(target: Node3DRefLike, label: string, body: (o: any) => void, options?: { waitForModel?: boolean }): void {
    resolveNode3DDeferred(target, (o) => {
        if (!o) return;
        try {
            body(o);
        } catch (err) {
            console.warn(`[FlowState] ${label} failed`, err);
        }
    }, options);
}

/**
 * The sequenced form: `start(o, onComplete)` runs once `o` resolves, and
 * `onComplete` fires at once when it cannot resolve or `start` throws.
 */
function sequenceNode3D(
    target: Node3DRefLike,
    label: string,
    sequenceNodeOn: string,
    start: (o: any, onComplete: () => void) => void,
    options?: { waitForModel?: boolean },
): Promise<void> {
    return runTween(sequenceNodeOn, (onComplete) => {
        resolveNode3DDeferred(target, (o) => {
            if (!o) {
                onComplete();
                return;
            }
            try {
                start(o, onComplete);
            } catch (err) {
                console.warn(`[FlowState] ${label} failed`, err);
                onComplete();
            }
        }, options);
    });
}

// ── Model clip bookkeeping ─────────────────────────────────────────────────
// Module-level (not instance fields): findMethod recurses into own object properties.

/** Pending sequenced completions per mixer, by action. */
const pendingClipCompletions = new WeakMap<object, Map<object, () => void>>();
const currentActions = new WeakMap<object, any>();
const listenedMixers = new WeakSet<object>();

function settlePending(mixer: any, action?: any): void {
    const pending = pendingClipCompletions.get(mixer);
    if (!pending) return;
    const entries = action ? (pending.has(action) ? [[action, pending.get(action)!] as const] : []) : Array.from(pending.entries());
    for (const [key, done] of entries) {
        pending.delete(key);
        done();
    }
}

function listenToMixer(mixer: any): void {
    if (listenedMixers.has(mixer)) return;
    listenedMixers.add(mixer);
    mixer.addEventListener('finished', (event: { action?: unknown }) => settlePending(mixer, event.action));
    mixer.addEventListener(MIXER_DISPOSED_EVENT, () => {
        settlePending(mixer);
        currentActions.delete(mixer);
    });
}

function applyColor(target: { set(value: unknown): unknown } | undefined, color: unknown): boolean {
    if (!target || typeof target.set !== 'function') return false;
    if (typeof color === 'string' && HEX_COLOR_RE.test(color.trim())) {
        target.set(color.trim());
        return true;
    }
    if (typeof color === 'number' && Number.isFinite(color) && color >= 0 && color <= 0xffffff) {
        target.set(Math.floor(color));
        return true;
    }
    return false;
}

function nodeType(o: any): string {
    return typeof o?.userData?.orcaNodeType === 'string' ? o.userData.orcaNodeType : '';
}

class Scene3DMethods {
    public setNode3DPosition(target: Node3DRefLike, x: number, y: number, z: number): void {
        withNode3D(target, 'setNode3DPosition', (o) => {
            o.position.set(finiteOr(x, o.position.x), finiteOr(y, o.position.y), finiteOr(z, o.position.z));
        });
    }

    public setNode3DRotation(target: Node3DRefLike, x: number, y: number, z: number): void {
        withNode3D(target, 'setNode3DRotation', (o) => {
            applyRotationDegrees(
                o,
                finiteOr(x, o.rotation.x * RAD_TO_DEG),
                finiteOr(y, o.rotation.y * RAD_TO_DEG),
                finiteOr(z, o.rotation.z * RAD_TO_DEG),
            );
        });
    }

    public setNode3DScale(target: Node3DRefLike, x: number, y: number, z: number): void {
        withNode3D(target, 'setNode3DScale', (o) => {
            o.scale.set(finiteOr(x, o.scale.x), finiteOr(y, o.scale.y), finiteOr(z, o.scale.z));
        });
    }

    public tweenNode3DPosition(target: Node3DRefLike, x: number, y: number, z: number, durationMS: number, ease: string, easeStrength: number, sequenceNodeOn: string): Promise<void> {
        return sequenceNode3D(target, 'tweenNode3DPosition', sequenceNodeOn, (o, onComplete) => {
            const to = { x: finiteOr(x, o.position.x), y: finiteOr(y, o.position.y), z: finiteOr(z, o.position.z) };
            if (!(durationMS > 0)) {
                o.position.set(to.x, to.y, to.z);
                onComplete();
                return;
            }
            gsap.to(o.position, { ...to, duration: durationMS / 1000, ease: resolveEase(ease, easeStrength), onComplete });
        });
    }

    public tweenNode3DRotation(target: Node3DRefLike, x: number, y: number, z: number, durationMS: number, ease: string, easeStrength: number, sequenceNodeOn: string): Promise<void> {
        return sequenceNode3D(target, 'tweenNode3DRotation', sequenceNodeOn, (o, onComplete) => {
            const proxy = rotationProxyOf(o);
            const to = { x: finiteOr(x, proxy.x), y: finiteOr(y, proxy.y), z: finiteOr(z, proxy.z) };
            if (!(durationMS > 0)) {
                Object.assign(proxy, to);
                applyRotationDegrees(o, to.x, to.y, to.z);
                onComplete();
                return;
            }
            gsap.to(proxy, {
                ...to,
                duration: durationMS / 1000,
                ease: resolveEase(ease, easeStrength),
                onUpdate: () => applyRotationDegrees(o, proxy.x, proxy.y, proxy.z),
                onComplete,
            });
        });
    }

    public tweenNode3DScale(target: Node3DRefLike, x: number, y: number, z: number, durationMS: number, ease: string, easeStrength: number, sequenceNodeOn: string): Promise<void> {
        return sequenceNode3D(target, 'tweenNode3DScale', sequenceNodeOn, (o, onComplete) => {
            const to = { x: finiteOr(x, o.scale.x), y: finiteOr(y, o.scale.y), z: finiteOr(z, o.scale.z) };
            if (!(durationMS > 0)) {
                o.scale.set(to.x, to.y, to.z);
                onComplete();
                return;
            }
            gsap.to(o.scale, { ...to, duration: durationMS / 1000, ease: resolveEase(ease, easeStrength), onComplete });
        });
    }

    public showNode3D(target: Node3DRefLike): void {
        withNode3D(target, 'showNode3D', (o) => { o.visible = true; });
    }

    public hideNode3D(target: Node3DRefLike): void {
        withNode3D(target, 'hideNode3D', (o) => { o.visible = false; });
    }

    /**
     * Turn `target` to face `lookTarget`'s world position. Cameras and lights
     * face along -Z and three's `lookAt` accounts for that; a directional light
     * shines at its `target`, which is moved to the same point.
     */
    public lookAtNode3D(target: Node3DRefLike, lookTarget: Node3DRefLike): void {
        withNode3D(target, 'lookAtNode3D', (o) => {
            const other = resolveNode3D(lookTarget);
            if (!other || other === o) return;
            other.updateWorldMatrix(true, false);
            const point = other.getWorldPosition(o.position.clone());
            o.lookAt(point);
            if (o.isDirectionalLight && o.target) {
                o.target.position.copy(point);
                if (o.target.parent) o.target.parent.worldToLocal(o.target.position);
                o.target.updateMatrixWorld(true);
            }
        });
    }

    /** `color` is `#rrggbb` or a 0xRRGGBB number; applies to the primitive's own mesh. */
    public setPrimitive3DColor(target: Node3DRefLike, color: string | number): void {
        withNode3D(target, 'setPrimitive3DColor', (o) => {
            if (nodeType(o) !== 'primitive3d') {
                warnOnce(`primitive:${node3DRefId(target)}`, `[FlowState] setPrimitive3DColor: 3D node ${node3DRefId(target)} is not a primitive3d.`);
                return;
            }
            let applied = false;
            for (const child of o.children) {
                if (!child?.isMesh) continue;
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                for (const material of materials) {
                    if (applyColor(material?.color, color)) applied = true;
                }
            }
            if (!applied) warnOnce(`color:${String(color)}`, `[FlowState] setPrimitive3DColor: "${String(color)}" is not a #rrggbb colour.`);
        });
    }

    public setLight3DColor(target: Node3DRefLike, color: string | number): void {
        withNode3D(target, 'setLight3DColor', (o) => {
            if (!o.isLight) {
                warnOnce(`light:${node3DRefId(target)}`, `[FlowState] setLight3DColor: 3D node ${node3DRefId(target)} is not a light3d.`);
                return;
            }
            if (!applyColor(o.color, color)) warnOnce(`color:${String(color)}`, `[FlowState] setLight3DColor: "${String(color)}" is not a #rrggbb colour.`);
        });
    }

    public setLight3DIntensity(target: Node3DRefLike, intensity: number): void {
        withNode3D(target, 'setLight3DIntensity', (o) => {
            if (!o.isLight) {
                warnOnce(`light:${node3DRefId(target)}`, `[FlowState] setLight3DIntensity: 3D node ${node3DRefId(target)} is not a light3d.`);
                return;
            }
            o.intensity = Math.max(0, finiteOr(intensity, o.intensity));
        });
    }

    /** Vertical field of view in degrees, clamped to 1–179. */
    public setCamera3DFov(target: Node3DRefLike, fov: number): void {
        withNode3D(target, 'setCamera3DFov', (o) => {
            if (!o.isPerspectiveCamera) {
                warnOnce(`camera:${node3DRefId(target)}`, `[FlowState] setCamera3DFov: 3D node ${node3DRefId(target)} is not a camera3d.`);
                return;
            }
            o.fov = Math.min(179, Math.max(1, finiteOr(fov, o.fov)));
            o.updateProjectionMatrix();
        });
    }

    /**
     * Play a glTF clip on a model3d, cross-fading from the clip it is playing.
     * Waits for the model to load. With `sequenceNodeOn === 'onComplete'` the
     * flow resumes when a non-looping clip finishes (it holds its last frame),
     * immediately for a looping clip, and immediately when the target or clip is
     * missing. A later play / stop on the same model also completes it.
     * `timeScale` 0 or non-numeric means 1; negative plays backwards.
     */
    public playModel3DClip(target: Node3DRefLike, clipName: string, loop: boolean, crossFadeMS: number, timeScale: number, sequenceNodeOn: string): Promise<void> {
        return sequenceNode3D(target, 'playModel3DClip', sequenceNodeOn, (_o, onComplete) => {
            const id = node3DRefId(target) ?? '';
            const mixer = getModel3DMixer(id);
            const name = typeof clipName === 'string' ? clipName : '';
            const clip = getModel3DClips(id).find((c) => c?.name === name);
            if (!mixer || !clip) {
                warnOnce(`clip:${id}:${name}`, `[FlowState] playModel3DClip: model ${id} has no clip "${name}".`);
                onComplete();
                return;
            }
            listenToMixer(mixer);
            settlePending(mixer);

            const previous = currentActions.get(mixer);
            const action = mixer.clipAction(clip);
            const scale = finiteOr(timeScale, 1) || 1;
            action.reset();
            action.setLoop(loop ? LOOP_REPEAT : LOOP_ONCE, Infinity);
            action.clampWhenFinished = !loop;
            action.timeScale = scale;
            if (scale < 0) action.time = clip.duration;
            action.setEffectiveWeight(1);
            action.play();
            const fadeMS = finiteOr(crossFadeMS, 0);
            if (previous && previous !== action) {
                if (fadeMS > 0) action.crossFadeFrom(previous, fadeMS / 1000, false);
                else previous.stop();
            }
            currentActions.set(mixer, action);

            if (loop) {
                onComplete();
                return;
            }
            let pending = pendingClipCompletions.get(mixer);
            if (!pending) {
                pending = new Map();
                pendingClipCompletions.set(mixer, pending);
            }
            pending.set(action, onComplete);
        }, { waitForModel: true });
    }

    /** Stop the model's current clip, fading out over `fadeOutMS` (0 = at once). Completes any flow waiting on it. */
    public stopModel3DClip(target: Node3DRefLike, fadeOutMS: number): void {
        withNode3D(target, 'stopModel3DClip', () => {
            const id = node3DRefId(target) ?? '';
            const mixer = getModel3DMixer(id);
            if (!mixer) return;
            const current = currentActions.get(mixer);
            currentActions.delete(mixer);
            settlePending(mixer);
            const fadeMS = finiteOr(fadeOutMS, 0);
            if (current && fadeMS > 0) current.fadeOut(fadeMS / 1000);
            else mixer.stopAllAction();
        }, { waitForModel: true });
    }
}

export const scene3d = new Scene3DMethods();
