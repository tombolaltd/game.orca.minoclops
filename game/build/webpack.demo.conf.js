/**
 * DEMO build — webpack config for `npm run build:demo` (build/build-demo.js).
 *
 * A demo build is the normal PRODUCTION build plus the bundled mock engine
 * running INSIDE the client: `mock-engine/client/mock-build-entry.js` is
 * prepended to `entry.app`, answers every engine call (begin / continue /
 * resume / potvalues) in-page through an axios adapter, shows an always-visible
 * "DEMO – mock engine" badge, and REFUSES to start on a live host. The fake
 * wallet and session are in memory only — every page reload starts fresh.
 *
 * ⚠️ DISPOSABILITY (AGENTS.md rule 27): this file and build-demo.js /
 * mock-build-plan.js are the ONLY build files that reach `mock-engine/`.
 * `build.js`, `webpack.base.conf.js`, `webpack.prod.conf.js` and `game/src/**`
 * must never require any of them — checked by the editor's
 * `npm run check:mock-build-isolation`.
 *
 * Output goes to `<normal assetsRoot>-demo` (e.g. `.build-output/<game>-demo`),
 * so a demo build can never overwrite a normal one. The prod config reads
 * `config.build.assetsRoot` / `config.build.index` when it is first required,
 * so they are redirected BEFORE requiring it — which is why this file refuses
 * to load after webpack.prod.conf.js already has.
 */

'use strict';

const path = require('path');
const webpack = require('webpack');
const config = require('./configuration');
const { MOCK_ENGINE_ROOT, MOCK_CLIENT_ENTRY, MOCK_CLIENT_TSCONFIG, resolveMockBuildPlan } = require('./mock-build-plan');

const DEMO_OUTPUT_SUFFIX = '-demo';
const GAME_ROOT = path.resolve(__dirname, '..');

if (require.cache[require.resolve('./webpack.prod.conf')]) {
  throw new Error('[build:demo] webpack.demo.conf.js must be loaded before webpack.prod.conf.js (it redirects the output folder first).');
}

// ── 1. Redirect the output so a demo can never overwrite a normal build. ─────
const prodRoot = path.resolve(config.build.assetsRoot);
const demoRoot = `${prodRoot.replace(/[\\/]+$/, '')}${DEMO_OUTPUT_SUFFIX}`;
const indexRel = path.relative(prodRoot, path.resolve(config.build.index));
if (!indexRel || indexRel.startsWith('..') || path.isAbsolute(indexRel)) {
  throw new Error(`[build:demo] configuration build.index (${config.build.index}) is not inside build.assetsRoot (${prodRoot}).`);
}
config.build.assetsRoot = demoRoot;
config.build.index = path.join(demoRoot, indexRel);

// ── 2. The engine config, resolved and validated at BUILD time. ──────────────
const mockBuildPlan = resolveMockBuildPlan();

// ── 3. The normal production config (now pointed at the demo folder). ───────
const webpackConfig = require('./webpack.prod.conf');

if (path.resolve(webpackConfig.output.path) !== demoRoot) {
  throw new Error(`[build:demo] the production config ignored the redirected output folder (${webpackConfig.output.path}); refusing to risk overwriting a normal build.`);
}

// Mock entry FIRST, so the live-host refusal runs before any game code.
const appEntry = webpackConfig.entry && webpackConfig.entry.app;
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
    ORCA_MOCK_BUILD: JSON.stringify(mockBuildPlan),
  })
);

console.log(
  `[build:demo] DEMO build: mock engine "${mockBuildPlan.mechanic}" runs in the client; output → ${demoRoot}`
);

// (No extra properties on the export: webpack validates the config's top-level keys.
// build-demo.js reads the redirected folder back from `config.build.assetsRoot`.)
module.exports = webpackConfig;
