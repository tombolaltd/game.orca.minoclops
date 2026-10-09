/**
 * Bundled MOCK ARCADE ENGINE — game dev-server wiring.
 *
 * `<project>/mock-engine/` is a zero-dependency TypeScript port of the real
 * Tombola B2B Arcade engine's request surface (begin / continue / resume /
 * potvalues). This module is the CommonJS bridge that lets
 * `build/webpack.dev.conf.js` — plain Node, no loaders — host it in-process,
 * so a project with no real engine behind it can still run a full game loop
 * against `http://localhost:<gamePort>/{game}/begin`.
 *
 * ⚠️ It is a DEVELOPMENT MOCK: not RNG-certified, not audited, no fairness or
 * RTP guarantee. Never point a player-facing build at it.
 *
 * ── How the TypeScript is loaded ────────────────────────────────────────────
 * `mock-engine/` ships SOURCE only (no `dist`, no `package.json`). Rather than
 * commit a build artefact — which would silently rot against the sources — the
 * loader installs a `require.extensions['.ts']` hook backed by `typescript`'s
 * `transpileModule` (the same mechanism `ts-node` uses, minus the type
 * checking). `typescript` is ALREADY a devDependency of this game package, so
 * this adds NO new dependency. The hook is scoped to files under
 * `mock-engine/src` and delegates anything else to whatever handler was
 * already registered, so it cannot affect the rest of the build. Registering
 * `.ts` in `require.extensions` also makes Node's extension-less resolution
 * (`./core/ArcadeGame`, `./games` → `games/index.ts`) work unchanged.
 *
 * ── Fail-soft, always ───────────────────────────────────────────────────────
 * Every failure path here (missing `mock-engine/`, missing `typescript`, a
 * transpile/load error, a bad config) warns once and registers NOTHING. A
 * project must always boot with no mock engine. `transpileModule` does no type
 * checking, so a GENERATED mechanic with a syntax error throws at require time;
 * that is caught too, and the previously loaded engine keeps serving.
 *
 * ── Source reload without a restart ─────────────────────────────────────────
 * `mock-engine/src/**` is fingerprinted (file count + newest mtime) behind a
 * short time gate. When the fingerprint moves — the editor generating a new
 * mechanic, say — every `mock-engine/src` entry is evicted from
 * `require.cache`, the entry is re-required and the engine is rebuilt. The
 * fingerprint is folded into the engine cache key alongside the settings mtime.
 * None of this runs while the project has the mock engine disabled.
 *
 * ── Opt-in, per project ─────────────────────────────────────────────────────
 * Driven by `main.orca.projectSettings.mockEngine` (an optional, self-creating
 * field — AGENTS.md rule 14):
 *
 *   { enabled: boolean, mechanic: string, seed?, startingBalance?, currencyCode?,
 *     jackpot?: { enabled, networkName?, configVersion?, forceWin?, forceWinTierId?, pots? } }
 *
 * Absent or `enabled !== true` → the middleware `next()`s on every request, so
 * a project pointed at a real engine is completely unaffected. The config is
 * re-read PER REQUEST behind an mtime gate (mirroring `readActiveSkinCached`
 * in `orca-project-assets.js`), so toggling the mock engine, switching mechanic
 * or changing the seed takes effect WITHOUT a dev-server restart.
 *
 * Switching it OFF also DROPS the built engine, so the fake wallet, session
 * tokens and in-flight round do not survive into the next enable. A fake
 * backend that resumed a round the user had already left behind (with a
 * balance from before) is worse than no backend at all.
 *
 * ── Jackpots are a second, independent opt-in ───────────────────────────────
 * `jackpot.enabled === true` injects a `MockJackpotService` into the engine, at
 * which point `resume` / `potvalues` carry `Jackpot.CurrentPotValues` and
 * `begin` carries `Jackpot.JackpotWin`. Absent or malformed → nothing is
 * injected and every response is byte-identical to a project that never opted
 * in, with no `Jackpot` member anywhere.
 *
 * ── Generated per-mechanic settings ─────────────────────────────────────────
 * `mock-engine/settings/<mechanic>.json` — written by the editor's Build From
 * Spec wizard — is MERGED over the mechanic's own `createDefaultSettings()`
 * instance, so a spec can tune reels / paylines / symbols / RTP without any
 * code. Absent or malformed → the mechanic's defaults stand. Read behind the
 * same mtime gate as the config, so a rewrite takes effect without a restart.
 *
 * Style and the `req.method` guard follow `createOrcaAssetsDevMiddleware` in
 * `build/orca-project-assets.js`.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { readActiveSkinCached } = require('./orca-project-assets');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ORCA_PATH = path.join(PROJECT_ROOT, 'orca-project-files', 'main.orca');
const MOCK_ENGINE_SRC_DIR = path.join(PROJECT_ROOT, 'mock-engine', 'src');
const MOCK_ENGINE_ENTRY = path.join(MOCK_ENGINE_SRC_DIR, 'index.ts');
const MOCK_ENGINE_SETTINGS_DIR = path.join(PROJECT_ROOT, 'mock-engine', 'settings');

/** Matches the first key in `MECHANIC_CATALOG` (mock-engine/src/games/index.ts). */
const DEFAULT_MECHANIC = 'lines-slot';

