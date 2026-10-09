import { Application, ApplicationOptions } from 'pixi.js';

import { container, IGameApp, eventEmitter, userModel } from '@game-studio/arcade-base';

import { gameModel } from '../../models/game-model';
import {
    enterJackpotsRuntime,
    initJackpotsRuntime,
    resizeJackpotsRuntime,
} from '../../services/jackpots/jackpots-runtime';
import { Flowstate } from '../../services/orca/flowstate';
import animationPlayer from '../../services/orca/animation-player';
import { installGameFeelProbe } from '../../services/orca/game-feel-probe';
import sceneManager from '../../services/orca/scene-manager';
import { gameEventEmitter } from '@/src/events';

export class GameApplication implements IGameApp {

    // Application is static so it can be accessed easily for things like RenderTextures
    public static pixiApp: Application;

    public async initPixi(options: Partial<ApplicationOptions>): Promise<Application> {
        Flowstate.init();
        Flowstate.eventTriggers.application.onInitPixi();
        // NOTE: do NOT enable `autoDensity` here. The arcade-base GameView
        // sizes the <canvas> purely via CSS (`.canvas-view { width:100%;
        // height:100% }`), reads that computed size with
        // `getBoundingClientRect()`, and drives `gameApp.resize()` from it.
        // `autoDensity` makes Pixi write inline `canvas.style.width/height`
        // (backing size ÷ resolution) on every `renderer.resize()`, which
        // overrides the `100%` rule and locks the canvas to a fixed pixel
        // size — so the view stops re-filling its container on orientation
        // change. Keep the default so CSS continues to own the canvas size.
        //
        // `resolution: 2` CAPS the backing store. arcade-base's GameView asks
        // for `devicePixelRatio` (and 4 on a retina desktop), which on a large
        // display costs far more fill rate than the art can use. Pixi 8 reads
        // `renderer.resolution` live on every hit test — the pixi-6
        // InteractionManager, which snapshotted it once in
        // `setTargetElement(view, renderer.resolution)` and mis-scaled every
        // pointer coordinate after a later reassignment, no longer exists —
        // so the cap is now purely a rendering-cost decision.
        //
        // From Pixi 8 the constructor takes NO options and builds NO renderer:
        // `app.init(options)` is what creates it, and it is async because the
        // renderer is auto-detected (WebGPU/WebGL). The static is published
        // only once `init()` has resolved, so no caller can observe a
        // renderer-less Application. arcade-base awaits this Promise before it
        // calls `preInit()` / `init()`, which is what keeps the boot order
        // below deterministic.
        //
        // A camera background of `clear` (the 3D layer shows through) needs an
        // alpha-capable context, which Pixi 8 only creates when backgroundAlpha
        // is below 1 at init; the host's alpha is restored straight after.
        // Optional-called so this file still builds against an older scene-manager.
        const transparent = (sceneManager as unknown as { requiresTransparentCanvas?: () => boolean }).requiresTransparentCanvas?.() === true;
        const app = new Application();
        await app.init({ ...options, resolution: 2, ...(transparent ? { backgroundAlpha: 0 } : {}) });
        if (transparent) app.renderer.background.alpha = options.backgroundAlpha ?? 1;
        GameApplication.pixiApp = app;

        return GameApplication.pixiApp;
    }

    public async preInit(): Promise<void> {
        Flowstate.eventTriggers.application.onApplicationPreInit();
        await sceneManager.buildScenes();

        // Register Animation Timeline clips (core + active skin). gsap drives
        // its own ticker, so no per-frame hook is needed.
        animationPlayer.init();

        // TODO: Initialise any constant dynamic strings
        // TODO: Initialise components and add them to the scene here

        // Hand the cabinet view to SceneManager so its draw order is
        // controlled by the `cabinet` system-singleton node's position
        // among root-level scene siblings (authored in the editor's scene
        // hierarchy). SceneManager parks the view on the persistent DDOL
        // host until the first loadScene() and rebinds it into each new
        // scene's cabinet mount point on every subsequent load.
        sceneManager.attachCabinet(container.cabinet);
        // bigWin has no editor-side scene-graph node, so it stays directly
        // on the stage above scenes (matches legacy behaviour).
        GameApplication.pixiApp.stage.addChild(container.bigWin);
    }

