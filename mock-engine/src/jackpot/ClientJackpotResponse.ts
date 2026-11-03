// MOCK: no C# counterpart. The arcade client (`@game-studio/jackpots`) reads a reply's jackpot
// from `JackpotResponse` — `low` / `mid` / `high` tiers and `PrizeValue`s, the shape the real
// engine's begin / resume / potvalues replies carry — while this port's `Jackpot` member keeps
// the engine-side `JackpotDetails`. This builds the first from the second, so a game previewed
// against the mock plays its jackpot rounds and its panel's poller reads the mock's pots.

import { ClientJackpotPrize, ClientJackpotResponse, JackpotDetails, JackpotPotValue } from '../core/models/BaseArcadeResponse';
import { PotTier } from '../core/models/enums';

/** The client's name for a pot's tier: by `TierId` (`PotTier`), else its `Tier` lowercased. */
export function clientJackpotTier(pot: Pick<JackpotPotValue, 'Tier' | 'TierId'>): string {
    switch (pot.TierId) {
        case PotTier.Low:
            return 'low';
        case PotTier.Mid:
            return 'mid';
        case PotTier.High:
            return 'high';
        default:
            return String(pot.Tier).toLowerCase();
    }
}

function toClientPrize(pot: JackpotPotValue, prizeValue: number = pot.CurrentValue): ClientJackpotPrize {
    return { Tier: clientJackpotTier(pot), PrizeValue: prizeValue };
}

/**
 * `details` in the client's shape. `currentPots` are the pots as they stand after the request
 * (begin never fills `CurrentPotValues`, so they stand in). On a win the won pot shows the prize
 * it paid, as the real engine reports it, and `NextPotValue` its reseeded value.
 */
export function toClientJackpotResponse(details: JackpotDetails, currentPots: JackpotPotValue[]): ClientJackpotResponse {
    const pots = details.CurrentPotValues.length > 0 ? details.CurrentPotValues : currentPots;
    const won = details.JackpotWin === true ? details.WinningPot : undefined;
    const prize = won === undefined ? undefined : details.JackpotPrize ?? won.CurrentValue;

    const response: ClientJackpotResponse = {
        CurrentPotValues: pots.map(pot => (won !== undefined && pot.TierId === won.TierId ? toClientPrize(pot, prize) : toClientPrize(pot))),
        JackpotWin: won !== undefined,
    };
    if (won === undefined) return response;

    response.WinningPot = toClientPrize(won, prize);
    response.NextPotValue = toClientPrize(pots.find(pot => pot.TierId === won.TierId) ?? won);
    if (details.WinningTicket !== undefined) response.WinningTicket = details.WinningTicket;
    if (details.WinningDetails !== undefined) response.WinningDetails = details.WinningDetails;
    return response;
}
