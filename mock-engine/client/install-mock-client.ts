// MOCK BUILD bootstrap — runs FIRST in a demo build's `app` entry (see mock-build-entry.js), before
// any polyfill or game code. It refuses to start on a live host, shows an always-visible DEMO
// badge, builds the in-memory MockEngine from the build-time `ORCA_MOCK_BUILD` constant and points
// every axios copy the game uses at it. Nothing is persisted: a page reload is a fresh wallet and
// session. Pure logic lives in mock-client.ts.

import {
    AxiosLike,
    createMockBuildRuntime,
    describeLiveEnvironment,
    installMockAxiosAdapter,
    LocationLike,
    MockBuildConfig,
    MockBuildRuntime,
} from './mock-client';

/** Replaced by webpack.demo.conf.js's DefinePlugin; absent in any other build. */
declare const ORCA_MOCK_BUILD: MockBuildConfig | undefined;

export const MOCK_BUILD_BADGE_ID = 'orca-mock-build-badge';
export const MOCK_BUILD_REFUSAL_ID = 'orca-mock-build-refusal';
export const MOCK_BUILD_BADGE_TEXT = 'DEMO \u2013 mock engine';

export interface InstallMockClientOptions {
    /** Every axios module copy the game's dependencies resolve to (ESM and CommonJS builds differ). */
    axiosInstances: AxiosLike[];
    /** Defaults to the compiled-in `ORCA_MOCK_BUILD`. */
    config?: MockBuildConfig;
    location?: LocationLike;
    document?: Document;
}

function compiledConfig(): MockBuildConfig | undefined {
    return typeof ORCA_MOCK_BUILD === 'undefined' ? undefined : ORCA_MOCK_BUILD;
}

function whenBody(doc: Document | undefined, run: (body: HTMLElement) => void): void {
    if (!doc) return;
    if (doc.body) {
        run(doc.body);
        return;
    }
    doc.addEventListener('DOMContentLoaded', () => {
        if (doc.body) run(doc.body);
    });
}

function showRefusal(doc: Document | undefined, reason: string): void {
    whenBody(doc, body => {
        if (doc!.getElementById(MOCK_BUILD_REFUSAL_ID)) return;
        const panel = doc!.createElement('div');
        panel.id = MOCK_BUILD_REFUSAL_ID;
        panel.setAttribute('role', 'alert');
        panel.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:2147483647', 'display:flex', 'align-items:center',
            'justify-content:center', 'padding:24px', 'background:#2b0000', 'color:#fff',
            'font:16px/1.5 system-ui,sans-serif', 'text-align:center',
        ].join(';');
        panel.textContent =
            `This is a DEMO build that runs a mock game engine. It refuses to run here because ${reason}. ` +
            'Deploy a normal build (npm run build) to live.';
        body.appendChild(panel);
    });
}

function showBadge(doc: Document | undefined, mechanic: string): void {
    whenBody(doc, body => {
        if (doc!.getElementById(MOCK_BUILD_BADGE_ID)) return;
        const badge = doc!.createElement('div');
        badge.id = MOCK_BUILD_BADGE_ID;
        badge.textContent = MOCK_BUILD_BADGE_TEXT;
        badge.title = `Demo build: every round is played by the bundled mock engine ("${mechanic}"). Balance resets on reload.`;
        badge.style.cssText = [
            'position:fixed', 'left:6px', 'bottom:6px', 'z-index:2147483647', 'padding:2px 8px',
            'border-radius:4px', 'background:rgba(200,0,0,0.85)', 'color:#fff',
            'font:bold 11px/16px system-ui,sans-serif', 'letter-spacing:0.04em', 'pointer-events:none',
            'user-select:none',
        ].join(';');
        body.appendChild(badge);
    });
}

/**
 * Throws (after painting a visible refusal) when the page counts as live or no config was compiled
 * in — the throw stops the rest of the entry, so the game never boots. Otherwise installs the
 * adapter on every axios copy and returns the runtime.
 */
export function installMockClient(options: InstallMockClientOptions): MockBuildRuntime {
    const doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
    const location = options.location ?? (typeof window === 'undefined' ? undefined : window.location);

    const refuse = (reason: string): never => {
        showRefusal(doc, reason);
        throw new Error(`[mock-build] Refusing to start: ${reason}`);
    };

    if (!location) return refuse('the page location is unknown');
    const live = describeLiveEnvironment(location);
    if (live !== null) return refuse(live);

    const config = options.config ?? compiledConfig();
    if (!config) return refuse('no mock engine config was compiled into this build');

    let runtime: MockBuildRuntime;
    try {
        runtime = createMockBuildRuntime(config);
    } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error));
    }

    const instances = (options.axiosInstances || []).filter(Boolean);
    if (instances.length === 0) return refuse('no axios instance was handed to the mock client');
    for (const instance of instances) installMockAxiosAdapter(instance, runtime);

    showBadge(doc, runtime.mechanic.key);
    console.warn(`[mock-build] DEMO build: engine calls are answered in-page by the mock engine ("${runtime.mechanic.key}").`);
    return runtime;
}
