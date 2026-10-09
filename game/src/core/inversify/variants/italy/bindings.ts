import { ContainerModule } from 'inversify';

import { Injects, ITranslationVersions, queryStringParams } from '@game-studio/arcade-base';

export const containerModule = new ContainerModule((_, __, ___, rebind) => {
    rebind<ITranslationVersions>(Injects.TranslationVersions).toConstantValue({
        errors: 0,
        shared: 0,
        chatRules: 1,
        game: 1
    });

    rebind(Injects.UserPrefsGameName).toConstantValue(queryStringParams.currentSkin);
});
