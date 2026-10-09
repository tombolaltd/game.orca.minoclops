import { container, delay as arcadeDelay, eventEmitter, userModel } from "@game-studio/arcade-base";
import { gameModel } from "@/src/core/models/game-model";
import { gameSettings } from "@/src/core/models/game-settings";
import { gameEventEmitter } from "@/src/events";

/**
 * Game State Methods for FlowState
 * 
 * Provides control over game state including bonus rounds, free spins,
 * game progression, and internal flags. This is the primary interface
 * for controlling game flow logic.
 * 
 * Key state flags:
 * - isInBonusRound: Currently in bonus/free spin mode
 * - hasBonus: Player triggered bonus (may resume into bonus)
 * - isComplete: Current game cycle is complete
 * - winner: Player won in current spin
 */
class GameStateMethods {
    // =====================
    // Bonus Round Control
    // =====================

    /**
     * Check if the game is currently in bonus round
     * @returns true if in bonus round
     */
    public isInBonusRound(): boolean {
        return gameModel.isInBonusRound;
    }

    /**
     * Set the bonus round state
     * @param inBonus - Whether currently in bonus round
     */
    public setInBonusRound(inBonus: boolean): void {
        gameModel.isInBonusRound = inBonus;
    }

    /**
     * Check if player has triggered a bonus (for resume)
     * @returns true if bonus has been triggered
     */
    public hasBonus(): boolean {
        return gameModel.hasBonus;
    }

    /**
     * Set the has bonus flag
     * @param hasBonus - Whether player has triggered bonus
     */
    public setHasBonus(hasBonus: boolean): void {
        gameModel.hasBonus = hasBonus;
    }

    /**
     * Get the number of free spins remaining
     * @returns Number of free spins left
     */
    public getFreeSpinsRemaining(): number {
        return gameModel.freeSpinsRemaining;
    }

    /**
     * Set the number of free spins remaining
     * @param spins - Number of free spins
     */
    public setFreeSpinsRemaining(spins: number): void {
        gameModel.freeSpinsRemaining = spins;
    }

    /**
     * Decrement free spins by one
     * @returns New remaining free spins count
     */
    public decrementFreeSpins(): number {
        gameModel.freeSpinsRemaining = Math.max(0, gameModel.freeSpinsRemaining - 1);
        return gameModel.freeSpinsRemaining;
    }

    /**
     * Check if player is in free spinning mode
     * @returns true if currently free spinning
     */
    public isFreeSpinning(): boolean {
        return gameModel.isFreeSpinning;
    }

    /**
     * Set the free spinning flag
     * @param freeSpinning - Whether currently free spinning
     */
    public setFreeSpinning(freeSpinning: boolean): void {
        gameModel.isFreeSpinning = freeSpinning;
    }

    /**
     * Get the current bonus spin number
     * @returns Current bonus spin index
     */
    public getCurrentBonusSpin(): number {
        return gameModel.currentBonusSpin;
    }

    /**
     * Set the current bonus spin number
     * @param spinNumber - Current bonus spin index
     */
    public setCurrentBonusSpin(spinNumber: number): void {
        gameModel.currentBonusSpin = spinNumber;
    }

    /**
     * Increment the bonus spin counter
     * @returns New bonus spin count
     */
    public incrementBonusSpin(): number {
        gameModel.currentBonusSpin++;
        return gameModel.currentBonusSpin;
    }

    // =====================
    // Jackpot State
    // =====================

    /**
     * Check if currently in jackpot round
     * @returns true if in jackpot round
     */
    public isInJackpot(): boolean {
        return gameModel.isInJackpot;
    }

    /**
     * Set the jackpot round state
     * @param inJackpot - Whether in jackpot round
     */
    public setInJackpot(inJackpot: boolean): void {
        gameModel.isInJackpot = inJackpot;
    }

    // =====================
    // Game Completion
    // =====================

    /**
     * Check if the current game cycle is complete
     * @returns true if game is complete
     */
    public isComplete(): boolean {
        return gameModel.isComplete;
    }

    /**
     * Set the game complete flag
     * @param complete - Whether game is complete
     */
    public setComplete(complete: boolean): void {
        gameModel.isComplete = complete;
    }

    /**
     * Check if the last spin was a winner
     * @returns true if player won
     */
    public isWinner(): boolean {
        return gameModel.winner;
    }

    /**
     * Set the winner flag
     * @param winner - Whether player won
     */
    public setWinner(winner: boolean): void {
        gameModel.winner = winner;
    }

