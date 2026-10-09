/**
 * Runtime half of a scene's optional `scene3d` section (three.js).
 *
 * The 3D view is drawn on its OWN WebGL canvas inserted immediately BEFORE the
 * Pixi canvas, so it sits beneath the 2D scene and shows through wherever the
 * 2D camera's background is `clear`. It renders only inside the 2D camera
 * frame's on-screen rect, handed in by `SceneManager.drawScene`.
 *
 * `three` is imported DYNAMICALLY, so a game with no 3D scene never fetches the
 * chunk. The game compiles with TypeScript 4.9 and `@types/three` needs TS 5,
 * so three is typed loosely (`any`) here on purpose.
 *
 * Only one scene is loaded at a time, so the most recently loaded scene with a
 * clear camera and a `scene3d` section owns the layer.
 *
 * Custom components on 3D nodes are instantiated by `SceneManager` through the
 * `Scene3DComponentHost` hook. The only static imports are the import-free
 * primitive-geometry, skybox and shadow-quality parity twins, so this module
 * cannot join an import cycle.
 *
 * Shadows follow the project's `SCENE3D_SHADOW_QUALITY`, read by `SceneManager`
 * and handed to `activate`: directional AND point lights cast, only while some
 * model / primitive casts, and directional shadow cameras are fitted to the
 * models + primitives on build and after every model load.
 *
 * FlowState 3D methods reach nodes through `getObjectById` / `whenReady` /
 * `whenModelReady`, and a model's glTF clips through `getMixer` / `getClips`.
 * Every queued callback is answered exactly once — `false` when the build
 * fails or the layer deactivates — so a waiting flow can never hang.
 */

import { createPrimitiveGeometry, primitiveMaterialParams, primitiveTextureParams } from './scene-3d-primitives';
import { applySkybox, normalizeSkybox } from './scene-3d-skybox';
import { applyShadowQuality, DEFAULT_SHADOW_QUALITY, fitDirectionalShadowCamera, normalizeShadowQuality } from './scene-3d-shadows';
import type { ShadowQuality } from './scene-3d-shadows';

export interface OrcaVec3 { x: number; y: number; z: number }

export interface OrcaTransform3D { position: OrcaVec3; rotation: OrcaVec3; scale: OrcaVec3 }

/** Mirrors the editor's exported `scene3d` node. Untrusted: every field is re-checked. */
export interface OrcaScene3DNode {
    id: string;
    type: string;
    name: string;
    visible: boolean;
    /** `rotation` is DEGREES, XYZ euler. */
    transform: OrcaTransform3D;
    children: OrcaScene3DNode[];
    // camera3d
    fov?: number;
    near?: number;
    far?: number;
    // model3d — bare bucket-relative `.glb` / `.gltf` path
    src?: string;
    // model3d + primitive3d
    castShadow?: boolean;
    receiveShadow?: boolean;
    // primitive3d — unit-sized; see scene-3d-primitives.ts
    shape?: string;
    roughness?: number;
    metalness?: number;
    /** Bare bucket-relative png / jpg / webp path; `color` tints it. */
    texture?: string;
    /** Tiling per axis, default 1; see `primitiveTextureParams`. */
    textureRepeat?: { x: number; y: number };
    // light3d
    lightType?: string;
    // light3d + primitive3d
    color?: string;
    intensity?: number;
    /** Same instance shape as a 2D node's `customComponents`. */
    customComponents?: unknown[] | null;
}

/** What a 3D host's components can reach beyond the shared context. */
export interface Scene3DComponentEnv {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    THREE: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getObject3DById(nodeId: string): any | null;
}

/** One 3D node's live components. Both methods are idempotent. */
export interface Scene3DComponentHandle {
    /** Runs every `onCreate`; called once the whole 3D tree is built. */
    start(): void;
    /** Runs every `onDestroy` and releases its subscriptions. */
    destroy(): void;
}

export interface Scene3DComponentHost {
    /** Instantiate `node`'s components on `object3d` without running `onCreate`; null when it has none. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attach(node: OrcaScene3DNode, object3d: any, env: Scene3DComponentEnv): Scene3DComponentHandle | null;
}

export interface OrcaScene3DData {
    nodes: OrcaScene3DNode[];
    /** `#rrggbb` — adds a scene-wide ambient light at intensity 1. */
    ambientColor?: string;
    /** Untrusted `Skybox3D`; see scene-3d-skybox.ts. Absent keeps the transparent background. */
    skybox?: unknown;
}

