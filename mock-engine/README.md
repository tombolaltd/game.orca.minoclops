# Mock Arcade Engine

A **prototyping** TypeScript port of the structure of the real Tombola B2B Arcade
engine (`gamestudio.engine.b2b.arcade`, .NET). It lets an Orca project run a full
game loop — begin / continue / resume / potvalues — with no real engine behind it.

It carries the wire shapes, result codes, enums, the abstract `ArcadeGame` and the
handler interfaces, plus RNG, in-memory storage, a default flow handler and the
bundled mechanic blocks listed below.

## ⚠️ WARNING — not certified, not fair, never ship it

This is a **development mock**. It is not RNG-certified, not audited, not
regulator-approved and makes no fairness or RTP guarantee whatsoever. It exists so
a designer can prototype a game before a real engine build exists. **Never point a
production or player-facing build at it.**

## Scope — dev-preview only, by design

Orca's editor hosts this engine inside the **game dev server** and serves it to the
editor's game preview. That is the whole of its intended reach. The shipped game
does **not** consume it and a deployed build must never reach it — an intentional
boundary, **not an unfinished feature**. Nothing about wiring the live game to this
mock is pending or planned; the mock's job is to let the client be developed before
a real engine is available, and it is complete at that job.

What legitimately crosses over is authoring OUTPUT the user chose to keep — the
server field mapping generated into the game's model files from a captured
response, and the per-mechanic settings a Build From Spec run wrote.

## Ground rules

- **Zero runtime dependencies.** No npm packages, no `node:` imports, no DOM
  globals. Identical behaviour in the Electron main process and in a browser bundle.
- **The engine team's naming is retained verbatim.** Wire-shape fields stay
  PascalCase (`ResultCode`, `PlayerData`, `GameComplete`, `Stake`, `Skin`, …) so the
  JSON this emits is indistinguishable from the real engine's. Methods and handler
  slots are camelCase, matching TypeScript convention.
- **Enums go on the wire as their member name.** The real API registers a global
  `JsonStringEnumConverter`, so ported enums are string enums. The exception is any
  enum whose every C# member carries an explicit integer — `TransactionActionCode`,
  `DBOXError`, `PotTier`, `JackpotTease` — where the integer is the database or
  protocol contract and the value never reaches a response body.
- **`// MOCK:`** marks every place where the C# reached into GEP, the session layer,
  SQL Server, Redis or config and the mock had to deviate.

## Port map

| Module | Ported from (`Libraries/Tombola.B2B.Arcade/…`) |
| --- | --- |
| `core/ArcadeResultCode.ts` | `ArcadeResultCode.cs` |
| `core/ArcadeGame.ts` | `ArcadeGame.cs` |
| `core/models/enums.ts` | `Models/Enums/*.cs`, `Models/GameMessage.cs` (`ArcadeGameType`), `Tombola.RngSerialisation/Arcade/JackpotRngRequest.cs` (`PotTier`, `JackpotTease`) |
| `core/models/BaseArcadeRequest.ts` | `Models/BaseArcadeRequest.cs`, `Models/GameInGameParentInfo.cs`, `Models/DebugJackpotData.cs` |
| `core/models/BaseArcadeResponse.ts` | `Models/BaseArcadeResponse.cs`, `GameSettings/GameSettings.cs` |
| `core/models/GameMessage.ts` | `Models/GameMessage.cs` |
| `core/models/GameTicketDetails.ts` | `Models/GameTicketDetails.cs`, `Tombola.Redis/RedisTypes.cs` (`CachedTicket`, `ArcadeCachedTicket`) |
| `core/models/GameInternalData.ts` | `Models/GameInternalData.cs` |
| `core/interfaces/index.ts` | `Interfaces/*.cs`, `Models/SimulationGameResult.cs`, `Interfaces/GameSettingsInterfaces/IArcadeSettings.cs` |

## Component blocks

The real engine is assembled from swappable **component blocks** hung off a single
`IGameContext`. `ArcadeGame` is that context and owns five slots:

