// Editor-facing MOTION probe. Backs the Build From Spec wizard's opt-in
// "game-feel assertions" pass, which checks that a generated game's reels
// actually ANIMATE and stop in SEQUENCE instead of instant-revealing. It also
// hosts the playtest API (`window.__orcaPlaytest`, end of file).
//
// WHY THIS LIVES IN THE GAME AND NOT THE EDITOR
// The editor injects scripts into the game <webview>, but the game usually
// runs inside a CROSS-ORIGIN iframe hosted by the shell, so injected script in
// the top frame cannot read the game's Pixi scene graph. The two channels that
// DO cross that boundary are `postMessage` (editor -> game) and `console.log`
// (game -> editor, the same relay `editor-integration.ts` uses for server
// responses). This module owns the in-page half of both.
//
// It samples REAL scene-graph state — per-reel `speed` off the generic-reels
// speed controller plus the live symbol-strip y offsets — never a canvas pixel
// hash. Interpretation of the trace is deliberately NOT here: the editor
// decides what "animated" and "sequential" mean, so thresholds can change
// without a project migration.
//
// PROTOTYPING AID ONLY. It measures motion in a dev preview; it certifies
// nothing and is never part of a production build path.

import { container, device, eventEmitter, Injects } from '@game-studio/arcade-base';
import { getGameModelProperty, getSettingsModelProperty } from './methods/model';

/** Bumped only when the TRACE SHAPE changes; the editor reports a mismatch. */
const PROBE_VERSION = 1;

/** Editor -> game request, delivered by postMessage or a same-origin event. */
const REQUEST_TYPE = 'orca-game-feel-request';

/** Game -> editor reply prefix, read off the webview's console-message feed. */
const REPLY_PREFIX = 'orca-game-feel:';

/** Hard ceilings so a runaway request can never flood the console channel. */
const MAX_SAMPLES = 200;
const MAX_REELS = 16;
const MAX_DURATION_MS = 20000;

interface ProbeRequest {
    requestId?: unknown;
    durationMs?: unknown;
    sampleIntervalMs?: unknown;
    trigger?: unknown;
}

interface ReelSample {
    /** ms since the run started. */
    t: number;
    /** Per-reel absolute speed off the generic-reels speed controller. */
    speeds: number[];
    /** Per-reel strip offset (first symbol's y, else the reel view's own y). */
    offsets: number[];
}

interface SpinControlState {
    present: boolean;
    visible: boolean;
    interactive: boolean;
}

interface GameFeelTrace {
    v: number;
    requestId: string;
    ok: boolean;
    /** Machine-readable skip reason when `ok` is false. */
    reason?: string;
    triggered: boolean;
    triggerMethod: string;
    durationMs: number;
    reelSetName: string;
    reelCount: number;
    samples: ReelSample[];
    spinControlStart: SpinControlState;
    spinControlEnd: SpinControlState;
}

type UnknownRecord = Record<string, unknown>;

function toNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Depth-bounded walk for the reels roots `buildFlowstateReelsDisplay` tags with
 * `_flowstateReelViews`. Stops descending into a matched root — a reels node
 * never nests another.
 */
function collectReelRoots(node: unknown, out: UnknownRecord[], depth: number): void {
    if (!node || depth > 14 || out.length >= 4) return;
    const record = node as UnknownRecord;
    const views = record._flowstateReelViews;
    if (Array.isArray(views) && views.length > 0) {
        out.push(record);
        return;
    }
    const children = record.children;
    if (!Array.isArray(children)) return;
    for (const child of children) collectReelRoots(child, out, depth + 1);
}

function readReelSample(reelViews: UnknownRecord[], t: number): ReelSample {
    const speeds: number[] = [];
    const offsets: number[] = [];
    for (const view of reelViews) {
        let speed = 0;
        let offset = 0;
        try {
            const control = view._speedControl as { speed?: unknown } | undefined;
            speed = Math.abs(toNumber(control && control.speed, 0));
            const symbols = view.symbols;
            const first = Array.isArray(symbols) && symbols.length > 0
                ? (symbols[0] as UnknownRecord | undefined)
                : undefined;
            offset = toNumber(first && first.y, toNumber(view.y, 0));
        } catch {
            // A destroyed reel (scene swapped mid-run) reads as stopped.
        }
        speeds.push(round2(speed));
        offsets.push(round2(offset));
    }
    return { t: Math.round(t), speeds, offsets };
}

