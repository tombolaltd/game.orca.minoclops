// Ported from Libraries/Tombola.B2B.Arcade/StorageHandlers/DefaultStorageHandler.cs
// and Libraries/Tombola.B2B.Arcade/Cache/ElastiCacheGameHandler.cs.
// MOCK: Redis and SQL Server both collapse into Maps. Expiries are wall-clock ms, standing in for TimeSpan.

import { ArcadeResultCode } from '../core/ArcadeResultCode';
import { BonusRoundDetails, IGameContext, IGameStorageHandler, IGameTicketHelper } from '../core/interfaces';
import { GameTicketDetails } from '../core/models/GameTicketDetails';
import { TransactionActionCode } from '../core/models/enums';

interface CacheEntry {
    value: string;
    expiresAt: number;
}

export interface StoredGame {
    gameId: string;
    gsUserId: number;
    skin: string;
    version: string;
    playMode: string;
    stake: number;
    ticketJson: string;
    complete: boolean;
    voided: boolean;
    forceClosed: boolean;
    startStamp: string;
    endStamp?: string;
}

export interface TransactionLogEntry {
    transactionId: string;
    gameId: string;
    gsUserId: number;
    actionCode: TransactionActionCode;
    stamp: string;
}

export interface InMemoryStorageConfig {
    cacheTickets?: boolean;
    skinSpecificResume?: boolean;
    /** Default cache TTL in ms, standing in for CacheConfig.DefaultExpiry. */
    defaultExpiry?: number;
    /** Starting balance for demo play, matching DefaultStorageHandler.CacheDemoBalance. */
    defaultDemoBalance?: number;
}

const DEMO_CACHE_EXPIRY = 10 * 60 * 1000;

export class InMemoryGameStorageHandler implements IGameStorageHandler {
    readonly cacheTickets: boolean;
    readonly skinSpecificResume: boolean;

    /** Keyed by gameId; the SQL games table. */
    readonly games = new Map<string, StoredGame>();
    readonly transactionLog: TransactionLogEntry[] = [];
    /** territory:operator:mechanic:skin -> version. Seed it to exercise the demo flow. */
    readonly demoVersions = new Map<string, string>();

    private readonly gameCache = new Map<string, CacheEntry>();
    private readonly demoGameCache = new Map<string, CacheEntry>();
    private readonly demoBalances = new Map<string, CacheEntry>();
    private readonly purchaseBlocks = new Map<number, number>();

    private readonly defaultExpiry: number;
    private readonly defaultDemoBalance: number;

    constructor(
        private readonly context: IGameContext,
        config: InMemoryStorageConfig = {},
    ) {
        this.cacheTickets = config.cacheTickets ?? false;
        this.skinSpecificResume = config.skinSpecificResume ?? false;
        this.defaultExpiry = config.defaultExpiry ?? 30 * 60 * 1000;
        this.defaultDemoBalance = config.defaultDemoBalance ?? 100000;
    }

    // ---------------------------------------------------------------- core game data

    // MOCK: the C# routes these through a per-flow-type storage extension; the default returns true.
    async beforeBeginLogicAsync(): Promise<boolean> {
        return true;
    }

    async beforeResumeLoadAsync(): Promise<boolean> {
        return true;
    }

    async getGameInPlay(): Promise<void> {
        const found = this.cacheTickets ? await this.doesGameExistInCache() : this.findRecentGame() !== undefined;
        if (found) this.context.response.ResultCode = ArcadeResultCode.GameInPlay;
    }

    async storeNewGame(): Promise<boolean> {
        const request = this.context.request;
        const gesData = this.context.internalData.GesData;

        this.games.set(gesData.GameId, {
            gameId: gesData.GameId,
            gsUserId: gesData.GSUserId,
            skin: this.getDBSkinName(),
            version: gesData.GameVersion,
            playMode: String(request.PlayMode),
            stake: request.Stake,
            ticketJson: this.serialiseTicket(),
            complete: this.context.response.GameMessage?.GameComplete ?? true,
            voided: false,
            forceClosed: false,
            startStamp: new Date().toISOString(),
        });

        return true;
    }

