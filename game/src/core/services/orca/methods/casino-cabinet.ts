import { CabinetButtonStringOption, container } from "@game-studio/arcade-base";

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
}

export const casinoCabinet = new CasinoCabinetMethods();