/**
 * The arcade cabinet owns the only player-facing spin control, so "is input
 * blocked" reduces to "is the cabinet still visible and accepting pointers".
 * Everything is optional-read: a game without a cabinet reports `present:false`
 * and the editor skips that assertion rather than failing it.
 */
function readSpinControl(): SpinControlState {
    try {
        const cabinet = (container as unknown as UnknownRecord).cabinet as UnknownRecord | undefined;
        if (!cabinet) return { present: false, visible: false, interactive: false };
        return {
            present: true,
            visible: cabinet.visible !== false && cabinet.renderable !== false,
            interactive: cabinet.interactiveChildren !== false,
        };
    } catch {
        return { present: false, visible: false, interactive: false };
    }
}

function reply(trace: GameFeelTrace): void {
    try {
        // eslint-disable-next-line no-console
        console.log(REPLY_PREFIX + JSON.stringify(trace));
    } catch {
        // A trace that cannot be serialised is simply never answered; the
        // editor times out and reports a skip.
    }
}

function runProbe(stage: unknown, request: ProbeRequest): void {
    const requestId = typeof request.requestId === 'string' ? request.requestId : '';
    const durationMs = clamp(toNumber(request.durationMs, 3500), 250, MAX_DURATION_MS);
    const sampleIntervalMs = clamp(toNumber(request.sampleIntervalMs, 32), 8, 500);
    const wantsTrigger = request.trigger !== false;

    const roots: UnknownRecord[] = [];
    try {
        collectReelRoots(stage, roots, 0);
    } catch {
        // Fall through to the no-reels reply below.
    }

    const spinControlStart = readSpinControl();

    if (roots.length === 0) {
        reply({
            v: PROBE_VERSION,
            requestId,
            ok: false,
            reason: 'no-reels',
            triggered: false,
            triggerMethod: 'none',
            durationMs: 0,
            reelSetName: '',
            reelCount: 0,
            samples: [],
            spinControlStart,
            spinControlEnd: spinControlStart,
        });
        return;
    }

    const root = roots[0];
    const reelViews = (root._flowstateReelViews as UnknownRecord[]).slice(0, MAX_REELS);
    const reelSetName = typeof root.name === 'string' ? root.name : '';

    const samples: ReelSample[] = [readReelSample(reelViews, 0)];

    let triggered = false;
    let triggerMethod = 'none';
    if (wantsTrigger) {
        try {
            // The same signal `@game-studio/cabinet` emits on a successful buy
            // in, and the signal `application.ts` already listens for — so the
            // spin runs through the game's own flow, not a private shortcut.
            // `false` = not an auto-buy, matching the FlowState `gameBegin`
            // method in `methods/fireEvent.ts`.
            eventEmitter.emit('GAME_BEGIN', false);
            triggered = true;
            triggerMethod = 'GAME_BEGIN';
        } catch {
            triggerMethod = 'failed';
        }
    }

    const started = Date.now();
    let lastSampleAt = -Infinity;

    const tick = (): void => {
        const elapsed = Date.now() - started;
        if (elapsed - lastSampleAt >= sampleIntervalMs) {
            lastSampleAt = elapsed;
            try {
                samples.push(readReelSample(reelViews, elapsed));
            } catch {
                // Ignore a single bad frame; the run still completes.
            }
        }
        if (elapsed < durationMs && samples.length < MAX_SAMPLES) {
            requestAnimationFrame(tick);
            return;
        }
        reply({
            v: PROBE_VERSION,
            requestId,
            ok: true,
            triggered,
            triggerMethod,
            durationMs: elapsed,
            reelSetName,
            reelCount: reelViews.length,
            samples,
            spinControlStart,
            spinControlEnd: readSpinControl(),
        });
    };

    requestAnimationFrame(tick);
}

/**
 * Install the probe's request listeners. Idempotent, and safe to call before
 * any scene exists — the stage is walked lazily, per request.
 *
 * Called from the host boot in `views/game/application.ts` once the Pixi stage
 * is registered with SceneManager.
 */
