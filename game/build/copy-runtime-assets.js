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

const { copyAssets } = require('./copy-assets');

(async () => {
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
