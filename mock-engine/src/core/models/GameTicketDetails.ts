// Ported from Libraries/Tombola.B2B.Arcade/Models/GameTicketDetails.cs
// (+ CachedTicket/ArcadeCachedTicket from Libraries/Tombola.Redis/RedisTypes.cs, its base classes)

import { JackpotTease, PotTier } from './enums';

export class CachedTicket {
    GameIdGuid = '';
    GamingSessionToken = '';
}

export class ArcadeCachedTicket extends CachedTicket {
    Version = '';
    Stake = 0;
    Skin = '';
    PlayMode = '';
    BonusTriggered = false;
}

export class GameTicketDetails extends ArcadeCachedTicket {
    JackpotVersion = 1;
    Symbols: number[] = [];
    SideBetStake = 0; // for add ons - can be used in any game

    JackpotWin: PotTier = PotTier.None;
    GemLayouts: number[][][] = [];
    JackpotTease: JackpotTease = JackpotTease.None;
}