export function installGameFeelProbe(stage: unknown): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as UnknownRecord;
    if (w.__orcaGameFeelProbeInstalled === true) return;
    w.__orcaGameFeelProbeInstalled = true;
    w.__orcaGameFeelProbeVersion = PROBE_VERSION;

    // Requests are answered at most once each, so a broadcast that reaches the
    // game through BOTH channels cannot start two overlapping recordings.
    const served = new Set<string>();
    let busy = false;

    const accept = (payload: unknown): void => {
        if (!payload || typeof payload !== 'object') return;
        const request = payload as ProbeRequest;
        if ((payload as UnknownRecord).type !== REQUEST_TYPE) return;
        const requestId = typeof request.requestId === 'string' ? request.requestId : '';
        if (!requestId || served.has(requestId) || busy) return;
        served.add(requestId);
        busy = true;
        try {
            runProbe(stage, request);
        } finally {
            // The recording continues on rAF; the latch only serialises the
            // synchronous entry, and is released once the run window closes.
            const durationMs = clamp(toNumber(request.durationMs, 3500), 250, MAX_DURATION_MS);
            setTimeout(() => { busy = false; }, durationMs + 500);
        }
    };

    window.addEventListener('message', (event: MessageEvent) => { accept(event.data); });
    window.addEventListener(REQUEST_TYPE, (event: Event) => {
        accept((event as CustomEvent<unknown>).detail);
    });

    installPlaytestApi(stage);
}

// =========================================================================
// Playtest API (Orca's Magicbook / Port playtest pass)
// =========================================================================
// Main calls these from the editor through `WebFrameMain.executeJavaScript`
// on this frame, so answers are return values, not console lines. Nothing is
// wrapped or listened to until `arm()`; idle cost is one global object.
//
// Version 3 adds `fire`, `read`, `cabinet` and `buy` for the project's
// Playwright suite (`tests/e2e/`). The editor's own playtest never calls them.
// `spin` replays the round already in the model (GAME_BEGIN is what the
// cabinet emits AFTER the engine answers a buy), so it sends no begin request;
// `buy` presses the cabinet's buy action, which does.
// Version 4 adds `counters.reelMoves`, counted every frame after `arm()`.
// Version 5 adds `debug` (list / selectTicket / setSetting / openMenu) for the
// editor's Game view Debug panel: the in-game debug menu without the long press.

const PLAYTEST_VERSION = 5;
const MAX_ERRORS = 20;
const MAX_OVERLAPS = 8;
/** Smallest share of the reel window an object must cover to be reported. */
const MIN_COVERAGE = 0.02;
/** How often the per-frame motion watcher looks for the reels again (scene swaps). */
const REEL_LOOKUP_MS = 500;

interface PlaytestRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface PlaytestOverlap {
    path: string;
    kind: string;
    text?: string;
    coverage: number;
    alpha: number;
}

/** The cabinet's buy control, read from `@game-studio/cabinet` internals (best effort). */
interface PlaytestCabinet {
    present: boolean;
    /** True while the player can buy; null when the control could not be read. */
    buyEnabled: boolean | null;
    /** The arcade action state ('buy' | 'reveal' | 'stop' | 'auto-buy' | 'disabled' | 'bonus'), when readable. */
    actionState: string | null;
    /** The buy button's bounds on the canvas, in CSS pixels. */
    buyRect: PlaytestRect | null;
}

interface PlaytestSnapshot {
    v: number;
    t: number;
    reels: null | { name: string; reelCount: number; spinning: boolean; speeds: number[]; rect: PlaytestRect | null };
    spinControl: SpinControlState;
    overlaps: PlaytestOverlap[];
    /** `reelMoves`: frames in which a reel moved — catches a spin shorter than the editor's poll. */
    counters: { begins: number; endGames: number; completes: number; hooked: boolean; reelMoves: number };
    errors: string[];
}

/** The window the game is drawn in, as the scene manager sees it. */
interface PlaytestLayout {
    width: number;
    height: number;
    /** The band the game may use: in portrait with the chat open, the top part only. */
    gameHeight: number;
    mode: 'portrait' | 'landscape' | 'desktop';
}

