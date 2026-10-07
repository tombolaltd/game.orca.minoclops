// Ported from Libraries/Tombola.B2B.Arcade/Models/BaseArcadeResponse.cs
// (+ GameSettings from Libraries/Tombola.B2B.Arcade/GameSettings/GameSettings.cs, which it references)

import { ArcadeResultCode } from '../ArcadeResultCode';
import { PlayMode, RequestType, SkinName } from './enums';
import { GameMessage } from './GameMessage';
import { Timestamps } from './GameInternalData';

// ArcadeB2B Game Settings
export class GameSettings {
    WinMultipliers: number[] = [];
    StakeOptions: number[] = [];
    DefaultStake = 0;
    Version = '';
    Rtp = 0;

    TotalRtp?: number;
}

// The base response for all games.
export interface BaseArcadeResponse {
    RequestType: RequestType;

    ResultCode: ArcadeResultCode;

    GameMessage?: GameMessage;

    ServiceDetails: ServiceDetails;

    PlayerData: PlayerData;
    PlayState: PlayState;

    RngStatus: RngStatus;
    DemoSettings?: DemoSettings;
    TimeKeeperLimit: TimeKeeperLimit;

    PromoDetails: PromoDetails[];

    Jackpot?: JackpotDetails;

    Timestamps?: Timestamps;

    GameSettings: GameSettings;

    Tokens?: Tokens;

    MiscInfo: string;

    OperatorMessaging?: OperatorMessaging;
}

// This class declares the various PlayerData details
export interface PlayerData {
    Username: string;
    /** Not always accurate (only calculated by current balance minus stake) */
    PreStakeBalance?: number;
    /** Current balance */
    StartBalance?: number;
    /** Post stake balance - for reveal at game end */
    EndBalance?: number;
    /** We should only ever need current free play balance as you balance can't increase from a game */
    FreePlayBalance?: number;
    FreePlayValue?: number;
    PreviousStake?: number;
    CurrencyCode: string;
    NewPlayer: boolean;
    RewardWallets: RewardWalletDetails[];
}

// MOCK: merges the V2 (FreeSpin) and V3 (Tokens) GEP balance shapes — there is no GEP behind the mock.
export interface Balance {
    Primary: number;
    Bonus: number;
    FreeSpin?: { Amount: number; BetAmount: number };
    Tokens?: { NumberOfUses: number; ValuePerUse: number };
}

// PlayerData.SetBalancesFromGepResponse, lifted out because the mock has no GEP response to hang it off.
export function setBalancesFromGepResponse(
    playerData: PlayerData,
    balance: Balance,
    playMode: PlayMode,
    stake: number,
    payout: number,
    gameComplete = true,
): void {
    const effectivePayout = gameComplete ? payout : 0;

    switch (playMode) {
        case PlayMode.Wallet:
        case PlayMode.FunBonus: {
            const newBalance = balance.Primary + balance.Bonus;
            playerData.PreStakeBalance = newBalance - effectivePayout + stake;
            playerData.StartBalance = newBalance - effectivePayout;
            playerData.EndBalance = newBalance;
            // MOCK: always report the free-play count. arcade-base stores the raw
            // value and its cabinet enters free play whenever it is `!== 0`, so an
            // OMITTED field (undefined) put every cash round into free play with
            // no stake, which begin then refused as "Unsupported bet amount".
            playerData.FreePlayBalance = balance.FreeSpin?.Amount ?? balance.Tokens?.NumberOfUses ?? 0;
            break;
        }
        case PlayMode.FreePlay:
            playerData.FreePlayBalance = balance.FreeSpin?.Amount ?? balance.Tokens?.NumberOfUses ?? 0;
            playerData.FreePlayValue = balance.FreeSpin?.BetAmount ?? balance.Tokens?.ValuePerUse ?? 0;
            break;
        default:
            throw new Error(`PlayMode ${playMode} is not supported for balance setting.`);
    }
}

export interface RewardWalletDetails {
    RewardId: string;
    RewardValue: number;
    RemainingQuantity: number;
    Expiry: string;
}

export interface PlayState {
    BalanceUpdateDelayed: boolean;
    BetCancelled: boolean;
    ShouldRefreshBeforeNextBuyIn: boolean;
    NeedsNicknameToBeSet: boolean;
    ShouldCloseGame: boolean;
}

export interface DemoSettings {
    Skin: SkinName;
    RemainingDemoGames: number;
    InPlayDemoBonusGame: StuckInDemoBonusRound;
    AllDemoGamesRemaining: AllRemainingDemoGames[];
}

export interface AllRemainingDemoGames {
    Skin: SkinName;
    RemainingDemoGames: number;
}

export interface StuckInDemoBonusRound {
    GameId: number;
    StartStamp: string;
    Skin: SkinName;
    Complete: boolean;
}

export interface TimeKeeperLimit {
    Value: number;
}

export interface ServiceDetails {
    ServiceB: string;
    ServiceA: string;
}

// This class defines the possible statuses of the RNG Queue
export class RngStatus {
    Description: string;

    constructor(description: string) {
        this.Description = description;
    }

    static readonly Success = new RngStatus('Success');
    static readonly LowQueue = new RngStatus('WARNING: Queue Low');
    static readonly EmptyQueue = new RngStatus('WARNING: Empty Queue');
}

// Class with promo details
export interface PromoDetails {
    PromoId: number;
    PromoNotification: boolean;
    QualifiedForPromo: boolean;
    PromoStartTime: string;
    PromoEndTime: string;
    TotalSpend: number;
    PromoTicketId: string;
}

export interface JackpotDetails {
    ConfigVersion?: number;
    CurrentPotValues: JackpotPotValue[];
    JackpotWin?: boolean;
    JackpotPrize?: number;
    WinningPot?: JackpotPotValue;
    WinningTicket?: JackpotTicket;
    WinningDetails?: JackpotWinDetails;
}

export interface JackpotWinDetails {
    ImmediateWin: boolean;
    PaidOut: boolean;
}

export interface JackpotPotValue {
    Tier: string;
    TierId: number;
    Ordering: number;
    CurrentValue: number;
    Rtp: number;
    BaseSeedValue?: number;
    ContributionPercent?: number;
    MustGoValue?: number;
    MustGoTime?: string;
    RecentWinnerUsername?: string;
    RecentWinnerPrize?: number;
    RecentWinnerStampUTC?: string;
}

export class JackpotTicket {
    GemLayouts: number[][][];

    constructor(layout: number[][][]) {
        this.GemLayouts = layout;
    }
}

export interface Tokens {
    GamingSessionToken: string;
}

export interface OperatorMessaging {
    MessageBody: string;
    MessageTitle: string;
}