/** Mirrors `MECHANIC_KEY_RE` in the editor's `src/services/MockEngineClient.ts`. */
const MECHANIC_KEY_RE = /^[a-z0-9][a-z0-9-]*$/i;

/** Keys that would poison the settings instance the overrides are merged onto. */
const UNSAFE_SETTINGS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Mirrors `MOCK_ENGINE_POT_INT_FIELDS` / `..._NUMBER_FIELDS` in `electron/main.js`. */
const JACKPOT_POT_INT_FIELDS = ['Ordering', 'BaseSeedValue', 'ProbabilityNumerator', 'ProbabilityDenominator', 'MustGoValue'];
const JACKPOT_POT_NUMBER_FIELDS = ['ContributionPercent', 'Rtp'];

/**
 * Mirrors `normalizeMockEngineJackpotPots` in the editor's `electron/main.js`.
 * Sparse per-tier overrides keyed by `TierId`; every other field is dropped
 * unless valid, and the defaults are filled in by `buildJackpotOptions`.
 *
 * @param {any} raw
 * @returns {Array<Record<string, unknown>>}
 */
function normaliseJackpotPots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Number.isFinite(entry.TierId)) continue;
    const tierId = Math.trunc(entry.TierId);
    if (tierId <= 0 || seen.has(tierId)) continue;
    seen.add(tierId);

    const pot = { TierId: tierId };
    if (typeof entry.Tier === 'string' && entry.Tier.trim()) pot.Tier = entry.Tier.trim();
    for (const key of JACKPOT_POT_INT_FIELDS) {
      if (Number.isFinite(entry[key]) && entry[key] >= 0) pot[key] = Math.trunc(entry[key]);
    }
    for (const key of JACKPOT_POT_NUMBER_FIELDS) {
      if (Number.isFinite(entry[key]) && entry[key] >= 0) pot[key] = entry[key];
    }
    out.push(pot);
  }
  return out;
}

/**
 * Mirrors `normalizeMockEngineJackpot` in the editor's `electron/main.js`.
 * Returns undefined for an absent/malformed value, which keeps the key off the
 * config entirely — and with no `jackpot` key nothing is ever injected, so
 * every response stays byte-identical to a project that never opted in.
 *
 * @param {any} raw
 * @returns {{ enabled: boolean, networkName?: string, configVersion?: number, forceWin?: boolean, forceWinTierId?: number, pots?: Array<Record<string, unknown>> } | undefined}
 */
function normaliseJackpotConfig(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = { enabled: raw.enabled === true };
  if (typeof raw.networkName === 'string' && raw.networkName.trim()) out.networkName = raw.networkName.trim();
  if (Number.isFinite(raw.configVersion) && raw.configVersion > 0) out.configVersion = Math.trunc(raw.configVersion);
  if (raw.forceWin === true) out.forceWin = true;
  if (Number.isFinite(raw.forceWinTierId) && raw.forceWinTierId > 0) out.forceWinTierId = Math.trunc(raw.forceWinTierId);
  const pots = normaliseJackpotPots(raw.pots);
  if (pots.length > 0) out.pots = pots;
  return out;
}

