import { ContainerModule } from 'inversify';

import { Injects } from '@game-studio/arcade-base';

export const containerModule = new ContainerModule((_, __, ___, rebind) => {
    // example of rebinding something to a new value
    rebind(Injects.UserPrefsGameName).toConstantValue('minoclop-spain');
});