function readLayout(): PlaytestLayout {
    const width = toNumber(window.innerWidth, 0);
    const height = toNumber(window.innerHeight, 0);
    let gameHeight = height;
    let isDesktop = false;
    try {
        // Read lazily: `device` is assigned when arcade-base initialises it.
        const d = device as unknown as UnknownRecord | undefined;
        const gh = toNumber(d?.gameHeight, 0);
        if (gh > 0) gameHeight = Math.min(gh, height);
        isDesktop = ((d?.type as UnknownRecord | undefined)?.isDesktop) === true;
    } catch {
        // Not initialised yet: the whole window is the game area.
    }
    const mode = isDesktop ? 'desktop' : height > width ? 'portrait' : 'landscape';
    return { width, height, gameHeight, mode };
}

function nodeLabel(node: UnknownRecord): string {
    const label = node.label ?? node.name;
    return typeof label === 'string' && label ? label : String((node.constructor as { name?: string } | undefined)?.name ?? '?');
}

function readBounds(node: UnknownRecord): PlaytestRect | null {
    try {
        const b = (node.getBounds as (() => UnknownRecord) | undefined)?.call(node);
        if (!b) return null;
        const rect = { x: toNumber(b.x, 0), y: toNumber(b.y, 0), width: toNumber(b.width, 0), height: toNumber(b.height, 0) };
        return rect.width > 0 && rect.height > 0 ? rect : null;
    } catch {
        return null;
    }
}

