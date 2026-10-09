import type * as PIXI from "pixi.js";
import { gameModel } from "@/src/core/models/game-model";
import { gameSettings } from "@/src/core/models/game-settings";
import reelService from "../../reel-service";
import {
    ICoreSettings,
    IReelSettings,
    ISymbolSettings,
    SpinProfileAction,
    SpinProfileSequence,
    SpinState,
    type ICascadeSettings,
} from "@game-studio/generic-reels";
import { nodeRefId, resolveNode, type NodeRefLike, type NodeRefValue } from "./node-ref";

/**
 * Loose shape for the per-instance reel service that
 * `buildFlowstateReelsDisplay` attaches onto a Reels scene-node root as
 * `_flowstateReelService`. Matches the subset of `GCService` members used
 * by the dispatched methods below (`GCService extends GRService`, adding
 * the cascade members).
 */
type InjectedReelServiceLike = {
    model: {
        targetPosition: number[];
        /** Per-reel strip index a reel (re)starts from when its strip is replaced. */
        startPosition?: number[];
        spinComplete: boolean;
        onScreenReels: number[][];
        /** Force-display the visible symbol grid (game DisplayReels). */
        displayReels: number[][];
        spinState: number[];
        spinSpeedValues: number[];
        /** Cascade — 2D outcome (all symbols per reel). */
        cascadeOutcome: number[][];
        /** Cascade — 2D removal locations per reel. */
        cascadeLocations: number[][];
    };
    runSpinSequence: () => void;
    setSpinSequence: (endPositions: number[], startPositions?: number[]) => void;
    spinProfile: SpinProfileSequence;
    commands: { stepSpinSequence: () => void };
    eventFire?: { serviceEvent?: { ON_SPIN_COMPLETE?: () => void; ON_CASCADE_COMPLETE?: () => void } };
    /** Cascade — get/set merges a (partial) `ICascadeSettings`. */
    cascadeSettings: ICascadeSettings;
    /** Cascade — kick off the staggered removal→fall sequence. */
    runCascadeSequence: () => void;
    /** Off-screen pad symbols above / below each reel (the package defaults both to 1). */
    coreSettings?: { topOffset?: number };
};

/**
 * The package's cascade (`GCReelView.getLocationSymbols`) indexes a reel's
 * symbol ARRAY, which starts with `topOffset` off-screen pad symbols, while a
 * `runCascade` caller names the VISIBLE rows to clear (row 0 = top). Turn rows
 * into array indices; without this a clear of row r removed the symbol ABOVE
 * it (the pad, for row 0) and the cleared cell's symbol was swapped in place
 * instead of dropping in. Rows outside the reel are dropped.
 */
export function cascadeRowsToSymbolIndices(rows: number[], topOffset: number, rowCount: number): number[] {
    const pad = Number.isFinite(topOffset) && topOffset > 0 ? Math.round(topOffset) : 0;
    const out: number[] = [];
    for (const row of rows) {
        if (typeof row !== "number" || !Number.isInteger(row) || row < 0) continue;
        if (rowCount > 0 && row >= rowCount) continue;
        if (!out.includes(row + pad)) out.push(row + pad);
    }
    return out;
}

/**
 * Common `number[]` parser used by `spinReels`/`stopReels`. Accepts a
 * JSON-encoded string OR an already-parsed array (a model property wired
 * straight in). Returns `undefined` for missing/empty input or on
 * parse/shape failure (with a `[FlowState/reels]` warn naming the calling
 * method).
 */
function parsePositions(raw: unknown, caller: string): number[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    let parsed: unknown = raw;
    if (!Array.isArray(raw)) {
        const trimmed = String(raw).trim();
        if (trimmed === "") return undefined;
        try {
            parsed = JSON.parse(trimmed);
        } catch (err) {
            console.warn(`[FlowState/reels] ${caller}: failed to parse positions JSON`, raw, err);
            return undefined;
        }
    }
    if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === "number")) {
        console.warn(`[FlowState/reels] ${caller}: expected a number[] (or its JSON), got`, raw);
        return undefined;
    }
    return [...(parsed as number[])];
}

/**
 * Coerce a raw positions array into a `number[]` of length === `reelCount`
 * where each entry is a reachable index on the corresponding reel's strip.
 *
 * Strip length per reel is read from `model.onScreenReels[i].length`. The
 * editor builds these strips in `components/reels.ts` `buildInitialDisplayMap`
 * (`max(symbolCount, (rowCount + 2) * 2)`), and `GRReelView`'s
 * `_reelMapTargetIndex` (`GRReelView.ts` L526) indexes into the same
 * `onScreenReels[i]`-derived `_reelMap`. If a reel's strip length is
 * unknown (0/missing), the input is treated as already-valid for that reel.
 *
 * Out-of-range entries are wrapped via modulo and emit a single warn per
 * coercion so authors get a console signal instead of a silent infinite
 * spin (the root-cause bug pre-fix: a target index >= strip length leaves
 * `_reelMapTargetIndex` unreachable and the reel ticks forever).
 *
 * Pads with `0` and truncates to `reelCount`.
 */
function sanitisePositions(
    raw: number[] | undefined,
    reelCount: number,
    stripLengths: number[],
    caller: string,
): number[] {
    const safeReelCount = Math.max(1, reelCount);
    const out: number[] = new Array(safeReelCount).fill(0);
    for (let i = 0; i < safeReelCount; i += 1) {
        const stripLen = stripLengths[i] ?? 0;
        const rawValue = raw && i < raw.length ? raw[i] : undefined;
        if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
            out[i] = 0;
            continue;
        }
        const intValue = Math.trunc(rawValue);
        if (stripLen <= 0) {
            // No strip info — trust the caller for this reel.
            out[i] = intValue;
            continue;
        }
        if (intValue < 0 || intValue >= stripLen) {
            const wrapped = ((intValue % stripLen) + stripLen) % stripLen;
            console.warn(
                `[FlowState/reels] ${caller}: targetPosition[${i}]=${rawValue} out of range for strip length ${stripLen}, wrapping to ${wrapped}`,
            );
            out[i] = wrapped;
        } else {
            out[i] = intValue;
        }
    }
    return out;
}

/**
 * Parse a 2D number array (`number[][]`) used by `runCascade` for cascade
 * `locations`/`outcome`, and by every grid-taking node. Accepts a JSON
 * string OR an already-parsed array. Returns `undefined` for missing/empty
 * input or on parse/shape failure (with a `[FlowState/reels]` warn naming
 * the calling method + field).
 */
function parse2D(raw: unknown, caller: string, field: string): number[][] | undefined {
    if (raw === undefined || raw === null) return undefined;
    let parsed: unknown = raw;
    if (!Array.isArray(raw)) {
        const trimmed = String(raw).trim();
        if (trimmed === "") return undefined;
        try {
            parsed = JSON.parse(trimmed);
        } catch (err) {
            console.warn(`[FlowState/reels] ${caller}: failed to parse ${field} JSON`, raw, err);
            return undefined;
        }
    }
    if (
        !Array.isArray(parsed) ||
        !parsed.every((row) => Array.isArray(row) && row.every((n) => typeof n === "number"))
    ) {
        console.warn(`[FlowState/reels] ${caller}: expected a number[][] (or its JSON) for ${field}, got`, raw);
        return undefined;
    }
    return (parsed as number[][]).map((row) => row.slice());
}

// -- Completion waiters -------------------------------------------------------
// `spinReelsToGrid` / `waitForReelsToStop` / `runCascade` can BLOCK the flow
// until the reels settle. The injected service fires its completion through
// two assignable package slots (`eventFire.serviceEvent.ON_SPIN_COMPLETE` /
// `ON_CASCADE_COMPLETE`) that `components/reels.ts` already wraps to fan the
// `spinComplete` / `cascadeComplete` starters out. We COMPOSE onto the same
// slots, once per service instance, so the starters and every pending waiter
// hear the same event.

type ReelsWaiters = { spin: Array<() => void>; cascade: Array<() => void> };

const reelsWaiters = new WeakMap<object, ReelsWaiters>();

/** Longest a blocking reels node waits before giving up and continuing the flow. */
const DEFAULT_REELS_WAIT_SECONDS = 30;

/** How many symbols `spinReelsToGrid` scrolls past between the old and the new board. */
const SPIN_TO_GRID_FILLER = 12;

/** Symbols after the new board, so the package's stop blend never wraps onto it. */
const SPIN_TO_GRID_TAIL = 12;

function flushWaiters(list: Array<() => void>): void {
    const pending = list.splice(0);
    for (const finish of pending) {
        try { finish(); } catch { /* a waiter never breaks the event */ }
    }
}

function waitersFor(service: InjectedReelServiceLike): ReelsWaiters | null {
    const existing = reelsWaiters.get(service);
    if (existing) return existing;
    const events = service.eventFire?.serviceEvent;
    if (!events) return null;
    const waiters: ReelsWaiters = { spin: [], cascade: [] };
    const prevSpin = events.ON_SPIN_COMPLETE;
    events.ON_SPIN_COMPLETE = () => {
        if (typeof prevSpin === "function") prevSpin();
        flushWaiters(waiters.spin);
    };
    const prevCascade = events.ON_CASCADE_COMPLETE;
    events.ON_CASCADE_COMPLETE = () => {
        if (typeof prevCascade === "function") prevCascade();
        flushWaiters(waiters.cascade);
    };
    reelsWaiters.set(service, waiters);
    return waiters;
}

/** Resolves on the next completion in `list`, or after the timeout (with a warn). */
function waitForCompletion(list: Array<() => void> | undefined, timeoutSeconds: unknown, label: string): Promise<void> {
    if (!list) return Promise.resolve();
    const seconds = typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
        ? timeoutSeconds
        : DEFAULT_REELS_WAIT_SECONDS;
    return new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            const index = list.indexOf(finish);
            if (index !== -1) list.splice(index, 1);
            resolve();
        };
        timer = setTimeout(() => {
            console.warn(`[FlowState/reels] ${label}: gave up waiting after ${seconds}s, continuing the flow`);
            finish();
        }, seconds * 1000);
        list.push(finish);
    });
}

/** Is any reel of this service still moving? */
function isServiceSpinning(service: InjectedReelServiceLike): boolean {
    if (service.model.spinComplete === true) return false;
    const states = service.model.spinState;
    return Array.isArray(states) && states.some((state) => typeof state === "number" && state > 0);
}

/** A random run of `count` symbols drawn from `pool` - the scenery a reel scrolls past. */
function fillerRun(pool: number[], count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) out.push(pool[Math.floor(Math.random() * pool.length)]);
    return out;
}

/**
 * Loose shape for the per-symbol view (`FlowstateInjectedSymbolView extends
 * GCSymbolView`) that `buildFlowstateReelsDisplay` builds for every visible
 * cell. Typed structurally — same convention as `InjectedReelServiceLike` —
 * so this module never imports the component's private view classes.
 */
type ReelSymbolViewLike = {
    /** `skin` is the NUMBER index into the node's `symbolEntries[]` (NOT a
     *  spine skin string). */
    symbolData?: { skin?: number } | null;
    setSymbolIndex: (index: number) => void;
    playSymbolAnimation: (animationName?: string, loop?: boolean) => boolean;
    stopSymbolAnimation: () => void;
    applyVisualOverride: (o: { alpha?: number; tint?: number; scale?: number; visible?: boolean }) => void;
    clearVisualOverride: () => void;
    /** Symbol texts — absent on a component injected before the feature. */
    encodedSkin?: () => number;
    getCellText?: (slot: number) => string;
    setCellText?: (slot: number, text: string) => void;
    setCellTexts?: (texts: readonly string[]) => void;
};

/**
 * Loose shape for the component's `ReelsSymbolTextState` (the Reels node's
 * `symbolTexts` slots and the virtual-skin table that carries a text on a
 * strip entry).
 */
type SymbolTextStateLike = {
    readonly slotCount: number;
    encode: (symbol: number, texts: readonly string[] | null | undefined) => number;
    encodeFiller: (symbol: number) => number;
    resetTable: () => void;
    stage: (reel: number, row: number, slot: number, text: string) => void;
    stagedAt: (reel: number, row: number) => string[] | null;
    clearStaged: () => void;
};

/**
 * Loose shape for the per-reel view (`FlowstateInjectedReelView extends
 * GCReelView`). Only the package members the dispatched methods read are
 * declared, all optional so a package version lacking one degrades to the
 * documented fallback instead of throwing.
 */
type ReelViewLike = {
    reelIndex?: number;
    reelSize?: number;
    /** LIVE scroll speed (package getter) — not the configured speed limit
     *  held in `model.spinSpeedValues`. */
    speed?: number;
    isSpinning?: boolean;
    symbols?: ReelSymbolViewLike[];
};

