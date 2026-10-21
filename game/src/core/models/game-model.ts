import { IBaseGameModel, IBaseServerResponse } from '@game-studio/arcade-base';
import { gameSettings } from './game-settings';
import { IFlowStateServerResponse } from '../services/orca/types';
import { sendServerResponseToEditor } from '../services/orca/editor-integration';
import { IBonusRound, IOutcome, IScatterResult, ISplitSymbolDetail, IGameMessageResponse, IGameResult, IServerResponse } from '../services/orca/generated-types';

//model
export class GameModel implements IBaseGameModel {
    public hotSpotPlayed: boolean = false;
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
    private _currentCascade: number = 0;
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

    public bonusTutorialSeen: boolean = false;
    // The on-screen win counter; kept apart from payout so graph writes can't overwrite the server total.
    private _winAmountSoFar: number = 0;

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
                    WinWays: 243
                }
            ]
        };
        return {
            GameId: 0,
            GameComplete: true,
            PlayMode: 'real',
            Stake: 0,
            Skin: 'minoclop',
            ArcadeGameType: 'splitting-symbols',
            Payout: 0,
            Winner: false,
            Game: { GameResult: gameResult }
        };
    }

    public get reelStoppingPositions(): number[]{
        return this.unplayedSpinOutcomes[0]?.Stops ?? [];
    }

    public set reelStoppingPositions(value: number[]){
        if (this.unplayedSpinOutcomes[0]) {
            this.unplayedSpinOutcomes[0].Stops = value;
        }
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
        return this._winAmountSoFar;
    }

     public set winAmountSoFar(value: number){
         this._winAmountSoFar = value;
    }

    // Graphs step this to walk the cascades; keeps displayReels/waysShown on the current board.
    public get currentCascade(): number {
        return this._currentCascade;
    }

    public set currentCascade(value: number) {
        this._currentCascade = value;
        const outcome = this.unplayedSpinOutcomes[value];
        if (outcome) {
            this.displayReels = outcome.DisplayReels;
            this.waysShown = outcome.WinWays;
        }
    }

    // Aliases for the names the bonus graphs use.
    public get inBonus(): boolean {
        return this.isInBonusRound;
    }

    public set inBonus(value: boolean) {
        this.isInBonusRound = value;
    }

    public get tutorialSeen(): boolean {
        return this.bonusTutorialSeen;
    }

    public set tutorialSeen(value: boolean) {
        this.bonusTutorialSeen = value;
    }

    // Shape read by the bonus graphs' Parse Object nodes.
    public get bonusSpin(): Record<string, any> {
        return {
            ...this.bonusRound,
            Number: this.currentBonusSpin,
            Total: this.currentBonusSpin + this.bonusSpinsRemaining,
            Remaining: this.bonusSpinsRemaining,
            BonusPayout: this.currentBonusSpinPayout,
            TotalBonusPayout: this.totalBonusPayout
        };
    }

    // Shape read by the bonus-trigger/start/spin-end graphs' Parse Object nodes.
    public get roundInfo(): Record<string, any> {
        return {
            GameComplete: this.isComplete,
            BonusTier: this.scatterResult?.Count ?? 0,
            FreeSpins: this.currentBonusSpin + this.bonusSpinsRemaining,
            BonusPositions: this.scatterResult?.Positions ?? [],
            ScatterAward: this.scatterResult?.Prize ?? 0,
            WinAfterScatter: this.mainGamePayout
        };
    }


     public setData(responseData: IBaseServerResponse): void {
        // Forward to FlowState Editor for auto-gathering (if enabled)
        sendServerResponseToEditor(responseData);

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
        const isResume = responseData.RequestType === 'Resume';
        // GameResult is empty {} on a free-spin Continue.
        const gameResult: Partial<IGameResult> = message.Game?.GameResult ?? {};
        const bonusRound = message.Game?.BonusRound;

        this.playMode = message.PlayMode;
        this.isComplete = message.GameComplete;
        this.gameId = this.gameid = this.engineGameId = message.GameId;
        this.gameComplete = message.GameComplete;
        this.stake = message.Stake;
        this.skin = message.Skin;
        this.arcadeGameType = message.ArcadeGameType;
        this.payout = this.mainGamePayout = message.Payout;
        this.winner = message.Winner;
        this.playedSpinOutcomes = [];
        // Reset here so the first Continue of a resume-triggered bonus sends BonusSpin 1; the bonus
        // block below overrides it with the engine's Number once free spins are in progress.
        this.currentBonusSpin = 0;
        // An unfinished game (GameComplete false) resumed from the server is mid bonus round.
        this.bonusOnResume = isResume && !this.isComplete;

        // steps-done reads this as "in free spins?", so only a BonusRound sets it.
        this.bonus = false;
        this.hasBonus = gameResult.ScatterResult?.Bonus === true;
        // Trigger stage (Bonus landed, no Game.BonusRound yet): seed the award; the bonus block overrides with Remaining.
        this.bonusSpinsRemaining = this.hasBonus ? gameSettings.initialBonusSpins : 0;
        this.cascadeCount = gameResult.CascadeCount ?? 0;
        this.scatterResult = this.toClientScatter(gameResult.ScatterResult);
        this.splitSymbolDetails = this.toClientSplitDetails(gameResult.SplitSymbolDetails);
        this.unplayedSpinOutcomes = (gameResult.Outcomes ?? []).map(outcome => this.toClientOutcome(outcome));

        if (bonusRound) {
            // Free spin (Continue/Resume): cascades and counters live under Game.BonusRound.
            const clientBonusRound: IBonusRound = {
                ...bonusRound,
                Outcomes: (bonusRound.Outcomes ?? []).map(outcome => this.toClientOutcome(outcome)),
                ScatterResult: this.toClientScatter(bonusRound.ScatterResult) ?? undefined,
                SplitSymbolDetails: this.toClientSplitDetails(bonusRound.SplitSymbolDetails)
            };
            this.currentBonus = { ...clientBonusRound };
            this.bonusRound = clientBonusRound;
            this.bonus = true;
            this.scatterResult = clientBonusRound.ScatterResult ?? null;
            this.hasBonus = bonusRound.ScatterResult?.Bonus === true;
            this.cascadeCount = bonusRound.CascadeCount ?? 0;
            this.splitSymbolDetails = clientBonusRound.SplitSymbolDetails;
            this.bonusSpinsRemaining = bonusRound.Remaining;
            this.currentBonusSpin = bonusRound.Number;
            this.currentBonusSpinPayout = bonusRound.BonusPayout;
            this.totalBonusPayout = bonusRound.TotalBonusPayout;
            this.mainGamePayout = this.payout - this.totalBonusPayout;
            this.unplayedSpinOutcomes = [...clientBonusRound.Outcomes];
        }

        // On a Resume the spin already played out; keep only its settled board.
        if (isResume) {
            if (this.unplayedSpinOutcomes.length > 0) {
                this.unplayedSpinOutcomes = [this.unplayedSpinOutcomes[this.unplayedSpinOutcomes.length - 1]];
            }
            this.winAmountSoFar = this.payout;
        }

        this.displayReels = [];
        this.currentCascade = 0;
    }

    // Engine symbol IDs are 1-based; the reel symbol entries are 0-based.
    private toClientOutcome(outcome: IOutcome): IOutcome {
        return {
            ...outcome,
            DisplayReels: (outcome.DisplayReels ?? []).map(reel => reel.map(symbol => symbol - 1)),
            Results: (outcome.Results ?? []).map(result => ({ ...result, Symbol: result.Symbol - 1 }))
        };
    }

    private toClientScatter(scatter: IScatterResult | undefined): IScatterResult | null {
        return scatter ? { ...scatter, Symbol: scatter.Symbol - 1 } : null;
    }

    private toClientSplitDetails(details: ISplitSymbolDetail[] | undefined): ISplitSymbolDetail[] {
        return (details ?? []).map(detail => ({ ...detail, Symbol: detail.Symbol - 1 }));
    }


    public get cascadeOutcome(): number[][] {
        return this.unplayedSpinOutcomes[this.currentCascade]?.DisplayReels ?? [];
    }

    // The board after the given cascade's wins are removed and refilled; the last cascade returns its own settled board.
    public getReelsAfterCascade(cascade: number = this.currentCascade): number[][] {
        const outcome = this.unplayedSpinOutcomes[cascade + 1] ?? this.unplayedSpinOutcomes[cascade];
        return outcome?.DisplayReels ?? [];
    }

    // topOffset accounts for the hidden buffer symbol above the visible grid
    public getFullReelRemovals(topOffset: number): number[][] {
        return this.cascadeOutcome.map(
            reel => reel.map((_, row) => row + topOffset)
        );
    }

    // Blocks to be removed from the current cascade's board. topOffset accounts for the
    // hidden buffer symbol above the visible grid.
    public currentCascadeTargets(topOffset: number): number[][] {
        const outcome = this.unplayedSpinOutcomes[this.currentCascade];
        if (!outcome) {
            return [];
        }
        const locations: number[][] = outcome.DisplayReels.map(() => []);
        for (const result of outcome.Results ?? []) {
            for (const position of result.Positions ?? []) {
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
