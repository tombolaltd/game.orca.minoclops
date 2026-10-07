// MOCK: no single C# counterpart. This block collapses the jackpot-api pot store plus
// Jackpot/Flow/{DefaultJackpotFlowHandler,DefaultJackpotWinSelector,ForcedJackpotWinSelector,
// JackpotWinDecision}.cs and Jackpot/TicketGeneration/ChampionsJackpotTicketGenerator.cs into
// one deterministic in-process object, so a jackpot prototype gets a real `Jackpot` payload.
//
// MOCK: the jackpot-api stage / confirm / cancel lifecycle is dropped — the pots are local
// state, so a buy-in is a direct mutation plus a rollback rather than three HTTP round trips.
// MOCK: `expectedConfigVersion` staleness (ArcadeResultCode.JackpotConfigurationChanged, 218)
// is dropped with it; the local config version cannot change mid-run, so nothing goes stale.
// MOCK: the V3 PlaceBet `JackpotContribution` item is dropped — MockPlaceBetHandler sends one
// bet amount and never itemises a contribution.
//
// Every value the real engine treats as an unscaled percentage (`Rtp`, `ContributionPercent`)
// stays unscaled here; every money value is integer minor units, as everywhere else.

import { IRandomNumberGenerator } from '../core/interfaces';
import { DebugJackpotData } from '../core/models/BaseArcadeRequest';
import { JackpotPotValue, JackpotTicket, JackpotWinDetails } from '../core/models/BaseArcadeResponse';
import { PotTier } from '../core/models/enums';

/** One pot tier. Mirrors JackpotPotDto plus the probability fields of JackpotStagePotValueDto. */
export interface MockJackpotPotConfig {
    Tier: string;
    TierId: number;
    Ordering: number;
    /** Integer minor units. The pot returns to this value after it is won. */
    BaseSeedValue: number;
    /** Percentage of each stake added to this pot, unscaled: 1.5 means 1.5%. */
    ContributionPercent: number;
    /** Percentage, unscaled, emitted verbatim as JackpotPotValue.Rtp. */
    Rtp: number;
    /** Odds of this pot winning per staked bet, as numerator/denominator. */
    ProbabilityNumerator: number;
    ProbabilityDenominator: number;
    MustGoValue?: number;
}

/** Ported from Config/JackpotConfig.cs JackpotChampionsTicketConfig, including its defaults. */
export interface MockJackpotTicketConfig {
    GridWidth: number;
    GridHeight: number;
    JackpotRounds: number;
    /** TierId → [minimum, maximum] gems to collect. */
    CollectorSizeBoundary: Record<number, number[]>;
}

export interface MockJackpotConfig {
    /** Off by default: every existing mechanic response is unchanged until this is true. */
    enabled?: boolean;
    networkName?: string;
    configVersion?: number;
    pots?: MockJackpotPotConfig[];
    ticket?: Partial<MockJackpotTicketConfig>;
    /** Mirrors DebugJackpotData; a request carrying its own DebugJackpotData wins over this. */
    debug?: DebugJackpotData;
}

/** One bet's contribution, kept so a failed begin can roll it back. */
export interface MockJackpotBuyIn {
    ConfigVersion: number;
    Contributions: Array<{ TierId: number; Amount: number; PreviousRemainder: number }>;
}

/** The result of the win check, mirroring JackpotWinSelection plus the confirm response. */
export interface MockJackpotOutcome {
    JackpotWin: boolean;
    JackpotPrize?: number;
    WinningPot?: JackpotPotValue;
    WinningTicket?: JackpotTicket;
    WinningDetails?: JackpotWinDetails;
    /** For GameTicketDetails.JackpotWin; None unless a tier matched a PotTier member. */
    Tier: PotTier;
    GemLayouts: number[][][];
    /** Set when a forced win was requested badly, mirroring JackpotWinSelection.ValidationError. */
    ValidationError?: string;
}

export type MockJackpotSnapshot = Array<{ TierId: number; CurrentValue: number }>;

export const DEFAULT_JACKPOT_NETWORK_NAME = 'MockJackpotNetwork';

