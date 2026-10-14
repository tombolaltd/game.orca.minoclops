import { IBaseGameSettingsModel, IBaseServerResponse, IBaseSettingsResponse, IJackpotResponse } from '@game-studio/arcade-base';
import { IFlowStateServerResponse } from '../services/orca/types';
import { IS_JACKPOT } from '../services/orca/active-skin';
import { gameModel } from './game-model';
import { ISymbolPayoutData } from '../../types';


export const SYMBOLS = {
    WILD: 2,
    BONUS: 1,
    PAYING: [3, 4, 5, 6, 7, 8, 9, 10, 11],
} as const;

export interface IServerResponse extends IBaseServerResponse {
    GameSettings: IGameSettingsResponse;
}

export interface IGameSettingsSymbol {
    IsWild: boolean;
    IsScatter: boolean;
    Prizes: ISymbolPrize[];
    Symbol: number;
}

export interface ISymbolPrize {
    Matched: number;
    Multiplier: number;
    SpinMultiplier: number;
    PrizeType: string;
}

export interface IGameSettingsResponse extends IBaseSettingsResponse {
    ScatterSymbol: number;
    WildSymbol: number;
    Symbols: IGameSettingsSymbol[];
    TotalRTP?: string;
    TotalRtp?: string;
    Reels: number[][];
    BonusReels: number[][];
}

export class GameSettings implements IBaseGameSettingsModel {
   public static get Instance(): GameSettings {
        return this._instance || (this._instance = new GameSettings());
    }
    private static _instance: GameSettings;

    public engineVersion: string = '';
    public rtp: string = '';
    public maxWinStakeMultiplier!: number;
    public defaultStake!: number;
    public stakeOptions!: number[];
    public totalRTP!: string;
    public symbolDescriptions!: IGameSettingsSymbol[];
    public mainReels!: number[][];
    public bonusReels!: number[][];
    public initialBonusSpins: number = 5;
    public bonusSpins!: number;
    
    /** GameSettings.Symbols as the engine sent it: Symbol, IsWild, IsScatter, Prizes [{ Matched, Multiplier }]. */
    public engineSymbols: Record<string, any>[] = [];

    /** Main-game reel strips (2D array indexed [reel][row]) */
    public reels: number[][] = [];
    /** Bonus / free-spin reel strips (2D array indexed [reel][row]) */
    public bonusSpinReels: number[][] = [];

    // Some fake settings data to use until a server is setup
    // Only applies while config.engineName === 'unknown'
   public dummySettings: IGameSettingsResponse = {
        DefaultStake: 10,
        Version: '1.0.0',
        StakeOptions: [10, 20, 50, 70, 100, 150, 200, 250, 300, 400, 500],
        RTP: '96.99%',

        Symbols: [
            // Engine scheme: 1 scatter, 2 wild, 3-11 paying.
            { Symbol: SYMBOLS.BONUS, IsWild: false, IsScatter: true, Prizes: [] },
            { Symbol: SYMBOLS.WILD, IsWild: true, IsScatter: false, Prizes: [] },
            ...SYMBOLS.PAYING.map((symbol) => ({
                Symbol: symbol,
                IsWild: false,
                IsScatter: false,
                Prizes: [
                    { Matched: 3, Multiplier: 2, SpinMultiplier: 0, PrizeType: 'line' },
                    { Matched: 4, Multiplier: 5, SpinMultiplier: 0, PrizeType: 'line' },
                    { Matched: 5, Multiplier: 10, SpinMultiplier: 0, PrizeType: 'line' }
                ]
            }))
        ],
        ScatterSymbol: 1,
        WildSymbol: 2,
        Reels: [],
        BonusReels: []
    };

    public get symbolPayoutData(): ISymbolPayoutData[] {
        return (this.symbolDescriptions ?? []).map((symbol) => ({
            symbolID: symbol.Symbol,
            payout: symbol.Prizes.map((prize) => ({
                matched: prize.Matched,
                multiplier: prize.Multiplier
            }))
        }));
    }


    public jackpotVersion: number = 0;

    public setData(responseData: IServerResponse): void {

        this.maxWinStakeMultiplier = 500; // TODO: Get this from the server e.g. Math.max(...responseData.GameSettings.WinMultipliers)
        this.engineVersion = responseData.GameSettings.Version;
        this.defaultStake = responseData.GameSettings.DefaultStake;
        this.stakeOptions = responseData.GameSettings.StakeOptions;

        // This engine doesn't send reel strips; use the local ones for the idle display.
        this.mainReels = responseData.GameSettings.Reels;
        this.bonusReels = responseData.GameSettings.BonusReels;

        this.symbolDescriptions = responseData.GameSettings.Symbols.map((symbol) => {
            return {
                Symbol: symbol.Symbol,
                IsWild: symbol.IsWild,
                IsScatter: symbol.IsScatter,
                // The engine sends null Prizes for non-paying symbols (e.g. wild); normalise to empty.
                Prizes: symbol.Prizes ?? [],
            };
        });

        
        this.totalRTP = this.rtp;
        

        // TODO: If a Paytable is required in the HTP
        if (responseData.GameSettings.RTP) {
            this.rtp = responseData.GameSettings.RTP;
        } else if (responseData.GameSettings.Rtp) {
            this.rtp = responseData.GameSettings.Rtp;
        } else {
            // This should always come from the engine in recent games to enable it changing without client releases.
            throw new Error('Missing RTP value from engine response.');
        }
    
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
