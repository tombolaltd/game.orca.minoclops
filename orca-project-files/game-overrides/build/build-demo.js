/**
 * `npm run build:demo` — a DEMO build: the normal production build plus the
 * bundled mock engine running inside the client (see webpack.demo.conf.js).
 *
 * Mirrors build.js step for step — runtime-asset reconcile, the static asset
 * copies (fonts, cabinet, jackpots when a skin needs them, game), a clean
 * output folder, webpack, then the built-asset verification — but runs
 * webpack.demo.conf.js and writes to `<normal output>-demo`. It is a separate
 * script rather than a flag on build.js so that build.js never names, let alone
 * requires, anything that reaches mock-engine/ (AGENTS.md rule 27; checked by
 * the editor's `npm run check:mock-build-isolation`). Keep the two in step when
 * build.js changes.
 *
 * Plain `node build/build-demo.js` — no arguments, no prompts, exit code 1 on
 * any failure — so CI (TeamCity) can run it as is.
 */

'use strict';
require('./check-versions')();

process.env.NODE_ENV = 'production';

const ora = require('ora');
const rm = require('rimraf');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const webpack = require('webpack');
const config = require('./configuration');

// Same order as build.js: reconcile BEFORE the prod config (inside the demo
// config) loads, because it checks the asset folders it will copy.
reconcileRuntimeAssets();

let webpackConfig;
try {
  webpackConfig = require('./webpack.demo.conf');
} catch (err) {
  console.log(chalk.red(`\n  ${err && err.message}\n`));
  if (!(err && err.mockBuild) && err && err.stack) console.log(err.stack);
  process.exit(1);
}
const { eraseFolder, copyAssets } = require('./copy-assets');

// webpack.demo.conf.js redirected this to `<normal assetsRoot>-demo`.
const OUTPUT_ROOT = config.build.assetsRoot;

const spinner = ora('building DEMO (mock engine in the client)...');
spinner.start();

const MAIN_ORCA_PATH = path.resolve(__dirname, '../../orca-project-files/main.orca');

/** Same decision (and the same fail-open posture) as build.js's `isJackpotSkin`. */
function isJackpotSkin() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(MAIN_ORCA_PATH, 'utf-8'));
  } catch (err) {
    const assets = require('./orca-project-assets');
    const table = typeof assets.readGameSkinTable === 'function' ? assets.readGameSkinTable() : null;
    if (table && table.skins.length) {
      return table.skins.some(skin => skin.isJackpot)
        || (Array.isArray(table.jackpotTiles) && table.jackpotTiles.length > 0);
    }
    console.warn(chalk.yellow(`  [build:demo] Could not read ${MAIN_ORCA_PATH} (${err && err.message}); copying jackpots assets defensively.\n`));
    return true;
  }
  const skins = Array.isArray(parsed && parsed.skins) ? parsed.skins : null;
  if (!skins) {
    console.warn(chalk.yellow(`  [build:demo] No "skins" array in ${MAIN_ORCA_PATH}; copying jackpots assets defensively.\n`));
    return true;
  }
  return skins.some(skin => skin && skin.isJackpot === true);
}

function reconcileRuntimeAssets() {
  try {
    const mirror = require('./orca-asset-mirror');
    mirror.logOrcaAssetMirrorReport(mirror.reconcileOrcaAssetMirrors());
  } catch (err) {
    console.warn(chalk.yellow(`  [build:demo] Runtime asset check failed: ${err && err.message}\n`));
  }
}

function verifyBuiltAssets() {
  let result;
  try {
    const mirror = require('./orca-asset-mirror');
    if (typeof mirror.verifyOrcaBuildOutput !== 'function') return true;
    result = mirror.verifyOrcaBuildOutput(path.join(OUTPUT_ROOT, 'assets'));
  } catch (err) {
    console.warn(chalk.yellow(`  [build:demo] Built-asset check failed: ${err && err.message}\n`));
    return true;
  }
  if (!result.lost.length) return true;
  const shown = result.lost.slice(0, 40).map(row => `    ${row.bucket}: ${row.ref}`);
  if (result.lost.length > 40) shown.push(`    …and ${result.lost.length - 40} more`);
  console.log(chalk.red(
    `  Demo build failed: ${result.lost.length} asset file(s) the game uses are in its asset folders but not in the build output:\n` +
    `${shown.join('\n')}\n`
  ));
  return false;
}

async function main() {
  await eraseFolder('./static/fonts/shared');
  await eraseFolder('./static/assets');
  await eraseFolder('./static/shared-jackpots-assets');
  await copyAssets('fonts');
  await copyAssets('cabinet');
  if (isJackpotSkin()) {
    const jackpotsCopied = await copyAssets('jackpots');
    if (!jackpotsCopied) {
      console.log(chalk.yellow('  [build:demo] Jackpots assets were requested but @game-studio/jackpots is not installed — none were copied.\n'));
    }
  }
  await copyAssets('game');

  await new Promise((resolve, reject) => {
    rm(path.join(OUTPUT_ROOT, 'assets'), rmError => (rmError ? reject(rmError) : resolve()));
  });

  rm(path.join(OUTPUT_ROOT, config.build.assetsSubDirectory), rmError => {
    if (rmError) {
      throw rmError;
    }
    webpack(webpackConfig, (webpackError, stats) => {
      spinner.stop();
      if (webpackError) {
        throw webpackError;
      }
      process.stdout.write(stats.toString({
        colors: true,
        modules: false,
        children: false,
        chunks: false,
        chunkModules: false
      }) + '\n\n');

      if (stats.hasErrors()) {
        console.log(chalk.red('  Demo build failed with errors.\n'));
        process.exit(1);
      }
      if (!verifyBuiltAssets()) process.exit(1);

      console.log(chalk.cyan(`  DEMO build complete: ${OUTPUT_ROOT}\n`));
      console.log(chalk.yellow(
        '  This build plays against the bundled MOCK engine and refuses to start on a live host.\n' +
        '  Deploy it to a demo / dev / stage location only — never to live.\n'
      ));
    });
  });
}

main().catch(err => {
  spinner.stop();
  console.error(err);
  process.exit(1);
});