export const DEFAULT_JACKPOT_TICKET_CONFIG: MockJackpotTicketConfig = {
    GridWidth: 5,
    GridHeight: 3,
    JackpotRounds: 3,
    CollectorSizeBoundary: { 1: [5, 10], 2: [10, 15], 3: [15, 16] },
};

/** Three tiers named after the PotTier enum, seeded so a prototype has visibly distinct pots. */
export function createDefaultJackpotPots(): MockJackpotPotConfig[] {
    return [
        {
            Tier: 'Low',
            TierId: PotTier.Low,
            Ordering: 1,
            BaseSeedValue: 5000,
            ContributionPercent: 1,
            Rtp: 1,
            ProbabilityNumerator: 1,
            ProbabilityDenominator: 2500,
        },
        {
            Tier: 'Mid',
            TierId: PotTier.Mid,
            Ordering: 2,
            BaseSeedValue: 50000,
            ContributionPercent: 0.75,
            Rtp: 0.75,
            ProbabilityNumerator: 1,
            ProbabilityDenominator: 25000,
        },
        {
            Tier: 'High',
            TierId: PotTier.High,
            Ordering: 3,
            BaseSeedValue: 500000,
            ContributionPercent: 0.5,
            Rtp: 0.5,
            ProbabilityNumerator: 1,
            ProbabilityDenominator: 250000,
        },
    ];
}

interface PotState {
    config: MockJackpotPotConfig;
    currentValue: number;
    /** Sub-minor-unit contribution carried forward, so small stakes still accumulate. */
    remainder: number;
}

export class MockJackpotService {
    readonly enabled: boolean;
    readonly networkName: string;
    readonly configVersion: number;

    private readonly rng: IRandomNumberGenerator;
    private readonly ticketConfig: MockJackpotTicketConfig;
    private readonly debug?: DebugJackpotData;
    private readonly pots: PotState[];

    constructor(rng: IRandomNumberGenerator, config: MockJackpotConfig = {}) {
        this.rng = rng;
        this.enabled = config.enabled === true;
        this.networkName = nonEmpty(config.networkName) ?? DEFAULT_JACKPOT_NETWORK_NAME;
        this.configVersion = positiveInteger(config.configVersion) ?? 1;
        this.ticketConfig = { ...DEFAULT_JACKPOT_TICKET_CONFIG, ...(config.ticket ?? {}) };
        this.debug = config.debug;

        const pots = normalisePots(config.pots ?? createDefaultJackpotPots());
        this.pots = pots.map(pot => ({ config: pot, currentValue: pot.BaseSeedValue, remainder: 0 }));
    }

    /** The sum of every pot's contribution, the mock's stand-in for `totalContributionPercent`. */
    get totalContributionPercent(): number {
        return this.pots.reduce((total, pot) => total + pot.config.ContributionPercent, 0);
    }

    /** The resume / potvalues read path. Ported from JackpotPotDto → JackpotPotValue. */
    currentPotValues(): JackpotPotValue[] {
        return this.pots
            .slice()
            .sort((a, b) => a.config.Ordering - b.config.Ordering)
            .map(pot => {
                const value: JackpotPotValue = {
                    Tier: pot.config.Tier,
                    TierId: pot.config.TierId,
                    Ordering: pot.config.Ordering,
                    CurrentValue: pot.currentValue,
                    Rtp: pot.config.Rtp,
                    BaseSeedValue: pot.config.BaseSeedValue,
                    ContributionPercent: pot.config.ContributionPercent,
                };
                if (pot.config.MustGoValue !== undefined) value.MustGoValue = pot.config.MustGoValue;
                return value;
            });
    }

    /** Accumulates this bet's contribution into every pot. */
    buyIn(stake: number): MockJackpotBuyIn {
        const contributions: MockJackpotBuyIn['Contributions'] = [];
        const stakeValue = Number.isFinite(stake) && stake > 0 ? stake : 0;

        for (const pot of this.pots) {
            const previousRemainder = pot.remainder;
            const exact = (stakeValue * pot.config.ContributionPercent) / 100 + previousRemainder;
            const amount = Math.floor(exact);

            pot.remainder = exact - amount;
            pot.currentValue += amount;
            contributions.push({ TierId: pot.config.TierId, Amount: amount, PreviousRemainder: previousRemainder });
        }

        return { ConfigVersion: this.configVersion, Contributions: contributions };
    }

