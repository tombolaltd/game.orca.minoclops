/**
 * FlowState Methods Index
 *
 * Aggregates every method module the FlowState graph runner can dispatch to.
 *
 * The runner uses `findMethod(flowstateMethods, node.title)` to resolve a
 * graph node's title to a function. Method names are global within their
 * resolution branch; keep names unique unless they live under different
 * subtrees (e.g. `actions.spine.playAnimation` vs `actions.audio.play`).
 *
 * Categories:
 * - Core utilities: `debug`, `delay`
 * - Game actions: `actions.{ transform | spine | animatedSprite | video |
 *                            videoSequencer | particles | scratchableItem |
 *                            text | cabinet | casinoCabinet | audio | mixer |
 *                            reels | bigwin | scene | animation | jackpots |
 *                            continueRequest | network | scene3d | settings }`
 * - Game state / info: `gameState`, `wallet`, `deviceInfo`
 * - Event dispatchers: `fireEvent.{ globalFireEvents | popupFireEvents |
 *                                    cabinetFireEvents | casinoCabinetFireEvents |
 *                                    gameFireEvents | chatFireEvents }`
 * - Model access: `getGameModelProperty`, `setGameModelProperty`,
 *                 `getSettingsModelProperty`, `setSettingsModelProperty`
 * - Value helpers: `math`, `logic`, `array`, `string`, `cast`, `objectOps`, `network`, `util`
 * - Installed node extensions: `extensions` (generated `ext_*` entries)
 * - Localisation: `translations` (reads the auto-generated
 *   `../generated-translations`)
 * - Player settings: `gamePreferences` (custom game preferences, via
 *   `../game-preferences`)
 * - User-authored custom nodes: `custom` (auto-generated from this project's
 *   `orca-project-files/scripts/` folder — see `../generated-custom-nodes`)
 *
 * Component actions resolve their `target` argument to a live Pixi
 * DisplayObject by UUID via `methods/node-ref.ts` → `SceneManager.getDisplayObjectById`.
 */
import { customNodes } from "../generated-custom-nodes";
import { animatedSprite } from "./animated-sprite";
import { animation } from "./animation";
import { array } from "./array";
import { audio } from "./audio";
import { bigwin } from "./bigwin";
import { cabinet } from "./cabinet";
import { cast } from "./cast";
import { casinoCabinet } from "./casino-cabinet";
import { continueRequest } from "./continue";
import { debug } from "./debug";
import { delay } from "./delay";
import { deviceInfo } from "./device";
import { extensions } from "./extensions";
import { cabinetFireEvents, casinoCabinetFireEvents, chatFireEvents, customFireEvents, gameFireEvents, globalFireEvents, popupFireEvents } from "./fireEvent";
import { gamePreferences } from "./game-preferences";
import { gameState } from "./game-state";
import { reels } from "./generic-reels";
import { reelsWinline } from "./reels-winline";
import { jackpots } from "./jackpots";
import { logic } from "./logic";
import { math } from "./math";
import { mixer } from "./mixer";
import { network, networkActions } from "./network";
import { getGameModelProperty, setGameModelProperty, getSettingsModelProperty, setSettingsModelProperty } from "./model";
import { objectOps } from "./object";
import { particles } from "./particles";
import { scene } from "./scene";
import { sceneQuery } from "./scene-query";
import { scene3d } from "./scene3d";
import { scratchableItem } from "./scratchable-item";
import { settings } from "./settings";
import { spine } from "./spine";
import { string } from "./string";
import { text } from "./text";
import { transform } from "./transform";
import { translations } from "./translations";
import { util } from "./util";
import { video } from "./video";
import { videoSequencer } from "./video-sequencer";
import { wallet } from "./wallet";

