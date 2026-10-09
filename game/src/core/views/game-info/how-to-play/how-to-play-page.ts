import { defineComponent } from 'vue';

import { environment, gameConfig } from '@game-studio/arcade-base';
import { diContainer } from '@/src/core/inversify';
export default defineComponent({
    name: 'HowToPlayPage',
    props: {
        scrollable: {
            type: Boolean,
            default: true
        },
        selectedTab: {
            type: Number,
            required: true
        },
        tabId: {
            type: Number,
            required: true
        },
        showControls: {
            type: Boolean,
            required: true
        }
    },
    data: () => ({
        scale: 1,
        scrollType: 'auto',
        strings: diContainer.strings.vueHtp
    }),
    computed: {
        contentStyle() {
            return {
                background: 'linear-gradient(0deg, rgba(6, 35, 28, 1) 0%, rgba(31, 110, 30) 100%)',
            };
        },
        containerStyle() {
            return {
                maxWidth: '100%',
                'justify-self': 'center',
            };
        }
    },
    watch: {
        selectedTab(newVal) {
            if (this.scrollable === false && newVal === this.tabId) {
                this.updateScale();
            }
        }
    },
    mounted: function() {
        if (this.scrollable === false) {
            this.scrollType = 'unset';
            this.updateScale();
            window.addEventListener('resize', this.updateScale);
            window.addEventListener('orientationchange', this.updateScale);
        }
    },
    beforeDestroy() {
        if (!this.scrollable) {
            window.removeEventListener('resize', this.updateScale);
            window.removeEventListener('orientationchange', this.updateScale);
        }
    },
    methods: {
        assetPath(path: string): string {
            const skinName = gameConfig.assetFolder;
            if (environment === 'debug' && process.env.LOCALASSETPORT !== undefined) {
                return `http://127.0.0.1:${process.env.LOCALASSETPORT}/static/assets/${skinName}/${path}`;
            }
            return `./static/assets/${skinName}/${path}`;
        },
        localisedString(stringName: string): string {
            if (this.strings && (stringName in this.strings)) {
                return this.strings[stringName];
            }
            return stringName;
        },
        colourisedLocaleString(stringName: string): string {
            const result = this.localisedString(stringName);
            if (result.includes('=')) {
                const parts = result.split('=');
                return `<span style="color: #a5aabc;">${parts[0]}</span>${parts[1]}`;
            }
            return result;
        },
        updateScale() {
            this.scale = 1;
            this.$nextTick(() => {
                const container = this.$refs.container;
                const content = this.$refs.content;
                if (!container || !content) return;

                const containerHeight = (container as HTMLDivElement).clientHeight;
                const contentHeight = (content as HTMLDivElement).scrollHeight;

                const newScale = (contentHeight * 0.9) / containerHeight;

                if (this.scale !== newScale) {
                    this.scale = newScale;
                }
            });
        }
    }
});