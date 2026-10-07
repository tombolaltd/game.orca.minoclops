// Ported from Libraries/Games/CashCollector3/CashCollector3FeatureHandlers/
// (OverlayHandler.cs, CashCollectorHandler.cs, CashBoostHandler.cs, LockSpinHandler.cs,
// WinBlastHandler.cs), one class per C# handler, same call order so the RNG draws line up.
//
// Every "chance" table here is CUMULATIVE, exactly as the C#: draw random(last entry), then take
// the first index whose threshold is above the draw (see `pickCumulative`).

import { RandomHelpers } from '../../rng/RandomHelpers';
import {
    CashCollectorCashBoostDetails,
    CashCollectorCashCollectionResult,
    CashCollectorCashCollectorDetails,
    CashCollectorCashSymbolPosition,
    CashCollectorCashValueDetails,
    CashCollectorCollectorDetails,
    CashCollectorDisplayResults,
    CashCollectorGameDetails,
    CashCollectorLockSpinDetails,
    CashCollectorLockSpinResult,
    CashCollectorWinBlastDetails,
    CashCollectorWinBlastResult,
} from './CashCollectorGameMessage';
import {
    CashCollectorCashBoostSettings,
    CashCollectorCollectionSettings,
    CashCollectorFeature,
    CashCollectorLockRespinSettings,
    CashCollectorSettings,
    CashCollectorWinBlastSettings,
} from './CashCollectorSettings';

export interface CashCollectorFeatureDetails {
    NoOfCollectorSymbols: number;
    NoOfCashSymbols: number;
    Features: CashCollectorFeature[];
}

/** First index whose cumulative threshold is above a fresh random(last) draw, or -1. */
export async function pickCumulative(thresholds: readonly number[]): Promise<number> {
    if (thresholds.length === 0) return -1;
    const last = thresholds[thresholds.length - 1];
    if (!(last > 0)) return -1;
    const draw = await RandomHelpers.GetRandomValueAsync(last);
    for (let i = 0; i < thresholds.length; i++) if (draw < thresholds[i]) return i;
    return -1;
}

export function cloneReels(reels: readonly (readonly number[])[]): number[][] {
    return reels.map(column => [...column]);
}

function cloneDisplay(display: CashCollectorDisplayResults): CashCollectorDisplayResults {
    return {
        Symbols: cloneReels(display.Symbols),
        CashValues: display.CashValues.map(value => ({ Value: value.Value, Position: { ...value.Position } })),
    };
}

export class CashCollectorOverlayHandler {
    constructor(private readonly settings: CashCollectorSettings) {}

    async overlayScatter(displayReels: number[][], numberOfScatters: number): Promise<number[][]> {
        const updatedReels = cloneReels(displayReels);
        const availableReels = updatedReels.map((_, index) => index);
        const scattersToPlace = Math.min(numberOfScatters, availableReels.length);

        for (let i = 0; i < scattersToPlace; i++) {
            const selectedReelIndex = await RandomHelpers.GetRandomValueAsync(availableReels.length);
            const reelIndex = availableReels[selectedReelIndex];
            const availablePositions: number[] = [];
            for (let row = 0; row < updatedReels[reelIndex].length; row++) {
                if (updatedReels[reelIndex][row] !== this.settings.WildSymbol) availablePositions.push(row);
            }

            if (availablePositions.length > 0) {
                const selectedPosition = availablePositions[await RandomHelpers.GetRandomValueAsync(availablePositions.length)];
                updatedReels[reelIndex][selectedPosition] = this.settings.ScatterSymbol;
            }

            availableReels.splice(selectedReelIndex, 1);
        }

        return updatedReels;
    }

