/**
 * Debug Methods for FlowState
 * 
 * Provides various console logging utilities for debugging game state
 * and flow execution during development.
 * 
 * These methods can be called from FlowState debug nodes to output
 * information to the browser console.
 *
 * The five level methods emit tagged `orca-console:` lines carrying the
 * executing node (see ./flow-console) so the editor Console links back to it.
 */
import { emitFlowConsole, FlowConsoleLevel, stringifyFlowValue } from "./flow-console";

function emitLog(level: FlowConsoleLevel, value: unknown, color?: unknown): void {
    emitFlowConsole(level, stringifyFlowValue(value), { color, code: 'debug-log' });
}

class DebugMethods {
    /**
     * Log a value to the console (standard log level)
     * @param value - Any value to log
     * @param color - Optional hex colour ('#ff0000'); '' = default
     */
    public log(value: unknown, color?: string): void {
        emitLog('log', value, color);
    }

    /**
     * Log an error message to the console
     * @param value - Error message or object to log
     * @param color - Optional hex colour; '' = default
     */
    public logError(value: unknown, color?: string): void {
        emitLog('error', value, color);
    }

    /**
     * Log a warning message to the console
     * @param value - Warning message or object to log
     * @param color - Optional hex colour; '' = default
     */
    public logWarn(value: unknown, color?: string): void {
        emitLog('warn', value, color);
    }

    /**
     * Log an info message to the console
     * @param value - Info message or object to log
     * @param color - Optional hex colour; '' = default
     */
    public logInfo(value: unknown, color?: string): void {
        emitLog('info', value, color);
    }

    /**
     * Log a debug message to the console
     * @param value - Debug message or object to log
     * @param color - Optional hex colour; '' = default
     */
    public logDebug(value: unknown, color?: string): void {
        emitLog('verbose', value, color);
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