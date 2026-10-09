import { IBaseGameModel, IBaseServerResponse, IBaseMessageResponse } from '@game-studio/arcade-base';
import { sendServerResponseToEditor } from '../services/orca/editor-integration';
import { IFlowStateServerResponse } from '../services/orca/types';

export class GameModel implements IBaseGameModel {
    public static get Instance(): GameModel {
        return this._instance || (this._instance = new GameModel());
    }
    private static _instance: GameModel;

    public payout: number = 0;
    public isNewPlayer: boolean = false;
    public playMode: string;
    public isComplete: boolean;
    public hasBonus: boolean;
    public gameId: number;
    public isInProgress: boolean;

    // ─────────────────────────────────────────────────────────────────────
    // Optional state fields consumed by the bundled FlowState method library.
    // These are intentionally permissive defaults so a fresh scaffold compiles
    // and runs; real games typically override / refine these. Do not remove
    // — the FlowState `gameState` and `reels` method modules read/write them.
    // ─────────────────────────────────────────────────────────────────────

    // Bonus / free-spin state
    public isInBonusRound: boolean = false;
    public freeSpinsRemaining: number = 0;
    public isFreeSpinning: boolean = false;
    public currentBonusSpin: number = 0;
    public isInJackpot: boolean = false;

    // Win state
    public winner: boolean = false;
    public totalGamePayout: number = 0;
    public totalBonusPayout: number = 0;
    public mainGamePayout: number = 0;
    public currentBonusSpinPayout: number = 0;
    public winAmountSoFar: number = 0;

    // Reel state
    public reelStoppingPositions: number[] = [];
    public isWildReel: boolean[] = [];
    public shouldReelSlowDown: boolean[] = [];

    // Some fake message data to use until a server is setup
    // Only applies while config.engineName === 'unknown'
    public dummyMessage: IBaseMessageResponse = {
        GameId: 1,
        GameComplete: true,
        Skin: 'GAME_NAME_LOWER_CASE',
        Stake: 5,
        PlayMode: 'Cash'
    };

    // Additional data merged into the outgoing Begin request payload by the
    // arcade-base runtime. Populated on Resume for jackpot skins with the
    // captured jackpot version (see game-settings.ts).
    public additionalBeginData: Record<string, unknown> = {};

    // ─────────────────────────────────────────────────────────────────────
    // Splitting Symbols. The server mappings below copy the engine's round
    // (GameMessage.Game) into `realGame`; `shapeSplittingRound` (end of
    // setData) turns it into the per-cascade steps the FlowState graphs play.
    // Symbol ids are the engine's: 1 BONUS, 2 WILD, 3-11 paying (3 highest);
    // a split symbol shows on the reels as its id + 10.
    // ─────────────────────────────────────────────────────────────────────

    /** The engine's game id, sent back as `GameId` on every Continue. */
    public engineGameId: number = 0;
    /** GameMessage.Game as the engine sent it: GameResult (paid spin) and BonusRound (free spin). */
    public realGame: Record<string, any> = {};
    /** The board to show, `[reel][row]` symbol ids (row 0 at the top). */
    public reelSymbols: number[][] = [[7,3,9],[5,10,4],[8,2,6],[11,7,3],[9,5,8]];
    /** One entry per cascade: Grid, NewSplitCells, WaysTotal, WinPositions, StepWin, AccumulatedWin, HasCascade, ClearLocations, CascadeGrid, CascadeBadges. */
    public steps: Record<string, any>[] = [];
    /** The step being played (written by the graphs). */
    public step: Record<string, any> = {};
    /** This spin's hotspot: Found, Reel, Row, Symbol, Variant, Multiple, Badge. */
    public hotspot: Record<string, any> = { Found: false, Reel: 0, Row: 0, Symbol: 0, Name: '', Variant: 0, Multiple: 1, Badge: '' };
    /** Two BONUS symbols landed on the first board. */
    public teaseBonus: boolean = false;
    /** The round: BonusTier, BonusCount, FreeSpins, BonusPositions, ScatterAward, WinAfterScatter, GameComplete, Payout. */
    public roundInfo: Record<string, any> = {};
    /** The free spin: Number, Total, Remaining, HotspotReel, Selections, Steps, SpinWin, TotalBonusPayout, AccumulatedWin. */
    public bonusSpin: Record<string, any> = {};
    /** Tutorial / hint bookkeeping (written by the graphs). */
    public bonusTutorialSeen: boolean = false;
    public tutorialSeen: boolean = false;
    public teaseHintCount: number = 0;
    public persistHintCount: number = 0;
    public splitHintCount: number = 0;
    /** Round flow state (written by the graphs). */
    public roundBusy: boolean = false;
    public inBonus: boolean = false;
    public bonusSpinsTotal: number = 0;
    public bonusSpinsPlayed: number = 0;
    public waysShown: number = 243;
    public stepIndex: number = 0;

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

