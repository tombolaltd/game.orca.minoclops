import { OrcaComponent } from './orca-component';
import type { OrcaComponentDefinition } from './orca-component';

/**
 * Fills the help popup's paytable from the engine.
 *
 * Attach it to the table container. Row N shows symbol `firstSymbol + N`; its
 * Pay3 / Pay4 / Pay5 texts get that symbol's prize multipliers (x stake) for
 * 3, 4 and 5 matching reels, from the Settings model's `symbolPayoutData`
 * (the engine's GameSettings.Symbols, read on Resume). A pay the engine does
 * not send shows "-".
 */
export const definition: OrcaComponentDefinition = {
  name: 'EnginePaytable',
  friendlyTitle: 'Engine Paytable',
  description: 'Writes the Pay3/Pay4/Pay5 texts of every Row from the engine symbol prizes.',
  icon: '💰',
  properties: [
    { name: 'firstSymbol', type: 'int', default: 3 },
    { name: 'digits', type: 'int', default: 3 }
  ]
};

interface SymbolPayout {
  symbolID: number;
  payout: Array<{ matched: number; multiplier: number }>;
}

interface TableNode {
  id: string;
  name: string;
  children?: TableNode[];
}

export default class EnginePaytable extends OrcaComponent {
  private filled = false;

  onCreate(): void {
    this.fill();
  }

  /** The engine's settings can arrive after the scene is built, so keep trying until they do. */
  onUpdate(): void {
    if (!this.filled) this.fill();
  }

  private fill(): void {
    const data = this.orca.getSettingsModelProperty('symbolPayoutData');
    if (!Array.isArray(data) || data.length === 0) return;
    const payouts = data as SymbolPayout[];
    const first = Number(this.getProperty('firstSymbol', 3));
    const digits = Math.max(1, Number(this.getProperty('digits', 3)));
    const rows: TableNode[] = this.node.children || [];
    for (const row of rows) {
      const rowMatch = /^Row(\d+)$/.exec(row.name);
      if (!rowMatch) continue;
      const symbol = first + Number(rowMatch[1]);
      const entry = payouts.find((payout) => payout.symbolID === symbol);
      for (const cell of row.children || []) {
        const payMatch = /^Pay(\d+)$/.exec(cell.name);
        if (!payMatch) continue;
        const prize = entry ? entry.payout.find((pay) => pay.matched === Number(payMatch[1])) : undefined;
        const text = this.orca.getDisplayObjectById(cell.id);
        if (text) text.text = prize && isFinite(prize.multiplier) ? String(Number(prize.multiplier.toPrecision(digits))) : '-';
      }
    }
    this.filled = true;
  }
}
