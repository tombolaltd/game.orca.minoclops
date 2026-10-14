import { IBaseGameModel, IBaseMessageResponse, IBaseServerResponse } from '@game-studio/arcade-base';
import { gameSettings } from './game-settings';
import { IFlowStateServerResponse } from '../services/orca/types';
import { sendServerResponseToEditor } from '../services/orca/editor-integration';

//types

export interface IServerResponse extends IBaseServerResponse {
    GameMessage: IGameMessageResponse;
}

export interface IGameMessageResponse extends IBaseMessageResponse {
    ArcadeGameType: string;
    Payout: number;
    Winner: boolean;
    BonusRound?: IBonusRound;
    Game: IGame;
}

export interface IReelPosition {
    Reel: number;
    Row: number;
}

export interface IGame {
    GameResult: IGameResult;
    BonusRound?: IBonusRound;
}

export interface IGameResult {
    Bonus: boolean;
    CascadeCount: number;
    Outcomes: IOutcome[];
    ScatterResult: IScatterResult | null;
    SplitSymbolDetails: ISplitSymbolDetail[];
}

export interface IOutcome {
    DisplayReels: number[][];
    Prize: number;
    Results: IOutcomeResult[];
    SplitSymbols: ISplitSymbol[];
    Stops: number[];
    WinWays: number;
}

export interface IOutcomeResult {
    Positions: IReelPosition[];
    OutcomeType: string;
    Matched: number;
    Symbol: number;
    Prize: number;
    Wild: boolean;
    IsSplit: boolean;
    SymbolMultiplier: number;
    SplitMultiplier: number;
    TotalMultiplier: number;
}

export interface ISplitSymbolDetail {
    HighlightedPosition: ISplitSymbol[];
    Split: number;
    Symbol: number;
}

export interface ISplitSymbol {
    Reel: number;
    Row: number;
}

export interface IPrizeResult {
    Prize: number;
    Positions: IReelPosition[];
    Symbol: number;
    Matched: number;
    Multiplier: number;
    OutcomeType: string;
    Wild: boolean;
}

export interface IScatterResult {
    Bonus: boolean;
    Count: number;
    Multiplier: number;
    OutcomeType: string;
    Positions: IReelPosition[];
    Prize: number;
    Symbol: number;
}

export interface IBonusRound extends IGameResult {
    BonusPayout: number;
    TotalBonusPayout: number;
    Number: number;
    Remaining: number;
}


//model
export class GameModel implements IBaseGameModel {
    public static get Instance(): GameModel {
        return this._instance || (this._instance = new GameModel());
    }
    private static _instance: GameModel;

    /** The engine's game id, sent back as `GameId` on every Continue. */
    public engineGameId: number = 0;
    /** GameMessage.Game as the engine sent it: GameResult (paid spin) and BonusRound (free spin). */
    public realGame: Record<string, any> = {};

    public payout: number = 0;
    public isNewPlayer: boolean = false;
    public playMode: string = '';
    public isComplete: boolean = false;
    public hasBonus: boolean = false;
    public gameId: number = 0;
    public isInProgress: boolean = false;
    public additionalBeginData: object = {};

    public gameid: number = 0;
    public gameComplete: boolean = false;
    public stake: number = 0;
    public skin: string = '';
    public arcadeGameType: string = '';
    public bonus: boolean = false;
    public cascadeCount: number = 0;
    public currentCascade: number = 0;
    public initialBonusSpins: number = 0;
    public currentBonusSpin: number = 0;
    public currentBonus: IBonusRound = {
        BonusPayout: 0,
        TotalBonusPayout: 0,
        Number: 0,
        Remaining: 0,
        Bonus: false,
        CascadeCount: 0,
        Outcomes: [],
        ScatterResult: null,
        SplitSymbolDetails: []
    };
    public currentBonusSpinPayout: number = 0;
    public bonusSpinsRemaining: number = 0;
    public totalBonusPayout: number = 0;

    // True while a free-spin round is being played out.
    public isInBonusRound: boolean = false;
    // True when the game launched already mid free-spin round (Resume), so it enters bonus on load.
    public bonusOnResume: boolean = false;