    /**
     * MUST stay synchronous. The ordering below is load-bearing:
     * `setRendererDimensions` → `setHostStage` → `setHostRenderer` → the first
     * `loadScene` → the starter re-bind. A single `await` anywhere in here
     * would let arcade-base continue past this method (it does NOT await
     * `init()`) and run the rest against a half-registered SceneManager.
     * All async boot work belongs in `initPixi`, which IS awaited.
     */
    public init(): void {
        Flowstate.eventTriggers.application.onApplicationInit();

        // Cache renderer dimensions so SceneManager can auto-snap the camera
        // on every loadScene (including flow-driven loads with no viewport
        // context).
        sceneManager.setRendererDimensions(
            GameApplication.pixiApp.renderer.width,
            GameApplication.pixiApp.renderer.height,
        );

        // Register the pixi stage as the parent for scene roots so every
        // loadScene() call (including flow-driven ones) auto-mounts the new
        // container. Without this, flow-driven loadScene leaves the freshly-
        // built container orphaned.
        sceneManager.setHostStage(GameApplication.pixiApp.stage);

        // Editor-only motion probe (Orca's opt-in game-feel assertions). Only
        // adds two idle listeners until the editor asks for a recording.
        installGameFeelProbe(GameApplication.pixiApp.stage);
        // Register the live renderer so node types that bake into a
        // RenderTexture during the scene build (the `scratchableItem` scratch
        // mask) can draw. Without it those nodes still render — they just lose
        // their dynamic behaviour.
        sceneManager.setHostRenderer(GameApplication.pixiApp.renderer);

        // Load and display Orca scene. Prefer the registered entry scene's
        // scope-qualified ref (so a per-skin entry whose name collides with
        // a core scene resolves correctly) over a hard-coded index 0
        // fallback.
        const entryScene = sceneManager.getEntryScene();
        if (entryScene) {
            sceneManager.loadScene(entryScene.name, entryScene.scope);
        } else {
            sceneManager.loadScene(0);
        }

        // The host boot loadScene above is the FIRST scene to exist — the
        // bind sweep inside Flowstate.init() ran before any scene was built
        // (getDisplayObjectById returned nothing), and the host loadScene
        // path (unlike the flow-driven loadScene in methods/scene.ts) does
        // not re-run the sweep. Re-bind here so pointer-event starters and
        // custom-event starters that target nodes in the ENTRY scene become
        // active.
        Flowstate.bindPixiStarters();
        Flowstate.bindCustomEventStarters();
        Flowstate.bindGamePreferenceStarters();
        // DDOL host MUST be added AFTER the scene root so dontDestroyOnLoad
        // containers render above the active scene by default. loadScene()
        // re-adds it to bring it to the front on every subsequent load.
        GameApplication.pixiApp.stage.addChild(sceneManager.getDontDestroyContainer());

        // Jackpots runtime — GATED on the active skin's `IS_JACKPOT` flag.
        // Fire-and-forget (NOT awaited): a non-jackpot skin no-ops (and never
        // loads the package), while a jackpot skin's asset/string/font loads
        // run in the background so boot is never blocked. Fully try/caught
        // inside the helper, so a failure degrades to "no jackpots".
        void initJackpotsRuntime(
            sceneManager,
            GameApplication.pixiApp.stage,
            // Pass the LOGICAL screen size (`renderer.screen.*`), NOT the
            // backing-pixel `renderer.width/height` (= screen × `resolution`,
            // and `resolution` is 2–4 here). The jackpots panel's
            // resize/position math works in stage/logical units — and
            // `resizeViews` subtracts the cabinet's LOGICAL height — exactly
            // what the later host `resize()` path passes (`view.width/height`
            // from `getBoundingClientRect`). These captured dims are retained
            // for signature stability but are NO LONGER used for sizing — the
            // up-front first-load resize reads the LIVE provider below instead;
            // that provider returns the same LOGICAL `renderer.screen.*` for
            // the same reason (backing pixels would land the panel
            // ~`resolution`× oversized and off-frame). Skin-independent.
            GameApplication.pixiApp.renderer.screen.width,
            GameApplication.pixiApp.renderer.screen.height,
            // Live-dimensions provider, read by the up-front first-load resize
            // (NOT captured now). The async init completes AFTER the host's
            // first `resize()`, so re-reading the renderer's CURRENT logical
            // size here lets that authoritative first-load resize use the
            // settled size rather than the dims captured above. Logical
            // (`renderer.screen.*`) for the same reason as the init dims.
            () => ({
                width: GameApplication.pixiApp.renderer.screen.width,
                height: GameApplication.pixiApp.renderer.screen.height,
            }),
            // FlowState fan-out for the jackpot lifecycle starters
            // (onJackpotRoundReady / onJackpotEnd / onJackpotWin). Passed in
            // (vs the helper importing `Flowstate`) so the gated jackpots glue
            // stays free of a module cycle and the package stays code-split.
            (starterType, args) => { void Flowstate.runFlowsByStarterType(starterType, args); },
        );

        // Update scene manager in ticker
        GameApplication.pixiApp.ticker.add(() => {
            sceneManager.update(GameApplication.pixiApp.ticker.deltaMS / 1000);
        });

        // Start the game
        if (gameModel.isNewPlayer) {
            // TODO: Show the HTP popup for new players, or any other onboarding you want to do
            if (userModel.freePlayBalance > 0) {
                eventEmitter.emit('GLOBAL_FREE_PLAY_EARNED', userModel.freePlayBalance);
            }
        }

        // GAME_BEGIN emitted by the BasePackage.Cabinet on a successful buy in
        eventEmitter.on('GAME_BEGIN', this.onBeginGame, this);

        gameEventEmitter.on('STAKE_CHANGED', (newStake: number) => {
            void Flowstate.eventTriggers.application.onStakeChanged(newStake);
        });
    }