/** A rect in the Pixi renderer's LOGICAL (CSS) pixels, top-left origin. */
export interface Scene3DFrameRect { x: number; y: number; width: number; height: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreeAny = any;

interface ThreeModules {
    THREE: ThreeAny;
    GLTFLoader: ThreeAny;
    cloneSkinned: (source: ThreeAny) => ThreeAny;
}

const DEG_TO_RAD = Math.PI / 180;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Dispatched on every `AnimationMixer` right before the layer disposes it, so a
 * flow waiting for a clip to finish can complete. methods/scene3d.ts matches the
 * same literal (it may land before this file does).
 */
export const SCENE3D_MIXER_DISPOSED_EVENT = 'orcaMixerDisposed';

interface ModelLoadState {
    state: 'loading' | 'ready' | 'failed';
    waiters: Array<(ok: boolean) => void>;
}

let threeModulesPromise: Promise<ThreeModules> | null = null;

function loadThreeModules(): Promise<ThreeModules> {
    if (!threeModulesPromise) {
        threeModulesPromise = Promise.all([
            // @ts-ignore — three ships no types; see the header.
            import(/* webpackChunkName: "three" */ 'three'),
            // @ts-ignore — as above.
            import(/* webpackChunkName: "three" */ 'three/examples/jsm/loaders/GLTFLoader.js'),
            // @ts-ignore — as above.
            import(/* webpackChunkName: "three" */ 'three/examples/jsm/utils/SkeletonUtils.js'),
        ]).then(([THREE, gltf, skeletonUtils]: ThreeAny[]) => ({
            THREE,
            GLTFLoader: gltf.GLTFLoader,
            cloneSkinned: skeletonUtils.clone,
        }));
        threeModulesPromise.catch(() => { threeModulesPromise = null; });
    }
    return threeModulesPromise;
}

function finiteOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function colorOr(value: unknown, fallback: string): string {
    return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value : fallback;
}

export class Scene3DLayer {
    private pixiCanvas: HTMLCanvasElement | null = null;
    private resolution = 1;
    private canvas: HTMLCanvasElement | null = null;
    private renderer: ThreeAny = null;
    private scene: ThreeAny = null;
    private camera: ThreeAny = null;
    private active = false;
    private generation = 0;
    /** Frame rect normalised to the renderer's logical size, so it survives a CSS-only resize. */
    private frame: { x: number; y: number; width: number; height: number } | null = null;
    private aspect = 16 / 9;
    private box = '';
    private pixiPositionPatched = false;
    /** URL → `{ scene, animations }` of the loaded glTF. */
    private readonly modelCache = new Map<string, Promise<{ scene: ThreeAny; animations: ThreeAny[] }>>();
    /** The built scene's nodes by id; empty until the build completes. */
    private objectsById = new Map<string, ThreeAny>();
    private readyState: 'building' | 'ready' | 'failed' = 'building';
    private readyWaiters: Array<(ok: boolean) => void> = [];
    private modelStates = new Map<string, ModelLoadState>();
    /** One mixer per loaded model3d instance, by node id. */
    private mixers = new Map<string, ThreeAny>();
    private clipsById = new Map<string, ThreeAny[]>();
    /** Per-activation source textures by URL; each primitive assigns its own clone (shared image). */
    private textureCache = new Map<string, Promise<ThreeAny>>();
    private readonly warned = new Set<string>();
    private componentHandles: Array<{ handle: Scene3DComponentHandle; object: ThreeAny }> = [];
    private disposeSkybox: (() => void) | null = null;
    private shadowQuality: ShadowQuality = DEFAULT_SHADOW_QUALITY;
    /** Some model3d / primitive3d authors `castShadow`. */
    private anyShadowCaster = false;
    /** Authored directional / point lights. */
    private shadowLights: ThreeAny[] = [];
    /** Model clones and primitive meshes — what directional shadow cameras are fitted to. */
    private shadowContents: ThreeAny[] = [];

    /** The Pixi canvas the 3D canvas sits beneath, and the backing-store resolution to match. */
    public setHost(pixiCanvas: HTMLCanvasElement | null, resolution: number): void {
        this.pixiCanvas = pixiCanvas;
        this.resolution = Number.isFinite(resolution) && resolution > 0 ? resolution : 1;
        this.renderer?.setPixelRatio(this.resolution);
    }