type ReelsRootLike = PIXI.Container & {
    _flowstateReelService?: InjectedReelServiceLike;
    /** Cascade settings authored on the Reels node, exposed by
     *  `buildFlowstateReelsDisplay` for `runCascade` to (re)apply. */
    _flowstateReelsCascadeSettings?: Partial<ICascadeSettings>;
    /** Per-reel views, in reel order. Same array the component's refresh /
     *  spin-blur paths use. */
    _flowstateReelViews?: ReelViewLike[];
    /** Authored grid dimensions — the bounds every index is validated
     *  against. */
    _flowstateReelsGridSize?: { reelCount: number; rowCount: number };
    /** Nearest-Y VISIBLE-cell lookup. The strip SCROLLS, so
     *  `reelView.symbols[rowIndex]` is NOT the visible row. Returns `null`
     *  for an out-of-range index or when no symbol sits within tolerance. */
    _flowstateResolveSymbolCell?: (reelIndex: number, rowIndex: number) => ReelSymbolViewLike | null;
    /** Re-point the node's symbol draw-order (zIndex) table and refresh every
     *  visible cell. Absent on a scene built before draw-order was runtime
     *  mutable. */
    _flowstateSetSymbolDrawOrder?: (order: number[]) => void;
    /** AUTHORED symbol count — the permutation length `setSymbolDrawOrder`
     *  validates against (NOT the padded runtime entry count). */
    _flowstateAuthoredSymbolCount?: number;
    /** Symbol-text slots (absent when the node has none, or on an older build). */
    _flowstateSymbolTexts?: SymbolTextStateLike;
};

/** The node's symbol-text state when it has at least one slot, else null. */
function symbolTextsOf(root: ReelsRootLike): SymbolTextStateLike | null {
    const state = root._flowstateSymbolTexts;
    return state && state.slotCount > 0 ? state : null;
}

const warnedNoSymbolTexts = new WeakSet<object>();

function symbolTextsOrWarn(root: ReelsRootLike, caller: string): SymbolTextStateLike | null {
    const state = symbolTextsOf(root);
    if (!state && !warnedNoSymbolTexts.has(root)) {
        warnedNoSymbolTexts.add(root);
        console.warn(`[FlowState/reels] ${caller}: this Reels node has no symbol texts — turn on Symbol Texts in its Advanced Settings (and save the scene)`);
    }
    return state;
}

function textSlotOrWarn(textIndex: unknown, texts: SymbolTextStateLike, caller: string): number | null {
    const slot = Math.trunc(Number(textIndex));
    if (!Number.isFinite(slot) || slot < 0 || slot >= texts.slotCount) {
        console.warn(`[FlowState/reels] ${caller}: textIndex=${String(textIndex)} is not a symbol text (0..${texts.slotCount - 1})`);
        return null;
    }
    return slot;
}

/**
 * A reference to part of a Reels node (`cell:<reel>:<row>` or
 * `text:<reel>:<row>:<slot>`), accepted by every node that takes a scene-node
 * `target`. The scene manager resolves it live, so it names whatever sits in
 * that cell when it is used.
 */
function reelsSubNodeRef(target: NodeRefLike, key: string): NodeRefValue | null {
    const id = nodeRefId(target);
    if (!id) return null;
    const base = target && typeof target === "object" && (target as NodeRefValue).kind === "nodeRef" ? (target as NodeRefValue) : undefined;
    return {
        kind: "nodeRef",
        nodeId: `${id}::${key}`,
        ...(base?.sceneScope ? { sceneScope: base.sceneScope } : {}),
        ...(base?.sceneSkin ? { sceneSkin: base.sceneSkin } : {}),
        ...(base?.sceneName ? { sceneName: base.sceneName } : {}),
    };
}

/**
 * Build a per-reel speed array of length `reelCount` from the service's
 * currently-selected `spinProfile`. Mirrors the package's private
 * `GRService.getReelSpeedsForCurrentSpin` (`GRService.ts` L148) so
 * `startSpinOnly` can populate `model.spinSpeedValues` without invoking
 * `runSpinSequence` (which would gsap-schedule a stop).
 *
 * Source priority for the per-reel speed value:
 *   1. `spinProfile.sequence[0].reelSpeed` as a `number[]` (per-reel).
 *   2. `spinProfile.sequence[0].reelSpeed` as an `IReelSpeedConfig`
 *      (`{ speed, overrides? }`) — fills with `speed`, then applies
 *      1-indexed `overrides`.
 *   3. `spinProfile.sequence[0].reelSpeed` as a `number` (uniform).
 *   4. Package default `45` (`SpinProfileAction(i, 45, 0.15)` registered
 *      per reel in `GRService.registerReel` — `GRService.ts` L99).
 */
function resolveDefaultReelSpeeds(service: InjectedReelServiceLike, reelCount: number): number[] {
    const DEFAULT_REEL_SPEED = 45; // package default, see GRService.ts L99
    try {
        const first = service.spinProfile?.sequence?.[0];
        const cfg = first?.reelSpeed;
        if (typeof cfg === "number" && Number.isFinite(cfg)) {
            return new Array(reelCount).fill(cfg);
        }
        if (Array.isArray(cfg)) {
            const out = new Array<number>(reelCount).fill(DEFAULT_REEL_SPEED);
            for (let i = 0; i < reelCount; i += 1) {
                const v = cfg[i];
                if (typeof v === "number" && Number.isFinite(v)) out[i] = v;
            }
            return out;
        }
        if (cfg && typeof cfg === "object" && "speed" in (cfg as unknown as Record<string, unknown>)) {
            const config = cfg as { speed: number; overrides?: Record<string, number> };
            const globalSpeed = typeof config.speed === "number" ? config.speed : DEFAULT_REEL_SPEED;
            const out = new Array<number>(reelCount).fill(globalSpeed);
            if (config.overrides) {
                for (const [key, speed] of Object.entries(config.overrides)) {
                    const idx = parseInt(key, 10) - 1; // 1-indexed in package
                    if (idx >= 0 && idx < reelCount && typeof speed === "number") {
                        out[idx] = speed;
                    }
                }
            }
            return out;
        }
    } catch (err) {
        console.warn(`[FlowState/reels] resolveDefaultReelSpeeds: falling back to default ${DEFAULT_REEL_SPEED}`, err);
    }
    return new Array(reelCount).fill(DEFAULT_REEL_SPEED);
}

/**
 * Normalise an authored `stopReel` (1-indexed). Scalars are rounded and
 * clamped to `>= 1`; arrays are filtered to finite entries and normalised
 * the same way. Returns `null` when nothing usable remains.
 *
 * Mirrors `normalizeStopReel` in `components/reels.ts` — kept local on
 * purpose, since that component is overwritten per-project by the reels
 * injection template.
 */
function normalizeStopReel(value: number | number[] | undefined): number | number[] | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(1, Math.round(value));
    }

    if (Array.isArray(value)) {
        const normalized = value
            .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
            .map((entry) => Math.max(1, Math.round(entry)));
        return normalized.length > 0 ? normalized : null;
    }

    return null;
}

/**
 * Normalise an authored `reelSpeed`: a uniform `number`, a per-reel
 * `number[]`, or an `{ speed, overrides }` config whose override keys are
 * 1-indexed reel numbers. Returns `null` when nothing usable remains.
 *
 * Mirrors `normalizeReelSpeed` in `components/reels.ts` (kept local — see
 * {@link normalizeStopReel}).
 */
function normalizeReelSpeed(
    value: unknown,
): number | number[] | { speed: number; overrides?: Record<number, number> } | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (Array.isArray(value)) {
        const normalized = value.filter(
            (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
        );
        return normalized.length > 0 ? normalized : null;
    }

    if (value && typeof value === "object") {
        const source = value as { speed?: unknown; overrides?: unknown };
        if (typeof source.speed !== "number" || !Number.isFinite(source.speed)) {
            return null;
        }

        const result: { speed: number; overrides?: Record<number, number> } = { speed: source.speed };

        if (source.overrides && typeof source.overrides === "object") {
            const entries = Object.entries(source.overrides as Record<string, unknown>)
                .filter(
                    ([key, entryValue]) =>
                        Number.isFinite(Number(key)) && typeof entryValue === "number" && Number.isFinite(entryValue),
                )
                .map(([key, entryValue]) => [Number(key), entryValue] as [number, number]);
            if (entries.length > 0) {
                const overrides: Record<number, number> = {};
                entries.forEach(([key, entryValue]) => {
                    overrides[key] = entryValue;
                });
                result.overrides = overrides;
            }
        }

        return result;
    }

    return null;
}

/** Resolved `reelSpeed` shape accepted by `SpinProfileAction` (`IReelSpeedConfig`). */
type ReelSpeedValue = number | number[] | { speed: number; overrides?: Record<number, number> };

/** A single spin-profile step, in the units `SpinProfileAction` wants (delay in SECONDS). */
type SpinProfileStep = { stopReel: number | number[]; reelSpeed: ReelSpeedValue; delaySeconds: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Was one optional `setSpinProfile` patch field supplied at all? Only
 * `undefined`/`null`/a blank STRING count as omitted — a supplied number
 * (including `0`), array or object is always a real value.
 */
function isPatchFieldSupplied(raw: unknown): boolean {
    if (raw === undefined || raw === null) return false;
    if (typeof raw === "string") return raw.trim() !== "";
    return true;
}

/**
 * Resolve a supplied patch field to its parsed value: a string is JSON-parsed,
 * an already-parsed number/array/object is used verbatim. Returns `null` (with
 * a warn) on failure so the caller can no-op the WHOLE call rather than
 * half-applying.
 */
function resolvePatchField(raw: unknown, field: string): { value: unknown } | null {
    if (typeof raw === "string") {
        try {
            return { value: JSON.parse(raw.trim()) };
        } catch (err) {
            console.warn(`[FlowState/reels] setSpinProfile: failed to parse ${field} JSON`, raw, err);
            return null;
        }
    }
    if (typeof raw === "number" || Array.isArray(raw) || isPlainObject(raw)) return { value: raw };
    console.warn(`[FlowState/reels] setSpinProfile: unusable ${field} value`, raw);
    return null;
}

/**
 * Per-step is opt-in by NESTING: an array whose EVERY element is itself an
 * array (or, where `allowObjectSteps`, a plain object) is one value per step —
 * so a flat `[1,2,3]` still means "this value on every step".
 */
function isPerStepArray(value: unknown, allowObjectSteps: boolean): boolean {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((entry) => Array.isArray(entry) || (allowObjectSteps && isPlainObject(entry)))
    );
}

/**
 * Expand a supplied `stopReel`/`reelSpeed` patch into one entry per step.
 * A per-step array shorter than the sequence leaves the trailing steps
 * `undefined` (= keep current); entries beyond `stepCount` are ignored.
 */
function distributeAcrossSteps(value: unknown, allowObjectSteps: boolean, stepCount: number): unknown[] {
    const out = new Array<unknown>(stepCount).fill(undefined);
    if (!isPerStepArray(value, allowObjectSteps)) return out.fill(value);
    const perStep = value as unknown[];
    for (let i = 0; i < Math.min(stepCount, perStep.length); i += 1) out[i] = perStep[i];
    return out;
}

/**
 * Expand a supplied `delay` patch (natively scalar, MILLISECONDS) into one
 * SECONDS value per step: a number applies to every step, a number array is
 * one delay per step by index. Returns `null` (with a warn) for an unusable
 * shape so the caller no-ops the whole call.
 */
function distributeDelayAcrossSteps(value: unknown, stepCount: number): (number | undefined)[] | null {
    const toSeconds = (ms: number): number => Math.max(0, ms) / 1000;
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Array<number | undefined>(stepCount).fill(toSeconds(value));
    }
    if (Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number" && Number.isFinite(n))) {
        const out = new Array<number | undefined>(stepCount).fill(undefined);
        for (let i = 0; i < Math.min(stepCount, value.length); i += 1) out[i] = toSeconds(value[i] as number);
        return out;
    }
    console.warn(`[FlowState/reels] setSpinProfile: expected delay to be a number or number[], got`, value);
    return null;
}

function getService(target: NodeRefLike): InjectedReelServiceLike | null {
    const obj = resolveNode<ReelsRootLike>(target);
    if (!obj) return null;
    const service = (obj as ReelsRootLike)._flowstateReelService;
    if (!service) {
        console.warn(`[FlowState/reels] target node is not a Reels container (missing _flowstateReelService)`);
        return null;
    }
    return service;
}

/**
 * Sibling of {@link getService} that resolves the reels ROOT container
 * itself, so the per-reel / per-symbol methods can reach the handles
 * `buildFlowstateReelsDisplay` attaches alongside `_flowstateReelService`
 * (`_flowstateReelViews`, `_flowstateReelsGridSize`,
 * `_flowstateResolveSymbolCell`). Warns (naming the caller) and returns
 * `null` when the target is missing or is not a Reels node.
 */
