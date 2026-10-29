'use strict';
const utils = require('./utils');
const webpack = require('webpack');
const config = require('./configuration');
const merge = require('webpack-merge');
const path = require('path');
const baseWebpackConfig = require('./webpack.base.conf');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const FriendlyErrorsPlugin = require('friendly-errors-webpack-plugin');
const { VueLoaderPlugin } = require('vue-loader');
const portfinder = require('portfinder');
const { createOrcaAssetsDevMiddleware, createJackpotsAssetsDevMiddleware } = require('./orca-project-assets');

// Bundled mock arcade engine (`<project>/mock-engine/`). Optional: a project
// scaffolded before it existed, or one whose copy failed to migrate, simply
// has no build/mock-engine.js — so the require is guarded and the dev server
// boots exactly as before.
let createMockEngineDevMiddleware = null;
try {
  ({ createMockEngineDevMiddleware } = require('./mock-engine'));
} catch (err) {
  console.warn('[mock-engine] build/mock-engine.js unavailable; mock engine disabled:', err && err.message);
}

const HOST = process.env.HOST;
const PORT = process.env.PORT && Number(process.env.PORT);

// webpack-dev-server 5 only accepts `proxy` as an ARRAY of
// `{ context, ...options }` entries. `config.dev.proxyTable` keeps the
// older `{ '<path>': options }` object shape, so convert it here (an array
// is passed through unchanged).
function toDevServerProxyList(table) {
  if (!table) return [];
  if (Array.isArray(table)) return table;
  return Object.keys(table).map((context) => {
    const entry = table[context];
    return typeof entry === 'string'
      ? { context: [context], target: entry }
      : Object.assign({ context: [context] }, entry);
  });
}

// Note: ./static population is owned by the `preserve` npm script
// (build/copy-runtime-assets.js), which runs to completion before
// webpack-dev-server boots. The previous in-config
// `eraseFolder(...).then(copyAssets...)` chain was not awaited and
// raced webpack-dev-server's static middleware, producing
// ENOTEMPTY on ./static/assets on macOS APFS.

