/**
 * Jackpots runtime wiring — GATED on the active skin's `IS_JACKPOT` flag.
 *
 * The editor's per-skin "jackpots" toggle is baked by the editor into the
 * auto-generated `core/services/orca/active-skin.ts` as `IS_JACKPOT`. This
 * module is the FIRST (and only) host-side runtime consumer of that flag for
 * the `@game-studio/jackpots` package.
 *
 * ── HARD CONTRACT: code-splitting / "no lingering jackpots code or assets" ──
 *   • `@game-studio/jackpots` is pulled in ONLY via `await import(...)`
 *     INSIDE the `IS_JACKPOT` branch. Webpack therefore code-splits the whole
 *     package into a SEPARATE async chunk that is NEVER fetched for a
 *     non-jackpot skin. A static top-level
 *     `import ... from '@game-studio/jackpots'` would force the package into
 *     the MAIN bundle for ALL skins — never add one here.
 *   • The `type JackpotsModule = typeof import(...)` below is a TYPE-ONLY
 *     reference. It is fully erased by the compiler and does NOT create a
 *     runtime chunk; only the value-position `await import(...)` does.
 *   • The build's jackpots ASSET copy (`build/copy-assets.js` +
 *     `build/build.js`) is likewise gated on `IS_JACKPOT`, so a non-jackpot
 *     production build copies no jackpots assets.
 *
 * ── HARD CONTRACT: must COMPILE without the package installed ──
 *   The editor's per-skin jackpots toggle UNINSTALLS `@game-studio/jackpots`
 *   from the project's `game/node_modules` when NO skin is a jackpot skin (the
 *   intentional "clean-disabled" state). Compiling in that state requires TWO
 *   independent escape hatches, because ts-loader and webpack each resolve the
 *   `import('@game-studio/jackpots')` specifiers below separately:
 *     1. ts-loader's TYPE check — silenced by the `// @ts-ignore` on each
 *        `import('@game-studio/jackpots')` specifier (and on the
 *        `type JackpotsModule = typeof import(...)` alias). Those suppressions
 *        are NO-OPS when a jackpot skin has the package installed (no error on
 *        the line, so full type-safety is retained), so they MUST NOT be
 *        "cleaned up".
 *     2. webpack's MODULE RESOLUTION — `@ts-ignore` does NOT stop webpack from
 *        trying to resolve the package at build time; without help, the bundle
 *        hard-fails with "Can't resolve '@game-studio/jackpots'". The tolerance
 *        is supplied by `resolve.fallback: { '@game-studio/jackpots': false }`
 *        in `build/webpack.base.conf.js`, which webpack consults ONLY when
 *        resolution fails (a strict no-op when the package IS installed). Keep
 *        these two files in sync.
 *
 * ── HARD CONTRACT: never crash boot ──
 *   `JackpotRound.loadAssets()` makes network calls (PoEditor shared-jackpots
 *   strings + Gemunu fonts on `*.tombolaarcade.co.uk`) that fail in the
 *   editor's offline webview. The whole init is wrapped in try/catch +
 *   `console.warn`, so a jackpots failure degrades to "no jackpots" and NEVER
 *   breaks the host game boot. Callers fire-and-forget `initJackpotsRuntime`.
 *
 * ── Lifecycle (per @game-studio/jackpots 0.8.x) ──
 *   loadAssets(...) → initialize(container) → createViews(stage) →
 *   sceneManager.attachJackpots(panel) → resizeViews + positionViews →
 *   mainGameIntroComplete()   ← reveals the panel (it starts at alpha 0)
 *
 *   loadAssets MUST run BEFORE initialize. initialize eagerly reads
 *   JackpotRound.region + jackpotStrings (both set ONLY by loadAssets) and
 *   constructs a JackpotPoller whose constructor self-starts a 10s timer and
 *   pings the region poller URL. With no region set, that ping reads
 *   `defaultJackpotPollerURLs[undefined].debug` and THROWS — once synchronously
 *   and again ~10s later from the orphaned, never-paused timer (uncaught).
 *   Running loadAssets first sets the region, which is exactly what every real
 *   shipping consumer does (loadAssets in the preload phase, initialize in
 *   preInit). The package README's initialize-then-loadAssets ordering is
 *   misleading — trust the consumers.
 *
 * ── The jackpot ROUND (see the section at the end of this file) ──
 *   The server decides a jackpot in its Begin reply. Every reply is noted as
 *   it arrives and handed to the package's model, and the round a Begin won
 *   plays before the game hands the finished round back to the cabinet
 *   (`endCabinetGame` awaits `enterJackpotsRuntime`). The Debug menu can play
 *   one on demand (`jackpotDebugSettingOptions`).
 */

import {
    container,
    device,
    environment,
    eventEmitter,
    queryStringParams,
    userModel,
    type IDebugSettingType,
} from '@game-studio/arcade-base';
import { Assets, Container, type Texture } from 'pixi.js';
import { SpineTexture } from '@esotericsoftware/spine-pixi-v8';

import { gameModel } from '../../models/game-model';
import { IS_JACKPOT } from '../orca/active-skin';
import { placeBetweenMargins, type FitAreaMargin } from '../orca/fit-area';
import { bindJackpotStarters, type JackpotStarterDispatch } from '../orca/event-triggers/jackpot-events';

// Type-only handle on the package — erased by the compiler, so it does NOT
// pull jackpots into the bundle. The dynamic `import()` in init does.
// @ts-ignore — `@game-studio/jackpots` is INTENTIONALLY absent when no skin is
// a jackpot skin (the editor uninstalls it for a clean-disabled project). The
// IS_JACKPOT gate means this code never runs in that state; this suppression
// lets the file still COMPILE without the package. When a jackpot skin has it
// installed there is no error here and full type-safety is retained.
type JackpotsModule = typeof import('@game-studio/jackpots');

// The shape of the `JackpotRound.initialize(...)` argument, derived from the
// package's own types so we stay in lock-step with version bumps.
type JackpotContainer = Parameters<JackpotsModule['JackpotRound']['initialize']>[0];

// The package's own shapes for a reply's jackpot, the three pots and the
// engine's jackpot settings, derived the same way.
type JackpotResponse = Parameters<JackpotsModule['jackpotGameModel']['setData']>[0];
type JackpotPots = Parameters<JackpotsModule['jackpotGameModel']['setJackpotData']>[0];
type JackpotDetails = Parameters<JackpotsModule['jackpotGameSettings']['setData']>[0];

