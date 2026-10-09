import { AssetData } from '@game-studio/arcade-base';

export const coreDataList: AssetData = {
    default: {
        textures: [],
        spriteSheets: [],
        animations: [],
        sounds: [
            { name: 'stake-change', url: 'sounds/change_stake.{ogg,mp3}' },
            { name: 'purchase', url: 'sounds/purchase_sfx.{ogg,mp3}' }
        ]
    }
};