    async continueGame(): Promise<boolean> {
        const gesData = this.context.internalData.GesData;
        const stored = this.games.get(gesData.GameId);
        if (stored === undefined) {
            this.context.response.ResultCode = ArcadeResultCode.GameNotFound;
            return false;
        }

        stored.ticketJson = this.serialiseTicket();
        stored.complete = this.context.response.GameMessage?.GameComplete ?? stored.complete;
        if (stored.complete) stored.endStamp = new Date().toISOString();
        return true;
    }

    async getRecentGameFromDatabase(): Promise<boolean> {
        const stored = this.findRecentGame();
        if (stored === undefined) {
            // Port of DBGetGameRecent's "no @GameId" branch: a player with no
            // previous game is a NEW player, not an error. The result code is
            // left alone so resume goes on to initialise settings from the
            // session's game version (continue reports GameNotFound itself).
            // Setting GameNotFound here made a fresh mock session's first resume
            // come back without GameSettings, which the client refuses to boot on.
            const playerData = this.context.response.PlayerData;
            playerData.NewPlayer = true;
            this.context.response.GameMessage = undefined;
            if (this.context.stakeOptions.length > 0) playerData.PreviousStake = Math.min(...this.context.stakeOptions);
            return false;
        }

        return this.hydrateFromStoredGame(stored);
    }

    async getGameByIdFromDatabase(): Promise<boolean> {
        const stored = this.games.get(this.context.request.GameId);
        if (stored === undefined) {
            this.context.response.ResultCode = ArcadeResultCode.GameNotFound;
            return false;
        }

        return this.hydrateFromStoredGame(stored);
    }

    // MOCK: there is no users table; the session handler already put the player on GesData.
    async getUserFromDatabase(): Promise<boolean> {
        return true;
    }

    /** Mirrors DefaultStorageHandler: no parent game name means nothing to insert. */
    async insertGameInGameParentGameAsync(): Promise<boolean> {
        const parentGame = this.context.request.Parent?.gameName;
        return parentGame !== undefined && parentGame.trim().length > 0;
    }

    // MOCK: the C# runs post-award bookkeeping through the flow-type storage extension.
    async afterAwardPrizeAsync(): Promise<void> {
        /* no-op */
    }

    async voidGameInDatabase(setContextResultCode = true): Promise<boolean> {
        const gesData = this.context.internalData.GesData;
        const stored = this.games.get(gesData.GameId);
        if (stored === undefined) {
            if (setContextResultCode) this.context.response.ResultCode = ArcadeResultCode.GameNotFound;
            return false;
        }

        stored.voided = true;
        stored.complete = true;
        stored.endStamp = new Date().toISOString();
        await this.appendToTransactionLogAsync(gesData.TransactionIdBuyIn, TransactionActionCode.Void, setContextResultCode);
        return true;
    }

    async forceCloseIncompleteGame(): Promise<boolean> {
        const gesData = this.context.internalData.GesData;
        const stored = this.games.get(gesData.GameId) ?? this.findRecentGame();
        if (stored === undefined) {
            this.context.response.ResultCode = ArcadeResultCode.CouldNotProcessIncomplete;
            return false;
        }

        stored.forceClosed = true;
        stored.complete = true;
        stored.endStamp = new Date().toISOString();
        this.context.internalData.ForceClosed = true;
        await this.appendToTransactionLogAsync(gesData.TransactionIdBuyIn, TransactionActionCode.ForceClosed, false);
        return true;
    }

    async appendToTransactionLogAsync(transactionId: string, actionCode: TransactionActionCode, setContextResultCode = true): Promise<boolean> {
        void setContextResultCode; // MOCK: an in-memory append cannot fail, so no result code is ever set.

        const gesData = this.context.internalData.GesData;
        this.transactionLog.push({
            transactionId,
            gameId: gesData.GameId,
            gsUserId: gesData.GSUserId,
            actionCode,
            stamp: new Date().toISOString(),
        });
        return true;
    }

