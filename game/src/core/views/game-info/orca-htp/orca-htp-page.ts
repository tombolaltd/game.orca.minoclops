import { defineComponent } from 'vue';

import { device, eventEmitter, SettingsEventEmitter } from '@game-studio/arcade-base';

import { diContainer } from '../../../inversify';
import { gameSettings } from '../../../models/game-settings';
import { ACTIVE_SKIN } from '../../../services/orca/active-skin';
import { HTP_BY_SKIN } from '../../../services/orca/generated-htp';
import { translations } from '../../../services/orca/methods/translations';
import { ORCA_TRANSLATIONS, ORCA_TRANSLATION_BASE_LANGUAGE } from '../../../services/orca/generated-translations';
// The editor's own How-To-Play renderer (copied from Orca's packages), so the
// game draws exactly what the HTP Editor previews.
import { HtpPreviewPage } from './htp-preview';

/**
 * Host for the authored How-To-Play document.
 *
 * `Injects.VueHTPComponent` is mounted by arcade-base as a bare
 * `createElement(component, { tag: 'component' })` — with NO props and NO
 * attrs — so the preview package can never be bound directly. This wrapper
 * exists purely to own the popup chrome and to feed the live game state in.
 */

type HtpLayoutMode = 'desktop' | 'portrait' | 'landscape';

interface IChatRect {
    top: number;
    left: number;
    width: number;
    height: number;
}

interface IData {
    isVisible: boolean;
    layoutMode: HtpLayoutMode;
    chatRect: IChatRect | null;
}

interface ILayoutTracking {
    onViewportChange: () => void;
    observer: ResizeObserver | null;
    observed: Element | null;
}

const layoutTracking = new WeakMap<object, ILayoutTracking>();

