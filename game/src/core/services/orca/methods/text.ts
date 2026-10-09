import * as PIXI from "pixi.js";
import gsap from "gsap";
import { container } from "@game-studio/arcade-base";
import type { NodeRefLike } from "./node-ref";
import { resolveNode } from "./node-ref";
import { resolveEase, runTween } from "./transform";
import {
    hasTranslationMarkup,
    translationMarkupToHtmlText,
    translationMarkupToPlainText,
} from "../translation-markup";

/** The count-up currently driving each Text, so a new one replaces it instead of fighting it. */
const countUps = new WeakMap<object, gsap.core.Tween>();

/**
 * Render a counted number. Money is in MINOR units (pence / cents) and goes
 * through the game's own currency formatter, so it matches every other amount
 * the cabinet shows.
 */
function formatCount(value: number, format: string): string {
    const rounded = Math.round(value);
    try {
        switch (format) {
            case "currency": return container.currencyFormatter.precise(rounded);
            case "currencyRounded": return container.currencyFormatter.rounded(rounded);
            case "multiplier": return `x${rounded}`;
            case "decimal": return value.toFixed(2);
            default: return String(rounded);
        }
    } catch {
        return String(rounded);
    }
}

/**
 * Text node controls. Targets a scene-graph node of type 'text', which builds
 * as a `PIXI.Text` or — rich runs / `allowMarkup` — a `PIXI.HTMLText`. Pixi 8's
 * `HTMLText` is NOT a `Text` subclass; both extend `AbstractText`.
 */
const warnedMarkupOnPlainText = new WeakSet<object>();

class TextMethods {
    private get(target: NodeRefLike): PIXI.AbstractText | null {
        return resolveNode<PIXI.AbstractText>(target, PIXI.AbstractText);
    }

    public setText(target: NodeRefLike, value: string): void {
        const t = this.get(target);
        if (!t) return;
        if (t instanceof PIXI.HTMLText) {
            t.text = translationMarkupToHtmlText(value);
            return;
        }
        if (hasTranslationMarkup(value)) {
            if (!warnedMarkupOnPlainText.has(t)) {
                warnedMarkupOnPlainText.add(t);
                console.warn(
                    `[FlowState] setText: text node "${t.label || '?'}" received formatted (rich-text) markup but renders plain text; `
                    + `the formatting was stripped. Enable "Allow Markup" on that text node to render it.`,
                );
            }
            t.text = translationMarkupToPlainText(value);
            return;
        }
        t.text = value ?? '';
    }
    public setTextFill(target: NodeRefLike, color: string): void {
        const t = this.get(target); if (t) (t.style as any).fill = color;
    }
    public setTextFontSize(target: NodeRefLike, fontSize: number): void {
        const t = this.get(target); if (t) (t.style as any).fontSize = fontSize | 0;
    }
    public setTextAlpha(target: NodeRefLike, alpha: number): void {
        const t = this.get(target); if (t) t.alpha = alpha;
    }

    /**
     * Count a Text node up (or down) from one number to another over time -
     * the rolling win meter every slot shows. Each frame writes the formatted
     * value; the last frame always lands exactly on `to`.
     *
     * @param format - `currency` / `currencyRounded` (minor units through the
     *   game's currency formatter), `integer`, `multiplier` (`x5`) or `decimal`
     */
    public countUpText(
        target: NodeRefLike,
        from: number,
        to: number,
        durationMS: number,
        format: string,
        ease: string,
        sequenceNodeOn: string,
    ): Promise<void> {
        const t = this.get(target);
        if (!t || (t as { destroyed?: boolean }).destroyed) return Promise.resolve();
        const start = Number.isFinite(Number(from)) ? Number(from) : 0;
        const end = Number.isFinite(Number(to)) ? Number(to) : 0;

        countUps.get(t)?.kill();
        countUps.delete(t);
        if (!(durationMS > 0)) {
            t.text = formatCount(end, format);
            return Promise.resolve();
        }

        return runTween(sequenceNodeOn, onComplete => {
            const proxy = { v: start };
            t.text = formatCount(start, format);
            const tween = gsap.to(proxy, {
                v: end,
                duration: durationMS / 1000,
                ease: resolveEase(ease, 1),
                onUpdate: () => {
                    if (!(t as { destroyed?: boolean }).destroyed) t.text = formatCount(proxy.v, format);
                },
                onComplete: () => {
                    if (!(t as { destroyed?: boolean }).destroyed) t.text = formatCount(end, format);
                    countUps.delete(t);
                    onComplete();
                },
            });
            countUps.set(t, tween);
        });
    }
    public setTextOutline(target: NodeRefLike, color: string, width: number): void {
        const t = this.get(target); if (!t) return;
        const w = Number(width);
        if (!Number.isFinite(w) || w <= 0) { (t.style as any).stroke = null; return; }
        (t.style as any).stroke = { color: this.outlineColor(color), width: w };
    }
    public clearTextOutline(target: NodeRefLike): void {
        const t = this.get(target); if (t) (t.style as any).stroke = null;
    }
    // Pixi's Color parser throws on unknown strings, so validate before it reaches the style.
    private outlineColor(color: string): string {
        const c = typeof color === 'string' ? color.trim() : '';
        if (!c) return '#000000';
        try { new PIXI.Color(c); return c; } catch { return '#000000'; }
    }
}

export const text = new TextMethods();