    async overlayCollectorFeatures(
        displayReels: number[][],
        features: CashCollectorFeatureDetails,
        collectorPositions: number[] | null = null,
    ): Promise<CashCollectorDisplayResults> {
        const updatedReels = cloneReels(displayReels);
        let displayCashSymbols: CashCollectorCashValueDetails[] = [];
        // The C# reads the BASE collector reels even for a free spin.
        const collectorReels = this.settings.CashCollectorSettings.CollectorSymbolReels;

        if (features.NoOfCollectorSymbols === 1) {
            const possibleReels = [...collectorReels];
            await RandomHelpers.GetShuffledListAsync(possibleReels);
            const reelIndex = possibleReels[0];
            await this.placeCollectorSymbol(updatedReels, reelIndex);
            collectorPositions = [reelIndex];
        } else if (features.NoOfCollectorSymbols === 2) {
            for (const reelIndex of collectorReels) await this.placeCollectorSymbol(updatedReels, reelIndex);
            collectorPositions = [0, 5];
        }

        if (features.NoOfCashSymbols > 0) {
            displayCashSymbols = await this.placeCashSymbols(updatedReels, features.NoOfCashSymbols, collectorPositions);
        }

        return { Symbols: updatedReels, CashValues: displayCashSymbols };
    }

    getSymbolPositions(displayResults: CashCollectorDisplayResults, multiplier: number, stake: number): CashCollectorCashSymbolPosition[] {
        const positions: CashCollectorCashSymbolPosition[] = [];
        const reels = displayResults.Symbols;

        for (let reel = 0; reel < reels.length; reel++) {
            for (let row = 0; row < reels[reel].length; row++) {
                const symbol = reels[reel][row];
                if (symbol !== this.settings.CashSymbol) continue;

                const details = displayResults.CashValues.find(value => value.Position.Reel === reel && value.Position.Row === row);
                const stakeMultiplier = details?.Value ?? 0;
                const cashValue = Math.trunc(stakeMultiplier * stake);
                positions.push({
                    Position: [reel, row],
                    Symbol: symbol,
                    CashValue: cashValue,
                    StakeMultiplier: stakeMultiplier,
                    Multiplier: multiplier,
                    TotalValue: cashValue * multiplier,
                });
            }
        }

        return positions;
    }

    async getCashSymbolValue(hasFeature: boolean): Promise<number> {
        const cash = this.settings.CashValueSettings;
        const index = await pickCumulative(hasFeature ? cash.StandardFeatureWeighting : cash.NoFeatureWeighting);
        return index < 0 ? 0 : cash.Values[index] ?? 0;
    }

    private async placeCollectorSymbol(reels: number[][], reelIndex: number): Promise<void> {
        const column = reels[reelIndex];
        if (column === undefined) return;

        const availablePositions: number[] = [];
        for (let row = 0; row < column.length; row++) {
            if (column[row] !== this.settings.WildSymbol && column[row] !== this.settings.ScatterSymbol) availablePositions.push(row);
        }

        if (availablePositions.length > 0) {
            const selectedPosition = availablePositions[await RandomHelpers.GetRandomValueAsync(availablePositions.length)];
            column[selectedPosition] = this.settings.CollectorSymbol;
        }
    }

    private async placeCashSymbols(
        reels: number[][],
        numberOfCashSymbols: number,
        collectorReels: number[] | null,
    ): Promise<CashCollectorCashValueDetails[]> {
        const s = this.settings;
        const displayCashSymbols: CashCollectorCashValueDetails[] = [];
        const availablePositions: Array<[reel: number, row: number]> = [];
        const hasFeature = collectorReels !== null;

        for (let reel = 0; reel < reels.length; reel++) {
            if (collectorReels !== null && collectorReels.includes(reel)) continue;
            for (let row = 0; row < reels[reel].length; row++) {
                const symbol = reels[reel][row];
                if (symbol !== s.WildSymbol && symbol !== s.ScatterSymbol && symbol !== s.CashSymbol && symbol !== s.CollectorSymbol) {
                    availablePositions.push([reel, row]);
                }
            }
        }

        const symbolsToPlace = Math.min(numberOfCashSymbols, availablePositions.length);
        for (let i = 0; i < symbolsToPlace; i++) {
            const selectedIndex = await RandomHelpers.GetRandomValueAsync(availablePositions.length);
            const [reel, row] = availablePositions[selectedIndex];

            reels[reel][row] = s.CashSymbol;
            const value = await this.getCashSymbolValue(hasFeature);
            displayCashSymbols.push({ Value: value, Position: { Reel: reel, Row: row } });

            availablePositions.splice(selectedIndex, 1);
        }

        return displayCashSymbols;
    }
}

