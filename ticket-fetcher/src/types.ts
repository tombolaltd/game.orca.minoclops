import { IGameMessage, IGameSettings } from '@arcade-client/base-ticketfetcher-package';

export interface IGameServerResponse {
    GameMessage: IGameMessageEx;
    GameSettings: IGameSettingsEx;
}

export interface IGameMessageEx extends IGameMessage {
    // TODO: Add game specific game message attributes here!
}

export interface IGameSettingsEx extends IGameSettings {
    // TODO: Add game specific game settings attributes here!
}

export interface ITicketFetcherStrings {
    // TODO: Add any TF specific strings here!
}

// TODO: Add other game specific types here!
