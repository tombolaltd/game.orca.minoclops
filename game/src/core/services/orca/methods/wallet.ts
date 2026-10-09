import { container, userModel } from "@game-studio/arcade-base";
import { gameSettings } from "@/src/core/models/game-settings";

/**
 * Wallet and Currency Methods for FlowState
 * 
 * Provides access to player wallet information and currency formatting.
 * This includes real money balance, free play balance, and utility methods
 * for displaying currency values in the correct format.
 * 
 * Note: These methods are read-only and cannot modify actual wallet values
 * (which are controlled by the game server).
 */
class WalletMethods {
    // =====================
    // Balance Information
    // =====================

    /**
     * Get the player's starting balance for the current session
     * @returns Starting balance in minor currency units
     */
    public getStartBalance(): number {
        return userModel.visibleBalance.startBalance;
    }

    /**
     * Get the player's ending balance after the last transaction
     * @returns End balance in minor currency units
     */
    public getEndBalance(): number {
        return userModel.visibleBalance.endBalance;
    }

    /**
     * Get the player's free play balance
     * @returns Free play balance in minor currency units
     */
    public getFreePlayBalance(): number {
        return userModel.freePlayBalance;
    }

    /**
     * Check if the player is currently in free play mode
     * @returns true if player is using free play credits
     */
    public isInFreePlay(): boolean {
        return userModel.freePlayBalance > 0;
    }

    // =====================
    // Stake Information
    // =====================

    /**
     * Get the current selected stake amount
     * @returns Current stake in minor currency units
     */
    public getCurrentStake(): number {
        return container.stake.currentStake;
    }

    /**
     * Get all available stake options from game settings
     * @returns Array of stake amounts in minor currency units
     */
    public getStakeOptions(): number[] {
        return gameSettings.stakeOptions || [];
    }

    /**
     * Get the minimum available stake
     * @returns Minimum stake in minor currency units
     */
    public getMinStake(): number {
        const options = this.getStakeOptions();
        return options.length > 0 ? Math.min(...options) : 0;
    }

    /**
     * Get the maximum available stake
     * @returns Maximum stake in minor currency units
     */
    public getMaxStake(): number {
        const options = this.getStakeOptions();
        return options.length > 0 ? Math.max(...options) : 0;
    }

    /**
     * Get the default stake amount
     * @returns Default stake in minor currency units
     */
    public getDefaultStake(): number {
        return gameSettings.defaultStake;
    }

    /**
     * Check if player can afford the current stake
     * @returns true if end balance >= current stake
     */
    public canAffordStake(): boolean {
        return userModel.visibleBalance.endBalance >= container.stake.currentStake;
    }

    /**
     * Check if player can afford a specific amount
     * @param amount - Amount to check in minor currency units
     * @returns true if end balance >= amount
     */
    public canAfford(amount: number): boolean {
        return userModel.visibleBalance.endBalance >= amount;
    }

    // =====================
    // Currency Formatting
    // =====================

    /**
     * Format an amount with full currency symbol (e.g., "£1.50")
     * @param amount - Amount in minor currency units (pence/cents)
     * @returns Formatted currency string
     */
    public formatCurrency(amount: number): string {
        return container.currencyFormatter.precise(amount);
    }

    /**
     * Format an amount in whole units rounded
     * @param amount - Amount in minor currency units
     * @returns Formatted rounded string
     */
    public formatRounded(amount: number): string {
        return container.currencyFormatter.rounded(amount);
    }

    /**
     * VALUE-node form of {@link formatCurrency}: minor units in, the game's
     * formatted money string out (e.g. `150` → `"£1.50"`), for wiring straight
     * into a Text node. `rounded` drops the pence (`"£2"`). A non-number reads
     * as 0 rather than printing `NaN`.
     */
    public formatMoney(amount: number, rounded?: boolean): string {
        const value = Number(amount);
        const minor = Number.isFinite(value) ? Math.round(value) : 0;
        return rounded === true ? container.currencyFormatter.rounded(minor) : container.currencyFormatter.precise(minor);
    }

    /**
     * VALUE-node form of {@link getCurrentStake}: the stake the player is
     * currently playing, in minor units.
     */
    public getStakeAmount(): number {
        return container.stake.currentStake;
    }

    // =====================
    // User Information
    // =====================

    /**
     * Get the user's unique identifier
     * @returns User ID number
     */
    public getUserId(): number {
        return userModel.userId as number;
    }

    /**
     * Get the client type identifier
     * @returns Client type ID
     */
    public getClientTypeId(): number {
        return userModel.clientTypeId;
    }

    // =====================
    // Calculations
    // =====================

    /**
     * Calculate the stake multiplier for a given win amount
     * @param winAmount - Win amount in minor currency units
     * @returns Multiplier (winAmount / currentStake)
     */
    public calculateMultiplier(winAmount: number): number {
        const stake = container.stake.currentStake;
        return stake > 0 ? winAmount / stake : 0;
    }

    /**
     * Calculate profit/loss from starting balance
     * @returns Profit (positive) or loss (negative) in minor currency units
     */
    public calculateProfit(): number {
        return userModel.visibleBalance.endBalance - userModel.visibleBalance.startBalance;
    }

    /**
     * Format a stake multiplier for display (e.g., "15x")
     * @param multiplier - The multiplier value
     * @param decimals - Number of decimal places (default: 0)
     * @returns Formatted multiplier string
     */
    public formatMultiplier(multiplier: number, decimals: number = 0): string {
        return `${multiplier.toFixed(decimals)}x`;
    }
}

export const wallet = new WalletMethods();
