// Ported from Libraries/Tombola.B2B.Arcade/AwardPrizeHandler/{AwardPrizeHandlerBaseV3,UKAwardPrizeHandler}.cs

import { IAwardPrizeHandler, IGameContext } from '../core/interfaces';
import { setBalancesFromGepResponse } from '../core/models/BaseArcadeResponse';
import { TransactionActionCode } from '../core/models/enums';
import { MockWallet, walletTargetForPlayMode } from './MockWallet';

export class MockAwardPrizeHandler implements IAwardPrizeHandler {
    constructor(
        private readonly context: IGameContext,
        readonly wallet: MockWallet = new MockWallet(),
    ) {}

    // MOCK: networkSessionToken only ever reached GEP, so it is accepted and ignored.
    async awardPrize(networkSessionToken?: string): Promise<void> {
        void networkSessionToken;

        const request = this.context.request;
        const response = this.context.response;
        const gesData = this.context.internalData.GesData;
        const gameMessage = response.GameMessage;

        gesData.AttemptedToAwardPrize = true;

        // The engine only settles a finished round; an incomplete game keeps its stake debited.
        if (gameMessage?.GameComplete !== true) return;

        const jackpotAmount = gesData.JackpotPrize > 0 ? gesData.JackpotPrize : 0;
        const totalAmount = gameMessage.Payout + jackpotAmount;

        if (totalAmount > 0)
            this.wallet.credit(gesData.TransactionIdWin, totalAmount, TransactionActionCode.EndWager, walletTargetForPlayMode(request.PlayMode));

        // Mirrors UKAwardPrizeHandler.AssignAwardPrizeResponseToGameContext.
        setBalancesFromGepResponse(response.PlayerData, this.wallet.snapshot(), request.PlayMode, request.Stake, totalAmount);
        response.PlayerData.CurrencyCode = this.wallet.currencyCode;
    }
}