/**
 * Coerce a raw `projectSettings.mockEngine` blob into the canonical shape.
 * Returns null when the field is absent/malformed (→ mock engine off).
 *
 * @param {any} raw
 * @returns {{ enabled: boolean, mechanic: string, seed?: number, startingBalance?: number, currencyCode?: string, jackpot?: object } | null}
 */
function normaliseMockEngineConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const mechanic =
    typeof raw.mechanic === 'string' && raw.mechanic.trim() ? raw.mechanic.trim() : DEFAULT_MECHANIC;
  const config = { enabled: raw.enabled === true, mechanic };

  if (Number.isFinite(raw.seed)) config.seed = Math.trunc(raw.seed);
  if (Number.isFinite(raw.startingBalance)) config.startingBalance = Math.trunc(raw.startingBalance);
  if (typeof raw.currencyCode === 'string' && raw.currencyCode.trim()) {
    config.currencyCode = raw.currencyCode.trim();
  }
  const jackpot = normaliseJackpotConfig(raw.jackpot);
  if (jackpot !== undefined) config.jackpot = jackpot;

  return config;
}

function readMockEngineConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MAIN_ORCA_PATH, 'utf-8'));
    return normaliseMockEngineConfig(parsed && parsed.projectSettings && parsed.projectSettings.mockEngine);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      console.warn('[mock-engine] Failed to read mockEngine config from main.orca:', err.message);
    }
    return null;
  }
}

/**
 * mtime-gated cache around `readMockEngineConfig()`, mirroring
 * `readActiveSkinCached` in `orca-project-assets.js`: `main.orca` is re-stat'd
 * per request (cheap) but only re-parsed when it actually changed, so the
 * editor's `set-mock-engine-config` IPC is picked up without a restart.
 */
let _configCache = { mtimeMs: -1, value: null };

function readMockEngineConfigCached() {
  try {
    const stat = fs.statSync(MAIN_ORCA_PATH);
    if (stat.mtimeMs !== _configCache.mtimeMs) {
      _configCache = { mtimeMs: stat.mtimeMs, value: readMockEngineConfig() };
    }
    return _configCache.value;
  } catch (err) {
    // main.orca missing/unreadable — treat as "no mock engine".
    _configCache = { mtimeMs: -1, value: null };
    return null;
  }
}

/**
 * `<project>/mock-engine/settings/<mechanic>.json`, or null when the mechanic
 * key is not a safe single path segment.
 *
 * @param {string} mechanic
 * @returns {string | null}
 */
function mechanicSettingsPath(mechanic) {
  if (!MECHANIC_KEY_RE.test(String(mechanic || ''))) return null;
  return path.join(MOCK_ENGINE_SETTINGS_DIR, `${mechanic}.json`);
}

let _settingsCache = { file: '', mtimeMs: -1, value: null };

/**
 * mtime-gated read of a mechanic's generated settings overrides, mirroring
 * `readMockEngineConfigCached`. A missing file is the normal case (no
 * overrides); a malformed one warns and falls back to the defaults.
 *
 * @param {string} mechanic
 * @returns {{ mtimeMs: number, value: Record<string, unknown> | null }}
 */
function readMechanicSettingsCached(mechanic) {
  const file = mechanicSettingsPath(mechanic);
  if (file === null) return { mtimeMs: -1, value: null };

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    _settingsCache = { file, mtimeMs: -1, value: null };
    return _settingsCache;
  }

  if (file !== _settingsCache.file || stat.mtimeMs !== _settingsCache.mtimeMs) {
    let value = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
      else console.warn(`[mock-engine] settings/${mechanic}.json is not a JSON object; using defaults`);
    } catch (err) {
      console.warn(`[mock-engine] Failed to parse settings/${mechanic}.json; using defaults:`, err && err.message);
    }
    _settingsCache = { file, mtimeMs: stat.mtimeMs, value };
  }
  return _settingsCache;
}

/**
 * Merge generated overrides onto a settings INSTANCE (its prototype carries
 * `toResponseGameSettings`, so the instance is mutated rather than replaced).
 *
 * @param {any} settings
 * @param {Record<string, unknown>} overrides
 */