function intersectArea(a: PlaytestRect, b: PlaytestRect): number {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

/** The union of every reel's mask: the window the player watches. */
function reelWindow(reelViews: UnknownRecord[]): PlaytestRect | null {
    let rect: PlaytestRect | null = null;
    for (const view of reelViews) {
        const wrapper = view.parent as UnknownRecord | undefined;
        const mask = (wrapper?.mask ?? null) as UnknownRecord | null;
        const b = mask ? readBounds(mask) : readBounds(view);
        if (!b) continue;
        if (!rect) { rect = b; continue; }
        const x = Math.min(rect.x, b.x);
        const y = Math.min(rect.y, b.y);
        rect = {
            x,
            y,
            width: Math.max(rect.x + rect.width, b.x + b.width) - x,
            height: Math.max(rect.y + rect.height, b.y + b.height) - y,
        };
    }
    return rect;
}

function drawOrderChildren(node: UnknownRecord): UnknownRecord[] {
    const children = Array.isArray(node.children) ? (node.children as UnknownRecord[]) : [];
    if (node.sortableChildren !== true) return children;
    return children
        .map((child, index) => ({ child, index }))
        .sort((a, b) => (toNumber(a.child.zIndex, 0) - toNumber(b.child.zIndex, 0)) || (a.index - b.index))
        .map((entry) => entry.child);
}

/**
 * Visible objects drawn IN FRONT of the reels that cover part of the reel
 * window. The reels' own group (lock tiles, win frames, expanded symbols) is
 * part of the reel presentation, so only objects outside it are reported.
 */
function collectOverlaps(stage: UnknownRecord, reelsRoot: UnknownRecord, reelRect: PlaytestRect): PlaytestOverlap[] {
    let sceneRoot: UnknownRecord = reelsRoot;
    while (sceneRoot.parent && sceneRoot.parent !== stage) sceneRoot = sceneRoot.parent as UnknownRecord;
    const parent = reelsRoot.parent as UnknownRecord | undefined;
    const exempt = parent && parent !== sceneRoot && parent !== stage ? parent : reelsRoot;
    const windowArea = reelRect.width * reelRect.height;
    const out: PlaytestOverlap[] = [];
    let passedReels = false;
    let visited = 0;

    const walk = (node: UnknownRecord, alpha: number, path: string[]): void => {
        if (visited++ > 5000) return;
        if (node === exempt) { passedReels = true; return; }
        if (node.visible === false || node.renderable === false) return;
        const nodeAlpha = alpha * toNumber(node.alpha, 1);
        if (nodeAlpha < 0.05) return;
        const children = drawOrderChildren(node);
        const kind = String((node.constructor as { name?: string } | undefined)?.name ?? '');
        const here = [...path, nodeLabel(node)];
        if (children.length > 0 && kind !== 'Spine') {
            for (const child of children) walk(child, nodeAlpha, here);
            return;
        }
        if (!passedReels) return;
        const b = readBounds(node);
        if (!b) return;
        const coverage = intersectArea(b, reelRect) / windowArea;
        if (coverage < MIN_COVERAGE) return;
        const text = typeof node.text === 'string' ? node.text.slice(0, 40) : undefined;
        out.push({ path: here.slice(-4).join('/'), kind, ...(text ? { text } : {}), coverage: round2(coverage), alpha: round2(nodeAlpha) });
    };

    walk(stage, 1, []);
    return out.sort((a, b) => b.coverage - a.coverage).slice(0, MAX_OVERLAPS);
}

// ── Debug menu ───────────────────────────────────────────────────────────

interface DebugTicketInfo {
    index: number;
    name: string;
    hasData: boolean;
    /** `data` is an empty object: the option sends nothing to the server. */
    emptyData: boolean;
    /** A Debug Panel "fire custom event" button: fires, never stays selected. */
    isEvent: boolean;
    selected: boolean;
}

interface DebugSettingInfo {
    index: number;
    name: string;
    type: 'enum' | 'slider' | 'trigger' | 'other';
    availableValues?: string[];
    min?: number;
    max?: number;
    steps?: number;
    currentValue?: number | string | boolean;
}

type DebugFailure = { ok: false; reason: string; message?: string };
type DebugList = { ok: true; tickets: DebugTicketInfo[]; settings: DebugSettingInfo[]; active: boolean } | DebugFailure;

function isDebugModel(value: unknown): value is UnknownRecord {
    return !!value && typeof value === 'object' && Array.isArray((value as UnknownRecord).debugTicketOptions);
}

/** The game's debug model, looked up on every call (variants may rebind it). */
function resolveDebugModel(): UnknownRecord | null {
    const c = container as unknown as UnknownRecord | undefined;
    try {
        if (isDebugModel(c?.debugModel)) return c?.debugModel as UnknownRecord;
    } catch {
        // Not bound yet.
    }
    try {
        const key = (Injects as unknown as UnknownRecord | undefined)?.DebugModel;
        const get = c?.get;
        if (key !== undefined && typeof get === 'function') {
            const model = (get as (k: unknown) => unknown).call(c, key);
            if (isDebugModel(model)) return model;
        }
    } catch {
        // Not bound yet.
    }
    return null;
}

function debugSettings(model: UnknownRecord): UnknownRecord[] {
    return Array.isArray(model.debugSettingOptions) ? (model.debugSettingOptions as UnknownRecord[]) : [];
}

// arcade-base's in-game debug overlay (Vue 2) keeps its OWN copy of the selected
// ticket (`selectedOption` data) and of each enum's label (DebugSetting
// `selectedEnum`, read once at mount), so a model change made here must be
// mirrored into those instances or the in-game menu keeps showing the old choice.
const MAX_VM_DEPTH = 6;

function debugOverlayVms(): UnknownRecord[] {
    const doc = (globalThis as unknown as { document?: { querySelectorAll?: (s: string) => ArrayLike<unknown> } }).document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const found: UnknownRecord[] = [];
    try {
        for (const el of Array.from(doc.querySelectorAll('.debug-overlay'))) {
            let node = el as UnknownRecord | null;
            for (let depth = 0; node && depth < 4; depth += 1, node = (node.parentElement as UnknownRecord | null) ?? null) {
                const vm = node.__vue__ as UnknownRecord | undefined;
                if (vm && typeof vm.updateDebugOption === 'function' && 'selectedOption' in vm) {
                    if (!found.includes(vm)) found.push(vm);
                    break;
                }
            }
        }
    } catch {
        // A document without the overlay; nothing to mirror.
    }
    return found;
}

function syncOverlayTicket(model: UnknownRecord): void {
    for (const vm of debugOverlayVms()) {
        try {
            vm.selectedOption = model.selectedOption;
        } catch {
            // Display only; the model already holds the choice.
        }
    }
}

function settingVms(vm: UnknownRecord, setting: UnknownRecord, depth: number, out: UnknownRecord[]): void {
    if (depth > MAX_VM_DEPTH) return;
    const children = Array.isArray(vm.$children) ? (vm.$children as UnknownRecord[]) : [];
    for (const child of children) {
        if (child && child.setting === setting && 'selectedEnum' in child) out.push(child);
        else if (child) settingVms(child, setting, depth + 1, out);
    }
}

function syncOverlaySetting(setting: UnknownRecord): void {
    const vms: UnknownRecord[] = [];
    for (const overlay of debugOverlayVms()) settingVms(overlay, setting, 0, vms);
    for (const vm of vms) {
        try {
            if (setting.type === 'enum' && Array.isArray(setting.availableValues)) {
                vm.selectedEnum = (setting.availableValues as unknown[])[setting.currentValue as number];
            }
            if (typeof vm.$forceUpdate === 'function') (vm.$forceUpdate as () => void).call(vm);
        } catch {
            // Display only.
        }
    }
}

function plainScalar(value: unknown): number | string | boolean | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    return typeof value === 'string' || typeof value === 'boolean' ? value : undefined;
}

function finiteOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function listDebug(): DebugList {
    const model = resolveDebugModel();
    if (!model) return { ok: false, reason: 'no-debug-model' };
    try {
        const options = model.debugTicketOptions as UnknownRecord[];
        const selected = model.selectedOption as UnknownRecord | undefined;
        let selectedIndex = selected ? options.indexOf(selected) : -1;
        if (selectedIndex < 0 && selected) selectedIndex = options.findIndex((o) => o?.name === selected.name);
        const tickets = options.map((o, index): DebugTicketInfo => ({
            index,
            name: String(o?.name ?? ''),
            hasData: o?.data !== undefined,
            emptyData: !!o?.data && typeof o.data === 'object' && !Array.isArray(o.data) && Object.keys(o.data as object).length === 0,
            isEvent: typeof o?.orcaEventName === 'string' && o.orcaEventName !== '',
            selected: index === selectedIndex,
        }));
        const settings = debugSettings(model).map((s, index): DebugSettingInfo => {
            const raw = s?.type;
            const type = raw === 'enum' || raw === 'slider' || raw === 'trigger' ? raw : 'other';
            const info: DebugSettingInfo = { index, name: String(s?.name ?? ''), type };
            if (type === 'enum' && Array.isArray(s.availableValues)) info.availableValues = (s.availableValues as unknown[]).map((v) => String(v));
            if (type === 'slider') {
                const min = finiteOrUndefined(s.min);
                const max = finiteOrUndefined(s.max);
                const steps = finiteOrUndefined(s.steps);
                if (min !== undefined) info.min = min;
                if (max !== undefined) info.max = max;
                if (steps !== undefined) info.steps = steps;
            }
            const current = plainScalar(s?.currentValue);
            if (current !== undefined) info.currentValue = current;
            return info;
        });
        let active = false;
        try { active = model.shouldSendDebugData === true; } catch { active = false; }
        return { ok: true, tickets, settings, active };
    } catch (error) {
        return { ok: false, reason: 'threw', message: String((error as { message?: unknown } | null)?.message ?? error) };
    }
}

function selectDebugTicket(index: unknown, name: unknown): { ok: true; state: DebugList } | DebugFailure {
    const model = resolveDebugModel();
    if (!model) return { ok: false, reason: 'no-debug-model' };
    const options = model.debugTicketOptions as UnknownRecord[];
    const option = typeof index === 'number' && Number.isInteger(index) ? options[index] : undefined;
    if (!option || option.name !== name) return { ok: false, reason: 'stale' };
    try {
        (model.updateDebugOption as (o: unknown) => unknown).call(model, option);
    } catch (error) {
        return { ok: false, reason: 'threw', message: String((error as { message?: unknown } | null)?.message ?? error) };
    }
    syncOverlayTicket(model);
    return { ok: true, state: listDebug() };
}

