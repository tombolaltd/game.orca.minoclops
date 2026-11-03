// MOCK BUILD — the bundled mock engine running INSIDE the game client.
//
// A "demo build" (`npm run build:demo` in game/) bundles the mock engine into the game itself, so
// a deployed demo plays without any engine behind it. This file is the pure, DOM-free half: the
// request matcher, the live-environment test, the engine construction and the axios adapter. The
// browser side effects (refusal screen, DEMO badge, installing the adapter) live in
// `install-mock-client.ts`; the webpack entry that hands it the game's axios copies is
// `mock-build-entry.js`.
//
// ⚠️ DISPOSABILITY: nothing under game/src, webpack.base.conf.js, webpack.prod.conf.js or
// build.js may reach this folder. Only `game/build/webpack.demo.conf.js` does. Checked by the
// editor's `npm run check:mock-build-isolation`.
//
// ⚠️ A PROTOTYPING mock: not RNG-certified, not audited. A demo build refuses to start on a live
// host (`describeLiveEnvironment`), and its fake wallet and session live in memory only, so every
// page reload starts a fresh session.

import { ArcadeResultCode } from '../src/core/ArcadeResultCode';
import { RequestType } from '../src/core/models/enums';
import { BaseArcadeResponse } from '../src/core/models/BaseArcadeResponse';
import { MECHANIC_CATALOG, MechanicCatalogEntry, MechanicRegistrationOptions } from '../src/games';
import { MockJackpotConfig } from '../src/jackpot/MockJackpotService';
import { createDefaultArcadeResponse, MockArcadeRequest, MockEngine, MockEngineOptions } from '../src/MockEngine';
import { GameTypeRegistry } from '../src/registry/GameTypeRegistry';
import { CryptoRandomNumberGenerator } from '../src/rng/CryptoRandomNumberGenerator';
import { GameSettingsBase } from '../src/settings/GameSettingsBase';

/** Bumped whenever the shape `game/build/mock-build-plan.js` emits changes. */
export const MOCK_BUILD_CONFIG_VERSION = 1;

/**
 * The build-time constant (`ORCA_MOCK_BUILD`), computed in Node by `game/build/mock-build-plan.js`
 * from `main.orca.projectSettings.mockEngine` + `mock-engine/settings/<mechanic>.json` through the
 * dev-server bridge's own helpers (`game/build/mock-engine.js`).
 */
export interface MockBuildConfig {
    version: number;
    mechanic: string;
    /** Registered eagerly, as the dev server registers the active skin. Others are registered on first use. */
    gameIds: string[];
    /** Already stripped of `__proto__` / `constructor` / `prototype` by the bridge's `applySettingsOverrides`. */
    settingsOverrides: Record<string, unknown> | null;
    engine: {
        seed?: number;
        startingBalance?: number;
        currencyCode?: string;
        /** Already the engine's own MockJackpotConfig (the bridge's `buildJackpotOptions`). */
        jackpot?: MockJackpotConfig;
    };
}

// ── Request matching ──────────────────────────────────────────────────────────────────────────
// MIRROR of `ENGINE_HOSTS` / `readEngineRoute` in the editor's electron/mock/mock-preview-routing.js
// (the template may not import editor code). The editor's `check:mock-build-client` test fails if
// the host lists drift apart.

export const MOCK_BUILD_ENGINE_HOSTS: readonly string[] = [
    'dev-games.tombolaarcade.co.uk',
    'stage-games.tombolaarcade.co.uk',
    'games.tombolaarcade.co.uk',
    'dev-arcade.tombola.es',
    'stage-arcade.tombola.es',
    'arcade.tombola.es',
    'dev-arcade.tombola.dk',
    'stage-arcade.tombola.dk',
    'arcade.tombola.dk',
    'dev-arcade.tombola.it',
    'stage-arcade.tombola.it',
    'arcade.tombola.it',
    'dev-arcade.tombola.se',
    'stage-arcade.tombola.se',
    'arcade.tombola.se',
];