| Slot | Interface | Responsibility |
| --- | --- | --- |
| `flowHandler` | `IGameFlowHandler` | Orchestrates a request: begin, continue, resume, review, demo, force-close. |
| `logicHandler` | `IGameLogicHandler` | The game's own maths — build the RNG request, play, continue, validate. |
| `storageHandler` | `IGameStorageHandler` | Persistence and cache: store, load, void, cache, transaction log. |
| `ticketHelper` | `IGameTicketHelper` | Serialises a `GameTicketDetails` to and from storage. |
| `debugHandler` | `IGameDebugHandler` | Optional. Forces outcomes and drives simulation runs. |

A concrete game subclasses `ArcadeGame`, declares its `acceptedSkins`, implements
`setSettings(version)`, and registers itself:

```ts
ArcadeGame.registerGameFactory('MySkin', (request, requestType) => new MyGame(request, requestType));
const game = ArcadeGame.createGame(logger, request, Territory.UK, RequestType.Begin);
```

Shared stake handling already lives on the base class:
`validateAndSetStakeOptions()` applies `minStakeDivisor` plus session limits,
`getGameStakeOptions()` is the per-game override point, `validateRequestedStake()`
gates the requested bet, and `populateResponseGameSettings()` fills the response.

## Jackpots — an optional sixth block

`jackpot/MockJackpotService.ts` collapses the jackpot-api pot store,
`DefaultJackpotFlowHandler`, the win selectors and `ChampionsJackpotTicketGenerator`
into one deterministic in-process object. It is an **independent opt-in**:
`GameFlowHandlerBase` keeps the dependency only when
`dependencies.jackpotService?.enabled === true`, so with jackpots off every jackpot
step in the flow is a no-op and **no response carries a `Jackpot` member at all**.
With it on, `resume` / `potvalues` carry `ConfigVersion` + `CurrentPotValues` and
`begin` carries `ConfigVersion` + `JackpotWin` (plus `JackpotPrize` / `WinningPot` /
`WinningTicket` / `WinningDetails` on a win); `continue` is unaffected.

`createDefaultJackpotPots()` owns the per-tier numeric defaults — a caller supplies
**sparse** `MockJackpotPotConfig` overrides keyed by `TierId` and the caller is
responsible for merging them over those defaults, because `normalisePots` defaults
every missing numeric to `0`.

## Mechanic blocks

`src/games/` bundles the ported mechanics. `src/games/index.ts` re-exports them all
and **registers them on import**; `MECHANIC_CATALOG` describes them as one array.

| `key` | Friendly name | `ArcadeGameType` | Settings type | Description |
| --- | --- | --- | --- | --- |
| `lines-slot` | Lines Slot | `Spin` | `LinesSlotSettings` | Reel slot paying fixed left-to-right paylines, with wilds, scatters and a free-spin bonus round. |
| `ways-slot` | Ways Slot | `Spin` | `WaysSlotSettings` | Reel slot paying every adjacent symbol path (243 ways by default), with wilds, scatters and a free-spin bonus round. |
| `cash-collector` | Cash Collector | `Spin` | `CashCollectorSettings` | A 6x4 ways slot where collector symbols bank on-screen cash values. Collector kinds (Standard, Lock & Spin, Cash Boost, Win Blast) unlock as cash symbols fill a persistent meter; 3+ scatters start free spins with a rising cash multiplier. |
| `instant-win` | Instant Win | `InstantWin` | `InstantWinSettings` | Scratch card of reveal cells where a symbol landing `MatchesToWin` times pays its stake multiplier. |

Every entry carries a `register`, so `registerBundledMechanics()` stands all four up.
`lines-slot`, `ways-slot` and `cash-collector` return `GameComplete: false` on a bonus trigger and
step the free spins through `continue`; `instant-win` models no bonus stage, so a begin always
completes and a `continue` reports `NoBonusGame`.