/**
 * Minimal structural view of SceneManager's jackpots mount point. The host's
 * `sceneManager` singleton already exposes `attachJackpots(view)` (it slots
 * the panel into the `jackpotsModule` system-singleton node's place in scene
 * draw order). We depend on the shape only — never widening SceneManager's
 * API from here.
 */
interface JackpotsMountTarget {
    attachJackpots(view: Container | null): void;
    /**
     * Puts the cabinet back in the scene's draw order after a jackpot round
     * (which raises it over the round). Optional like the getters below.
     */
    attachCabinet?(view: Container | null): void;
    /**
     * Authored landscape X offset for the jackpots panel, as a fraction
     * (0..1) of the renderer width, read from the current scene's
     * `jackpotsModule` node (`gameLeftEdge`). Optional so this structural
     * type stays tolerant of mount targets that don't expose it; the host
     * `sceneManager` singleton does. `undefined` means "use the package
     * default" (`positionViews` landscape X = `trueWidth + 20`).
     */
    getJackpotsGameLeftEdge?(): number | undefined;
    /**
     * The panel's Fit to Area margins when the `jackpotsModule` node places it
     * that way (centred in the area between them at its own size in landscape,
     * always a gap inside the screen), else undefined. Optional like the above.
     */
    getJackpotsAreaMargins?(): { left: FitAreaMargin; right: FitAreaMargin } | undefined;
    /**
     * The panel's restyle when the `jackpotsModule` node has one switched on:
     * each quality's restyled atlas page (a URL; `'1'` desktop, `'0.5'`
     * phones) and the fingerprint of the atlas it was baked from. Optional
     * like the above; undefined means the package's own art.
     */
    getJackpotsPanelStyle?(): { pages: Record<string, string>; atlas: Record<string, string> } | undefined;
}

/** The parts of a spine-core atlas page the restyle reads and swaps. */
interface JackpotsAtlasPage {
    width: number;
    height: number;
    regions: ReadonlyArray<{ name: string; x: number; y: number; width: number; height: number; degrees: number }>;
    setTexture(texture: SpineTexture): void;
}

/**
 * An atlas page's layout fingerprint: its size and every region's name, place,
 * size and turn (FNV-1a). Twin of `atlasFingerprint` in the editor's
 * electron/media/jackpots-style.js, which bakes restyled pages: a page is only
 * swapped in over the very atlas it was baked from.
 */