    public isActive(): boolean {
        return this.active;
    }

    public isReady(): boolean {
        return this.active && this.readyState === 'ready';
    }

    /**
     * The node's Object3D: the holder Group for model3d / primitive3d, the light,
     * the camera, or the Group. `null` until the build completes.
     */
    public getObjectById(id: string): ThreeAny | null {
        if (!this.active || typeof id !== 'string') return null;
        return this.objectsById.get(id) ?? null;
    }

    /**
     * Run `cb(true)` once this activation's tree is built — immediately when it
     * already is. Queued callbacks get `cb(false)` if the build fails or the layer
     * deactivates first. Returns false (and never calls `cb`) while inactive or
     * after a failed build.
     */
    public whenReady(cb: (ok: boolean) => void): boolean {
        if (!this.active || this.readyState === 'failed') return false;
        if (this.readyState === 'ready') {
            cb(true);
            return true;
        }
        this.readyWaiters.push(cb);
        return true;
    }

    /**
     * Run `cb(true)` once model3d `id`'s glTF is loaded and its mixer exists, or
     * `cb(false)` if the load fails / the layer deactivates. Returns false (no
     * callback) when `id` is not a model3d of the built tree.
     */
    public whenModelReady(id: string, cb: (ok: boolean) => void): boolean {
        if (!this.isReady()) return false;
        const entry = this.modelStates.get(id);
        if (!entry) return false;
        if (entry.state === 'loading') entry.waiters.push(cb);
        else cb(entry.state === 'ready');
        return true;
    }

    /** The model3d's `AnimationMixer`, once its glTF has loaded. */
    public getMixer(id: string): ThreeAny | null {
        return this.active ? this.mixers.get(id) ?? null : null;
    }

    /** The model3d's glTF animation clips (empty until loaded, or when it has none). */
    public getClips(id: string): ThreeAny[] {
        return this.active ? this.clipsById.get(id) ?? [] : [];
    }

    /**
     * Build `data` and start rendering it. `resolveUrl` maps a bare model ref to
     * its scoped `/assets/…` URL; `shadowQuality` is untrusted (invalid ⇒ 'medium').
     */
    public activate(
        data: OrcaScene3DData,
        resolveUrl: (src: string) => string,
        components: Scene3DComponentHost | null = null,
        shadowQuality: unknown = DEFAULT_SHADOW_QUALITY,
    ): void {
        this.deactivate();
        this.active = true;
        this.readyState = 'building';
        this.shadowQuality = normalizeShadowQuality(shadowQuality);
        const generation = this.generation;
        void this.build(generation, data, resolveUrl, components);
    }

    /** Stop rendering, hide the canvas and free the scene's GPU resources. The WebGL context is kept for reuse. */
    public deactivate(): void {
        this.generation += 1;
        this.active = false;
        // Before disposal, so onDestroy still sees live objects.
        this.destroyComponents();
        this.releaseMixers();
        this.settleWaiters();
        this.releaseSkybox();
        this.disposeScene();
        this.modelCache.clear();
        this.releaseTextureCache();
        if (this.renderer) {
            try {
                this.renderer.setScissorTest(false);
                this.renderer.clear();
            } catch {
                // Context may already be lost.
            }
        }
        if (this.canvas) this.canvas.style.display = 'none';
        if (this.pixiPositionPatched && this.pixiCanvas) {
            this.pixiCanvas.style.position = '';
            this.pixiPositionPatched = false;
        }
    }

    /** Release the WebGL context and remove the canvas. */
    public destroy(): void {
        this.deactivate();
        if (this.renderer) {
            try {
                this.renderer.dispose();
                this.renderer.forceContextLoss();
            } catch {
                // Best effort.
            }
            this.renderer = null;
        }
        this.canvas?.parentNode?.removeChild(this.canvas);
        this.canvas = null;
        this.box = '';
    }

    /**
     * The 2D camera frame's on-screen rect, in the same logical pixels as
     * `viewportWidth` × `viewportHeight`. `null` renders nothing.
     */
    public setFrame(rect: Scene3DFrameRect | null, viewportWidth: number, viewportHeight: number): void {
        if (!rect || !(viewportWidth > 0) || !(viewportHeight > 0) || !(rect.width > 0) || !(rect.height > 0)) {
            this.frame = null;
            return;
        }
        this.frame = {
            x: rect.x / viewportWidth,
            y: rect.y / viewportHeight,
            width: rect.width / viewportWidth,
            height: rect.height / viewportHeight,
        };
        this.aspect = rect.width / rect.height;
        if (this.camera) {
            this.camera.aspect = this.aspect;
            this.camera.updateProjectionMatrix();
        }
    }

