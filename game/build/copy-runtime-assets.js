// Idempotent runtime-asset copy step.
//
// Invoked by the `preserve` npm hook so that `npm run serve` populates
// ./static/ before webpack-dev-server starts. Without this, dev-server's
// historyApiFallback returns index.html for any 404'd asset (cabinet
// textures, fonts, game assets), so Pixi's Assets loader receives HTML where
// it expected an image/JSON and the BaseGame preInit hangs forever on the
// loading screen.
//
// `copyAssets` (build/copy-assets.js) uses `cpSync(..., { force: true })`,
// so re-running on every serve is safe — files get overwritten in place
// and we never erase ./static/ wholesale (the runtime-mirror JSON the
// editor's exporter writes into ./static/ remains untouched).
//
// It also brings the runtime asset folders (`src/<bucket>/assets/`) up to date
// with what the scenes, graphs and clips name (build/orca-asset-mirror.js), so
// the game the editor starts never draws a missing texture as a white box.
// That half is never fatal.

const { copyAssets } = require('./copy-assets');

function reconcileRuntimeAssets() {
  try {
    const mirror = require('./orca-asset-mirror');
    mirror.logOrcaAssetMirrorReport(mirror.reconcileOrcaAssetMirrors());
  } catch (err) {
    console.warn('[copy-runtime-assets] runtime asset check failed:', err && err.message);
  }
}

(async () => {
  reconcileRuntimeAssets();
  try {
    await copyAssets('fonts');
    await copyAssets('cabinet');
    await copyAssets('game');
    console.log('[copy-runtime-assets] ✅ fonts/cabinet/game assets copied to ./static');
  } catch (err) {
    console.error('[copy-runtime-assets] ❌ failed:', err);
    process.exit(1);
  }
})();