    public unplayedSpinOutcomes: IOutcome[] = [];
    public playedSpinOutcomes: IOutcome[] = [];

    public winner: boolean = false;
    public bonusRound: IBonusRound = {
        BonusPayout: 0,
        TotalBonusPayout: 0,
        Number: 0,
        Remaining: 0,
        Bonus: false,
        CascadeCount: 0,
        Outcomes: [],
        ScatterResult: null,
        SplitSymbolDetails: []
    };
    public scatterResult: IScatterResult | null = null;

    public splitSymbolDetails: ISplitSymbolDetail[] = [];

       /** Round flow state (written by the graphs). */
    public roundBusy: boolean = false;
    public bonusSpinsTotal: number = 0;
    public bonusSpinsPlayed: number = 0;
    public waysShown: number = 243;
    public stepIndex: number = 0;

    public isInJackpot: boolean = false;
    public mainGamePayout: number = 0;
    public isWildReel: boolean[] = [];
    public shouldReelSlowDown: boolean[] = [];

    public displayReels: number [][] = [];

    // Static stand-in message used while config.engineName === 'unknown'. The dummy generator is
    // commented out for now; this returns one fixed base-spin board so the reels have something to show.
    public get dummyMessage(): IGameMessageResponse {
        const gameResult: IGameResult = {
            Bonus: false,
            CascadeCount: 0,
            ScatterResult: {
                Bonus: false,
                Count: 0,
                Multiplier: 0,
                OutcomeType: 'scatter',
                Positions: [],
                Prize: 0,
                Symbol: 1
            },
            SplitSymbolDetails: [],
            Outcomes: [
                {
                    DisplayReels: [
                        [1, 6, 3],
                        [4, 7, 2],
                        [8, 5, 9],
                        [3, 10, 6],
                        [5, 8, 2]
                    ],
                    Prize: 0,
                    Results: [],
                    SplitSymbols: [],
                    Stops: [0, 0, 0, 0, 0],
                    WinWays: 0
                }
            ]
        };
        return {
            GameId: 0,
            GameComplete: true,
            PlayMode: 'real',
            Stake: 0,
            Skin: 'minoclops',
            ArcadeGameType: 'splitting-symbols',
            Payout: 0,
            Winner: false,
            BonusRound: { ...gameResult, BonusPayout: 0, TotalBonusPayout: 0, Number: 0, Remaining: 0 },
            Game: { GameResult: gameResult }
        };
    }

    public get reelStoppingPositions(): number[]{
        return this.unplayedSpinOutcomes[0].Stops;
    }

    public set reelStoppingPositions(value: number[]){
        this.unplayedSpinOutcomes[0].Stops = value;
    }


    public get freeSpinsRemaining(): number{
        return this.bonusSpinsRemaining;
    }

    public set freeSpinsRemaining(value: number){
        this.bonusSpinsRemaining = value;
    }

    public get totalGamePayout(): number{
        return this.payout;
    }

    public set totalGamePayout(value: number){
        this.payout = value;
    }

    public get isFreeSpinning(): boolean{
        return this.isInBonusRound;
    }

     public set isFreeSpinning(value: boolean){
         this.isInBonusRound = value;
    }

     public get winAmountSoFar(): number{
        return this.payout;
    }

     public set winAmountSoFar(value: number){
         this.payout = value;
    }


     public setData(responseData: IBaseServerResponse): void {
        // Forward to FlowState Editor for auto-gathering (if enabled)
        sendServerResponseToEditor(responseData);

        this.playMode = responseData.GameMessage.PlayMode;
        this.isComplete = responseData.GameMessage.GameComplete;
        this.hasBonus = false; // TODO: If game has a bonus, figure this out from responseData

        const data = responseData as unknown as IFlowStateServerResponse;
        switch (data.RequestType) {
            case 'Resume':
                this.setResumeData(data);
                break;
            case 'Begin':
                this.setBeginData(data);
                break;
            case 'Continue':
                this.setContinueData(data);
                break;
            default:
                break;
        }

        this.setSplittingSymbolsGameData(responseData as IServerResponse);

    }

    private setResumeData(resumeData: IFlowStateServerResponse): void {
        this.flowstateSetResumeData(resumeData);
    }

