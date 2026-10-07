// Ported from Libraries/Tombola.B2B.Arcade/GameSessionHandlers/{SessionHandlerBaseV3,UKSessionHandler}.cs
// MOCK: GEP auth/exchange collapses into a locally-held MockSessionConfig — there is no session manager here.

import { ArcadeResultCode } from '../core/ArcadeResultCode';
import { IGameContext, IGameSessionHandler } from '../core/interfaces';
import { setBalancesFromGepResponse } from '../core/models/BaseArcadeResponse';
import { newGameId, newGuid } from '../core/models/GameInternalData';
import { MockWallet } from '../wallet/MockWallet';

/** The fields GEP would have returned from auth + exchange. */
export interface MockSessionConfig {
    username: string;
    nickname: string;
    gsUserId: number;
    currencyCode: string;
    /** The RtpCode GEP returns, which becomes GesData.GameVersion and drives setSettings(). */
    gameVersion: string;
    minStakeAmount?: number;
    maxStakeAmount?: number;
    allowAutoplay?: boolean;
    gamingSessionToken: string;
    networkSessionToken: string;
    authToken: string;
    gameId: string;
    /** Forces the InvalidSession path so the refresh flow stays exercisable. */
    currentSessionIsInvalid: boolean;
    needsNicknameToBeSet: boolean;
}

export function createDefaultSessionConfig(overrides: Partial<MockSessionConfig> = {}): MockSessionConfig {
    return {
        username: 'MockPlayer',
        nickname: 'MockPlayer',
        gsUserId: 1,
        currencyCode: 'GBP',
        gameVersion: '95.00',
        minStakeAmount: undefined,
        maxStakeAmount: undefined,
        allowAutoplay: true,
        gamingSessionToken: newGuid(),
        networkSessionToken: newGuid(),
        authToken: newGuid(),
        gameId: newGameId(),
        currentSessionIsInvalid: false,
        needsNicknameToBeSet: false,
        ...overrides,
    };
}

export class MockGameSessionHandler implements IGameSessionHandler {
    readonly config: MockSessionConfig;

    constructor(
        private readonly context: IGameContext,
        readonly wallet: MockWallet = new MockWallet(),
        config: Partial<MockSessionConfig> = {},
    ) {
        this.config = createDefaultSessionConfig(config);
    }

    async authorize(): Promise<void> {
        const response = this.context.response;

        if (this.config.authToken.trim().length === 0) {
            response.ResultCode = ArcadeResultCode.NoAuthToken;
            return;
        }

        if (this.config.gameVersion.trim().length === 0) {
            response.ResultCode = ArcadeResultCode.VersionGepError;
            return;
        }

        if (this.config.needsNicknameToBeSet) {
            this.context.internalData.GesData.NeedsNicknameToBeSet = true;
            return;
        }

        if (!this.tryAssignCurrencyCode(this.config.currencyCode)) return;

        this.assignSessionToGesData();

        response.Tokens = response.Tokens ?? { GamingSessionToken: '' };
        response.Tokens.GamingSessionToken = this.config.gamingSessionToken;
        response.PlayerData.Username = this.config.nickname;

        this.assignBalances();
    }

    async exchangeAndAssignToContext(gamingSessionToken?: string): Promise<void> {
        const response = this.context.response;
        const gesData = this.context.internalData.GesData;

        // Mirrors UKSessionHandler.AssignExchangeResponseToGameContext's validation ladder.
        if (!Number.isInteger(this.config.gsUserId)) {
            response.ResultCode = ArcadeResultCode.GsUserIdGepError;
            return;
        }

        if (this.config.nickname.length === 0) {
            response.ResultCode = ArcadeResultCode.NicknameGepError;
            return;
        }

        if (this.config.gameVersion.length === 0) {
            response.ResultCode = ArcadeResultCode.VersionGepError;
            return;
        }

        if (!this.tryAssignCurrencyCode(this.config.currencyCode)) return;

        this.assignSessionToGesData();
        gesData.GamingSessionTokenFromStorage = gamingSessionToken ?? this.context.request.GamingSessionToken ?? this.config.gamingSessionToken;
        gesData.CurrentSessionIsInvalid = this.config.currentSessionIsInvalid;

        response.PlayerData.Username = this.config.nickname;

        if (this.config.currentSessionIsInvalid) response.ResultCode = ArcadeResultCode.InvalidSession;
    }

    // MOCK: the C# returns a GEP ExchangeTokenResponse; the mock hands back its own config snapshot.
    async exchange(gamingSessionToken?: string): Promise<unknown> {
        return {
            GsUserId: this.config.gsUserId,
            Nickname: this.config.nickname,
            RtpCode: this.config.gameVersion,
            Currency: this.config.currencyCode,
            AuthToken: this.config.authToken,
            NetworkSessionToken: this.config.networkSessionToken,
            GamingSessionToken: gamingSessionToken ?? this.config.gamingSessionToken,
            Invalid: this.config.currentSessionIsInvalid,
            GameConfiguration: {
                MinStakeAmount: this.config.minStakeAmount,
                MaxStakeAmount: this.config.maxStakeAmount,
                AllowAutoplay: this.config.allowAutoplay,
            },
        };
    }

    private assignSessionToGesData(): void {
        const gesData = this.context.internalData.GesData;

        gesData.NetworkSessionToken = this.config.networkSessionToken;
        gesData.AuthToken = this.config.authToken;
        gesData.GSUserId = this.config.gsUserId;
        gesData.Nickname = this.config.nickname;
        gesData.GameVersion = this.config.gameVersion;
        gesData.GameId = this.config.gameId;
        gesData.MinStakeAmount = this.config.minStakeAmount;
        gesData.MaxStakeAmount = this.config.maxStakeAmount;
        gesData.AllowAutoplay = this.config.allowAutoplay;
    }

    private assignBalances(): void {
        const request = this.context.request;
        const gameMessage = this.context.response.GameMessage;

        setBalancesFromGepResponse(
            this.context.response.PlayerData,
            this.wallet.snapshot(),
            request.PlayMode,
            request.Stake,
            gameMessage?.Payout ?? 0,
        );
    }

    /** Port of UKSessionHandler.TryAssignCurrencyCode. */
    private tryAssignCurrencyCode(currencyCode: string): boolean {
        const gesData = this.context.internalData.GesData;
        const playerData = this.context.response.PlayerData;

        if (currencyCode.length !== 3 || !/^[A-Za-z]{3}$/.test(currencyCode)) {
            gesData.CurrencyCode = '';
            playerData.CurrencyCode = '';
            this.context.response.ResultCode = ArcadeResultCode.CurrencyGepError;
            return false;
        }

        gesData.CurrencyCode = currencyCode;
        playerData.CurrencyCode = currencyCode;
        this.wallet.currencyCode = currencyCode;
        return true;
    }
}
