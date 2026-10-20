import type { CustomNodeDefinition } from './orca-custom-node';
import { gameModel } from '../../../models/game-model';
import { resolveNode } from '../methods/node-ref';
import type { NodeRefLike } from '../methods/node-ref';
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
  description: 'Splits the board\'s SplitSymbols cells showing the given symbol, leaving cells already split untouched',
  icon: '🧩',
  color: '#8e44ad',
  nodeType: 'sequence',
  inputs: [
    { name: 'split', type: 'int', description: 'Split level; plays `${animationName}${split}x`' },
    { name: 'symbol', type: 'int', description: 'Only split cells showing this symbol' },
    { name: 'reels', type: 'nodeRef', description: 'The Reels scene node' },
    { name: 'animationName', type: 'string', default: 'split', description: 'Base spine animation name; plays `${animationName}${split}x`' }
  ],
  outputs: []
};

// The board last split, so the next board can tell which split symbols merely fell rather than arrived.
let spinOutcomes: IOutcome[] | null = null;
let shownOutcome: IOutcome | null = null;
let carriedSplits = new Set<string>();

interface KeptSplit { skin: unknown; outcomes: IOutcome[]; animationName: string; }
// Symbol views that must stay split while they fall; dropped once the view shows a different symbol or a new spin starts.
const keptSplits = new WeakMap<object, KeptSplit>();
const patchedViews = new WeakSet<object>();

// Track 0 is the reel's land animation and track 1 its win / playSymbolAnimation track.
const SPLIT_TRACK = 2;
const SPLIT_PLAY_TIMEOUT_MS = 5000;

// Called once per SplitSymbolDetails entry; each call splits that entry's symbol wherever SplitSymbols marks it on the board.
export async function run(split: number, symbol: number, reelsNode: NodeRefLike, baseAnimationName: string): Promise<void> {
  const root = resolveNode<any>(reelsNode);
  const outcomes = gameModel.unplayedSpinOutcomes;
  // cascade-step bumps currentCascade past the last outcome once the final board has dropped (always so on a no-win spin).
  const outcome = outcomes[Math.min(gameModel.currentCascade, outcomes.length - 1)];
  if (!root || !outcome) return;
  if (outcome !== shownOutcome) {
    carriedSplits = outcomes === spinOutcomes && shownOutcome ? splitsAfterCascade(shownOutcome) : new Set();
    spinOutcomes = outcomes;
    shownOutcome = outcome;
  }

  const animationName = `${baseAnimationName}${split}x`;
  const cells = (outcome.SplitSymbols ?? []).filter(({ Reel, Row }) => outcome.DisplayReels?.[Reel]?.[Row] === symbol);
  await Promise.all(cells.map(({ Reel, Row }) =>
    splitCell(symbolViewAt(root, Reel, Row), animationName, carriedSplits.has(cellKey(Reel, Row)), outcomes)));

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

async function splitCell(view: any, animationName: string, carried: boolean, outcomes: IOutcome[]): Promise<void> {
  const live = view?.getFlowstateSpine?.();
  if (!live) return;
  keepSplitWhileFalling(view, animationName, outcomes);
  if (live.state.tracks[SPLIT_TRACK]?.animation?.name === animationName) {
    protectSplitTrack(view);
    return;
  }
  if (carried) {
    holdSplitPose(view, animationName);
    return;
  }
  await playSplit(view, live, animationName);
}

// The reel clears every track when a symbol is re-skinned (each cascade fall), so re-apply the held split straight after.
function keepSplitWhileFalling(view: any, animationName: string, outcomes: IOutcome[]): void {
  keptSplits.set(view, { skin: view.symbolData?.skin, outcomes, animationName });
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
        holdSplitPose(this, kept.animationName);
      }
      return result;
    };
  }
}

function holdSplitPose(view: any, animationName: string): void {
  const live = view.getFlowstateSpine?.();
  if (!live) return;
  try {
    const entry = live.state.setAnimation(SPLIT_TRACK, animationName, false);
    entry.trackTime = entry.animationEnd;
    live.update(0);
    protectSplitTrack(view);
  } catch {
    // Missing animation or skeleton: leave the symbol as the reel drew it.
  }
}

// The reel parks the spine (clearing the split) when its other tracks finish unless a track is registered as looping.
function protectSplitTrack(view: any): void {
  view.spineLoopingTracks?.add?.(SPLIT_TRACK);
}

function playSplit(view: any, live: any, animationName: string): Promise<void> {
  let entry: any;
  try {
    entry = live.state.setAnimation(SPLIT_TRACK, animationName, false);
  } catch {
    return Promise.resolve();
  }
  protectSplitTrack(view);
  live.autoUpdate = true;
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