    // ---------------------------------------------------------------- cache

    async getGameFromCacheOrDatabase(): Promise<boolean> {
        if (this.context.shouldCacheTickets) {
            const cachedJson = this.readCache(this.gameCache, this.gameCacheKey());
            if (cachedJson !== undefined) {
                this.context.ticketDetails = this.deserialiseCachedTicket(cachedJson);
                this.context.internalData.GesData.GameId = this.context.ticketDetails.GameIdGuid;
                this.context.internalData.GesData.GamingSessionTokenFromStorage = this.context.ticketDetails.GamingSessionToken;
                this.context.setSettings(this.context.ticketDetails.Version);
                return true;
            }
        }

        return this.getRecentGameFromDatabase();
    }

    async cacheIncompleteGame(preserveExistingTtl = false): Promise<void> {
        if (this.context.response.GameMessage?.GameComplete === true) return;
        if (!this.context.shouldCacheTickets) return;

        const key = this.gameCacheKey();
        const expiresAt = preserveExistingTtl ? (this.gameCache.get(key)?.expiresAt ?? Date.now() + this.defaultExpiry) : Date.now() + this.defaultExpiry;
        this.gameCache.set(key, { value: this.serialiseTicket(), expiresAt });
    }

    async invalidateGameCache(): Promise<void> {
        this.gameCache.delete(this.gameCacheKey());
    }

    async deleteCachedGame(): Promise<void> {
        await this.invalidateGameCache();
    }

    async doesGameExistInCache(): Promise<boolean> {
        return this.readCache(this.gameCache, this.gameCacheKey()) !== undefined;
    }

    // MOCK: closes the cached unfinished game so a new buy-in can start (see beginGame).
    async abandonUnfinishedGame(): Promise<void> {
        const cachedJson = this.readCache(this.gameCache, this.gameCacheKey());
        if (cachedJson !== undefined) {
            const stored = this.games.get(this.deserialiseCachedTicket(cachedJson).GameIdGuid);
            if (stored !== undefined && !stored.complete) {
                stored.complete = true;
                stored.forceClosed = true;
                stored.endStamp = new Date().toISOString();
            }
        }
        await this.invalidateGameCache();
    }

    // ---------------------------------------------------------------- demo cache

    async cacheDemoBalance(): Promise<void> {
        const token = this.getGamingSessionToken();
        if (token === undefined) return;

        const request = this.context.request;
        const payout = this.context.response.GameMessage?.Payout ?? 0;
        const cached = this.readCache(this.demoBalances, token);
        const previous = cached === undefined ? this.defaultDemoBalance : Number(cached);

        let newBalance = previous - request.Stake + payout;
        if (newBalance < 0) newBalance = this.defaultDemoBalance;

        this.demoBalances.set(token, { value: String(newBalance), expiresAt: Date.now() + DEMO_CACHE_EXPIRY });

        const playerData = this.context.response.PlayerData;
        playerData.PreStakeBalance = newBalance - payout + request.Stake;
        playerData.StartBalance = newBalance - payout;
        playerData.EndBalance = newBalance;
    }

    async checkIfDemoSessionExists(): Promise<boolean> {
        const token = this.getGamingSessionToken();
        if (token === undefined) return false;
        return this.readCache(this.demoBalances, token) !== undefined;
    }

    async getDemoGameFromCache(): Promise<boolean> {
        const token = this.getGamingSessionToken();
        if (token === undefined) return false;

        const cachedJson = this.readCache(this.demoGameCache, this.demoGameCacheKey(token));
        if (cachedJson === undefined) return false;

        this.context.ticketDetails = this.deserialiseCachedTicket(cachedJson);
        this.context.setSettings(this.context.ticketDetails.Version);
        return true;
    }

