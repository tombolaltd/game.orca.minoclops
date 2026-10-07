// Ported from Libraries/Tombola.B2B.Arcade/GameFlowHandlers/DefaultGameFlowHandler.cs
// (+ Interfaces/IOperatorSettingsProvider.cs and Interfaces/IResumeGameTerritoryPolicy.cs,
//    whose default implementations the C# resolves through DI).

import {
    GameFlowHandlerBase,
    GameFlowHandlerDependencies,
    IOperatorSettingsProvider,
    IResumeGameTerritoryPolicy,
    OperatorFlowSettings,
} from './GameFlowHandlerBase';

/** The territory-agnostic handler. The C# UK/Italy subclasses only swap the injected blocks. */
export class DefaultGameFlowHandler extends GameFlowHandlerBase {
    constructor(dependencies: GameFlowHandlerDependencies) {
        super(dependencies);
    }
}

export const DEFAULT_OPERATOR_FLOW_SETTINGS: OperatorFlowSettings = {
    StakeOptions: [25, 50, 100, 200, 500],
    CurrencyCode: 'GBP',
    MaxFreeplaysPerStake: 1,
};

// MOCK: the C# reads per-operator settings from config; every operator gets the same block here.
export class StaticOperatorSettingsProvider implements IOperatorSettingsProvider {
    constructor(private readonly settings: OperatorFlowSettings = DEFAULT_OPERATOR_FLOW_SETTINGS) {}

    getSettings(operatorId: string): OperatorFlowSettings {
        void operatorId;
        return this.settings;
    }
}

/** The default resume policy; the territory-specific ones have no mock equivalent. */
export class NoOpResumeGameTerritoryPolicy implements IResumeGameTerritoryPolicy {
    async beforePopulateResponseAsync(): Promise<void> {
        /* no-op */
    }
}
