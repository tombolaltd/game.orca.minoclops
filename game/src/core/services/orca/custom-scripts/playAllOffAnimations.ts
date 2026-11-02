import { Container, Graphics, GraphicsContext, Matrix } from 'pixi.js';
import { Spine } from '@esotericsoftware/spine-pixi-v8';
import type { CustomNodeDefinition } from './orca-custom-node';
import { reels } from '../methods/generic-reels';
import { spine } from '../methods/spine';
import { resolveNode } from '../methods/node-ref';
import type { NodeRefLike } from '../methods/node-ref';
import { returnToReelClock, setSplitState, splitStatesShownOn } from './playSplitSymbols';
/**
 * Play off animations
 *
 * Inputs below become `run`'s positional parameters, in order.
 * Outputs: none -> return void. One -> return the value.
 * Two or more -> return an object keyed by each output name.
 */
export const definition: CustomNodeDefinition = {
  name: 'playAllOffAnimations',
  friendlyTitle: 'Play off animations',
  description: 'Plays a row-specific off animation on every cell in locations and waits for them; a symbol split on the board it shows keeps its split pose (state2x, state3x) and its idle over its off animation. While they play, the reels are masked to the whole reel window rather than column by column, so the dust is not cut at the column edges, and the dust is drawn above every symbol',
  icon: '🧩',
  color: '#8e44ad',
  nodeType: 'sequence',
  inputs: [
    { name: 'locations', type: 'string', description: 'JSON rows per reel, e.g. [[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2]]' },
    { name: 'reels', type: 'nodeRef', description: 'The Reels scene node' }
  ],
  outputs: []
};

const ROW_ANIMATIONS = ['off1', 'off2', 'off3'];

export async function run(locations: string, reelsNode: NodeRefLike): Promise<void> {
  let cells: number[][];
  try {
    cells = JSON.parse(locations || '[]');
  } catch {
    console.warn('[playAllOffAnimations] locations is not valid JSON', locations);
    return;
  }
  const playing: Promise<void>[] = [];
  const closers = [openReelWindowMask(reelsNode)];
  try {
    // The Crumble Reels shows the board that just finished, so its split symbols crumble split.
    const root = resolveNode<any>(reelsNode);
    const splitStates = splitStatesShownOn(reelsNode);
    cells.forEach((rows, reel) => {
      for (const row of rows ?? []) {
        setSplitState(cellView(root, reel, row), splitStates.get(`${reel},${row}`) ?? null);
        const animationName = ROW_ANIMATIONS[row] ?? 'off1';
        const symbolSpine = reels.getReelSymbolSpine(reelsNode, reel, row);
        const done = spine.playAnimation(symbolSpine, animationName, false, 1, 'onComplete');
        if (done) {
          const live = cellView(root, reel, row)?.spine ?? null;
          playing.push(done.then(() => returnToReelClock(live)));
          closers.push(drawDustOnTop(reelsNode, symbolSpine, animationName));
        }
      }
    });
    await Promise.all(playing);
  } finally {
    closers.forEach((close) => close());
  }
}

// Each reel column is masked to exactly one symbol's width, so the dust puffs of the off and win
// animations (wider than a symbol) were cut in straight lines at every column edge. While they play,
// every column's mask is opened to the whole reel window (each column keeps its own top and bottom),
// and put back when the last one using it closes.
const openWindows = new WeakMap<object, { users: number; restore: () => void }>();

export function openReelWindowMask(reelsNode: NodeRefLike): () => void {
  const root = resolveNode<any>(reelsNode);
  if (!root?.children) return () => {};
  let open = openWindows.get(root);
  if (!open) {
    const columns = (root.children as any[]).filter((child) => child?.mask && child.mask.parent === child
      && child.children?.some((view: any) => typeof view?.setVisibleMaskBounds === 'function'));
    if (columns.length === 0) return () => {};
    const boxes = columns.map((column) => {
      const bounds = column.mask.getLocalBounds();
      return { column, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    });
    const left = Math.min(...boxes.map((box) => box.column.x + box.x));
    const right = Math.max(...boxes.map((box) => box.column.x + box.x + box.width));
    const swapped = boxes.map(({ column, y, height }) => {
      const mask = column.mask;
      const original = mask.context;
      mask.context = new GraphicsContext().rect(left - column.x, y, right - left, height).fill({ color: 0xffffff });
      return { mask, original };
    });
    open = {
      users: 0,
      restore: () => {
        for (const { mask, original } of swapped) {
          if (mask.destroyed) continue;
          const wide = mask.context;
          mask.context = original;
          wide?.destroy?.();
        }
      },
    };
    openWindows.set(root, open);
  }
  const shared = open;
  shared.users += 1;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    shared.users -= 1;
    if (shared.users <= 0 && openWindows.get(root) === shared) {
      openWindows.delete(root);
      shared.restore();
    }
  };
}

