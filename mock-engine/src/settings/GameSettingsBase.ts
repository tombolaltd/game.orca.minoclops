// Ported from Libraries/Tombola.B2B.Arcade/GameSettings/GameSettings.cs
// (+ Interfaces/GameSettingsInterfaces/IArcadeSettings.cs, which every concrete settings class implements).

import { IArcadeSettings } from '../core/interfaces';
import { GameSettings } from '../core/models/BaseArcadeResponse';

/**
 * The base a concrete mechanic's settings extend, e.g.
 * `class MySettings_95_03 extends GameSettingsBase { ActiveVersion = '95.03'; Rtp = 95.03; Reels = [...]; }`
 */
export class GameSettingsBase implements IArcadeSettings {
    ActiveVersion = '';
    Rtp = 0;
    WinMultipliers: number[] = [];
    AnnounceWinnerMultipliers: number[] = [];

    /** Minor units. The engine filters these against minStakeDivisor and the session limits. */
    StakeOptions: number[] = [25, 50, 100, 200, 500];
    DefaultStake = 25;
    TotalRtp?: number;

    /** The response payload shape; ActiveVersion becomes GameSettings.Version on the wire. */
    toResponseGameSettings(): GameSettings {
        const settings = new GameSettings();
        settings.WinMultipliers = this.WinMultipliers;
        settings.StakeOptions = this.StakeOptions;
        settings.DefaultStake = this.DefaultStake;
        settings.Version = this.ActiveVersion;
        settings.Rtp = this.Rtp;
        settings.TotalRtp = this.TotalRtp;
        return settings;
    }
}

export type GameSettingsFactory<T extends GameSettingsBase = GameSettingsBase> = () => T;

/**
 * Replaces the engine's `version switch { "95.03" => new XSettings_95_03(), ... }` inside setSettings().
 */
export class GameSettingsRegistry<T extends GameSettingsBase = GameSettingsBase> {
    private readonly factories = new Map<string, GameSettingsFactory<T>>();
    private fallbackVersion: string | undefined;

    /** The first registered version doubles as the default, so a game needs no extra wiring. */
    register(version: string, factory: GameSettingsFactory<T>): this {
        this.factories.set(version, factory);
        if (this.fallbackVersion === undefined) this.fallbackVersion = version;
        return this;
    }

    setDefaultVersion(version: string): this {
        if (!this.factories.has(version)) throw new Error(`Cannot default to unregistered settings version ${version}`);
        this.fallbackVersion = version;
        return this;
    }

    get versions(): string[] {
        return [...this.factories.keys()];
    }

    get defaultVersion(): string | undefined {
        return this.fallbackVersion;
    }

    has(version: string): boolean {
        return this.factories.has(version);
    }

    tryCreate(version: string): T | undefined {
        return this.factories.get(version)?.();
    }

    /** Throws where the engine would set ArcadeResultCode.VersionInvalid; use tryCreate to handle it yourself. */
    create(version: string): T {
        const settings = this.tryCreate(version);
        if (settings === undefined) throw new Error(`Settings version ${version} is not registered. Known versions: ${this.versions.join(', ') || 'none'}`);
        return settings;
    }

    /** Falls back to the default version when the session hands over a version this game does not know. */
    createOrDefault(version: string): T {
        return this.tryCreate(version) ?? this.create(this.fallbackVersion ?? version);
    }
}
