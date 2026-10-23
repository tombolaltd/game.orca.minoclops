import { container, gameConfig, queryStringParams } from '@game-studio/arcade-base';

import { ACTIVE_SKIN, ACTIVE_SKIN_NAME } from './active-skin';
import { ORCA_REQUEST_FIELDS } from './generated-request-fields';
import type { OrcaRequestField } from './generated-request-fields';

/**
 * Orca Server request fields: the extra key/value records authored in the Data
 * Browser, added to the game's outgoing Begin and Resume requests.
 *
 * arcade-base's `BaseGameServer` spreads its own `baseRequestData` into every
 * request it builds, so each wrapped call swaps in `{ ...baseRequestData,
 * ...fields }` and restores the original right after. Core fields arcade-base
 * sets afterwards (Skin, Stake, debug data, `gameModel.additionalBeginData`)
 * still win a clash.
 */

export type OrcaRequestFieldMode = 'begin' | 'resume';

export type OrcaRequestFieldTokens = Record<string, string>;

interface IRequestFieldCapableServer {
    baseRequestData?: unknown;
    resumeRequest?: (...args: unknown[]) => unknown;
    beginRequest?: (...args: unknown[]) => unknown;
    __orcaRequestFieldsInstalled?: boolean;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOKEN_RE = /\{\{([A-Z_]+)\}\}/g;
const MAX_DEPTH = 32;

let warned = false;

function warnOnce(message: string): void {
    if (warned) return;
    warned = true;
    console.warn(`[Orca] Server request fields: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// arcade-base's query-string getters throw when the parameter is absent.
function readQueryString(name: 'currentSkin' | 'locale'): string {
    try {
        const value = (queryStringParams as unknown as Record<string, unknown>)[name];
        return typeof value === 'string' ? value : '';
    } catch (err) {
        return '';
    }
}

function readEngineName(): string {
    try {
        const value = (gameConfig as unknown as { engineName?: unknown }).engineName;
        return typeof value === 'string' ? value : '';
    } catch (err) {
        return '';
    }
}

/** The `{{TOKEN}}` values for the current launch. */
export function buildRequestFieldTokens(): OrcaRequestFieldTokens {
    return {
        SKIN: readQueryString('currentSkin') || ACTIVE_SKIN,
        SKIN_FOLDER: ACTIVE_SKIN,
        SKIN_NAME: ACTIVE_SKIN_NAME,
        ENGINE_NAME: readEngineName(),
        LOCALE: readQueryString('locale'),
    };
}

/** Replace known `{{TOKEN}}`s in every string, recursively; unknown tokens stay verbatim. */
export function resolveRequestFieldValue(value: unknown, tokens: OrcaRequestFieldTokens, depth = 0): unknown {
    if (typeof value === 'string') {
        return value.replace(TOKEN_RE, (match, name: string) =>
            Object.prototype.hasOwnProperty.call(tokens, name) ? tokens[name] : match);
    }
    if (depth >= MAX_DEPTH) return value;
    if (Array.isArray(value)) {
        return value.map((item) => resolveRequestFieldValue(item, tokens, depth + 1));
    }
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            if (UNSAFE_KEYS.has(key)) continue;
            out[key] = resolveRequestFieldValue(value[key], tokens, depth + 1);
        }
        return out;
    }
    return value;
}

/** The resolved fields for one request, or `null` when there are none. */
export function resolveRequestFields(
    fields: ReadonlyArray<OrcaRequestField> | undefined,
    tokens: OrcaRequestFieldTokens,
): Record<string, unknown> | null {
    if (!Array.isArray(fields) || fields.length === 0) return null;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
        if (!field || typeof field.key !== 'string' || !field.key || UNSAFE_KEYS.has(field.key)) continue;
        out[field.key] = resolveRequestFieldValue(field.value, tokens);
    }
    return Object.keys(out).length > 0 ? out : null;
}

function wrapRequest(
    server: IRequestFieldCapableServer,
    method: 'resumeRequest' | 'beginRequest',
    mode: OrcaRequestFieldMode,
    fields: ReadonlyArray<OrcaRequestField>,
): void {
    const original = server[method] as (...args: unknown[]) => unknown;
    server[method] = function orcaRequestFieldsWrapper(this: unknown, ...args: unknown[]): unknown {
        let extra: Record<string, unknown> | null = null;
        try {
            extra = resolveRequestFields(fields, buildRequestFieldTokens());
        } catch (err) {
            warnOnce(`could not resolve ${mode} fields (${err})`);
        }
        const saved = server.baseRequestData;
        if (!extra || !isPlainObject(saved)) return original.apply(this, args);
        server.baseRequestData = { ...saved, ...extra };
        // arcade-base builds the request before its first await, so restoring
        // synchronously keeps the fields off any later continue request.
        try {
            return original.apply(this, args);
        } finally {
            server.baseRequestData = saved;
        }
    };
}

/**
 * Add the authored fields to the game server's Begin / Resume requests.
 * Idempotent; warns once and does nothing when the server does not look like
 * arcade-base's `BaseGameServer`. Never throws.
 */
export function installOrcaRequestFields(
    gameServer?: unknown,
    fields: { begin: ReadonlyArray<OrcaRequestField>; resume: ReadonlyArray<OrcaRequestField> } = ORCA_REQUEST_FIELDS,
): boolean {
    try {
        const begin = Array.isArray(fields?.begin) ? fields.begin : [];
        const resume = Array.isArray(fields?.resume) ? fields.resume : [];
        if (begin.length === 0 && resume.length === 0) return false;

        let server = gameServer as IRequestFieldCapableServer | undefined;
        if (server === undefined) {
            try {
                server = (container as unknown as { gameServer?: IRequestFieldCapableServer }).gameServer;
            } catch (err) {
                server = undefined;
            }
        }
        if (!server || typeof server !== 'object') {
            warnOnce('the game server is not available — fields not sent.');
            return false;
        }
        if (server.__orcaRequestFieldsInstalled) return false;
        if (!isPlainObject(server.baseRequestData)
            || typeof server.resumeRequest !== 'function'
            || typeof server.beginRequest !== 'function') {
            warnOnce('this arcade-base game server has no baseRequestData / resumeRequest / beginRequest — fields not sent.');
            return false;
        }

        if (resume.length > 0) wrapRequest(server, 'resumeRequest', 'resume', resume);
        if (begin.length > 0) wrapRequest(server, 'beginRequest', 'begin', begin);
        server.__orcaRequestFieldsInstalled = true;
        return true;
    } catch (err) {
        warnOnce(`install failed (${err})`);
        return false;
    }
}