        this.shapeSplittingRound(data);
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

    // ─────────────────────────────────────────────────────────────────────
    // Splitting Symbols round shaping (see the note above the fields).
    // ─────────────────────────────────────────────────────────────────────

    private shapeSplittingRound(data: IFlowStateServerResponse): void {
        const message: Record<string, any> | undefined = (data as any).GameMessage;
        if (!message || !message.Game || typeof message.Game !== 'object') return;
        const game: Record<string, any> = this.realGame || {};
        const base: Record<string, any> = game.GameResult || {};
        const free: Record<string, any> | null = game.BonusRound || null;
        const outcomes: Record<string, any>[] = Array.isArray(base.Outcomes) ? base.Outcomes : [];
        const settings: Record<string, any> = (data as any).GameSettings || {};
        const complete = message.GameComplete === true;
        const resumed = data.RequestType === 'Resume';

        if (outcomes.length > 0) {
            this.roundInfo = this.splittingRoundInfo(base, complete, settings.Symbols);
        } else {
            this.roundInfo = Object.assign({}, this.roundInfo, { GameComplete: complete, Payout: this.payout });
        }
        if (free) {
            this.shapeSplittingFreeSpin(free, resumed);
            return;
        }
        if (outcomes.length === 0) return;

        const details: Record<string, any>[] = Array.isArray(base.SplitSymbolDetails) ? base.SplitSymbolDetails : [];
        const detail: Record<string, any> | undefined = details[0];
        const selections = new Map<number, number>();
        if (detail && Number(detail.Split) > 0) selections.set(Number(detail.Symbol), Number(detail.Split));
        const firstBoard = this.splittingBoard(outcomes[0].DisplayReels);
        this.hotspot = this.splittingHotspot(firstBoard, detail);
        this.steps = this.splittingSteps(outcomes, selections, 0, -1, this.hotspot);
        this.reelSymbols = resumed ? this.splittingBoard(outcomes[outcomes.length - 1].DisplayReels) : firstBoard;
        this.teaseBonus = !resumed && this.splittingCount(firstBoard, 1) === 2;
        const freeSpins = Number(this.roundInfo.FreeSpins) || 0;
        this.bonusSpin = {
            Number: 0,
            Total: freeSpins,
            Remaining: freeSpins,
            Grid: [],
            HotspotReel: 0,
            Selections: [],
            SelectionCount: 0,
            Steps: [],
            CascadeCount: 0,
            SpinWin: 0,
            TotalBonusPayout: 0,
            AccumulatedWin: freeSpins > 0 ? this.payout : 0,
            Clamped: false,
        };
    }

    private splittingRoundInfo(base: Record<string, any>, complete: boolean, symbols: any): Record<string, any> {
        const scatter: Record<string, any> = base.ScatterResult || {};
        const count = Number(scatter.Count) || 0;
        const triggered = scatter.Bonus === true || base.Bonus === true;
        const tier = triggered ? Math.min(5, Math.max(3, count)) : 0;
        const positions: Record<string, any>[] = Array.isArray(scatter.Positions) ? scatter.Positions : [];
        return {
            BonusTier: tier,
            BonusCount: count,
            FreeSpins: tier > 0 ? this.splittingFreeSpins(symbols, tier) : 0,
            BonusPositions: positions.map((cell: Record<string, any>) => ({ Reel: Number(cell.Reel), Row: Number(cell.Row) })),
            ScatterAward: Number(scatter.Prize) || 0,
            WinAfterScatter: this.payout,
            GameComplete: complete,
            Payout: this.payout,
        };
    }

    /** Free spins for a BONUS count: the engine's table (the BONUS symbol's prizes) when it sends one, else the game's rules. */
    private splittingFreeSpins(symbols: any, tier: number): number {
        const entries: Record<string, any>[] = Array.isArray(symbols) ? symbols : [];
        for (const entry of entries) {
            if (!entry || !(entry.IsScatter === true || Number(entry.Symbol) === 1)) continue;
            const prizes: Record<string, any>[] = Array.isArray(entry.Prizes) ? entry.Prizes : [];
            for (const prize of prizes) {
                if (prize && Number(prize.Matched) === tier && Number(prize.NumberOfBonusSpins) > 0) return Number(prize.NumberOfBonusSpins);
            }
        }
        const rules: Record<string, number> = { '3': 4, '4': 5, '5': 5 };
        return rules[String(tier)] || 0;
    }

