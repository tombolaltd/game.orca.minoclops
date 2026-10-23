import { BaseCabinet, BaseChip, CasinoCabinet, container, eventEmitter } from '@game-studio/arcade-base';
import { Container, FederatedPointerEvent } from 'pixi.js';
import { buildOrcaChips } from './orca-chip';

type CabinetLayoutSetting = Parameters<CasinoCabinet['changeCabinetLayout']>[0];

/** `CasinoCabinet`'s private buttons and the cabinet package's private device / view, read by name. */
interface CasinoCabinetInternals {
    _clearButton?: Container;
    _undoButton?: Container;
    _repeatLastBetButton?: Container;
    _device?: { orientation?: { isPortrait?: boolean } };
    _cabinetView?: Container & { backgroundWidth: number; backgroundHeight: number };
}

interface CasinoParts {
    comps: Container;
    selector: CasinoCabinet['chipSelector'];
    clear: Container;
    undo: Container;
    repeat: Container;
}

/** Moves `item` so its local bounds' top-left lands at (left, top) in its parent. */
function placeAt(item: Container, left: number, top: number): void {
    const b = item.getLocalBounds();
    item.position.set(left - b.x * item.scale.x, top - b.y * item.scale.y);
}

/** Scales `item` uniformly to `size` tall. */
function scaleToHeight(item: Container, size: number): void {
    item.scale.set(1);
    const h = item.getLocalBounds().height;
    if (h > 0) item.scale.set(size / h);
}

/**
 * `addChips` sizes its mask and pill from `_chipHolder.height`, which Pixi 8 clips to the
 * holder's own mask — a 1×1 `Texture.WHITE` until then. Cover the chips first.
 */
