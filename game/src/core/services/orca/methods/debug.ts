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

const COLOR_ARG_RE = /^(?:#|0x)?(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Log nodes take `(message, color, message2, message3, …)`: extra `message<N>`
 * inputs are appended after `color` as each last one is connected, so there is
 * always one spare, unconnected slot at the end — trailing `undefined`s are
 * dropped so it never prints. A node saved before `color` existed has no
 * colour slot, so a second value that is not a colour is logged as a message.
 */
function emitLog(level: FlowConsoleLevel, message: unknown, color: unknown, more: unknown[]): void {
    const isColor = color === undefined || (typeof color === 'string' && (color.trim() === '' || COLOR_ARG_RE.test(color.trim())));
    const values = isColor ? [message, ...more] : [message, color, ...more];
    let end = values.length;
    while (end > 1 && values[end - 1] === undefined) end--;
    for (let i = 0; i < end; i++) {
        emitFlowConsole(level, stringifyFlowValue(values[i]), { color: isColor ? color : undefined, code: 'debug-log' });
    }
}

class DebugMethods {
    /**
     * Log values to the console (standard log level), in order
     * @param value - Any value to log
     * @param color - Optional hex colour ('#ff0000'); '' = default
     * @param more - Further `message<N>` values, logged in pin order
     */
    public log(value: unknown, color?: unknown, ...more: unknown[]): void {
        emitLog('log', value, color, more);
    }

    /**
     * Log each error message to the console, in order
     */
    public logError(value: unknown, color?: unknown, ...more: unknown[]): void {
        emitLog('error', value, color, more);
    }

    /**
     * Log each warning message to the console, in order
     */
    public logWarn(value: unknown, color?: unknown, ...more: unknown[]): void {
        emitLog('warn', value, color, more);
    }

    /**
     * Log each info message to the console, in order
     */
    public logInfo(value: unknown, color?: unknown, ...more: unknown[]): void {
        emitLog('info', value, color, more);
    }

    /**
     * Log each debug message to the console, in order
     */
    public logDebug(value: unknown, color?: unknown, ...more: unknown[]): void {
        emitLog('verbose', value, color, more);
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