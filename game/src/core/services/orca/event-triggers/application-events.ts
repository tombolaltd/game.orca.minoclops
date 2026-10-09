import { Flowstate } from "../flowstate";

export class FlowstateApplicationEventTriggers {
    private lastMode: string | null = null;

    public async onApplicationPreInit(): Promise<void> {
        await Flowstate.runFlowsByStarterType('onApplicationPreInit');
    }

    public async onInitPixi(): Promise<void> {
        await Flowstate.runFlowsByStarterType('onInitPixi');
    }

    public async onApplicationInit(): Promise<void> {
        await Flowstate.runFlowsByStarterType('onApplicationInit');
    }

    public async onEnterBonusRound(): Promise<void> {
        await Flowstate.runFlowsByStarterType('onEnterBonusRound');
    }

    public async onExitBonusRound(): Promise<void> {
        await Flowstate.runFlowsByStarterType('onExitBonusRound');
    }

    public async onEnterJackpot(): Promise<void> {
        await Flowstate.runFlowsByStarterType('onEnterJackpot');
    }

    public async onApplicationResize(width: number, height: number): Promise<void> {
        await Flowstate.runFlowsByStarterType('onApplicationResize', { width, height });
    }

    /**
     * Fires only when the 3-way device mode actually CHANGES. The host calls
     * this on every resize; the dedupe lives here, not in the host.
     */
    public async onDeviceModeChanged(mode: string): Promise<void> {
        if (mode === this.lastMode) return;
        this.lastMode = mode;
        await Flowstate.runFlowsByStarterType('onDeviceModeChanged', { mode });
    }

    public async onStakeChanged(stake: number): Promise<void> {
        if (!Number.isFinite(stake)) return;
        await Flowstate.runFlowsByStarterType('onStakeChanged', { stake });
    }

    public async onBeginGame(): Promise<void> {
        await Flowstate.runFlowsByStarterType('onBeginGame');
    }
}
