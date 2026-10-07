// MOCK: stands in for the GEP wallet the engine talks to via IGesManagerV3 (place bet / award prize /
// refund player). There is no C# counterpart — the engine never holds a balance itself.

import { Balance } from '../core/models/BaseArcadeResponse';
import { newGuid } from '../core/models/GameInternalData';
import { PlayMode, TransactionActionCode } from '../core/models/enums';

/** Where money is taken from, or put back. GEP spends the bonus wallet before the primary one. */
export type WalletSource = 'primary' | 'bonus' | 'bonusFirst';

export interface LedgerEntry {
    transactionId: string;
    action: TransactionActionCode;
    /** Signed: negative for a debit, positive for a credit or refund. */
    amount: number;
    balanceAfter: number;
    stamp: string;
}

export interface WalletMovement {
    ok: boolean;
    primaryAmount: number;
    bonusAmount: number;
}

export interface MockWalletConfig {
    balance?: number;
    bonusBalance?: number;
    freePlayBalance?: number;
    freePlayValue?: number;
    currencyCode?: string;
}

export class MockWallet {
    // Money is INTEGER MINOR UNITS (pence/cents) everywhere, exactly as the engine does it. Never floats.
    balance: number;
    bonusBalance: number;
    /** A COUNT of remaining free plays, not money. */
    freePlayBalance: number;
    /** The notional stake one free play is worth, in minor units. */
    freePlayValue: number;
    currencyCode: string;

    readonly ledger: LedgerEntry[] = [];

    constructor(config: MockWalletConfig = {}) {
        this.balance = config.balance ?? 10000; // £100.00
        this.bonusBalance = config.bonusBalance ?? 0;
        this.freePlayBalance = config.freePlayBalance ?? 0;
        this.freePlayValue = config.freePlayValue ?? 0;
        this.currencyCode = config.currencyCode ?? 'GBP';
    }

    get totalBalance(): number {
        return this.balance + this.bonusBalance;
    }

    debit(transactionId: string, amount: number, action: TransactionActionCode = TransactionActionCode.BuyIn, source: WalletSource = 'bonusFirst'): WalletMovement {
        assertMinorUnits(amount);

        const available = source === 'primary' ? this.balance : source === 'bonus' ? this.bonusBalance : this.totalBalance;
        if (amount > available) return { ok: false, primaryAmount: 0, bonusAmount: 0 };

        const bonusAmount = source === 'primary' ? 0 : Math.min(amount, this.bonusBalance);
        const primaryAmount = amount - bonusAmount;

        this.bonusBalance -= bonusAmount;
        this.balance -= primaryAmount;
        this.record(transactionId, action, -amount);

        return { ok: true, primaryAmount, bonusAmount };
    }

    /** FreePlay spends a play count, not money; the ledger still records the notional stake value. */
    debitFreePlays(transactionId: string, plays: number, notionalAmount: number, action: TransactionActionCode = TransactionActionCode.BuyIn): boolean {
        assertMinorUnits(notionalAmount);
        if (!Number.isInteger(plays) || plays <= 0) throw new RangeError(`plays must be a positive integer, got ${plays}`);
        if (plays > this.freePlayBalance) return false;

        this.freePlayBalance -= plays;
        this.record(transactionId, action, -notionalAmount);
        return true;
    }

    credit(transactionId: string, amount: number, action: TransactionActionCode = TransactionActionCode.EndWager, target: 'primary' | 'bonus' = 'primary'): void {
        assertMinorUnits(amount);

        if (target === 'bonus') this.bonusBalance += amount;
        else this.balance += amount;

        this.record(transactionId, action, amount);
    }

    // MOCK: the original debit's primary/bonus split is not tracked, so the caller states where the refund lands.
    refund(transactionId: string, amount: number, target: 'primary' | 'bonus' = 'primary', freePlays = 0): void {
        assertMinorUnits(amount);

        if (freePlays > 0) this.freePlayBalance += freePlays;
        else if (target === 'bonus') this.bonusBalance += amount;
        else this.balance += amount;

        this.record(transactionId, TransactionActionCode.GdsCancelApiSuccess, amount);
    }

    /** The GEP balance shape the response balance helper consumes. */
    snapshot(): Balance {
        return {
            Primary: this.balance,
            Bonus: this.bonusBalance,
            FreeSpin: { Amount: this.freePlayBalance, BetAmount: this.freePlayValue },
        };
    }

    private record(transactionId: string, action: TransactionActionCode, amount: number): void {
        this.ledger.push({
            transactionId: transactionId || newGuid(),
            action,
            amount,
            balanceAfter: this.totalBalance,
            stamp: new Date().toISOString(),
        });
    }
}

function assertMinorUnits(amount: number): void {
    if (!Number.isInteger(amount) || amount < 0) throw new RangeError(`Amounts are non-negative integer minor units, got ${amount}`);
}

/** Mirrors GesData.prizeAmounts' AmountType mapping: only PlayMode.Wallet moves REAL money. */
export function walletTargetForPlayMode(playMode: PlayMode): 'primary' | 'bonus' {
    return playMode === PlayMode.Wallet ? 'primary' : 'bonus';
}
