import type { CustomNodeDefinition } from './orca-custom-node';
import { reels } from '../methods/generic-reels';
import { spine } from '../methods/spine';
import type { NodeRefLike } from '../methods/node-ref';
/**
 * Play win animations
 *
 * Inputs below become `run`'s positional parameters, in order.
 * Outputs: none -> return void. One -> return the value.
 * Two or more -> return an object keyed by each output name.
 */
export const definition: CustomNodeDefinition = {
  name: 'playWinAnimations',
  friendlyTitle: 'Play win animations',
  description: 'Plays a row-specific win animation on every cell in locations and waits for them',
  icon: '🧩',
  color: '#8e44ad',
  nodeType: 'sequence',
  inputs: [
    { name: 'locations', type: 'any' },
    { name: 'reels', type: 'nodeRef', description: 'The Reels scene node' },
  ],
  outputs: []
};

const ROW_ANIMATIONS = ['win1', 'win2', 'win3'];

// locations is per reel: [[rows on reel 0], [rows on reel 1], ...] from cascadeLocations.
export async function run(locations: number[][], reelsNode: NodeRefLike): Promise<void> {
  const playing: Promise<void>[] = [];
  (locations ?? []).forEach((rows, reel) => {
    for (const row of rows ?? []) {
      const animationName = ROW_ANIMATIONS[row] ?? 'win';
      const done = spine.playAnimation(reels.getReelSymbolSpine(reelsNode, reel, row), animationName, false, 1, 'onComplete');
      if (done) playing.push(done);
    }
  });
  await Promise.all(playing);
}
