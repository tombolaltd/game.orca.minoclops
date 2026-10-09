import { BaseCabinet, ICabinetDimensions } from '@game-studio/arcade-base';

/**
 * A cabinet with no views, for games that draw their own controls.
 *
 * `BaseCabinet` still builds and drives its views (the purchase / stake state
 * machine, free play, auto-buy and every FlowState cabinet method need them),
 * but they are kept off the display list, so nothing renders and nothing takes
 * pointer input. It also reports zero size, so layouts that subtract the
 * cabinet (the jackpots panel) use the full game area.
 */
export class EmptyCabinet extends BaseCabinet {
    public async init(): Promise<void> {
        await super.init();
        this.removeViews();
    }

    public get CabinetDimensions(): ICabinetDimensions {
        return { x: 0, y: 0, width: 0, height: 0 };
    }

    private removeViews(): void {
        this.removeChildren();
        this.interactiveChildren = false;
    }
}