    /**
     * Advance the model mixers by `deltaSeconds` and draw one frame. Called from
     * the game ticker; a no-op while inactive or still loading. Mixers advance even
     * when there is no frame to draw, so a waiting clip still finishes.
     */
    public render(deltaSeconds = 0): void {
        if (!this.active || !this.scene) return;
        this.sweepDetachedComponents();
        this.updateMixers(deltaSeconds);
        if (!this.renderer || !this.camera || !this.frame || !this.canvas) return;
        const pixi = this.pixiCanvas;
        if (!pixi || !pixi.parentNode) return;
        try {
            this.attachBeneath(pixi);
            const width = pixi.clientWidth;
            const height = pixi.clientHeight;
            if (width <= 0 || height <= 0) return;
            this.syncBox(pixi, width, height);

            const x = this.frame.x * width;
            const w = this.frame.width * width;
            const h = this.frame.height * height;
            // three's viewport / scissor are GL-style: bottom-left origin.
            const y = height - (this.frame.y * height + h);

            this.renderer.setScissorTest(false);
            this.renderer.clear();
            this.renderer.setViewport(x, y, w, h);
            this.renderer.setScissor(x, y, w, h);
            this.renderer.setScissorTest(true);
            this.renderer.render(this.scene, this.camera);
            if (this.canvas.style.display === 'none') this.canvas.style.display = '';
        } catch (err) {
            this.warnOnce('render', '[Scene3D] Render failed; the 3D layer is disabled for this scene.', err);
            this.active = false;
            // Nothing advances the mixers any more; let waiting clips complete.
            this.releaseMixers();
        }
    }

    private updateMixers(deltaSeconds: number): void {
        if (this.mixers.size === 0 || !(deltaSeconds > 0) || !Number.isFinite(deltaSeconds)) return;
        for (const mixer of this.mixers.values()) {
            try {
                mixer.update(deltaSeconds);
            } catch (err) {
                this.warnOnce('mixer:update', '[Scene3D] Advancing a model animation failed.', err);
            }
        }
    }

    /** Announce disposal (see `SCENE3D_MIXER_DISPOSED_EVENT`), then stop and uncache every mixer. */
    private releaseMixers(): void {
        const mixers = Array.from(this.mixers.values());
        this.mixers.clear();
        this.clipsById.clear();
        for (const mixer of mixers) {
            try {
                mixer.dispatchEvent({ type: SCENE3D_MIXER_DISPOSED_EVENT });
            } catch (err) {
                this.warnOnce('mixer:dispose-event', '[Scene3D] A model animation listener failed on disposal.', err);
            }
            try {
                mixer.stopAllAction();
                mixer.uncacheRoot(mixer.getRoot());
            } catch (err) {
                this.warnOnce('mixer:dispose', '[Scene3D] Disposing a model animation mixer failed.', err);
            }
        }
    }

    /** Answer every queued layer / model waiter with `false`. */
    private settleWaiters(): void {
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        const models = Array.from(this.modelStates.values());
        this.modelStates = new Map();
        this.objectsById = new Map();
        for (const cb of waiters) this.callWaiter(cb, false);
        for (const entry of models) this.settleModel(entry, 'failed');
    }

    private settleModel(entry: ModelLoadState, state: 'ready' | 'failed'): void {
        if (entry.state !== 'loading') return;
        entry.state = state;
        const waiters = entry.waiters;
        entry.waiters = [];
        for (const cb of waiters) this.callWaiter(cb, state === 'ready');
    }

    private callWaiter(cb: (ok: boolean) => void, ok: boolean): void {
        try {
            cb(ok);
        } catch (err) {
            this.warnOnce('waiter', '[Scene3D] A queued 3D callback failed.', err);
        }
    }

    /** A failed build answers the queue with `false` and refuses later waits. */
    private failBuild(generation: number): void {
        if (generation !== this.generation) return;
        this.readyState = 'failed';
        this.settleWaiters();
    }

