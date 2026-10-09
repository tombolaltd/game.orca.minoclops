import { defineComponent } from 'vue';

import { ACTIVE_SKIN_NAME } from '../../services/orca/active-skin';
import {
    ORCA_LOADING_SCREEN_BY_SKIN,
    ORCA_LOADING_SCREEN_DEFAULT,
    OrcaLoadingScreenConfig,
    OrcaLoadingScreenGradient
} from '../../services/orca/generated-loading-screen';

type Style = Record<string, string>;
type Orientation = 'portrait' | 'landscape';

interface LayoutScales {
    logoScale: number;
    barWidthScale: number;
    barHeightScale: number;
}

// Read optionally so a stale generated module (no border/layout fields) can never crash boot.
interface LayoutFields {
    progressBorder?: { color?: unknown; width?: unknown };
    layout?: { portrait?: Partial<Record<keyof LayoutScales, unknown>>; landscape?: Partial<Record<keyof LayoutScales, unknown>> };
}

// Twin of the Orca editor's preview (src/components/loading-screen/loadingScreenStyles.ts) — keep the styles in lock-step.
// Styles are inline (no `<style>` block): the look is config-driven and this
// keeps the component free of any CSS loader requirement.
const LOGO_WIDTH = 'min(58vw, 80vh)';
const LOGO_HEIGHT = 'min(28vh, 45vw)';
const BAR_WIDTH = 'min(70vw, 560px)';
const BAR_HEIGHT = 'clamp(18px, 6.5vmin, 30px)';

function scaleFactor(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n / 100 : 1;
}

function resolveLayout(config: object, orientation: Orientation): LayoutScales {
    const entry = (config as LayoutFields).layout?.[orientation];
    return {
        logoScale: scaleFactor(entry?.logoScale),
        barWidthScale: scaleFactor(entry?.barWidthScale),
        barHeightScale: scaleFactor(entry?.barHeightScale)
    };
}

function borderShadow(config: object): string {
    const border = (config as LayoutFields).progressBorder;
    const width = Math.round(Number(border?.width));
    if (!Number.isFinite(width) || width <= 0) return 'none';
    const color = typeof border?.color === 'string' && border.color ? border.color : '#ffffff';
    return `0 0 0 ${width}px ${color}`;
}

function barHeight(scales: LayoutScales): string {
    return `calc(${BAR_HEIGHT} * ${scales.barHeightScale})`;
}

function readViewport(): { width: number; height: number } {
    return typeof window === 'undefined'
        ? { width: 0, height: 0 }
        : { width: window.innerWidth, height: window.innerHeight };
}

function resolveConfig(): OrcaLoadingScreenConfig {
    return Object.prototype.hasOwnProperty.call(ORCA_LOADING_SCREEN_BY_SKIN, ACTIVE_SKIN_NAME)
        ? ORCA_LOADING_SCREEN_BY_SKIN[ACTIVE_SKIN_NAME]
        : ORCA_LOADING_SCREEN_DEFAULT;
}

function gradientCss(gradient: OrcaLoadingScreenGradient): string {
    const stops = gradient.stops.map((stop) => `${stop.color} ${stop.position}%`).join(', ');
    return `linear-gradient(${gradient.angle}deg, ${stops})`;
}

export default defineComponent({
    name: 'OrcaLoadingSplash',

    props: {
        visible: {
            type: Boolean,
            required: true
        },
        progress: {
            type: Number,
            required: true
        }
    },

    data() {
        const viewport = readViewport();
        return {
            viewportWidth: viewport.width,
            viewportHeight: viewport.height
        };
    },

    mounted() {
        window.addEventListener('resize', this.onViewportResize);
        window.addEventListener('orientationchange', this.onViewportResize);
        this.onViewportResize();
    },

    // Vue 2.7 teardown hook.
    beforeDestroy() {
        window.removeEventListener('resize', this.onViewportResize);
        window.removeEventListener('orientationchange', this.onViewportResize);
    },

    methods: {
        onViewportResize(): void {
            const viewport = readViewport();
            this.viewportWidth = viewport.width;
            this.viewportHeight = viewport.height;
        }
    },

    computed: {
        config(): OrcaLoadingScreenConfig {
            return resolveConfig();
        },
        orientation(): Orientation {
            return this.viewportHeight > this.viewportWidth ? 'portrait' : 'landscape';
        },
        scales(): LayoutScales {
            return resolveLayout(this.config, this.orientation);
        },
        percent(): number {
            const value = Number(this.progress);
            return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
        },
        rootStyle(): Style {
            return {
                position: 'absolute',
                top: '0',
                right: '0',
                bottom: '0',
                left: '0',
                zIndex: '999',
                overflow: 'hidden',
                pointerEvents: 'auto',
                userSelect: 'none',
                background: gradientCss(this.config.background)
            };
        },
        logoBoxStyle(): Style {
            return {
                position: 'absolute',
                left: '50%',
                top: '30%',
                transform: 'translate(-50%, -50%)',
                width: `calc(${LOGO_WIDTH} * ${this.scales.logoScale})`,
                height: `calc(${LOGO_HEIGHT} * ${this.scales.logoScale})`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none'
            };
        },
        logoImageStyle(): Style {
            return {
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain'
            };
        },
        barStyle(): Style {
            return {
                position: 'absolute',
                left: '50%',
                top: '55%',
                transform: 'translate(-50%, -50%)',
                width: `calc(${BAR_WIDTH} * ${this.scales.barWidthScale})`,
                height: barHeight(this.scales)
            };
        },
        trackStyle(): Style {
            return {
                position: 'relative',
                width: '100%',
                height: '100%',
                borderRadius: '999px',
                background: this.config.progressTrackColor,
                boxShadow: borderShadow(this.config)
            };
        },
        fillStyle(): Style {
            return {
                position: 'relative',
                width: `${this.percent}%`,
                height: '100%',
                borderRadius: '999px',
                background: gradientCss(this.config.progressFill),
                transition: 'width 0.3s ease-out'
            };
        },
        iconStyle(): Style {
            return {
                position: 'absolute',
                right: '0',
                top: '50%',
                transform: 'translate(50%, -50%)',
                height: `calc(2.8 * ${barHeight(this.scales)})`,
                width: 'auto',
                maxWidth: 'none',
                pointerEvents: 'none'
            };
        }
    }
});