export function jackpotsAtlasFingerprint(page: Pick<JackpotsAtlasPage, 'width' | 'height' | 'regions'>): string {
    const lines = [`${page.width}x${page.height}`];
    for (const r of page.regions) lines.push(`${r.name}|${r.x},${r.y},${r.width},${r.height},${r.degrees}`);
    const text = lines.join('\n');
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * Swap the scene's restyled panel page in over the package's (loaded by
 * `loadAssets`, before any view is built), when it has one switched on and
 * it was baked from this very atlas. Every region keeps its place, so the
 * layout and animations are the package's.
 */
async function applyPanelStyle(mountTarget: JackpotsMountTarget, quality: '1' | '0.5'): Promise<void> {
    const style = mountTarget.getJackpotsPanelStyle?.();
    const url = style?.pages[quality];
    if (!style || !url) return;
    const atlas = Assets.get('jackpots-panelAtlas') as { pages?: JackpotsAtlasPage[] } | undefined;
    const page = atlas?.pages?.length === 1 ? atlas.pages[0] : null;
    if (!page) return;
    if (jackpotsAtlasFingerprint(page) !== style.atlas[quality]) {
        console.warn('[jackpots-runtime] The jackpots panel restyle was made for another atlas (another package version or locale); the package\'s own art is drawn.');
        return;
    }
    const texture = await Assets.load<Texture>(url);
    page.setTexture(SpineTexture.from(texture.source));
}

/**
 * The five locales `@game-studio/jackpots` actually ships region data for (its
 * `SupportedLocale = Exclude<Locale, 'pt-pt' | 'nl-nl'>`). arcade-base's
 * `Locale` is WIDER, so an unsupported value (e.g. `'nl-nl'`) would set an
 * invalid `JackpotRound.region` → the poller reads
 * `defaultJackpotPollerURLs[<invalid>].debug` and crashes even ONLINE. We keep
 * a LOCAL string-literal union here rather than importing `SupportedLocale`
 * from the package, to preserve the "compiles without the package installed"
 * contract.
 */
const JACKPOTS_SUPPORTED_LOCALES = ['en-gb', 'es-es', 'it-it', 'dk-dk', 'se-se'] as const;
type JackpotsSupportedLocale = (typeof JACKPOTS_SUPPORTED_LOCALES)[number];

/** Clamp any arcade-base locale to a jackpots-supported one (fallback en-gb). */
function clampJackpotsLocale(locale: string | undefined): JackpotsSupportedLocale {
    return (JACKPOTS_SUPPORTED_LOCALES as readonly string[]).includes(locale ?? '')
        ? (locale as JackpotsSupportedLocale)
        : 'en-gb';
}

// Cached reference to the dynamically-imported package, populated ONLY after a
// fully-successful init. `resizeJackpotsRuntime` / `enterJackpotsRuntime` are
// therefore no-ops until jackpots is ready (and forever for a non-jackpot
// skin), so both are always safe to call from the host.
let jackpots: JackpotsModule | null = null;
// Guards against a second init (host `init()` runs once, but belt-and-braces).
let initStarted = false;
// Cached at init so `resizeJackpotsRuntime` (which has no `mountTarget` arg)
// can also read the authored landscape X offset. Set before any await, so it
// is always populated by the time `resizeJackpotsRuntime` does real work
// (which it only does once `jackpots` is non-null, i.e. after init succeeds).
let jackpotsMountTarget: JackpotsMountTarget | null = null;

/**
 * Resolve the landscape X position to hand `JackpotRound.positionViews` (where
 * the panel's right edge goes) on a `width` x `height` screen for a panel
 * `panelWidth` wide: centred in the area between the authored Fit to Area
 * margins (kept `jackpotsEdgeClear` inside the screen) when the
 * `jackpotsModule` node places it that way, else from the authored
 * `jackpotsModule.gameLeftEdge` (a 0..1 fraction of renderer width). Returns
 * `undefined` when neither is set so the package default (`trueWidth + 20`)
 * applies. Landscape-only is correct — `positionViews` ignores the X in
 * portrait (it centres). The editor canvas's twin is `jackpotsPlacement.ts`.
 */
function resolveLandscapeXPosition(width: number, height: number, panelWidth: number): number | undefined {
    const place = fitAreaPlace(width, height, panelWidth);
    if (place) return place.left + panelWidth * place.scale;
    const edge = jackpotsMountTarget?.getJackpotsGameLeftEdge?.();
    return typeof edge === 'number' && Number.isFinite(edge) ? edge * width : undefined;
}

/**
 * The least gap a Fit to Area panel keeps from each side of the screen: a
 * share of its width, never under `px`. Twin of the editor's
 * `JACKPOTS_EDGE_CLEAR`.
 */
const JACKPOTS_EDGE_CLEAR = { share: 0.01, px: 12 };

/** Where a Fit to Area panel `panelWidth` wide goes on a `width` x `height` screen (`placeBetweenMargins`); null when it is not placed that way. */
function fitAreaPlace(width: number, height: number, panelWidth: number): { left: number; scale: number } | null {
    const margins = jackpotsMountTarget?.getJackpotsAreaMargins?.();
    if (!margins) return null;
    const edge = Math.max(JACKPOTS_EDGE_CLEAR.px, JACKPOTS_EDGE_CLEAR.share * width);
    return placeBetweenMargins({ left: 0, top: 0, right: width, bottom: height }, margins.left, margins.right, panelWidth, edge);
}

/**
 * Make every resize of the views — ours, and the package's own once its lazy
 * assets load — end with a Fit to Area panel placed in landscape: at the
 * package's own size (shrunk only if it is wider than the screen less its
 * edge gaps), its middle on the middle of its area, always on the screen.
 * The editor canvas's twin is `jackpotsPlacement.ts`.
 */
function placePanelAfterEveryResize(JackpotRound: JackpotsModule['JackpotRound']): void {
    const resizeViews = JackpotRound.resizeViews.bind(JackpotRound);
    JackpotRound.resizeViews = (width: number, height: number, portraitScaleMultiplier?: number): void => {
        resizeViews(width, height, portraitScaleMultiplier);
        const panel = JackpotRound.views?.jackpotPanelView;
        if (!panel || device.orientation.isPortrait) return;
        const place = fitAreaPlace(width, height, panel.trueWidth);
        if (!place) return;
        if (Number.isFinite(place.scale) && place.scale > 0 && place.scale < 1) panel.scale.set(panel.scale.x * place.scale, panel.scale.y * place.scale);
        JackpotRound.positionViews(width, height, resolveLandscapeXPosition(width, height, panel.trueWidth));
    };
}

/**
 * Assemble the `IJackpotContainerRequirements` literal from the host's
 * arcade-base singletons. Each binding is verified against arcade-base; the
 * single `as unknown as JackpotContainer` cast bridges harmless cross-package
 * structural-type drift (BaseCabinet↔ICabinet, EventEmitter generics, the
 * shared `Device`/`SoundManager`/`Environment` types) so the scaffolded game
 * compiles even when the two packages resolve slightly different type
 * versions.
 */
function buildJackpotContainer(): JackpotContainer {
    return {
        cabinet: container.cabinet,
        currencyFormatter: (value: number) => container.currencyFormatter.precise(value),
        environment,
        soundManager: container.soundManager,
        device,
        userModelInfo: {
            userId: userModel.userId as number,
            crossCheck: userModel.crossCheck,
            visibleBalance: () => userModel.visibleBalance,
        },
        clientTypeId: userModel.clientTypeId.toString(),
        skin: queryStringParams.currentSkin,
        overlayEventEmitter: eventEmitter,
        payout: () => gameModel.payout,
    } as unknown as JackpotContainer;
}

/**
 * Initialise + reveal the jackpots panel for a jackpot skin. No-op (and never
 * imports the package) for a non-jackpot skin. Fire-and-forget from the host
 * `init()` — it must NOT be awaited, so boot never blocks on the package's
 * network asset/string/font loads.
 *
 * @param mountTarget the host `sceneManager` singleton (provides `attachJackpots`
 *                    + the authored `getJackpotsGameLeftEdge`).
 * @param stage       the host pixi stage the panel is built onto.
 * @param width       renderer width captured at the `init()` call. Retained on
 *                    the host call signature but NO LONGER used for sizing — the
 *                    up-front resize reads LIVE dims via `getLiveDimensions`
 *                    instead, because these captured dims are stale by the time
 *                    this async lifecycle completes (see step 5).
 * @param height      renderer height captured at the `init()` call. As with
 *                    `width`: retained for the signature, superseded by
 *                    `getLiveDimensions` at resize time.
 * @param getLiveDimensions provider returning the renderer's CURRENT logical
 *                    size at CALL time (NOT captured here). The authoritative
 *                    up-front first-load resize (step 5) uses this — the size
 *                    the host settled on AFTER its first `resize()` — instead of
 *                    the (stale) `width`/`height` above.
 * @param dispatch    host-supplied FlowState fan-out dispatcher
 *                    (`(type, args) => Flowstate.runFlowsByStarterType(type, args)`)
 *                    used to bind the jackpot lifecycle starters. Passed in (vs
 *                    importing `Flowstate` here) so this glue stays free of a
 *                    module cycle and the package stays gated.
 */
export async function initJackpotsRuntime(
    mountTarget: JackpotsMountTarget,
    stage: Container,
    width: number,
    height: number,
    getLiveDimensions: () => { width: number; height: number },
    dispatch: JackpotStarterDispatch,
): Promise<void> {
    if (!IS_JACKPOT) return;
    if (initStarted) return;
    initStarted = true;
    // Cache for resizeJackpotsRuntime's landscape-X lookup (set before any
    // await; resize only reads it after init succeeds anyway).
    jackpotsMountTarget = mountTarget;
    starterDispatch = dispatch;

    // Every game-server reply from now on: a Begin's decides whether the game
    // won a jackpot. The boot Resume arrived before this listener, so it is
    // read from where the server keeps its latest reply.
    container.gameServer.on('ON_SUCCESSFUL_RESULT', noteServerResult);
    const bootResume = (window as unknown as { $response?: unknown }).$response;

    // Hoisted OUT of the try so the catch can pause the poller on the residual
    // failure window where loadAssets SUCCEEDED (so initialize ran and built
    // the self-starting poller) but a LATER step threw. Typed from the package
    // handle so it stays `any`-safe when the package is uninstalled (the
    // header's @ts-ignore on `type JackpotsModule` makes it `any`).
    let JackpotRound: JackpotsModule['JackpotRound'] | undefined;

    try {
        // @ts-ignore — see header: the package is intentionally absent for a
        // clean-disabled (no-jackpot-skin) project; the `IS_JACKPOT` guard
        // above means we never reach here in that state. No-op with full
        // type-safety when a jackpot skin has the package installed.
        const mod = await import(/* webpackChunkName: "jackpots" */ '@game-studio/jackpots');
        JackpotRound = mod.JackpotRound;

        // 1. Load assets + shared-translation strings + fonts (NETWORK — this
        //    is what fails offline; the surrounding try/catch keeps boot safe).
        //    MUST run BEFORE initialize (see header): it sets JackpotRound.region
        //    + jackpotStrings that initialize reads eagerly. Needs no container.
        //    NB the 5th parameter is an optional PROGRESS CALLBACK as of 0.10.x
        //    (it used to be the PoEditor shared-translation version, which the
        //    package now owns itself) — do not pass a number here.
        await JackpotRound.loadAssets(
            environment as Parameters<typeof JackpotRound.loadAssets>[0],
            device.type.isMobile ? 0.5 : 1,
            'tombola-arcade',
            clampJackpotsLocale(queryStringParams.locale) as Parameters<typeof JackpotRound.loadAssets>[3],
        );

        // 1b. The scene's restyle of the panel, when it has one switched on:
        //     its page swapped in before any view is built. Never fatal.
        try {
            await applyPanelStyle(mountTarget, device.type.isMobile ? '0.5' : '1');
        } catch (err) {
            console.warn('[jackpots-runtime] The jackpots panel restyle could not be loaded; the package\'s own art is drawn.', err);
        }

        // 1c. The jackpot settings and pots the boot Resume carried. The
        //     round's reels come with the settings and `initialize` builds the
        //     game-rules figures from them, so this runs first.
        seedFromResume(mod, bootResume);

        // 2. Wire the package to the host (cabinet, currency, sound, user, …).
        //    Safe now that loadAssets populated region + strings. This also
        //    constructs the JackpotPoller, whose constructor self-starts its
        //    10s polling timer — which is why every later step lives in the
        //    same try, and the catch pauses the poller (below).
        JackpotRound.initialize(buildJackpotContainer());
        placePanelAfterEveryResize(JackpotRound);

        // 3. Build the panel view onto the host stage.
        await JackpotRound.createViews(stage);

        // 4. Hand the panel to SceneManager so its draw order is governed by
        //    the `jackpotsModule` system-singleton node's position among
        //    root-level scene siblings (authored in the editor).
        mountTarget.attachJackpots(JackpotRound.views.jackpotPanelView);

        // 5. Size + place the panel CORRECTLY before its intro animation plays.
        //    Real shipping jackpot games size up-front and NEVER gate the first
        //    resize on the spine reaching `idle`. Two things make this the
        //    authoritative, correct-from-frame-one pass:
        //      • `resizeViews` subtracts the cabinet's PER-ORIENTATION height
        //        (`CabinetDimensions.height`), which only settles inside
        //        `cabinet.handleOrientationChange()`. The LANDSCAPE panel scale
        //        is height-sensitive (`min(widthScale, heightScale)`), so a
        //        STALE cabinet height renders it oversized (PORTRAIT is
        //        width-only, hence was immune). So settle the cabinet for the
        //        CURRENT orientation FIRST.
        //      • Then measure off LIVE renderer dims: the dims captured at the
        //        `init()` call (`width`/`height`) are stale by now — this
        //        lifecycle is async and only completes AFTER the host's first
        //        `resize()`, so re-read the settled size via
        //        `getLiveDimensions()`.
        //    No idle-pose forcing is needed: the package's `resize()` is
        //    pose-independent (`setToSetupPose(); update(0); scale.set(1)` BEFORE
        //    measuring the SIZER slot) AND track 0 is still EMPTY here (we run
        //    BEFORE `mainGameIntroComplete()` queues `<orientation>On → idle`),
        //    so the setup-pose measurement is already deterministic. The 3rd
        //    `positionViews` arg is the authored landscape X offset
        //    (`jackpotsModule.gameLeftEdge` * width), or undefined to fall back
        //    to the package default (`trueWidth + 20`). The cabinet must already
        //    exist — application.preInit attaches it before init runs.
        try { container.cabinet.handleOrientationChange(); } catch { /* cabinet not ready — non-fatal */ }
        const { width: liveWidth, height: liveHeight } = getLiveDimensions();
        if (liveWidth > 0 && liveHeight > 0) {
            JackpotRound.resizeViews(liveWidth, liveHeight);
            JackpotRound.positionViews(liveWidth, liveHeight, resolveLandscapeXPosition(liveWidth, liveHeight, JackpotRound.views.jackpotPanelView.trueWidth));
        }

        // 6. MANDATORY: the panel starts at alpha 0; this reveals it AND queues
        //    the intro — which now plays at the already-correct size set in
        //    step 5 (no visible "oversized, then pop to correct size" delay).
        JackpotRound.mainGameIntroComplete();

        // 7. Bind the jackpot lifecycle starters (onJackpotRoundReady /
        //    onJackpotEnd / onJackpotWin) to the package's event emitter so
        //    authored FlowState graphs run on each. Idempotent (detach-first).
        bindJackpotStarters(JackpotRound.events, dispatch);

        // 8. The round's own views (background, reels, big win) load in the
        //    background onto a layer that is raised over the game while a
        //    round plays, and the cabinet's button spins the round's reels.
        roundLayer = new Container();
        roundLayer.label = 'orca-jackpot-round';
        roundLayer.visible = false;
        stage.addChild(roundLayer);
        void JackpotRound.createLazyViews(roundLayer);
        eventEmitter.on('CABINET_BONUS_ACTION', onCabinetBonusAction);

        // Mark ready ONLY now, so resize/enter no-op until fully wired.
        jackpots = mod;
        // A Begin answered while the package was loading.
        applyServerResults();
    } catch (err) {
        // Offline editor webview, missing package, network failure, etc.
        // Degrade to "no jackpots" — NEVER crash the host game boot.
        //
        // Pause the poller in case loadAssets succeeded (so initialize ran and
        // constructed the self-starting 10s poller) but a later step threw —
        // otherwise its orphaned timer fires ~10s later and crashes. This only
        // runs on the failure path, so a real online game's live polling is
        // never touched.
        try { JackpotRound?.jackpotPoller?.pause(); } catch { /* noop */ }
        console.warn('[jackpots-runtime] Jackpots init failed; continuing without jackpots.', err);
        jackpots = null;
    }
}

/**
 * Re-size + re-position the jackpots panel on a host resize. No-op until init
 * has fully completed (and forever for a non-jackpot skin).
 */
export function resizeJackpotsRuntime(
    width: number,
    height: number,
    portraitScaleMultiplier = 1,
): void {
    if (!IS_JACKPOT || !jackpots) return;
    const { JackpotRound } = jackpots;
    if (!JackpotRound.views || !JackpotRound.views.jackpotPanelView) return;
    try {
        JackpotRound.resizeViews(width, height, portraitScaleMultiplier);
        JackpotRound.positionViews(width, height, resolveLandscapeXPosition(width, height, JackpotRound.views.jackpotPanelView.trueWidth));
    } catch (err) {
        console.warn('[jackpots-runtime] Jackpots resize failed.', err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The jackpot ROUND
//
// The game server decides a jackpot: a Begin reply carries it as
// `JackpotResponse` (the shape `jackpotGameModel.setData` takes; the engines'
// `Jackpot` details are translated). Every reply is noted as it arrives and
// handed to the package once it is ready, and the round a Begin won plays
// before the game hands the finished round back to the cabinet —
// `endCabinetGame` awaits `enterJackpotsRuntime()` — so it always follows the
// game's own presentation and bonuses. The round is the package's: the
// panel's "triggered" animation, the screen wipe, three spins of the jackpot
// reels started from the cabinet's button, the big win and the exit, on a
// layer raised over the game with the cabinet above it. The Debug menu plays
// one on demand without the server (`jackpotDebugSettingOptions`).
// ─────────────────────────────────────────────────────────────────────────────

type UnknownRecord = Record<string, unknown>;
export type JackpotTier = 'low' | 'mid' | 'high';
type RoundKind = 'won' | 'preview';

/** Each tier's id in the engines' forced-win request (`PotTier`: Low 1, Mid 2, High 3). */
const TIER_IDS: Record<JackpotTier, number> = { low: 1, mid: 2, high: 3 };

/** A round plays three spins of five reels of three rows (`JACKPOT_SPIN_COUNT`). */
const ROUND_SPINS = 3;
const ROUND_REELS = 5;
const ROUND_ROWS = 3;

/** How long a round waits for its art, which loads in the background after boot. */
const ROUND_ART_WAIT_MS = 30000;
/** The panel's "triggered" animation before the round. */
const TEASE_WAIT_MS = 8000;
/** From entering to the round being ready to spin (a screen wipe and an intro). */
const ROUND_READY_WAIT_MS = 20000;
/** From the spin press to the round's exit (three spins, the collection, the big win). */
const ROUND_FINISH_WAIT_MS = 120000;
/** The exit of a round that went wrong. */
const ROUND_LEAVE_WAIT_MS = 5000;

/** Gems a preview collects per tier, as the engines' ticket generator does. */
const PREVIEW_GEMS: Record<JackpotTier, [number, number]> = { low: [5, 9], mid: [10, 14], high: [15, 15] };
/** Pot values (minor units) used when the game has none yet. */
const FALLBACK_POTS: Record<JackpotTier, number> = { low: 5000, mid: 50000, high: 500000 };

/** The layer the round's views are built on (on the stage; raised while a round plays). */
let roundLayer: Container | null = null;
/** The FlowState fan-out from init, for `onEnterJackpot`. */
let starterDispatch: JackpotStarterDispatch | null = null;
/** A Begin won a jackpot whose round has not played yet. */
let wonRoundPending = false;
/** The round playing now. */
let activeRound: Promise<boolean> | null = null;
/** Set while a ready round waits for the cabinet's spin press. */
let releaseSpinPress: (() => void) | null = null;
/** The latest Begin reply, until the package has it. */
let pendingBegin: UnknownRecord | null = null;
/** The latest pot values from any other reply, until the package has them. */
let pendingPots: { pots: unknown } | null = null;

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
    const n = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
    return Number.isFinite(n) ? n : null;
}

/** `'low'` / `'mid'` / `'high'` (or the medal names some engines use), any case; else null. */
function tierOf(value: unknown): JackpotTier | null {
    switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
        case 'low':
        case 'bronze':
            return 'low';
        case 'mid':
        case 'silver':
            return 'mid';
        case 'high':
        case 'gold':
            return 'high';
        default:
            return null;
    }
}

/** An engine pot (`TierId` / `CurrentValue`) in the package's shape (`Tier` / `PrizeValue`). */
function fromEnginePot(pot: unknown, prize?: unknown): UnknownRecord | null {
    if (!isRecord(pot)) return null;
    const tier = pot.TierId === 1 ? 'low' : pot.TierId === 2 ? 'mid' : pot.TierId === 3 ? 'high' : tierOf(pot.Tier);
    const value = finiteNumber(prize ?? pot.CurrentValue);
    return tier && value !== null ? { Tier: tier, PrizeValue: value } : null;
}

/** The engines' `Jackpot` details (the bundled mock's too) in the package's shape. */
function fromEngineJackpot(details: UnknownRecord): UnknownRecord {
    return {
        CurrentPotValues: Array.isArray(details.CurrentPotValues)
            ? details.CurrentPotValues.map((pot: unknown) => fromEnginePot(pot))
            : [],
        JackpotWin: details.JackpotWin === true,
        WinningPot: fromEnginePot(details.WinningPot, details.JackpotPrize),
        WinningTicket: details.WinningTicket,
        WinningDetails: details.WinningDetails,
    };
}

/** A reply's jackpot: `JackpotResponse`, else the engines' `Jackpot` translated; null when it has neither. */
function replyJackpot(reply: UnknownRecord): UnknownRecord | null {
    if (isRecord(reply.JackpotResponse)) return reply.JackpotResponse;
    if (isRecord(reply.Jackpot)) return fromEngineJackpot(reply.Jackpot);
    return null;
}

/**
 * Exactly one pot per tier, each with a numeric `PrizeValue`, as fresh copies
 * (the package sorts and annotates the array it is given); else null.
 */
function readPots(value: unknown): JackpotPots | null {
    if (!Array.isArray(value)) return null;
    const pots: Partial<Record<JackpotTier, UnknownRecord>> = {};
    for (const entry of value) {
        if (!isRecord(entry)) return null;
        const tier = tierOf(entry.Tier);
        const prize = finiteNumber(entry.PrizeValue);
        if (!tier || pots[tier] || prize === null) return null;
        pots[tier] = { ...entry, Tier: tier, PrizeValue: prize };
    }
    const list = [pots.low, pots.mid, pots.high];
    return list.every(isRecord) ? (list as unknown as JackpotPots) : null;
}

/** Copies of the pots the panel shows now. */
function currentPots(): JackpotPots | null {
    return jackpots ? readPots(jackpots.jackpotGameModel.potValues) : null;
}

/** The three pots at their seed values (the engine settings', else stand-ins). */
function fallbackPots(): JackpotPots {
    const seeds: unknown = jackpots?.jackpotGameSettings.jackpotDetails?.SeedValues;
    const tiers: JackpotTier[] = ['low', 'mid', 'high'];
    return tiers.map((tier, index) => ({
        Tier: tier,
        PrizeValue: (Array.isArray(seeds) ? finiteNumber(seeds[index]) : null) ?? FALLBACK_POTS[tier],
    })) as unknown as JackpotPots;
}

/** A winning ticket the round can play: at least three spins of five reels of three 0/1 rows. */
function isPlayableTicket(ticket: unknown): ticket is { GemLayouts: number[][][] } {
    return isRecord(ticket)
        && Array.isArray(ticket.GemLayouts)
        && ticket.GemLayouts.length >= ROUND_SPINS
        && ticket.GemLayouts.every((spin: unknown) => Array.isArray(spin)
            && spin.length === ROUND_REELS
            && spin.every((reel: unknown) => Array.isArray(reel)
                && reel.length === ROUND_ROWS
                && reel.every((cell: unknown) => cell === 0 || cell === 1)));
}

/**
 * A reply's jackpot (`replyJackpot`) as `jackpotGameModel.setData` takes it.
 * A win the round cannot play (no winning pot, no three-spin ticket) is read
 * as no win, with a warning.
 */
function readJackpotResponse(raw: UnknownRecord): JackpotResponse {
    const pots = readPots(raw.CurrentPotValues) ?? currentPots() ?? fallbackPots();
    if (raw.JackpotWin === true) {
        const pot = isRecord(raw.WinningPot) ? raw.WinningPot : null;
        const tier = pot ? tierOf(pot.Tier) : null;
        const prize = pot ? finiteNumber(pot.PrizeValue) : null;
        const ticket = raw.WinningTicket;
        if (pot && tier && prize !== null && isPlayableTicket(ticket)) {
            const details: UnknownRecord = isRecord(raw.WinningDetails) ? raw.WinningDetails : {};
            const winning = { ...pot, Tier: tier, PrizeValue: prize };
            return {
                CurrentPotValues: pots,
                JackpotWin: true,
                WinningPot: winning,
                NextPotValue: isRecord(raw.NextPotValue) ? { ...raw.NextPotValue } : { ...winning },
                WinningTicket: { GemLayouts: ticket.GemLayouts.map((spin) => spin.map((reel) => reel.slice())) },
                WinningDetails: { ImmediateWin: details.ImmediateWin !== false, PaidOut: details.PaidOut !== false },
            } as unknown as JackpotResponse;
        }
        console.warn('[jackpots-runtime] The server reported a jackpot win the round cannot play (it needs the winning pot and a ticket of three spins); it is not shown.', raw);
    }
    return { CurrentPotValues: pots, JackpotWin: false } as unknown as JackpotResponse;
}

/** Settings `initialize` can build the game-rules figures from (else the package's defaults are used). */
function isJackpotDetails(value: unknown): boolean {
    const numbers = (list: unknown): boolean => Array.isArray(list)
        && list.length >= 3
        && list.every((n: unknown) => typeof n === 'number' && Number.isFinite(n));
    return isRecord(value)
        && numbers(value.ContributionDetails)
        && numbers(value.SeedValues)
        && typeof value.ContributionPercent === 'number'
        && finiteNumber(value.JackpotRTP) !== null;
}

/**
 * Before `initialize`: the engine's jackpot settings from the boot Resume (the
 * round's reels come with them — `setData` installs those whatever it is
 * given) and its pots, so the panel shows them at once.
 */
function seedFromResume(mod: JackpotsModule, reply: unknown): void {
    const settings = isRecord(reply) && isRecord(reply.GameSettings) ? reply.GameSettings.JackpotDetails : undefined;
    mod.jackpotGameSettings.setData((isJackpotDetails(settings) ? settings : undefined) as JackpotDetails);
    const jackpot = isRecord(reply) ? replyJackpot(reply) : null;
    const pots = jackpot ? readPots(jackpot.CurrentPotValues) : null;
    if (pots) mod.jackpotGameModel.setJackpotData(pots);
}

/** Note a game-server reply: a Begin's jackpot decides the round; any other's pots update the panel. */
function noteServerResult(reply: unknown): void {
    if (!isRecord(reply)) return;
    if (reply.RequestType === 'Begin') {
        pendingBegin = reply;
        pendingPots = null;
    } else {
        const jackpot = replyJackpot(reply);
        if (jackpot) pendingPots = { pots: jackpot.CurrentPotValues };
    }
    applyServerResults();
}

/** Hand the noted replies to the package once it is ready. */
function applyServerResults(): void {
    if (!jackpots) return;
    const { jackpotGameModel } = jackpots;
    const begin = pendingBegin;
    const update = pendingPots;
    pendingBegin = null;
    pendingPots = null;
    if (begin) {
        try {
            const jackpot = replyJackpot(begin);
            if (jackpot) jackpotGameModel.setData(readJackpotResponse(jackpot));
            else jackpotGameModel.hasJackpot = false;
        } catch (err) {
            jackpotGameModel.hasJackpot = false;
            console.warn('[jackpots-runtime] The Begin reply\'s jackpot could not be read; no jackpot round plays for it.', err);
        }
        wonRoundPending = jackpotGameModel.hasJackpot === true;
    }
    if (update) {
        const pots = readPots(update.pots);
        try {
            if (pots) jackpotGameModel.setJackpotData(pots);
        } catch (err) {
            console.warn('[jackpots-runtime] The jackpot pot values could not be updated.', err);
        }
    }
}

/** The cabinet's button while a ready round waits: spin the round's reels. */
function onCabinetBonusAction(stateName: string): void {
    if (stateName !== 'jackpot' || !releaseSpinPress || !jackpots) return;
    const release = releaseSpinPress;
    releaseSpinPress = null;
    try {
        jackpots.JackpotRound.cabinetSpinClicked();
    } catch (err) {
        console.warn('[jackpots-runtime] The jackpot round\'s spin failed to start.', err);
    }
    release();
}

/** A playing sound, as far as holding the game's music needs. */
interface HeldTrack {
    readonly isPlaying: boolean;
    pause(): void;
    resume(): void;
}

/**
 * Pause the game's music for the round (the package starts its own on top of
 * whatever plays); returns what resumes it.
 */
function holdGameMusic(): () => void {
    let held: HeldTrack[] = [];
    try {
        // `getActiveTracks` is the music group's own list of its tracks.
        const music = container.soundManager.music as unknown as { getActiveTracks?(): HeldTrack[] };
        held = (music.getActiveTracks?.() ?? []).filter((track) => track.isPlaying);
        for (const track of held) track.pause();
    } catch (err) {
        console.warn('[jackpots-runtime] The game music could not be paused for the jackpot round.', err);
    }
    return () => {
        for (const track of held) {
            try {
                track.resume();
            } catch {
                // The track has ended.
            }
        }
    };
}

/** Wait (up to `ROUND_ART_WAIT_MS`) for the round's background, reels and big win. */
async function roundArtLoaded(JackpotRound: JackpotsModule['JackpotRound']): Promise<boolean> {
    const deadline = Date.now() + ROUND_ART_WAIT_MS;
    for (;;) {
        const views = JackpotRound.views;
        if (views && views.background && views.slotView && views.bigWin) return true;
        if (Date.now() >= deadline) return false;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
    }
}

/** The parts of an event emitter a round waits on (the package's `JackpotRound.events`). */
interface RoundEvents {
    once(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
}

/** A promise of `events`' next `name`, and a way to stop listening. */
function nextEvent(events: RoundEvents, name: string): { promise: Promise<void>; cancel(): void } {
    let listener: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        listener = () => resolve();
        events.once(name, listener);
    });
    return { promise, cancel: () => { events.off(name, listener); } };
}

/** Whether `promise` settles within `ms`. */
function settles(promise: Promise<unknown>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => resolve(false), ms);
        const done = (): void => {
            window.clearTimeout(timer);
            resolve(true);
        };
        promise.then(done, done);
    });
}