    private async build(
        generation: number,
        data: OrcaScene3DData,
        resolveUrl: (src: string) => string,
        components: Scene3DComponentHost | null,
    ): Promise<void> {
        let modules: ThreeModules;
        try {
            modules = await loadThreeModules();
        } catch (err) {
            this.warnOnce('import', '[Scene3D] Could not load three.js; the 3D section will not render.', err);
            this.failBuild(generation);
            return;
        }
        if (generation !== this.generation) return;
        const THREE = modules.THREE;
        if (!this.ensureRenderer(THREE)) {
            this.failBuild(generation);
            return;
        }

        const scene = new THREE.Scene();
        if (typeof data.ambientColor === 'string' && HEX_COLOR_RE.test(data.ambientColor)) {
            scene.add(new THREE.AmbientLight(data.ambientColor, 1));
        }

        let camera: ThreeAny = null;
        const shadowLights: ThreeAny[] = [];
        let wantsShadows = false;
        this.shadowContents = [];
        const objectsById = new Map<string, ThreeAny>();
        const modelStates = new Map<string, ModelLoadState>();
        const handles: Array<{ handle: Scene3DComponentHandle; object: ThreeAny }> = [];
        const env: Scene3DComponentEnv = {
            THREE,
            getObject3DById: (nodeId: string) => (typeof nodeId === 'string' ? objectsById.get(nodeId) ?? null : null),
        };

        const buildNode = (node: OrcaScene3DNode, parent: ThreeAny): void => {
            if (!node || typeof node !== 'object') return;
            let object: ThreeAny;
            switch (node.type) {
                case 'camera3d': {
                    if (camera) return;
                    object = new THREE.PerspectiveCamera(
                        finiteOr(node.fov, 50),
                        this.aspect,
                        finiteOr(node.near, 0.1),
                        finiteOr(node.far, 1000),
                    );
                    camera = object;
                    break;
                }
                case 'light3d': {
                    const color = colorOr(node.color, '#ffffff');
                    const intensity = Math.max(0, finiteOr(node.intensity, 1));
                    if (node.lightType === 'ambient') {
                        object = new THREE.AmbientLight(color, intensity);
                    } else if (node.lightType === 'point') {
                        object = new THREE.PointLight(color, intensity);
                        shadowLights.push(object);
                    } else {
                        // Aims at its default target, the world origin.
                        object = new THREE.DirectionalLight(color, intensity);
                        shadowLights.push(object);
                    }
                    break;
                }
                case 'model3d': {
                    object = new THREE.Group();
                    if (node.castShadow === true) wantsShadows = true;
                    let loadState: ModelLoadState | null = null;
                    if (typeof node.id === 'string' && node.id && !modelStates.has(node.id)) {
                        loadState = { state: 'loading', waiters: [] };
                        modelStates.set(node.id, loadState);
                    }
                    this.loadModelInto(object, node, generation, modules, resolveUrl, loadState);
                    break;
                }
                case 'primitive3d': {
                    // Holder Group, like model3d, so transform + components never touch the mesh.
                    object = new THREE.Group();
                    if (node.castShadow === true) wantsShadows = true;
                    object.add(this.createPrimitiveMesh(THREE, node, generation, resolveUrl));
                    break;
                }
                default:
                    object = new THREE.Group();
                    break;
            }
            object.name = typeof node.name === 'string' ? node.name : '';
            object.userData.orcaNodeType = node.type;
            object.visible = node.visible !== false;
            this.applyTransform(object, node.transform);
            parent.add(object);
            if (typeof node.id === 'string' && node.id && !objectsById.has(node.id)) objectsById.set(node.id, object);
            // A model3d's `object` is the holder Group, so components never wait on the glTF.
            if (components && Array.isArray(node.customComponents) && node.customComponents.length > 0) {
                try {
                    const handle = components.attach(node, object, env);
                    if (handle) handles.push({ handle, object });
                } catch (err) {
                    this.warnOnce(`components:${node.id}`, `[Scene3D] Components on "${node.name}" failed to attach.`, err);
                }
            }
            if (node.type !== 'camera3d' && Array.isArray(node.children)) {
                for (const child of node.children) buildNode(child, object);
            }
        };

        try {
            for (const node of Array.isArray(data.nodes) ? data.nodes : []) buildNode(node, scene);
        } catch (err) {
            for (const entry of handles) this.destroyHandle(entry.handle);
            this.warnOnce('build', '[Scene3D] Building the 3D section failed; it will not render.', err);
            this.modelStates = modelStates;
            this.failBuild(generation);
            return;
        }

        if (!camera) {
            this.warnOnce('camera', '[Scene3D] scene3d has no camera3d; using a default perspective camera.');
            camera = new THREE.PerspectiveCamera(50, this.aspect, 0.1, 1000);
            camera.position.set(0, 1.5, 5);
            scene.add(camera);
        }

        this.scene = scene;
        this.camera = camera;
        this.objectsById = objectsById;
        this.modelStates = modelStates;
        this.componentHandles = handles;
        this.anyShadowCaster = wantsShadows;
        this.shadowLights = shadowLights;
        this.syncShadows(THREE);
        this.loadSkybox(THREE, scene, data, generation, resolveUrl);

        for (const entry of handles) {
            // An onCreate may load another scene, which deactivates this layer.
            if (generation !== this.generation) break;
            try {
                entry.handle.start();
            } catch (err) {
                this.warnOnce('components:start', '[Scene3D] Starting 3D components failed.', err);
            }
        }

        // After onCreate, so flows queued during the build override component setup.
        if (generation !== this.generation) return;
        this.readyState = 'ready';
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const cb of waiters) {
            // A flow may load another scene, which answers the rest with false.
            this.callWaiter(cb, generation === this.generation);
        }
    }

