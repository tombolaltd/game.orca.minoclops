import { defineComponent } from 'vue';

import { environment, gameConfig, queryStringParams } from '@game-studio/arcade-base';

import { diContainer } from '@/src/core/inversify';
import { gameSettings } from '@/src/core/models/game-settings';

export default defineComponent({
    name: 'PayTablePage',
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
        symbols: [
            [
                {
                    "symbolID": 8,
                    "image": "symbol8.png"
                },
                {
                    "symbolID": 7,
                    "image": "symbol7.png"
                },
                {
                    "symbolID": 6,
                    "image": "symbol6.png"
                },
                {
                    "symbolID": 5,
                    "image": "symbol5.png"
                },
                {
                    "symbolID": 4,
                    "image": "symbol4.png"
                },
                {
                    "symbolID": 3,
                    "image": "symbol3.png"
                },
                {
                    "symbolID": 2,
                    "image": "symbol2.png"
                }
            ]
        ]
    }),
    computed: {
        contentStyle() {
            return {
                background: 'linear-gradient(0deg, rgba(32, 115, 31, 1) 0%, rgba(2, 7, 2, 1) 100%)',
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
    mounted() {
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
        logoPath(): string {
            return this.assetPath(`logos/logo.${queryStringParams.locale}.png`);
        },
        assetPath(path: string): string {
            const skinName = gameConfig.assetFolder;
            if (environment === 'debug' && process.env.LOCALASSETPORT !== undefined) {
                return `http://127.0.0.1:${process.env.LOCALASSETPORT}/static/assets/${skinName}/${path}`;
            }
            return `./static/assets/${skinName}/${path}`;
        },
        localisedString(stringName: string): string {
            const strings = diContainer.strings.vueHtp;
            if (strings && (stringName in strings)) {
                return strings[stringName];
            }
            return stringName;
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
        },
        scrollStyle() {
            return {
                transform: `scale(${this.scale})`,
                transformOrigin: 'top center',
                'overflow-y': `${this.scrollType}`
            };
        },
        maxSymbolWidth() {
            return '25%';
        },
        getSymbolText(symbolID: number) {
            const symbolData = gameSettings.symbolPayoutData;

            for (let i = 0; i < symbolData.length; i++) {
                if (symbolData[i].symbolID === symbolID) {
                    let string = '';
                    for (let j = 0; j < symbolData[i].payout.length; j++) {
                        const matched = symbolData[i].payout[j].matched;
                        const multiplier = symbolData[i].payout[j].multiplier;
                        const stake = diContainer.stake.currentStake;
                        const payout = diContainer.currencyFormatter.precise(stake * multiplier);
                        string += `<span style="color: orange;">x${matched}</span> = ${payout}`;
                        if (j !== symbolData[i].payout.length - 1) {
                            string += '<br>';
                        }
                    }
                    return string;
                }
            }

            return 'error fetching symbol data, have you bound it correctly?';
        }
    }
});