/** Raise the round over the game, with the cabinet (which spins it) on top. */
function raiseRound(): void {
    const stage = roundLayer?.parent;
    if (!roundLayer || !stage) return;
    roundLayer.visible = true;
    stage.addChild(roundLayer);
    stage.addChild(container.cabinet);
}

/** Hide the round's layer and put the cabinet back in the scene's draw order. */
function lowerRound(): void {
    if (roundLayer) roundLayer.visible = false;
    try {
        jackpotsMountTarget?.attachCabinet?.(container.cabinet);
    } catch (err) {
        console.warn('[jackpots-runtime] The cabinet could not be returned to the scene.', err);
    }
}

/** After a preview: the cabinet as the idle game had it. */
function restoreIdleCabinet(): void {
    const cabinet = container.cabinet;
    try {
        cabinet.exitBonusState();
        cabinet.updateStakeButtons();
        cabinet.setCabinetMessageEx(container.strings.cabinet.default);
        cabinet.show();
    } catch (err) {
        console.warn('[jackpots-runtime] The cabinet could not be restored after the jackpot round.', err);
    }
}

/** Close a round that went wrong, so the game can carry on. */
async function abandonRound(JackpotRound: JackpotsModule['JackpotRound'], exited: Promise<void>): Promise<void> {
    try {
        JackpotRound.events.emit('onComplete');
    } catch (err) {
        console.warn('[jackpots-runtime] The jackpot round could not be closed.', err);
    }
    await settles(exited, ROUND_LEAVE_WAIT_MS);
    try {
        container.soundManager.music.stopAllInstancesOf('jackpots-background');
    } catch {
        // No round music.
    }
    try {
        container.cabinet.show();
    } catch {
        // No cabinet.
    }
}