function getReelsRoot(target: NodeRefLike, caller: string): ReelsRootLike | null {
    const root = resolveNode<ReelsRootLike>(target);
    if (!root) {
        console.warn(`[FlowState/reels] ${caller}: target did not resolve to a scene node`);
        return null;
    }
    if (!root._flowstateReelService) {
        console.warn(
            `[FlowState/reels] ${caller}: target node is not a Reels container (missing _flowstateReelService)`,
        );
        return null;
    }
    return root;
}

/**
 * Read the authored grid dimensions off the reels root. Missing means the
 * node was built by an older component build (pre per-reel handles) — warn
 * and let the caller no-op rather than guessing a shape.
 */
function getGridSize(root: ReelsRootLike, caller: string): { reelCount: number; rowCount: number } | null {
    const grid = root._flowstateReelsGridSize;
    if (
        !grid ||
        typeof grid.reelCount !== "number" ||
        typeof grid.rowCount !== "number" ||
        grid.reelCount <= 0 ||
        grid.rowCount <= 0
    ) {
        console.warn(
            `[FlowState/reels] ${caller}: Reels node exposes no grid size (_flowstateReelsGridSize) — rebuild the scene`,
        );
        return null;
    }
    return { reelCount: grid.reelCount, rowCount: grid.rowCount };
}

/**
 * Expand the shared `-1` wildcard index convention into a concrete index
 * list: `-1` → every index in `[0, count)`, any other value → a single
 * validated index. Returns `null` (with a warn naming the caller + field)
 * for a non-finite or out-of-range value so the caller can no-op.
 */
function expandIndexWildcard(value: number, count: number, field: string, caller: string): number[] | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        console.warn(`[FlowState/reels] ${caller}: ${field} must be a number, got`, value);
        return null;
    }
    const index = Math.trunc(value);
    if (index === -1) return Array.from({ length: count }, (_, i) => i);
    if (index < 0 || index >= count) {
        console.warn(`[FlowState/reels] ${caller}: ${field}=${value} out of range (0..${count - 1}, or -1 for all)`);
        return null;
    }
    return [index];
}

/**
 * Resolve every VISIBLE symbol view addressed by a (`reelIndex`, `rowIndex`)
 * pair, honouring the `-1` wildcard on either axis. Delegates the actual
 * cell lookup to the component's `_flowstateResolveSymbolCell` (nearest-Y
 * against the scrolling strip). Cells that don't currently resolve to a
 * visible symbol are skipped; an empty result warns once.
 */
function resolveSymbolCells(
    root: ReelsRootLike,
    reelIndex: number,
    rowIndex: number,
    caller: string,
): ReelSymbolViewLike[] {
    const grid = getGridSize(root, caller);
    if (!grid) return [];
    const resolveCell = root._flowstateResolveSymbolCell;
    if (typeof resolveCell !== "function") {
        console.warn(
            `[FlowState/reels] ${caller}: Reels node exposes no cell resolver (_flowstateResolveSymbolCell) — rebuild the scene`,
        );
        return [];
    }
    const reelIndices = expandIndexWildcard(reelIndex, grid.reelCount, "reelIndex", caller);
    const rowIndices = expandIndexWildcard(rowIndex, grid.rowCount, "rowIndex", caller);
    if (!reelIndices || !rowIndices) return [];

    const views: ReelSymbolViewLike[] = [];
    for (const reel of reelIndices) {
        for (const row of rowIndices) {
            let view: ReelSymbolViewLike | null = null;
            try {
                view = resolveCell(reel, row);
            } catch (err) {
                console.warn(`[FlowState/reels] ${caller}: cell resolve failed for [${reel}][${row}]`, err);
            }
            if (view) views.push(view);
        }
    }
    if (views.length === 0) {
        console.warn(
            `[FlowState/reels] ${caller}: no visible symbol resolved for reelIndex=${reelIndex}, rowIndex=${rowIndex}`,
        );
    }
    return views;
}

/**
 * Fetch a single per-reel view by index. Returns `null` (silently — callers
 * warn with their own context) when the handle is missing or the index is
 * out of range.
 */
function getReelView(root: ReelsRootLike, reelIndex: number): ReelViewLike | null {
    const views = root._flowstateReelViews;
    if (!Array.isArray(views)) return null;
    if (typeof reelIndex !== "number" || !Number.isFinite(reelIndex)) return null;
    const index = Math.trunc(reelIndex);
    if (index < 0 || index >= views.length) return null;
    return views[index] ?? null;
}

/**
 * Live "is this reel moving?" probe. Prefers the reel VIEW's `isSpinning`
 * getter (view-level truth, still true while a landed reel settles through
 * its elastic bounce) and falls back to the model's `SpinState` entry
 * (`> 0` === not STOPPED, matching the package enum).
 */
function isReelViewSpinning(root: ReelsRootLike, service: InjectedReelServiceLike | undefined, index: number): boolean {
    const view = getReelView(root, index);
    if (view && typeof view.isSpinning === "boolean") return view.isSpinning;
    const state = service?.model?.spinState;
    if (Array.isArray(state) && typeof state[index] === "number") return state[index] > 0;
    return false;
}

/**
 * Generic Reels Methods for FlowState
 * 
 * Controls slot machine reels including spinning, stopping, symbol display,
 * and spin profiles. These methods interface with the game-studio/generic-reels
 * package.
 * 
 * Key concepts:
 * - **Spin Sequence**: The animation of reels spinning and stopping
 * - **Target Positions**: Where each reel should stop (symbol index)
 * - **Spin Profile**: Configuration for spin speed, acceleration, etc.
 * - **On-Screen Reels**: The symbol data currently visible
 */
export class GenericReelsMethods {
    // =====================
    // Spin Control
    // =====================

