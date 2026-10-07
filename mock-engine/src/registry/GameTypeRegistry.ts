// Ported from Libraries/Tombola.B2B.Arcade/GameTypeRegistry/{BeginGameTypeRegistry,
// BonusRoundTypeRegistry,GameDebugTypeRegistry}.cs, folded into one registry and joined to
// ArcadeGame.RegisterGameFactory (ArcadeGame.cs) so a mechanic self-registers in one call.
//
// MOCK: the C# registries map a game name to a `Type` the API then hands to
// JsonSerializer.Deserialize. TypeScript has no runtime type, so a registration supplies a
// parser function instead; the default is the identity parser, mirroring the C# fallback to
// the untyped DebugGameData.

import { ArcadeGame, ArcadeGameFactory } from '../core/ArcadeGame';
import { SkinName } from '../core/models/enums';

export type GameDataParser<T = unknown> = (raw: unknown) => T;

export interface GameRegistration {
    /** The URL segment AND the SkinName: `POST /{game}/begin`. Matched case-insensitively. */
    game: SkinName;
    factory: ArcadeGameFactory;
    /** BeginGameTypeRegistry — shapes request.BeginGameData. */
    beginGameData?: GameDataParser;
    /** BonusRoundTypeRegistry — shapes request.BonusRoundData. */
    bonusRoundData?: GameDataParser;
    /** GameDebugTypeRegistry — shapes request.DebugGameData. Defaults to the identity parser. */
    debugGameData?: GameDataParser;
}

const identityParser: GameDataParser = raw => raw;

export class GameTypeRegistry {
    // Keyed lower-cased, standing in for the C# StringComparer.OrdinalIgnoreCase dictionaries.
    private static readonly registrations = new Map<string, GameRegistration>();

    /** Registers the game's factory with ArcadeGame and its request parsers with this registry. */
    static register(registration: GameRegistration): void {
        const game = registration.game.trim();
        if (game.length === 0) throw new Error('A game registration needs a non-empty game name');

        GameTypeRegistry.registrations.set(game.toLowerCase(), { ...registration, game });
        ArcadeGame.registerGameFactory(game, registration.factory);
        ArcadeGame.availableGames = GameTypeRegistry.availableGames;
    }

    /** Mirrors ArcadeConfig.Game.AvailableGames, which the endpoints validate the URL segment against. */
    static get availableGames(): string[] {
        return [...GameTypeRegistry.registrations.values()].map(registration => registration.game);
    }

    static isAvailable(game: string): boolean {
        return GameTypeRegistry.registrations.has(game.trim().toLowerCase());
    }

    /** Returns the registration, canonically-cased game name included, or undefined. */
    static tryGet(game: string): GameRegistration | undefined {
        return GameTypeRegistry.registrations.get(game.trim().toLowerCase());
    }

    static registerBeginGameType(game: string, parser: GameDataParser): void {
        GameTypeRegistry.mutate(game, registration => (registration.beginGameData = parser));
    }

    /** Throws where the C# throws KeyNotFoundException. */
    static getBeginGameType(game: string): GameDataParser {
        const parser = GameTypeRegistry.tryGet(game)?.beginGameData;
        if (parser === undefined) throw new Error(`Begin game type does not exist for game '${game}'.`);
        return parser;
    }

    static registerBonusRoundType(game: string, parser: GameDataParser): void {
        GameTypeRegistry.mutate(game, registration => (registration.bonusRoundData = parser));
    }

    static getBonusRoundType(game: string): GameDataParser {
        const parser = GameTypeRegistry.tryGet(game)?.bonusRoundData;
        if (parser === undefined) throw new Error(`Bonus round type does not exist for game '${game}'.`);
        return parser;
    }

    static registerDebugDataType(game: string, parser: GameDataParser): void {
        GameTypeRegistry.mutate(game, registration => (registration.debugGameData = parser));
    }

    /** Falls back to the identity parser, as the C# falls back to typeof(DebugGameData). */
    static getDebugDataType(game: string): GameDataParser {
        return GameTypeRegistry.tryGet(game)?.debugGameData ?? identityParser;
    }

    /** MOCK: not in the C#; lets a prototype re-register a mechanic between replays. */
    static clear(): void {
        GameTypeRegistry.registrations.clear();
        ArcadeGame.availableGames = [];
    }

    private static mutate(game: string, apply: (registration: GameRegistration) => void): void {
        const registration = GameTypeRegistry.tryGet(game);
        if (registration === undefined) throw new Error(`Game '${game}' is not registered.`);
        apply(registration);
    }
}