export class CashCollectorCashBoostHandler {
    constructor(private readonly settings: CashCollectorSettings) {}

    applyCashBoosts(positions: CashCollectorCashSymbolPosition[], multipliers: readonly number[]): void {
        let totalMultiplier = 1;
        for (const multiplier of multipliers) totalMultiplier *= multiplier;

        for (const position of positions) {
            position.Multiplier *= totalMultiplier;
            position.TotalValue *= totalMultiplier;
        }
    }

    async getCashBoostDetails(numberOfCashBoosts: number, isBonus: boolean): Promise<CashCollectorCashBoostDetails> {
        const boost = this.collection(isBonus).CashBoostSettings;
        const multipliers: number[] = [];
        for (let i = 0; i < numberOfCashBoosts; i++) multipliers.push(await getCashBoost(boost));
        return { Multipliers: multipliers };
    }

    private collection(isBonus: boolean): CashCollectorCollectionSettings {
        return isBonus ? this.settings.BonusSettings.CashCollectorSettings : this.settings.CashCollectorSettings;
    }
}

async function getCashBoost(boost: CashCollectorCashBoostSettings): Promise<number> {
    const index = await pickCumulative(boost.Weighting);
    return index < 0 ? 1 : boost.Multipliers[index] ?? 1;
}

export class CashCollectorLockSpinHandler {
    private lockRespinSettings!: CashCollectorLockRespinSettings;

    constructor(
        private readonly settings: CashCollectorSettings,
        private readonly overlayHandler: CashCollectorOverlayHandler,
    ) {}

    async getLockSpinDetails(
        gameData: CashCollectorGameDetails,
        symbolPositions: CashCollectorCashSymbolPosition[],
        isBonus: boolean,
    ): Promise<CashCollectorDisplayResults[]> {
        const s = this.settings;
        this.lockRespinSettings = isBonus ? s.BonusSettings.CashCollectorSettings.LockRespinSettings : s.CashCollectorSettings.LockRespinSettings;

        const startingCashSymbols = symbolPositions.length;
        const collectorPositions = gameData.CollectorDetails
            .filter(collector => collector.Type === 'LockSpin' || collector.Type === 'WinBlast')
            .map(collector => collector.Position[0]);

        const symbolChance = collectorPositions.length === 1
            ? this.lockRespinSettings.FinalNumSymbolChanceOneCollector
            : this.lockRespinSettings.FinalNumSymbolChanceTwoCollectors;

        const totalDisplayedSymbols = s.ColumnHeight * (s.Reels.length - collectorPositions.length);
        const finalCashSymbols = await this.getFinalSymbolCount(startingCashSymbols, symbolChance);
        const startingReels = this.getStartingReels(gameData.DisplayResults.Symbols, collectorPositions);
        let remainingSymbols = finalCashSymbols - startingCashSymbols;
        const respinResults: CashCollectorDisplayResults[] = [];

        let currentDisplay: CashCollectorDisplayResults = {
            CashValues: gameData.DisplayResults.CashValues.map(value => ({ Value: value.Value, Position: { ...value.Position } })),
            Symbols: startingReels,
        };
        respinResults.push(currentDisplay);

        while (remainingSymbols > 0) {
            const maxSymbolsThisSpin = Math.min(this.lockRespinSettings.MaxSymbolsPerSpin, remainingSymbols);
            const randomRange = (maxSymbolsThisSpin + 1) - this.lockRespinSettings.MinSymbolsPerSpin;
            const symbolsThisSpin = this.lockRespinSettings.MinSymbolsPerSpin + (randomRange > 0 ? await RandomHelpers.GetRandomValueAsync(randomRange) : 0);

            const newSpin = await this.overlayHandler.overlayCollectorFeatures(
                currentDisplay.Symbols,
                { NoOfCashSymbols: symbolsThisSpin, NoOfCollectorSymbols: 0, Features: [] },
                collectorPositions,
            );

            consolidateCashValues(currentDisplay, newSpin);
            respinResults.push(newSpin);
            remainingSymbols -= symbolsThisSpin;
            currentDisplay = newSpin;
        }

        // The losing respin: shown again unchanged unless the board filled up.
        if (finalCashSymbols !== totalDisplayedSymbols) respinResults.push(cloneDisplay(currentDisplay));

        return respinResults;
    }

