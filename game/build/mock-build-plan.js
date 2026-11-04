/**
 * MOCK ENGINE build — the build-time half of a production build with the mock
 * engine baked in (AGENTS.md rule 27).
 *
 * Orca writes `build/generated-mock-build.json` from Data Browser ▸ Server
 * Connection ▸ "Use mock engine". When it says `enabled: true`,
 * `webpack.prod.conf.js` calls `applyMockBuild(webpackConfig)`, which:
 *
 *   - prepends `mock-engine/client/mock-build-entry.js` to `entry.app`, so the
 *     live-host refusal and the always-visible MOCK ENGINE badge run before
 *     any game code, and every engine call (begin / continue / resume /
 *     potvalues) is answered in the browser by an axios adapter;
 *   - gives mock-engine/ its own transpile-only ts-loader pass (it is not in
 *     the game's tsconfig program) and keeps the game's rule off it;
 *   - resolves `axios` from the game's node_modules (mock-engine/ is a sibling
 *     of game/);
 *   - compiles in `ORCA_MOCK_BUILD`, the engine config, resolved HERE with the
 *     dev-server bridge's own helpers (`./mock-engine`) so the preview and a
 *     build turn the same config into the same engine:
 *       `normaliseMockEngineConfig` — the generated `config`;
 *       `listMechanicKeys` — loads mock-engine/src in Node, so an unknown
 *         mechanic or a tree that does not load fails the BUILD;
 *       `readMechanicSettingsCached` + `applySettingsOverrides` —
 *         mock-engine/settings/<mechanic>.json, prototype keys stripped;
 *       `buildJackpotOptions` — sparse pot overrides over the engine's
 *         default pots.
 *
 * Every failure THROWS with a `[build] mock engine:` message: an enabled build
 * must never quietly ship talking to the real engine, nor without its mock.
 * The fake wallet lives in memory only — every page reload starts fresh.
 *
 * ⚠️ Required ONLY from webpack.prod.conf.js's enabled branch. Never require it
 * from build.js, webpack.base.conf.js, webpack.dev.conf.js or game/src —
 * checked by the editor's `npm run check:mock-build-isolation`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GAME_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(GAME_ROOT, '..');
const MOCK_BUILD_SETTINGS_FILE = path.join(__dirname, 'generated-mock-build.json');
const MOCK_ENGINE_ROOT = path.join(PROJECT_ROOT, 'mock-engine');
const MOCK_CLIENT_ENTRY = path.join(MOCK_ENGINE_ROOT, 'client', 'mock-build-entry.js');
const MOCK_CLIENT_TSCONFIG = path.join(MOCK_ENGINE_ROOT, 'client', 'tsconfig.json');

/** Must equal MOCK_BUILD_CONFIG_VERSION in mock-engine/client/mock-client.ts. */
const MOCK_BUILD_CONFIG_VERSION = 1;
/** Must equal MOCK_BUILD_FORMAT in the editor's electron/codegen/mock-build-codegen.js. */
const MOCK_BUILD_SETTINGS_FORMAT = 1;

function fail(message) {
  const error = new Error(`[build] mock engine: ${message}`);
  error.mockBuild = true;
  return error;
}

/** The parsed generated file. Throws when it is missing or malformed. */
function readMockBuildSettings() {
  let raw;
  try {
    raw = fs.readFileSync(MOCK_BUILD_SETTINGS_FILE, 'utf-8');
  } catch (err) {
    throw fail(`could not read build/generated-mock-build.json (${err && err.message}). Open the project in Orca to regenerate it.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw fail(`build/generated-mock-build.json is not valid JSON (${err && err.message}). Open the project in Orca to regenerate it.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('build/generated-mock-build.json is not a JSON object. Open the project in Orca to regenerate it.');
  }
  return parsed;
}

/** The mock-engine tree an enabled build needs, or a clear error naming what is missing. */
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
      `"Use mock engine" is on, but the bundled mock engine is missing or out of date — ${missing.map((file) => path.relative(PROJECT_ROOT, file)).join(', ')} ` +
        'not found. Open the project in Orca to restore mock-engine/, or turn "Use mock engine" off for a build that talks to the real engine.'
    );
  }
}

/**
 * @param {object} [settings] the parsed generated file (read when omitted)
 * @returns {{ version: number, mechanic: string, gameIds: string[], settingsOverrides: Record<string, unknown> | null,
 *   engine: { seed?: number, startingBalance?: number, currencyCode?: string, jackpot?: object } }}
 */