const ENGINE_HOST_SET = new Set(MOCK_BUILD_ENGINE_HOSTS);
const SAFE_GAME_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const REQUEST_TYPE_BY_ACTION: { [action: string]: RequestType } = {
    begin: RequestType.Begin,
    continue: RequestType.Continue,
    resume: RequestType.Resume,
    potvalues: RequestType.PotValues,
};

export interface EngineRoute {
    game: string;
    action: 'begin' | 'continue' | 'resume' | 'potvalues';
}

/** `/{game}/{begin|continue|resume|potvalues}` exactly — two literal segments, nothing else. */
export function readEngineRoute(pathname: string): EngineRoute | null {
    const segments = String(pathname ?? '').split('/').filter(segment => segment.length > 0);
    if (segments.length !== 2) return null;
    const [game, rawAction] = segments;
    // A real engine segment is always literal, so percent-encoding is a normalisation mismatch.
    if (game.includes('%') || rawAction.includes('%')) return null;
    if (!SAFE_GAME_SEGMENT_RE.test(game)) return null;
    const action = rawAction.toLowerCase();
    if (REQUEST_TYPE_BY_ACTION[action] === undefined) return null;
    return { game, action: action as EngineRoute['action'] };
}

/** The engine host a URL names (exact match, trailing dot stripped), or null. */
export function engineHostOf(rawUrl: string): string | null {
    const url = parseUrl(rawUrl);
    if (url === null) return null;
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    return ENGINE_HOST_SET.has(host) ? host : null;
}

/** A routable engine call: POST, http(s), no credentials, no explicit port, an engine host, an engine route. */
export function matchEngineRequest(rawUrl: string, method: string | undefined): EngineRoute | null {
    if (String(method ?? '').trim().toUpperCase() !== 'POST') return null;
    const url = parseUrl(rawUrl);
    if (url === null) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '' || url.port !== '') return null;
    if (engineHostOf(rawUrl) === null) return null;
    return readEngineRoute(url.pathname);
}

function parseUrl(raw: string): URL | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

// ── Live refusal ──────────────────────────────────────────────────────────────────────────────

export interface LocationLike {
    hostname: string;
    search: string;
}

/**
 * Why this page would count as LIVE, or null when it would not. Mirrors arcade-base's
 * `services/environment.ts` (`?env=`, else hostname `dev-` / `.dev.` / `stage-` / `.stage.`, else a
 * `tombola` hostname is live) but STRICTER: a live-looking hostname refuses even when `?env=`
 * claims otherwise, and `?env=live` refuses on any host.
 */
export function describeLiveEnvironment(location: LocationLike): string | null {
    let env = '';
    try {
        env = (new URLSearchParams(location.search || '').get('env') || '').trim().toLowerCase();
    } catch {
        env = '';
    }
    if (env === 'live') return 'the page was opened with ?env=live';

    const host = String(location.hostname || '').toLowerCase();
    const devOrStage = host.includes('dev-') || host.includes('.dev.') || host.includes('stage-') || host.includes('.stage.');
    if (host.includes('tombola') && !devOrStage) return `"${host}" is a live tombola host`;
    return null;
}

// ── Engine ────────────────────────────────────────────────────────────────────────────────────

const UNSAFE_SETTINGS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface MockBuildRuntime {
    readonly engine: MockEngine;
    readonly mechanic: MechanicCatalogEntry;
    /** Registers the mechanic under `game` unless something already answers to it. */
    ensureGame(game: string): void;
}

type MechanicRegistration = MechanicRegistrationOptions & { settings?: GameSettingsBase };

/**
 * MIRROR of `createEngine` in game/build/mock-engine.js (the dev-server bridge): the mechanic is
 * re-registered under its own skin with the generated settings merged over its defaults (pinned to
 * the default `ActiveVersion`), then under each game id the game will call. Unlike the dev server,
 * a game id first seen at request time (a per-locale EngineName, arcade-base's `unknown` fallback)
 * is registered on demand — a demo bundle carries every skin and only learns which one at boot.
 */