async function setDebugSetting(index: unknown, name: unknown, value: unknown): Promise<{ ok: true; state: DebugList } | DebugFailure> {
    const model = resolveDebugModel();
    if (!model) return { ok: false, reason: 'no-debug-model' };
    const settings = debugSettings(model);
    const setting = typeof index === 'number' && Number.isInteger(index) ? settings[index] : undefined;
    if (!setting || setting.name !== name) return { ok: false, reason: 'stale' };
    const onChange = setting.onChange;
    if (typeof onChange !== 'function') return { ok: false, reason: 'no-onchange' };
    try {
        let result: unknown;
        if (setting.type === 'enum') {
            const count = Array.isArray(setting.availableValues) ? (setting.availableValues as unknown[]).length : 0;
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= count) return { ok: false, reason: 'bad-value' };
            setting.currentValue = value;
            result = (onChange as (s: unknown) => unknown).call(setting, setting);
        } else if (setting.type === 'slider') {
            if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'bad-value' };
            const min = finiteOrUndefined(setting.min) ?? -Infinity;
            const max = finiteOrUndefined(setting.max) ?? Infinity;
            setting.currentValue = Math.min(max, Math.max(min, value));
            result = (onChange as (s: unknown) => unknown).call(setting, setting);
        } else if (setting.type === 'trigger') {
            result = (onChange as (s: unknown) => unknown).call(setting, setting);
        } else {
            return { ok: false, reason: 'unsupported-type' };
        }
        syncOverlaySetting(setting);
        if (result && typeof (result as { then?: unknown }).then === 'function') await result;
    } catch (error) {
        return { ok: false, reason: 'threw', message: String((error as { message?: unknown } | null)?.message ?? error) };
    }
    return { ok: true, state: listDebug() };
}

function openDebugMenu(): { ok: boolean } {
    try {
        (eventEmitter.emit as (name: string, ...args: unknown[]) => unknown)('POPUP_TOGGLE_DEBUG_OVERLAY', true);
        return { ok: true };
    } catch {
        return { ok: false };
    }
}