    private shapeSplittingFreeSpin(free: Record<string, any>, resumed: boolean): void {
        const outcomes: Record<string, any>[] = Array.isArray(free.Outcomes) ? free.Outcomes : [];
        const details: Record<string, any>[] = Array.isArray(free.SplitSymbolDetails) ? free.SplitSymbolDetails : [];
        const selections = new Map<number, number>();
        const picks: Record<string, any>[] = [];
        let hotspotReel = 0;
        for (let i = 0; i < details.length; i++) {
            const detail: Record<string, any> = details[i] || {};
            const cells: Record<string, any>[] = Array.isArray(detail.HighlightedPosition) ? detail.HighlightedPosition : [];
            if (i === 0 && cells.length > 0) hotspotReel = Number(cells[0].Reel) || 0;
            const symbol = Number(detail.Symbol);
            const multiple = Number(detail.Split) || 0;
            if (multiple <= 0 || selections.has(symbol)) continue;
            selections.set(symbol, multiple);
            picks.push({ Symbol: symbol, Name: this.splittingName(symbol), Variant: symbol + 10, Count: cells.length, Multiple: multiple, Badge: 'x' + multiple });
        }
        const spinWin = Number(free.BonusPayout) || 0;
        const steps = this.splittingSteps(outcomes, selections, Math.max(0, this.payout - spinWin), hotspotReel, null);
        const first = outcomes.length > 0 ? this.splittingBoard(outcomes[0].DisplayReels) : [];
        const last = steps.length > 0 ? steps[steps.length - 1] : null;
        const number = Number(free.Number) || 0;
        const remaining = Number(free.Remaining) || 0;
        this.steps = steps;
        this.reelSymbols = resumed && outcomes.length > 0 ? this.splittingBoard(outcomes[outcomes.length - 1].DisplayReels) : first;
        this.teaseBonus = false;
        this.bonusSpin = {
            Number: number,
            Total: number + remaining,
            Remaining: remaining,
            Grid: first,
            HotspotReel: hotspotReel,
            Selections: picks,
            SelectionCount: picks.length,
            Steps: steps,
            CascadeCount: Number(free.CascadeCount) || Math.max(0, outcomes.length - 1),
            SpinWin: spinWin,
            TotalBonusPayout: Number(free.TotalBonusPayout) || 0,
            AccumulatedWin: last ? last.AccumulatedWin : this.payout,
            Clamped: false,
        };
    }

    private splittingHotspot(board: number[][], detail: Record<string, any> | undefined): Record<string, any> {
        const none: Record<string, any> = { Found: false, Reel: 0, Row: 0, Symbol: 0, Name: '', Variant: 0, Multiple: 1, Badge: '' };
        if (!detail || !(Number(detail.Split) > 0)) return none;
        const symbol = Number(detail.Symbol);
        const multiple = Number(detail.Split);
        let reel = -1;
        let row = -1;
        const cells: Record<string, any>[] = Array.isArray(detail.HighlightedPosition) ? detail.HighlightedPosition : [];
        for (const cell of cells) {
            const r = Number(cell.Reel);
            const w = Number(cell.Row);
            if (reel < 0 && board[r] && board[r][w] === symbol) {
                reel = r;
                row = w;
            }
        }
        for (let r = 0; reel < 0 && r < board.length; r++) {
            for (let w = 0; reel < 0 && w < board[r].length; w++) {
                if (board[r][w] === symbol) {
                    reel = r;
                    row = w;
                }
            }
        }
        if (reel < 0) return none;
        return { Found: true, Reel: reel, Row: row, Symbol: symbol, Name: this.splittingName(symbol), Variant: symbol + 10, Multiple: multiple, Badge: 'x' + multiple };
    }

