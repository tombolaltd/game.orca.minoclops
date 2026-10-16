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
  inputs: [
    { name: 'currentCascade', type: 'int', description: 'the cascade outcome we are at'}
  ],
  outputs: [
    { name: 'locations', type: 'object' },
    { name: 'outcomes', type: 'object' }
  ]
};

interface CascadeLocationsResult {
  locations: number[][];
  outcomes: number[][];
}

export async function run(currentCascade: number): Promise<CascadeLocationsResult> {
  console.log('[cascadeLocations] running', currentCascade);

  const outcome = gameModel.unplayedSpinOutcomes[currentCascade];
  if (!outcome) return { locations: [], outcomes: [] };

  // Wilds appear in every ways win they substitute for, so de-duplicate positions.
  const seen = new Set<string>();
  const locations: number[][] = [];
  for (const result of outcome.Results ?? []) {
    for (const { Reel, Row } of result.Positions ?? []) {
      const key = `${Reel},${Row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push([Reel, Row]);
    }
  }
  locations.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  return { locations, outcomes: outcome.DisplayReels };
}