    /** The CancelStagedJackpotBuyIn compensation: undo an unconfirmed buy-in's contributions. */
    rollback(buyIn: MockJackpotBuyIn): void {
        for (const contribution of buyIn.Contributions) {
            const pot = this.pots.find(candidate => candidate.config.TierId === contribution.TierId);
            if (pot === undefined) continue;

            pot.currentValue = Math.max(pot.config.BaseSeedValue, pot.currentValue - contribution.Amount);
            pot.remainder = contribution.PreviousRemainder;
        }
    }

    /** CheckJackpotWin: pick a winning pot (forced or rolled), then generate its ticket. */
    async evaluate(debug?: DebugJackpotData): Promise<MockJackpotOutcome> {
        const noWin: MockJackpotOutcome = { JackpotWin: false, Tier: PotTier.None, GemLayouts: [] };
        const request = debug ?? this.debug;

        let winner: PotState | undefined;
        if (request?.ForceWin === true) {
            const tierId = request.WinningPotTierId;
            if (tierId === undefined || !Number.isInteger(tierId) || tierId <= 0) {
                return { ...noWin, ValidationError: 'A positive WinningPotTierId is required when forcing a jackpot win.' };
            }
            winner = this.pots.find(pot => pot.config.TierId === tierId);
            if (winner === undefined) {
                return { ...noWin, ValidationError: `WinningPotTierId ${tierId} was not returned by the staged jackpot buy-in.` };
            }
        } else {
            winner = await this.rollForWin();
        }

        if (winner === undefined) return noWin;

        const gemLayouts = await this.generateTicket(winner.config.TierId);
        // MOCK: the C# leaves WinningPot.Rtp at its default; the real value is more useful here.
        const winningPot: JackpotPotValue = {
            Tier: winner.config.Tier,
            TierId: winner.config.TierId,
            Ordering: winner.config.Ordering,
            CurrentValue: winner.currentValue,
            Rtp: winner.config.Rtp,
        };

        return {
            JackpotWin: true,
            JackpotPrize: winner.currentValue,
            WinningPot: winningPot,
            WinningTicket: new JackpotTicket(gemLayouts),
            // MOCK: jackpot-api decides ImmediatePayout; MockAwardPrizeHandler always pays at once.
            WinningDetails: { ImmediateWin: true, PaidOut: true },
            Tier: toPotTier(winner.config.TierId),
            GemLayouts: gemLayouts,
        };
    }

    /** ConfirmBuyIn: a won pot drains back to its seed. */
    confirm(outcome: MockJackpotOutcome): void {
        if (!outcome.JackpotWin || outcome.WinningPot === undefined) return;

        const pot = this.pots.find(candidate => candidate.config.TierId === outcome.WinningPot?.TierId);
        if (pot !== undefined) pot.currentValue = pot.config.BaseSeedValue;
    }

    snapshot(): MockJackpotSnapshot {
        return this.pots.map(pot => ({ TierId: pot.config.TierId, CurrentValue: pot.currentValue }));
    }

    restore(snapshot: MockJackpotSnapshot): void {
        for (const entry of snapshot) {
            const pot = this.pots.find(candidate => candidate.config.TierId === entry.TierId);
            if (pot !== undefined && Number.isFinite(entry.CurrentValue)) pot.currentValue = entry.CurrentValue;
        }
    }

    /** DefaultJackpotWinSelector: highest Ordering first, first winning roll takes it. */
    private async rollForWin(): Promise<PotState | undefined> {
        const ordered = this.pots.slice().sort((a, b) => b.config.Ordering - a.config.Ordering);
        for (const pot of ordered) {
            if (await this.isWinningRoll(pot.config)) return pot;
        }
        return undefined;
    }

