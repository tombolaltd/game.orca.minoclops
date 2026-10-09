import { ISymbolPayoutData } from '@/src/types';
import { IBaseGameSettingsModel, IBaseServerResponse, IBaseSettingsResponse } from '@game-studio/arcade-base';
import { IFlowStateServerResponse } from '../services/orca/types';
import { IS_JACKPOT } from '../services/orca/active-skin';
import { gameModel } from './game-model';

export class GameSettings implements IBaseGameSettingsModel {
    public static get Instance(): GameSettings {
        return this._instance || (this._instance = new GameSettings());
    }
    private static _instance: GameSettings;

    public engineVersion: string = '';
    public rtp: string = '';
    public maxWinStakeMultiplier: number;
    public symbolPayoutData: ISymbolPayoutData[] = [];
    /** GameSettings.Symbols as the engine sent it: Symbol, IsWild, IsScatter, Prizes [{ Matched, Multiplier }]. */
    public engineSymbols: Record<string, any>[] = [];

    // ─────────────────────────────────────────────────────────────────────
    // Optional settings consumed by the bundled FlowState method library.
    // Defaults here are empty / placeholder values; real games should
    // populate these from server response or static config. Do not remove
    // — the FlowState `gameState`, `reels`, and `wallet` method modules
    // reference them.
    // ─────────────────────────────────────────────────────────────────────

    /** Main-game reel strips (2D array indexed [reel][row]) */
    public reels: number[][] = [];
    /** Bonus / free-spin reel strips (2D array indexed [reel][row]) */
    public bonusSpinReels: number[][] = [];
    /** Available stake options in minor currency units */
    public stakeOptions: number[] = [];
    /** Default stake amount in minor currency units */
    public defaultStake: number = 0;

    // Some fake settings data to use until a server is setup
    // Only applies while config.engineName === 'unknown'
    public dummySettings: IBaseSettingsResponse = {
        DefaultStake: 5,
        Version: '',
        StakeOptions: [5, 10, 20, 50, 100, 200],
        RTP: '98.25%'
    };

    public jackpotVersion: number = 0;

    public setData(responseData: IBaseServerResponse): void {
        this.maxWinStakeMultiplier = 500; // TODO: Get this from the server e.g. Math.max(...responseData.GameSettings.WinMultipliers)
        this.engineVersion = responseData.GameSettings.Version;
        
        if (responseData.GameSettings.RTP) {
            this.rtp = responseData.GameSettings.RTP;
        } else if (responseData.GameSettings.Rtp) {
            this.rtp = responseData.GameSettings.Rtp;
        } else {
            // This should always come from the engine in recent games to enable it changing without client releases.
            throw new Error('Missing RTP value from engine response.');
        }

        // Propagate stake options / default stake into the FlowState-consumed
        // fields, falling back to safe defaults when the server omits them.
        this.stakeOptions = responseData.GameSettings.StakeOptions ?? [];
        this.defaultStake =
            responseData.GameSettings.DefaultStake ?? this.stakeOptions[0] ?? 0;

        // Jackpot skins capture the jackpot version on Resume and forward it
        // with the outgoing Begin request via gameModel.additionalBeginData.
        // samsplitjp is a jackpot engine: its Begin carries the jackpot version
        // even while this skin's jackpots panel is switched off.
        const jackpotDetails = (responseData as unknown as IFlowStateServerResponse).GameSettings?.JackpotDetails;
        if (IS_JACKPOT || jackpotDetails) {
            const flowstateData = responseData as unknown as IFlowStateServerResponse;
            if (flowstateData.RequestType === 'Resume') {
                const version = flowstateData.GameSettings?.JackpotDetails?.Version ?? 0;
                gameModel.additionalBeginData = { JackpotVersion: version };
                this.jackpotVersion = version;
            }
        }

        this.flowstateSetData(responseData as unknown as IFlowStateServerResponse);
        if (this.engineSymbols.length > 0) this.symbolPayoutData = this.splittingPayouts(this.engineSymbols);
    }

    /** The paying symbols' prizes in the shape the paytable and how-to-play pages read (BONUS awards free spins instead). */
    private splittingPayouts(symbols: Record<string, any>[]): ISymbolPayoutData[] {
        const payouts: ISymbolPayoutData[] = [];
        for (const entry of symbols) {
            const prizes: Record<string, any>[] = entry && Array.isArray(entry.Prizes) ? entry.Prizes : [];
            if (prizes.length === 0 || entry.IsScatter === true) continue;
            payouts.push({
                symbolID: Number(entry.Symbol),
                payout: prizes.map((prize: Record<string, any>) => ({ matched: Number(prize.Matched), multiplier: Number(prize.Multiplier) })),
            });
        }
        return payouts;
    }

    // #region FlowState Server Connection Mappings
    // Auto-generated by FlowState Data Browser - 2026-09-30T00:00:00.000Z
    // DO NOT EDIT MANUALLY - Changes will be overwritten
    // Required import: import { IFlowStateServerResponse } from '../services/orca/types';

    private flowstateSetData(responseData: IFlowStateServerResponse): void {
        const engineSymbols = (responseData as Record<string, any>).GameSettings?.Symbols;
        if (engineSymbols !== undefined && engineSymbols !== null) {
            // Deep copy - the response object is transient, never store a live reference.
            const engineSymbolsSource: any = Array.isArray(engineSymbols) ? engineSymbols : [engineSymbols];
            let engineSymbolsCopy: any = engineSymbolsSource;
            try {
                engineSymbolsCopy = JSON.parse(JSON.stringify(engineSymbolsSource));
            } catch (e) {
                console.warn('[FlowState] Could not deep-copy response value for "engineSymbols"', e);
            }
            this.engineSymbols = engineSymbolsCopy as typeof this.engineSymbols;
        }
    }

    // #endregion FlowState Server Connection Mappings
}

export const gameSettings = GameSettings.Instance;