/**
 * The whole round, from the panel's "triggered" animation to the exit. Never
 * rejects: a round that goes wrong is closed so the game carries on, and
 * resolves false.
 */
async function runRound(mod: JackpotsModule, kind: RoundKind): Promise<boolean> {
    const { JackpotRound, jackpotGameModel } = mod;
    if (!(await roundArtLoaded(JackpotRound))) {
        console.warn('[jackpots-runtime] The jackpot round\'s art has not loaded, so the round cannot play.');
        return false;
    }
    const cabinet = container.cabinet;
    const model = gameModel as unknown as { isInJackpot?: boolean };
    const ready = nextEvent(JackpotRound.events, 'ON_JACKPOT_ROUND_READY');
    const exited = nextEvent(JackpotRound.events, 'ON_JACKPOT_EXIT_TRANSITION_COMPLETE');
    // A real win also reaches arcade-base's own listeners (the session balance
    // overlay counts it); a preview's made-up prize must not.
    const forwardWin = (prize: number): void => {
        eventEmitter.emit('GAME_JACKPOT_WIN', prize);
    };
    if (kind === 'won') JackpotRound.events.on('GAME_JACKPOT_WIN', forwardWin);
    const resumeMusic = holdGameMusic();
    let entered = false;
    model.isInJackpot = true;
    try {
        starterDispatch?.('onEnterJackpot', undefined);
        cabinet.onBonusTriggered(false);
        cabinet.disablePurchaseButton();
        cabinet.disableStakeButtons();
        await settles(JackpotRound.views.jackpotPanelView.playTease(), TEASE_WAIT_MS);
        entered = true;
        raiseRound();
        await JackpotRound.enter();
        raiseRound();
        if (!(await settles(ready.promise, ROUND_READY_WAIT_MS))) throw new Error('the round never became ready');
        // The player starts the spins from the cabinet, as in every jackpot game.
        await new Promise<void>((resolve) => {
            releaseSpinPress = resolve;
        });
        if (!(await settles(exited.promise, ROUND_FINISH_WAIT_MS))) throw new Error('the round never finished');
        return true;
    } catch (err) {
        console.warn('[jackpots-runtime] The jackpot round went wrong; returning to the game.', err);
        if (entered) await abandonRound(JackpotRound, exited.promise);
        return false;
    } finally {
        releaseSpinPress = null;
        ready.cancel();
        exited.cancel();
        JackpotRound.events.off('GAME_JACKPOT_WIN', forwardWin);
        jackpotGameModel.hasJackpot = false;
        lowerRound();
        if (kind === 'preview') restoreIdleCabinet();
        else cabinet.disablePurchaseButton();
        model.isInJackpot = false;
        resumeMusic();
    }
}