    /** Apply the project's shadow tier, then fit every casting directional light to the models + primitives. */
    private syncShadows(THREE: ThreeAny): void {
        const scene = this.scene;
        if (!this.renderer || !scene) return;
        try {
            applyShadowQuality(THREE, this.renderer, scene, this.shadowQuality, {
                anyCaster: this.anyShadowCaster,
                lights: this.shadowLights,
            });
            if (!this.renderer.shadowMap.enabled) return;
            scene.updateMatrixWorld();
            const box = new THREE.Box3();
            for (const content of this.shadowContents) box.expandByObject(content);
            for (const light of this.shadowLights) fitDirectionalShadowCamera(THREE, light, box);
        } catch (err) {
            this.warnOnce('shadows', '[Scene3D] Applying the shadow quality failed.', err);
        }
    }

    /** Asynchronous for image skies; a scene swap mid-load discards the result. */
    private loadSkybox(
        THREE: ThreeAny,
        scene: ThreeAny,
        data: OrcaScene3DData,
        generation: number,
        resolveUrl: (src: string) => string,
    ): void {
        const skybox = normalizeSkybox(data.skybox);
        if (!skybox) return;
        const isStale = (): boolean => generation !== this.generation || this.scene !== scene;
        applySkybox(THREE, scene, skybox, resolveUrl, isStale).then((dispose) => {
            if (isStale()) {
                dispose();
                return;
            }
            this.releaseSkybox();
            this.disposeSkybox = dispose;
        }).catch((err: unknown) => {
            this.warnOnce('skybox', '[Scene3D] Applying the skybox failed.', err);
        });
    }

    private releaseSkybox(): void {
        const dispose = this.disposeSkybox;
        this.disposeSkybox = null;
        if (!dispose) return;
        try {
            dispose();
        } catch (err) {
            this.warnOnce('skybox:dispose', '[Scene3D] Disposing the skybox failed.', err);
        }
    }

    private destroyComponents(): void {
        const handles = this.componentHandles;
        this.componentHandles = [];
        for (const entry of handles) this.destroyHandle(entry.handle);
    }

    /** A node whose Object3D has left the 3D scene counts as removed. */
    private sweepDetachedComponents(): void {
        if (this.componentHandles.length === 0) return;
        const scene = this.scene;
        const kept: Array<{ handle: Scene3DComponentHandle; object: ThreeAny }> = [];
        const removed: Scene3DComponentHandle[] = [];
        for (const entry of this.componentHandles) {
            let cursor: ThreeAny = entry.object;
            while (cursor && cursor !== scene) cursor = cursor.parent;
            if (cursor === scene) kept.push(entry);
            else removed.push(entry.handle);
        }
        if (removed.length === 0) return;
        this.componentHandles = kept;
        for (const handle of removed) this.destroyHandle(handle);
    }

    private destroyHandle(handle: Scene3DComponentHandle): void {
        try {
            handle.destroy();
        } catch (err) {
            this.warnOnce('components:destroy', '[Scene3D] Destroying 3D components failed.', err);
        }
    }

