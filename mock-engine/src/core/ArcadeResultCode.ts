// Ported from Libraries/Tombola.B2B.Arcade/ArcadeResultCode.cs

// MOCK: Tombola.GesInterface is not ported; this mirrors the fields the engine reads off an operator error.
export interface OperatorErrorDetails {
    Type: string;
    Title: string;
    Status: number;
    Detail: string;
    PlayerFacingErrorMessage: string;
    Retryable?: boolean;
}

/**
 * Represents error codes that can be returned by the arcade API, along with their descriptions and any additional details.
 *
 * The codes are used by the client to map to specific logic on their end, so it's safest not to change the
 * integer value of any existing codes.
 */
export class ArcadeResultCode {
    ResultCode: number;
    Description: string;
    OperatorErrorDetails?: OperatorErrorDetails;

    constructor(resultCode: number, description: string, operatorErrorDetails?: OperatorErrorDetails) {
        this.ResultCode = resultCode;
        this.Description = description;
        this.OperatorErrorDetails = operatorErrorDetails;
    }

    withOperatorErrorDetails(operatorErrorDetails: OperatorErrorDetails): ArcadeResultCode {
        return new ArcadeResultCode(this.ResultCode, this.Description, operatorErrorDetails);
    }

    private static resultCodeLookup: Map<number, ArcadeResultCode> | undefined;

    /** Returns the ArcadeResultCode matching the given integer code, or undefined if not found. */
    static getByCode(code: number): ArcadeResultCode | undefined {
        if (ArcadeResultCode.resultCodeLookup === undefined) {
            const lookup = new Map<number, ArcadeResultCode>();
            for (const name of Object.getOwnPropertyNames(ArcadeResultCode)) {
                const value = (ArcadeResultCode as unknown as Record<string, unknown>)[name];
                if (value instanceof ArcadeResultCode) lookup.set(value.ResultCode, value);
            }
            ArcadeResultCode.resultCodeLookup = lookup;
        }
        return ArcadeResultCode.resultCodeLookup.get(code);
    }

    // Debug
    static readonly DebugCode = new ArcadeResultCode(-1, '(╯°□°）╯︵ ┻━┻');

    // Standard succcess/fail
    static readonly Success = new ArcadeResultCode(0, 'Success');
    static readonly UnexpectedError = new ArcadeResultCode(1, 'Uncaught Exception thrown');

    // Timeouts and blocks
    static readonly PurchaseBlockedDueToSpam = new ArcadeResultCode(19, 'User is buying in too quickly');
    static readonly Timeout = new ArcadeResultCode(20, 'Request timed out');

    // Continue / user choice
    static readonly InvalidPicks = new ArcadeResultCode(6, 'The submitted picks are not allowed');
    static readonly IncorrectNumberOfPicks = new ArcadeResultCode(8, 'Sent number of picks was not the correct amount');
    static readonly OutOfSync = new ArcadeResultCode(12, 'Out of sync; invalid request');
    static readonly InvalidRequestInput = new ArcadeResultCode(15, 'Invalid request input');
    static readonly NoBonusGame = new ArcadeResultCode(16, 'Game cannot be continued; no bonus game');

    // Miscellaneous errors to show to players
    static readonly InvalidStake = new ArcadeResultCode(13, 'Unsupported bet amount');
    static readonly GameUnavailable = new ArcadeResultCode(28, 'Sorry, this game is currently unavailable.');
    static readonly GameInPlay = new ArcadeResultCode(103, 'Game already in play');
    static readonly BalanceTooLow = new ArcadeResultCode(104, 'Balance too low to purchase');
    static readonly GameAlreadyComplete = new ArcadeResultCode(106, 'Game has already been completed');
    static readonly FreePlayNotAllowed = new ArcadeResultCode(117, 'Free Play credits are not allowed in this game');
    static readonly NoStakeOptions = new ArcadeResultCode(145, 'No stake options available');

    // Internal errors, ideally not shown to the player
    static readonly RngError = new ArcadeResultCode(3, 'Error getting an RNG response');
    static readonly MalformedOrIncompleteRequest = new ArcadeResultCode(14, 'Message was malformed or incomplete');
    static readonly VersionInvalid = new ArcadeResultCode(32, "We tried to get a game version that doesn't exist");
    static readonly DatabaseError = new ArcadeResultCode(100, 'Error communicating with the database');
    static readonly TicketNotFound = new ArcadeResultCode(105, 'Database does not contain ticket');
    static readonly UpdateTicketError = new ArcadeResultCode(108, 'Ticket not updated');
    static readonly GameNotFound = new ArcadeResultCode(113, 'Game not found');
    static readonly UserNotFound = new ArcadeResultCode(114, 'User not found');
    static readonly InsertBonusGameError = new ArcadeResultCode(120, 'Error inserting bonus game data into table');
    static readonly UpdateBonusGamesError = new ArcadeResultCode(122, 'Error updating bonus games');
    static readonly DemoGameNotFound = new ArcadeResultCode(126, 'Demo Game not found');
    static readonly BonusGameAlreadyExists = new ArcadeResultCode(161, 'Bonus Game already in table');

    // Exclusive to admin endpoints, not shown to players
    static readonly CouldNotProcessIncomplete = new ArcadeResultCode(163, "Couldn't successfully process incomplete game");

    // GES/session codes
    static readonly AwardPrizeGepError = new ArcadeResultCode(201, 'GEP returned error response for AwardPrize');
    static readonly BetCancelledWithGep = new ArcadeResultCode(202, 'Bet cancelled');
    static readonly ShouldCancelBet = new ArcadeResultCode(203, 'Cancelling bet');
    static readonly AuthGepError = new ArcadeResultCode(204, 'GEP returned error response for auth');
    static readonly ExchangeGepError = new ArcadeResultCode(205, 'GEP returned error response for exchange');
    static readonly PlaceBetGepError = new ArcadeResultCode(206, 'GEP returned error response for place bet');
    static readonly NicknameGepError = new ArcadeResultCode(207, 'GEP returned empty/null nickname');
    static readonly VersionGepError = new ArcadeResultCode(208, 'GEP returned empty/null game version');
    static readonly GsUserIdGepError = new ArcadeResultCode(209, 'GEP returned empty/null GsUserId');
    static readonly CurrencyGepError = new ArcadeResultCode(210, 'GEP returned missing or invalid currency');
    static readonly CancelBetGepError = new ArcadeResultCode(211, 'GEP returned error response on cancelbet');
    static readonly NoAuthToken = new ArcadeResultCode(212, 'AuthToken was null or empty');
    static readonly InvalidSession = new ArcadeResultCode(213, 'Invalid session; refresh required');
    static readonly SessionNotOpened = new ArcadeResultCode(214, 'Session not opened');
    static readonly AwardPrizeNonRetriableGepError = new ArcadeResultCode(215, 'GEP returned non-retriable error response for AwardPrize');
    static readonly JackpotServiceUnavailable = new ArcadeResultCode(216, 'Could not retrieve jackpot values');
    static readonly RewardWalletServiceUnavailable = new ArcadeResultCode(217, 'Could not retrieve reward wallets');
    static readonly JackpotConfigurationChanged = new ArcadeResultCode(218, 'Jackpot configuration changed; acknowledge the current version before buying in');

    // Operator error; read OperatorErrorDetails for details
    static readonly OperatorReturnedError = new ArcadeResultCode(300, 'Operator error');
}
