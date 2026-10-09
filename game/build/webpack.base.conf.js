'use strict';
const path = require('path');
const utils = require('./utils');
const config = require('./configuration');
const vueLoaderConfig = require('./vue-loader.conf');

function resolve(dir) {
  return path.join(__dirname, '..', dir);
}

module.exports = {
  context: path.resolve(__dirname, '../'),
  entry: {
    app: ['custom-event-polyfill', 'core-js', './src/main.ts']
  },
  output: {
    path: config.build.assetsRoot,
    filename: '[name].js'
  },
  resolve: {
    extensions: ['.ts', '.js', '.vue', '.json'],
    alias: {
      'vue': path.resolve('./node_modules/vue'),
      // Force ONE copy of pixi and of the spine runtime, resolved from this
      // game's own node_modules. @game-studio/* declare `pixi.js` and
      // `@esotericsoftware/spine-pixi-v8` as PEERS, so a nested install would
      // otherwise give us two Pixi instances (broken `instanceof`, duplicate
      // texture/GPU caches) and two spine cores.
      'pixi.js': resolve('./node_modules/pixi.js'),
      '@esotericsoftware': resolve('./node_modules/@esotericsoftware'),
      '@': resolve('')
    },
    fallback: {
      setimmediate: false,
      dgram: false,
      fs: false,
      net: false,
      tls: false,
      child_process: false,
      // Webpack 5 consults `resolve.fallback[request]` ONLY when normal module
      // resolution for that request FAILS. So this is a STRICT NO-OP when a
      // jackpot skin has `@game-studio/jackpots` installed (full resolution +
      // the real async "jackpots" chunk are preserved), and supplies an empty
      // module (no warning, no error) for a non-jackpot "clean-disabled"
      // project where the editor has UNINSTALLED the package. The runtime
      // `if (!IS_JACKPOT) return;` guard + try/catch in
      // `src/core/services/jackpots/jackpots-runtime.ts` already ensure the
      // empty module is never executed in that state.
      '@game-studio/jackpots': false
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules|vue\/src/,
        loader: 'ts-loader',
        options: {
          appendTsSuffixTo: [/\.vue$/]
        }
      },
      {
        // `@game-studio/htp-*` ship raw, untranspiled `.ts` / `.vue<script
        // lang="ts">` source with no `dist/`, unlike every other
        // `@game-studio/*` dependency, so they need their own ts-loader pass.
        //
        // `transpileOnly` is REQUIRED, not a preference: tsconfig excludes
        // node_modules, so these files are not in the program and a normal
        // ts-loader pass fails with "TypeScript emitted no output". Emitting
        // each file standalone sidesteps program membership entirely. It also
        // keeps the package's own types from failing OUR build — and the
        // game's `src/` rule above is untouched, so first-party code (and the
        // mirrored custom scripts/components that rely on it) stays fully
        // type-checked.
        test: /\.ts$/,
        include: /node_modules[\\/]@game-studio[\\/]htp-/,
        loader: 'ts-loader',
        options: {
          appendTsSuffixTo: [/\.vue$/],
          transpileOnly: true,
          compilerOptions: {
            rootDir: undefined
          }
        }
      },
      {
        test: /\.vue$/,
        loader: 'vue-loader',
        options: vueLoaderConfig
      },
      {
        test: /\.js$/,
        loader: 'babel-loader',
        include: [resolve('src'), resolve('test'), resolve('node_modules/webpack-dev-server/client')]
      },
      {
        test: /\.atlas$/,
        use: 'raw-loader'
      },
      {
        test: /\.(png|jpg|jpeg|gif|svg)$/i,
        type: 'asset',
        parser: {
          dataUrlCondition: { maxSize: 8 * 1024 } // 8 KB — small icons inline; everything else emits as file
        },
        generator: {
          filename: utils.assetsPath('img/[name].[hash:7][ext]')
        }
      },
      {
        test: /\.(mp4|webm|ogg|mp3|wav|flac|aac)(\?.*)?$/,
        loader: 'url-loader',
        options: {
          limit: 10000,
          name: utils.assetsPath('media/[name].[hash:7].[ext]')
        }
      },
      {
        // `asset/resource`, NOT url-loader: url-loader delegates anything over
        // its limit to `file-loader`, which is not a dependency of this
        // project — so a large font (e.g. the 115 KB OTF bundled in
        // `@game-studio/htp-preview-vue2`'s scoped `<style>`) would fail the
        // build outright.
        test: /\.(woff2?|eot|ttf|otf)(\?.*)?$/,
        type: 'asset/resource',
        generator: {
          filename: utils.assetsPath('fonts/[name].[hash:7][ext]')
        }
      }
    ]
  }
};