function applySettingsOverrides(settings, overrides) {
  for (const key of Object.keys(overrides)) {
    if (UNSAFE_SETTINGS_KEYS.has(key)) continue;
    settings[key] = overrides[key];
  }
  return settings;
}

// 0 = not attempted, 1 = installed, -1 = unavailable (never retried).
let _tsHookState = 0;

/**
 * Containment test shared by the `.ts` require hook and the require-cache
 * purge: is `filename` inside `mock-engine/src`? Anything else is not ours to
 * compile — and, critically, not ours to evict from `require.cache`.
 *
 * @param {string} filename
 * @returns {boolean}
 */
function isInsideMockEngineSrc(filename) {
  const rel = path.relative(MOCK_ENGINE_SRC_DIR, filename);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Bounds on the source walk so a pathological tree can never stall a request. */
const SOURCE_STAMP_MIN_INTERVAL_MS = 1000;
const SOURCE_STAMP_MAX_FILES = 4000;
const SOURCE_STAMP_MAX_DEPTH = 16;

/**
 * A cheap fingerprint of `mock-engine/src/**`: file count + newest mtime.
 * Agent-GENERATED mechanics are written straight into that tree, and unlike the
 * config/settings JSON there is no single file to stat — so we walk it,
 * skipping `node_modules` and dot-dirs and bailing at the bounds above.
 *
 * Count-plus-newest only misses the pathological "delete one file and add an
 * older-mtime one in the same tick" case; a real edit or a new mechanic folder
 * always moves one of the two.
 *
 * @returns {string}
 */
function computeMockEngineSourceStamp() {
  let files = 0;
  let newest = 0;
  const stack = [{ dir: MOCK_ENGINE_SRC_DIR, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // missing or unreadable — treat as empty.
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < SOURCE_STAMP_MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      if (files > SOURCE_STAMP_MAX_FILES) return `${files}:${newest}:capped`;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch { /* vanished mid-walk */ }
    }
  }

  return `${files}:${newest}`;
}

let _sourceStampCache = { checkedAt: -1, value: '' };

/**
 * Time-debounced `computeMockEngineSourceStamp()`. The middleware runs on every
 * dev-server request, so the walk is rate-limited to one per
 * SOURCE_STAMP_MIN_INTERVAL_MS — the same "cheap gate, no restart needed"
 * posture as the mtime-gated config/settings caches, just clock-gated instead
 * of gated on one file's mtime. Only ever reached once the project has opted
 * in, so a project with the mock engine off does no work at all. A walk failure
 * keeps the last stamp, which keeps the loaded module.
 *
 * @returns {string}
 */
function readMockEngineSourceStampCached() {
  const now = Date.now();
  if (_sourceStampCache.checkedAt >= 0 && now - _sourceStampCache.checkedAt < SOURCE_STAMP_MIN_INTERVAL_MS) {
    return _sourceStampCache.value;
  }
  let value = _sourceStampCache.value;
  try {
    value = computeMockEngineSourceStamp();
  } catch (err) {
    console.warn('[mock-engine] Failed to stamp mock-engine/src; keeping the loaded module:', err && err.message);
  }
  _sourceStampCache = { checkedAt: now, value };
  return value;
}

/**
 * Evict every transpiled `mock-engine/src` module from Node's require cache so
 * the next `require(MOCK_ENGINE_ENTRY)` re-reads (and re-transpiles) the tree.
 * Scoped by the SAME containment test as the `.ts` hook, so nothing outside
 * `mock-engine/src` is ever touched.
 */
function purgeMockEngineRequireCache() {
  for (const filename of Object.keys(require.cache)) {
    if (!isInsideMockEngineSrc(filename)) continue;
    delete require.cache[filename];
  }
}

function installTypeScriptRequireHook() {
  if (_tsHookState !== 0) return _tsHookState === 1;

  let ts;
  try {
    ts = require('typescript');
  } catch (err) {
    console.warn('[mock-engine] `typescript` is not installed; mock engine disabled:', err.message);
    _tsHookState = -1;
    return false;
  }

  const compilerOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2019,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    inlineSourceMap: true,
  };

  const previous = require.extensions['.ts'];
  require.extensions['.ts'] = function compileMockEngineTypeScript(module, filename) {
    // Containment: only mock-engine sources are ours to compile. The SAME test
    // gates the require-cache purge, so the two can never disagree.
    if (!isInsideMockEngineSrc(filename)) {
      if (typeof previous === 'function') return previous(module, filename);
      throw new Error(`[mock-engine] Refusing to compile TypeScript outside mock-engine/src: ${filename}`);
    }
    const source = fs.readFileSync(filename, 'utf-8');
    const transpiled = ts.transpileModule(source, { compilerOptions, fileName: filename });
    module._compile(transpiled.outputText, filename);
  };

  _tsHookState = 1;
  return true;
}

