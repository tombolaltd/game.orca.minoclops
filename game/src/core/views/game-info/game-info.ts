import { defineComponent } from 'vue';

import { environment, eventEmitter, gameConfig } from '@game-studio/arcade-base';

import { diContainer } from '../../inversify';

import HowToPlayPage from './how-to-play/how-to-play-page.vue';
import PayTablePage from './pay-table/pay-table-page.vue';

interface IData {
    selectedTab: number;
    playbutton: string;
    selectedColor: string;
    unselectedColor: string;
    backgroundColor: string;
    unselectedTextColor: string;
    selectedTextColor: string;
    isVisible: boolean;
    closeBtnImagePath: string;
    showControls: boolean;
}

export default defineComponent({
    name: 'HowToPlayView',
    components: {
        HowToPlayPage,
        PayTablePage
    },
    data() {
        return {
            selectedTab: 1,
            playbutton: 'play.png',
            selectedColor: '#00736a',
            unselectedColor: '#b1e3e0',
            backgroundColor: '#005b05ff',
            unselectedTextColor: '#00736a',
            selectedTextColor: '#ffffff',
            isVisible: false,
            closeBtnImagePath: '',
            showControls: true
        } as IData;
    },
    computed: {
        rootStyle() {
            return {
                'font-family': 'Wallop-Bold'
            };
        }
    },
    async mounted() {
        eventEmitter.on('POPUP_TOGGLE_HTP_POPUP', (visibility: boolean | void) => {
            if (visibility === false) {
                this.isVisible = false;
                return;
            }

            this.isVisible = !this.isVisible;
            this.selectedTab = 2;
        });

        eventEmitter.on('POPUP_TOGGLE_GAME_INFO', (visibility: boolean | void) => {
            if (visibility === false) {
                this.isVisible = false;
                return;
            }
            
            this.isVisible = !this.isVisible;
            this.selectedTab = 1;
        });

        const coreAssetVersion = diContainer.adminSettings.assetVersion.core;
            const assetsBaseUrl = (environment === 'debug' && process.env.LOCALASSETPORT !== undefined) ?
                `http://127.0.0.1:${process.env.LOCALASSETPORT}/static/assets/`:
                './static/assets/';
            const localAssetFilePath = assetsBaseUrl + 'core/how-to-play/';
            const coreAssetFilePath = assetsBaseUrl + 'core/' + coreAssetVersion + '/how-to-play/';
        this.closeBtnImagePath = gameConfig.features.usingLocalAssets ? localAssetFilePath : coreAssetFilePath;
    },
    methods: {
        hide() {
            this.isVisible = false;
        },
        select(newTab: number) {
            this.selectedTab = newTab;
        },
        controlColour(tab: number) {
            const colour = tab !== this.selectedTab ? this.unselectedColor : this.selectedColor;
            const textColour = tab !== this.selectedTab ? this.unselectedTextColor : this.selectedTextColor;

            return {
                background: colour,
                color: textColour,
            };
        },
        localisedString(stringName: string): string {
            const strings = diContainer.strings.vueHtp;
            if (strings && (stringName in strings)) {
                return strings[stringName];
            }
            return stringName;
        }
    }
});