    /**
     * Spin the reels and land them on an exact board.
     *
     * An engine often answers with the SYMBOLS a spin shows (`grid[reel][row]`)
     * rather than stop positions on a fixed strip. This builds a fresh strip per
     * reel - the board on screen now, a run of filler symbols, the target board
     * and a tail - resets every reel to the start of it (so nothing visibly
     * jumps) and spins to the target window with the node's own spin profile.
     * Works after a cascade too: the "board on screen now" is read off the
     * visible symbols.
     *
     * @param target - NodeRef to a Reels scene node
     * @param grid - The board to land on, `number[][]` `[reel][row]` (or its JSON)
     * @param fillerSymbols - Optional `number[]` (or JSON) of symbols to scroll past; defaults to the symbols of both boards
     * @param sequenceNodeOn - `"immediate"` (default) or `"onComplete"` to wait until every reel has landed
     */
    public spinReelsToGrid(target: NodeRefLike, grid: unknown, fillerSymbols?: unknown, sequenceNodeOn?: string): Promise<void> {
        const root = getReelsRoot(target, "spinReelsToGrid");
        if (!root) return Promise.resolve();
        const service = root._flowstateReelService as InjectedReelServiceLike;
        const size = getGridSize(root, "spinReelsToGrid");
        if (!size) return Promise.resolve();
        const board = parse2D(grid, "spinReelsToGrid", "grid");
        if (!board) return Promise.resolve();

        const { reelCount, rowCount } = size;
        const resolveCell = root._flowstateResolveSymbolCell;
        // Symbol texts ride their strip entries as virtual skins: the board
        // on screen keeps its texts while it scrolls away, the new board gets
        // the texts staged with `setLandingSymbolText`.
        const texts = symbolTextsOf(root);
        if (texts) texts.resetTable();
        const current: number[][] = [];
        const currentStrip: number[][] = [];
        const wanted: number[][] = [];
        for (let reel = 0; reel < reelCount; reel += 1) {
            const want: number[] = [];
            const now: number[] = [];
            const nowStrip: number[] = [];
            for (let row = 0; row < rowCount; row += 1) {
                const value = board[reel]?.[row];
                want.push(typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
                let skin: number | undefined;
                let encoded: number | undefined;
                try {
                    const view = typeof resolveCell === "function" ? resolveCell(reel, row) : null;
                    skin = view?.symbolData?.skin ?? undefined;
                    if (texts && typeof view?.encodedSkin === "function") encoded = view.encodedSkin();
                } catch { /* fall back to the target symbol */ }
                const base = typeof skin === "number" && Number.isFinite(skin) ? skin : want[row];
                now.push(base);
                nowStrip.push(typeof encoded === "number" && Number.isFinite(encoded) ? encoded : base);
            }
            wanted.push(want);
            current.push(now);
            currentStrip.push(nowStrip);
        }

        const explicitPool = parsePositions(fillerSymbols, "spinReelsToGrid");
        const pool = explicitPool && explicitPool.length > 0
            ? explicitPool.map((n) => Math.max(0, Math.trunc(n)))
            : [...new Set(([] as number[]).concat(...wanted, ...current))];
        const filler = (count: number): number[] => {
            const run = fillerRun(pool, count);
            return texts ? run.map((symbol) => texts.encodeFiller(symbol)) : run;
        };

        const strips: number[][] = [];
        const stops: number[] = [];
        for (let reel = 0; reel < reelCount; reel += 1) {
            const landing = texts
                ? wanted[reel].map((symbol, row) => texts.encode(symbol, texts.stagedAt(reel, row)))
                : wanted[reel];
            strips.push([
                ...currentStrip[reel],
                ...filler(SPIN_TO_GRID_FILLER),
                ...landing,
                ...filler(SPIN_TO_GRID_TAIL),
            ]);
            stops.push(rowCount + SPIN_TO_GRID_FILLER);
        }
        if (texts) texts.clearStaged();

        // Start every reel at the top of its new strip - which IS the board on
        // screen - then spin to the target window. The explicit re-apply covers
        // a strip identical to the previous one, which the package skips.
        const starts = new Array<number>(reelCount).fill(0);
        service.model.startPosition = starts;
        service.model.onScreenReels = strips;
        for (const view of root._flowstateReelViews ?? []) {
            try { (view as { forceApplyStartPositionChange?: () => void }).forceApplyStartPositionChange?.(); } catch { /* ignore */ }
        }

        const done = sequenceNodeOn === "onComplete"
            ? waitForCompletion(waitersFor(service)?.spin, DEFAULT_REELS_WAIT_SECONDS, "spinReelsToGrid")
            : Promise.resolve();
        service.setSpinSequence(stops, starts);
        service.model.spinComplete = false;
        // The strip above already starts with the board on screen, so the
        // package's snapshot (which re-reads plain symbols) would only strip
        // their texts. It is taken synchronously when the reels start.
        const core = texts ? (service as unknown as { coreSettings?: { snapshotInjection?: boolean } }).coreSettings : undefined;
        const snapshot = core?.snapshotInjection;
        if (core) core.snapshotInjection = false;
        try {
            service.runSpinSequence();
        } finally {
            if (core) core.snapshotInjection = snapshot;
        }
        return done;
    }

    /**
     * Hold the flow until every reel of the target has landed (the moment the
     * `spinComplete` starter fires). Continues at once when nothing is spinning,
     * and after `timeoutSeconds` regardless, so a flow can never hang here.
     *
     * @param target - NodeRef to a Reels scene node
     * @param timeoutSeconds - Give up after this long (default 30)
     */
    public waitForReelsToStop(target: NodeRefLike, timeoutSeconds?: number): Promise<void> {
        const service = getService(target);
        if (!service || !isServiceSpinning(service)) return Promise.resolve();
        return waitForCompletion(waitersFor(service)?.spin, timeoutSeconds, "waitForReelsToStop");
    }

    /**
     * Start the reel spin sequence on the targeted Reels scene node.
     *
     * Two modes, selected by the `mode` arg:
     *
     * - `"fullSequence"` (default, back-compat for older graphs where this
     *   arg is omitted): if `endPositions` is provided (as a JSON-encoded
     *   `number[]` string), the sequence is configured via
     *   `service.setSpinSequence(end, start?)` before starting. Otherwise,
     *   falls back to `gameModel.reelStoppingPositions`. Then runs the
     *   currently-configured `spinProfile` to completion, stopping reels
     *   at the target positions.
     *
     * - `"startSpinOnly"`: starts a continuous / indefinite spin. Reels
     *   keep spinning until `stopReels(target, endPositions)` is called.
     *   No target positions are scheduled here.
     *
     * @param target - NodeRef to a Reels scene node
     * @param mode - `"fullSequence"` (default) or `"startSpinOnly"`
     * @param endPositions - Optional JSON string encoding `number[]` of stop positions (fullSequence only)
     * @param startPositions - Optional JSON string encoding `number[]` of start positions (fullSequence only)
     */
    public spinReels(
        target: NodeRefLike,
        mode?: string,
        endPositions?: string,
        startPositions?: string,
    ): void {
        const service = getService(target);
        if (!service) return;

        // Canonical reel count = number of registered/dummy-populated reels
        // on `model.onScreenReels` (each `registerReel` push grows this
        // array, and `_registeredReels.length` always tracks it). This
        // must match the `spinState` array length the package expects.
        const reelCount = service.model.onScreenReels.length || 1;
        const stripLengths = service.model.onScreenReels.map((s) => (Array.isArray(s) ? s.length : 0));

        if (mode === "startSpinOnly") {
            // CLEAN primitive: writing `model.spinState` triggers
            // `GRModel.spinState`'s setter → `invalidate()` → each
            // `GRReelView.onSpinState$` listener (`GRReelView.ts` L516),
            // which calls `beginReelSpin()` for any reel transitioning
            // STOPPED→SPINNING. BUT spin-state alone does not move the
            // reels: per-tick scroll is driven by `_speedControl.speedLimit`,
            // which `GRReelView.onReelSpeedLimit$` (`GRReelView.ts` L531)
            // reads from `model.spinSpeedValues[reelIndex]`. `_spinSpeedValues`
            // defaults to `[]` (`GRModel.ts` L18), so without populating it
            // the reels enter SPINNING state but scroll 0 px/tick (frozen).
            // `runSpinSequence` sets it via `getReelSpeedsForCurrentSpin()`
            // (`GRService.ts` L47); that method is private, so we mirror
            // its behaviour using the public `service.spinProfile` (first
            // action's `reelSpeed`: `number | number[] | IReelSpeedConfig`).
            // No gsap, no profile install, no scheduled stop — reels
            // scroll forever until `stopReels` writes STOPPED.
            const speeds = resolveDefaultReelSpeeds(service, reelCount);
            service.model.spinComplete = false;
            service.model.spinSpeedValues = speeds;
            service.model.spinState = new Array(reelCount).fill(SpinState.SPINNING);
            return;
        }

        // fullSequence (default / undefined / unknown mode → back-compat).
        const parsedEnd = parsePositions(endPositions, "spinReels");
        const parsedStart = parsePositions(startPositions, "spinReels");

        // Fallback chain: explicit endPositions → gameModel default → zeros.
        // Zeros are always a reachable index on any non-empty strip.
        const rawEnd =
            parsedEnd ??
            (Array.isArray(gameModel.reelStoppingPositions) && gameModel.reelStoppingPositions.length > 0
                ? [...gameModel.reelStoppingPositions]
                : undefined);
        const sanitisedEnd = sanitisePositions(rawEnd, reelCount, stripLengths, "spinReels");
        const sanitisedStart = parsedStart
            ? sanitisePositions(parsedStart, reelCount, stripLengths, "spinReels")
            : undefined;

        // Configure targets and let the package's default staggered profile
        // (built lazily by `registerReel` — one `SpinProfileAction(i, 45, 0.15)`
        // per registered reel, see `GRService.ts` L99) drive the natural
        // stop. The `FlowstateInjectedReelView` constructor (extends
        // `GRReelView`) calls `service.commands.registerReel(reelIndex)`
        // for every reel built in `buildFlowstateReelsDisplay`, so the
        // default profile reliably covers every reel. Authored
        // `spinProfileActions` (when present) replace the default via
        // `buildSpinProfileSequence` at build time.
        service.setSpinSequence(sanitisedEnd, sanitisedStart);
        service.model.spinComplete = false;
        service.runSpinSequence();
    }

    /**
     * Stop a Reels scene node at the supplied `endPositions`.
     *
     * Counterpart to `spinReels(target, "startSpinOnly")`. Safe to call
     * regardless of whether the reels are mid-spin, idle, or in
     * `startSpinOnly`-perpetual mode.
     *
     * Out-of-range targets are wrapped against the per-reel strip
     * length (`model.onScreenReels[i].length`) with a console warn —
     * unreachable targets were the root-cause spins-forever bug. If
     * `endPositions` is missing/invalid, falls back to
     * `gameModel.reelStoppingPositions` (with a `[FlowState/reels]` warn),
     * then to zeros.
     *
     * Why this drives the stop through `runSpinSequence` and NOT by
     * directly flipping `model.spinState` to STOPPED:
     *
     *   When a `GRReelView` lands at its `_reelMapTargetIndex` it calls
     *   `service.commands.stepSpinSequence()` (`GRReelView.ts` L359).
     *   `GRService.stepSpinSequence` (`GRService.ts` L70) does:
     *     this._spinSequenceProgress++;
     *     if (progress === _currentSpinProfile.length) sequenceComplete();
     *     else const action = _currentSpinProfile[progress]; action.stopReel ...
     *   There is NO guard against `_currentSpinProfile` being empty or
     *   `progress` overshooting beyond `length`. A direct-write stop
     *   never populates `_currentSpinProfile`, so the first reel to
     *   land increments progress from 0 → 1, sees `1 !== 0`, indexes
     *   into `[]`, and crashes with `Cannot read properties of
     *   undefined (reading 'stopReel')` on the shared `PIXI.Ticker`.
     *
     * Fix: temporarily install a stop-now `SpinProfileSequence` of
     * shape `[ SpinProfileAction([1..reelCount], speeds, 0) ]`, then
     * call `setSpinSequence(targets)` + `runSpinSequence()`. The
     * package's `formatSequence` (`GRService.ts` L132) expands the
     * array-`stopReel` action into 1 real action + `(reelCount - 1)`
     * dummies (`stopReel === -1`), so `_currentSpinProfile.length ===
     * reelCount` — exactly one increment per landing reel. The first
     * `executeCurrentSequenceAction` tick writes `spinState[i] =
     * STOPPED` for every reel simultaneously (natural shape for an
     * emergency stop after `startSpinOnly`); each subsequent landing
     * marches `stepSpinSequence` through the dummy entries (each early-
     * returns on `stopReel === -1`); after the Nth landing `progress
     * === length` and `sequenceComplete()` fires `ON_SPIN_COMPLETE`.
     *
     * The previous live `spinProfile` is restored synchronously after
     * `runSpinSequence()` returns — by that point `_currentSpinProfile`
     * has been snapshotted internally, so the restore does not affect
     * the in-flight stop cycle but leaves the authored profile intact
     * for the next `spinReels("fullSequence")` call.
     *
     * `startSpinOnly` → `stopReels` handoff: `startSpinOnly` writes
     * `spinState = SPINNING` directly and does NOT populate
     * `_currentSpinProfile`. While reels are spinning,
     * `GRReelView.movementUpdate` only calls `stepSpinSequence` at the
     * moment a reel transitions to STOPPED (`GRReelView.ts` L359),
     * never mid-SPINNING — so the empty profile during perpetual spin
     * is harmless. When `stopReels` runs, `runSpinSequence` freshly
     * sets `_currentSpinProfile = formatSequence(stopProfile.sequence)`
     * and resets `_spinSequenceProgress = 0` BEFORE any reel lands, so
     * the handoff is safe.
     *
     * @param target - NodeRef to a Reels scene node
     * @param endPositions - JSON string encoding `number[]` of stop positions
     */
    public stopReels(target: NodeRefLike, endPositions?: string): void {
        const service = getService(target);
        if (!service) return;

        const reelCount = service.model.onScreenReels.length || 1;
        const stripLengths = service.model.onScreenReels.map((s) => (Array.isArray(s) ? s.length : 0));

        const parsedEnd = parsePositions(endPositions, "stopReels");
        if (!parsedEnd) {
            console.warn(
                `[FlowState/reels] stopReels: no valid endPositions supplied, falling back to gameModel.reelStoppingPositions`,
            );
        }
        const rawEnd =
            parsedEnd ??
            (Array.isArray(gameModel.reelStoppingPositions) && gameModel.reelStoppingPositions.length > 0
                ? [...gameModel.reelStoppingPositions]
                : undefined);
        const sanitisedEnd = sanitisePositions(rawEnd, reelCount, stripLengths, "stopReels");

        // Build a stop-now profile: a single action that stops every
        // reel simultaneously. `formatSequence` expands the array-stopReel
        // entry into `reelCount` total entries (1 real + N-1 dummies),
        // matching the number of `stepSpinSequence` calls the package
        // will make as each reel lands.
        const speeds = resolveDefaultReelSpeeds(service, reelCount);
        const stopReelIndices = Array.from({ length: reelCount }, (_, i) => i + 1);
        const stopProfile = new SpinProfileSequence([
            new SpinProfileAction(stopReelIndices, speeds, 0),
        ]);

        const prevProfile = service.spinProfile;
        service.spinProfile = stopProfile;
        try {
            service.setSpinSequence(sanitisedEnd);
            service.model.spinComplete = false;
            service.runSpinSequence();
        } finally {
            // runSpinSequence has already snapshotted `_currentSpinProfile`
            // from `stopProfile.sequence`, so restoring the previous
            // `spinProfile` here does not affect the in-flight stop cycle.
            service.spinProfile = prevProfile;
        }
    }

    /**
     * Run a cascade (tumble) sequence on the targeted Reels scene node.
     *
     * Requires the injected reel service to be a `GCService` (the cascade
     * variant of `GRService`). `buildFlowstateReelsDisplay` constructs
     * exactly that, so any Reels node built by the editor supports this.
     *
     * `locations` / `outcome` are JSON-encoded 2D number arrays
     * (`number[][]`):
     *
     * - `outcome` is the post-cascade symbol grid `[reel][row]` that the
     *   falling symbols settle into. Maps onto `model.cascadeOutcome`
     *   (e.g. `"[[1,2,3],[4,3,2],[5,7,2],[2,4,5],[1,4,2]]"` for a 5×3 slot).
     * - `locations` is the per-reel set of row indices to REMOVE before the
     *   fall. Maps onto `model.cascadeLocations`
     *   (e.g. `"[[0,1],[0],[0],[],[]]"` removes the top two of reel 0 and
     *   the top of reels 1 and 2).
     *
     * Either may be omitted, in which case the service's current
     * `cascadeOutcome` / `cascadeLocations` are left unchanged.
     *
     * Cascade timing settings authored on the Reels node (exposed on the
     * root as `_flowstateReelsCascadeSettings`) are re-applied here so an
     * authored config drives fall/bounce/stagger. When none were authored
     * the package's `GCSettings` defaults remain in effect.
     *
     * @param target - NodeRef to a Reels scene node
     * @param locations - `number[][]` (or its JSON) of removal locations per reel
     * @param outcome - `number[][]` (or its JSON) of the post-cascade symbols per reel
     * @param sequenceNodeOn - `"immediate"` (default) or `"onComplete"` to wait until the cascade settles
     */
    public runCascade(target: NodeRefLike, locations?: unknown, outcome?: unknown, sequenceNodeOn?: string): Promise<void> {
        console.log('[FlowState/reels] runCascade CALLED', { locations, outcome });
        const root = resolveNode<ReelsRootLike>(target);
        if (!root) {
            console.warn('[FlowState/reels] runCascade: resolveNode returned null — target did not resolve to a scene node');
            return Promise.resolve();
        }
        const service = root._flowstateReelService;
        if (!service) {
            console.warn(
                `[FlowState/reels] runCascade: target node is not a Reels container (missing _flowstateReelService)`,
            );
            return Promise.resolve();
        }
        if (typeof service.runCascadeSequence !== "function") {
            console.warn(
                `[FlowState/reels] runCascade: injected reel service does not support cascade (not a GCService)`,
            );
            return Promise.resolve();
        }

        // Re-apply authored cascade timing settings (no-op when none authored —
        // the package's GCSettings defaults stay in effect).
        const cascadeSettings = root._flowstateReelsCascadeSettings;
        if (cascadeSettings) {
            service.cascadeSettings = cascadeSettings as ICascadeSettings;
        }

        const parsedOutcome = parse2D(outcome, "runCascade", "outcome");
        const parsedLocations = parse2D(locations, "runCascade", "locations");

        // Canonical reel count = number of reels populated on
        // `model.onScreenReels` (each `registerReel` grows this array). Pad
        // BOTH cascade grids to this length so `GCReelView.triggerCascadeFall`
        // never dereferences an undefined `cascadeOutcome[reelIndex]` /
        // `cascadeLocations[reelIndex]` (which throws and silently aborts the
        // whole cascade for reels the author didn't explicitly list). The
        // current on-screen grid is the fallback outcome when none is
        // configured. Mirrors the working editor preview
        // (`Pixi8Adapter.previewReelsCascade`).
        const currentGrid: number[][] = Array.isArray(service.model.onScreenReels)
            ? (service.model.onScreenReels as number[][]).map((reel) => (Array.isArray(reel) ? reel.slice() : []))
            : [];
        const reelCount = Math.max(
            currentGrid.length,
            parsedLocations ? parsedLocations.length : 0,
            parsedOutcome ? parsedOutcome.length : 0,
        );
        const rawOutcome = parsedOutcome && parsedOutcome.length > 0 ? parsedOutcome : currentGrid;
        const rawLocations = parsedLocations ?? [];

        const cascadeLocations: number[][] = [];
        const cascadeOutcome: number[][] = [];
        const texts = symbolTextsOf(root);
        const topOffset = service.coreSettings?.topOffset ?? 1;
        for (let r = 0; r < reelCount; r += 1) {
            const loc = rawLocations[r];
            const rowCount = Array.isArray(currentGrid[r]) ? currentGrid[r].length : 0;
            cascadeLocations.push(Array.isArray(loc) ? cascadeRowsToSymbolIndices(loc, topOffset, rowCount) : []);
            const out = rawOutcome[r];
            const column = Array.isArray(out) ? out.slice() : [];
            // Every outcome cell carries its texts explicitly (the ones staged
            // with `setLandingSymbolText`, else none), because a cascade
            // shuffles symbol views between rows.
            cascadeOutcome.push(texts
                ? column.map((symbol, row) => (typeof symbol === "number" && symbol < (1 << 20) ? texts.encode(symbol, texts.stagedAt(r, row)) : symbol))
                : column);
        }
        if (texts) texts.clearStaged();

        service.model.cascadeLocations = cascadeLocations;
        service.model.cascadeOutcome = cascadeOutcome;

        console.log('[FlowState/reels] runCascade dispatching', {
            onScreenReelsLen: Array.isArray(service.model.onScreenReels) ? service.model.onScreenReels.length : 'NOT_ARRAY',
            cascadeStateLen: (service as any).model?.cascadeState?.length ?? 'unknown',
            reelCount,
            cascadeLocations: JSON.stringify(cascadeLocations),
            cascadeOutcome: JSON.stringify(cascadeOutcome),
        });
        const done = sequenceNodeOn === "onComplete"
            ? waitForCompletion(waitersFor(service)?.cascade, DEFAULT_REELS_WAIT_SECONDS, "runCascade")
            : Promise.resolve();
        service.runCascadeSequence();
        console.log('[FlowState/reels] runCascade: runCascadeSequence() returned without throwing');
        return done;
    }

    /**
     * Set up a spin sequence with specific end positions on the targeted
     * Reels scene node.
     *
     * Deprecated from the node menu (folded into `spinReels`), but retained
     * for back-compat with previously-exported graphs that reference a
     * `setSpinSequence` node by title.
     *
     * @param target - NodeRef to a Reels scene node
     * @param endPositions - Array of target stop positions for each reel
     * @param startPositions - Optional starting positions (default: current positions)
     */
    public setSpinSequence(target: NodeRefLike, endPositions: number[], startPositions?: number[]): void {
        const service = getService(target);
        if (!service) return;
        service.setSpinSequence(endPositions, startPositions);
    }

    /**
     * Step to the next phase in the spin sequence on the targeted Reels
     * scene node. Useful for manual control of spin progression.
     */
    public stepSpinSequence(target: NodeRefLike): void {
        const service = getService(target);
        if (!service) return;
        service.commands.stepSpinSequence();
    }

    /**
     * Manually trigger the spin complete callback on the targeted Reels
     * scene node. Use when managing spin completion externally.
     */
    public completeSpinSequence(target: NodeRefLike): void {
        const service = getService(target);
        if (!service) return;
        service.model.spinComplete = true;
        if (service.eventFire?.serviceEvent?.ON_SPIN_COMPLETE) {
            service.eventFire.serviceEvent.ON_SPIN_COMPLETE();
        }
    }

    /**
     * PATCH the live spin profile of the targeted Reels scene node, per field.
     *
     * Each field is a JSON string or an already-parsed value; a blank/omitted
     * one KEEPS the profile's current value for that field. The base is the
     * live `spinProfile.sequence`
     * (or a synthesised single step stopping every reel at speed 45 / 0 delay
     * when there is none).
     *
     * `stopReel` is 1-indexed; `delay` is supplied in MILLISECONDS and stored
     * in SECONDS. A value applies to EVERY step unless it is NESTED — an array
     * whose every element is itself an array (or, for `reelSpeed`, an object)
     * is one value per step, by index.
     *
     * Atomic: if any supplied field is unparseable/unusable, or the result
     * fails to stop every reel (`1..reelCount`), nothing is applied. Patches
     * the PER-INSTANCE injected reel service, not the module-level singleton.
     *
     * @param target - NodeRef to a Reels scene node
     * @param stopReel - JSON `number | number[]`, or nested `number[][]` per step
     * @param reelSpeed - JSON `number | number[] | { speed, overrides }`, or nested per step
     * @param delay - JSON `number` (ms), or `number[]` per step
     */
    public setSpinProfile(target: NodeRefLike, stopReel?: unknown, reelSpeed?: unknown, delay?: unknown): void {
        const root = getReelsRoot(target, "setSpinProfile");
        if (!root) return;
        const service = root._flowstateReelService;
        if (!service) return;

        const hasStopReel = isPatchFieldSupplied(stopReel);
        const hasReelSpeed = isPatchFieldSupplied(reelSpeed);
        const hasDelay = isPatchFieldSupplied(delay);
        if (!hasStopReel && !hasReelSpeed && !hasDelay) {
            console.warn(`[FlowState/reels] setSpinProfile: no fields supplied — leaving the existing profile in place`);
            return;
        }

        const grid = root._flowstateReelsGridSize;
        const registeredReels = Array.isArray(service.model.onScreenReels) ? service.model.onScreenReels.length : 0;
        const reelCount =
            typeof grid?.reelCount === "number" && Number.isFinite(grid.reelCount) && grid.reelCount > 0
                ? grid.reelCount
                : registeredReels;
        if (reelCount <= 0) {
            console.warn(`[FlowState/reels] setSpinProfile: could not determine reel count — rebuild the scene`);
            return;
        }

        // Resolve everything BEFORE touching the profile so a bad field no-ops the whole call.
        const parsedStopReel = hasStopReel ? resolvePatchField(stopReel, "stopReel") : null;
        if (hasStopReel && !parsedStopReel) return;
        const parsedReelSpeed = hasReelSpeed ? resolvePatchField(reelSpeed, "reelSpeed") : null;
        if (hasReelSpeed && !parsedReelSpeed) return;
        const parsedDelay = hasDelay ? resolvePatchField(delay, "delay") : null;
        if (hasDelay && !parsedDelay) return;

        if (parsedStopReel && typeof parsedStopReel.value !== "number" && !Array.isArray(parsedStopReel.value)) {
            console.warn(
                `[FlowState/reels] setSpinProfile: expected stopReel to be a number or array, got`,
                parsedStopReel.value,
            );
            return;
        }
        if (
            parsedReelSpeed &&
            typeof parsedReelSpeed.value !== "number" &&
            !Array.isArray(parsedReelSpeed.value) &&
            !isPlainObject(parsedReelSpeed.value)
        ) {
            console.warn(
                `[FlowState/reels] setSpinProfile: expected reelSpeed to be a number, array or object, got`,
                parsedReelSpeed.value,
            );
            return;
        }

        const liveSequence = Array.isArray(service.spinProfile?.sequence) ? service.spinProfile.sequence : [];
        const baseSteps: SpinProfileStep[] =
            liveSequence.length > 0
                ? liveSequence.map((action) => ({
                      stopReel: action.stopReel,
                      reelSpeed: action.reelSpeed as ReelSpeedValue,
                      delaySeconds: action.delay,
                  }))
                : [
                      {
                          stopReel: Array.from({ length: reelCount }, (_, i) => i + 1),
                          reelSpeed: 45, // package default, see resolveDefaultReelSpeeds
                          delaySeconds: 0,
                      },
                  ];

        const stepCount = baseSteps.length;
        const stopReelPerStep = parsedStopReel ? distributeAcrossSteps(parsedStopReel.value, false, stepCount) : null;
        const reelSpeedPerStep = parsedReelSpeed ? distributeAcrossSteps(parsedReelSpeed.value, true, stepCount) : null;
        const delayPerStep = parsedDelay ? distributeDelayAcrossSteps(parsedDelay.value, stepCount) : null;
        if (parsedDelay && !delayPerStep) return;

        const resultActions: SpinProfileAction[] = [];
        const coveredReels = new Set<number>();

        for (let i = 0; i < stepCount; i += 1) {
            const base = baseSteps[i];

            let nextStopReel = base.stopReel;
            if (stopReelPerStep && stopReelPerStep[i] !== undefined) {
                const normalized = normalizeStopReel(stopReelPerStep[i] as number | number[]);
                if (normalized !== null) nextStopReel = normalized;
            }

            let nextReelSpeed = base.reelSpeed;
            if (reelSpeedPerStep && reelSpeedPerStep[i] !== undefined) {
                const normalized = normalizeReelSpeed(reelSpeedPerStep[i]);
                if (normalized !== null) nextReelSpeed = normalized;
            }

            const nextDelaySeconds = delayPerStep && delayPerStep[i] !== undefined ? delayPerStep[i]! : base.delaySeconds;

            if (Array.isArray(nextStopReel)) {
                nextStopReel.forEach((stopValue) => {
                    if (stopValue >= 1 && stopValue <= reelCount) coveredReels.add(stopValue);
                });
            } else if (nextStopReel >= 1 && nextStopReel <= reelCount) {
                coveredReels.add(nextStopReel);
            }

            resultActions.push(new SpinProfileAction(nextStopReel, nextReelSpeed, nextDelaySeconds));
        }

        if (coveredReels.size < reelCount) {
            console.warn(
                `[FlowState/reels] setSpinProfile: the patched profile only stops ${coveredReels.size} of ${reelCount} reels — leaving the existing profile in place (an uncovered reel would spin forever)`,
            );
            return;
        }

        service.spinProfile = new SpinProfileSequence(resultActions);
    }

    // =====================
    // Position Control
    // =====================

    /**
     * Set the target stopping positions for each reel
     * @param positions - Array of stop positions (symbol indices)
     */
    public setReelTargetPositions(positions: number[]): void {
        reelService.model.targetPosition = positions;
    }

    /**
     * Get the current target positions
     * @returns Array of target stop positions
     */
    public getReelTargetPositions(): number[] {
        return reelService.model.targetPosition;
    }

    /**
     * Set the starting positions for the spin
     * @param positions - Array of start positions
     */
    public setReelStartPositions(positions: number[]): void {
        reelService.model.startPosition = positions;
    }

    /**
     * Get the current start positions
     * @returns Array of start positions
     */
    public getReelStartPositions(): number[] {
        return reelService.model.startPosition;
    }

    // =====================
    // Spin State
    // =====================

    /**
     * Set the spin complete flag on the targeted Reels scene node.
     * @param target - NodeRef to a Reels scene node
     * @param complete - Whether the spin has completed
     */
    public setReelSpinComplete(target: NodeRefLike, complete: boolean): void {
        const service = getService(target);
        if (!service) return;
        service.model.spinComplete = complete;
    }

    /**
     * Check if the spin is complete
     * @returns true if spin has completed
     */
    public isSpinComplete(): boolean {
        return reelService.model.spinComplete;
    }

    /**
     * Get the current spin state for each reel
     * @returns Array of spin state values
     */
    public getReelSpinState(): number[] {
        return reelService.model.spinState;
    }

    /**
     * Get the current spin speed values
     * @returns Array of speed values for each reel
     */
    public getReelSpinSpeedValues(): number[] {
        return reelService.model.spinSpeedValues;
    }

    // =====================
    // On-Screen Reels Data
    // =====================

    /**
     * Get the symbols currently visible on screen
     * @returns 2D array of symbol indices [reel][row]
     */
    public getOnScreenReels(): number[][] {
        return reelService.model.onScreenReels;
    }

    /**
     * Set the symbols displayed on screen on the targeted Reels scene node.
     * Assigning to the package's `GRModel.onScreenReels` setter invalidates
     * and redraws via `GRReelView.onReelSetupUpdate$` → `setAndPosition` →
     * `setStaticSkin`, so no explicit redraw call is needed.
     * @param target - NodeRef to a Reels scene node
     * @param reels - 2D array `number[][]` of symbol indices `[reel][row]`, or
     *   its JSON (e.g. `"[[0,0,0],[0,0,0],[0,0,0]]"`).
     */
    public setOnScreenReels(target: NodeRefLike, reels: unknown): void {
        const service = getService(target);
        if (!service) return;
        const parsed = parse2D(reels, "setOnScreenReels", "reels");
        if (!parsed) return;
        // With symbol texts, the new board carries its staged texts (or none).
        const root = resolveNode<ReelsRootLike>(target);
        const texts = root ? symbolTextsOf(root) : null;
        if (texts) {
            texts.resetTable();
            const encoded = parsed.map((column, reel) => column.map((symbol, row) => texts.encode(symbol, texts.stagedAt(reel, row))));
            texts.clearStaged();
            service.model.onScreenReels = encoded;
            return;
        }
        service.model.onScreenReels = parsed;
    }

    /**
     * Force-set the currently-visible symbols on the targeted Reels scene
     * node (the game "DisplayReels" grid). Assigning to the package's
     * `GRModel.displayReels` setter drives `GRReelView.onForceDisplayReel$`,
     * which writes each symbol's skin directly (`symbol.symbolData.skin =
     * displayReel[i]; symbol.setStaticSkin()`) WITHOUT rebuilding the
     * scrolling reel strip/map or repositioning.
     *
     * Contrast with {@link setOnScreenReels}, which sets the scrolling reel
     * strip/map (`GRModel.onScreenReels` → `onReelSetupUpdate$`) and
     * rebuilds + repositions the reel.
     * @param target - NodeRef to a Reels scene node
     * @param reels - 2D array `number[][]` of symbol indices `[reel][row]`, or
     *   its JSON (e.g. `"[[0,0,0],[0,0,0],[0,0,0]]"`).
     */
    public setDisplayReels(target: NodeRefLike, reels: unknown): void {
        const service = getService(target);
        if (!service) return;
        const parsed = parse2D(reels, "setDisplayReels", "reels");
        if (!parsed) return;
        service.model.displayReels = parsed;
    }

    /**
     * Switch the targeted Reels scene node to main game reels
     * (from game settings).
     */
    public useMainGameReels(target: NodeRefLike): void {
        const service = getService(target);
        if (!service) return;
        service.model.onScreenReels = gameSettings.reels;
    }

    /**
     * Switch the targeted Reels scene node to bonus spin reels
     * (from game settings).
     */
    public useBonusReels(target: NodeRefLike): void {
        const service = getService(target);
        if (!service) return;
        service.model.onScreenReels = gameSettings.bonusSpinReels;
    }

    /**
     * Get a specific symbol at a reel/row position
     * @param reelIndex - Reel index (0-based)
     * @param rowIndex - Row index (0-based)
     * @returns Symbol index at that position
     */
    public getSymbolAt(reelIndex: number, rowIndex: number): number {
        const onScreen = reelService.model.onScreenReels;
        if (onScreen && onScreen[reelIndex] && onScreen[reelIndex][rowIndex] !== undefined) {
            return onScreen[reelIndex][rowIndex];
        }
        return -1;
    }

    // =====================
    // Spin Profile Configuration
    // =====================

    /**
     * Set the spin profile (controls spin animation characteristics)
     * @param spinProfileSequence - Spin profile configuration
     */
    public setReelSpinProfile(spinProfileSequence: SpinProfileSequence): void {
        reelService.spinProfile = spinProfileSequence;
    }

    /**
     * Get the current spin profile
     * @returns Current spin profile configuration
     */
    public getReelSpinProfile(): SpinProfileSequence {
        return reelService.spinProfile;
    }

    // =====================
    // Settings Configuration
    // =====================

    /**
     * Update core reel settings (number of reels, rows, etc.)
     * @param settings - Core settings object
     */
    public updateReelCoreSettings(settings: ICoreSettings): void {
        reelService.coreSettings = settings;
    }

    /**
     * Get the current core reel settings
     * @returns Core settings object
     */
    public getReelCoreSettings(): ICoreSettings {
        return reelService.coreSettings;
    }

    /**
     * Update symbol settings (sizes, spacing, etc.)
     * @param settings - Symbol settings object
     */
    public updateReelSymbolSettings(settings: ISymbolSettings): void {
        reelService.symbolSettings = settings;
    }

    /**
     * Get the current symbol settings
     * @returns Symbol settings object
     */
    public getReelSymbolSettings(): ISymbolSettings {
        return reelService.symbolSettings;
    }

    /**
     * Update general reel settings
     * @param settings - Reel settings object
     */
    public updateReelSettings(settings: IReelSettings): void {
        reelService.reelSettings = settings;
    }

    /**
     * Get the current reel settings
     * @returns Reel settings object
     */
    public getReelSettings(): IReelSettings {
        return reelService.reelSettings;
    }

    // =====================
    // Anticipation / Tease Control
    // =====================

    /**
     * Get the number of reels
     * @returns Number of reels in the game
     */
    // public getReelCount(): number {
    //     return reelService.coreSettings?.reelCount || 5;
    // }

    /**
     * Get the number of visible rows
     * @returns Number of visible symbol rows
     */
    // public getRowCount(): number {
    //     return reelService.coreSettings?.rowCount || 3;
    // }

    /**
     * Check if a specific reel is currently spinning
     * @param reelIndex - Reel index (0-based)
     * @returns true if the reel is spinning
     */
    public isReelSpinning(reelIndex: number): boolean {
        const spinState = reelService.model.spinState;
        if (spinState && spinState[reelIndex] !== undefined) {
            return spinState[reelIndex] > 0;
        }
        return false;
    }

    /**
     * Get the number of reels still spinning
     * @returns Count of spinning reels
     */
    public getSpinningReelCount(): number {
        const spinState = reelService.model.spinState || [];
        return spinState.filter(state => state > 0).length;
    }

    // =========================================================================
    // Per-reel / per-symbol control (TARGET-DISPATCHED)
    // =========================================================================
    // Every method below resolves the Reels ROOT container from its `target`
    // NodeRef (via `getReelsRoot`) and drives the per-instance handles that
    // `components/reels.ts` attaches in `buildFlowstateReelsDisplay`:
    // `_flowstateReelViews`, `_flowstateReelsGridSize` and
    // `_flowstateResolveSymbolCell` (plus the per-instance
    // `_flowstateReelService`).
    //
    // This is DELIBERATELY unlike the legacy `getSymbolAt` / `isReelSpinning` /
    // `getSpinningReelCount` / `getReelSpinState` group above, which read the
    // module-level `reelService` singleton imported from `../../reel-service`.
    // No reel view ever registers with that singleton in an Orca-built game —
    // `buildFlowstateReelsDisplay` constructs its own
    // `FlowstateInjectedReelService` per Reels node — so those methods always
    // return `[]` / `false` / `-1` and have no menu nodes. NEVER wire a new
    // method to that singleton.
    //
    // Shared index conventions for the SETTERS:
    //   * `reelIndex === -1` → ALL reels.
    //   * `rowIndex === -1`  → ALL rows.
    //   * anything else is validated against `_flowstateReelsGridSize` and
    //     warns (then no-ops) when out of range.
    //   * `rowIndex` is a VISIBLE row. The strip SCROLLS, so the component's
    //     `_flowstateResolveSymbolCell` performs a nearest-Y lookup rather
    //     than indexing `reelView.symbols[rowIndex]`.
    // The GETTERS take concrete indices only (no wildcard) and return a
    // zero-value (`0` / `false` / `-1` / an all-zero object) when the target
    // or the addressed cell cannot be resolved.

    /**
     * Set the symbol shown at one visible cell (or a whole reel / row / grid
     * via the `-1` wildcards).
     *
     * Drives `FlowstateInjectedSymbolView.setSymbolIndex`, which writes
     * `symbolData.skin` and re-runs the shared visual resolver through
     * `setStaticSkin()` — so it works in all three symbol render modes
     * (sprite, animatedSprite, spine) and re-asserts any live visual
     * override.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel, or `-1` for every reel
     * @param rowIndex - 0-based VISIBLE row, or `-1` for every row
     * @param symbolIndex - Index into the node's authored `symbolEntries[]`
     */
    public setSymbolAt(target: NodeRefLike, reelIndex: number, rowIndex: number, symbolIndex: number): void {
        const root = getReelsRoot(target, "setSymbolAt");
        if (!root) return;
        if (typeof symbolIndex !== "number" || !Number.isFinite(symbolIndex) || symbolIndex < 0) {
            console.warn(`[FlowState/reels] setSymbolAt: symbolIndex must be a non-negative number, got`, symbolIndex);
            return;
        }
        const index = Math.trunc(symbolIndex);
        for (const view of resolveSymbolCells(root, reelIndex, rowIndex, "setSymbolAt")) {
            try {
                view.setSymbolIndex(index);
            } catch (err) {
                console.warn(`[FlowState/reels] setSymbolAt: setSymbolIndex failed`, err);
            }
        }
    }

    /**
     * Set every visible row of a reel from a JSON-encoded `number[]` of
     * symbol indices (one entry per visible row, top-first).
     *
     * Entries beyond the authored row count are ignored (with a warn);
     * a short array leaves the remaining rows untouched. Each entry is
     * applied through `FlowstateInjectedSymbolView.setSymbolIndex`.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel, or `-1` to apply the same column to every reel
     * @param symbols - JSON string encoding `number[]`, e.g. `"[3,0,1]"`
     */
    public setReelSymbols(target: NodeRefLike, reelIndex: number, symbols: string): void {
        const root = getReelsRoot(target, "setReelSymbols");
        if (!root) return;
        const grid = getGridSize(root, "setReelSymbols");
        if (!grid) return;
        const parsed = parsePositions(symbols, "setReelSymbols");
        if (!parsed || parsed.length === 0) {
            console.warn(`[FlowState/reels] setReelSymbols: no valid symbols array supplied`, symbols);
            return;
        }
        if (parsed.length > grid.rowCount) {
            console.warn(
                `[FlowState/reels] setReelSymbols: got ${parsed.length} symbols for ${grid.rowCount} visible rows — extra entries ignored`,
            );
        }
        const rows = Math.min(parsed.length, grid.rowCount);
        for (let row = 0; row < rows; row += 1) {
            const value = parsed[row];
            if (!Number.isFinite(value) || value < 0) {
                console.warn(`[FlowState/reels] setReelSymbols: ignoring invalid symbol index at row ${row}`, value);
                continue;
            }
            for (const view of resolveSymbolCells(root, reelIndex, row, "setReelSymbols")) {
                try {
                    view.setSymbolIndex(Math.trunc(value));
                } catch (err) {
                    console.warn(`[FlowState/reels] setReelSymbols: setSymbolIndex failed`, err);
                }
            }
        }
    }

    /**
     * Fill EVERY visible row of a reel with one symbol index — the "make this
     * a wild reel" primitive. Equivalent to `setSymbolAt(target, reelIndex,
     * -1, symbolIndex)`, exposed separately so the menu node reads clearly.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel, or `-1` for every reel
     * @param symbolIndex - Index into the node's authored `symbolEntries[]`
     */
    public setReelToSymbol(target: NodeRefLike, reelIndex: number, symbolIndex: number): void {
        const root = getReelsRoot(target, "setReelToSymbol");
        if (!root) return;
        if (typeof symbolIndex !== "number" || !Number.isFinite(symbolIndex) || symbolIndex < 0) {
            console.warn(
                `[FlowState/reels] setReelToSymbol: symbolIndex must be a non-negative number, got`,
                symbolIndex,
            );
            return;
        }
        const index = Math.trunc(symbolIndex);
        for (const view of resolveSymbolCells(root, reelIndex, -1, "setReelToSymbol")) {
            try {
                view.setSymbolIndex(index);
            } catch (err) {
                console.warn(`[FlowState/reels] setReelToSymbol: setSymbolIndex failed`, err);
            }
        }
    }

    /**
     * Re-point the node's symbol DRAW ORDER at runtime — which symbol ID
     * renders on top when two visible symbols overlap (per-symbol `scale > 1`).
     *
     * `order` is a JSON-encoded `number[]` of AUTHORED symbol IDs, FIRST entry
     * topmost, e.g. `"[2,0,1]"`. It is normalised by the same component-side
     * helper the authored `symbolDrawOrder` uses: non-integer / out-of-range /
     * duplicate IDs are DROPPED and any ID that never appeared is appended in
     * ascending order — so a short list is legal (the omitted IDs keep their
     * relative order at the bottom) and `"[]"` restores the authored-default
     * identity order. Padded tail symbols inherit their source symbol's depth.
     *
     * Presentation-only and NOT persisted: reloading the scene snaps back to
     * the authored `symbolDrawOrder`. A live winline elevation always wins.
     *
     * @param target - NodeRef to a Reels scene node
     * @param order - JSON string encoding `number[]`, e.g. `"[2,0,1]"`
     */
    public setSymbolDrawOrder(target: NodeRefLike, order: string): void {
        const root = getReelsRoot(target, "setSymbolDrawOrder");
        if (!root) return;
        const apply = root._flowstateSetSymbolDrawOrder;
        if (typeof apply !== "function") {
            console.warn(
                `[FlowState/reels] setSymbolDrawOrder: Reels node exposes no draw-order handle (_flowstateSetSymbolDrawOrder) — rebuild the scene`,
            );
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(String(order ?? "").trim() || "[]");
        } catch (err) {
            console.warn(`[FlowState/reels] setSymbolDrawOrder: failed to parse order JSON`, order, err);
            return;
        }
        if (!Array.isArray(parsed)) {
            console.warn(`[FlowState/reels] setSymbolDrawOrder: expected JSON-encoded number[], got`, order);
            return;
        }
        const authoredCount = root._flowstateAuthoredSymbolCount;
        if (typeof authoredCount === "number" && authoredCount > 0) {
            for (const id of parsed) {
                if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id >= authoredCount) {
                    console.warn(
                        `[FlowState/reels] setSymbolDrawOrder: ignoring invalid symbol ID ${String(id)} (authored symbols: 0..${authoredCount - 1})`,
                    );
                }
            }
        }
        try {
            apply(parsed as number[]);
        } catch (err) {
            console.warn(`[FlowState/reels] setSymbolDrawOrder: failed to apply draw order`, err);
        }
    }

