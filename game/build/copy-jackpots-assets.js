const path = require('path');
const fs = require('fs');

module.exports = async function () {
    const baseAssetUrl = `node_modules/@game-studio/jackpots/dist/assets`
    
    // Check if Jackpots Package is Installed
    if (!fs.existsSync(baseAssetUrl)) { return; }

    const targetDirectory = './static/shared-jackpots-assets';

    // Check if the folder we want to push to already exists, so we can clear it out.
    if (fs.existsSync(targetDirectory)) { await fs.promises.rm(targetDirectory, { recursive: true, force: true }); }

    // Copy Core Assets into Folder
    const fromCore = path.resolve(__dirname, `../${baseAssetUrl}/core`);
    fs.cpSync(fromCore, targetDirectory + '/core', { recursive: true, force: true });

    const country = process.env.country || process.env.npm_config_country?.toLowerCase();
    
    // Check if Country Param Exists and Isnt UK.
    if (country !== undefined && country !== 'uk') { 
        // Check if International Base Exists.
        const internationalBaseFolderName = baseAssetUrl + '/regional/international-base';
        
        if (fs.existsSync(internationalBaseFolderName)) {
            const fromIntBase = path.resolve(__dirname, `../${internationalBaseFolderName}`);
            fs.cpSync(fromIntBase, targetDirectory + '/regional/international-base', { recursive: true, force: true });
        }
        
        // Check if the Country we are building exists.
        const countryFolderName = baseAssetUrl + `/regional/${country}`;

        if (fs.existsSync(countryFolderName)) {
            const fromIntBase = path.resolve(__dirname, `../${countryFolderName}`);
            fs.cpSync(fromIntBase, targetDirectory + `/regional/${country}`, { recursive: true, force: true });
        }
    }
}