import type { CustomNodeDefinition } from './orca-custom-node';
import { wallet } from '../methods/wallet';

/**
 * Format money prize for displahy
 *
 * Inputs below become `run`'s positional parameters, in order.
 * Outputs: none -> return void. One -> return the value.
 * Two or more -> return an object keyed by each output name.
 */
export const definition: CustomNodeDefinition = {
  name: 'formatPrize',
  friendlyTitle: 'Format money prize for displahy',
  description: '',
  icon: '🧩',
  color: '#8e44ad',
  nodeType: 'sequence',
  inputs: [{name: 'amount', type: 'int'}],
  outputs: [{name: 'formattedAmount', type: 'string'}]
};

export async function run(amount: number): Promise< string> {
  return wallet.formatMoney(amount);
}