function installPlaytestApi(stage: unknown): void {
    const w = window as unknown as UnknownRecord;
    if (w.__orcaPlaytest) return;
    const counters = { begins: 0, endGames: 0, completes: 0, hooked: false, reelMoves: 0 };
    const errors: string[] = [];
    let armed = false;

    const watchReelMotion = (): void => {
        if (typeof requestAnimationFrame !== 'function') return;
        let views: UnknownRecord[] = [];
        let lookedAt = -Infinity;
        const frame = (): void => {
            try {
                const now = Date.now();
                if (now - lookedAt >= REEL_LOOKUP_MS) {
                    lookedAt = now;
                    const roots: UnknownRecord[] = [];
                    collectReelRoots(stage, roots, 0);
                    views = roots[0] ? (roots[0]._flowstateReelViews as UnknownRecord[]).slice(0, MAX_REELS) : [];
                }
                if (views.length > 0 && readReelSample(views, 0).speeds.some((s) => s > 0.01)) counters.reelMoves += 1;
            } catch {
                // A scene mid-swap reads as still.
            }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    };

    const pushError = (message: unknown): void => {
        const text = String(message ?? '').slice(0, 300);
        if (text && errors.length < MAX_ERRORS) errors.push(text);
    };

    const arm = (): { ok: boolean } => {
        if (armed) return { ok: true };
        armed = true;
        window.addEventListener('error', (event: ErrorEvent) => pushError(event.message || event.error));
        window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
            const reason = event.reason as { message?: unknown } | undefined;
            pushError(`Unhandled rejection: ${reason?.message ?? reason}`);
        });
        try {
            eventEmitter.on('GAME_BEGIN', () => { counters.begins += 1; });
            eventEmitter.on('GAME_COMPLETE', () => { counters.completes += 1; });
        } catch {
            // No emitter: rounds are judged on the reels alone.
        }
        try {
            const cabinet = (container as unknown as UnknownRecord).cabinet as UnknownRecord | undefined;
            const endGame = cabinet?.endGame;
            if (cabinet && typeof endGame === 'function') {
                cabinet.endGame = function wrappedEndGame(this: unknown, ...args: unknown[]) {
                    counters.endGames += 1;
                    return (endGame as (...a: unknown[]) => unknown).apply(this, args);
                };
                counters.hooked = true;
            }
        } catch {
            // A cabinet that cannot be wrapped: the editor falls back to reel motion.
        }
        watchReelMotion();
        return { ok: true };
    };

    const snapshot = (): PlaytestSnapshot => {
        const roots: UnknownRecord[] = [];
        try { collectReelRoots(stage, roots, 0); } catch { /* no reels */ }
        let reels: PlaytestSnapshot['reels'] = null;
        let overlaps: PlaytestOverlap[] = [];
        const root = roots[0];
        if (root) {
            const views = (root._flowstateReelViews as UnknownRecord[]).slice(0, MAX_REELS);
            const { speeds } = readReelSample(views, 0);
            const rect = reelWindow(views);
            reels = {
                name: typeof root.name === 'string' ? root.name : nodeLabel(root),
                reelCount: views.length,
                spinning: speeds.some((s) => s > 0.01),
                speeds,
                rect,
            };
            if (rect) {
                try { overlaps = collectOverlaps(stage as UnknownRecord, root, rect); } catch { overlaps = []; }
            }
        }
        return {
            v: PLAYTEST_VERSION,
            t: Date.now(),
            reels,
            spinControl: readSpinControl(),
            overlaps,
            counters: { ...counters },
            errors: errors.slice(),
        };
    };

    const spin = (): { triggered: boolean; method: string } => {
        try {
            eventEmitter.emit('GAME_BEGIN', false);
            return { triggered: true, method: 'GAME_BEGIN' };
        } catch {
            return { triggered: false, method: 'failed' };
        }
    };

    /** Emit an event on the game's emitter, as a FlowState fire node would. */
    const fire = (event: unknown, payload?: unknown): { ok: boolean } => {
        if (typeof event !== 'string' || !event) return { ok: false };
        try {
            (eventEmitter.emit as (name: string, ...args: unknown[]) => unknown)(event, payload);
            return { ok: true };
        } catch {
            return { ok: false };
        }
    };

    /** A Game model (or, with target 'settings', Settings model) property. */
    const read = (property: unknown, target?: unknown): unknown => {
        if (typeof property !== 'string' || !property) return undefined;
        try {
            const value = target === 'settings'
                ? getSettingsModelProperty(property as never)
                : getGameModelProperty(property as never);
            return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
        } catch {
            return undefined;
        }
    };

    const cabinetState = (): PlaytestCabinet => {
        const none: PlaytestCabinet = { present: false, buyEnabled: null, actionState: null, buyRect: null };
        try {
            const cabinet = (container as unknown as UnknownRecord).cabinet as UnknownRecord | undefined;
            if (!cabinet) return none;
            const view = cabinet._cabinetView as UnknownRecord | undefined;
            const button = view?.actionButton as UnknownRecord | undefined;
            const sprite = button?.buttonSprite as UnknownRecord | undefined;
            const state = typeof button?.state === 'string' ? button.state : null;
            const interactive = typeof sprite?.interactive === 'boolean' ? sprite.interactive : null;
            const action = cabinet._actionButtonState ?? cabinet.actionButtonState;
            return {
                present: true,
                buyEnabled: state === null ? null : state === 'enabled' && interactive !== false,
                actionState: typeof action === 'string' ? action : null,
                buyRect: sprite ? readBounds(sprite) : button ? readBounds(button) : null,
            };
        } catch {
            return none;
        }
    };

    /**
     * Press buy as the player does: the cabinet's own action, which checks the
     * stake and the session and sends the begin request. Nothing is pressed
     * (`ok: false` with the reason) while the cabinet would not take a buy.
     */
    const buy = (): { ok: boolean; reason?: string } => {
        try {
            const cabinet = (container as unknown as UnknownRecord).cabinet as UnknownRecord | undefined;
            const press = cabinet?.onActionButtonClick;
            if (!cabinet || typeof press !== 'function') return { ok: false, reason: 'the game has no cabinet buy action' };
            const state = cabinet._actionButtonState ?? cabinet.actionButtonState;
            if (state !== 'buy') return { ok: false, reason: `the action button is "${String(state)}", not "buy"` };
            if (cabinet._awaitingPostGameTimeout === true) return { ok: false, reason: 'the cabinet is still closing the last game' };
            if (cabinet._canProcessNextActionButtonClick === false) return { ok: false, reason: 'the cabinet is ignoring the next press' };
            (press as () => unknown).call(cabinet);
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: String((error as { message?: unknown } | null)?.message ?? error) };
        }
    };

    const debug = { list: listDebug, selectTicket: selectDebugTicket, setSetting: setDebugSetting, openMenu: openDebugMenu };
    w.__orcaPlaytest = { version: PLAYTEST_VERSION, arm, snapshot, spin, layout: readLayout, fire, read, cabinet: cabinetState, buy, debug };
}
