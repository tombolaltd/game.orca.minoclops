import type { CustomNodeDefinition } from './orca-custom-node';
import { gameModel } from '../../../models/game-model';
import { resolveNode } from '../methods/node-ref';
import type { NodeRefLike } from '../methods/node-ref';
import { customFireEvents } from '../methods/fireEvent';
import sceneManager from '../scene-manager';
import type { IOutcome } from './orca-types';

/**
 * Play split symbols
 *
 * Inputs below become `run`'s positional parameters, in order.
 * Outputs: none -> return void. One -> return the value.
 * Two or more -> return an object keyed by each output name.
 */
export const definition: CustomNodeDefinition = {
  name: 'playSplitSymbols',
  friendlyTitle: 'Play split symbols',
  description: 'Splits the board\'s SplitSymbols cells showing the given symbol, leaving cells already split untouched. From the end of its split, each split symbol keeps `${stateAnimationName}${split}x` layered over every animation it plays next, and loops its idle animation for as long as it stays split',
  icon: '🧩',
  color: '#8e44ad',
  nodeType: 'sequence',
  inputs: [
    { name: 'split', type: 'int', description: 'Split level; plays `${animationName}${split}x`' },
    { name: 'symbol', type: 'int', description: 'Only split cells showing this symbol' },
    { name: 'reels', type: 'nodeRef', description: 'The Reels scene node' },
    { name: 'animationName', type: 'string', default: 'split', description: 'Base spine animation name; plays `${animationName}${split}x`' },
    { name: 'stateAnimationName', type: 'string', default: 'state', description: 'Base name of the pose a split symbol keeps from the end of its split, layered over every animation it plays next (win, land, off): `${stateAnimationName}${split}x`' },
    { name: 'stateBlend', type: 'float', default: 0.2, description: 'Seconds to blend from the last frame of the split into that pose' },
    { name: 'idleAnimationName', type: 'string', default: 'idle', description: 'Looped on each split symbol from the end of its split for as long as it stays split, falls included; empty plays none' }
  ],
  outputs: []
};

// The board last split, so the next board can tell which split symbols merely fell rather than arrived.
let spinOutcomes: IOutcome[] | null = null;
let shownOutcome: IOutcome | null = null;
let carriedSplits = new Set<string>();
// How each split cell of the last board split here shows, for the Crumble Reels' copy of that board (playAllOffAnimations).
let splitBoard: { reels: number[][]; cells: Map<string, { state: string; idle: string; view: object | null }> } | null = null;

/** How a split cell shows: the pose it keeps, the idle it loops and when that idle's current loop began (performance.now() ms). */
export interface ShownSplit { state: string; idle: string; idleSince?: number; }

interface KeptSplit { skin: unknown; outcomes: IOutcome[]; stateName: string; idleName: string; }
// Symbol views that must stay split while they fall; dropped once the view shows a different symbol or a new spin starts.
const keptSplits = new WeakMap<object, KeptSplit>();
const patchedViews = new WeakSet<object>();
// When each split symbol's idle loop began, so a symbol redrawn mid-board (a cascade fall, a resize) carries on where it was.
const idleSince = new WeakMap<object, number>();

// Track 0 is the reel's land animation and track 1 its win / off / playSymbolAnimation track; the split, then its pose, play
// on track 2 above both, so the pose (attachments only) layers over every animation the symbol plays next.
const SPLIT_TRACK = 2;
// The idle plays on the track above, so it moves the split pieces under every pose and animation below it.
const IDLE_TRACK = 3;
const SPLIT_PLAY_TIMEOUT_MS = 5000;
const DEFAULT_STATE_BLEND = 0.2;

