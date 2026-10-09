'use strict';
const path = require('path');
const utils = require('./utils');
const webpack = require('webpack');
const config = require('./configuration');
const merge = require('webpack-merge');
const baseWebpackConfig = require('./webpack.base.conf');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCSSExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const { VueLoaderPlugin } = require('vue-loader');
const { getOrcaProjectAssetRoots, getOrcaProjectScopedAssetRoots, ORCA_ASSET_IGNORE_PATTERNS } = require('./orca-project-assets');

const env = require('./configuration/prod.env');

const fs = require('fs');
const pkg = require('../package.json');

pkg.version = process.env.BUILD_NUMBER || '0.0.0';

fs.writeFile('package.json', JSON.stringify(pkg, null, '\t'), function(error) {
  if (error) {
    console.log(error);
  }
});

const webpackConfig = merge(baseWebpackConfig, {
  mode: 'production',
  performance: {
    hints: false
  },
  module: {
    rules: [
      {
        test: /\.less$/,
        use: [
          {
            loader: MiniCSSExtractPlugin.loader
          },
          'css-loader',
          'postcss-loader',
          'less-loader'
        ]
      },
      {
        // Plain CSS must NOT go through less-loader. This rule used to be
        // folded into the `.less` one above via /\.(le|c|)ss$/, which sent
        // every stylesheet through Less — and Less 3 evaluates the CSS
        // `min()` / `max()` functions as its OWN, failing with "incompatible
        // types" on a perfectly valid `min(56px, 100%)`. That took out any
        // dependency shipping modern CSS (e.g. @game-studio/htp-preview-vue2's
        // scoped block). Dev never had the bug: `utils.styleLoaders` already
        // gives `.css` a less-free rule, so this also realigns prod with dev.
        test: /\.css$/,
        use: [
          {
            loader: MiniCSSExtractPlugin.loader
          },
          'css-loader',
          'postcss-loader'
        ]
      }
    ]
  },
  devtool: config.build.productionSourceMap ? config.build.devtool : false,
  output: {
    path: config.build.assetsRoot,
    filename: utils.assetsPath('js/[name].[chunkhash].js'),
    chunkFilename: utils.assetsPath('js/[id].[chunkhash].js')
  },
  optimization: {
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        vendor: {
          name: 'vendor',
          test: /[\\/]node_modules[\\/](pixi\.js|@pixi|@esotericsoftware)[\\/]/,
          chunks: 'all',
          enforce: true
        },
        manifest: {
          name: 'manifest',
          minChunks: Infinity
        },
        arcade: {
          name: 'arcade',
          test: /[\\/]node_modules[\\/](@arcade-client)[\\/]/,
          chunks: 'all',
          enforce: true
        },
        app: {
          minChunks: 3,
          chunks: 'all',
          enforce: true
        },
        styles: {
          name: 'styles',
          type: 'css/mini-extract',
          chunks: 'all',
          enforce: true
        }
      }
    },
    moduleIds: 'deterministic',
    minimizer: [
      `...`,
      // Compress extracted CSS. We are using this plugin so that possible
      // duplicated CSS from different components can be deduped.
      new CssMinimizerPlugin()
    ]
  },
  plugins: [
    // http://vuejs.github.io/vue-loader/en/workflow/production.html
    new webpack.DefinePlugin({
      'process.env': env
    }),
    // extract css into its own file
    new MiniCSSExtractPlugin({
      filename: utils.assetsPath('css/[name].[contenthash].css')
    }),
    // generate dist index.html with correct asset hash for caching.
    // you can customize output by editing /index.html
    // see https://github.com/ampedandwired/html-webpack-plugin
    new HtmlWebpackPlugin({
      filename: config.build.index,
      template: 'index.html',
      inject: true,
      minify: {
        removeComments: true,
        collapseWhitespace: true,
        removeAttributeQuotes: true
        // more options:
        // https://github.com/kangax/html-minifier#options-quick-reference
      },
      // necessary to consistently work with multiple chunks via CommonsChunkPlugin
      chunksSortMode: 'auto'
    }),
    // copy custom static assets
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, '../static'),
          to: config.build.assetsSubDirectory,
          globOptions: { ignore: ['.*'] }
        },
        // Mirror the Orca authoring asset trees into the dist bundle so
        // bucket-relative paths (e.g. `spine/backgroundBonus.json`) used
        // by scenes resolve at runtime. We emit TWO sets of copy
        // patterns — SCOPED and FLAT — because the runtime mixes two URL
        // styles. See build/orca-project-assets.js and scene-manager
        // `toAbsoluteSceneAssetUrl`.
        //
        // SCOPED copy (`assets/core` + `assets/skins/<activeSkin>`):
        // textures, scenes and reels assets are fetched at
        // scope-qualified URLs (`/assets/core/<R>`,
        // `/assets/skins/<skin>/<R>`) so that a same basename in core and
        // a skin can't collide in a single flat `dist/assets/` folder.
        // Core and skin go to DISTINCT destinations, so there's no
        // collision between them and copy order is irrelevant for this
        // set. This matches the scope-aware dev middleware which mounts
        // each bucket ROOT under its scoped publicPath.
        ...getOrcaProjectScopedAssetRoots().map((root) => ({
          from: root.directory,
          to: root.to, // 'assets/core' | 'assets/skins/<skin>'
          globOptions: { ignore: ORCA_ASSET_IGNORE_PATTERNS },
          noErrorOnMissing: true,
        })),
        // FLAT copy (`assets`): legacy UNSCOPED refs (audio, fonts) are
        // still emitted WITHOUT a scope prefix, so they must resolve at
        // `/assets/<R>` → `dist/assets/<R>`. Active skin first so a
        // same-name unscoped ref keeps the current skin-wins behaviour.
        // `to: 'assets'` (NOT `'.'`): copying a bucket's CONTENTS into
        // `dist/assets/` makes `/assets/<R>` resolve to `dist/assets/<R>`
        // (the previous `to: '.'` copied to the dist ROOT, 404'ing every
        // `/assets/<R>` request in a production build).
        ...getOrcaProjectAssetRoots().map((root) => ({
          from: root.directory,
          to: 'assets',
          globOptions: { ignore: ORCA_ASSET_IGNORE_PATTERNS },
          noErrorOnMissing: true,
        })),
      ]
    }),

    new VueLoaderPlugin()
  ]
});

if (config.build.productionGzip) {
  const CompressionWebpackPlugin = require('compression-webpack-plugin');

  webpackConfig.plugins.push(
    new CompressionWebpackPlugin({
      asset: '[path].gz[query]',
      algorithm: 'gzip',
      test: new RegExp(
        '\\.(' +
        config.build.productionGzipExtensions.join('|') +
        ')$'
      ),
      threshold: 10240,
      minRatio: 0.8
    })
  );
}

if (config.build.bundleAnalyzerReport) {
  const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;
  webpackConfig.plugins.push(new BundleAnalyzerPlugin());
}

module.exports = webpackConfig;
