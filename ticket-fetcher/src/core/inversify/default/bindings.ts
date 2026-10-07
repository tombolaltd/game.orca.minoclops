import { BaseAppView, Injects } from '@arcade-client/base-ticketfetcher-package';
import { ContainerModule } from 'inversify';
import { AppModel } from '../../model/app-model';
import { DebugModel } from '../../model/debug-model';
import { AppView } from '../../view/app-view';
import { DetailsBlock } from '../../view/game-details-block';
import { ITicketFetcherStrings } from 'src/types';
import { strings } from '../../../core/skins/core/strings';

export const DefaultModule: ContainerModule = new ContainerModule((bind) => {
    bind<BaseAppView>(Injects.Application).to(AppView).inSingletonScope();
    bind<AppModel>(Injects.AppModel).to(AppModel).inSingletonScope();
    bind<DebugModel>(Injects.DebugModel).to(DebugModel).inSingletonScope();
    bind<DetailsBlock>(Injects.GameDetailsBlock).to(DetailsBlock).inSingletonScope();
    bind<ITicketFetcherStrings>(Injects.Strings).toConstantValue(strings);
});