// Called once per SplitSymbolDetails entry; each call starts that entry's symbol splitting without waiting, so the loop splits all symbols together.
export async function run(split: number, symbol: number, reelsNode: NodeRefLike, baseAnimationName: string, stateAnimationName: string, stateBlend: number, idleAnimationName: string): Promise<void> {
  const root = resolveNode<any>(reelsNode);
  const outcomes = gameModel.unplayedSpinOutcomes;
  // cascade-step bumps currentCascade past the last outcome once the final board has dropped (always so on a no-win spin).
  const outcome = outcomes[Math.min(gameModel.currentCascade, outcomes.length - 1)];
  if (!root || !outcome) return;
  if (outcome !== shownOutcome) {
    carriedSplits = outcomes === spinOutcomes && shownOutcome ? splitsAfterCascade(shownOutcome) : new Set();
    spinOutcomes = outcomes;
    shownOutcome = outcome;
    splitBoard = { reels: outcome.DisplayReels ?? [], cells: new Map() };
    fireSplittingEvent(outcome);
  }

  const splitName = `${baseAnimationName || 'split'}${split}x`;
  const stateName = `${stateAnimationName || 'state'}${split}x`;
  const idleName = idleAnimationName === undefined || idleAnimationName === null ? 'idle' : String(idleAnimationName).trim();
  const blendSeconds = Number(stateBlend);
  const blend = Number.isFinite(blendSeconds) && blendSeconds >= 0 ? blendSeconds : DEFAULT_STATE_BLEND;
  const cells = (outcome.SplitSymbols ?? []).filter(({ Reel, Row }) => outcome.DisplayReels?.[Reel]?.[Row] === symbol);
  for (const { Reel, Row } of cells) {
    const view = symbolViewAt(root, Reel, Row);
    splitBoard?.cells.set(cellKey(Reel, Row), { state: stateName, idle: idleName, view });
    void splitCell(view, splitName, stateName, idleName, blend, carriedSplits.has(cellKey(Reel, Row)), outcomes);
  }

  // This board's winning symbols are removed by the next cascade, so they must not stay split.
  for (const result of outcome.Results ?? []) {
    for (const { Reel, Row } of result.Positions ?? []) {
      const view = symbolViewAt(root, Reel, Row);
      if (view) keptSplits.delete(view);
    }
  }
}

function symbolViewAt(root: any, reel: number, row: number): any {
  try {
    return root._flowstateResolveSymbolCell?.(reel, row) ?? null;
  } catch {
    return null;
  }
}

async function splitCell(view: any, splitName: string, stateName: string, idleName: string, blend: number, carried: boolean, outcomes: IOutcome[]): Promise<void> {
  const live = view?.getFlowstateSpine?.();
  if (!live) return;
  keepSplitWhileFalling(view, stateName, idleName, outcomes);
  const current = live.state.tracks[SPLIT_TRACK]?.animation?.name;
  if (current === splitName || current === stateName) {
    protectSplitTrack(view);
    if (current === stateName) startIdle(view, live, idleName);
    return;
  }
  if (carried) {
    holdSplitState(view, stateName, idleName);
    return;
  }
  // Not awaited: the graph's own delay after this node decides how long the split gets.
  void playSplit(view, live, splitName, stateName, idleName, blend);
}

// The reel clears every track when a symbol is re-skinned (each cascade fall), so re-apply its split pose straight after.
function keepSplitWhileFalling(view: any, stateName: string, idleName: string, outcomes: IOutcome[]): void {
  keptSplits.set(view, { skin: view.symbolData?.skin, outcomes, stateName, idleName });
  if (patchedViews.has(view)) return;
  patchedViews.add(view);
  for (const method of ['setAnimationSkin', 'setStaticSkin']) {
    const original = view[method];
    if (typeof original !== 'function') continue;
    view[method] = function (this: any, ...args: unknown[]) {
      const result = original.apply(this, args);
      const kept = keptSplits.get(this);
      if (!kept) return result;
      if (kept.outcomes !== gameModel.unplayedSpinOutcomes || this.symbolData?.skin !== kept.skin) {
        keptSplits.delete(this);
      } else {
        holdSplitState(this, kept.stateName, kept.idleName);
      }
      return result;
    };
  }
}

