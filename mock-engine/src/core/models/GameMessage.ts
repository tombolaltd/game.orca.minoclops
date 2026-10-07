// Ported from Libraries/Tombola.B2B.Arcade/Models/GameMessage.cs

import { ArcadeGameType, SkinName } from './enums';

// This class defines the properties of every game message
export interface GameMessage {
    ArcadeGameType: ArcadeGameType;
    Stake: number;
    GameId: string;
    Skin: SkinName;
    WinThisSpin: number;
    Payout: number;
    Username: string;
    Winner: boolean;
    Symbols: number[];
    GameComplete: boolean;
}
