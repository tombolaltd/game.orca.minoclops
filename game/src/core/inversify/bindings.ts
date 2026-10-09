import { ContainerModule } from 'inversify';

import { Injects, ISkinDesc, ICabinetOptions, BaseCabinet, BigWin, IBigWinOptions, queryStringParams, AssetData, ITranslationVersions, device } from '@game-studio/arcade-base';

import { default as OrcaHtpPage } from '@/src/core/views/game-info/orca-htp/orca-htp-page.vue';

import { coreDataList } from '@/src/skins/core/data-list';
import { debugModel, DebugModel } from '@/src/core/models/debug';
import { gameModel, GameModel } from '@/src/core/models/game-model';
import { gameSettings, GameSettings } from '@/src/core/models/game-settings';
import { GameApplication } from '@/src/core/views/game/application';
import { ACTIVE_SKIN } from '@/src/core/services/orca/active-skin';
import { preloadOrcaGameRules } from '@/src/core/services/orca/game-rules';
import { createOrcaCabinet } from '@/src/core/services/orca/cabinet-factory';

// arcade-base throws when the host supplied no `?skin=` — see `skin-resolver.ts`.
function readRequestedSkin(): string {
    try {
        const requested = queryStringParams.currentSkin;
        return typeof requested === 'string' ? requested : '';
    } catch (err) {
        return '';
    }
}

export const containerModule = new ContainerModule((bind, _, __, rebind) => {
    bind<AssetData>(Injects.LocalDataList).toConstantValue(coreDataList);
    bind<GameModel>(Injects.GameModel).toConstantValue(gameModel);
    bind<GameSettings>(Injects.GameSettings).toConstantValue(gameSettings);
    bind<DebugModel>(Injects.DebugModel).toConstantValue(debugModel);

    bind<() => void>(Injects.SkinFactory).toFactory(() => {
        return async () => {
            // The folder is the RESOLVED skin, not the raw `?skin=` tile name —
            // a Skin override lets those legitimately differ.
            const skinName = ACTIVE_SKIN;
            const requestedSkin = readRequestedSkin();
            if (requestedSkin && requestedSkin !== skinName) {
                console.warn(`Launcher requested skin "${requestedSkin}", which is not a folder in this bundle. Loading resolved skin "${skinName}" instead.`);
            }

            try {
                const { getDataList, getSkinConfig } = await import(
                    /* webpackInclude: /[\\/]index\.(ts|js)$/ */
                    /* webpackChunkName: "skin-[request]" */
                    `@/src/skins/${skinName}`
                );

                if (getDataList === undefined) { console.error(`skinDataList export missing in @/src/skins/${skinName}.`); }
                if (getSkinConfig === undefined) { console.error(`skinConfig export missing in @/src/skins/${skinName}.`); }

                const skin = { dataList: getDataList(), config: getSkinConfig() } as ISkinDesc;
                bind<ISkinDesc>(Injects.Skin).toConstantValue(skin);
            } catch (error) {
                console.error(`Failed to load skin from @/src/skins/${skinName}: ${error}. Injects.Skin will be left unbound, so the game cannot start.`);
            }
        };
    });

    bind<() => void>(Injects.ComponentsFactory).toFactory(() => {
        return () => {
            const cabinetOptions: ICabinetOptions = {
                // TODO: Configure your cabinet by passing in any desired options
            };
            // Standard / None / Casino comes from Orca's Project Settings ▸ Cabinet.
            const cabinet = createOrcaCabinet(cabinetOptions);
            bind<BaseCabinet>(Injects.Cabinet).toConstantValue(cabinet);
            
            const bigWinOptions: Partial<IBigWinOptions> = {
                // TODO: Configure your bigwin component here
                assetNames: {
                    spine: 'big-win',
                    sounds: {
                        on: 'sfx-big-win',
                        off: ''
                    }
                }
            };
            bind<BigWin>(Injects.BigWin).toConstantValue(new BigWin(bigWinOptions));
        };
    });

    bind<ITranslationVersions>(Injects.TranslationVersions).toConstantValue({
        errors: 1,
        game: 1,
        shared: 1,
        chatRules: 1
    });

    // Orca Game Rules: must run before arcade-base substitutes {{RTP}}-style placeholders.
    bind<(onProgress?: (progress: number) => void) => Promise<void>>(Injects.PreloadAssetsFunction)
        .toFunction((onProgress) => preloadOrcaGameRules(onProgress));

    bind(Injects.GameApp).toConstantValue(new GameApplication());

    rebind(Injects.AssetQualityGetter).toFunction(() => device.type.isMobile ? '0.5' : '1');
    // Renders the document authored in Orca's HTP Editor. Swap back to the
    // hand-built `views/game-info/game-info.vue` for a bespoke How-To-Play.
    rebind(Injects.VueHTPComponent).toConstantValue(OrcaHtpPage);
});
