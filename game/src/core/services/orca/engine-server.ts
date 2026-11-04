import axiosEsm from 'axios';

import { ORCA_ENGINE_SERVER_URL } from './generated-engine-server';

/**
 * Orca Engine server URL override — the GAME half.
 *
 * Project Settings ▸ Engine server URL is baked into `generated-engine-server.ts`
 * (`origin + optional path prefix`, http/https, no trailing slash, or '' when
 * off). When set, every engine round call arcade-base / @game-studio/jackpots
 * makes to `https://<engine host>/<EngineName>/<begin|continue|resume|potvalues>`
 * goes to `<override>/<EngineName>/<action><search>` instead. EngineName and the
 * action are still appended by the game per call; only the origin (+ prefix)
 * changes. Anything else — `createsession`, wallet, auth, CDN, a URL with an
 * explicit port, a host outside the 15 below — is left exactly as it was.
 *
 * Mechanism: the same axios default-adapter wrap as the bundled mock build
 * client. The game reaches TWO axios module copies — `@game-studio/server-comms`
 * (begin / continue / resume) is a UMD that `require`s axios (the CommonJS
 * build) while `@game-studio/jackpots`' pot-value poller `import`s it (the ESM
 * build) — and each copy has its own `defaults`, so both are wrapped. Both
 * libraries call the DEFAULT instance (`axios.post`), which reads
 * `defaults.adapter` per request, so installing before `game.initialise()` is
 * early enough.
 *
 * Mock interplay. A mock engine build installs its adapter first (its webpack
 * entry runs before this file) and marks it `__orcaMockBuildAdapter`. Wrapping
 * on top of it would rewrite the engine URL BEFORE the mock could recognise it,
 * and the call would leave the page for the override server — so on any axios
 * copy whose adapter carries that mark this installer stays INERT (the mock
 * answers every round; no engine traffic leaves). The editor preview's mock
 * guard knows the override origin from main.orca and routes / cancels it there.
 *
 * Caveats (deployment, not code): an `http://` override from an `https://` page
 * is mixed content and the browser blocks it; the override server must answer
 * CORS (incl. preflight) for the page origin exactly like the real engine.
 *
 * Empty override: `installOrcaEngineServer()` touches nothing, so the build is
 * byte-for-byte as before at runtime. Idempotent, never throws, warns once.
 */