`cash-collector` is a port of the real Cash Collector 3 engine (95.00 maths) and is the one
STATEFUL mechanic: the player's unlock state is read off their most recent stored game, so it
survives between rounds (and a simulator prune keeps each player's latest game for that reason).
Its wins run through the shared `evaluateWays`; its response adds a few MOCK presentation
helpers (`GameState.EndProgress`, `BonusSpin.TrailProgress`, `ScatterResult.BonusSpinsAwarded`, …)
that are marked as such in `CashCollectorGameMessage.ts`. A continue may carry its `BonusSpin` at
the top level of the body, which is what arcade-base's `continueRequest(payload)` sends. Tests:
`npm run check:mock-cash-collector`.

## Evaluation block

`src/evaluation/` holds the canonical win-evaluation primitives, ported from the game-studio
prototyping harness (`proto-design-system/src/evaluation/`). A mechanic under `src/games/<key>/` —
bundled or generated — composes them instead of re-deriving line/ways maths:

```ts
import { evaluateLines, evaluateWays, tieredMultiplier } from '../../evaluation';

const { Wins, TotalMultiplier } = evaluateLines({
    reels: displayReels,          // column-major, from getDisplayedReels()
    winlines: settings.Winlines,  // rows[reel] per line
    wildSymbol: settings.WildSymbol,
    multiplierFor: tieredMultiplier({ 2: { 3: 2, 4: 10, 5: 50 } }),
});
```

They are re-exported from the engine barrel too, so an outside consumer imports the same names
from `mock-engine/src`.

| Export | What it does |
| --- | --- |
| `evaluateLines(options)` | Left-to-right payline evaluator with wild substitution. A wild-led line adopts the first paying symbol it reaches; `wildRunPays` additionally prices the leading wild run and awards the better of the two. |
| `evaluateWays(options)` | N-ways evaluator. Awards the longest PAYING run at its tier multiplier times the product of the per-reel hit counts. `direction` selects the walk, so pay-both-ways is two calls. |
| `tieredMultiplier(paytable)` | Paytable lookup that falls back to the highest declared tier at or below the matched count. |
| `exactMultiplier(paytable)` | Paytable lookup that pays only the exact matched count — the real engine's convention, and what both bundled slots use. |

`multiplierFor` is injected rather than fixed, so a mechanic keeps its own paytable shape while
there stays exactly **one** copy of the run-detection maths in the tree. The rules the real engine
adds are options (`wildRunPays`, `paysOnLine` / `paysOnWays`, `wildLead`, `minMatch`,
`multiplier`), never a forked walk — `lines-slot` and `ways-slot` both run through these
evaluators and their wire responses are unchanged by the move. A mechanic needing a rule the
options cannot express should extend them here.

⚠️ **The paytable lookup moves RTP.** `tieredMultiplier` pays a 5-reel run its 4-of-a-kind prize
when no 5-of-a-kind is declared; `exactMultiplier` refuses, and the evaluator falls back to the
longest run that does pay — a shorter, and for ways a narrower, win. Pick deliberately and measure
with the simulator below. Nothing here is certified.

## Simulation block

`src/sim/runMechanicSimulation.ts` plays a bounded run of rounds and reports RTP, hit frequency,
max win, bonus rate and a payout histogram. It drives `MockEngine.begin` / `MockEngine.continue`
— the SAME pipeline the HTTP routes use — and drains any bonus round before scoring, so there is
no second copy of the maths to drift from. Settings are not re-registered: whatever is already in
a mechanic's per-skin settings registry is what gets measured.

```ts
const result = await runMechanicSimulation({ mechanic: 'lines-slot', spins: 5000, seed: 7 });
console.log((result.rtp * 100).toFixed(2) + '%', result.hitFrequency, result.maxSinglePayX);
```

It is also reachable over HTTP at `POST /sim` with `{ mechanic, skin?, spins?, seed?, stake? }`,
answering `{ ok, result?, error? }`. Bounded by a round cap and a wall-clock ceiling, and it
restores the process-wide `RandomHelpers` generator afterwards so a simulation cannot disturb a
live engine sharing the process.

**It measures a prototype and certifies nothing.** Two runs at one seed are bit-identical, which
makes it useful for catching an ungated `Math.random()`, a payout path that fills state but never
pays, and a config field declared but never rolled — not for judging fairness.

Composing a backend is picking a mechanic, registering it under your skin, and
pointing a `MockEngine` at it:

```ts
import { createDefaultLinesSlotSettings, MockEngine, registerLinesSlotGame } from './mock-engine/src';

const settings = createDefaultLinesSlotSettings();
settings.Rtp = 96;

const skin = registerLinesSlotGame({ skin: 'MyGame', settings });
const engine = new MockEngine({ seed: 1, startingBalance: 10000 });
const response = await engine.begin({ game: skin, Skin: skin, Stake: 25 });
```

## Building

No `package.json` — whoever consumes this folder compiles it.

```sh
npx tsc -p mock-engine/tsconfig.json
```
