import { Injects } from '@arcade-client/base-ticketfetcher-package';
import { ContainerModule } from 'inversify';
import { strings } from './strings';

export const SwedenModule = new ContainerModule((_, __, ___, rebind) => {
    // TODO: If no regional strings are defined, this rebind can be removed.
    rebind(Injects.Strings).toConstantValue(strings);
});