    /**
     * Check if the game is currently in progress
     * @returns true if game is in progress
     */
    public isInProgress(): boolean {
        return gameModel.isInProgress;
    }

    /**
     * Set the in progress flag
     * @param inProgress - Whether game is in progress
     */
    public setInProgress(inProgress: boolean): void {
        gameModel.isInProgress = inProgress;
    }

    // =====================
    // Payout Information
    // =====================

    /**
     * Get the current spin payout
     * @returns Payout amount in minor currency units
     */
    public getPayout(): number {
        return gameModel.payout;
    }

    /**
     * Set the current payout
     * @param payout - Payout amount in minor currency units
     */
    public setPayout(payout: number): void {
        gameModel.payout = payout;
    }

    /**
     * Get the total game payout (main + bonus)
     * @returns Total payout amount
     */
    public getTotalGamePayout(): number {
        return gameModel.totalGamePayout;
    }

    /**
     * Set the total game payout
     * @param payout - Total payout amount
     */
    public setTotalGamePayout(payout: number): void {
        gameModel.totalGamePayout = payout;
    }

    /**
     * Get the total bonus payout
     * @returns Bonus payout amount
     */
    public getTotalBonusPayout(): number {
        return gameModel.totalBonusPayout;
    }

    /**
     * Set the total bonus payout
     * @param payout - Bonus payout amount
     */
    public setTotalBonusPayout(payout: number): void {
        gameModel.totalBonusPayout = payout;
    }

    /**
     * Get the main game (non-bonus) payout
     * @returns Main game payout amount
     */
    public getMainGamePayout(): number {
        return gameModel.mainGamePayout;
    }

    /**
     * Set the main game payout
     * @param payout - Main game payout amount
     */
    public setMainGamePayout(payout: number): void {
        gameModel.mainGamePayout = payout;
    }

    /**
     * Get the current bonus spin payout
     * @returns Current bonus spin payout
     */
    public getCurrentBonusSpinPayout(): number {
        return gameModel.currentBonusSpinPayout;
    }

    /**
     * Set the current bonus spin payout
     * @param payout - Current bonus spin payout
     */
    public setCurrentBonusSpinPayout(payout: number): void {
        gameModel.currentBonusSpinPayout = payout;
    }

    /**
     * Get the win amount accumulated so far
     * @returns Win amount so far
     */
    public getWinAmountSoFar(): number {
        return gameModel.winAmountSoFar;
    }

    /**
     * Set the win amount so far
     * @param amount - Win amount so far
     */
    public setWinAmountSoFar(amount: number): void {
        gameModel.winAmountSoFar = amount;
    }

    /**
     * Add to the win amount so far
     * @param amount - Amount to add
     * @returns New total
     */
    public addToWinAmountSoFar(amount: number): number {
        gameModel.winAmountSoFar += amount;
        return gameModel.winAmountSoFar;
    }

    // =====================
    // Reel State
    // =====================

    /**
     * Get the reel stopping positions
     * @returns Array of stopping position indices
     */
    public getReelStoppingPositions(): number[] {
        return gameModel.reelStoppingPositions;
    }

    /**
     * Set the reel stopping positions
     * @param positions - Array of stopping position indices
     */
    public setReelStoppingPositions(positions: number[]): void {
        gameModel.reelStoppingPositions = positions;
    }

    /**
     * Get the wild reel flags
     * @returns Array of booleans indicating which reels are wild
     */
    public getWildReels(): boolean[] {
        return gameModel.isWildReel;
    }

    /**
     * Set a specific reel as wild
     * @param reelIndex - Index of the reel (0-based)
     * @param isWild - Whether the reel is wild
     */
    public setWildReel(reelIndex: number, isWild: boolean): void {
        if (reelIndex >= 0 && reelIndex < gameModel.isWildReel.length) {
            gameModel.isWildReel[reelIndex] = isWild;
        }
    }

    /**
     * Reset all wild reels to false
     */
    public clearWildReels(): void {
        gameModel.isWildReel = gameModel.isWildReel.map(() => false);
    }

    /**
     * Get the reel slow down flags
     * @returns Array of booleans indicating which reels should slow down
     */
    public getReelSlowDownFlags(): boolean[] {
        return gameModel.shouldReelSlowDown;
    }