    /**
     * Play an animation on one visible symbol (or a whole reel / row / grid
     * via the `-1` wildcards).
     *
     * Delegates to `FlowstateInjectedSymbolView.playSymbolAnimation`, which
     * branches on the symbol's render mode: spine plays on TRACK 1 (track 0
     * holds the landed pose), `animatedSprite` plays the lazily-resolved
     * frame list, and a static sprite has nothing to play (warns, returns
     * false). An empty `animationName` falls through to the symbol's
     * authored default.
     *
     * Frame resolution for `animatedSprite` symbols is async: the FIRST call
     * on a symbol index kicks the resolve and returns false — re-fire to
     * play. This method never blocks the flow walk.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel, or `-1` for every reel
     * @param rowIndex - 0-based VISIBLE row, or `-1` for every row
     * @param animationName - Spine animation name; empty for the symbol default
     * @param loop - Whether the animation loops
     */
    public playSymbolAnimation(
        target: NodeRefLike,
        reelIndex: number,
        rowIndex: number,
        animationName: string,
        loop: boolean,
    ): void {
        const root = getReelsRoot(target, "playSymbolAnimation");
        if (!root) return;
        const name = typeof animationName === "string" && animationName.trim() !== ""
            ? animationName.trim()
            : undefined;
        const views = resolveSymbolCells(root, reelIndex, rowIndex, "playSymbolAnimation");
        let started = 0;
        for (const view of views) {
            try {
                if (view.playSymbolAnimation(name, loop === true)) started += 1;
            } catch (err) {
                console.warn(`[FlowState/reels] playSymbolAnimation: playback failed`, err);
            }
        }
        if (views.length > 0 && started === 0) {
            console.warn(
                `[FlowState/reels] playSymbolAnimation: no symbol started playback (static sprites, or animsprite frames still resolving)`,
            );
        }
    }

