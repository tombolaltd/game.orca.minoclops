import { queryStringParams } from "@game-studio/arcade-base";
import {
    ORCA_TRANSLATIONS,
    ORCA_TRANSLATION_BASE_LANGUAGE,
    ORCA_TRANSLATION_LANGUAGES,
} from "../generated-translations";

/**
 * Translation Methods for FlowState
 *
 * Reads the project's authored translation table, mirrored by the Orca editor
 * into `../generated-translations.ts` (auto-generated — never hand-edit).
 *
 * Lookup ladder for every getter:
 *   1. the ACTIVE locale (`?locale=` -> exact match -> case-insensitive match)
 *   2. the authored BASE language
 *   3. the key itself
 *
 * Returning the key (rather than an empty string) mirrors arcade-base's own
 * `localisedString(stringName)` convention, so an unauthored key is visible in
 * game instead of silently rendering as nothing.
 */

/** Unresolved keys already warned about — one console line per key, ever. */
const warnedMissingKeys = new Set<string>();

function normalizeCode(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

class TranslationMethods {
    /**
     * The locale the host launched the game with, or '' when unavailable.
     *
     * The arcade-base `queryStringParams` module THROWS when the param is
     * absent, so the read is guarded — a non-shell host (plain `index.html`,
     * a test harness) must still run.
     */
    private readRequestedLocale(): string {
        try {
            return normalizeCode(queryStringParams.locale);
        } catch (err) {
            return '';
        }
    }

    /**
     * Resolve an arbitrary locale string to a language code that actually
     * exists in the generated table, falling back to the base language.
     */
    private resolveLanguage(requested: string): string {
        const code = normalizeCode(requested);
        if (code) {
            if (Object.prototype.hasOwnProperty.call(ORCA_TRANSLATIONS, code)) return code;
            // `?locale=EN-GB` / `en_GB`-style casing must still resolve.
            const match = ORCA_TRANSLATION_LANGUAGES.find((lang) => normalizeCode(lang) === code);
            if (match) return match;
        }
        return ORCA_TRANSLATION_BASE_LANGUAGE;
    }

    /** Non-empty value for `key` in `language`, or '' when there isn't one. */
    private lookupInLanguage(language: string, key: string): string {
        const table = ORCA_TRANSLATIONS[language];
        if (!table) return '';
        const value = table[key];
        return typeof value === 'string' && value ? value : '';
    }

    /** Active locale -> base language -> '' (the caller decides the fallback). */
    private resolveWithFallback(language: string, key: string): string {
        const active = this.lookupInLanguage(language, key);
        if (active) return active;
        if (language !== ORCA_TRANSLATION_BASE_LANGUAGE) {
            const base = this.lookupInLanguage(ORCA_TRANSLATION_BASE_LANGUAGE, key);
            if (base) return base;
        }
        return '';
    }

    private warnMissingOnce(key: string, language: string): void {
        if (warnedMissingKeys.has(key)) return;
        warnedMissingKeys.add(key);
        console.warn(`[Translations] No value for key "${key}" in "${language}" or base language "${ORCA_TRANSLATION_BASE_LANGUAGE}" — using the key.`);
    }

    /**
     * Look up a translation key in the ACTIVE locale.
     * @param key the authored translation key
     * @returns the translated value, else the base-language value, else `key`
     */
    public getTranslation(key: string): string {
        return this.getTranslationIn(key, this.readRequestedLocale());
    }

    /**
     * Look up a translation key in an EXPLICIT locale.
     * @param key the authored translation key
     * @param locale a language code (case-insensitive); unknown codes fall
     *               back to the base language
     * @returns the translated value, else the base-language value, else `key`
     */
    public getTranslationIn(key: string, locale: string): string {
        if (typeof key !== 'string' || !key) return '';
        const language = this.resolveLanguage(locale);
        const value = this.resolveWithFallback(language, key);
        if (value) return value;
        this.warnMissingOnce(key, language);
        return key;
    }

    /**
     * The language code translations are actually being read from — i.e. the
     * `?locale=` value when it names a declared language, else the base
     * language.
     * @returns a language code such as "en-gb"
     */
    public getTranslationLocale(): string {
        return this.resolveLanguage(this.readRequestedLocale());
    }

    /**
     * Check whether a key has a non-empty value in the active locale or the
     * base language.
     * @param key the authored translation key
     * @returns true when a value exists
     */
    public hasTranslation(key: string): boolean {
        if (typeof key !== 'string' || !key) return false;
        return !!this.resolveWithFallback(this.resolveLanguage(this.readRequestedLocale()), key);
    }
}

export const translations = new TranslationMethods();
