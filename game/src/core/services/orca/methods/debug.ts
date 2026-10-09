/**
 * Debug Methods for FlowState
 * 
 * Provides various console logging utilities for debugging game state
 * and flow execution during development.
 * 
 * These methods can be called from FlowState debug nodes to output
 * information to the browser console.
 */
class DebugMethods {
    /**
     * Log a value to the console (standard log level)
     * @param value - Any value to log
     */
    public log(value: unknown): void {
        console.log(value);
    }

    /**
     * Log an error message to the console
     * @param value - Error message or object to log
     */
    public logError(value: unknown): void {
        console.error(value);
    }

    /**
     * Log a warning message to the console
     * @param value - Warning message or object to log
     */
    public logWarn(value: unknown): void {
        console.warn(value);
    }

    /**
     * Log an info message to the console
     * @param value - Info message or object to log
     */
    public logInfo(value: unknown): void {
        console.info(value);
    }

    /**
     * Log a debug message to the console
     * @param value - Debug message or object to log
     */
    public logDebug(value: unknown): void {
        console.debug(value);
    }

    /**
     * Log a stack trace to the console
     */
    public logTrace(): void {
        console.trace();
    }

    /**
     * Start a named console group (expanded by default)
     * @param label - Label for the group
     */
    public logGroup(label: unknown): void {
        console.group(label);
    }

    /**
     * Start a named console group (collapsed by default)
     * @param label - Label for the group
     */
    public logGroupCollapsed(label: unknown): void {
        console.groupCollapsed(label);
    }

    /**
     * End the current console group
     */
    public logGroupEnd(): void {
        console.groupEnd();
    }

    /**
     * Clear the console
     */
    public logClear(): void {
        console.clear();
    }

    /**
     * Log the number of times this call has been invoked
     * @param label - Optional label for the counter
     */
    public logCount(label?: string): void {
        console.count(label);
    }

    /**
     * Reset a counter started with logCount
     * @param label - Optional label for the counter to reset
     */
    public logCountReset(label?: string): void {
        console.countReset(label);
    }

    /**
     * Start a timer with a given label
     * @param label - Label for the timer
     */
    public logTime(label: string): void {
        console.time(label);
    }

    /**
     * Stop a timer and log the elapsed time
     * @param label - Label for the timer to end
     */
    public logTimeEnd(label: string): void {
        console.timeEnd(label);
    }

    /**
     * Log the current time of a running timer without stopping it
     * @param label - Label for the timer to log
     */
    public logTimeLog(label: string): void {
        console.timeLog(label);
    }

    /**
     * Log an assertion - writes an error if the condition is false
     * @param condition - Condition to assert
     * @param message - Message to log if assertion fails
     */
    public logAssert(condition: boolean, message: unknown): void {
        console.assert(condition, message);
    }
}

export const debug = new DebugMethods();