    public resize(width: number, height: number): void {
        // Cache the NEW dims first — a pure cache write, and both the
        // device-mode notify and any flow running off onApplicationResize read
        // them, so hoisting it stops them seeing the previous frame's size.
        sceneManager.setRendererDimensions(width, height);
        void Flowstate.eventTriggers.application.onDeviceModeChanged(sceneManager.getActiveLayoutMode());
        Flowstate.eventTriggers.application.onApplicationResize(width, height);
        sceneManager.drawScene(width, height);

        GameApplication.pixiApp.renderer.resize(width, height);
        container.cabinet.handleOrientationChange();
        container.bigWin.resize(width, height);
        // No-op until the (gated) jackpots panel has finished initialising.
        resizeJackpotsRuntime(width, height);
    }

    private onBeginGame(): void {
        Flowstate.eventTriggers.application.onBeginGame();

        
    }

    public enterBonusRound(): void {
        Flowstate.eventTriggers.application.onEnterBonusRound();
        // TODO: Implement bonus round logic if needed, if not this can be left empty
    }

    public enterJackpot(): void {
        Flowstate.eventTriggers.application.onEnterJackpot();
        // Enter the (gated) jackpot round. No-op for a non-jackpot skin, when
        // jackpots never initialised, or when the player has no active
        // jackpot (`jackpotGameModel.hasJackpot`). Fire-and-forget.
        void enterJackpotsRuntime();
    }

    public postResizeInit?(): void {
        //TODO: Implement if needed
    }

    public initLazyComponents?(): Promise<void> {
        //TODO: Implement if needed
        return Promise.resolve();
    }
    
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public resizeLazyComponents?(width: number, height: number): void {
        //TODO: Implement if needed
    }
}