export function createMockBuildRuntime(
    config: MockBuildConfig,
    catalog: readonly MechanicCatalogEntry[] = MECHANIC_CATALOG,
): MockBuildRuntime {
    if (!config || typeof config !== 'object') throw new Error('[mock-build] No mock build config was compiled in');
    if (config.version !== MOCK_BUILD_CONFIG_VERSION) {
        throw new Error(`[mock-build] Config version ${String(config.version)} is not ${MOCK_BUILD_CONFIG_VERSION}; rebuild with npm run build:demo`);
    }
    const entry = catalog.find(candidate => candidate && candidate.key === config.mechanic);
    if (entry === undefined) {
        throw new Error(`[mock-build] Unknown mechanic "${config.mechanic}" (available: ${catalog.map(c => c.key).join(', ')})`);
    }

    const registration: MechanicRegistration = {};
    if (config.settingsOverrides) {
        const defaults = entry.createDefaultSettings();
        registration.version = defaults.ActiveVersion;
        const target = defaults as unknown as Record<string, unknown>;
        for (const key of Object.keys(config.settingsOverrides)) {
            if (UNSAFE_SETTINGS_KEYS.has(key)) continue;
            target[key] = config.settingsOverrides[key];
        }
        registration.settings = defaults;
        entry.register({ ...registration } as MechanicRegistrationOptions);
    }

    const registered = new Set<string>();
    const ensureGame = (game: string): void => {
        const id = String(game ?? '').trim();
        if (!SAFE_GAME_SEGMENT_RE.test(id)) return;
        const key = id.toLowerCase();
        if (registered.has(key)) return;
        registered.add(key);
        // A game id another mechanic already answers to (its default skin) is left alone, exactly as
        // on the dev server.
        if (GameTypeRegistry.isAvailable(id)) return;
        entry.register({ ...registration, skin: id } as MechanicRegistrationOptions);
    };
    for (const id of Array.isArray(config.gameIds) ? config.gameIds : []) {
        // The active skin always takes the configured mechanic, even over a same-named default skin.
        const trimmed = String(id ?? '').trim();
        if (!SAFE_GAME_SEGMENT_RE.test(trimmed)) continue;
        registered.add(trimmed.toLowerCase());
        entry.register({ ...registration, skin: trimmed } as MechanicRegistrationOptions);
    }

    const engineConfig = config.engine || {};
    const options: MockEngineOptions = {};
    if (engineConfig.seed !== undefined) options.seed = engineConfig.seed;
    // No configured seed: every visitor and every reload gets its own sequence instead of replaying
    // DEFAULT_RNG_SEED's.
    else options.rng = new CryptoRandomNumberGenerator();
    if (engineConfig.startingBalance !== undefined) options.startingBalance = engineConfig.startingBalance;
    if (engineConfig.currencyCode !== undefined) options.currencyCode = engineConfig.currencyCode;
    if (engineConfig.jackpot && engineConfig.jackpot.enabled === true) options.jackpot = engineConfig.jackpot;

    return { engine: new MockEngine(options), mechanic: entry, ensureGame };
}

/** MIRROR of the request handling in src/http/createMockEngineMiddleware.ts, minus HTTP. */
export async function answerEngineRequest(runtime: MockBuildRuntime, route: EngineRoute, data: unknown): Promise<BaseArcadeResponse> {
    const requestType = REQUEST_TYPE_BY_ACTION[route.action];
    let body: unknown;
    try {
        body = readBody(data);
    } catch (error) {
        const envelope = createDefaultArcadeResponse(requestType);
        envelope.ResultCode = ArcadeResultCode.MalformedOrIncompleteRequest;
        envelope.MiscInfo = describeError(error);
        return envelope;
    }

    try {
        runtime.ensureGame(route.game);
        const request: MockArcadeRequest = { ...(isPlainObject(body) ? body : {}), game: route.game };
        switch (requestType) {
            case RequestType.Begin:
                return await runtime.engine.begin(request);
            case RequestType.Continue:
                return await runtime.engine.continue(request);
            case RequestType.Resume:
                return await runtime.engine.resume(request);
            default:
                return await runtime.engine.potvalues(request);
        }
    } catch (error) {
        const envelope = createDefaultArcadeResponse(requestType);
        envelope.ResultCode = ArcadeResultCode.UnexpectedError;
        envelope.MiscInfo = describeError(error);
        return envelope;
    }
}

