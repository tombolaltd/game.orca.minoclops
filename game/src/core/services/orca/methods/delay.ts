/**
 * Delay Methods for FlowState
 * 
 * Provides time-based delay utilities for pausing flow execution.
 * Useful for animations, timed events, and sequencing game actions.
 */
export class DelayMethods {
    /**
     * Pause execution for a specified number of seconds
     * @param seconds - Number of seconds to wait
     * @returns Promise that resolves after the delay
     * @example
     * // Wait 2 seconds before continuing
     * await delay.delay(2);
     */
    public delay(seconds: number): Promise<void> {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve();
            }, seconds * 1000);
        });
    }
}

export const delay = new DelayMethods();