// MIRROR of `ENGINE_HOSTS` in the editor's electron/mock/mock-preview-routing.js
// (the template may not import editor code). The editor's
// `npm run check:mock-build-client` fails if the lists drift apart.
export const ORCA_ENGINE_HOSTS: readonly string[] = [
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

const ENGINE_HOST_SET = new Set(ORCA_ENGINE_HOSTS);
const ENGINE_ACTIONS = new Set(['begin', 'continue', 'resume', 'potvalues']);
const SAFE_GAME_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const INSTALLED_MARK = '__orcaEngineServerAdapter';
/** Set on the bundled mock build's adapter. Seeing it means: mock build, stay inert. */
const MOCK_BUILD_ADAPTER_MARK = '__orcaMockBuildAdapter';

// Typed structurally so this file needs nothing from axios' types beyond the import.
export interface EngineServerRequestConfig {
    url?: string;
    baseURL?: string;
}

type AdapterFn = (config: EngineServerRequestConfig) => Promise<unknown>;

export interface EngineServerAxiosLike {
    defaults: { adapter?: unknown };
    getAdapter?: (adapters: unknown, config?: unknown) => AdapterFn;
}

let warned = false;

function warnOnce(message: string): void {
    if (warned) return;
    warned = true;
    console.warn(`[Orca] Engine server URL: ${message}`);
}

/** `origin + pathname` without a trailing slash, or '' when not a usable http(s) URL. */
export function normaliseEngineServerUrl(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim() === '') return '';
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch (err) {
        return '';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The full URL axios would request (baseURL joined unless `url` is already absolute). */
export function requestUrlOf(config: EngineServerRequestConfig): string {
    const url = String(config.url ?? '');
    const base = typeof config.baseURL === 'string' ? config.baseURL : '';
    if (base && !/^([a-z][a-z\d+\-.]*:)?\/\//i.test(url)) {
        return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
    }
    return url;
}

/** `/{game}/{begin|continue|resume|potvalues}` exactly — two literal segments, nothing else. */
function isEngineRoute(pathname: string): boolean {
    const segments = pathname.split('/').filter(segment => segment.length > 0);
    if (segments.length !== 2) return false;
    const [game, action] = segments;
    if (game.includes('%') || action.includes('%')) return false;
    return SAFE_GAME_SEGMENT_RE.test(game) && ENGINE_ACTIONS.has(action.toLowerCase());
}

/**
 * `<base><path><search>` when `rawUrl` is a round call to one of the engine
 * hosts (http(s), no credentials, NO explicit port, path exactly
 * `/{game}/{action}`); otherwise null. `base` must already be normalised.
 */
export function rewriteEngineUrl(rawUrl: string, base: string): string | null {
    if (!base) return null;
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch (err) {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '' || url.port !== '') return null;
    if (!ENGINE_HOST_SET.has(url.hostname.toLowerCase().replace(/\.+$/, ''))) return null;
    if (!isEngineRoute(url.pathname)) return null;
    return `${base}${url.pathname}${url.search}`;
}

function markOf(adapter: unknown, mark: string): boolean {
    return typeof adapter === 'function' && (adapter as unknown as Record<string, unknown>)[mark] === true;
}

/**
 * Wrap one axios copy's default adapter. Returns true when it installed; false
 * when already installed, when the mock build adapter owns this copy, or when
 * the copy is not a usable axios.
 */
export function installEngineServerAdapter(target: EngineServerAxiosLike, base: string): boolean {
    // An axios instance (the default export included) is a FUNCTION with properties.
    if (!target || (typeof target !== 'object' && typeof target !== 'function') || !target.defaults) {
        warnOnce('an axios copy is unavailable — engine calls on it keep their original host.');
        return false;
    }
    const original = target.defaults.adapter;
    if (markOf(original, INSTALLED_MARK)) return false;
    if (markOf(original, MOCK_BUILD_ADAPTER_MARK)) {
        console.info('[Orca] Engine server URL: mock engine build — override inactive, the mock answers every round.');
        return false;
    }
    if (typeof original !== 'function' && typeof target.getAdapter !== 'function') {
        warnOnce('cannot resolve the axios adapter — engine calls keep their original host.');
        return false;
    }

    const resolveOriginal = (config: EngineServerRequestConfig): AdapterFn => {
        if (typeof original === 'function') return original as AdapterFn;
        return (target.getAdapter as NonNullable<EngineServerAxiosLike['getAdapter']>)(original, config);
    };

    const adapter = (config: EngineServerRequestConfig): Promise<unknown> => {
        try {
            const rewritten = rewriteEngineUrl(requestUrlOf(config), base);
            if (rewritten !== null) {
                config.url = rewritten;
                config.baseURL = undefined;
            }
        } catch (err) {
            warnOnce(`could not rewrite a request (${err}) — sent to its original host.`);
        }
        return resolveOriginal(config)(config);
    };
    (adapter as unknown as Record<string, unknown>)[INSTALLED_MARK] = true;
    target.defaults.adapter = adapter;
    return true;
}

function commonJsAxios(): EngineServerAxiosLike | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('axios');
        return (mod && mod.default ? mod.default : mod) as EngineServerAxiosLike;
    } catch (err) {
        return null;
    }
}

/**
 * Point engine round calls at the baked-in Engine server URL. No-op when it is
 * ''. Call before `game.initialise()`. Idempotent; never throws.
 */
export function installOrcaEngineServer(
    rawBase: string = ORCA_ENGINE_SERVER_URL,
    axiosCopies?: ReadonlyArray<EngineServerAxiosLike | null | undefined>,
): void {
    try {
        if (typeof rawBase !== 'string' || rawBase === '') return;
        const base = normaliseEngineServerUrl(rawBase);
        if (!base) {
            warnOnce(`"${rawBase}" is not an http(s) URL — engine calls keep their original host.`);
            return;
        }
        const copies = axiosCopies ?? [axiosEsm as unknown as EngineServerAxiosLike, commonJsAxios()];
        let installed = false;
        for (const copy of copies) {
            if (copy && installEngineServerAdapter(copy, base)) installed = true;
        }
        if (installed) console.info(`[Orca] Engine server URL: engine round calls go to ${base}/<EngineName>/<action>.`);
    } catch (err) {
        warnOnce(`install failed (${err}) — engine calls keep their original host.`);
    }
}
