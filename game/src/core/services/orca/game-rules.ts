import { AssetManager, container } from '@game-studio/arcade-base';
import { Assets, ImageSource, Texture } from 'pixi.js';

import { ACTIVE_SKIN } from './active-skin';
import {
    ORCA_GAME_RULES,
    ORCA_GAME_RULES_BASE_LANGUAGE,
    ORCA_GAME_RULES_IMAGES_BY_SKIN,
    OrcaGameRulesDocument,
} from './generated-game-rules';
import { translations } from './methods/translations';
import { hasTranslationMarkup, translationMarkupToPlainText } from './translation-markup';

/**
 * Orca-authored Game Rules.
 *
 * Replaces `container.strings.gameRules` with the document authored in the
 * editor's Game Rules window (mirrored into `./generated-game-rules.ts` —
 * auto-generated, never hand-edit) and registers its images under the aliases
 * the codegen emitted (`skin:orca-rules-<hex>`).
 *
 * The pixi-8 arcade-base game-rules view renders `<img :src>` from
 * `Assets.resolver.hasKey(alias) ? Assets.resolver.resolveUrl(alias) : ''` — the
 * RESOLVER, not the cache — so every alias is added to `Assets.resolver` up
 * front. The loaded texture is ALSO put in the cache (`AssetManager.setAsset`)
 * for builds that read `AssetManager.getTexture(alias)` instead.
 *
 * Bound as `Injects.PreloadAssetsFunction` in `inversify/bindings.ts`: that is
 * the only hook arcade-base awaits AFTER the strings are loaded and BEFORE
 * `Bootstrap.localiseDynamicStrings()` substitutes `{{RTP}}` / `{{gameStakes}}`
 * / … into `strings.gameRules`. `GameApplication.preInit()` runs after that
 * substitution, so applying the rules there would render raw placeholders.
 *
 * An empty `ORCA_GAME_RULES` is a strict no-op: the game's own rules stay.
 */

const IMAGE_TIMEOUT_MS = 10000;

let applied = false;
let imagesPromise: Promise<void> | null = null;

function normalizeCode(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function languageOf(code: string): string {
    return code.split(/[-_]/)[0];
}

/** exact → case-insensitive → language prefix → base language → first entry. */
function pickLocale(requested: string): string | null {
    const locales = Object.keys(ORCA_GAME_RULES);
    if (locales.length === 0) return null;

    const code = normalizeCode(requested);
    if (code) {
        if (Object.prototype.hasOwnProperty.call(ORCA_GAME_RULES, code)) return code;
        const caseInsensitive = locales.find((l) => normalizeCode(l) === code);
        if (caseInsensitive) return caseInsensitive;
        const language = languageOf(code);
        const prefix = locales.find((l) => languageOf(normalizeCode(l)) === language);
        if (prefix) return prefix;
    }

    const base = normalizeCode(ORCA_GAME_RULES_BASE_LANGUAGE);
    const baseMatch = locales.find((l) => normalizeCode(l) === base);
    return baseMatch ?? locales[0];
}

function readActiveLocale(): string {
    try {
        return translations.getTranslationLocale();
    } catch (err) {
        return '';
    }
}

/**
 * The pixi-8 arcade-base `GameRules` view renders every title and `text` /
 * `title` item through `{{ }}` interpolation, never `v-html`, so rich-text
 * markup would show as literal tags. Flatten it to plain text (line breaks
 * kept); plain values pass through unchanged.
 */
function flattenRulesMarkup(doc: OrcaGameRulesDocument): OrcaGameRulesDocument {
    if (hasTranslationMarkup(doc.title)) doc.title = translationMarkupToPlainText(doc.title);
    for (const block of doc.blocks ?? []) {
        if (hasTranslationMarkup(block.title)) block.title = translationMarkupToPlainText(block.title);
        for (const item of block.content ?? []) {
            if (item.type !== 'text' && item.type !== 'title') continue;
            if (!hasTranslationMarkup(item.value)) continue;
            item.value = translationMarkupToPlainText(item.value);
            // `<p>` / `<h3>` collapse `\n`; keep the authored line breaks.
            if (item.value.indexOf('\n') !== -1) {
                const style = typeof item.style === 'string' ? item.style.trim() : '';
                item.style = `${style}${style && !style.endsWith(';') ? ';' : ''}white-space:pre-line`;
            }
        }
    }
    return doc;
}

/**
 * Assign a deep clone of the active locale's document to `strings.gameRules`.
 * @returns true when Orca rules were applied.
 */
export function applyOrcaGameRules(strings: { gameRules?: OrcaGameRulesDocument } | undefined): boolean {
    if (!strings) return false;
    const locale = pickLocale(readActiveLocale());
    if (locale === null) return false;
    const document = ORCA_GAME_RULES[locale];
    if (!document) return false;
    strings.gameRules = flattenRulesMarkup(JSON.parse(JSON.stringify(document)) as OrcaGameRulesDocument);
    return true;
}

/** Same folder the game serves the rest of `static/` from, in dev and prod. */
function staticUrl(staticRelativePath: string): string {
    const encoded = staticRelativePath.split('/').map(encodeURIComponent).join('/');
    return new URL(`static/${encoded}`, document.baseURI).toString();
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const image = new Image();
        const timer = setTimeout(() => finish(null), IMAGE_TIMEOUT_MS);
        function finish(result: HTMLImageElement | null): void {
            clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            resolve(result);
        }
        image.onload = () => finish(image);
        image.onerror = () => finish(null);
        image.src = url;
    });
}

