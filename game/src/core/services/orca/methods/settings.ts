import { SettingsEventEmitter } from "@game-studio/arcade-base";

/**
 * Settings Methods for FlowState — open, close or toggle the in-game
 * settings menu through arcade-base's `SettingsEventEmitter`, the same
 * events the cabinet's settings button sends.
 */
class SettingsMethods {
    public showSettings(): void { SettingsEventEmitter.emit('show'); }
    public hideSettings(): void { SettingsEventEmitter.emit('hide'); }
    public toggleSettings(): void { SettingsEventEmitter.emit('toggle'); }
}

export const settings = new SettingsMethods();
