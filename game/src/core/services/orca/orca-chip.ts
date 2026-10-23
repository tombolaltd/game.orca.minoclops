import { BaseChip, container } from '@game-studio/arcade-base';
import { Container, Graphics, Text } from 'pixi.js';

/** The selector reads the indexes of its first and last five chips. */
const MIN_CHIPS = 5;
const RADIUS = 50;
const PLACEHOLDER_COLOUR = 0x8a8a8a;
const CHIP_COLOURS: number[] = [0xc8161d, 0xe39a1f, 0xe8739f, 0x16903a, 0x1b5aa6];

function shade(colour: number, factor: number): number {
    const r = Math.round(((colour >> 16) & 0xff) * factor);
    const g = Math.round(((colour >> 8) & 0xff) * factor);
    const b = Math.round((colour & 0xff) * factor);
    return (Math.min(255, r) << 16) | (Math.min(255, g) << 8) | Math.min(255, b);
}

// Parity twin of drawChip in the editor's src/services/pixi/cabinetPreview.ts — keep the look in step.
function drawChip(g: Graphics, cx: number, cy: number, r: number, colour: number): void {
    g.circle(cx, cy, r).fill({ color: colour });
    for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const nx = Math.cos(a);
        const ny = Math.sin(a);
        const px = cx + nx * r * 0.84;
        const py = cy + ny * r * 0.84;
        const l = r * 0.14;
        const w = r * 0.11;
        g.poly([
            px - ny * l - nx * w, py + nx * l - ny * w,
            px + ny * l - nx * w, py - nx * l - ny * w,
            px + ny * l + nx * w, py - nx * l + ny * w,
            px - ny * l + nx * w, py + nx * l + ny * w,
        ]).fill({ color: 0xffffff });
    }
    g.circle(cx, cy, r * 0.66).stroke({ width: r * 0.06, color: shade(colour, 0.72) });
}

function formatChipValue(value: number): string {
    const formatter = container.currencyFormatter;
    if (!formatter) return String(value);
    return value % 100 === 0 ? formatter.rounded(value) : formatter.precise(value);
}

/**
 * A default casino-cabinet chip: a coloured disc labelled with its stake.
 * Without a value it is a greyed, unselectable placeholder (the selector needs five chips).
 */
export class OrcaChip extends BaseChip {
    private readonly _label: Text | null = null;

    constructor(id: number, value?: number) {
        super(id);
        const placeholder = typeof value !== 'number' || !Number.isFinite(value);
        this._value = placeholder ? 0 : value;
        this._selectable = !placeholder;

        const art = new Container();
        const g = new Graphics();
        drawChip(g, RADIUS, 0, RADIUS, placeholder ? PLACEHOLDER_COLOUR : CHIP_COLOURS[id % CHIP_COLOURS.length]);
        art.addChild(g);
        this.addChild(art);

        if (placeholder) {
            this.alpha = 0.5;
            return;
        }

        const colour = CHIP_COLOURS[id % CHIP_COLOURS.length];
        const label = new Text({
            text: formatChipValue(this._value),
            style: {
                fontFamily: 'Lato-Bold',
                fontSize: RADIUS * 0.52,
                fill: 0xffffff,
                stroke: { color: shade(colour, 0.5), width: RADIUS * 0.08 },
            },
        });
        label.anchor.set(0.5);
        label.position.set(RADIUS, 0);
        const maxWidth = RADIUS * 1.2;
        if (label.width > maxWidth) label.scale.set(maxWidth / label.width);
        this.addChild(label);
        this._label = label;
    }

    public showValue(): void {
        if (this._label) this._label.visible = true;
    }

    public hideValue(): void {
        if (this._label) this._label.visible = false;
    }

    public enterCabinetMode(): void {
        this.showValue();
    }
}

/**
 * One chip per unique positive stake (sorted, id = index), padded with
 * placeholders at the end to five. Empty when there are no stakes.
 */
export function buildOrcaChips(stakes: number[]): OrcaChip[] {
    const values = Array.from(new Set((Array.isArray(stakes) ? stakes : [])
        .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)))
        .sort((a, b) => a - b);
    if (values.length === 0) return [];
    const chips = values.map((v, i) => new OrcaChip(i, v));
    while (chips.length < MIN_CHIPS) chips.push(new OrcaChip(chips.length));
    return chips;
}