    getLockSpinValue(
        initialCashSymbolPositions: CashCollectorCashSymbolPosition[],
        respins: CashCollectorDisplayResults[],
        stake: number,
        multiplier: number,
    ): CashCollectorLockSpinDetails {
        const spins: CashCollectorLockSpinResult[] = [];
        let previousCashPositions = initialCashSymbolPositions;

        for (const respin of respins) {
            const newCashPositions = this.overlayHandler.getSymbolPositions(respin, multiplier, stake);
            consolidateMultipliers(previousCashPositions, newCashPositions);
            spins.push({ DisplayResults: respin, CashSymbolPositions: newCashPositions });
            previousCashPositions = newCashPositions;
        }

        const last = spins[spins.length - 1];
        return {
            CollectorCount: respins.length > 0 ? this.getCollectorCount(respins[0]) : 0,
            Spins: spins,
            TotalRespins: Math.max(0, respins.length - 1),
            RespinPrize: last === undefined ? 0 : last.CashSymbolPositions.reduce((total, position) => total + position.TotalValue, 0),
        };
    }

    private getCollectorCount(display: CashCollectorDisplayResults): number {
        let count = 0;
        for (const column of display.Symbols) if (column.includes(this.settings.CollectorSymbol)) count++;
        return count;
    }

    private async getFinalSymbolCount(startingCashSymbols: number, symbolChance: readonly number[]): Promise<number> {
        const settings = this.lockRespinSettings;
        const minSymbols = Math.max(settings.MinNumSymbols, startingCashSymbols + 1);
        const minChanceIndex = minSymbols - settings.MinNumSymbols;
        // MOCK: the C# indexes past the table here when the board is already all cash; the
        // mock settles for the starting count instead of throwing.
        if (symbolChance.length === 0 || minChanceIndex >= symbolChance.length) return startingCashSymbols;

        const randomAdjustment = minChanceIndex > 0 ? symbolChance[minChanceIndex - 1] : 0;
        const randomRange = symbolChance[symbolChance.length - 1] - randomAdjustment;
        if (randomRange <= 0) return startingCashSymbols;
        const finalSymbolChance = await RandomHelpers.GetRandomValueAsync(randomRange) + randomAdjustment;

        for (let i = minChanceIndex; i < symbolChance.length; i++) {
            if (finalSymbolChance < symbolChance[i]) return i + settings.MinNumSymbols;
        }
        return startingCashSymbols;
    }

    private getStartingReels(displayReels: number[][], collectorPositions: number[]): number[][] {
        const s = this.settings;
        return displayReels.map((column, reel) => {
            if (collectorPositions.includes(reel)) return column.map(() => s.CollectorSymbol);
            return column.map(symbol => (symbol === s.CashSymbol ? s.CashSymbol : 0));
        });
    }
}

function consolidateMultipliers(oldValues: CashCollectorCashSymbolPosition[], newValues: CashCollectorCashSymbolPosition[]): void {
    for (const position of newValues) {
        const existing = oldValues.find(old => old.Position[0] === position.Position[0] && old.Position[1] === position.Position[1]);
        if (existing !== undefined) {
            position.Multiplier = existing.Multiplier;
            position.TotalValue = position.CashValue * position.Multiplier;
        }
    }
}