    private loadModelInto(
        holder: ThreeAny,
        node: OrcaScene3DNode,
        generation: number,
        modules: ThreeModules,
        resolveUrl: (src: string) => string,
        loadState: ModelLoadState | null,
    ): void {
        const fail = (): void => {
            if (loadState) this.settleModel(loadState, 'failed');
        };
        const src = typeof node.src === 'string' ? node.src.trim() : '';
        if (!src) {
            fail();
            return;
        }
        let url: string;
        try {
            url = resolveUrl(src);
        } catch (err) {
            this.warnOnce(`model:${src}`, `[Scene3D] Could not resolve model "${src}".`, err);
            fail();
            return;
        }
        let pending = this.modelCache.get(url);
        if (!pending) {
            const loaded: Promise<{ scene: ThreeAny; animations: ThreeAny[] }> = new modules.GLTFLoader()
                .loadAsync(url)
                .then((gltf: ThreeAny) => ({ scene: gltf.scene, animations: Array.isArray(gltf.animations) ? gltf.animations : [] }));
            this.modelCache.set(url, loaded);
            pending = loaded;
        }
        const request = pending;
        request.then((source) => {
            if (generation !== this.generation) return;
            const instance = modules.cloneSkinned(source.scene);
            instance.traverse((child: ThreeAny) => {
                if (!child.isMesh) return;
                child.castShadow = node.castShadow === true;
                child.receiveShadow = node.receiveShadow === true;
            });
            holder.add(instance);
            this.shadowContents.push(instance);
            this.syncShadows(modules.THREE);
            if (typeof node.id === 'string' && node.id && !this.mixers.has(node.id)) {
                // Clips bind by track name, which the skinned clone preserves.
                this.mixers.set(node.id, new modules.THREE.AnimationMixer(instance));
                this.clipsById.set(node.id, source.animations);
            }
            if (loadState) this.settleModel(loadState, 'ready');
        }).catch((err: unknown) => {
            if (this.modelCache.get(url) === request) this.modelCache.delete(url);
            this.warnOnce(`model:${url}`, `[Scene3D] Model "${src}" failed to load (${url}).`, err);
            if (generation === this.generation) fail();
        });
    }

    /** Geometry, material and the map clone are per-node, so `disposeScene`'s traversal frees them. */
    private createPrimitiveMesh(
        THREE: ThreeAny,
        node: OrcaScene3DNode,
        generation: number,
        resolveUrl: (src: string) => string,
    ): ThreeAny {
        const params = primitiveMaterialParams(node);
        const material = new THREE.MeshStandardMaterial({
            color: params.color,
            roughness: params.roughness,
            metalness: params.metalness,
            side: params.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
        });
        const mesh = new THREE.Mesh(createPrimitiveGeometry(THREE, typeof node.shape === 'string' ? node.shape : ''), material);
        mesh.castShadow = node.castShadow === true;
        mesh.receiveShadow = node.receiveShadow === true;
        this.shadowContents.push(mesh);
        this.loadPrimitiveTexture(THREE, material, node, generation, resolveUrl);
        return mesh;
    }

    /** Until (and unless) the image loads, the material stays untextured. */
    private loadPrimitiveTexture(
        THREE: ThreeAny,
        material: ThreeAny,
        node: OrcaScene3DNode,
        generation: number,
        resolveUrl: (src: string) => string,
    ): void {
        const texture = primitiveTextureParams(node);
        if (!texture) return;
        let url: string;
        try {
            url = resolveUrl(texture.ref);
        } catch (err) {
            this.warnOnce(`texture:${texture.ref}`, `[Scene3D] Could not resolve texture "${texture.ref}".`, err);
            return;
        }
        let pending: Promise<ThreeAny> | undefined = this.textureCache.get(url);
        if (!pending) {
            pending = new THREE.TextureLoader().loadAsync(url) as Promise<ThreeAny>;
            this.textureCache.set(url, pending);
        }
        pending.then((source: ThreeAny) => {
            if (generation !== this.generation) return;
            // A clone shares the source image, so one upload serves every node using this URL.
            const map = source.clone();
            map.colorSpace = THREE.SRGBColorSpace;
            map.wrapS = texture.repeatX !== 1 ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
            map.wrapT = texture.repeatY !== 1 ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
            map.repeat.set(texture.repeatX, texture.repeatY);
            const maxAnisotropy = this.renderer?.capabilities?.getMaxAnisotropy?.();
            if (typeof maxAnisotropy === 'number' && maxAnisotropy > 0) map.anisotropy = maxAnisotropy;
            map.needsUpdate = true;
            material.map = map;
            material.needsUpdate = true;
        }).catch((err: unknown) => {
            this.warnOnce(`texture:${url}`, `[Scene3D] Texture "${texture.ref}" failed to load (${url}); the primitive stays untextured.`, err);
        });
    }

