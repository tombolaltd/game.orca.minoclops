// Ported from Libraries/Tombola.B2B.Arcade/CancelBetHandler/{CancelBetHandlerBaseV3,UKCancelBetHandler}.cs

import { ArcadeResultCode } from '../core/ArcadeResultCode';
import { ICancelBetHandler, IGameContext } from '../core/interfaces';
import { setBalancesFromGepResponse } from '../core/models/BaseArcadeResponse';
import { GesData } from '../core/models/GameInternalData';
import { PlayMode } from '../core/models/enums';
import { MockWallet, walletTargetForPlayMode } from './MockWallet';

export class MockCancelBetHandler implements ICancelBetHandler {
    constructor(
        private readonly context: IGameContext,
        readonly wallet: MockWallet = new MockWallet(),
    ) {}

    async cancelBet(originalBetTransactionId: string): Promise<void> {
        const request = this.context.request;
        const response = this.context.response;

        const refundAmount = GesData.betAmount(request.PlayMode, request.Stake, request.FreeplaysUsed);
        const freePlays = request.PlayMode === PlayMode.FreePlay ? request.FreeplaysUsed : 0;
        this.wallet.refund(originalBetTransactionId, refundAmount.Value, walletTargetForPlayMode(request.PlayMode), freePlays);

        // Mirrors CancelBetHandlerBaseV3.ProcessResponseStatusCodeForCancel on the success branch.
        if (response.ResultCode === ArcadeResultCode.Success || response.ResultCode === ArcadeResultCode.ShouldCancelBet)
            response.ResultCode = ArcadeResultCode.BetCancelledWithGep;

        response.PlayState.BetCancelled = true;
        response.GameMessage = undefined;

        setBalancesFromGepResponse(response.PlayerData, this.wallet.snapshot(), request.PlayMode, request.Stake, 0);
        response.PlayerData.CurrencyCode = this.wallet.currencyCode;
    }
}