function readBody(data: unknown): unknown {
    if (data === undefined || data === null || data === '') return {};
    if (typeof data === 'string') return JSON.parse(data);
    return data;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ── axios adapter ─────────────────────────────────────────────────────────────────────────────
// Typed structurally so this folder needs no axios types: it only touches `defaults.adapter`,
// `getAdapter` and the request config fields every axios 1.x adapter receives.

export interface AxiosRequestConfigLike {
    url?: string;
    baseURL?: string;
    method?: string;
    data?: unknown;
}

export interface AxiosResponseLike {
    data: unknown;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    config: AxiosRequestConfigLike;
    request: unknown;
}

export type AxiosAdapterLike = (config: AxiosRequestConfigLike) => Promise<unknown>;

export interface AxiosLike {
    defaults: { adapter?: unknown };
    getAdapter?: (adapters: unknown, config?: unknown) => AxiosAdapterLike;
}

/** What the adapter does with one request: answer it, refuse it, or hand it to the real adapter. */
export type MockRequestDecision =
    | { kind: 'answer'; route: EngineRoute }
    | { kind: 'refuse'; reason: string }
    | { kind: 'delegate' };

/** The full URL axios would request (baseURL joined unless `url` is already absolute). */
export function requestUrlOf(config: AxiosRequestConfigLike): string {
    const url = String(config.url ?? '');
    const base = typeof config.baseURL === 'string' ? config.baseURL : '';
    if (base && !/^([a-z][a-z\d+\-.]*:)?\/\//i.test(url)) {
        return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
    }
    return url;
}

/**
 * Engine routes are answered by the mock; any OTHER request to an engine host is refused (the
 * demo must never talk to a real engine — the same fail-closed posture as the editor preview's
 * egress guard); everything else goes to the real adapter untouched.
 */
export function decideMockRequest(config: AxiosRequestConfigLike): MockRequestDecision {
    const url = requestUrlOf(config);
    const route = matchEngineRequest(url, config.method);
    if (route !== null) return { kind: 'answer', route };
    if (engineHostOf(url) !== null) return { kind: 'refuse', reason: `mock build: refusing a non-engine request to ${url}` };
    return { kind: 'delegate' };
}

const INSTALLED_MARK = '__orcaMockBuildAdapter';

/**
 * Point one axios instance's DEFAULT adapter at the mock. The original adapter setting is
 * resolved lazily through `getAdapter` (axios 1.x accepts the `['xhr','http','fetch']` list) for
 * everything the mock does not answer. Idempotent per instance; returns false when it was already
 * installed.
 */
export function installMockAxiosAdapter(target: AxiosLike, runtime: MockBuildRuntime): boolean {
    // An axios instance (the default export included) is a FUNCTION with properties, not a plain object.
    if (!target || (typeof target !== 'object' && typeof target !== 'function') || !target.defaults) {
        throw new Error('[mock-build] Not an axios instance');
    }
    const original = target.defaults.adapter;
    if (typeof original === 'function' && (original as unknown as Record<string, unknown>)[INSTALLED_MARK] === true) return false;

    const resolveOriginal = (config: AxiosRequestConfigLike): AxiosAdapterLike => {
        if (typeof original === 'function') return original as AxiosAdapterLike;
        if (typeof target.getAdapter === 'function') return target.getAdapter(original, config);
        throw new Error('[mock-build] Cannot resolve the original axios adapter');
    };

    const adapter = (config: AxiosRequestConfigLike): Promise<unknown> => {
        const decision = decideMockRequest(config);
        if (decision.kind === 'delegate') return resolveOriginal(config)(config);
        if (decision.kind === 'refuse') return Promise.reject(new Error(decision.reason));
        return answerEngineRequest(runtime, decision.route, config.data).then(
            (envelope): AxiosResponseLike => ({
                // A string, like the wire: axios' own transformResponse parses it, so the game sees
                // exactly what a JSON response from the dev-server mock would give it.
                data: JSON.stringify(envelope),
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'application/json; charset=utf-8' },
                config,
                request: {},
            }),
        );
    };
    (adapter as unknown as Record<string, unknown>)[INSTALLED_MARK] = true;
    target.defaults.adapter = adapter;
    return true;
}