    private splittingSteps(outcomes: Record<string, any>[], selections: Map<number, number>, start: number, hotspotReel: number, hotspot: Record<string, any> | null): Record<string, any>[] {
        const isSplit = (symbol: number): boolean => symbol !== 1 && selections.has(symbol);
        const multipleOf = (symbol: number): number => (isSplit(symbol) ? Number(selections.get(symbol)) : 1);
        const steps: Record<string, any>[] = [];
        let total = start;
        let dropped: string[] | null = null;
        for (let index = 0; index < outcomes.length; index++) {
            const outcome: Record<string, any> = outcomes[index] || {};
            const board = this.splittingBoard(outcome.DisplayReels);
            const splitCells: Record<string, any>[] = [];
            board.forEach((column: number[], reel: number) => column.forEach((symbol: number, row: number) => {
                if (!isSplit(symbol)) return;
                const multiple = multipleOf(symbol);
                splitCells.push({ Reel: reel, Row: row, Symbol: symbol, Variant: symbol + 10, Multiple: multiple, Badge: 'x' + multiple });
            }));
            let fresh: Record<string, any>[];
            if (dropped === null && hotspotReel >= 0) {
                fresh = splitCells.filter((cell) => cell.Reel === hotspotReel).concat(splitCells.filter((cell) => cell.Reel !== hotspotReel));
            } else if (dropped === null) {
                fresh = splitCells.filter((cell) => !(hotspot && hotspot.Found && cell.Reel === hotspot.Reel && cell.Row === hotspot.Row));
            } else {
                const landed: string[] = dropped;
                fresh = splitCells.filter((cell) => landed.indexOf(cell.Reel + ':' + cell.Row) >= 0);
            }
            const results: Record<string, any>[] = Array.isArray(outcome.Results) ? outcome.Results : [];
            const won: string[] = [];
            const winPositions: Record<string, any>[] = [];
            for (const result of results) {
                const positions: Record<string, any>[] = result && Array.isArray(result.Positions) ? result.Positions : [];
                for (const position of positions) {
                    const reel = Number(position.Reel);
                    const row = Number(position.Row);
                    const key = reel + ':' + row;
                    if (reel < 0 || reel >= board.length || won.indexOf(key) >= 0) continue;
                    won.push(key);
                    winPositions.push({ Reel: reel, Row: row });
                }
            }
            winPositions.sort((a, b) => a.Reel - b.Reel || a.Row - b.Row);
            let ways = board.length > 0 ? 1 : 0;
            for (const column of board) {
                let copies = 0;
                for (const symbol of column) copies += multipleOf(symbol);
                ways *= copies;
            }
            const prize = Number(outcome.Prize) || 0;
            total += prize;
            const step: Record<string, any> = {
                Index: index,
                Grid: board.map((column: number[]) => column.map((symbol: number) => (isSplit(symbol) ? symbol + 10 : symbol))),
                SymbolGrid: board.map((column: number[]) => column.slice()),
                SplitCells: splitCells,
                NewSplitCells: fresh,
                NewSplitCount: fresh.length,
                WaysTotal: typeof outcome.WinWays === 'number' ? outcome.WinWays : ways,
                WinPositions: winPositions,
                WinCount: results.length,
                StepWin: prize,
                AccumulatedWin: total,
                Clamped: false,
                HasCascade: false,
                ClearLocations: [],
                CascadeGrid: [],
                CascadeBadges: [],
            };
            dropped = [];
            const next: Record<string, any> | undefined = outcomes[index + 1];
            if (next) {
                const landed: string[] = [];
                const badges: Record<string, any>[] = [];
                const cleared = board.map((column: number[], reel: number) => column.map((symbol: number, row: number) => row).filter((row: number) => won.indexOf(reel + ':' + row) >= 0));
                const cascadeGrid = this.splittingBoard(next.DisplayReels).map((column: number[], reel: number) => column.map((symbol: number, row: number) => {
                    if (row < (cleared[reel] ? cleared[reel].length : 0)) {
                        landed.push(reel + ':' + row);
                        return symbol;
                    }
                    if (!isSplit(symbol)) return symbol;
                    badges.push({ Reel: reel, Row: row, Badge: 'x' + multipleOf(symbol) });
                    return symbol + 10;
                }));
                step.HasCascade = true;
                step.ClearLocations = cleared;
                step.CascadeGrid = cascadeGrid;
                step.CascadeBadges = badges;
                dropped = landed;
            }
            steps.push(step);
        }
        return steps;
    }

    private splittingBoard(raw: any): number[][] {
        if (!Array.isArray(raw)) return [];
        return raw.map((column: any) => (Array.isArray(column) ? column.map((symbol: any) => Number(symbol)) : []));
    }

    private splittingCount(board: number[][], symbol: number): number {
        let count = 0;
        for (const column of board) {
            for (const cell of column) {
                if (cell === symbol) count++;
            }
        }
        return count;
    }

    private splittingName(symbol: number): string {
        const names = ['', 'BONUS', 'WILD', 'HP1', 'HP2', 'MP1', 'MP2', 'LP1', 'LP2', 'LP3', 'LP4', 'LP5'];
        return names[symbol] || '';
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
