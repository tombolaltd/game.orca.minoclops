// Ported from Libraries/Tombola.B2B.Arcade/PlaceBetHandler/{PlaceBetHandlerBaseV3,UKPlaceBetHandler,ITPlaceBetHandler}.cs
// The V3 shape is the live one: build ONE bet amount for the play mode, send it, then assign balances back.

import { ArcadeResultCode } from '../core/ArcadeResultCode';
import { IGameContext, IPlaceBetHandler } from '../core/interfaces';
import { setBalancesFromGepResponse } from '../core/models/BaseArcadeResponse';
import { GesData } from '../core/models/GameInternalData';
import { PlayMode, TransactionActionCode } from '../core/models/enums';
import { MockWallet } from './MockWallet';

export class MockPlaceBetHandler implements IPlaceBetHandler {
    constructor(
        private readonly context: IGameContext,
        readonly wallet: MockWallet = new MockWallet(),
    ) {}

    async placeBet(): Promise<void> {
        const request = this.context.request;
        const response = this.context.response;

        // Throws for UnauthDemo, exactly as the C# does — demo play never reaches place bet.
        const betAmount = GesData.betAmount(request.PlayMode, request.Stake, request.FreeplaysUsed);

        if (!this.tryDebit(betAmount.Value)) {
            // Mirrors ITPlaceBetHandler mapping DBOXError.InvalidBetAmount onto BalanceTooLow.
            response.ResultCode = ArcadeResultCode.BalanceTooLow;
            return;
        }

        this.assignPlaceBetResponseToGameContext();
    }

    private tryDebit(amount: number): boolean {
        const request = this.context.request;
        const gesData = this.context.internalData.GesData;

        if (request.PlayMode === PlayMode.FreePlay)
            return this.wallet.debitFreePlays(gesData.TransactionIdBuyIn, request.FreeplaysUsed, amount);

        const movement = this.wallet.debit(
            gesData.TransactionIdBuyIn,
            amount,
            TransactionActionCode.BuyIn,
            request.PlayMode === PlayMode.FunBonus ? 'bonus' : 'bonusFirst',
        );

        // UKPlaceBetHandler reads this straight off the GEP response's BonusAmount.
        if (movement.ok) gesData.BonusWalletSpend = movement.bonusAmount;
        return movement.ok;
    }

    /** Mirrors UKPlaceBetHandler.AssignPlaceBetResponseToGameContext. */
    private assignPlaceBetResponseToGameContext(): void {
        const request = this.context.request;
        const response = this.context.response;
        const gameMessage = response.GameMessage;

        setBalancesFromGepResponse(
            response.PlayerData,
            this.wallet.snapshot(),
            request.PlayMode,
            request.Stake,
            gameMessage?.Payout ?? 0,
            gameMessage?.GameComplete ?? true,
        );

        response.PlayerData.CurrencyCode = this.wallet.currencyCode;
    }
}