    private setBeginData(beginData: IFlowStateServerResponse): void {
        this.flowstateSetBeginData(beginData);
    }

    private setContinueData(continueData: IFlowStateServerResponse): void {
        this.flowstateSetContinueData(continueData);
    }

    public setSplittingSymbolsGameData(responseData: IServerResponse): void {
        if (!responseData) {
            return;
        }

        const message = responseData.GameMessage;
        const game = message.Game;
        const gameResult = game.GameResult;
        const bonusRound = game.BonusRound;

        this.playMode = message.PlayMode;
        this.isComplete = message.GameComplete;
        this.gameId = message.GameId;
        this.gameComplete = message.GameComplete;
        this.stake = message.Stake;
        this.skin = message.Skin;
        this.arcadeGameType = message.ArcadeGameType;
        this.payout = this.mainGamePayout = message.Payout;
        this.winner = message.Winner;
        this.playedSpinOutcomes = [];
        this.currentCascade = 0;
        // Reset here so the first Continue of a resume-triggered bonus sends BonusSpin 1; the bonus
        // block below overrides it with the engine's Number once free spins are in progress.
        this.currentBonusSpin = 0;
        // An unfinished game (GameComplete false) resumed from the server is mid bonus round.
        this.bonusOnResume = responseData.RequestType === 'Resume' && !this.isComplete;

        this.bonus = gameResult.Bonus;
        this.hasBonus = gameResult.ScatterResult?.Bonus === true;
        // Trigger stage (Bonus landed, no Game.BonusRound yet): seed the award; the bonus block overrides with Remaining.
        this.bonusSpinsRemaining = this.hasBonus ? gameSettings.initialBonusSpins : 0;
        this.cascadeCount = gameResult.CascadeCount;
        this.scatterResult = gameResult.ScatterResult;
        this.splitSymbolDetails = gameResult.SplitSymbolDetails;
        // GameResult is empty {} on a Continue, so guard the spread; a Resume carries the full triggering spin.
        this.unplayedSpinOutcomes = gameResult.Outcomes ? [...gameResult.Outcomes] : [];
        this.displayReels = gameResult.Outcomes ? gameResult.Outcomes[0].DisplayReels : [];
        this.waysShown = this.unplayedSpinOutcomes[0].WinWays;

        // On a Resume the triggering spin already played out; keep only its settled board so the reels show it.
        if (responseData.RequestType === 'Resume' && this.unplayedSpinOutcomes.length > 0) {
            this.currentCascade = this.unplayedSpinOutcomes.length - 1;
            this.unplayedSpinOutcomes = [this.unplayedSpinOutcomes[this.currentCascade]];
        }

        if (bonusRound) {
            // Free spin (Continue/Resume): cascades and counters live under Game.BonusRound.
            this.currentBonus = bonusRound;
            this.bonusRound = bonusRound;
            this.bonus = true;
            this.hasBonus = false;
            this.scatterResult = null;
            this.cascadeCount = bonusRound.CascadeCount;
            this.splitSymbolDetails = bonusRound.SplitSymbolDetails;
            this.bonusSpinsRemaining = bonusRound.Remaining;
            this.currentBonusSpin = bonusRound.Number;
            this.currentBonusSpinPayout = bonusRound.BonusPayout;
            this.totalBonusPayout = bonusRound.TotalBonusPayout;
            this.mainGamePayout = this.payout - this.totalBonusPayout;
            this.unplayedSpinOutcomes = [...bonusRound.Outcomes];

            // A mid free-spin Resume settles on the last cascade of the current spin.
            if (responseData.RequestType === 'Resume' && this.unplayedSpinOutcomes.length > 0) {
                this.currentCascade = this.unplayedSpinOutcomes.length - 1;
                this.unplayedSpinOutcomes = [this.unplayedSpinOutcomes[this.currentCascade]];
            }
        }

    }


    public get cascadeOutcome(): number[][] {
        return this.unplayedSpinOutcomes[0].DisplayReels;
    }

    // topOffset accounts for the hidden buffer symbol above the visible grid
    public getFullReelRemovals(topOffset: number): number[][] {
        return this.unplayedSpinOutcomes[0].DisplayReels.map(
            reel => reel.map((_, row) => row + topOffset)
        );
    }