// Keep every reference to an imported binding inside a function: this barrel sits in a production import cycle.
const buildActions = () => ({
    /** Generic DisplayObject controls (position/scale/alpha/visibility/tweens). */
    transform,
    /** Spine skeletal-animation control (target: spine scene node). */
    spine,
    /** AnimatedSprite (frame-array) playback control. */
    animatedSprite,
    /** Video element control (play/pause/seek/loop/volume/mute). */
    video,
    /** VideoSequencer playlist control (next/previous/setIndex). */
    videoSequencer,
    /** Particles emitter control (start/stop/burst). */
    particles,
    /** Scratch-card panel control (reset/reveal/enable/brush size/progress). */
    scratchableItem,
    /** Text node content + style control. */
    text,
    /** Generic cabinet/chrome control (visibility, messages, buttons). */
    cabinet,
    /** Casino-only cabinet modes (free play, demo, bonus state, reveal-all). */
    casinoCabinet,
    /** Audio playback (SFX and music). */
    audio,
    /** Audio mixer — bus faders, mute/solo, pitch and ducking. */
    mixer,
    /** Reel control for slot games. Includes per-instance winline methods (`playWinline`, `clearWinline`) merged in from `reels-winline.ts`. */
    reels: Object.assign(reels, {
        playWinline: reelsWinline.playWinline.bind(reelsWinline),
        clearWinline: reelsWinline.clearWinline.bind(reelsWinline),
    }),
    /** BigWin celebration display. */
    bigwin,
    /** Scene management — load/unload scenes at runtime. */
    scene,
    /** Scene-node lookups (`findChildNode` / `getChildNode` / `getChildCount`) that turn one node reference into another. */
    sceneQuery,
    /** Animation Timeline clips — play/stop/pause/resume/seek/speed. */
    animation,
    /** Jackpots — enter the (gated) jackpot round (`enterJackpot`). No-op for a non-jackpot skin. */
    jackpots,
    /** Game-server "continue" request with an author-defined payload (`sendContinueRequest`). */
    continueRequest,
    /** HTTP POST of a JSON body (`httpPost`). */
    network: networkActions,
    /** `scene3d` node controls (target: node3dRef) — transform, tweens, lights, camera, model clips. */
    scene3d,
    /** In-game settings menu — show / hide / toggle. */
    settings
});

const buildFireEvent = () => ({
    globalFireEvents,
    popupFireEvents,
    cabinetFireEvents,
    casinoCabinetFireEvents,
    gameFireEvents,
    chatFireEvents,
    customFireEvents,
});

const buildFlowstateMethods = () => ({
    debug,
    delay,
    actions: buildActions(),
    gameState,
    wallet,
    deviceInfo,
    fireEvent: buildFireEvent(),
    math,
    /** Boolean-logic combinators (`and` / `or` / `not`) plus the `isDefined` existence check, for `branch` conditions. */
    logic,
    array,
    string,
    cast,
    /**
     * Structured-data helpers (`parseObject`). Named `objectOps` rather than
     * `object` to avoid shadowing the built-in type name — dispatch matches on
     * the METHOD key, not the namespace key, so the name is free.
     */
    objectOps,
    /** HTTP GET returning parsed JSON (`httpGet`). */
    network,
    util,
    /**
     * Translation lookups against this project's authored language table,
     * mirrored by the editor into `../generated-translations.ts`.
     */
    translations,
    /** Custom game preferences from the in-game settings menu, authored in the editor. */
    gamePreferences,
    getGameModelProperty,
    setGameModelProperty,
    getSettingsModelProperty,
    setSettingsModelProperty,
    /**
     * Installed node extensions, from the GENERATED `extensions/index.ts`.
     * Every key is `ext_*` (enforced in the editor by `EXTENSION_METHOD_KEY_RE`),
     * so no extension can ever shadow a builtin method name. Listed LAST so
     * `findMethod`'s own-property walk reaches every builtin before it descends
     * in here, leaving builtin resolution byte-for-byte unchanged.
     */
    extensions,
    /**
     * User-authored custom nodes, auto-generated from this project's
     * `orca-project-files/scripts/` folder into `../generated-custom-nodes.ts`
     * (mirrored source lives in `../custom-scripts/`). Each key is a script's
     * `definition.name` — the IMMUTABLE runtime key — and each value is that
     * script's exported `run` function.
     *
     * `findMethod` recurses into any nested plain object, so a custom node
     * resolves by `definition.name` alone: the `custom` namespace key is never
     * part of a graph node's title. Inputs map to `run`'s POSITIONAL
     * parameters in declared order; 0 outputs = void, 1 output = the returned
     * value, 2+ outputs = an object keyed by output name.
     *
     * NEVER hand-edit `generated-custom-nodes.ts` or `custom-scripts/` — Orca
     * rewrites both on project open and on every script change.
     */
    custom: customNodes
});

type FlowstateMethods = ReturnType<typeof buildFlowstateMethods>;

let built: FlowstateMethods | undefined;

function methods(): FlowstateMethods {
    return (built ??= buildFlowstateMethods());
}

// Descriptors are forced configurable: the proxy target is empty, and a non-configurable report for a key it lacks throws.
export const flowstateMethods: FlowstateMethods = new Proxy({} as FlowstateMethods, {
    get: (_target, prop) => Reflect.get(methods(), prop),
    has: (_target, prop) => prop in methods(),
    ownKeys: () => Reflect.ownKeys(methods()),
    getOwnPropertyDescriptor: (_target, prop) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(methods(), prop);
        return descriptor && { ...descriptor, configurable: true };
    },
});
