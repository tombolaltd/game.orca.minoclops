import type { CustomNodeDefinition } from './orca-custom-node';
import { reels } from '../methods/generic-reels';
import { spine } from '../methods/spine';
import type { NodeRefLike } from '../methods/node-ref';
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
  description: '',
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
  cells.forEach((rows, reel) => {
    for (const row of rows ?? []) {
      const animationName = ROW_ANIMATIONS[row] ?? 'off1';
      const done = spine.playAnimation(reels.getReelSymbolSpine(reelsNode, reel, row), animationName, false, 1, 'onComplete');
      if (done) playing.push(done);
    }
  });
  await Promise.all(playing);
}


