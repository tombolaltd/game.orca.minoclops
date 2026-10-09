const path = require('path');
const fs = require('fs');

async function copyAssets(assetType) {
    const assetConfig = {
        fonts: {
            source: 'node_modules/@game-studio/arcade-base/dist/static/fonts',
            target: './static/fonts/shared'
        },
        cabinet: {
            source: 'node_modules/@game-studio/cabinet/dist/assets',
            target: './static/assets/core/cabinet'
        },
        // Jackpots assets ship under `dist/assets/<operator>/...` and are
        // fetched at runtime from `/static/shared-jackpots-assets/...`. The
        // CALLER gates this copy on the active skin's IS_JACKPOT flag (see
        // build/build.js) so a non-jackpot build copies nothing.
        //
        // `optional` because `@game-studio/jackpots` is legitimately ABSENT on
        // a non-jackpot project — the editor uninstalls it, and a fresh
        // scaffold never installs it. build.js's `isJackpotSkin()` gate fails
        // OPEN (see its comment block), so an unreadable/absent main.orca asks
        // for this copy on a project that has no such package; that must warn
        // and continue, never kill the build before webpack starts. This is
        // the ONLY tolerant entry — see the missing-source check below.
        jackpots: {
            source: 'node_modules/@game-studio/jackpots/dist/assets',
            target: './static/shared-jackpots-assets',
            optional: true
        },
        game: {
            source: 'src/assets',
            target: './static/assets'
        }
    }

    const config = assetConfig[assetType];

    if (!config) {
        console.error(`Copy Asset Error: Unknown asset type '${assetType}'. Valid types are: fonts, cabinet, jackpots, game`);
        process.exit(1);
    }

    const { source, target, optional } = config;

    // Check if Source Exists.
    //
    // A missing source is FATAL for fonts/cabinet/game: those are never
    // optional, and shipping without them leaves Pixi's loader fetching
    // index.html in their place, so BaseGame preInit hangs forever on the
    // loading screen (the failure build/copy-runtime-assets.js exists to
    // prevent). Only an `optional` type (jackpots) warns and returns — same
    // tolerant posture as build/copy-jackpots-assets.js.
    if (!fs.existsSync(source)) {
        if (optional) {
            console.warn(`Copy Asset Warning: Source path '${source}' does not exist for ${assetType} assets — package not installed, skipping.`);
            return false;
        }

        console.error(`Copy Asset Error: Source path '${source}' does not exist for ${assetType} assets. Please ensure the package is installed.`);
        process.exit(1);
    }

    try {
        // Copy Assets from Source to Target
        const fromPath = path.resolve(__dirname, `../${source}`);

        fs.cpSync(fromPath, target, { recursive: true, force: true });
    } catch (error) {
        console.error(`Error Copying ${assetType} Assets from ${source} to ${target}: `, error);
    }

    return true;
}

async function eraseFolder(targetDirectory) {
    try {
        // Check if the folder we want to push to already exists, so we can clear it out.
        if (fs.existsSync(targetDirectory)) { await fs.promises.rm(targetDirectory, { recursive: true, force: true }); }
    } catch (error) {
        console.error(`Unable to Delete Folder ${targetDirectory}: `, error);
        process.exit(1);
    }
}

module.exports = { eraseFolder, copyAssets }