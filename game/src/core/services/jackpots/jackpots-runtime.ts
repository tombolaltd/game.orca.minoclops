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
 */

import {
    container,
    device,
    environment,
    eventEmitter,
    queryStringParams,
    userModel,
} from '@game-studio/arcade-base';
import { Assets, type Container, type Texture } from 'pixi.js';
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

        // Mark ready ONLY now, so resize/enter no-op until fully wired.
        jackpots = mod;
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

/**
 * Enter the jackpot round (the host wires this to the FlowState
 * `onEnterJackpot` starter). Guarded by `jackpotGameModel.hasJackpot`, so it
 * is safe to call even when the player has no active jackpot or jackpots never
 * initialised — both cases simply no-op.
 */
export async function enterJackpotsRuntime(): Promise<void> {
    if (!IS_JACKPOT || !jackpots) return;
    const { JackpotRound, jackpotGameModel } = jackpots;
    if (!jackpotGameModel.hasJackpot) return;
    try {
        await JackpotRound.enter();
    } catch (err) {
        console.warn('[jackpots-runtime] Jackpots enter failed.', err);
    }
}
