import { container } from "@game-studio/arcade-base";

/**
 * Cabinet Methods for FlowState (generic cabinet/chrome).
 *
 * Casino/slot/instant-win-only modes (free play, demo, bonus state,
 * reveal-all) live in `./casino-cabinet.ts`.
 */
class CabinetMethods {
    // -- Visibility -------------------------------------------------
    public showCabinet(): void { container.cabinet.show(); }
    public hideCabinet(): void { container.cabinet.hide(); }
    public disableCabinetAll(): void { container.cabinet.disableAll(); }

    // -- Game state transitions ------------------------------------
    public resetCabinet(): void {
        container.cabinet.reset({
            stake: container.currencyFormatter.precise(container.stake.currentStake),
            stakeAsPennies: container.stake.currentStake
        });
    }
    public cancelCabinetPostGameTimeout(): void { container.cabinet.cancelPostGameTimeout(); }
    public endCabinetGame(): Promise<void> { return container.cabinet.endGame(); }

    // -- Messages ---------------------------------------------------
    public setCabinetMessage(messagePortrait: string, messageLandscape: string, flash: boolean, instant: boolean): void {
        container.cabinet.setCabinetMessage({ portrait: messagePortrait, landscape: messageLandscape }, instant);
        if (flash) container.cabinet.flashMessage();
    }
    public flashCabinetMessage(): void { container.cabinet.flashMessage(); }
    public setCabinetWinMessage(showAsBonusWin?: boolean): void { container.cabinet.setCabinetWinMessage(showAsBonusWin); }
    public setCabinetLoseMessage(): void { container.cabinet.setCabinetLoseMessage(); }

    // -- Balance ----------------------------------------------------
    public setCabinetCurrentBalance(amount: string): void { container.cabinet.setCurrentBalance(amount); }

    // -- Purchase button -------------------------------------------
    public showCabinetPurchaseText(): void { container.cabinet.showPurchaseText(); }
    public hideCabinetPurchaseText(): void { container.cabinet.hidePurchaseText(); }
    public updateCabinetPurchaseText(newText: string): void { container.cabinet.updatePurchaseText(newText); }
    public enableCabinetPurchaseButton(): void { container.cabinet.enablePurchaseButton(); }
    public disableCabinetPurchaseButton(): void { container.cabinet.disablePurchaseButton(); }
    public enableCabinetPurchaseButtonInteractivity(): void { container.cabinet.enablePurchaseButtonInteractivity(); }
    public disableCabinetPurchaseButtonInteractivity(): void { container.cabinet.disablePurchaseButtonInteractivity(); }
    public bounceCabinetActionButton(): void { container.cabinet.bounceActionButton(); }

    // -- Stake controls --------------------------------------------
    public showCabinetStakeButtons(): void { container.cabinet.showStakeButtons(); }
    public hideCabinetStakeButtons(): void { container.cabinet.hideStakeButtons(); }
    public enableCabinetStakeButtons(): void { container.cabinet.enableStakeButtons(); }
    public disableCabinetStakeButtons(): void { container.cabinet.disableStakeButtons(); }
    public updateCabinetStakeButtons(): void { container.cabinet.updateStakeButtons(); }
    public enableCabinetPlusButton(): void { container.cabinet.enablePlusButton(); }
    public disableCabinetPlusButton(): void { container.cabinet.disablePlusButton(); }
    public enableCabinetMinusButton(): void { container.cabinet.enableMinusButton(); }
    public disableCabinetMinusButton(): void { container.cabinet.disableMinusButton(); }
    public animateCabinetStakeText(text: string): void { container.cabinet.animateStakeText(text); }

    // -- Game info button ------------------------------------------
    public enableCabinetGameInfoButton(): void { container.cabinet.enableGameInfoButton(); }
    public disableCabinetGameInfoButton(): void { container.cabinet.disableGameInfoButton(); }

    // -- Loading indicators ----------------------------------------
    public showCabinetLoadingSpinner(): void { container.cabinet.showLoadingSpinner(); }
    public hideCabinetLoadingSpinner(): void { container.cabinet.hideLoadingSpinner(); }
    public showCabinetActionHoldSpinner(): void { container.cabinet.showActionHoldSpinner(); }
    public hideCabinetActionHoldSpinner(): void { container.cabinet.hideActionHoldSpinner(); }

    // -- Auto play -------------------------------------------------
    public showCabinetAutoPlayPopup(): void { container.cabinet.showAutoPlayPopup(); }
    public hideCabinetAutoPlayPopup(): void { container.cabinet.hideAutoPlayPopup(); }
}

export const cabinet = new CabinetMethods();