const devWebpackConfig = merge(baseWebpackConfig, {
  mode: 'development',
  module: {
    rules: utils.styleLoaders({ sourceMap: config.dev.cssSourceMap, usePostCSS: true })
  },
  // cheap-module-eval-source-map is faster for development
  devtool: config.dev.devtool,

  // these devServer options should be customized in /config/index.js
  devServer: {
    client: {
      logging: 'warn',
      overlay: {
        errors: true,
        warnings: false,
        // Legacy Pixi 6 clause: `LoaderResource._onError` rejected an
        // internal promise nobody caught, producing spurious "Failed to load
        // element using: IMG" overlay errors on any texture that 404s. Pixi 8
        // has no LoaderResource, so this is inert on a ported game — but it is
        // RETAINED because it is the anchor that
        // `migrateUpgradeGameWebpackOverlayFilter` (electron/project-migrate.js)
        // matches on; deleting it makes that migration warn-and-skip.
        // Any other runtime error still surfaces.
        runtimeErrors: (error) => {
          const msg = error?.message ?? '';
          if (typeof msg === 'string' && msg.includes('Failed to load element using:')) {
            return false;
          }
          // @game-studio/arcade-base fires cross-origin analytics/logging
          // fetches (logBeginSession, logPurchaseEvent, ...) to absolute
          // Tombola-cloud URLs that CORS-fail from the localhost emulator,
          // surfacing as "Uncaught runtime errors: Failed to fetch". Scope the
          // suppression to the arcade-base stack so a developer's OWN genuine
          // fetch failure still surfaces. Optional chaining guards a missing
          // message/stack on the unhandled-rejection error object.
          if (
            typeof msg === 'string' && msg.includes('Failed to fetch') &&
            error?.stack?.includes?.('@game-studio/arcade-base')
          ) {
            return false;
          }
          return true;
        }
      }
    },
    historyApiFallback: {
      // SPA fallback MUST exclude static asset prefixes. Otherwise a missing
      // `/assets/Symbols/3.sprite.json` (or any `/static/...`) returns
      // `index.html` (HTML 200) instead of an honest 404, and the runtime
      // descriptor loader sees HTML being JSON.parse'd — surfacing as a
      // misleading "Invalid sprite descriptor JSON" warning instead of a
      // proper missing-asset branch. Keep the index.html target for genuine
      // SPA routes; asset 404s must stay 404s.
      rewrites: [
        { from: /^(?!\/(assets|static)\/).*$/, to: path.posix.join(config.dev.assetsPublicPath, 'index.html') }
      ]
    },
    hot: true,
    compress: true,
    host: HOST || config.dev.host,
    port: PORT || config.dev.port,
    open: config.dev.autoOpenBrowser,
    static: [
      { publicPath: config.dev.assetsPublicPath },
    ],
    // Serve Orca runtime-mirror assets at the `/assets` publicPath by
    // resolving the CURRENT active skin PER REQUEST (skin mirror first,
    // then core). This REPLACES the previous boot-time static mount of
    // `getOrcaProjectAssetRoots()`, which resolved the active skin ONCE at
    // dev-server boot — so after a mid-session skin switch (or a boot with
    // no/empty `activeSkin`) the current skin's mirror was never mounted,
    // making active-skin assets 404 (core kept resolving) and same-name
    // refs fall through to core. The middleware re-reads `main.orca`
    // (mtime-gated) on each request, so skin switches are picked up without
    // a server restart. Missing assets stay an honest 404 (no index.html
    // fallback); `historyApiFallback` already excludes `/assets/`.
    setupMiddlewares: (middlewares) => {
      middlewares.unshift(
        {
          name: 'orca-active-skin-assets',
          middleware: createOrcaAssetsDevMiddleware(),
        },
        // Serve a jackpot skin's editor-synced assets from
        // `game/static/shared-jackpots-assets/` per request (so post-boot
        // drops are served without a restart). Falls through on a miss, so a
        // non-jackpot skin is unaffected.
        {
          name: 'orca-jackpots-assets',
          middleware: createJackpotsAssetsDevMiddleware(),
        },
      );

      // Serve the editor-managed Game Rules + How-To-Play image mirrors
      // (`game/static/{game-rules,htp}/`) from disk per request, so an image the
      // editor writes after boot never waits on a successful recompile. Falls
      // through on a miss.
      const { createEditorStaticMirrorsDevMiddleware } = require('./orca-project-assets');
      if (typeof createEditorStaticMirrorsDevMiddleware === 'function') {
        middlewares.unshift({
          name: 'orca-editor-static-mirrors',
          middleware: createEditorStaticMirrorsDevMiddleware(),
        });
      }

      // Host the bundled mock arcade engine at the real engine's own routes
      // (`POST /{game}/begin|continue|resume|potvalues`, `GET /diagnostics`,
      // `GET /ping`). Registered unconditionally but INERT until the project
      // opts in via `main.orca.projectSettings.mockEngine.enabled` — it reads
      // that flag per request (mtime-gated) and `next()`s while it is off, so
      // a project pointed at a real engine is completely unaffected.
      if (createMockEngineDevMiddleware) {
        try {
          middlewares.unshift({
            name: 'orca-mock-engine',
            middleware: createMockEngineDevMiddleware(),
          });
        } catch (err) {
          console.warn('[mock-engine] Failed to register the mock-engine middleware:', err && err.message);
        }
      }

      return middlewares;
    },
    proxy: toDevServerProxyList(config.dev.proxyTable)
  },
  watchOptions: {
    aggregateTimeout: 200,
    poll: config.dev.poll,
    // Exclude the mirrored asset trees and editor-managed caches from
    // chokidar re-statting. Webpack's ContextModule snapshot otherwise
    // stats every entry under skins/<skin>/, including binary asset
    // mirrors — a transient stat failure (race vs the editor's
    // sync-skin-assets IPC) can be JSON-stringified through the
    // ContextModule graph and trigger an OOM. See
    // agent-docs/game-integration.md §5c.1.
    ignored: [
      '**/node_modules/**',
      '**/skins/*/assets/**',
      '**/core/assets/**',
      '**/.cache/**',
      '**/.build-output/**',
    ],
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env': require('./configuration/dev.env')
    }),
    new webpack.NoEmitOnErrorsPlugin(),
    // https://github.com/ampedandwired/html-webpack-plugin
    new HtmlWebpackPlugin({
      filename: 'index.html',
      template: 'index.html',
      inject: true
    }),
    // copy custom static assets
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, '../static'),
          to: config.dev.assetsSubDirectory,
          globOptions: { ignore: ['.*'] }
        },
      ]
    }),
    new VueLoaderPlugin()
  ]
});

module.exports = () => {
  return new Promise((resolve, reject) => {
    portfinder.basePort = process.env.PORT || config.dev.port;
    portfinder.getPort((err, port) => {
      if (err) {
        reject(err);
      } else {
        // publish the new Port, necessary for e2e tests
        process.env.PORT = port;
        // add port to devServer config
        devWebpackConfig.devServer.port = port;

        // Add FriendlyErrorsPlugin
        devWebpackConfig.plugins.push(new FriendlyErrorsPlugin({
          compilationSuccessInfo: {
            messages: [`${config.dev.gameName} is running here: http://${devWebpackConfig.devServer.host}:${port}`]
          },
          onErrors: config.dev.notifyOnErrors
              ? utils.createNotifierCallback()
              : undefined
        }));

        resolve(devWebpackConfig);
      }
    });
  });
};