function startRound(mod: JackpotsModule, kind: RoundKind): Promise<boolean> {
    const round = runRound(mod, kind).then(
        (played) => {
            activeRound = null;
            return played;
        },
        (err: unknown) => {
            activeRound = null;
            console.warn('[jackpots-runtime] The jackpot round failed.', err);
            return false;
        },
    );
    activeRound = round;
    return round;
}

/** A made-up winning ticket for `tier`: its gems land over the three spins, each spin keeping the last one's. */
function previewTicket(tier: JackpotTier): { GemLayouts: number[][][] } {
    const [fewest, most] = PREVIEW_GEMS[tier];
    const total = fewest + Math.floor(Math.random() * (most - fewest + 1));
    const cells: number[] = [];
    for (let cell = 0; cell < ROUND_REELS * ROUND_ROWS; cell++) cells.push(cell);
    for (let i = cells.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const swap = cells[i];
        cells[i] = cells[j];
        cells[j] = swap;
    }
    const perSpin: number[] = [];
    for (let spin = 0; spin < ROUND_SPINS; spin++) perSpin.push(Math.floor(total / ROUND_SPINS));
    for (let left = total % ROUND_SPINS; left > 0; left--) perSpin[Math.floor(Math.random() * ROUND_SPINS)]++;
    const layouts: number[][][] = [];
    let landed = 0;
    for (const count of perSpin) {
        landed += count;
        const lit = cells.slice(0, landed);
        const reels: number[][] = [];
        for (let reel = 0; reel < ROUND_REELS; reel++) {
            const rows: number[] = [];
            for (let row = 0; row < ROUND_ROWS; row++) rows.push(lit.indexOf(reel + ROUND_REELS * row) >= 0 ? 1 : 0);
            reels.push(rows);
        }
        layouts.push(reels);
    }
    return { GemLayouts: layouts };
}