function openChipMask(selector: CasinoCabinet['chipSelector'], chips: BaseChip[]): void {
    const mask = (selector as unknown as { _chipMask?: Container })._chipMask;
    if (!mask || chips.length === 0) return;
    let width = 0;
    let height = 0;
    for (const chip of chips) {
        width += chip.width;
        height = Math.max(height, chip.height);
    }
    mask.position.set(0, 0);
    mask.width = Math.max(1, width);
    mask.height = Math.max(1, height);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The boot Resume reply's `GameSettings.StakeOptions` (pence), or [] when absent or invalid. */
function readResumeStakeOptions(): number[] {
    // server-comms keeps the latest reply here; at cabinet init that is the boot Resume.
    const response = (window as unknown as { $response?: unknown }).$response;
    if (!isRecord(response) || response.RequestType !== 'Resume') return [];
    const settings = response.GameSettings;
    if (!isRecord(settings)) return [];
    const options = settings.StakeOptions;
    if (!Array.isArray(options)) return [];
    if (!options.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return [];
    return options as number[];
}

/**
 * A chip dragged off the selector stays hidden until something emits
 * RELEASED / PLACED. When the game does neither, return it on pointer up.
 */
function guardDraggedChips(): void {
    let pendingChip: BaseChip | null = null;
    const settle = (): void => { pendingChip = null; };
    eventEmitter.on('CASINO_CABINET_DRAG_CHIP_RELEASED', settle);
    eventEmitter.on('CASINO_CABINET_DRAG_CHIP_PLACED', settle);

    eventEmitter.on('CASINO_CABINET_DRAG_CHIP_STARTED', (_point, chip) => {
        const stage = window.$pixi?.stage;
        if (!stage) return;
        pendingChip = chip;
        const onUp = (event: FederatedPointerEvent): void => {
            stage.off('pointerup', onUp);
            stage.off('pointerupoutside', onUp);
            const point = { x: event.global.x, y: event.global.y };
            // Let the game's own pointer-up handlers place or release it first.
            setTimeout(() => {
                if (pendingChip !== chip) return;
                pendingChip = null;
                eventEmitter.emit('CASINO_CABINET_DRAG_CHIP_RELEASED', point, chip.id);
            }, 0);
        };
        stage.on('pointerup', onUp);
        stage.on('pointerupoutside', onUp);
    });
}

/**
 * The casino cabinet, safe to lay out before its casino parts exist.
 *
 * `BaseCabinet.init()` lays the cabinet out before `CasinoCabinet.init()` has
 * built its chip selector and buttons, and `CasinoCabinet`'s own layout reads
 * them, so the stock class throws and the game never finishes booting.
 */
export class OrcaCasinoCabinet extends CasinoCabinet {
    public async init(): Promise<void> {
        try {
            await super.init();
        } catch (err) {
            // The game view's `cabinet.init().then(...)` has no catch, so a throw here stops the boot.
            console.warn('[OrcaCasinoCabinet] casino parts unavailable, using the standard cabinet:', err);
        }
        if (this.casinoParts()) {
            try {
                const resumeStakes = readResumeStakeOptions();
                const chips = buildOrcaChips(resumeStakes.length > 0 ? resumeStakes : container.stake?.stakes ?? []);
                if (chips.length > 0) this.setChips(chips);
            } catch (err) {
                console.warn('[OrcaCasinoCabinet] could not add the default chips:', err);
            }
            guardDraggedChips();
        }
        this.handleOrientationChange();
    }

    public setChips(chips: BaseChip[]): void {
        if (this.chipSelector) openChipMask(this.chipSelector, chips);
        super.setChips(chips);
    }

    public handleOrientationChange(): void {
        if (!this.casinoParts()) {
            BaseCabinet.prototype.handleOrientationChange.call(this);
            return;
        }
        super.handleOrientationChange();
        this.layoutCasinoComponents();
    }

    public changeCabinetLayout(oneHandedSetting: CabinetLayoutSetting): void {
        if (!this.casinoParts()) {
            BaseCabinet.prototype.changeCabinetLayout.call(this, oneHandedSetting);
            return;
        }
        super.changeCabinetLayout(oneHandedSetting);
        this.layoutCasinoComponents();
    }

    public onResumeGame(): void {
        if (this.casinoParts()) super.onResumeGame();
    }

    public playInvalidBetAlert(): void {
        if (this.casinoParts()) super.playInvalidBetAlert();
    }

    private casinoParts(): CasinoParts | null {
        const self = this as unknown as CasinoCabinetInternals;
        const comps = this.casinoComponents;
        const selector = this.chipSelector;
        const clear = self._clearButton;
        const undo = self._undoButton;
        const repeat = self._repeatLastBetButton;
        if (!comps || !selector || !clear || !undo || !repeat) return null;
        return { comps, selector, clear, undo, repeat };
    }

    /**
     * arcade-base centres the tray on `_cabinetView.x` (the bar's LEFT edge), at
     * native size, above the floating action button; lay it out on the bar.
     * Parity twin of cabinetPreview.ts layoutCasinoComponents — keep in step.
     */
    private layoutCasinoComponents(): void {
        const parts = this.casinoParts();
        const self = this as unknown as CasinoCabinetInternals;
        const view = self._cabinetView;
        if (!parts || !view) return;
        const { comps, selector, clear, undo, repeat } = parts;

        comps.scale.set(view.scale.x, view.scale.y);
        const barWidth = view.backgroundWidth || this.CabinetDimensions.width;
        const barHeight = view.backgroundHeight || 40;
        const isPortrait = self._device?.orientation?.isPortrait === true;

        const selectorHeight = barHeight * 1.2;
        const button = selectorHeight * 0.62;
        const spacing = button * 0.25;

        for (const item of [clear, undo, repeat]) scaleToHeight(item, button);
        // Uniform scale: min(selectorHeight / height, barWidth * 0.62 / width).
        selector.resize(Math.max(1, barWidth * 0.62), selectorHeight);
        const midY = selector.height * 0.5;

        // Landscape: [clear][undo] chips [repeat]. Portrait: [undo][repeat] chips, clear above undo.
        const row = isPortrait ? [undo, repeat, selector] : [clear, undo, selector, repeat];
        const rowWidth = row.reduce((w, item) => w + item.width, 0) + spacing * (row.length - 1);
        let x = -rowWidth * 0.5;
        for (const item of row) {
            placeAt(item, x, item === selector ? 0 : midY - item.height * 0.5);
            x += item.width + spacing;
        }
        if (isPortrait) {
            const undoLeft = -rowWidth * 0.5;
            placeAt(clear, undoLeft, midY - undo.height * 0.5 - clear.height - spacing);
        }

        // A floating action button may stand above the bar.
        const top = Math.min(view.y, this.CabinetDimensions.y);
        comps.position.set(
            view.x + barWidth * view.scale.x * 0.5,
            top - (barHeight * 0.2 + selectorHeight) * comps.scale.y,
        );
    }
}