function consolidateCashValues(oldVersion: CashCollectorDisplayResults, newVersion: CashCollectorDisplayResults): void {
    for (const symbol of oldVersion.CashValues) {
        const already = newVersion.CashValues.find(value => value.Position.Reel === symbol.Position.Reel && value.Position.Row === symbol.Position.Row);
        if (already === undefined) newVersion.CashValues = [...newVersion.CashValues, symbol];
    }
}

export class CashCollectorWinBlastHandler {
    private winBlastSettings!: CashCollectorWinBlastSettings;

    constructor(
        private readonly settings: CashCollectorSettings,
        private readonly overlayHandler: CashCollectorOverlayHandler,
    ) {}

    async getWinBlastDetails(
        positions: number[],
        collectorDetails: CashCollectorCollectorDetails[],
        isBonus: boolean,
    ): Promise<CashCollectorDisplayResults[]> {
        const s = this.settings;
        this.winBlastSettings = isBonus ? s.BonusSettings.CashCollectorSettings.WinBlastSettings : s.CashCollectorSettings.WinBlastSettings;

        const { cascades, cascadeCashSymbols } = await this.drawCascades();
        const blastResults: CashCollectorDisplayResults[] = [];
        const collectorPositions = collectorDetails.filter(collector => collector.Type === 'WinBlast').map(collector => collector.Position[0]);

        for (let i = 0; i < cascades; i++) {
            const cascadePositions = this.jumpPositions(positions, isBonus);
            blastResults.push(await this.getWinBlastReels(cascadePositions, collectorPositions, cascadeCashSymbols[i], isBonus));
            positions = cascadePositions;
        }

        return blastResults;
    }

    playWinBlast(winBlastDisplays: CashCollectorDisplayResults[], stake: number, multiplier: number): CashCollectorWinBlastDetails {
        const results: CashCollectorWinBlastResult[] = winBlastDisplays.map(display => {
            const cashSymbolPositions = this.overlayHandler.getSymbolPositions(display, multiplier, stake);
            return {
                DisplayResults: display,
                CashSymbolPositions: cashSymbolPositions,
                Prize: cashSymbolPositions.reduce((total, position) => total + position.TotalValue, 0),
            };
        });

        return { Results: results, TotalPrize: results.reduce((total, result) => total + result.Prize, 0) };
    }

    private jumpPositions(initialPositions: number[], isBonus: boolean): number[] {
        const reels = isBonus ? this.settings.BonusSettings.Reels : this.settings.Reels;
        return initialPositions.map((position, index) => {
            const reelLength = Math.max(1, (reels[index]?.length ?? 1) - this.settings.BufferSize);
            return (position + this.winBlastSettings.PositionJump) % reelLength;
        });
    }

    private async drawCascades(): Promise<{ cascades: number; cascadeCashSymbols: number[] }> {
        const settings = this.winBlastSettings;
        let cascades = settings.MinCascades;
        const extra = await pickCumulative(settings.CascadeChance);
        if (extra > 0) cascades += extra;

        const cascadeCashSymbols: number[] = [];
        for (let i = 0; i < cascades; i++) {
            const count = await pickCumulative(settings.WinBlastNumCashWeighting);
            cascadeCashSymbols.push(Math.max(0, count));
        }

        return { cascades, cascadeCashSymbols };
    }

    private async getWinBlastReels(reelPositions: number[], collectorReels: number[], noOfSymbols: number, isBonus: boolean): Promise<CashCollectorDisplayResults> {
        const s = this.settings;
        const reels = isBonus ? s.BonusSettings.Reels : s.Reels;
        const displayReels: number[][] = reelPositions.map((position, reel) => {
            if (collectorReels.includes(reel)) return new Array<number>(s.ColumnHeight).fill(s.CollectorSymbol);
            const strip = reels[reel] ?? [];
            const column: number[] = [];
            for (let row = 0; row < s.ColumnHeight; row++) column.push(strip.length === 0 ? 0 : strip[(position + row) % strip.length]);
            return column;
        });

        return this.overlayHandler.overlayCollectorFeatures(
            displayReels,
            { NoOfCashSymbols: noOfSymbols, NoOfCollectorSymbols: 0, Features: ['None'] },
            collectorReels,
        );
    }
}