/**
 * Play the jackpot round the latest Begin won, if it has not played yet, and
 * resolve once the game is back (true when a round played). `endCabinetGame`
 * awaits this before ending the game, so a won jackpot plays after the game's
 * own presentation and bonuses; the Enter Jackpot node can play it earlier. A
 * call while a round plays waits for that round. No-op (false) for a
 * non-jackpot skin, before jackpots are ready, and when nothing was won.
 */
export function enterJackpotsRuntime(): Promise<boolean> {
    if (!IS_JACKPOT || !jackpots) return Promise.resolve(false);
    if (activeRound) return activeRound;
    applyServerResults();
    if (!wonRoundPending || !jackpots.jackpotGameModel.hasJackpot) return Promise.resolve(false);
    wonRoundPending = false;
    return startRound(jackpots, 'won');
}

/**
 * Play a `tier` jackpot round now, without the server: a preview with a
 * made-up ticket and the pots the panel shows. Nothing is paid. Only while
 * the game is idle (not mid-game, no round playing). Resolves true when the
 * round played.
 */
export function previewJackpotRound(tier: JackpotTier): Promise<boolean> {
    if (!IS_JACKPOT || !jackpots) {
        console.warn('[jackpots-runtime] Jackpots are not running in this game, so no jackpot round can play.');
        return Promise.resolve(false);
    }
    if (activeRound || wonRoundPending || container.gameModel.isInProgress) {
        console.warn('[jackpots-runtime] A jackpot round can be played from the Debug menu only while the game is idle.');
        return Promise.resolve(false);
    }
    const mod = jackpots;
    try {
        const pots = currentPots() ?? fallbackPots();
        const winning = (pots as unknown as UnknownRecord[]).filter((pot) => pot.Tier === tier)[0];
        mod.jackpotGameModel.setData({
            CurrentPotValues: pots,
            JackpotWin: true,
            WinningPot: { ...winning },
            NextPotValue: { ...winning },
            WinningTicket: previewTicket(tier),
            WinningDetails: { ImmediateWin: true, PaidOut: true },
        } as unknown as JackpotResponse);
    } catch (err) {
        console.warn('[jackpots-runtime] The jackpot round could not be set up.', err);
        return Promise.resolve(false);
    }
    return startRound(mod, 'preview');
}

