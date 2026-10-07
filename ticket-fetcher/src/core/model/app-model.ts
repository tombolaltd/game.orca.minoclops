import { container, formatCurrency, GameInfoData, IBaseAppModel, PlayMode } from '@arcade-client/base-ticketfetcher-package';
import { injectable } from 'inversify';
import { IGameServerResponse, IGameMessageEx, IGameSettingsEx } from '../../types';

@injectable()
export class AppModel implements IBaseAppModel {
    //* Core Specific *//
    public skin: string = '';
    public stake: number = 0;
    public gameId: number = 0;
    public payout: number = 0;
    public numberOfSliderPoints: number = 0;
    public highlightedSliderPoints: number[] = [];
    public winMultipliers: number[] = [];
    public isComplete: boolean = false;
    public playMode: PlayMode = 'Cash';
    public isClientFacing: boolean = false;

    //* Fetcher Specific *//
    // TODO: The results should be built based on the game server response, this varies from game to game
    public results: any[] = [];

    public infoData: GameInfoData[] = [];

    public setData(data: IGameServerResponse) {
        const gameMessage: IGameMessageEx = data.GameMessage;
        const gameSettings: IGameSettingsEx = data.GameSettings;

        this.playMode = gameMessage.PlayMode;
        this.skin = gameMessage.Skin.toLowerCase();
        this.stake = gameMessage.Stake === 0 ? 10 : gameMessage.Stake;
        this.gameId = gameMessage.GameId;
        this.payout = gameMessage.Payout;
        this.isComplete = gameMessage.GameComplete;
        this.winMultipliers = gameSettings.WinMultipliers;

        // Set this value to be the correct amount of points on the slider. 0 Will mean the slider isnt shown.
        this.numberOfSliderPoints = 0;

        // Set this value to be what points on the slider are highlighted to represent bonus rounds Empty Array will mean none are highlighted.
        this.highlightedSliderPoints = [];

        // Set Fetcher specific data here

        // Call setGameInfo which will build the array of items to be displayed in the Game Info section of the Info View.
        this.setGameInfo();
    }

    public setGameInfo(): void {
        this.infoData.push(
            {
                label: container.defaultStrings.gameInfo.gameId,
                value: this.gameId.toString()
            },
            {
                label: container.defaultStrings.gameInfo.stake.label,
                value: this.playMode === 'FreePlay' ? container.defaultStrings.gameInfo.stake.values.freePlay : formatCurrency(this.stake, container.currencySettings, false)
            },
            {
                label: container.defaultStrings.gameInfo.payout,
                value: formatCurrency(this.payout, container.currencySettings, false)
            },
            {
                label: container.defaultStrings.gameInfo.complete.label,
                value: this.isComplete ? container.defaultStrings.gameInfo.complete.values.true : container.defaultStrings.gameInfo.complete.values.false
            }
        );
    }

    // TODO: Any other functions to handle fetcher specific data
}