// The symbol shows its split pose at once, layered over whatever plays on the tracks below, and goes on idling.
function holdSplitState(view: any, stateName: string, idleName: string, since?: number): void {
  const live = view?.getFlowstateSpine?.();
  if (!live) return;
  try {
    const entry = live.state.setAnimation(SPLIT_TRACK, stateName, false);
    entry.mixDuration = 0;
    protectSplitTrack(view);
  } catch {
    // Missing animation or skeleton: leave the symbol as the reel drew it.
    return;
  }
  startIdle(view, live, idleName, since);
  live.update(0);
}

// Loops the idle on its own track at the point of its loop the symbol had reached (or `since`, to match another copy of it).
function startIdle(view: any, live: any, idleName: string, since?: number): void {
  const idle = idleName ? live.skeleton?.data?.findAnimation?.(idleName) : null;
  if (!idle) return;
  const now = performance.now();
  if (since !== undefined) idleSince.set(view, since);
  let start = idleSince.get(view);
  if (start === undefined || start > now) {
    start = now;
    idleSince.set(view, start);
  }
  const phase = idle.duration > 0 ? ((now - start) / 1000) % idle.duration : 0;
  const track = live.state.tracks[IDLE_TRACK];
  try {
    if (track?.animation?.name === idleName) {
      if (since !== undefined) track.trackTime = phase;
    } else if (track?.next?.animation?.name !== idleName) {
      const entry = live.state.setAnimation(IDLE_TRACK, idleName, true);
      entry.mixDuration = 0;
      entry.trackTime = phase;
    }
  } catch {
    return;
  }
  view.spineLoopingTracks?.add?.(IDLE_TRACK);
  tickOnce(live);
}

// The idle starts the moment the split ends, from its first frame: the split leaves every piece at rest.
function queueIdle(view: any, live: any, idleName: string, delay: number): void {
  if (!idleName || !live.skeleton?.data?.findAnimation?.(idleName)) return;
  try {
    live.state.setEmptyAnimation(IDLE_TRACK, 0);
    live.state.addAnimation(IDLE_TRACK, idleName, true, delay).mixDuration = 0;
  } catch {
    return;
  }
  idleSince.set(view, performance.now() + delay * 1000);
  view.spineLoopingTracks?.add?.(IDLE_TRACK);
}

// One clock per symbol: its own ticker, as the reel view uses. The scene's ticker as well would play it at double speed.
function tickOnce(live: any): void {
  sceneManager.untrackSpineForUpdates(live);
  live.autoUpdate = true;
}

/**
 * Hands a reel symbol back to the reel's own clock once an animation played through the general spine player is over.
 * That player runs the symbol on the scene's clock and leaves it there, and the reel turns its own clock on for the next
 * symbol landing in that cell, so its land animation (the spool's looping idle) would play at double speed.
 */
export function returnToReelClock(live: any): void {
  if (!live) return;
  if (live.visible) tickOnce(live);
  else sceneManager.untrackSpineForUpdates(live);
}

// The reel parks the spine (clearing the split) when its other tracks finish unless a track is registered as looping.
function protectSplitTrack(view: any): void {
  view.spineLoopingTracks?.add?.(SPLIT_TRACK);
}

// The split, then its pose: queued to start the moment the split ends, blending out of the split's last frame.
function playSplit(view: any, live: any, splitName: string, stateName: string, idleName: string, blend: number): Promise<void> {
  let entry: any;
  try {
    entry = live.state.setAnimation(SPLIT_TRACK, splitName, false);
  } catch {
    return Promise.resolve();
  }
  try {
    live.state.addAnimation(SPLIT_TRACK, stateName, false, 0).mixDuration = blend;
  } catch {
    // No such pose: the symbol keeps the split's last frame.
  }
  queueIdle(view, live, idleName, Math.max(0, entry.animation?.duration ?? 0));
  protectSplitTrack(view);
  tickOnce(live);
  return new Promise(resolve => {
    const finish = (settled: unknown) => {
      if (settled !== entry) return;
      live.state.removeListener(listener);
      clearTimeout(timeout);
      resolve();
    };
    const listener = { complete: finish, interrupt: finish, dispose: finish };
    const timeout = setTimeout(() => finish(entry), SPLIT_PLAY_TIMEOUT_MS);
    live.state.addListener(listener);
  });
}

