// Ported from Libraries/Tombola.B2B.Arcade/Models/Enums/*.cs, plus ArcadeGameType (Models/GameMessage.cs)
// and PotTier/JackpotTease (Libraries/Tombola.RngSerialisation/Arcade/JackpotRngRequest.cs).
// The real API registers a global JsonStringEnumConverter, so enums go on the wire as their member NAME.
// Only enums whose every member carries an explicit integer in C# stay numeric here — those integers are
// the database/protocol contract and never appear in a response body.

/** SkinName is a closed C# enum; open here because every Orca project defines its own skins. */
export type SkinName = string;

// All the possible request types
export enum RequestType {
    Invalid = 'Invalid',
    CreateSession = 'CreateSession',
    SessionStatus = 'SessionStatus',
    Begin = 'Begin',
    Resume = 'Resume',
    Review = 'Review',
    Continue = 'Continue',
    PotValues = 'PotValues',
    ProcessIncompleteGame = 'ProcessIncompleteGame',
    Simulate = 'Simulate',
}

export enum PlayMode {
    Unknown = 'Unknown',
    Wallet = 'Wallet',
    FreePlay = 'FreePlay',
    FunBonus = 'FunBonus',
    UnauthDemo = 'UnauthDemo',
}

export enum GameType {
    None = 'None',
    Spin = 'Spin',
    InstantWin = 'InstantWin',
    Crash = 'Crash',
}

export enum GameFlowType {
    None = 'None',
    Precalculated = 'Precalculated',
    CashCollector3 = 'CashCollector3',
    CashCollector4 = 'CashCollector4',
    LeftRight = 'LeftRight',
}

// The various game types
export enum ArcadeGameType {
    None = 'None',
    Scratch = 'Scratch',
    Keno = 'Keno',
    Pick = 'Pick',
    Spin = 'Spin',
    Flip = 'Flip',
    Tap = 'Tap',
    Glow = 'Glow',
    Go = 'Go',
    Slide = 'Slide',
    Cards = 'Cards',
    Shared = 'Shared',
    Drop = 'Drop',
    Denari = 'Denari',
    InstantWin = 'InstantWin',
    Roulette = 'Roulette',
    Crash = 'Crash',
    ChoiceCrash = 'ChoiceCrash',
}

export enum Territory {
    None = 'None',
    UK = 'UK',
    IT = 'IT',
    ES = 'ES',
    SE = 'SE',
    DK = 'DK',
}

export enum Environment {
    Local = 'Local',
    Dev = 'Dev',
    Int = 'Int',
    Live = 'Live',
}

export enum InstancePurpose {
    None = 'None', // fallback; invalid
    Standard = 'Standard', // the usual type of instance; serves games
    Admin = 'Admin', // serves admin functions only
    SimClient = 'SimClient', // serves simulation runs
    JackpotClient = 'JackpotClient', // serves controlled jackpot API load runs
}

export enum GameSpendType {
    Unknown = 'Unknown',
    Wallet = 'Wallet',
    FunBonus = 'FunBonus',
    FreePlay = 'FreePlay',
    WalletBonus = 'WalletBonus',
}

// GameSpendTypeExtensions.ParseDatabaseValue
export function parseGameSpendTypeDatabaseValue(spendType: string): GameSpendType {
    const normalised = spendType.split('_').join('').toLowerCase();
    const match = Object.values(GameSpendType).find(value => value.toLowerCase() === normalised);
    return match ?? GameSpendType.Unknown;
}

// GameSpendTypeExtensions.ToDatabaseValue
export function gameSpendTypeToDatabaseValue(spendType: GameSpendType): string {
    switch (spendType) {
        case GameSpendType.Wallet:
            return 'WALLET';
        case GameSpendType.WalletBonus:
            return 'WALLET_BONUS';
        case GameSpendType.FunBonus:
            return 'FUN_BONUS';
        case GameSpendType.FreePlay:
            return 'FREEPLAY';
        default:
            return 'UNKNOWN';
    }
}