    /** Each cached source is disposed once it settles, including loads still in flight. */
    private releaseTextureCache(): void {
        const cache = this.textureCache;
        this.textureCache = new Map();
        for (const pending of cache.values()) {
            pending.then((source: ThreeAny) => source?.dispose?.(), () => undefined);
        }
    }

    private applyTransform(object: ThreeAny, transform: OrcaTransform3D | undefined): void {
        const position = transform?.position;
        const rotation = transform?.rotation;
        const scale = transform?.scale;
        object.position.set(finiteOr(position?.x, 0), finiteOr(position?.y, 0), finiteOr(position?.z, 0));
        object.rotation.set(
            finiteOr(rotation?.x, 0) * DEG_TO_RAD,
            finiteOr(rotation?.y, 0) * DEG_TO_RAD,
            finiteOr(rotation?.z, 0) * DEG_TO_RAD,
            'XYZ',
        );
        object.scale.set(finiteOr(scale?.x, 1), finiteOr(scale?.y, 1), finiteOr(scale?.z, 1));
    }

    private ensureRenderer(THREE: ThreeAny): boolean {
        if (this.renderer) return true;
        if (typeof document === 'undefined') return false;
        const canvas = document.createElement('canvas');
        canvas.setAttribute('data-orca-scene-3d', '');
        canvas.style.position = 'absolute';
        canvas.style.pointerEvents = 'none';
        canvas.style.display = 'none';
        try {
            this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
        } catch (err) {
            this.warnOnce('webgl', '[Scene3D] Could not create a WebGL context; the 3D section will not render.', err);
            return false;
        }
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.setPixelRatio(this.resolution);
        this.canvas = canvas;
        this.box = '';
        return true;
    }

    /** Keep the 3D canvas as the Pixi canvas's PREVIOUS sibling, and both positioned so tree order decides paint order. */
    private attachBeneath(pixi: HTMLCanvasElement): void {
        const canvas = this.canvas!;
        const parent = pixi.parentNode!;
        if (canvas.parentNode !== parent || canvas.nextSibling !== pixi) {
            parent.insertBefore(canvas, pixi);
            this.box = '';
        }
        // A static Pixi canvas would paint UNDER the absolutely positioned 3D canvas.
        if (!this.pixiPositionPatched && getComputedStyle(pixi).position === 'static') {
            pixi.style.position = 'relative';
            this.pixiPositionPatched = true;
        }
    }

    private syncBox(pixi: HTMLCanvasElement, width: number, height: number): void {
        const left = pixi.offsetLeft + pixi.clientLeft;
        const top = pixi.offsetTop + pixi.clientTop;
        const key = `${left},${top},${width},${height}`;
        if (key === this.box) return;
        this.box = key;
        const style = this.canvas!.style;
        style.left = `${left}px`;
        style.top = `${top}px`;
        style.width = `${width}px`;
        style.height = `${height}px`;
        this.renderer.setSize(width, height, false);
    }

    private disposeScene(): void {
        const scene = this.scene;
        this.scene = null;
        this.camera = null;
        this.anyShadowCaster = false;
        this.shadowLights = [];
        this.shadowContents = [];
        if (!scene) return;
        try {
            scene.traverse((object: ThreeAny) => {
                object.geometry?.dispose?.();
                const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
                for (const material of materials) {
                    for (const value of Object.values(material)) {
                        if ((value as ThreeAny)?.isTexture) (value as ThreeAny).dispose();
                    }
                    material.dispose?.();
                }
                object.dispose?.();
            });
            scene.clear();
        } catch (err) {
            this.warnOnce('dispose', '[Scene3D] Disposing the 3D scene failed.', err);
        }
    }

    private warnOnce(key: string, message: string, err?: unknown): void {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        if (err === undefined) console.warn(message);
        else console.warn(message, err);
    }
}
