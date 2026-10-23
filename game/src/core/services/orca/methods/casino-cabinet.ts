import { BaseChip, CabinetButtonStringOption, CasinoCabinet, container } from "@game-studio/arcade-base";

/** The selector's chips, or [] when the cabinet is not a casino cabinet. */
function casinoChips(): BaseChip[] {
    const cabinet = container.cabinet;
    if (!(cabinet instanceof CasinoCabinet) || !cabinet.chipSelector) return [];
    // `_chips` is private; arrow scrolling leaves `currentChip` stale, so read every chip.
    const chips = (cabinet.chipSelector as unknown as { _chips?: BaseChip[] })._chips;
    return Array.isArray(chips) ? chips : [];
}

/**
 * Casino-specific cabinet methods for FlowState.
 *
 * Modes / actions only relevant to casino-style games (slots,
 * instant-win): free play, demo, real-money mode, bonus-state
 * transitions, reveal-all (instant-win), free-play balance.
 */
class CasinoCabinetMethods {
    public enterCabinetFreePlay(): void { container.cabinet.enterFreePlay(); }
    public leaveCabinetFreePlay(): void { container.cabinet.leaveFreePlay(); }
    public setFreePlayBalance(amount: number): void { container.cabinet.setFreePlayBalance(amount); }

    public enterCabinetDemoMode(): void { container.cabinet.enterDemoMode(); }
    public leaveCabinetDemoMode(): void { container.cabinet.leaveDemoMode(); }
    public enterCabinetRealMoneyMode(): void { container.cabinet.enterRealMoneyMode(); }

    public enterCabinetBonusState(stateName: string, buttonText: CabinetButtonStringOption): void {
        container.cabinet.enterBonusState(stateName, buttonText);
    }
    public exitCabinetBonusState(): void { container.cabinet.exitBonusState(); }

    public setCabinetBonusMessage(delayTimeMS?: number): Promise<void> {
        return container.cabinet.setBonusMessage(delayTimeMS);
    }

    public startCabinetRevealAll(): void { container.cabinet.startRevealAll(); }
    public stopCabinetRevealAll(): void { container.cabinet.stopRevealAll(); }

    public getSelectedChipValue(): number {
        const chip = casinoChips().find((c) => c.selected === true);
        return chip ? chip.value : 0;
    }

    public getSelectedChipIndex(): number {
        return casinoChips().findIndex((c) => c.selected === true);
    }

    public getChipValues(): number[] {
        return casinoChips().filter((c) => c.selectable).map((c) => c.value);
    }

    public playChipInvalidBetAlert(): void {
        const cabinet = container.cabinet;
        if (!(cabinet instanceof CasinoCabinet) || !cabinet.chipSelector) return;
        cabinet.playInvalidBetAlert();
    }
}

export const casinoCabinet = new CasinoCabinetMethods();