    /** Ported from JackpotWinDecision.IsWinningRoll; the Int64 sampling branch has no mock use. */
    private async isWinningRoll(pot: MockJackpotPotConfig): Promise<boolean> {
        if (pot.ProbabilityNumerator <= 0 || pot.ProbabilityDenominator <= 0) return false;
        if (pot.ProbabilityNumerator >= pot.ProbabilityDenominator) return true;
        return (await this.rng.getInt32(pot.ProbabilityDenominator)) < pot.ProbabilityNumerator;
    }

    /** Ported from ChampionsJackpotTicketGenerator; an unconfigured tier yields no layouts. */
    private async generateTicket(tierId: number): Promise<number[][][]> {
        const range = this.ticketConfig.CollectorSizeBoundary[tierId];
        if (!Array.isArray(range) || range.length < 2) return [];

        const rangeSize = Math.max(1, range[1] - range[0]);
        const numberToCollect = (await this.rng.getInt32(rangeSize)) + range[0];
        const rounds = Math.max(1, Math.trunc(this.ticketConfig.JackpotRounds));
        const width = Math.max(1, Math.trunc(this.ticketConfig.GridWidth));
        const height = Math.max(1, Math.trunc(this.ticketConfig.GridHeight));

        const gemsPerRound = Math.floor(numberToCollect / rounds);
        const divisions = new Array<number>(rounds).fill(gemsPerRound);
        for (let leftover = numberToCollect % rounds; leftover > 0; leftover--) divisions[await this.rng.getInt32(rounds)]++;

        const cells = width * height;
        const shuffled: number[] = [];
        for (let i = 0; i < cells; i++) shuffled.push(i);
        for (let index = shuffled.length - 1; index > 0; index--) {
            const swapIndex = await this.rng.getInt32(index + 1);
            const swap = shuffled[index];
            shuffled[index] = shuffled[swapIndex];
            shuffled[swapIndex] = swap;
        }

        const layouts: number[][][] = [];
        let filledSpaces = 0;
        for (const division of divisions) {
            filledSpaces = Math.min(filledSpaces + division, cells);
            const ticket = new Array<number>(cells).fill(0);
            for (let index = 0; index < filledSpaces; index++) ticket[shuffled[index]] = 1;

            const reels: number[][] = [];
            for (let x = 0; x < width; x++) {
                const reel = new Array<number>(height).fill(0);
                for (let y = 0; y < height; y++) reel[y] = ticket[x + width * y];
                reels.push(reel);
            }
            layouts.push(reels);
        }

        return layouts;
    }
}

/** Drops malformed entries and clamps the rest so a bad config can never throw at request time. */
function normalisePots(pots: MockJackpotPotConfig[]): MockJackpotPotConfig[] {
    const seen = new Set<number>();
    const normalised: MockJackpotPotConfig[] = [];

    for (const raw of Array.isArray(pots) ? pots : []) {
        const tierId = positiveInteger(raw?.TierId);
        if (tierId === undefined || seen.has(tierId)) continue;
        seen.add(tierId);

        const pot: MockJackpotPotConfig = {
            Tier: nonEmpty(raw.Tier) ?? String(tierId),
            TierId: tierId,
            Ordering: positiveInteger(raw.Ordering) ?? tierId,
            BaseSeedValue: nonNegativeInteger(raw.BaseSeedValue) ?? 0,
            ContributionPercent: nonNegativeNumber(raw.ContributionPercent) ?? 0,
            Rtp: nonNegativeNumber(raw.Rtp) ?? 0,
            ProbabilityNumerator: nonNegativeInteger(raw.ProbabilityNumerator) ?? 0,
            ProbabilityDenominator: nonNegativeInteger(raw.ProbabilityDenominator) ?? 0,
        };
        const mustGo = nonNegativeInteger(raw.MustGoValue);
        if (mustGo !== undefined) pot.MustGoValue = mustGo;

        normalised.push(pot);
    }

    return normalised.length > 0 ? normalised : normalisePots(createDefaultJackpotPots());
}

function toPotTier(tierId: number): PotTier {
    switch (tierId) {
        case PotTier.Low:
            return PotTier.Low;
        case PotTier.Mid:
            return PotTier.Mid;
        case PotTier.High:
            return PotTier.High;
        default:
            return PotTier.None;
    }
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