    /**
     * Stop whatever {@link playSymbolAnimation} started and restore the
     * symbol's pre-animation visual state.
     *
     * Delegates to `FlowstateInjectedSymbolView.stopSymbolAnimation` — spine
     * clears TRACK 1 only (the landed track-0 pose is preserved), animated
     * sprites stop and reset to frame 0, static sprites are a no-op.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel, or `-1` for every reel
     * @param rowIndex - 0-based VISIBLE row, or `-1` for every row
     */
    public stopSymbolAnimation(target: NodeRefLike, reelIndex: number, rowIndex: number): void {
        const root = getReelsRoot(target, "stopSymbolAnimation");
        if (!root) return;
        for (const view of resolveSymbolCells(root, reelIndex, rowIndex, "stopSymbolAnimation")) {
            try {
                view.stopSymbolAnimation();
            } catch (err) {
                console.warn(`[FlowState/reels] stopSymbolAnimation: stop failed`, err);
            }
        }
    }

    /**
     * Tint one visible symbol (or a whole reel / row / grid via the `-1`
     * wildcards).
     *
     * Drives `FlowstateInjectedSymbolView.applyVisualOverride({ tint })`,
     * which tints the inner static sprite (a Container has no tint) and, when
     * one is hosted, the live spine. Clear it again with
     * {@link resetSymbolVisuals}.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel, or `-1` for every reel
     * @param rowIndex - 0-based VISIBLE row, or `-1` for every row
     * @param tint - 24-bit RGB tint (e.g. `0xff0000`); `0xffffff` is neutral
     */
    public setSymbolTint(target: NodeRefLike, reelIndex: number, rowIndex: number, tint: number): void {
        const root = getReelsRoot(target, "setSymbolTint");
        if (!root) return;
        if (typeof tint !== "number" || !Number.isFinite(tint)) {
            console.warn(`[FlowState/reels] setSymbolTint: tint must be a number, got`, tint);
            return;
        }
        const value = Math.trunc(tint);
        for (const view of resolveSymbolCells(root, reelIndex, rowIndex, "setSymbolTint")) {
            try {
                view.applyVisualOverride({ tint: value });
            } catch (err) {
                console.warn(`[FlowState/reels] setSymbolTint: applyVisualOverride failed`, err);
            }
        }
    }