// A symbol's dust is part of its own skeleton, so it was drawn at that symbol's depth: under the
// columns to its right and under the lower symbols of its own column. While the symbol plays
// `animationName` (on track 1), a copy of its skeleton that shows only the dust slots plays in a
// layer above every column of these reels, frame-locked to the symbol, and the symbol hides its own dust.
const DUST_SLOT = /^dust/;
const SYMBOL_TRACK = 1;
const dustLayers = new WeakMap<object, { layer: Container; users: number }>();

export function drawDustOnTop(reelsNode: NodeRefLike, symbolSpine: NodeRefLike, animationName: string): () => void {
  const root = resolveNode<any>(reelsNode);
  const symbol = resolveNode<any>(symbolSpine);
  if (!root?.children || !(symbol instanceof Spine) || !symbol.skeleton.data.findAnimation(animationName)) return () => {};
  const placement = transformWithin(symbol, root);
  if (!placement) return () => {};
  const shared = dustLayerOf(root);
  if (!shared) return () => {};

  const dust = new Spine(symbol.skeleton.data);
  dust.autoUpdate = false;
  dust.label = 'dust-on-top';
  if (symbol.skeleton.skin) dust.skeleton.setSkin(symbol.skeleton.skin);
  dust.skeleton.setSlotsToSetupPose();
  dust.setFromMatrix(placement);
  const otherSlots = dust.skeleton.slots.filter((slot) => !DUST_SLOT.test(slot.data.name));
  dust.afterUpdateWorldTransforms = () => otherSlots.forEach((slot) => slot.setAttachment(null));
  const dustEntry = dust.state.setAnimation(0, animationName, false);
  dust.update(0);
  shared.layer.addChild(dust);
  shared.users += 1;

  const ownDust = symbol.skeleton.slots.filter((slot) => DUST_SLOT.test(slot.data.name));
  const previousHook = symbol.afterUpdateWorldTransforms;
  const followSymbol = (object: Spine) => {
    previousHook?.call(symbol, object);
    ownDust.forEach((slot) => slot.setAttachment(null));
    const entry = symbol.state.tracks[SYMBOL_TRACK];
    if (entry?.animation?.name !== animationName || dust.destroyed) return;
    dustEntry.trackTime = entry.trackTime;
    dust.update(0);
  };
  symbol.afterUpdateWorldTransforms = followSymbol;

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (symbol.afterUpdateWorldTransforms === followSymbol) symbol.afterUpdateWorldTransforms = previousHook;
    if (!dust.destroyed) dust.destroy();
    shared.users -= 1;
    if (shared.users <= 0 && dustLayers.get(root) === shared) {
      dustLayers.delete(root);
      if (!shared.layer.destroyed) shared.layer.destroy({ children: true });
    }
  };
}

function dustLayerOf(root: any): { layer: Container; users: number } | null {
  const existing = dustLayers.get(root);
  if (existing && !existing.layer.destroyed && existing.layer.parent === root) {
    root.addChild(existing.layer);
    return existing;
  }
  const box = reelWindow(root);
  if (!box) return null;
  const layer = new Container({ label: 'dust-on-top' });
  const mask = new Graphics().rect(box.left, box.top, box.right - box.left, box.bottom - box.top).fill({ color: 0xffffff });
  layer.addChild(mask);
  layer.mask = mask;
  root.addChild(layer);
  const shared = { layer, users: 0 };
  dustLayers.set(root, shared);
  return shared;
}

// The reel window in the reels' own space: the box around every column's mask.
function reelWindow(root: any): { left: number; right: number; top: number; bottom: number } | null {
  const columns = (root.children as any[]).filter((child) => child?.mask && child.mask.parent === child
    && child.children?.some((view: any) => typeof view?.setVisibleMaskBounds === 'function'));
  if (columns.length === 0) return null;
  const boxes = columns.map((column) => {
    const bounds = column.mask.getLocalBounds();
    return { left: column.x + bounds.x, right: column.x + bounds.x + bounds.width, top: column.y + bounds.y, bottom: column.y + bounds.y + bounds.height };
  });
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    right: Math.max(...boxes.map((box) => box.right)),
    top: Math.min(...boxes.map((box) => box.top)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

function transformWithin(object: any, ancestor: any): Matrix | null {
  let matrix = new Matrix();
  for (let node = object; node !== ancestor; node = node.parent) {
    if (!node) return null;
    node.updateLocalTransform?.();
    matrix = node.localTransform.clone().append(matrix);
  }
  return matrix;
}

export function cellView(root: any, reel: number, row: number): any {
  try {
    return root?._flowstateResolveSymbolCell?.(reel, row) ?? null;
  } catch {
    return null;
  }
}