    async cacheIncompleteDemoGame(): Promise<void> {
        if (this.context.response.GameMessage?.GameComplete === true) return;
        if (!this.context.shouldCacheTickets) return;

        const token = this.getGamingSessionToken();
        if (token === undefined) return;

        this.demoGameCache.set(this.demoGameCacheKey(token), { value: this.serialiseTicket(), expiresAt: Date.now() + DEMO_CACHE_EXPIRY });
    }

    async deleteDemoGameFromCache(): Promise<void> {
        if (!this.context.shouldCacheTickets) return;

        const token = this.getGamingSessionToken();
        if (token === undefined) return;

        this.demoGameCache.delete(this.demoGameCacheKey(token));
    }

    async getDemoVersionAsync(territoryCode: string, operatorId: string, mechanic: string, skin: string): Promise<string | undefined> {
        return this.demoVersions.get(`${territoryCode}:${operatorId}:${mechanic}:${skin}`);
    }

    // ---------------------------------------------------------------- purchase blocking

    async trySetPurchaseBlockAsync(gsUserId: number, expiry: number): Promise<boolean> {
        if (expiry <= 0) return true;

        const existing = this.purchaseBlocks.get(gsUserId);
        if (existing !== undefined && existing > Date.now()) return false;

        this.purchaseBlocks.set(gsUserId, Date.now() + expiry);
        return true;
    }

    async setPurchaseBlockExpiryAsync(gsUserId: number, expiry: number): Promise<void> {
        if (expiry <= 0) return;
        this.purchaseBlocks.set(gsUserId, Date.now() + expiry);
    }

    async deletePurchaseBlockAsync(gsUserId: number): Promise<void> {
        this.purchaseBlocks.delete(gsUserId);
    }

    // MOCK: all three are already commented-out no-ops in DefaultStorageHandler.
    async checkMultiplePurchaseStatus(): Promise<void> {
        /* no-op */
    }

    async checkAwardedFreeplays(): Promise<void> {
        /* no-op */
    }

    async checkSessionCache(): Promise<void> {
        /* no-op */
    }

    // ---------------------------------------------------------------- tickets

    setJackpotTicketDetails(dbJackpotTicket: string): void {
        const jackpot = this.context.response.Jackpot;
        if (jackpot === undefined || dbJackpotTicket.length === 0) return;

        // MOCK: the C# rebuilds gem layouts from jackpot settings; the mock stores whatever was serialised.
        try {
            jackpot.WinningTicket = { GemLayouts: JSON.parse(dbJackpotTicket) as number[][][] };
        } catch {
            this.context.loggingService.logWarning('Jackpot ticket could not be parsed');
        }
    }

    setPreviousGameState(resultCode: ArcadeResultCode, dbTicket: Uint8Array): void {
        const helper = this.ticketHelper();
        if (helper === undefined) {
            this.context.response.ResultCode = resultCode;
            return;
        }

        helper.setPreviousGameState(resultCode, decodeLatin1(dbTicket));
    }

    setTicketFetcherDetails(): void {
        this.ticketHelper()?.setTicketFetcherDetails();
        this.context.response.Timestamps = this.context.internalData.Timestamps;
    }

    ticketToByteArray(): Uint8Array {
        return this.convertIntArrayToVarbinary(this.ticketHelper()?.prepareTicketForDatabase() ?? []);
    }

    bonusTicketToByteArray(): Uint8Array {
        return this.convertIntArrayToVarbinary(this.ticketHelper()?.prepareBonusTicketForDatabase() ?? []);
    }

    playerChoiceToByteArray(): Uint8Array {
        return this.convertIntArrayToVarbinary(this.ticketHelper()?.preparePlayerChoicesForDatabase() ?? []);
    }

    /** Port of DefaultStorageHandler.ConvertFromVarbinaryToIntArray — the bytes hold little-endian ushorts. */
    convertFromVarbinaryToIntArray(input: Uint8Array): number[] {
        if (input == null || input.length === 0) return [];
        if (input.length % 2 !== 0) throw new Error('Invalid byte array length. Expected a multiple of 2 bytes.');

        const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
        const result: number[] = [];
        for (let i = 0; i < input.length; i += 2) result.push(view.getUint16(i, true));
        return result;
    }