    /**
     * Set the alpha of one visible symbol (or a whole reel / row / grid via
     * the `-1` wildcards). Clamped to `0..1`.
     *
     * Drives `FlowstateInjectedSymbolView.applyVisualOverride({ alpha })`,
     * which acts on the symbol CONTAINER. Clear it again with
     * {@link resetSymbolVisuals}.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel, or `-1` for every reel
     * @param rowIndex - 0-based VISIBLE row, or `-1` for every row
     * @param alpha - Opacity, clamped to `0..1`
     */
    public setSymbolAlpha(target: NodeRefLike, reelIndex: number, rowIndex: number, alpha: number): void {
        const root = getReelsRoot(target, "setSymbolAlpha");
        if (!root) return;
        if (typeof alpha !== "number" || !Number.isFinite(alpha)) {
            console.warn(`[FlowState/reels] setSymbolAlpha: alpha must be a number, got`, alpha);
            return;
        }
        const value = Math.max(0, Math.min(1, alpha));
        for (const view of resolveSymbolCells(root, reelIndex, rowIndex, "setSymbolAlpha")) {
            try {
                view.applyVisualOverride({ alpha: value });
            } catch (err) {
                console.warn(`[FlowState/reels] setSymbolAlpha: applyVisualOverride failed`, err);
            }
        }
    }

