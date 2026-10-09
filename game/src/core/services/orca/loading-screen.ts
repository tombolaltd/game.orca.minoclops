import { PluginObject, VueConstructor } from 'vue';

import LoadingSplash from '@/src/core/views/loading-splash/index.vue';
import { ORCA_LOADING_SCREEN_ENABLED } from './generated-loading-screen';

/**
 * Passed as `IEngineConfig.VuePlugin`. arcade-base `Vue.use`s it AFTER its
 * default overlays plugin, so registering `loading-splash` here replaces the
 * default loader. When the Orca loading screen is disabled this is a no-op and
 * arcade-base's own loader stays.
 */
export const orcaLoadingScreenPlugin: PluginObject<void> = {
    install(Vue: VueConstructor) {
        if (!ORCA_LOADING_SCREEN_ENABLED) return;
        Vue.component('loading-splash', LoadingSplash);
    }
};