/** The runtime's 3-way rule (methods/device.ts), read here without importing that cycle cluster. */
function detectDeviceMode(): HtpLayoutMode {
    if (device?.type?.isDesktop === true) return 'desktop';
    return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

const CHAT_SELECTORS = ['#app .companion-component', 'iframe.chat-panel'];

/** First chat element with a non-zero rect, else the first one present (to watch for it expanding). */
function findChatElement(): { el: Element | null; rect: DOMRect | null } {
    let first: Element | null = null;
    for (const selector of CHAT_SELECTORS) {
        const el = document.querySelector(selector);
        if (!el) continue;
        first = first ?? el;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return { el, rect };
    }
    return { el: first, rect: null };
}

/** `main.orca.projectSettings` is authoring-side only, so the document is
 *  selected by the SAME key the rest of the runtime uses: the effective folder. */
function activeDocument() {
    return HTP_BY_SKIN[ACTIVE_SKIN] ?? null;
}

/**
 * Reads a field off the adopted GameSettings model without binding this file to
 * it at compile time. The model is user-authored (AGENTS.md rule 14a) — a game
 * that renames or drops `rtp` / `stakeOptions` must still build.
 */
function settingsField<T>(name: string): T | undefined {
    const value = (gameSettings as unknown as Record<string, unknown>)[name];
    return value === undefined || value === null ? undefined : (value as T);
}

/** Subunits → display string. Falls back to the raw number pre-boot. */
function formatCurrency(subunits: number): string {
    const formatter = diContainer.currencyFormatter;
    return formatter ? formatter.precise(subunits) : String(subunits);
}

function readCurrentStake(): number {
    return diContainer.stake?.currentStake ?? 0;
}

let warnedMissingBackArrow = false;

export default defineComponent({
    name: 'OrcaHtpPage',
    components: {
        HtpPreviewPage
    },
    data() {
        return {
            isVisible: false,
            layoutMode: 'portrait',
            chatRect: null
        } as IData;
    },
    computed: {
        layoutClass(): string {
            return `orca-htp--${this.layoutMode}`;
        },
        layoutStyle(): Record<string, string> | undefined {
            const rect = this.chatRect;
            if (this.layoutMode !== 'desktop' || !rect) return undefined;
            return {
                top: `${rect.top}px`,
                left: `${rect.left}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`
            };
        },
        sections(): unknown[] {
            return activeDocument()?.contents ?? [];
        },
        injectedImages(): Record<string, string> | undefined {
            return activeDocument()?.injectedImages;
        },
        /** The game's title under "How to play" — read loosely: an older generated module lacks it. */
        gameName(): string {
            const name = (activeDocument() as { gameName?: unknown } | null)?.gameName;
            return typeof name === 'string' ? name : '';
        },
        /**
         * Image names were rewritten to bucket-relative paths by the editor's
         * HTP codegen, which mirrors the binaries to
         * `game/static/htp/<effective skin>/`. An ABSOLUTE base is required:
         * the package resolves relative names with `new URL(name, folderPath)`
         * and falls back to a dead `game-asset://` URL for anything else.
         */
        folderPath(): string {
            return new URL(`static/htp/${ACTIVE_SKIN}/`, document.baseURI).toString();
        },
        currentLanguageCode(): string {
            return translations.getTranslationLocale();
        },
        /** Base language underneath so a partially-translated locale still renders. */
        translationTable(): Record<string, string> {
            const locale = translations.getTranslationLocale();
            return {
                ...(ORCA_TRANSLATIONS[ORCA_TRANSLATION_BASE_LANGUAGE] ?? {}),
                ...(ORCA_TRANSLATIONS[locale] ?? {})
            };
        },
        /** `{{RTP}}` / `{{STAKES}}` / … placeholders authored in the document. */
        tokens(): Record<string, string> {
            const rtp = settingsField<string>('rtp') ?? '';
            const stakeOptions = settingsField<number[]>('stakeOptions') ?? [];
            const maxWin = settingsField<number>('maxWinStakeMultiplier');
            const defaultStake = settingsField<number>('defaultStake');
            return {
                RTP: rtp,
                TotalRTP: rtp,
                STAKES: stakeOptions.map(formatCurrency).join(', '),
                MAX_PAYOUT: maxWin === undefined ? '' : formatCurrency(maxWin * readCurrentStake()),
                defaultStake: defaultStake === undefined ? '' : formatCurrency(defaultStake)
            };
        },
        currentStake(): number {
            return readCurrentStake();
        },
        /** Structurally identical to the package's `HtpSymbolData`. */
        symbolData(): unknown {
            return settingsField<unknown[]>('symbolPayoutData') ?? [];
        }
    },
    mounted() {
        // Fixed geometry must escape arcade-base's ancestors (transforms / stacking contexts);
        // the stable inner layer moves, not $el, so the parent's vdom diff never loses a node.
        const layer = this.$refs.layer as HTMLElement | undefined;
        if (layer && document.body) document.body.appendChild(layer);

        eventEmitter.on('POPUP_TOGGLE_HTP_POPUP', (visibility: boolean | void) => {
            if (visibility === false) {
                this.isVisible = false;
                return;
            }
            this.isVisible = !this.isVisible;
        });

        eventEmitter.on('POPUP_TOGGLE_GAME_INFO', (visibility: boolean | void) => {
            if (visibility === false) {
                this.isVisible = false;
                return;
            }
            this.isVisible = !this.isVisible;
        });
    },
    beforeDestroy() {
        this.stopLayoutTracking();
        const layer = this.$refs.layer as HTMLElement | undefined;
        if (layer && this.$el && layer.parentNode !== this.$el) this.$el.appendChild(layer);
    },
    watch: {
        isVisible(visible: boolean) {
            if (visible) this.startLayoutTracking();
            else this.stopLayoutTracking();
            if (!visible || warnedMissingBackArrow) return;
            // The back arrow is the ONLY way to close this panel, so a package
            // rename of that class must not fail silently.
            this.$nextTick(() => {
                const layer = this.$refs.layer as HTMLElement | undefined;
                if (layer?.querySelector?.('.back-arrow')) return;
                warnedMissingBackArrow = true;
                console.warn('[OrcaHtpPage] No .back-arrow in the rendered How-To-Play — the close control is inert.');
            });
        }
    },
    methods: {
        hide() {
            this.isVisible = false;
        },
        updateLayout() {
            const mode = detectDeviceMode();
            const chat = mode === 'desktop' ? findChatElement() : { el: null, rect: null };
            if (chat.rect) {
                const { top, left, width, height } = chat.rect;
                this.layoutMode = 'desktop';
                this.chatRect = { top, left, width, height };
            } else {
                // Desktop with no visible chat to cover (disabled / collapsed) uses the side panel.
                this.layoutMode = mode === 'desktop' ? 'landscape' : mode;
                this.chatRect = null;
            }
            this.observeChat(chat.el);
        },
        observeChat(chat: Element | null) {
            const tracking = layoutTracking.get(this);
            // observe() always fires once, so re-observing the same element would loop.
            if (!tracking || typeof ResizeObserver === 'undefined' || tracking.observed === chat) return;
            if (!tracking.observer) tracking.observer = new ResizeObserver(() => this.updateLayout());
            tracking.observer.disconnect();
            tracking.observed = chat;
            if (chat) tracking.observer.observe(chat);
        },
        startLayoutTracking() {
            if (!layoutTracking.has(this)) {
                const onViewportChange = () => this.updateLayout();
                layoutTracking.set(this, { onViewportChange, observer: null, observed: null });
                window.addEventListener('resize', onViewportChange);
                window.addEventListener('orientationchange', onViewportChange);
            }
            this.updateLayout();
        },
        stopLayoutTracking() {
            const tracking = layoutTracking.get(this);
            if (!tracking) return;
            window.removeEventListener('resize', tracking.onViewportChange);
            window.removeEventListener('orientationchange', tracking.onViewportChange);
            tracking.observer?.disconnect();
            layoutTracking.delete(this);
        },
        /**
         * The package's header back-arrow renders no click handler of its own,
         * so closing is delegated from here. `.back-arrow` is the package's
         * internal class — a rename silently breaks this, which is what the
         * one-shot warning below is for.
         */
        onPanelClick(event: MouseEvent) {
            const target = event.target as Element | null;
            if (target && typeof target.closest === 'function' && target.closest('.back-arrow')) {
                this.hide();
            }
        },
        /** An authored component's `onClick` fires a project event verbatim. */
        onHtpEvent(event: string) {
            // Cast like every other dynamic emit in the runtime: `emit` is
            // typed against the known event-name unions, and an authored name
            // is a project custom event.
            if (event) eventEmitter.emit(event as any);
        },
        /**
         * "For full game rules click here". arcade-base shows the rules itself only
         * in the app; on the web they are the settings menu's Game Rules page.
         */
        openGameRules() {
            this.hide();
            if (device?.type?.isApp === true) {
                eventEmitter.emit('POPUP_TOGGLE_GAME_RULES', true);
                return;
            }
            // 'show' renders the menu's pages; 'inGameShow' opens Game Rules once the menu has slid in.
            SettingsEventEmitter.emit('show');
            SettingsEventEmitter.emit('inGameShow', { id: 'game-rules' });
        },
        currencyConverter(value: number): string {
            return formatCurrency(value);
        }
    }
});