/** The debug data that makes the server's next Begin win a jackpot. */
export interface JackpotWinDebugData {
    DebugJackpotTier: string;
    DebugJackpotForceWin: boolean;
    DebugJackpotData: { ForceWin: boolean; WinningPotTierId: number };
}

/**
 * The debug data asking the server for a `tier` jackpot on the next buy
 * (`'Low'` / `'Mid'` / `'High'`, any case), or null for anything else
 * (`'None'`). It carries both forms engines read: `DebugJackpotData` (the B2B
 * engines and the bundled mock) and `DebugJackpotTier` + `DebugJackpotForceWin`
 * (earlier engines).
 */
export function jackpotWinDebugData(tierName: unknown): JackpotWinDebugData | null {
    const tier = tierOf(tierName);
    if (!tier || typeof tierName !== 'string') return null;
    return {
        DebugJackpotTier: tierName,
        DebugJackpotForceWin: true,
        DebugJackpotData: { ForceWin: true, WinningPotTierId: TIER_IDS[tier] },
    };
}

/**
 * The Debug menu's "play jackpot round" buttons, one per tier, on a jackpot
 * skin (none otherwise). Each closes the menu and plays a preview round
 * (`previewJackpotRound`) while the game is idle; the "jackpot win" setting
 * instead asks the server for a real win on the next buy.
 *
 * Called while `models/debug.ts` builds its settings at import time, so it
 * reads nothing from this module's state.
 */
export function jackpotDebugSettingOptions(): IDebugSettingType[] {
    if (!IS_JACKPOT) return [];
    const tiers: Array<[JackpotTier, string]> = [['low', 'Low'], ['mid', 'Mid'], ['high', 'High']];
    return tiers.map(([tier, label]): IDebugSettingType => ({
        name: `play jackpot round: ${label}`,
        type: 'trigger',
        onChange: () => {
            eventEmitter.emit('POPUP_TOGGLE_DEBUG_OVERLAY', false);
            void previewJackpotRound(tier);
        },
    }));
}
