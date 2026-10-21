import { AssetData } from '@game-studio/arcade-base';

export function getDataList(): AssetData {
    return {
        default: {
            textures: [],
            spriteSheets: [],
            animations: [
                // asset-manager@6 resolves a spine's atlas by `<spineName>Atlas`
                // and no longer side-loads it, so the atlas must be declared.
                {
                    name: 'big-win',
                    url: 'base/big-win/bigWin.json',
                    dependencies: [
                        { name: 'big-winAtlas', url: 'base/big-win/bigWin.atlas' }
                    ]
                }
            ],
            sounds: [
                { name: 'sfx-big-win', url: 'base/sounds/big-win.{ogg,mp3}' }
            ]
        }
    };
}