// undefined = not attempted, null = unavailable. Reloaded IN PLACE whenever the
// source stamp moves, so a newly written mechanic goes live without a restart.
let _mockEngineModule;
let _loadedSourceStamp = null;

function loadMockEngineModule() {
  const stamp = readMockEngineSourceStampCached();
  if (_mockEngineModule !== undefined && stamp === _loadedSourceStamp) return _mockEngineModule;

  const isReload = _mockEngineModule !== undefined;
  const lastGood = isReload ? _mockEngineModule : null;
  // Pinned BEFORE the attempt so a failing tree is retried only once per edit
  // rather than on every request.
  _loadedSourceStamp = stamp;

  try {
    if (!fs.existsSync(MOCK_ENGINE_ENTRY)) {
      if (!isReload) console.warn('[mock-engine] mock-engine/src/index.ts not found; mock engine disabled');
      _mockEngineModule = null;
      return _mockEngineModule;
    }
    if (!installTypeScriptRequireHook()) {
      _mockEngineModule = null;
      return _mockEngineModule;
    }

    // A reload has to start from a clean cache or `require` just hands back the
    // modules transpiled from the PREVIOUS sources.
    if (isReload) purgeMockEngineRequireCache();
    _mockEngineModule = require(MOCK_ENGINE_ENTRY);
    console.log(
      isReload
        ? '[mock-engine] reloaded mock-engine/src after a source change'
        : '[mock-engine] loaded mock-engine/src (transpiled in-process)'
    );
  } catch (err) {
    // `ts.transpileModule` does NO type checking, so a generated mechanic with a
    // syntax error — or one that throws while registering — lands HERE, at
    // require time. Keep the LAST-GOOD module instead of half-registering a
    // broken tree: the engine carries on serving what it was serving, and the
    // next source edit retries automatically because the stamp moves again.
    console.warn(
      `[mock-engine] Failed to ${isReload ? 'reload' : 'load'} mock-engine/src` +
        `${lastGood ? '; keeping the previously loaded engine' : '; it is disabled'}:`,
      (err && err.stack) || (err && err.message) || err
    );
    _mockEngineModule = lastGood;
  }

  return _mockEngineModule;
}

/** The mechanic keys the bundled catalog exposes; `[]` when it failed to load. */
function listMechanicKeys() {
  const mod = loadMockEngineModule();
  if (mod === null || !Array.isArray(mod.MECHANIC_CATALOG)) return [];
  return mod.MECHANIC_CATALOG.map((entry) => entry && entry.key).filter(Boolean);
}

/**
 * Editor jackpot config → the engine's own `MockJackpotConfig`.
 *
 * Pot entries are SPARSE per-tier overrides: each is merged over the entry with
 * the same `TierId` from the engine's `createDefaultJackpotPots()`, so a tier
 * the editor only partly filled keeps its default odds / contribution rather
 * than silently falling back to zero. Tiers with no override keep their
 * defaults; an unknown `TierId` is appended as-is for the service to normalise.
 *
 * @param {any} mod the loaded mock-engine module
 * @param {{ networkName?: string, configVersion?: number, forceWin?: boolean, forceWinTierId?: number, pots?: Array<Record<string, unknown>> }} jackpot
 */
