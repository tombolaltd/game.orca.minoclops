import 'reflect-metadata';

import * as config from '../config.json';
import * as packageJson from '../package.json';

import { IEngineConfig, IOptionalAssetParams, IPackageConfig, ITicketFetcherAssetConfig, ITicketFetcherConfig, TicketFetcher } from '@arcade-client/base-ticketfetcher-package';
import { ContainerModule } from 'inversify';
import { getVarientBindings } from './core/inversify';
import { coreAssetList } from './core/skins/core/asset-list';
import { dummySkin1AssetList } from './core/skins/dummy-skin-1/asset-list';
import { dummySkin2AssetList } from './core/skins/dummy-skin-2/asset-list';
import { DefaultModule as defaultGameBindings } from './core/inversify/default/bindings';

const tfConfig = (config as unknown as ITicketFetcherConfig);
const packageConfig = (packageJson as unknown as IPackageConfig );

const engineConfig: IEngineConfig = {
    GameName: tfConfig.GameName,
    Version: packageConfig.version,
    AssetDesignWidth: tfConfig.AssetDesignWidth,
    AssetDesignHeight: tfConfig.AssetDesignHeight,
    CDNFolderName: tfConfig.CDNFolderName,
    GameHeightRatio: tfConfig.GameHeightRatio,
    FontCSSFilepath: tfConfig.FontCSSFilepath,
    GameMessageObjectName: tfConfig.GameMessageObjectName
};

const ticketFetcher = new TicketFetcher();

const variantRebindings: ContainerModule | undefined = getVarientBindings();

// TODO: Delete this the Ticket Fethcer doesnt have Core Assets or Custom Fonts.
const optionalCoreAssetParams: IOptionalAssetParams = { coreGameAssetList: coreAssetList, customFonts: [''] };
// TODO: Change to the skin that matches the engine (e.g. { phoenix: phoenixAssetList, galleon: galleonAssetList })
const gameAssets: ITicketFetcherAssetConfig = { gameSkinAssetList: { dummySkin1: dummySkin1AssetList, dummySkin2: dummySkin2AssetList }, optionalParams: optionalCoreAssetParams };

ticketFetcher.init(engineConfig, gameAssets, defaultGameBindings, variantRebindings);