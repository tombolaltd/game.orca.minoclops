/**
 * MOCK BUILD plan — the build-time half of a DEMO build (`npm run build:demo`).
 *
 * Turns `orca-project-files/main.orca` `projectSettings.mockEngine` and
 * `mock-engine/settings/<mechanic>.json` into the `ORCA_MOCK_BUILD` constant
 * that `webpack.demo.conf.js` compiles into the bundle, using the dev-server
 * bridge's OWN helpers (`./mock-engine`), so the preview and a demo build turn
 * the same config into the same engine:
 *
 *   - `normaliseMockEngineConfig` (via `readMockEngineConfig`) — the config;
 *   - `listMechanicKeys` — loads `mock-engine/src` in Node (the bridge's
 *     `.ts` require hook) and lists the catalog, so an unknown mechanic or a
 *     tree that does not even load fails the BUILD, not the player's page;
 *   - `applySettingsOverrides` — strips the prototype-poisoning keys;
 *   - `buildJackpotOptions` — merges sparse pot overrides over the engine's
 *     own default pots.
 *
 * Every failure THROWS with a `[build:demo]` message: unlike the dev server,
 * a demo build must never quietly ship without its engine.
 *
 * ⚠️ Required ONLY by `webpack.demo.conf.js`. Never require it from build.js,
 * webpack.base.conf.js, webpack.prod.conf.js or game/src — checked by the
 * editor's `npm run check:mock-build-isolation`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MOCK_ENGINE_ROOT = path.join(PROJECT_ROOT, 'mock-engine');
const MOCK_CLIENT_ENTRY = path.join(MOCK_ENGINE_ROOT, 'client', 'mock-build-entry.js');
const MOCK_CLIENT_TSCONFIG = path.join(MOCK_ENGINE_ROOT, 'client', 'tsconfig.json');
const MAIN_ORCA_PATH = path.join(PROJECT_ROOT, 'orca-project-files', 'main.orca');

/** Must equal MOCK_BUILD_CONFIG_VERSION in mock-engine/client/mock-client.ts. */
const MOCK_BUILD_CONFIG_VERSION = 1;

function fail(message) {
  const error = new Error(`[build:demo] ${message}`);
  error.mockBuild = true;
  return error;
}

/** The mock-engine tree a demo build needs, or a clear error naming what is missing. */
function assertMockEngineTree() {
  const required = [
    path.join(MOCK_ENGINE_ROOT, 'src', 'index.ts'),
    path.join(MOCK_ENGINE_ROOT, 'src', 'games', 'index.ts'),
    MOCK_CLIENT_ENTRY,
    path.join(MOCK_ENGINE_ROOT, 'client', 'install-mock-client.ts'),
    path.join(MOCK_ENGINE_ROOT, 'client', 'mock-client.ts'),
    MOCK_CLIENT_TSCONFIG,
  ];
  const missing = required.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw fail(
      `the bundled mock engine is missing or out of date — ${missing.map((file) => path.relative(PROJECT_ROOT, file)).join(', ')} ` +
        'not found. Open the project in Orca to restore mock-engine/, or use `npm run build` for a normal build.'
    );
  }
}

/**
 * @returns {{ version: number, mechanic: string, gameIds: string[], settingsOverrides: Record<string, unknown> | null,
 *   engine: { seed?: number, startingBalance?: number, currencyCode?: string, jackpot?: object } }}
 */
function resolveMockBuildPlan() {
  assertMockEngineTree();

  let bridge;
  try {
    bridge = require('./mock-engine');
  } catch (err) {
    throw fail(`could not load build/mock-engine.js: ${err && err.message}`);
  }
  for (const name of ['readMockEngineConfig', 'listMechanicKeys', 'readMechanicSettingsCached', 'loadMockEngineModule', 'applySettingsOverrides', 'buildJackpotOptions']) {
    if (typeof bridge[name] !== 'function') {
      throw fail(`build/mock-engine.js is out of date (no ${name}); open the project in Orca to update it.`);
    }
  }

  if (!fs.existsSync(MAIN_ORCA_PATH)) {
    throw fail(`${path.relative(PROJECT_ROOT, MAIN_ORCA_PATH)} not found — a demo build reads its mock engine settings from it.`);
  }
  const config = bridge.readMockEngineConfig();
  if (config === null) {
    throw fail(
      'main.orca has no projectSettings.mockEngine — choose a mechanic in Project Settings ▸ Mock Backend before building a demo.'
    );
  }

  const keys = bridge.listMechanicKeys();
  if (keys.length === 0) {
    throw fail('mock-engine/src failed to load in Node (see the [mock-engine] warning above); fix it before building a demo.');
  }
  if (!keys.includes(config.mechanic)) {
    throw fail(`unknown mock engine mechanic "${config.mechanic}" in main.orca (available: ${keys.join(', ')}).`);
  }

  const settingsRead = bridge.readMechanicSettingsCached(config.mechanic);
  const settingsOverrides = settingsRead && settingsRead.value
    ? JSON.parse(JSON.stringify(bridge.applySettingsOverrides(Object.create(null), settingsRead.value)))
    : null;

  const engine = {};
  if (config.seed !== undefined) engine.seed = config.seed;
  if (config.startingBalance !== undefined) engine.startingBalance = config.startingBalance;
  if (config.currencyCode !== undefined) engine.currencyCode = config.currencyCode;
  if (config.jackpot && config.jackpot.enabled === true) {
    const mod = bridge.loadMockEngineModule();
    if (!mod) throw fail('mock-engine/src failed to load in Node; cannot build the jackpot config.');
    engine.jackpot = JSON.parse(JSON.stringify(bridge.buildJackpotOptions(mod, config.jackpot)));
  }

  // The dev server registers the mechanic under the active skin; a demo bundle
  // carries EVERY skin, so register them all up front (any other id the game
  // calls is registered on first use by the client).
  const gameIds = [];
  try {
    const assets = require('./orca-project-assets');
    const active = typeof assets.readActiveSkin === 'function' ? assets.readActiveSkin() : '';
    const all = typeof assets.getAllSkinFolders === 'function' ? assets.getAllSkinFolders() : [];
    for (const id of [active, ...all]) {
      if (typeof id === 'string' && id.trim() && !gameIds.includes(id.trim())) gameIds.push(id.trim());
    }
  } catch (err) {
    console.warn(`[build:demo] could not read the project's skins (${err && err.message}); game ids will register on first use.`);
  }

  return {
    version: MOCK_BUILD_CONFIG_VERSION,
    mechanic: config.mechanic,
    gameIds,
    settingsOverrides,
    engine,
  };
}

module.exports = {
  PROJECT_ROOT,
  MOCK_ENGINE_ROOT,
  MOCK_CLIENT_ENTRY,
  MOCK_CLIENT_TSCONFIG,
  MOCK_BUILD_CONFIG_VERSION,
  assertMockEngineTree,
  resolveMockBuildPlan,
};