    convertIntArrayToVarbinary(array: number[]): Uint8Array {
        if (array == null || array.length === 0) return new Uint8Array(0);
        for (const value of array)
            if (!Number.isInteger(value) || value < 0 || value > 0xffff)
                throw new RangeError(`One or more values in the array cannot be converted to ushort. Valid range: 0 to 65535`);

        const bytes = new Uint8Array(array.length * 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < array.length; i++) view.setUint16(i * 2, array[i], true);
        return bytes;
    }

    deserialiseCachedTicket(cachedTicketJSON: string): GameTicketDetails {
        const helper = this.ticketHelper();
        if (helper !== undefined) return helper.deserialiseCachedTicket(cachedTicketJSON);

        // MOCK: the C# returns an empty ticket here; a prototype is more useful with the real values back.
        return Object.assign(new GameTicketDetails(), JSON.parse(cachedTicketJSON) as Partial<GameTicketDetails>);
    }

    getBonusRoundDetails(): BonusRoundDetails[] {
        return this.ticketHelper()?.getBonusRoundDetails() ?? [];
    }

    // ---------------------------------------------------------------- utility

    getDBSkinName(): string {
        return String(this.context.request.Skin);
    }

    getDBResultCode(status: number): ArcadeResultCode {
        return status === -201 ? ArcadeResultCode.GameNotFound : ArcadeResultCode.DatabaseError;
    }

    // ---------------------------------------------------------------- internals

    private ticketHelper(): IGameTicketHelper | undefined {
        return this.context.ticketHelper as IGameTicketHelper | undefined;
    }

    private serialiseTicket(): string {
        const helper = this.ticketHelper();
        return helper !== undefined ? helper.serialiseCachedTicket(this.context.ticketDetails) : JSON.stringify(this.context.ticketDetails);
    }

    private gameCacheKey(): string {
        return `PreviousGame:${this.getDBSkinName()}:${this.context.internalData.GesData.GSUserId}`;
    }

    private demoGameCacheKey(gamingSessionToken: string): string {
        return `PreviousGame:demo.${this.getDBSkinName()}:${gamingSessionToken}`;
    }

    /** Port of GetGamingSessionTokenAsGuid, minus the Guid parse — the mock accepts any non-empty token. */
    private getGamingSessionToken(): string | undefined {
        const token = this.context.response.Tokens?.GamingSessionToken;
        if (token === undefined || token.trim().length === 0) {
            this.context.response.ResultCode = ArcadeResultCode.DemoGameNotFound;
            return undefined;
        }
        return token;
    }

    private findRecentGame(): StoredGame | undefined {
        const skin = this.getDBSkinName();
        const gsUserId = this.context.internalData.GesData.GSUserId;

        let recent: StoredGame | undefined;
        for (const stored of this.games.values()) {
            if (stored.gsUserId !== gsUserId) continue;
            if (this.skinSpecificResume && stored.skin !== skin) continue;
            if (stored.voided) continue;
            if (recent === undefined || stored.startStamp >= recent.startStamp) recent = stored;
        }
        return recent;
    }

    private hydrateFromStoredGame(stored: StoredGame): boolean {
        this.context.ticketDetails = this.deserialiseCachedTicket(stored.ticketJson);
        this.context.internalData.GesData.GameId = stored.gameId;
        this.context.internalData.GesData.GamingSessionTokenFromStorage = this.context.ticketDetails.GamingSessionToken;
        this.context.setSettings(stored.version);
        return true;
    }

    private readCache(cache: Map<string, CacheEntry>, key: string): string | undefined {
        const entry = cache.get(key);
        if (entry === undefined) return undefined;
        if (entry.expiresAt <= Date.now()) {
            cache.delete(key);
            return undefined;
        }
        return entry.value;
    }
}

/** The mock stores ticket JSON, so a varbinary round-trip is a byte-per-char decode. */
function decodeLatin1(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i++) result += String.fromCharCode(bytes[i]);
    return result;
}