export class CashCollectorHandler {
    private readonly cashBoostHandler: CashCollectorCashBoostHandler;
    private readonly lockSpinHandler: CashCollectorLockSpinHandler;
    private readonly winBlastHandler: CashCollectorWinBlastHandler;

    constructor(
        private readonly settings: CashCollectorSettings,
        private readonly overlayHandler: CashCollectorOverlayHandler,
    ) {
        this.cashBoostHandler = new CashCollectorCashBoostHandler(settings);
        this.lockSpinHandler = new CashCollectorLockSpinHandler(settings, overlayHandler);
        this.winBlastHandler = new CashCollectorWinBlastHandler(settings, overlayHandler);
    }

    getCashSymbolCount(displayReels: number[][]): number {
        let count = 0;
        for (const column of displayReels) for (const symbol of column) if (symbol === this.settings.CashSymbol) count++;
        return count;
    }

    async populateCashCollectionFeatureData(positions: number[], data: CashCollectorGameDetails, stake: number, isBonus = false, multiplier = 1): Promise<void> {
        const cashSymbolPositions = this.overlayHandler.getSymbolPositions(data.DisplayResults, multiplier, stake);
        if (cashSymbolPositions.length === 0 || data.CollectorDetails.length === 0) return;

        const features = data.CollectorDetails.map(collector => collector.Type);
        const cashBoosts = features.filter(feature => feature === 'CashBoost').length;

        if (features.includes('CashBoost') && data.CashBoostDetails == null)
            data.CashBoostDetails = await this.cashBoostHandler.getCashBoostDetails(cashBoosts, isBonus);

        if (features.includes('LockSpin') && data.LockSpinDetails == null)
            data.LockSpinDetails = await this.lockSpinHandler.getLockSpinDetails(data, cashSymbolPositions, isBonus);

        if (features.includes('WinBlast') && data.WinBlastDetails == null)
            data.WinBlastDetails = await this.winBlastHandler.getWinBlastDetails(positions, data.CollectorDetails, isBonus);
    }

    getCashCollectionResult(positions: number[], data: CashCollectorGameDetails, stake: number, isBonus = false, multiplier = 1): CashCollectorCashCollectionResult {
        void positions;
        void isBonus;
        const collectorDetails: CashCollectorCashCollectorDetails[] = data.CollectorDetails.map(collector => ({
            Position: [...collector.Position],
            Type: collector.Type,
            CashCollected: 0,
        }));

        const result: CashCollectorCashCollectionResult = {
            CollectorPositions: collectorDetails,
            FeatureTriggered: false,
            CashSymbolPositions: [],
            CashPrize: 0,
            CashMultiplier: multiplier,
            InitialSpinPrize: 0,
            LockSpinDetails: null,
            WinBlastDetails: null,
            CashBoostDetails: null,
            FeatureTypes: distinct(collectorDetails.map(collector => collector.Type)),
        };

        const cashSymbolPositions = this.overlayHandler.getSymbolPositions(data.DisplayResults, multiplier, stake);
        result.CashSymbolPositions = cashSymbolPositions;

        if (cashSymbolPositions.length > 0 && collectorDetails.length > 0) {
            result.FeatureTriggered = true;
            const features = collectorDetails.map(collector => collector.Type);
            const hasLockSpin = features.includes('LockSpin');

            if (features.includes('CashBoost')) {
                const boost = data.CashBoostDetails;
                if (boost == null) throw new Error('Cash boost details must be generated before cash collection is resolved.');
                result.CashBoostDetails = { Multipliers: [...boost.Multipliers] };
                this.cashBoostHandler.applyCashBoosts(cashSymbolPositions, boost.Multipliers);
            }

            const totalCashValue = cashSymbolPositions.reduce((total, position) => total + position.TotalValue, 0);
            result.CashSymbolPositions = cashSymbolPositions;

            updateCollectorCash(collectorDetails, totalCashValue, collector =>
                collector.Type !== 'LockSpin' && !(collector.Type === 'WinBlast' && hasLockSpin));

            result.InitialSpinPrize += collectorDetails.reduce((total, collector) => total + collector.CashCollected, 0);

            if (hasLockSpin) {
                const respins = data.LockSpinDetails;
                if (respins == null) throw new Error('Lock spin details must be generated before cash collection is resolved.');
                result.LockSpinDetails = this.lockSpinHandler.getLockSpinValue(cashSymbolPositions, respins, stake, multiplier);
                updateCollectorCash(collectorDetails, result.LockSpinDetails.RespinPrize, collector =>
                    collector.Type === 'LockSpin' || (collector.Type === 'WinBlast' && hasLockSpin));
            }

            if (features.includes('WinBlast')) {
                const blasts = data.WinBlastDetails;
                if (blasts == null) throw new Error('Win blast details must be generated before cash collection is resolved.');
                result.WinBlastDetails = this.winBlastHandler.playWinBlast(blasts, stake, multiplier);
                updateCollectorCash(collectorDetails, result.WinBlastDetails.TotalPrize, collector => collector.Type === 'WinBlast');
            }

            result.CashPrize = collectorDetails.reduce((total, collector) => total + collector.CashCollected, 0);
        }

        return result;
    }