function buildJackpotOptions(mod, jackpot) {
  const options = { enabled: true };
  if (jackpot.networkName !== undefined) options.networkName = jackpot.networkName;
  if (jackpot.configVersion !== undefined) options.configVersion = jackpot.configVersion;
  if (jackpot.forceWin === true) {
    options.debug = { ForceWin: true };
    if (jackpot.forceWinTierId !== undefined) options.debug.WinningPotTierId = jackpot.forceWinTierId;
  }

  const overrides = Array.isArray(jackpot.pots) ? jackpot.pots : [];
  if (overrides.length > 0) {
    const defaults = typeof mod.createDefaultJackpotPots === 'function' ? mod.createDefaultJackpotPots() : [];
    const merged = defaults.map((pot) => {
      const override = overrides.find((candidate) => candidate.TierId === pot.TierId);
      return override ? { ...pot, ...override } : pot;
    });
    for (const override of overrides) {
      if (!merged.some((pot) => pot.TierId === override.TierId)) merged.push(override);
    }
    options.pots = merged;
  }

  return options;
}

/**
 * Build a MockEngine for `config`. Importing `mock-engine/src` already
 * registered every mechanic under its own default skin (`LinesSlot`, …); we
 * additionally register the SELECTED mechanic under the project's active skin
 * so the game's own `POST /{gameId}/begin` calls resolve too.
 *
 * When `mock-engine/settings/<mechanic>.json` exists, both registrations are
 * re-run with the overrides merged over the mechanic's defaults. The registry
 * key is pinned to the DEFAULT `ActiveVersion` so a tuned version string
 * replaces the mechanic's own registration instead of adding an unreachable one.
 */
function createEngine(mod, config) {
  const catalog = Array.isArray(mod.MECHANIC_CATALOG) ? mod.MECHANIC_CATALOG : [];
  const entry = catalog.find((candidate) => candidate && candidate.key === config.mechanic);
  if (entry === undefined) {
    throw new Error(`Unknown mechanic "${config.mechanic}" (available: ${catalog.map((c) => c.key).join(', ')})`);
  }

  const overrides = readMechanicSettingsCached(config.mechanic).value;
  const registration = {};
  if (overrides) {
    const defaults = entry.createDefaultSettings();
    registration.version = defaults.ActiveVersion;
    registration.settings = applySettingsOverrides(defaults, overrides);
    entry.register({ ...registration });
    console.log(`[mock-engine] applied ${Object.keys(overrides).length} generated setting(s) from settings/${config.mechanic}.json`);
  }

  const activeSkin = readActiveSkinCached();
  if (activeSkin) entry.register({ ...registration, skin: activeSkin });

  const options = {};
  if (config.seed !== undefined) options.seed = config.seed;
  if (config.startingBalance !== undefined) options.startingBalance = config.startingBalance;
  if (config.currencyCode !== undefined) options.currencyCode = config.currencyCode;
  // Anything short of an explicit opt-in leaves `options.jackpot` unset, which
  // is what keeps the `Jackpot` member off every response.
  if (config.jackpot && config.jackpot.enabled === true) {
    try {
      options.jackpot = buildJackpotOptions(mod, config.jackpot);
      console.log('[mock-engine] jackpots enabled; responses will carry a Jackpot member');
    } catch (err) {
      console.warn('[mock-engine] Failed to build the jackpot config; jackpots stay off:', err && err.message);
      delete options.jackpot;
    }
  }

  console.log(
    `[mock-engine] serving mechanic "${config.mechanic}" as POST /{${activeSkin || entry.key},…}/begin|continue|resume|potvalues`
  );
  return new mod.MockEngine(options);
}

/**
 * Express-style dev-server middleware hosting the bundled mock arcade engine
 * at the SAME routes the real engine uses:
 *
 *   POST /{game}/begin | continue | resume | potvalues
 *   GET  /diagnostics
 *   GET  /ping
 *
 * Registered UNCONDITIONALLY by `webpack.dev.conf.js` but inert until the
 * project opts in — it `next()`s immediately while
 * `projectSettings.mockEngine.enabled` is not true, and on ANY load failure.
 * The engine is constructed lazily on the first enabled request and rebuilt
 * whenever the mechanic/seed/balance/currency changes.
 *
 * @returns {(req: any, res: any, next: Function) => void}
 */