function resolveMockBuildPlan(settings) {
  const generated = settings === undefined ? readMockBuildSettings() : settings;
  if (!generated || generated.enabled !== true) {
    throw fail('build/generated-mock-build.json does not enable the mock engine.');
  }
  if (generated.format !== MOCK_BUILD_SETTINGS_FORMAT) {
    throw fail(
      `build/generated-mock-build.json has format ${JSON.stringify(generated.format)}, this build script reads ${MOCK_BUILD_SETTINGS_FORMAT}. ` +
        'Open the project in Orca to update it.'
    );
  }
  assertMockEngineTree();

  let bridge;
  try {
    bridge = require('./mock-engine');
  } catch (err) {
    throw fail(`could not load build/mock-engine.js: ${err && err.message}`);
  }
  for (const name of ['normaliseMockEngineConfig', 'listMechanicKeys', 'readMechanicSettingsCached', 'loadMockEngineModule', 'applySettingsOverrides', 'buildJackpotOptions']) {
    if (typeof bridge[name] !== 'function') {
      throw fail(`build/mock-engine.js is out of date (no ${name}); open the project in Orca to update it.`);
    }
  }

  const config = bridge.normaliseMockEngineConfig(generated.config);
  if (config === null) {
    throw fail('build/generated-mock-build.json has no "config". Open the project in Orca to regenerate it.');
  }

  const keys = bridge.listMechanicKeys();
  if (keys.length === 0) {
    throw fail('mock-engine/src failed to load in Node (see the [mock-engine] warning above); fix it before building.');
  }
  if (!keys.includes(config.mechanic)) {
    throw fail(`unknown mock engine mechanic "${config.mechanic}" (available: ${keys.join(', ')}).`);
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

  // The dev server registers the mechanic under the active skin; a bundle
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
    console.warn(`[build] mock engine: could not read the project's skins (${err && err.message}); game ids will register on first use.`);
  }

  return {
    version: MOCK_BUILD_CONFIG_VERSION,
    mechanic: config.mechanic,
    gameIds,
    settingsOverrides,
    engine,
  };
}

/**
 * Turn the production webpack config into one that bundles the mock engine.
 * Mutates `webpackConfig` in place; throws (see `fail`) rather than ever
 * leaving an enabled build without its mock engine.
 *
 * @param {object} webpackConfig the merged production config
 * @returns {object} the ORCA_MOCK_BUILD plan compiled in
 */
function applyMockBuild(webpackConfig) {
  const webpack = require('webpack');
  const plan = resolveMockBuildPlan();

  // Mock entry FIRST, so the live-host refusal runs before any game code.
  const appEntry = webpackConfig.entry && webpackConfig.entry.app;
  if (appEntry === undefined) throw fail('the production config has no entry.app to put the mock engine in front of.');
  webpackConfig.entry.app = [MOCK_CLIENT_ENTRY, ...(Array.isArray(appEntry) ? appEntry : [appEntry])];

  // The game's own ts-loader rule matches every `.ts` outside node_modules, and
  // mock-engine/ is outside game/ — so keep it off the engine (it is not in the
  // game's tsconfig program) and give the engine its own transpile-only pass.
  for (const rule of webpackConfig.module.rules) {
    if (rule && rule.loader === 'ts-loader' && rule.include === undefined) {
      rule.exclude = rule.exclude === undefined ? [MOCK_ENGINE_ROOT] : [rule.exclude, MOCK_ENGINE_ROOT];
    }
  }
  webpackConfig.module.rules.push({
    test: /\.ts$/,
    include: [MOCK_ENGINE_ROOT],
    loader: 'ts-loader',
    options: {
      instance: 'orca-mock-engine',
      configFile: MOCK_CLIENT_TSCONFIG,
      transpileOnly: true,
      compilerOptions: { noEmit: false, declaration: false, declarationMap: false },
    },
  });

  // mock-engine/ is a sibling of game/, so `axios` must resolve from the game's node_modules.
  webpackConfig.resolve = webpackConfig.resolve || {};
  webpackConfig.resolve.modules = ['node_modules', path.join(GAME_ROOT, 'node_modules')];

  webpackConfig.plugins.push(
    new webpack.DefinePlugin({
      ORCA_MOCK_BUILD: JSON.stringify(plan),
    })
  );

  console.log(
    `[build] MOCK ENGINE build: "${plan.mechanic}" answers every engine call in the browser ` +
      '(dev / stage only — it refuses to start on a live host).'
  );
  return plan;
}

module.exports = {
  PROJECT_ROOT,
  MOCK_BUILD_SETTINGS_FILE,
  MOCK_ENGINE_ROOT,
  MOCK_CLIENT_ENTRY,
  MOCK_CLIENT_TSCONFIG,
  MOCK_BUILD_CONFIG_VERSION,
  MOCK_BUILD_SETTINGS_FORMAT,
  readMockBuildSettings,
  assertMockEngineTree,
  resolveMockBuildPlan,
  applyMockBuild,
};
