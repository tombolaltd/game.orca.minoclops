import { AssetData } from '@arcade-client/base-ticketfetcher-package';

// This file can be removed if no assets are loaded from core.

export const coreAssetList: AssetData = {
    default: {
        textures: [
            { name: 'ASSET_NAME', url: 'UK/PATH/TO/ASSET.png' }
        ],
        animations: [
            { name: 'ASSET_NAME', skeleton: 'UK/PATH/TO/ASSET.json' },
        ],
        spriteSheets: [
            { name: 'ASSET_NAME', url: 'UK/PATH/TO/ASSET.json' }
        ],
        sounds: [
            { name: 'ASSET_NAME', url: 'UK/PATH/TO/ASSET.mp3' }
        ]
    },
    it: { // TODO: Include any assets you want to override the defaults with.
        textures: [
            { name: 'ASSET_NAME', url: 'IT/PATH/TO/ASSET.png' }
        ],
    },
    dk: {}, // TODO: Include any assets you want to override the defaults with.
    es: {}, // TODO: Include any assets you want to override the defaults with.
    se: {}, // TODO: Include any assets you want to override the defaults with.
    nl: {}  // TODO: Include any assets you want to override the defaults with.

    // TODO: If a country doesnt have any overrides, you can delete that region.
};