function createMockEngineDevMiddleware() {
  let inner; // undefined = not built, null = unavailable
  let innerMod = null; // the module `inner` closed over; a reload must rebuild it
  let engine = null;
  let engineKey = '';

  /**
   * Drop the built engine. Called on the DISABLED path, so switching the mock
   * backend off and on again starts a genuinely fresh fake session.
   *
   * The engine holds the whole fake backend's state in memory — wallet balance,
   * session/token ids, the in-flight round, jackpot pot values. Without this the
   * instance simply survived the off period (the disabled path returns before
   * `resolveEngine` is ever reached, so the cache key it is compared against is
   * never even computed) and the first `resume` after a re-enable replayed the
   * PREVIOUS session's bonus/round state. Nothing is persisted, so dropping the
   * reference is the whole reset.
   *
   * ⚠️ KNOWN WINDOW — the reset needs the disabled config to be OBSERVED, and
   * this middleware only observes on a request. Toggling off and straight back
   * on with ZERO dev-server requests in between leaves the previous session
   * standing: `config.enabled` is in the engine cache key below, but the
   * disabled path returns before that key is computed, and the re-enabled key
   * matches the one already held. Not reachable from the editor, which answers
   * a toggle with one game-webview reload — dozens of requests through here
   * while the config reads disabled — but reachable by hand-editing `main.orca`
   * with the preview closed. Closing it properly needs a signal this file does
   * not have: folding `main.orca`'s mtime into the key would reset the fake
   * wallet on every unrelated project write. Asserted in
   * `scripts/test-mock-engine-offline.cjs` so it stays legible.
   */
  const resetEngine = () => {
    if (engine === null && engineKey === '') return;
    engine = null;
    engineKey = '';
    console.log('[mock-engine] disabled; dropped the fake session (a re-enable starts fresh)');
  };

  const resolveEngine = (mod) => {
    const config = readMockEngineConfigCached();
    if (config === null) throw new Error('mockEngine config disappeared from main.orca');
    const settingsStamp = readMechanicSettingsCached(config.mechanic).mtimeMs;
    // `_loadedSourceStamp` is what makes a newly written mechanic take effect:
    // after a reload the cached engine holds catalog entries belonging to the
    // PREVIOUS module instance, so it has to be rebuilt. `config.enabled` is in
    // the key as well, so an off→on transition can never match a stale key even
    // if `resetEngine` were ever bypassed.
    const key = JSON.stringify([
      config.enabled,
      config.mechanic,
      config.seed,
      config.startingBalance,
      config.currencyCode,
      config.jackpot,
      settingsStamp,
      _loadedSourceStamp,
    ]);
    if (engine === null || key !== engineKey) {
      let next;
      try {
        next = createEngine(mod, config);
      } catch (err) {
        // A generated mechanic that registers badly (or an unknown key) must not
        // leave a half-built engine behind. Pin the key so we don't rebuild-thrash
        // on every request; the next config/settings/source change moves it again.
        engineKey = key;
        console.warn(
          `[mock-engine] Failed to build the engine for mechanic "${config.mechanic}":`,
          (err && err.stack) || (err && err.message) || err
        );
        if (engine === null) throw err; // nothing to fall back on
        console.warn('[mock-engine] keeping the previously built engine');
        return engine;
      }
      engine = next;
      engineKey = key;
    }
    return engine;
  };

  return function mockEngineDevMiddleware(req, res, next) {
    const config = readMockEngineConfigCached();
    if (config === null || !config.enabled) {
      resetEngine();
      return next();
    }

    const mod = loadMockEngineModule();
    if (mod === null) return next();

    // `inner` closes over `mod`, so a source reload (new module identity) has to
    // rebuild it. A build FAILURE sticks until the next reload — same
    // never-retry-on-the-hot-path posture as before.
    if (inner === undefined || mod !== innerMod) {
      innerMod = mod;
      try {
        inner = mod.createMockEngineMiddleware(() => resolveEngine(mod));
      } catch (err) {
        console.warn('[mock-engine] Failed to build the mock-engine middleware:', err && err.message);
        inner = null;
      }
    }
    if (!inner) return next();

    try {
      return inner(req, res, next);
    } catch (err) {
      console.warn('[mock-engine] Request failed; falling through:', err && err.message);
      return next();
    }
  };
}

module.exports = {
  DEFAULT_MECHANIC,
  normaliseMockEngineConfig,
  readMockEngineConfig,
  readMockEngineConfigCached,
  readMechanicSettingsCached,
  listMechanicKeys,
  createMockEngineDevMiddleware,
};
