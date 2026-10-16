import { gameModel } from '../../../models/game-model';
import type { CustomNodeDefinition } from './orca-custom-node';

/**
 * cascadeLocations
 *
 * Inputs below become `run`'s positional parameters, in order.
 * Outputs: none -> return void. One -> return the value.
 * Two or more -> return an object keyed by each output name.
 */
export const definition: CustomNodeDefinition = {
  name: 'cascadeLocations',
  friendlyTitle: 'Return Cascade Locations',
  description: 'Returns the locations of the symbols to remove from the game model using the supplied cascade count',
  icon: '🧩',
  color: '#8e44ad',
  nodeType: 'property',
  inputs: [],
  outputs: [
    { name: 'locations', type: 'any' },
    { name: 'outcomes', type: 'any' }

  ]
};

export async function run(): Promise<{ locations: number[][]; outcomes: number[][] }> {
  return {
    locations: gameModel.currentCascadeTargets(0),
    outcomes: gameModel.getReelsAfterCascade()
  };
}
