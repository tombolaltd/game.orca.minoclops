import { container } from "@game-studio/arcade-base";

/**
 * BigWin Methods for FlowState
 * 
 * Controls the BigWin celebration animation that plays when players
 * achieve significant wins (e.g., multiplier thresholds).
 * 
 * BigWin typically displays:
 * - Animated spine celebration with coin explosions
 * - Win amount counter that increments
 * - Various tiers (Big Win, Super Win, Mega Win, etc.)
 * 
 * Note: BigWin implementation varies by game. Methods use type assertions
 * to access runtime-available methods that may not be in the base interface.
 */
class BigWinMethods {
    /**
     * Get the BigWin instance with extended type for runtime methods
     */
    private get bigWin(): any {
        return container.bigWin;
    }

    /**
     * Show the BigWin animation for a winning amount
     * @param amount - The win amount to display
     * @returns Promise that resolves when animation completes
     */
    public async showBigWin(amount: number): Promise<void> {
        if (this.bigWin && typeof this.bigWin.show === 'function') {
            await this.bigWin.show(amount);
        }
    }

    /**
     * Hide the BigWin animation immediately
     */
    public hideBigWin(): void {
        if (this.bigWin && typeof this.bigWin.hide === 'function') {
            this.bigWin.hide();
        }
    }

    /**
     * Check if BigWin animation is currently playing
     * @returns true if BigWin is currently showing
     */
    public isBigWinShowing(): boolean {
        return container.bigWin?.visible || false;
    }

    /**
     * Set the duration for the count-up animation
     * @param duration - Duration in milliseconds
     */
    public setCountUpDuration(duration: number): void {
        if (container.bigWin && 'countUpDuration' in container.bigWin) {
            (container.bigWin as any).countUpDuration = duration;
        }
    }

    /**
     * Set the minimum multiplier threshold for showing BigWin
     * @param multiplier - Minimum stake multiplier (e.g., 15 for 15x stake)
     */
    public setMinimumMultiplier(multiplier: number): void {
        if (container.bigWin && 'minimumMultiplier' in container.bigWin) {
            (container.bigWin as any).minimumMultiplier = multiplier;
        }
    }

    /**
     * Skip the current BigWin animation (fast-forward to end)
     */
    public skipBigWin(): void {
        if (container.bigWin && 'skip' in container.bigWin) {
            (container.bigWin as any).skip();
        }
    }

    /**
     * Pause the BigWin animation
     */
    public pauseBigWin(): void {
        if (container.bigWin && 'pause' in container.bigWin) {
            (container.bigWin as any).pause();
        }
    }

    /**
     * Resume a paused BigWin animation
     */
    public resumeBigWin(): void {
        if (container.bigWin && 'resume' in container.bigWin) {
            (container.bigWin as any).resume();
        }
    }

    /**
     * Set the BigWin animation speed
     * @param speed - Speed multiplier (1 = normal, 2 = double speed)
     */
    public setBigWinSpeed(speed: number): void {
        if (container.bigWin && 'speed' in container.bigWin) {
            (container.bigWin as any).speed = speed;
        }
    }

    /**
     * Get the current BigWin tier based on stake multiplier
     * @param stakeMultiplier - The win amount divided by stake
     * @returns Tier name ("bigwin", "superwin", "megawin", "epicwin")
     */
    public getBigWinTier(stakeMultiplier: number): string {
        if (stakeMultiplier >= 100) return "epicwin";
        if (stakeMultiplier >= 50) return "megawin";
        if (stakeMultiplier >= 25) return "superwin";
        if (stakeMultiplier >= 15) return "bigwin";
        return "none";
    }

    /**
     * Check if an amount qualifies for BigWin based on current stake
     * @param amount - Win amount to check
     * @param multiplierThreshold - Minimum multiplier for BigWin (default: 15)
     * @returns true if amount qualifies for BigWin
     */
    public qualifiesForBigWin(amount: number, multiplierThreshold: number = 15): boolean {
        const stake = container.stake.currentStake;
        return (amount / stake) >= multiplierThreshold;
    }
}

export const bigwin = new BigWinMethods();