    /**
     * Set a specific reel to slow down
     * @param reelIndex - Index of the reel (0-based)
     * @param shouldSlowDown - Whether the reel should slow down
     */
    public setReelSlowDown(reelIndex: number, shouldSlowDown: boolean): void {
        if (reelIndex >= 0 && reelIndex < gameModel.shouldReelSlowDown.length) {
            gameModel.shouldReelSlowDown[reelIndex] = shouldSlowDown;
        }
    }

    // =====================
    // Game Events
    // =====================

    /**
     * Emit a game event to trigger game-specific handlers
     * @param eventName - Name of the game event
     * @param args - Optional event arguments
     */
    public emitGameEvent(eventName: string, ...args: unknown[]): void {
        gameEventEmitter.emit(eventName as any, ...args);
    }

    /**
     * Trigger the bonus round start event
     */
    public triggerBonusStart(): void {
        gameEventEmitter.emit('GAME_ON_BONUS_TRIGGERED');
    }

    /**
     * Trigger the bonus round end event
     */
    public triggerBonusEnd(): void {
        gameEventEmitter.emit('GAME_ON_BONUS_ENDED');
    }

    /**
     * Trigger the game complete event
     */
    public triggerGameComplete(): void {
        gameEventEmitter.emit('GAME_ON_COMPLETE');
    }

    /**
     * Trigger the spin start event
     */
    public triggerSpinStart(): void {
        gameEventEmitter.emit('GAME_START_SPIN');
    }

    /**
     * Trigger the show wins event
     */
    public triggerShowWins(): void {
        gameEventEmitter.emit('GAME_SHOW_WINS');
    }

    /**
     * Trigger a reel tease animation
     * @param reelIndex - Index of the reel to tease
     */
    public triggerReelTease(reelIndex: number): void {
        gameEventEmitter.emit('GAME_TEASE_REEL', reelIndex);
    }

    /**
     * Trigger a reel to become wild
     * @param reelIndex - Index of the reel to make wild
     */
    public triggerMakeReelWild(reelIndex: number): void {
        gameEventEmitter.emit('GAME_MAKE_REEL_WILD', reelIndex);
    }

    /**
     * Show the prize amount display
     * @param amount - Optional specific amount to display
     */
    public triggerShowPrize(amount?: number): void {
        // GAME_SHOW_PRIZE is typed `(amount: number) => void` — coerce optional arg.
        gameEventEmitter.emit('GAME_SHOW_PRIZE', amount ?? 0);
    }

    // =====================
    // Game Settings Access
    // =====================

    /**
     * Get the main game reels configuration
     * @returns 2D array of reel symbol indices
     */
    public getMainReels(): number[][] {
        return gameSettings.reels;
    }

    /**
     * Get the bonus spin reels configuration
     * @returns 2D array of bonus reel symbol indices
     */
    public getBonusReels(): number[][] {
        return gameSettings.bonusSpinReels;
    }

    /**
     * Get the game ID
     * @returns Current game ID
     */
    public getGameId(): number {
        return gameModel.gameId;
    }

    /**
     * Get the current play mode
     * @returns Play mode string (e.g., "Normal", "Bonus")
     */
    public getPlayMode(): string {
        return gameModel.playMode;
    }

    /**
     * Check if this is a new player (first time)
     * @returns true if new player
     */
    public isNewPlayer(): boolean {
        return gameModel.isNewPlayer;
    }

    /**
     * Set the new player flag
     * @param isNew - Whether this is a new player
     */
    public setNewPlayer(isNew: boolean): void {
        gameModel.isNewPlayer = isNew;
    }

    // =====================
    // Utility Methods
    // =====================

    /**
     * Delay execution for a specified duration
     * @param ms - Duration in milliseconds
     * @returns Promise that resolves after the delay
     */
    public async wait(ms: number): Promise<void> {
        await arcadeDelay(ms);
    }

    /**
     * Reset game state for a new spin
     */
    public resetForNewSpin(): void {
        gameModel.winner = false;
        gameModel.payout = 0;
        gameModel.isComplete = false;
        gameModel.currentBonusSpinPayout = 0;
    }

    /**
     * Reset game state for a new game cycle
     */
    public resetForNewGame(): void {
        this.resetForNewSpin();
        gameModel.totalGamePayout = 0;
        gameModel.totalBonusPayout = 0;
        gameModel.mainGamePayout = 0;
        gameModel.winAmountSoFar = 0;
        gameModel.currentBonusSpin = 0;
        this.clearWildReels();
    }
}

export const gameState = new GameStateMethods();
