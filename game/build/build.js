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
const webpackConfig = require('./webpack.prod.conf');
const { eraseFolder, copyAssets } = require('./copy-assets');

const spinner = ora('building for production...');
spinner.start();

// Decide whether this production build needs the jackpots assets.
//
// We read `orca-project-files/main.orca` directly (the same fs/JSON pattern as
// `orca-project-assets.js`) rather than text-parsing the auto-generated
// `active-skin.ts`. That file used to carry a literal `IS_JACKPOT = true;`,
// but it is now a DERIVED expression (`SKIN_TABLE[ACTIVE_SKIN]?.isJackpot`)
// because a bundle carries every skin and picks one at boot from
// `?skin=<gameId>` — so any regex over it would silently return false and ship
// a jackpots-less build. Reading the source of truth is drift-proof.
//
// A bundle serving ALL skins needs the assets if ANY skin is a jackpot skin.
const MAIN_ORCA_PATH = path.resolve(__dirname, '../../orca-project-files/main.orca');

function isJackpotSkin() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(MAIN_ORCA_PATH, 'utf-8'));
  } catch (err) {
    // Unreadable/unparseable main.orca. Copying assets that turn out to be
    // unused only bloats the bundle; NOT copying them 404-storms a jackpot
    // skin at runtime — so fail toward copying.
    console.warn(chalk.yellow(
      `  [build] Could not read ${MAIN_ORCA_PATH} (${err && err.message}).\n` +
      '  [build] Assuming this project MAY contain a jackpot skin — copying\n' +
      '  [build] jackpots assets so a jackpot skin cannot 404 at runtime.\n'
    ));
    return true;
  }

  const skins = Array.isArray(parsed && parsed.skins) ? parsed.skins : null;
  if (!skins) {
    console.warn(chalk.yellow(
      `  [build] No "skins" array in ${MAIN_ORCA_PATH}.\n` +
      '  [build] Copying jackpots assets defensively.\n'
    ));
    return true;
  }

  return skins.some(skin => skin && skin.isJackpot === true);
}

// Populate ./static before webpack runs. Production has no `prebuild`
// npm hook (unlike `serve`'s `preserve`), so this must complete first
// — previously the chain was fire-and-forget and raced webpack.
async function main() {
  await eraseFolder('./static/fonts/shared');
  await eraseFolder('./static/assets');
  // Always clear any previously-copied jackpots tree first so toggling the
  // active skin's jackpots flag OFF removes the assets from the next build.
  await eraseFolder('./static/shared-jackpots-assets');
  await copyAssets('fonts');
  await copyAssets('cabinet');
  // Jackpots assets are copied only when at least one skin in the project is a
  // jackpot skin, so a purely non-jackpot production build carries none
  // (mirrors the runtime gate in core/services/jackpots/jackpots-runtime.ts).
  //
  // `isJackpotSkin()` FAILS OPEN, and both directions of that bite:
  //
  //   FALSE NEGATIVE — the erase above + this gate silently ship a
  //   jackpots-less production build: the editor-synced
  //   `static/shared-jackpots-assets/` is wiped and never repopulated, and the
  //   only symptom is a runtime 404 storm on
  //   `/static/shared-jackpots-assets/**` plus "[jackpots-runtime] Jackpots
  //   init failed". Dev keeps working regardless, because
  //   `webpack.dev.conf.js` serves that folder from disk per request via
  //   `createJackpotsAssetsDevMiddleware()` and never consults IS_JACKPOT — so
  //   this class of bug is invisible until deploy. That is why the two
  //   defensive branches return TRUE and why `isJackpotSkin()` stays loud.
  //
  //   FALSE POSITIVE — a defensive `true` on a project with NO jackpot skin
  //   asks for a package the editor has legitimately uninstalled (a fresh
  //   scaffold never installs it). That happens for ANY build run outside the
  //   canonical project layout: CI, a copied `game/` folder, a deploy
  //   pipeline. `copyAssets('jackpots')` is therefore OPTIONAL and warns
  //   instead of exiting — it used to `process.exit(1)` and kill the build
  //   before webpack ever started. The cost is only a missing optional asset
  //   tree, which is exactly what a non-jackpot build wants anyway.
  if (isJackpotSkin()) {
    const jackpotsCopied = await copyAssets('jackpots');
    if (!jackpotsCopied) {
      console.log(chalk.yellow(
        '  [build] Jackpots assets were requested but @game-studio/jackpots is\n' +
        '  [build] not installed — none were copied. This is expected for a\n' +
        '  [build] non-jackpot project; a jackpot skin will 404 at runtime.\n'
      ));
    }
  }
  await copyAssets('game');

  rm(path.join(config.build.assetsRoot, config.build.assetsSubDirectory), rmError => {
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
        children: false, // If you are using ts-loader, setting this to true will make TypeScript errors show up during build.
        chunks: false,
        chunkModules: false
      }) + '\n\n');

      if (stats.hasErrors()) {
        console.log(chalk.red('  Build failed with errors.\n'));
        process.exit(1);
      }

      console.log(chalk.cyan('  Build complete.\n'));
      console.log(chalk.yellow(
        '  Tip: built files are meant to be served over an HTTP server.\n' +
        '  Opening index.html over file:// won\'t work.\n'
      ));
    });
  });
}

main().catch(err => {
  spinner.stop();
  console.error(err);
  process.exit(1);
});