async function registerImages(): Promise<void> {
    const images = ORCA_GAME_RULES_IMAGES_BY_SKIN[ACTIVE_SKIN];
    if (!images) return;

    const failed: string[] = [];
    await Promise.all(Object.keys(images).map(async (alias) => {
        const relPath = images[alias];
        let url = relPath;
        try {
            url = staticUrl(relPath);
            // Registered before the load so a slow/late image still renders when the view mounts.
            if (!Assets.resolver.hasKey(alias)) Assets.resolver.add({ alias, src: url });
            if (Assets.cache.has(alias)) return;
            const image = await loadImage(url);
            if (!image) {
                failed.push(url);
                return;
            }
            AssetManager.setAsset(alias, new Texture({ source: new ImageSource({ resource: image }) }));
        } catch (err) {
            failed.push(url);
        }
    }));

    if (failed.length > 0) {
        console.warn(`[game-rules] ${failed.length} Game Rules image(s) failed to load and will not render: ${failed.join(', ')}`);
    }
}

/** Load + register the active skin's Game Rules images. Never rejects. */
export function preloadOrcaGameRulesImages(): Promise<void> {
    if (!imagesPromise) {
        imagesPromise = registerImages().catch((err) => {
            console.warn('[game-rules] image registration failed:', err);
        });
    }
    return imagesPromise;
}

/**
 * `Injects.PreloadAssetsFunction`: apply the authored rules, then register
 * their images. Never rejects, so it can never fail the arcade-base boot.
 */
export async function preloadOrcaGameRules(onProgress?: (progress: number) => void): Promise<void> {
    try {
        if (!applied) {
            applied = true;
            if (Object.keys(ORCA_GAME_RULES).length > 0) {
                let strings: { gameRules?: OrcaGameRulesDocument } | undefined;
                try {
                    strings = container.strings;
                } catch (err) {
                    console.warn('[game-rules] strings are not bound; keeping the game\'s own rules.', err);
                }
                if (applyOrcaGameRules(strings)) await preloadOrcaGameRulesImages();
            }
        }
    } catch (err) {
        console.warn('[game-rules] failed to apply Orca Game Rules:', err);
    }
    if (onProgress) onProgress(1);
}
