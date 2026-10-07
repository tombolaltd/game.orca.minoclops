// MOCK: stands in for ArcadeB2BApi's route surface — B2B-Arcade/ArcadeB2BApi/Program.cs
// (instance purposes / route registration) and Endpoints/ArcadeB2BEndpoints.{cs,Standard.cs}
// (`POST /{game}/{begin,continue,resume,potvalues}`, plus the always-present operational
// `GET /diagnostics` and `GET /ping`). It is an Express-shaped middleware so a webpack
// dev-server can host the engine in-process; style and the `req.method` guard follow
// `createOrcaAssetsDevMiddleware` in game/build/orca-project-assets.js.
//
// One route has NO counterpart in the real API: `POST /sim` runs the bounded in-process RTP
// simulator (`sim/runMechanicSimulation.ts`) so an authoring tool can check a mechanic's maths
// without a second maths implementation. It lives here rather than in the CommonJS dev-server
// bridge so the bridge — a user-customizable file — needs no change at all.
//
// webpack-dev-server v4 registers NO body parser, so the request stream is read and parsed
// here, under a size cap, and any failure becomes a MalformedOrIncompleteRequest envelope.
//
// CORS: the editor's game preview reaches these routes through a redirect away from the real
// engine host, and the browser then sends `Origin: null`. The four engine routes answer that
// (and loopback origins) so the preview can read the mock's replies; no other origin is allowed.

import { ArcadeResultCode } from '../core/ArcadeResultCode';
import { BaseArcadeResponse } from '../core/models/BaseArcadeResponse';
import { RequestType } from '../core/models/enums';
import { createDefaultArcadeResponse, MockArcadeRequest, MockEngine } from '../MockEngine';
import { MechanicSimulationEnvelope, MechanicSimulationOptions, runMechanicSimulation } from '../sim/runMechanicSimulation';

// Structural only — the mock has no dependencies, so Express is never imported or typed.
export interface MockEngineHttpRequest {
    method?: string;
    url?: string;
    path?: string;
    /** Already-parsed body, when something upstream did register a parser. */
    body?: unknown;
    headers?: { [name: string]: string | string[] | undefined };
    on?(event: string, listener: (chunk?: unknown) => void): unknown;
    setEncoding?(encoding: string): unknown;
}

export interface MockEngineHttpResponse {
    statusCode?: number;
    setHeader?(name: string, value: string): unknown;
    end(chunk?: string): unknown;
}

export type MockEngineMiddlewareNext = () => void;

export type MockEngineMiddleware = (req: MockEngineHttpRequest, res: MockEngineHttpResponse, next: MockEngineMiddlewareNext) => void;