    async getCashCollectorFeature(isBonus = false): Promise<CashCollectorFeatureDetails> {
        const s = this.settings;
        const collection = isBonus ? s.BonusSettings.CashCollectorSettings : s.CashCollectorSettings;

        const featureChance = await RandomHelpers.GetRandomValueAsync(100);
        let features: CashCollectorFeature[] = ['None'];
        const hasFeature = featureChance < collection.FeatureTriggerProbability;

        if (hasFeature) {
            const index = await pickCumulative(collection.FeatureChances);
            const combination = index < 0 ? undefined : s.CashCollectorFeatures[index];
            if (combination !== undefined) {
                features = [...combination];
                await RandomHelpers.GetShuffledListAsync(features);
            }
        }

        const symbolChance = hasFeature
            ? collection.NoOfCashSymbolsChance.StandardFeatureWeighting
            : collection.NoOfCashSymbolsChance.NoFeatureWeighting;
        const numberOfSymbols = Math.max(0, await pickCumulative(symbolChance));

        return {
            NoOfCashSymbols: numberOfSymbols,
            NoOfCollectorSymbols: hasFeature ? features.length : 0,
            Features: features,
        };
    }

    getCollectorPositions(displayResults: CashCollectorDisplayResults, features: CashCollectorFeatureDetails): CashCollectorCollectorDetails[] {
        const s = this.settings;
        const collectorDetails: CashCollectorCollectorDetails[] = [];
        const firstReel = displayResults.Symbols[0] ?? [];
        const lastReel = displayResults.Symbols[5] ?? [];

        const firstRow = firstReel.indexOf(s.CollectorSymbol);
        if (firstRow !== -1) collectorDetails.push({ Position: [0, firstRow], Type: features.Features[0] });

        const lastRow = lastReel.indexOf(s.CollectorSymbol);
        if (lastRow !== -1) {
            collectorDetails.push({
                Position: [5, lastRow],
                Type: features.NoOfCollectorSymbols === 2 ? features.Features[1] : features.Features[0],
            });
        }

        return collectorDetails;
    }
}

function updateCollectorCash(
    collectors: CashCollectorCashCollectorDetails[],
    amount: number,
    condition: (collector: CashCollectorCashCollectorDetails) => boolean,
): void {
    for (const collector of collectors) if (condition(collector)) collector.CashCollected += amount;
}

function distinct<T>(values: T[]): T[] {
    return values.filter((value, index) => values.indexOf(value) === index);
}