    // Blocks to be removed from the on-screen board, taken from the outcome that just
    // settled (mirrors cascade-243's currentCascadeTargets). topOffset accounts for the
    // hidden buffer symbol above the visible grid.
    public currentCascadeTargets(topOffset: number): number[][] {
        const outcome = this.playedSpinOutcomes[this.playedSpinOutcomes.length - 1];
        const locations: number[][] = outcome.DisplayReels.map(() => []);
        for (const result of outcome.Results) {
            const positions = result.Positions
            for (const position of positions) {
                const location = locations[position.Reel];
                if (location && !location.includes(position.Row + topOffset)) {
                    location.push(position.Row + topOffset);
                }
            }
        }
        return locations;
    }

    // #region FlowState Server Connection Mappings
    // Auto-generated by FlowState Data Browser - 2026-09-30T00:00:00.000Z
    // DO NOT EDIT MANUALLY - Changes will be overwritten
    // Required import: import { IFlowStateServerResponse } from '../services/orca/types';

    private flowstateSetResponseData(responseData: IFlowStateServerResponse): void {
        // No mappings configured for Response
    }

    private flowstateSetResumeData(responseData: IFlowStateServerResponse): void {
        if ((responseData as Record<string, any>).GameMessage?.GameId !== undefined) this.engineGameId = Number((responseData as Record<string, any>).GameMessage?.GameId);
        if ((responseData as Record<string, any>).GameMessage?.Payout !== undefined) this.payout = Number((responseData as Record<string, any>).GameMessage?.Payout);
        const realGame = (responseData as Record<string, any>).GameMessage?.Game;
        if (realGame !== undefined && realGame !== null) {
            // Deep copy - the response object is transient, never store a live reference.
            const realGameSource: any = realGame;
            let realGameCopy: any = realGameSource;
            try {
                realGameCopy = JSON.parse(JSON.stringify(realGameSource));
            } catch (e) {
                console.warn('[FlowState] Could not deep-copy response value for "realGame"', e);
            }
            this.realGame = realGameCopy as typeof this.realGame;
        }
    }

    private flowstateSetBeginData(responseData: IFlowStateServerResponse): void {
        if ((responseData as Record<string, any>).GameMessage?.GameId !== undefined) this.engineGameId = Number((responseData as Record<string, any>).GameMessage?.GameId);
        if ((responseData as Record<string, any>).GameMessage?.Payout !== undefined) this.payout = Number((responseData as Record<string, any>).GameMessage?.Payout);
        const realGame = (responseData as Record<string, any>).GameMessage?.Game;
        if (realGame !== undefined && realGame !== null) {
            // Deep copy - the response object is transient, never store a live reference.
            const realGameSource: any = realGame;
            let realGameCopy: any = realGameSource;
            try {
                realGameCopy = JSON.parse(JSON.stringify(realGameSource));
            } catch (e) {
                console.warn('[FlowState] Could not deep-copy response value for "realGame"', e);
            }
            this.realGame = realGameCopy as typeof this.realGame;
        }
    }

    private flowstateSetContinueData(responseData: IFlowStateServerResponse): void {
        if ((responseData as Record<string, any>).GameMessage?.GameId !== undefined) this.engineGameId = Number((responseData as Record<string, any>).GameMessage?.GameId);
        if ((responseData as Record<string, any>).GameMessage?.Payout !== undefined) this.payout = Number((responseData as Record<string, any>).GameMessage?.Payout);
        const realGame = (responseData as Record<string, any>).GameMessage?.Game;
        if (realGame !== undefined && realGame !== null) {
            // Deep copy - the response object is transient, never store a live reference.
            const realGameSource: any = realGame;
            let realGameCopy: any = realGameSource;
            try {
                realGameCopy = JSON.parse(JSON.stringify(realGameSource));
            } catch (e) {
                console.warn('[FlowState] Could not deep-copy response value for "realGame"', e);
            }
            this.realGame = realGameCopy as typeof this.realGame;
        }
    }

    // #endregion FlowState Server Connection Mappings
}

export const gameModel = GameModel.Instance;
