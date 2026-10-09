import type { GCSymbolView } from '@game-studio/generic-reels';
import type { CustomNodeDefinition } from './orca-custom-node';
import { resolveNode, type NodeRefLike } from '../methods/node-ref';

export const definition: CustomNodeDefinition = {
  name: 'returnReelSymbols',
  friendlyTitle: 'Return Reel Symbols',
  description: 'Returns the visible symbol objects of a Reels node (the owner of its reel service), reel by reel, top row to bottom.',
  icon: '🧩',
  color: '#8e44ad',
  nodeType: 'property',
  inputs: [
    { name: 'reels', type: 'nodeRef', description: 'Reels node that owns the reel service' }
  ],
  outputs: [
    { name: 'symbols', type: 'object' }
  ]
};

// The reel service only holds symbol IDs; the symbol objects live on the Reels root that owns it.
type ReelsRoot = {
  _flowstateReelService?: unknown;
  _flowstateReelsGridSize?: { reelCount: number; rowCount: number };
  _flowstateResolveSymbolCell?: (reelIndex: number, rowIndex: number) => GCSymbolView | null;
};

export function run(reels: NodeRefLike | ReelsRoot): GCSymbolView[] {
  const root = (reels as ReelsRoot)?._flowstateReelService
    ? (reels as ReelsRoot)
    : resolveNode<ReelsRoot>(reels as NodeRefLike);

  if (!root?._flowstateReelService) {
    console.warn('[returnReelSymbols] input is not a Reels node (no reel service)');
    return [];
  }

  const grid = root._flowstateReelsGridSize;
  const resolveCell = root._flowstateResolveSymbolCell;
  if (!grid || typeof resolveCell !== 'function') {
    console.warn('[returnReelSymbols] Reels node exposes no grid/cell resolver — rebuild the scene');
    return [];
  }

  const symbols: GCSymbolView[] = [];
  for (let reel = 0; reel < grid.reelCount; reel++) {
    for (let row = 0; row < grid.rowCount; row++) {
      const symbol = resolveCell(reel, row);
      if (symbol) symbols.push(symbol);
    }
  }
  return symbols;
}