export interface MockEngineMiddlewareOptions {
    /** Mounted prefix, e.g. `/mock-engine`. Default `''` → `POST /{game}/begin`. */
    basePath?: string;
    /** Request body cap. Default 1 MiB. */
    maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** `POST {basePath}/sim` — the bounded RTP simulator. */
const SIM_ACTION = 'sim';

const REQUEST_TYPE_BY_ACTION: { [action: string]: RequestType } = {
    begin: RequestType.Begin,
    continue: RequestType.Continue,
    resume: RequestType.Resume,
    potvalues: RequestType.PotValues,
};

/** `engine` may be a lazy provider so the caller keeps ownership of the engine's lifetime. */
export function createMockEngineMiddleware(
    engine: MockEngine | (() => MockEngine),
    options: MockEngineMiddlewareOptions = {},
): MockEngineMiddleware {
    const basePath = normalisePrefix(options.basePath);
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const resolveEngine = typeof engine === 'function' ? engine : () => engine;

    return function mockEngineMiddleware(req, res, next) {
        const method = (req.method || '').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD' && method !== 'POST' && method !== 'OPTIONS') return next();

        const pathname = readPathname(req);
        if (basePath.length > 0 && pathname !== basePath && !pathname.startsWith(basePath + '/')) return next();

        let rest = pathname.slice(basePath.length);
        if (rest.startsWith('/')) rest = rest.slice(1);
        if (rest.endsWith('/')) rest = rest.slice(0, -1);
        if (rest.length === 0) return next();

        if (method === 'OPTIONS') {
            const origin = allowedCorsOrigin(req);
            if (origin === undefined || !isEngineRoute(rest)) return next();
            setCorsHeaders(res, origin);
            res.setHeader?.('Access-Control-Allow-Methods', 'POST');
            res.setHeader?.('Access-Control-Allow-Headers', readHeader(req, 'access-control-request-headers') || 'content-type');
            res.setHeader?.('Access-Control-Max-Age', '600');
            res.statusCode = 204;
            res.end();
            return;
        }

        // Operational endpoints; the engine always exposes both.
        if (method === 'GET' || method === 'HEAD') {
            if (rest === 'diagnostics') return sendText(res, 200, '');
            if (rest === 'ping') return sendText(res, 200, 'pong');
            return next();
        }

        // The RTP simulator. One segment, so it can never collide with `POST /{game}/{action}`.
        if (rest === SIM_ACTION) {
            void (async () => {
                let body: unknown;
                try {
                    body = await readJsonBody(req, maxBodyBytes);
                } catch (error) {
                    return sendJson(res, 200, { ok: false, error: describeError(error) } as MechanicSimulationEnvelope);
                }
                sendJson(res, 200, await runSimulation(resolveEngine, isPlainObject(body) ? body : {}));
            })();
            return;
        }

        const match = rest.match(/^([^/]+)\/([^/]+)$/);
        const requestType = match === null ? undefined : REQUEST_TYPE_BY_ACTION[match[2].toLowerCase()];
        if (match === null || requestType === undefined) return next();

        const game = decodeSegment(match[1]);
        const corsOrigin = allowedCorsOrigin(req);
        if (corsOrigin !== undefined) setCorsHeaders(res, corsOrigin);

        void (async () => {
            let body: unknown;
            try {
                body = await readJsonBody(req, maxBodyBytes);
            } catch (error) {
                const envelope = createDefaultArcadeResponse(requestType);
                envelope.ResultCode = ArcadeResultCode.MalformedOrIncompleteRequest;
                envelope.MiscInfo = error instanceof Error ? error.message : String(error);
                // MOCK: the C# answers a malformed body with 400; the mock keeps 200 so both
                // callers can parse one envelope shape whatever happened.
                return sendJson(res, 200, envelope);
            }

            let envelope: BaseArcadeResponse;
            try {
                const request: MockArcadeRequest = { ...(isPlainObject(body) ? body : {}), game };
                envelope = await runRequest(resolveEngine(), requestType, request);
            } catch (error) {
                // MockEngine already swallows everything; this covers a broken engine provider.
                envelope = createDefaultArcadeResponse(requestType);
                envelope.ResultCode = ArcadeResultCode.UnexpectedError;
                envelope.MiscInfo = error instanceof Error ? error.message : String(error);
            }

            sendJson(res, 200, envelope);
        })();
    };
}

/**
 * Resolve the engine FIRST — building it is what registers the mechanic's tuned settings and the
 * project's active skin, which the simulation then measures — then run an isolated simulation
 * beside it. Every failure is answered in-band so a broken mechanic can never surface as an
 * unhandled rejection on the dev server.
 */
async function runSimulation(resolveEngine: () => MockEngine, body: Record<string, unknown>): Promise<MechanicSimulationEnvelope> {
    try {
        const engine = resolveEngine();
        const options: MechanicSimulationOptions = {
            mechanic: readString(body.mechanic) ?? '',
            skin: readString(body.skin),
            spins: readNumber(body.spins),
            seed: readNumber(body.seed),
            stake: readNumber(body.stake),
            maxDurationMs: readNumber(body.maxDurationMs),
            currencyCode: engine.wallet.currencyCode,
        };
        return { ok: true, result: await runMechanicSimulation(options) };
    } catch (error) {
        return { ok: false, error: describeError(error) };
    }
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function runRequest(engine: MockEngine, requestType: RequestType, request: MockArcadeRequest): Promise<BaseArcadeResponse> {
    switch (requestType) {
        case RequestType.Begin:
            return engine.begin(request);
        case RequestType.Continue:
            return engine.continue(request);
        case RequestType.Resume:
            return engine.resume(request);
        default:
            return engine.potvalues(request);
    }
}

/** `{game}/{begin|continue|resume|potvalues}` — the only routes that answer CORS. */
function isEngineRoute(rest: string): boolean {
    const match = rest.match(/^([^/]+)\/([^/]+)$/);
    return match !== null && REQUEST_TYPE_BY_ACTION[match[2].toLowerCase()] !== undefined;
}

function readHeader(req: MockEngineHttpRequest, name: string): string {
    const value = req.headers?.[name];
    return Array.isArray(value) ? value.join(', ') : value ?? '';
}

/** `null` (a redirected request) or a loopback page; anything else gets no CORS headers. */
function allowedCorsOrigin(req: MockEngineHttpRequest): string | undefined {
    const origin = readHeader(req, 'origin').trim();
    if (origin === 'null') return origin;
    return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(origin) ? origin : undefined;
}

function setCorsHeaders(res: MockEngineHttpResponse, origin: string): void {
    res.setHeader?.('Access-Control-Allow-Origin', origin);
    res.setHeader?.('Access-Control-Allow-Credentials', 'true');
    res.setHeader?.('Vary', 'Origin');
}

function readPathname(req: MockEngineHttpRequest): string {
    const raw = req.path || (req.url || '').split('?')[0] || '';
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function normalisePrefix(basePath: string | undefined): string {
    const trimmed = (basePath ?? '').trim();
    if (trimmed.length === 0 || trimmed === '/') return '';
    const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
}

function readJsonBody(req: MockEngineHttpRequest, maxBodyBytes: number): Promise<unknown> {
    if (req.body !== undefined && req.body !== null) return Promise.resolve(req.body);
    if (typeof req.on !== 'function') return Promise.resolve({});

    return new Promise((resolve, reject) => {
        let raw = '';
        let settled = false;

        const settle = (run: () => void): void => {
            if (settled) return;
            settled = true;
            run();
        };

        // Chunks arrive as strings once encoding is set; otherwise String() decodes them as UTF-8.
        req.setEncoding?.('utf8');

        req.on?.('data', chunk => {
            if (settled) return;
            raw += typeof chunk === 'string' ? chunk : String(chunk);
            if (raw.length > maxBodyBytes) settle(() => reject(new Error(`Request body exceeded ${maxBodyBytes} bytes`)));
        });

        req.on?.('end', () =>
            settle(() => {
                if (raw.trim().length === 0) return resolve({});
                try {
                    resolve(JSON.parse(raw));
                } catch (error) {
                    reject(new Error(`Request body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
                }
            }),
        );

        req.on?.('error', error => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
    });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: MockEngineHttpResponse, statusCode: number, payload: BaseArcadeResponse | MechanicSimulationEnvelope): void {
    res.statusCode = statusCode;
    res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function sendText(res: MockEngineHttpResponse, statusCode: number, payload: string): void {
    res.statusCode = statusCode;
    res.setHeader?.('Content-Type', 'text/plain; charset=utf-8');
    res.end(payload);
}