export enum TransactionActionCode {
    ForceClosed = 3, // used by the database only
    Void = 4, // used by the database only
    BuyIn = 100,
    EndWager = 101,
    GdsAwardApiSuccess = 600,
    GdsAwardApiFailure = 601,
    GdsCancelApiSuccess = 602,
    GdsCancelApiFailure = 603,
    GdsAwardQueueSuccess = 604,
    GdsAwardQueueFailure = 605,
    GdsCancelQueueSuccess = 606,
    GdsCancelQueueFailure = 607,
    VoidFailure = 608,
}

export enum PotTier {
    None = 0,
    Low = 1,
    Mid = 2,
    High = 3,
}

export enum JackpotTease {
    None = 0,
    Minor = 1,
    Major = 2,
}

/** DBOX error codes as of DBOXIntegrationGuide_SessionBased_v3.8. */
export enum DBOXError {
    OperationExecuted = 0,

    InvalidCloseSession = 1000,
    DepositTransactionNotFound = 1001,
    GameSessionHasPendingTransactions = 1002,
    GameSessionNotClosed = 1003,
    GameSessionNotProgressionSent = 1004,
    GameSessionHasPendingPhases = 1005,

    InvalidBetAmount = 2000,
    InvalidRebuy = 2001,
    BuyinNotFound = 2002,
    GameSessionNotOpened = 2003,
    InvalidPlayBonusAmount = 2004,
    InvalidJackpotAmount = 2005,
    InstantWagerCancelled = 2007,
    InstantWagerInvalidated = 2008,
    InstantWagerReserved = 2009,
    InstantWagerToCancel = 2011,

    GenericWalletError = 3000,
    ReserveFailed = 3001,
    ConfirmFailed = 3002,
    CancelFailed = 3003,
    DepositFailed = 3004,
    WithdrawFailed = 3005,
    BalanceFailed = 3006,
    PlayerInfoFailed = 3007,
    CheckTokenFailed = 3008,

    RegulatorOpenGameSession = 4001,
    RegulatorWager = 4002,
    RegulatorClosePlayerGameSession = 4003,
    RegulatorCloseGameSession = 4004,
    RegulatorSessionProgression = 4005,
    RegulatorPostponeSessionEnd = 4006,
    RegulatorSessionClearance = 4007,
    RegulatorModuleVersion = 4008,
    RegulatorPlayerGameSessionAlreadyClosed = 4009,

    PlayerDisabled = 5001,
    GameDisabled = 5002,
    GameProviderDisabled = 5003,

    ValidationError = 6000,
    WalletNotFound = 6003,
    InvalidBetTypeAmount = 6004,
    WalletBonusTypeNotFound = 6005,
    WalletBonusStatusNotFound = 6006,
    ValidityEndBeforeValidityStart = 6007,
    MessageNotFound = 6008,
    WalletBonusAlreadyAssigned = 6009,
    MessageAlreadyExists = 6010,

    RegulatorError = 7000,

    InvalidXauth = 8000,

    PlayerNotFound = 9001,
    PlayersGameSessionNotFound = 9002,
    GameNotFound = 9003,
    GameSessionNotFound = 9004,
    PlayersGamePhaseNotFound = 9005,
    LicenseeNotFound = 9006,
    InvalidPlayerGameSessionStatus = 9007,
    GameLicenseeNotFound = 9008,
    InvalidLicenseeForNetwork = 9009,
    PlayerNicknameAlreadyPresent = 9010,
    CertificationNotFound = 9012,
    GameSessionTransactionNotFound = 9014,
    SoftwareModuleNotFound = 9015,
    PlayersGamePhaseWagerNotFound = 9017,
    PlayersGameSessionNotOpened = 9018,
    InvalidCancelWager = 9020,
    GamePhaseNotFound = 9021,
    PlayersGamePhaseNotOpened = 9022,
    InvalidPlayerGamePhaseWager = 9023,
    InvalidPlayerGamePhaseWagerStatus = 9024,
    UnmatchedGamePhaseWagerGame = 9025,
    GameProviderNotFound = 9026,
    GameSubtypeNotFound = 9027,
    StatusNotFound = 9028,
    CancelledPlayerGamePhaseWagerStatus = 9029,

    InvalidGameForSession = 9100,

    Unauthorized = 9900,
    InvalidInputField = 9910,
    GenericError = 9999,
}