    /**
     * Scale one visible symbol (or a whole reel / row / grid via the `-1`
     * wildcards). Uniform on both axes.
     *
     * Drives `FlowstateInjectedSymbolView.applyVisualOverride({ scale })`,
     * which acts on the symbol CONTAINER and is re-asserted after a
     * {@link setSymbolAt} (whose `applySkin` resets container scale). Clear
     * it again with {@link resetSymbolVisuals}.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel, or `-1` for every reel
     * @param rowIndex - 0-based VISIBLE row, or `-1` for every row
     * @param scale - Uniform scale multiplier; must be `> 0`
     */
    public setSymbolScale(target: NodeRefLike, reelIndex: number, rowIndex: number, scale: number): void {
        const root = getReelsRoot(target, "setSymbolScale");
        if (!root) return;
        if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
            console.warn(`[FlowState/reels] setSymbolScale: scale must be a number > 0, got`, scale);
            return;
        }
        for (const view of resolveSymbolCells(root, reelIndex, rowIndex, "setSymbolScale")) {
            try {
                view.applyVisualOverride({ scale });
            } catch (err) {
                console.warn(`[FlowState/reels] setSymbolScale: applyVisualOverride failed`, err);
            }
        }
    }

    /**
     * Show / hide one visible symbol (or a whole reel / row / grid via the
     * `-1` wildcards).
     *
     * Drives `FlowstateInjectedSymbolView.applyVisualOverride({ visible })`,
     * which acts on the symbol CONTAINER. Clear it again with
     * {@link resetSymbolVisuals}.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel, or `-1` for every reel
     * @param rowIndex - 0-based VISIBLE row, or `-1` for every row
     * @param visible - Whether the symbol renders
     */
    public setSymbolVisible(target: NodeRefLike, reelIndex: number, rowIndex: number, visible: boolean): void {
        const root = getReelsRoot(target, "setSymbolVisible");
        if (!root) return;
        const value = visible === true;
        for (const view of resolveSymbolCells(root, reelIndex, rowIndex, "setSymbolVisible")) {
            try {
                view.applyVisualOverride({ visible: value });
            } catch (err) {
                console.warn(`[FlowState/reels] setSymbolVisible: applyVisualOverride failed`, err);
            }
        }
    }

    /**
     * Restore the pre-override alpha / tint / scale / visibility of one
     * visible symbol (or a whole reel / row / grid via the `-1` wildcards).
     *
     * Drives `FlowstateInjectedSymbolView.clearVisualOverride`, which
     * restores the snapshot taken on the FIRST override and is idempotent —
     * calling it on a symbol that was never overridden is a no-op.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel, or `-1` for every reel
     * @param rowIndex - 0-based VISIBLE row, or `-1` for every row
     */
    public resetSymbolVisuals(target: NodeRefLike, reelIndex: number, rowIndex: number): void {
        const root = getReelsRoot(target, "resetSymbolVisuals");
        if (!root) return;
        for (const view of resolveSymbolCells(root, reelIndex, rowIndex, "resetSymbolVisuals")) {
            try {
                view.clearVisualOverride();
            } catch (err) {
                console.warn(`[FlowState/reels] resetSymbolVisuals: clearVisualOverride failed`, err);
            }
        }
    }

    // =====================
    // Symbol Texts
    // =====================
    // The Reels node's `symbolTexts` slots (Advanced Settings ▸ Symbol Texts)
    // are styled in the editor; the TEXT comes from these nodes. `textIndex`
    // is the slot's position in that list (0 = the first).

    /**
     * Put a text on the symbol that LANDS in a cell: staged now, and drawn on
     * that symbol as the next board arrives — spun in by Spin Reels To Grid,
     * dropped in by Run Cascade or set by Set On Screen Reels — so the value
     * is on the symbol while it lands. Use it BEFORE that node. `-1` on
     * reelIndex / rowIndex stages every reel / row.
     */
    public setLandingSymbolText(target: NodeRefLike, reelIndex: number, rowIndex: number, textIndex: number, text: string): void {
        const caller = "setLandingSymbolText";
        const root = getReelsRoot(target, caller);
        const texts = root ? symbolTextsOrWarn(root, caller) : null;
        const grid = root && texts ? getGridSize(root, caller) : null;
        if (!texts || !grid) return;
        const slot = textSlotOrWarn(textIndex, texts, caller);
        const reels = expandIndexWildcard(reelIndex, grid.reelCount, "reelIndex", caller);
        const rows = expandIndexWildcard(rowIndex, grid.rowCount, "rowIndex", caller);
        if (slot === null || !reels || !rows) return;
        for (const reel of reels) {
            for (const row of rows) texts.stage(reel, row, slot, String(text ?? ""));
        }
    }

    /** Change the text on the symbol in a cell now. `-1` = every reel / row. */
    public setSymbolText(target: NodeRefLike, reelIndex: number, rowIndex: number, textIndex: number, text: string): void {
        const caller = "setSymbolText";
        const root = getReelsRoot(target, caller);
        const texts = root ? symbolTextsOrWarn(root, caller) : null;
        if (!root || !texts) return;
        const slot = textSlotOrWarn(textIndex, texts, caller);
        if (slot === null) return;
        for (const view of resolveSymbolCells(root, reelIndex, rowIndex, caller)) {
            view.setCellText?.(slot, String(text ?? ""));
        }
    }

    /**
     * Remove symbol texts now. `-1` on reelIndex / rowIndex = every reel /
     * row, and `textIndex` `-1` = every text of the cell. Anything staged for
     * the next board is dropped too when the whole board is cleared.
     */
    public clearSymbolTexts(target: NodeRefLike, reelIndex: number, rowIndex: number, textIndex: number): void {
        const caller = "clearSymbolTexts";
        const root = getReelsRoot(target, caller);
        const texts = root ? symbolTextsOrWarn(root, caller) : null;
        if (!root || !texts) return;
        const all = Math.trunc(Number(textIndex)) === -1;
        const slot = all ? -1 : textSlotOrWarn(textIndex, texts, caller);
        if (slot === null) return;
        for (const view of resolveSymbolCells(root, reelIndex, rowIndex, caller)) {
            if (all) view.setCellTexts?.([]);
            else view.setCellText?.(slot, "");
        }
        if (all && Math.trunc(Number(reelIndex)) === -1 && Math.trunc(Number(rowIndex)) === -1) texts.clearStaged();
    }

    /** The text a symbol shows in one slot now ('' when none). */
    public getSymbolText(target: NodeRefLike, reelIndex: number, rowIndex: number, textIndex: number): string {
        const caller = "getSymbolText";
        const root = getReelsRoot(target, caller);
        const texts = root ? symbolTextsOrWarn(root, caller) : null;
        if (!root || !texts) return "";
        const slot = textSlotOrWarn(textIndex, texts, caller);
        if (slot === null) return "";
        const view = root._flowstateResolveSymbolCell?.(Math.trunc(Number(reelIndex)), Math.trunc(Number(rowIndex))) ?? null;
        return view?.getCellText?.(slot) ?? "";
    }

    /**
     * A reference to a symbol's text, for any node that takes a scene-node
     * target (tween it, count it up with Count Up Text, fly it with Tween
     * Node To Node…). It names the CELL, so it follows whatever symbol is
     * there when it is used.
     */
    public getSymbolTextNode(target: NodeRefLike, reelIndex: number, rowIndex: number, textIndex: number): NodeRefValue | null {
        const caller = "getSymbolTextNode";
        const root = getReelsRoot(target, caller);
        const texts = root ? symbolTextsOrWarn(root, caller) : null;
        if (!root || !texts) return null;
        const slot = textSlotOrWarn(textIndex, texts, caller);
        if (slot === null) return null;
        return reelsSubNodeRef(target, `text:${Math.trunc(Number(reelIndex))}:${Math.trunc(Number(rowIndex))}:${slot}`);
    }

    /** A reference to the symbol in a cell (the whole symbol, texts included), for tweening. */
    public getReelSymbolNode(target: NodeRefLike, reelIndex: number, rowIndex: number): NodeRefValue | null {
        if (!getReelsRoot(target, "getReelSymbolNode")) return null;
        return reelsSubNodeRef(target, `cell:${Math.trunc(Number(reelIndex))}:${Math.trunc(Number(rowIndex))}`);
    }

    /**
     * Stop ONE reel at `endPosition`, leaving every other reel's target
     * position untouched.
     *
     * Intended for staggered / author-driven stops after
     * `spinReels(target, "startSpinOnly")`.
     *
     * Like {@link stopReels}, this must NOT write `model.spinState` directly:
     * `GRService.stepSpinSequence` (`GRService.ts` L70) indexes
     * `_currentSpinProfile[progress]` with no empty-array guard, so a direct
     * write crashes the shared `PIXI.Ticker` the moment the reel lands, and a
     * target index >= the strip length leaves the reel stuck in
     * `WAITING_TO_STOP` forever.
     *
     * Same profile-swap trick, sized for ONE landing:
     *   1. Seed the target array from the LIVE `model.targetPosition` so the
     *      other reels keep their existing targets, overwriting only this
     *      reel's entry, then run the whole array through `sanitisePositions`
     *      (wrapping an out-of-range `endPosition` against
     *      `model.onScreenReels[reelIndex].length` with a warn).
     *   2. Temporarily install `new SpinProfileSequence([new
     *      SpinProfileAction(reelIndex + 1, speeds, 0)])` — a SCALAR
     *      `stopReel` (the package is **1-INDEXED** here:
     *      `executeCurrentSequenceAction` does `newSpinState[stopReel - 1] =
     *      STOPPED`, while `reelIndex`, `spinState[]` and `onScreenReels[]`
     *      are 0-indexed). `formatSequence` only expands ARRAY `stopReel`
     *      entries into dummies, so a scalar leaves
     *      `_currentSpinProfile.length === 1` — exactly one
     *      `stepSpinSequence` increment for the single reel that will land,
     *      after which `progress === length` and `sequenceComplete()` runs.
     *   3. Restore the previous `spinProfile` in a `finally`.
     *      `runSpinSequence()` has already snapshotted `_currentSpinProfile`,
     *      so the restore leaves the in-flight stop alone and keeps the
     *      authored profile intact for the next `spinReels("fullSequence")`.
     *
     * Two caveats worth knowing:
     *   * `runSpinSequence()` re-arms the whole cycle — it writes SPINNING to
     *     EVERY reel before the delay-0 action stops this one. Reels already
     *     spinning are unaffected (`onSpinState$` only calls `beginReelSpin`
     *     on a STOPPED→SPINNING transition), but reels that had already
     *     stopped WILL start moving again. Use this while the reels spin.
     *   * `sequenceComplete()` fires `ON_SPIN_COMPLETE` once this reel lands,
     *     which `components/reels.ts` forwards to the FlowState
     *     `spinComplete` starter — so that starter runs per stopped reel, not
     *     once for the whole grid.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel to stop (no `-1` wildcard — use `stopReels` for all)
     * @param endPosition - Strip index this reel lands on (wrapped when out of range)
     */
    public stopSingleReel(target: NodeRefLike, reelIndex: number, endPosition: number): void {
        const service = getService(target);
        if (!service) return;

        const reelCount = service.model.onScreenReels.length || 1;
        if (typeof reelIndex !== "number" || !Number.isFinite(reelIndex)) {
            console.warn(`[FlowState/reels] stopSingleReel: reelIndex must be a number, got`, reelIndex);
            return;
        }
        const index = Math.trunc(reelIndex);
        if (index < 0 || index >= reelCount) {
            console.warn(`[FlowState/reels] stopSingleReel: reelIndex=${reelIndex} out of range (0..${reelCount - 1})`);
            return;
        }

        const stripLengths = service.model.onScreenReels.map((s) => (Array.isArray(s) ? s.length : 0));

        // Seed from the live targets so the other reels are untouched, then
        // overwrite just this reel's entry.
        const liveTargets = Array.isArray(service.model.targetPosition) ? service.model.targetPosition : [];
        const rawTargets: number[] = new Array(reelCount).fill(0);
        for (let i = 0; i < reelCount; i += 1) {
            const live = liveTargets[i];
            rawTargets[i] = typeof live === "number" && Number.isFinite(live) ? live : 0;
        }
        rawTargets[index] =
            typeof endPosition === "number" && Number.isFinite(endPosition) ? Math.trunc(endPosition) : 0;
        const sanitisedTargets = sanitisePositions(rawTargets, reelCount, stripLengths, "stopSingleReel");

        // ONE real action stopping ONE reel. `stopReel` is 1-INDEXED.
        const speeds = resolveDefaultReelSpeeds(service, reelCount);
        const stopProfile = new SpinProfileSequence([new SpinProfileAction(index + 1, speeds, 0)]);

        const prevProfile = service.spinProfile;
        service.spinProfile = stopProfile;
        try {
            service.setSpinSequence(sanitisedTargets);
            service.model.spinComplete = false;
            service.runSpinSequence();
        } finally {
            service.spinProfile = prevProfile;
        }
    }

    /**
     * Get the symbol index currently VISIBLE at a reel/row cell.
     *
     * Reads the live symbol view resolved by `_flowstateResolveSymbolCell`
     * (nearest-Y against the scrolling strip) and returns its
     * `symbolData.skin` — the NUMBER index into the node's authored
     * `symbolEntries[]`. Falls back to `model.onScreenReels[reel][row]` only
     * when no view resolves; note that array is the full scrolling STRIP, so
     * the fallback is only accurate before the reel has scrolled.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel
     * @param rowIndex - 0-based VISIBLE row
     * @returns Symbol index, or `-1` when unresolvable
     */
    public getReelSymbolAt(target: NodeRefLike, reelIndex: number, rowIndex: number): number {
        const root = getReelsRoot(target, "getReelSymbolAt");
        if (!root) return -1;
        const grid = getGridSize(root, "getReelSymbolAt");
        if (!grid) return -1;
        if (
            typeof reelIndex !== "number" || !Number.isFinite(reelIndex) ||
            typeof rowIndex !== "number" || !Number.isFinite(rowIndex)
        ) {
            console.warn(`[FlowState/reels] getReelSymbolAt: indices must be numbers, got`, reelIndex, rowIndex);
            return -1;
        }
        const reel = Math.trunc(reelIndex);
        const row = Math.trunc(rowIndex);
        if (reel < 0 || reel >= grid.reelCount || row < 0 || row >= grid.rowCount) {
            console.warn(
                `[FlowState/reels] getReelSymbolAt: [${reel}][${row}] out of range (${grid.reelCount}x${grid.rowCount})`,
            );
            return -1;
        }

        const resolveCell = root._flowstateResolveSymbolCell;
        if (typeof resolveCell === "function") {
            try {
                const view = resolveCell(reel, row);
                const skin = view?.symbolData?.skin;
                if (typeof skin === "number" && Number.isFinite(skin)) return Math.trunc(skin);
            } catch (err) {
                console.warn(`[FlowState/reels] getReelSymbolAt: cell resolve failed`, err);
            }
        }

        // Fallback: the scrolling strip (accurate only pre-scroll).
        const onScreen = root._flowstateReelService?.model?.onScreenReels;
        const value = Array.isArray(onScreen) && Array.isArray(onScreen[reel]) ? onScreen[reel][row] : undefined;
        return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : -1;
    }

    /**
     * Get the raw `SpinState` enum value for one reel from
     * `model.spinState[reelIndex]` (`0` === STOPPED).
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel
     * @returns The `SpinState` value, or `0` when unavailable
     */
    public getReelSpinStateAt(target: NodeRefLike, reelIndex: number): number {
        const service = getService(target);
        if (!service) return 0;
        if (typeof reelIndex !== "number" || !Number.isFinite(reelIndex)) {
            console.warn(`[FlowState/reels] getReelSpinStateAt: reelIndex must be a number, got`, reelIndex);
            return 0;
        }
        const index = Math.trunc(reelIndex);
        const state = service.model.spinState;
        if (!Array.isArray(state) || index < 0 || index >= state.length) {
            console.warn(`[FlowState/reels] getReelSpinStateAt: reelIndex=${reelIndex} out of range`);
            return 0;
        }
        const value = state[index];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    }

    /**
     * Whether one reel is currently moving.
     *
     * Prefers the reel VIEW's `isSpinning` getter (still true while a landed
     * reel settles through its elastic bounce) and falls back to
     * `model.spinState[reelIndex] > 0` (not STOPPED) — so this may disagree
     * with {@link getReelSpinStateAt} during the stop settle.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel
     * @returns `true` while the reel is spinning, `false` when unavailable
     */
    public isReelSpinningAt(target: NodeRefLike, reelIndex: number): boolean {
        const root = getReelsRoot(target, "isReelSpinningAt");
        if (!root) return false;
        const grid = getGridSize(root, "isReelSpinningAt");
        if (!grid) return false;
        if (typeof reelIndex !== "number" || !Number.isFinite(reelIndex)) {
            console.warn(`[FlowState/reels] isReelSpinningAt: reelIndex must be a number, got`, reelIndex);
            return false;
        }
        const index = Math.trunc(reelIndex);
        if (index < 0 || index >= grid.reelCount) {
            console.warn(
                `[FlowState/reels] isReelSpinningAt: reelIndex=${reelIndex} out of range (0..${grid.reelCount - 1})`,
            );
            return false;
        }
        return isReelViewSpinning(root, root._flowstateReelService, index);
    }

    /**
     * Get the LIVE scroll speed of one reel from the reel view's public
     * `speed` getter (px/tick).
     *
     * Deliberately does NOT fall back to `model.spinSpeedValues` — that is
     * the CONFIGURED speed limit, not the live speed, so it would read
     * non-zero on a stopped reel.
     *
     * @param target - NodeRef to a Reels scene node
     * @param reelIndex - 0-based reel
     * @returns Live speed, or `0` when unavailable
     */
    public getReelSpeedAt(target: NodeRefLike, reelIndex: number): number {
        const root = getReelsRoot(target, "getReelSpeedAt");
        if (!root) return 0;
        if (typeof reelIndex !== "number" || !Number.isFinite(reelIndex)) {
            console.warn(`[FlowState/reels] getReelSpeedAt: reelIndex must be a number, got`, reelIndex);
            return 0;
        }
        const view = getReelView(root, reelIndex);
        if (!view) {
            console.warn(`[FlowState/reels] getReelSpeedAt: no reel view for reelIndex=${reelIndex}`);
            return 0;
        }
        return typeof view.speed === "number" && Number.isFinite(view.speed) ? view.speed : 0;
    }

    /**
     * Multi-value getter describing the whole reels node.
     *
     * `reelCount` / `rowCount` come from the authored
     * `_flowstateReelsGridSize`; `spinningCount` counts reels that are live
     * (same probe as {@link isReelSpinningAt}); `spinComplete` is the
     * service's `model.spinComplete` flag.
     *
     * The four keys match the menu node's `outputs[].name` exactly. Returns
     * all zeroes / `false` when the target is missing or is not a Reels node.
     *
     * @param target - NodeRef to a Reels scene node
     */
    public getReelsGridInfo(
        target: NodeRefLike,
    ): { reelCount: number; rowCount: number; spinningCount: number; spinComplete: boolean } {
        const empty = { reelCount: 0, rowCount: 0, spinningCount: 0, spinComplete: false };
        const root = getReelsRoot(target, "getReelsGridInfo");
        if (!root) return empty;
        const service = root._flowstateReelService;
        const grid = root._flowstateReelsGridSize;
        const registeredReels = service && Array.isArray(service.model.onScreenReels)
            ? service.model.onScreenReels.length
            : 0;
        const reelCount = typeof grid?.reelCount === "number" && Number.isFinite(grid.reelCount)
            ? grid.reelCount
            : registeredReels;
        const rowCount = typeof grid?.rowCount === "number" && Number.isFinite(grid.rowCount) ? grid.rowCount : 0;

        let spinningCount = 0;
        for (let i = 0; i < reelCount; i += 1) {
            if (isReelViewSpinning(root, service, i)) spinningCount += 1;
        }

        return {
            reelCount,
            rowCount,
            spinningCount,
            spinComplete: service?.model?.spinComplete === true,
        };
    }
}

export const reels = new GenericReelsMethods();