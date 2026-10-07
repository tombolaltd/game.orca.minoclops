// Ported from Libraries/Tombola.B2B.Arcade/Models/BaseArcadeRequest.cs
// (+ Models/GameInGameParentInfo.cs and Models/DebugJackpotData.cs, which it references)

import { PlayMode, SkinName } from './enums';

// Wire names are camelCase here because the C# record carries [JsonPropertyName] on every member.
export interface GameInGameParentInfo {
    gameId?: string;
    gameName?: string;
    gameCategory?: string;
    gameType?: string;
    gameSubType?: string;
    networkSessionToken?: string;
}

export interface DebugJackpotData {
    ForceWin: boolean;
    WinningPotTierId?: number;
}

// The base request for all games. It declares the variables needed for every game.
export interface BaseArcadeRequest {
    OperatorUserId: string;
    Stake: number;
    ClientTypeId: number;

    OperatorId: string;
    Language: string;

    SiteId: number;
    GameId: string;
    ApiKey: string;
    ApiVersion: string;
    Skin: SkinName;
    PlayMode: PlayMode;
    FreeplaysUsed: number;
    JackpotConfigVersion?: number;

    BingoParentGame: string;

    Parent?: GameInGameParentInfo;

    /** Begin data specific to a game type determined from the request. */
    BeginGameData: unknown;

    ContextPassthrough?: string;

    /**
     * Debug data specific to a game type determined from the request.
     * It's implemented as an object to support any game-specific debug data structure.
     */
    DebugGameData: unknown;

    DebugJackpotData?: DebugJackpotData;

    /**
     * Bonus round data specific to a game type determined from the request.
     * It's implemented as an object to support any game-specific bonus round data structure.
     */
    BonusRoundData: unknown;

    AuthToken: string;

    GamingSessionToken: string;
}