function cellKey(reel: number, row: number): string {
  return `${reel},${row}`;
}

/**
 * For a reels node showing the last board split here (the Crumble Reels' copy of it): how each split cell shows,
 * keyed "reel,row". Empty when that reels node shows any other board.
 */
export function splitStatesShownOn(reelsNode: NodeRefLike): Map<string, ShownSplit> {
  const board = splitBoard;
  const root = resolveNode<any>(reelsNode);
  if (!board || !root || board.cells.size === 0) return new Map();
  for (let reel = 0; reel < board.reels.length; reel++) {
    for (let row = 0; row < (board.reels[reel]?.length ?? 0); row++) {
      if (symbolViewAt(root, reel, row)?.symbolData?.skin !== board.reels[reel][row]) return new Map();
    }
  }
  const shown = new Map<string, ShownSplit>();
  for (const [key, cell] of board.cells) {
    shown.set(key, { state: cell.state, idle: cell.idle, idleSince: cell.view ? idleSince.get(cell.view) : undefined });
  }
  return shown;
}

/** Shows the symbol in `view` split as `shown` says, over every animation it plays next; null takes any split pose and idle off it. */
export function setSplitState(view: any, shown: ShownSplit | null): void {
  if (!view) return;
  if (shown) {
    holdSplitState(view, shown.state, shown.idle, shown.idleSince);
    return;
  }
  const spine = view.spine;
  const tracks = spine?.state?.tracks;
  if (!tracks?.[SPLIT_TRACK] && !tracks?.[IDLE_TRACK]) return;
  try {
    spine.state.clearTrack(SPLIT_TRACK);
    spine.state.clearTrack(IDLE_TRACK);
    spine.skeleton.setToSetupPose();
  } catch {
    // no-op
  }
  view.spineLoopingTracks?.delete?.(SPLIT_TRACK);
  view.spineLoopingTracks?.delete?.(IDLE_TRACK);
}

function splitLevelsBySymbol(): Map<number, number> {
  const levels = new Map<number, number>();
  for (const detail of gameModel.splitSymbolDetails) levels.set(detail.Symbol, detail.Split);
  return levels;
}

function fireSplittingEvent(outcome: IOutcome): void {
  const splitBySymbol = splitLevelsBySymbol();

  let highest = 0;
  for (const { Reel, Row } of outcome.SplitSymbols ?? []) {
    if (carriedSplits.has(cellKey(Reel, Row))) continue;
    const level = splitBySymbol.get(outcome.DisplayReels?.[Reel]?.[Row] ?? -1) ?? 0;
    if (level > highest) highest = level;
  }
  if (highest > 0) customFireEvents.fireCustomEvent('symbolsSplitting', ['splitAmount'], highest);
}

// Where the previous board's split symbols end up once its winning cells are removed and the rest fall.
function splitsAfterCascade(previous: IOutcome): Set<string> {
  const removedRows = new Map<number, number[]>();
  for (const result of previous.Results ?? []) {
    for (const { Reel, Row } of result.Positions ?? []) {
      const rows = removedRows.get(Reel) ?? [];
      if (!rows.includes(Row)) rows.push(Row);
      removedRows.set(Reel, rows);
    }
  }
  const carried = new Set<string>();
  for (const { Reel, Row } of previous.SplitSymbols ?? []) {
    const removed = removedRows.get(Reel) ?? [];
    if (removed.includes(Row)) continue;
    carried.add(cellKey(Reel, Row + removed.filter(row => row > Row).length));
  }
  return carried;
}
