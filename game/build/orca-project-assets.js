/**
 * Resolve the on-disk directories that hold runtime asset files
 * (spine skeletons/atlases, textures, fonts, etc.) for the active skin.
 *
 * Background
 * ──────────
 * The game folder is the build-output SOURCE OF TRUTH. The running game
 * MUST resolve every asset from inside the game folder and NEVER reach
 * back into the editor's authoring tree (`<project>/orca-project-files/`).
 *
 * The editor's `sync-skin-assets` IPC owns the runtime mirror: on every
 * scene save it bakes the referenced binaries (stripping `.meta` GUID
 * sidecars and never copying authoring sidecars or authoring dirs) into
 *   <project>/game/src/core/assets/...
 *   <project>/game/src/skins/<skin>/assets/...
 * and PRUNES stale files there. That mirror is the only thing the runtime
 * is allowed to read.
 *
 * The mirror is NAMESPACED under `assets/`: a scene/graph ref `R` (the
 * VERBATIM bucket-relative subpath, e.g. `1.png`, `Spine/x.png`,
 * `assets/generated/y.png`) is mirrored to
 *   <project>/game/src/<bucket>/assets/<R>
 * Serving `<project>/game/src/<bucket>/assets` at the `/assets` publicPath
 * therefore gives a clean 1:1 mapping `/assets/<R>` →
 * `game/src/<bucket>/assets/<R>`.
 *
 * This module exposes:
 *   getOrcaProjectAssetRoots()
 *     → [{ directory, publicPath, label }]
 *
 * Each entry is a real on-disk directory that should be served at the
 * `/assets` publicPath by the dev server (and copied into the dist bundle
 * by the prod config). The active skin is read from
 * `<project>/orca-project-files/main.orca` once at config load — the only
 * thing still read from the authoring tree, and purely to pick which
 * skin's mirror to serve. main.orca is OPTIONAL here: a build that runs where
 * it is unreachable (CI building only `game/`, another checkout layout) falls
 * back to the committed game folder — the skin table in the generated
 * `game/src/core/services/orca/active-skin.ts` (`readGameSkinTable`,
 * `DEFAULT_SKIN` for the active skin), plus the `game/src/skins/<folder>/assets`
 * dirs on disk for the per-skin prod copy.
 *
 * The active skin's mirror is listed FIRST so that on a name
 * collision it overrides core (matching the runtime's
 * "skin-overlays-core" model).
 */

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ORCA_PROJECT_FILES_DIR = path.join(PROJECT_ROOT, 'orca-project-files');
const MAIN_ORCA_PATH = path.join(ORCA_PROJECT_FILES_DIR, 'main.orca');
const GAME_SRC_DIR = path.join(PROJECT_ROOT, 'game', 'src');
const ACTIVE_SKIN_TS_REL = 'game/src/core/services/orca/active-skin.ts';
const ACTIVE_SKIN_TS_PATH = path.join(PROJECT_ROOT, ...ACTIVE_SKIN_TS_REL.split('/'));

const _warned = new Set();
function warnOnce(message) {
  if (_warned.has(message)) return;
  _warned.add(message);
  console.warn(`[orca-project-assets] ${message}`);
}

/**
 * Parse main.orca. Never throws: `{ main: null, reason }` when it is missing,
 * unreadable or not a JSON object, so callers can fall back to the game folder.
 *
 * @returns {{ main: object | null, reason: string }}
 */
function readMainOrca() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MAIN_ORCA_PATH, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') {
      return { main: null, reason: `${MAIN_ORCA_PATH} is not a JSON object` };
    }
    return { main: parsed, reason: '' };
  } catch (err) {
    const reason = err && err.code === 'ENOENT'
      ? `${MAIN_ORCA_PATH} not found`
      : `${MAIN_ORCA_PATH} unreadable (${err && err.message})`;
    return { main: null, reason };
  }
}

// A skin folder name taken from disk or generated source must be one path segment.
function isSafeSkinFolder(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' &&
    !/[\\/\0]/.test(name);
}

/**
 * `DEFAULT_SKIN` from the generated, committed `active-skin.ts` — the editor's
 * active skin's effective folder, emitted by `ensureRuntimeActiveSkinFile` as
 * `export const DEFAULT_SKIN: string = '<folder>';` (only `\` and `'` escaped).
 * Pre-multi-skin files carried a literal `ACTIVE_SKIN` instead. '' when absent.
 *
 * @returns {string}
 */
function readDefaultSkinFromGeneratedFile() {
  let src;
  try { src = fs.readFileSync(ACTIVE_SKIN_TS_PATH, 'utf-8'); } catch (err) { return ''; }
  const match =
    src.match(/^export\s+const\s+DEFAULT_SKIN\s*(?::\s*string\s*)?=\s*'((?:[^'\\\r\n]|\\.)*)'\s*;/m) ||
    src.match(/^export\s+const\s+ACTIVE_SKIN\s*(?::\s*string\s*)?=\s*'((?:[^'\\\r\n]|\\.)*)'\s*;/m);
  if (!match) return '';
  const folder = match[1].replace(/\\(.)/g, '$1');
  return isSafeSkinFolder(folder) ? folder : '';
}

/**
 * Every `game/src/skins/<folder>` that has an `assets/` mirror dir, sorted.
 *
 * @returns {string[]}
 */
function listOnDiskSkinFolders() {
  const skinsDir = path.join(GAME_SRC_DIR, 'skins');
  let entries;
  try { entries = fs.readdirSync(skinsDir); } catch (err) { return []; }
  const folders = [];
  for (const name of entries) {
    if (name.startsWith('.') || !isSafeSkinFolder(name)) continue;
    try {
      if (fs.statSync(path.join(skinsDir, name, 'assets')).isDirectory()) folders.push(name);
    } catch (err) {
      // No mirror for this skin.
    }
  }
  return folders.sort();
}

/**
 * The bundle's skin table from the editor-generated `active-skin.ts`, for a
 * build of `game/` on its own (a CI checkout without `orca-project-files/`),
 * where main.orca cannot name the skins and every skin's assets used to be
 * left out of the build without a word. Null when the file is missing.
 *
 * @returns {{ defaultSkin: string, skins: Array<{ folder: string, realName: string, isJackpot: boolean }>, jackpotTiles: Array<{ tile: string, folder: string }> } | null}
 */
function readGameSkinTable() {
  let source;
  try {
    source = fs.readFileSync(ACTIVE_SKIN_TS_PATH, 'utf-8');
  } catch (err) {
    return null;
  }
  const skins = [];
  const row = /(['"])([A-Za-z0-9_.-]+)\1\s*:\s*\{\s*realName:\s*(['"])([^'"]*)\3[^}]*?\bisJackpot:\s*(true|false)/g;
  for (let match = row.exec(source); match; match = row.exec(source)) {
    skins.push({ folder: match[2], realName: match[4], isJackpot: match[5] === 'true' });
  }
  const declared = (source.match(/\brealName:\s*['"]/g) || []).length;
  if (declared !== skins.length) {
    // A skin left out here is a skin whose assets the build leaves out.
    warnOnce(
      `Read ${skins.length} of the ${declared} skins in ${ACTIVE_SKIN_TS_REL}. ` +
      'The file may come from a newer editor: open the project in Orca to update game/build/.'
    );
  }
  const fallback = source.match(/\bDEFAULT_SKIN\s*:\s*string\s*=\s*(['"])([^'"]*)\1/);
  // A "Both" game's jackpot launcher tile: not a skin row (its own row says
  // isJackpot: false), but the bundle still ships jackpots for it.
  const jackpotTiles = [];
  const tilesBlock = source.match(/\bJACKPOT_TILES\b[^=]*=\s*\{([^}]*)\}/);
  if (tilesBlock) {
    const pair = /(['"])([A-Za-z0-9_.-]+)\1\s*:\s*(['"])([A-Za-z0-9_.-]+)\3/g;
    for (let match = pair.exec(tilesBlock[1]); match; match = pair.exec(tilesBlock[1])) {
      jackpotTiles.push({ tile: match[2], folder: match[4] });
    }
  }
  return { defaultSkin: fallback ? fallback[2] : '', skins, jackpotTiles };
}

/**
 * Slugify a user-entered skin "override" (tileName) into a runtime folder
 * name candidate. MUST stay byte-identical to `slugifySkinFolder` in the
 * editor's `electron/skin-data-index.js` (which renames the runtime skin
 * folder + regenerates `active-skin.ts`). Lowercase, trim,
 * spaces/underscores → '-', strip any character outside [a-z0-9-], collapse
 * repeated '-', trim leading/trailing '-'. Returns '' when nothing valid
 * remains.
 */
function slugifySkinFolder(value) {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The RUNTIME folder name for a skin. THREE-rung precedence ladder:
 *
 *   1. `runtimeGameId` — used VERBATIM (trimmed, NEVER slugged). This is the
 *      real backend `gameId` captured from the shell launcher tile; the shell
 *      launches the game with `currentSkin = <gameId>` and the runtime does
 *      `@/src/skins/${currentSkin}`, so the folder must equal it byte-for-byte.
 *   2. `slugifySkinFolder(tileName)` — the slug of the user-entered "Skin
 *      override".
 *   3. `skin.name` — the real (immutable) authoring name.
 *
 * ⚠️ DUPLICATED IMPLEMENTATION. The SOURCE OF TRUTH is `effectiveSkinFolder`
 * in the editor's `electron/skin-data-index.js` (see also AGENTS.md rule 14);
 * this copy exists only because the game's build scripts cannot import from
 * the editor. Both this function and `slugifySkinFolder` above MUST stay
 * byte-equivalent to that reference.
 *
 * ⚠️ A DRIFT HERE FAILS SILENTLY IN PRODUCTION. `readActiveSkin()` feeds
 * `getOrcaProjectScopedAssetRoots()`, whose CopyWebpackPlugin patterns set
 * `noErrorOnMissing: true` — so if this resolves the WRONG folder the source
 * dir simply does not exist, webpack copies NOTHING without warning, and
 * every skin-scoped asset 404s at `/assets/skins/<skin>/<ref>` in the
 * packaged build. Meanwhile the editor's `sync-skin-assets` writes the
 * mirror to the CORRECT folder (it goes through the reference
 * implementation) and `ACTIVE_SKIN` in the generated `active-skin.ts` is
 * likewise correct — i.e. the mirror is populated at one path and the build
 * reads from another. (Historically this copy omitted rung 1 entirely.)
 *
 * @param {{ name?: string, tileName?: string, runtimeGameId?: string }} skin
 * @returns {string}
 */
function effectiveSkinFolder(skin) {
  if (!skin || typeof skin !== 'object') return '';
  // A verbatim runtime gameId wins outright — never slugged.
  if (typeof skin.runtimeGameId === 'string' && skin.runtimeGameId.trim()) {
    return skin.runtimeGameId.trim();
  }
  const slug = slugifySkinFolder(skin.tileName);
  return slug || (typeof skin.name === 'string' ? skin.name : '');
}

/**
 * The active skin's RUNTIME folder name (the "effective folder"). NOTE:
 * `main.orca.activeSkin` stores the skin's IMMUTABLE real `name`, but the
 * runtime folder is renamed to the effective folder
 * (`runtimeGameId || slug(tileName) || name`) whenever a backend gameId is
 * captured or a skin override is set. We therefore resolve the active skin
 * object and return its effective folder so the mirror we serve/copy matches
 * what the runtime requests.
 *
 * When main.orca is unreachable, falls back to `DEFAULT_SKIN` in the generated
 * `active-skin.ts` (the same effective folder, as last emitted by the editor).
 */
function readActiveSkin() {
  const { main, reason } = readMainOrca();
  if (main) {
    const activeName = typeof main.activeSkin === 'string' ? main.activeSkin : '';
    if (!activeName) return '';
    const skins = Array.isArray(main.skins) ? main.skins : [];
    const activeSkin = skins.find((s) => s && s.name === activeName);
    return activeSkin ? effectiveSkinFolder(activeSkin) : activeName;
  }
  const fallback = readDefaultSkinFromGeneratedFile();
  if (fallback) {
    warnOnce(`${reason}; using DEFAULT_SKIN '${fallback}' from ${ACTIVE_SKIN_TS_REL} as the active skin.`);
  } else {
    warnOnce(`${reason} and no DEFAULT_SKIN in ${ACTIVE_SKIN_TS_REL}; no active skin — unscoped /assets refs resolve against core only.`);
  }
  return fallback;
}

/**
 * EVERY skin's RUNTIME folder name (effective folder), in `main.orca` order.
 *
 * A production bundle now carries every skin and picks one at boot from
 * `?skin=<gameId>`, so the prod scoped asset copy must cover them ALL — a skin
 * the shell can launch but whose mirror was never copied 404s in total silence
 * (`noErrorOnMissing: true`). Duplicates and blanks are dropped.
 *
 * The GAME FOLDER is authoritative: every `game/src/skins/<folder>` with an
 * `assets/` dir is included even when main.orca is unreachable or does not list
 * it, so this never returns fewer folders than exist on disk. main.orca's
 * folders come first (including skins whose mirror does not exist yet).
 *
 * @returns {string[]}
 */
function getAllSkinFolders() {
  const { main, reason } = readMainOrca();
  const fromMain = [];
  if (main) {
    const skins = Array.isArray(main.skins) ? main.skins : [];
    for (const skin of skins) {
      const folder = effectiveSkinFolder(skin);
      if (folder) fromMain.push(folder);
    }
  }
  const onDisk = listOnDiskSkinFolders();
  if (fromMain.length === 0 && onDisk.length > 0) {
    warnOnce(
      `${main ? `${MAIN_ORCA_PATH} lists no skins` : reason}; ` +
      `copying the skin asset mirrors found under game/src/skins/: ${onDisk.join(', ')}.`,
    );
  }
  return Array.from(new Set([...fromMain, ...onDisk]));
}

/**
 * mtime-gated cache around `readActiveSkin()` for the per-request dev
 * middleware. `main.orca` is re-stat'd on every `/assets` request (cheap),
 * but its contents are only re-parsed when the mtime changes — so a skin
 * switch (which rewrites `main.orca`) is picked up WITHOUT a dev-server
 * restart, while steady-state asset bursts don't re-parse the file. With no
 * main.orca the generated `active-skin.ts` is the gate instead.
 */
let _activeSkinCache = { key: '', value: '' };

function readActiveSkinCached() {
  let key;
  try {
    key = `orca:${fs.statSync(MAIN_ORCA_PATH).mtimeMs}`;
  } catch (err) {
    try { key = `ts:${fs.statSync(ACTIVE_SKIN_TS_PATH).mtimeMs}`; } catch (e) { key = 'none'; }
  }
  if (key !== _activeSkinCache.key) {
    _activeSkinCache = { key, value: readActiveSkin() };
  }
  return _activeSkinCache.value;
}

/**
 * Ordered runtime-mirror asset directories for the CURRENT active skin,
 * resolved fresh (mtime-cached) on each call: active-skin mirror FIRST so
 * it overrides core on a same-name collision, core mirror LAST. Used by the
 * per-request dev `/assets` middleware so a mid-session skin switch is
 * reflected without a server restart.
 *
 * @returns {string[]} absolute directory paths, priority order.
 */
function getActiveSkinAssetDirsFresh() {
  const dirs = [];
  const activeSkin = readActiveSkinCached();
  if (activeSkin) {
    dirs.push(path.join(GAME_SRC_DIR, 'skins', activeSkin, 'assets'));
  }
  dirs.push(path.join(GAME_SRC_DIR, 'core', 'assets'));
  return dirs;
}

const ASSETS_PUBLIC_PATH = '/assets';

/**
 * Build an Express-style dev-server middleware that serves `/assets/<ref>`
 * with SCOPE-QUALIFIED resolution so a core ref and an active-skin ref that
 * share a basename never collide.
 *
 * Resolution order for a request path P (after stripping the `/assets`
 * publicPath prefix → `rest`):
 *
 *   a. SCOPED CORE — `rest` starts with `core/`:
 *        serve `game/src/core/assets/<rest without 'core/'>` if it exists.
 *   b. SCOPED SKIN — `rest` matches `skins/<name>/<remainder>`:
 *        serve `game/src/skins/<name>/assets/<remainder>` if it exists.
 *   c. UNSCOPED FALLBACK — neither scope prefix (legacy refs, e.g. audio /
 *        fonts that are emitted WITHOUT a scope): resolve `rest` against the
 *        CURRENT active skin's mirror FIRST, then core (the historical
 *        skin-overlays-core behaviour, preserved exactly).
 *   d. Honest 404 — present in none of the above. We do NOT call `next()`
 *        (which could reach the SPA history fallback) and never serve
 *        `index.html` for a missing asset.
 *
 * The active skin is re-read (mtime-gated) PER REQUEST, so a mid-session
 * skin switch is reflected without a dev-server restart.
 *
 * @returns {(req: any, res: any, next: Function) => void}
 */
function createOrcaAssetsDevMiddleware() {
  return function orcaAssetsDevMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // `req.path` is percent-encoded; decode the pathname only.
    let pathname;
    try {
      pathname = decodeURIComponent(req.path || (req.url || '').split('?')[0] || '');
    } catch (e) {
      pathname = req.path || '';
    }

    if (pathname !== ASSETS_PUBLIC_PATH && !pathname.startsWith(ASSETS_PUBLIC_PATH + '/')) {
      return next();
    }

    // Strip the `/assets` publicPath prefix → (scoped or bare) ref.
    let rest = pathname.slice(ASSETS_PUBLIC_PATH.length);
    if (rest.startsWith('/')) rest = rest.slice(1);
    if (!rest) return next();

    // Try a single mirror dir + relative ref; serve on hit, else null.
    // Returns true when the response was sent.
    const tryServe = (dir, relRef) => {
      if (!relRef) return false;
      const candidate = path.join(dir, relRef);
      const relFromDir = path.relative(dir, candidate);
      // Containment guard: never let a `..` ref escape the mirror root.
      if (relFromDir.startsWith('..') || path.isAbsolute(relFromDir)) return false;
      try {
        if (fs.statSync(candidate).isFile()) {
          res.sendFile(candidate);
          return true;
        }
      } catch (e) {
        // Not in this mirror.
      }
      return false;
    };

    // (a) SCOPED CORE: `core/<ref>` → game/src/core/assets/<ref>.
    if (rest === 'core' || rest.startsWith('core/')) {
      const coreRef = rest.slice('core/'.length);
      if (tryServe(path.join(GAME_SRC_DIR, 'core', 'assets'), coreRef)) return;
      // Scoped core URL that doesn't exist → honest 404 (do NOT fall
      // through to the unscoped pass, which could shadow with a skin file).
      res.status(404).end();
      return;
    }

    // (b) SCOPED SKIN: `skins/<name>/<ref>` → game/src/skins/<name>/assets/<ref>.
    const skinMatch = rest.match(/^skins\/([^/]+)\/(.+)$/);
    if (skinMatch) {
      const skinName = skinMatch[1];
      const skinRef = skinMatch[2];
      if (tryServe(path.join(GAME_SRC_DIR, 'skins', skinName, 'assets'), skinRef)) return;
      res.status(404).end();
      return;
    }

    // (c) UNSCOPED FALLBACK: legacy refs (audio, fonts, …) emitted without a
    // scope. Active-skin mirror first, then core — the historical behaviour.
    for (const dir of getActiveSkinAssetDirsFresh()) {
      if (tryServe(dir, rest)) return;
    }

    // (d) Honest 404.
    res.status(404).end();
  };
}

/**
 * @returns {Array<{ directory: string, publicPath: string, label: string }>}
 *   The runtime-mirror directories that should be served at the `/assets`
 *   publicPath, in priority order (active skin first, core last).
 *
 * NB: mirror directories are mounted UNCONDITIONALLY — they are NOT gated
 * on `fs.existsSync`. This function runs ONCE at webpack config-load time
 * (i.e. dev-server boot), but the mirror dir for a bucket
 * (`game/src/core/assets` or `game/src/skins/<skin>/assets`) is only
 * created/populated by the editor's `sync-skin-assets` IPC on the FIRST
 * scene save — which frequently happens AFTER the game dev server has
 * already started. `express.static` resolves files per-request, so
 * mounting a not-yet-existent directory is harmless and lets
 * later-mirrored assets be served without a dev-server restart. The prod
 * CopyWebpackPlugin path sets `noErrorOnMissing: true`, so a missing
 * mirror at build time is likewise tolerated. Gating on existence here
 * would cause assets to 404 permanently when the mirror didn't exist at
 * the instant the server booted.
 */
function getOrcaProjectAssetRoots() {
  const roots = [];

  // Mount each GAME RUNTIME MIRROR (`game/src/core/assets` and
  // `game/src/skins/<activeSkin>/assets`) at the `/assets` publicPath.
  //
  // We serve from the game folder — the build-output SOURCE OF TRUTH — and
  // NEVER from the editor's authoring tree (`orca-project-files/`). The
  // editor's `sync-skin-assets` IPC owns this mirror: it bakes only the
  // referenced binaries here (stripping `.meta` and never copying
  // authoring sidecars or authoring dirs) and prunes stale files. So the
  // runtime reads a clean, binaries-only tree that it itself ships.
  //
  // The mirror is NAMESPACED under `assets/`: a scene/graph ref `R` (the
  // VERBATIM bucket-relative subpath, e.g. `1.png`, `Spine/x.png`,
  // `assets/generated/y.png`) is mirrored to
  // `game/src/<bucket>/assets/<R>`. Serving `game/src/<bucket>/assets` at
  // the `/assets` publicPath therefore makes the runtime URL `/assets/<R>`
  // resolve to `game/src/<bucket>/assets/<R>` — a clean 1:1 mapping (the
  // static middleware strips the `/assets` publicPath prefix and serves
  // the remainder from the mirror root). A ref that already lives under a
  // folder literally named `assets/` (e.g. `assets/generated/y.png`)
  // therefore resolves via `/assets/assets/generated/y.png` →
  // `game/src/<bucket>/assets/assets/generated/y.png`.
  //
  // Mirrors are mounted UNCONDITIONALLY (no `fs.existsSync` gate) — see the
  // function jsdoc for why.
  //
  // DELIBERATELY ACTIVE-SKIN-ONLY, unlike the scoped prod copy below. This
  // FLAT mount serves legacy UNSCOPED refs (audio, fonts) straight out of
  // `/assets/<ref>`; widening it to every skin would let two skins' same-named
  // unscoped refs shadow (dev) / silently overwrite (prod) each other.
  const activeSkin = readActiveSkin();
  if (activeSkin) {
    const skinMirrorDir = path.join(GAME_SRC_DIR, 'skins', activeSkin, 'assets');
    roots.push({
      directory: skinMirrorDir,
      publicPath: '/assets',
      label: `game/src/skins/${activeSkin}/assets`,
    });
  }

  const coreMirrorDir = path.join(GAME_SRC_DIR, 'core', 'assets');
  roots.push({
    directory: coreMirrorDir,
    publicPath: '/assets',
    label: 'game/src/core/assets',
  });

  return roots;
}

/**
 * SCOPE-QUALIFIED prod copy targets. The runtime serves scoped URLs
 * (`/assets/core/<ref>`, `/assets/skins/<skin>/<ref>`) so a core ref and an
 * active-skin ref that share a basename never collide. For a packaged
 * build we therefore copy each mirror's CONTENTS into a scope-namespaced
 * sub-directory of `dist/assets`:
 *
 *   game/src/core/assets/**            → dist/assets/core/**
 *   game/src/skins/<skin>/assets       → dist/assets/skins/<skin>/**  (EVERY skin)
 *
 * EVERY skin is copied, not just the active one: a production bundle carries
 * all skins and picks one at boot from `?skin=<gameId>`, so a skin whose
 * mirror was skipped would 404 every scoped asset. Destinations are already
 * scope-namespaced, so there is zero cross-skin collision risk.
 *
 * The companion `getOrcaProjectAssetRoots()` is still used to ALSO produce a
 * FLAT copy into `dist/assets/**` for legacy UNSCOPED URLs (audio, fonts)
 * that are emitted without a scope prefix — that one stays ACTIVE-SKIN-ONLY,
 * because a flat copy of N skins would silently overwrite same-named refs.
 *
 * DIAGNOSTIC (warn only, NEVER a gate): a resolved mirror dir that does not
 * exist on disk at config-load time is `console.warn`ed. CopyWebpackPlugin
 * sets `noErrorOnMissing: true` on these patterns, so a wrong/missing source
 * dir otherwise copies NOTHING in total silence and every asset in that
 * scope 404s in the packaged build (see `effectiveSkinFolder`). The warning
 * does NOT change what is returned — the entry is still emitted, because a
 * missing mirror is legitimate for a project that has never saved a scene.
 * This check is deliberately PROD-ONLY: `getOrcaProjectAssetRoots()` mounts
 * mirrors that are routinely created AFTER dev-server boot, so warning there
 * would be pure noise.
 *
 * @returns {Array<{ directory: string, to: string, label: string }>}
 *   `to` is the dist-relative destination passed to CopyWebpackPlugin.
 */
function getOrcaProjectScopedAssetRoots() {
  const roots = [];

  // Warn-only: never gates, never alters the returned roots.
  const warnIfMissing = (directory, scope) => {
    try {
      if (!fs.existsSync(directory)) {
        console.warn(
          `[orca-project-assets] Asset mirror for scope "${scope}" does not exist: ${directory}\n` +
          '  CopyWebpackPlugin uses noErrorOnMissing:true, so NOTHING will be copied and\n' +
          `  every /assets/${scope}/... URL will 404 in this build. Expected if no scene has\n` +
          '  been saved yet; otherwise check the effective skin folder (runtimeGameId ||\n' +
          '  slug(tileName) || name) against game/src/skins/<folder>/assets.'
        );
      }
    } catch (err) {
      // Diagnostic only — never fail the build over it.
    }
  };

  const coreMirrorDir = path.join(GAME_SRC_DIR, 'core', 'assets');
  warnIfMissing(coreMirrorDir, 'core');
  roots.push({
    directory: coreMirrorDir,
    to: 'assets/core',
    label: 'game/src/core/assets -> assets/core',
  });

  const activeSkin = readActiveSkin();
  for (const skinFolder of getAllSkinFolders()) {
    const skinMirrorDir = path.join(GAME_SRC_DIR, 'skins', skinFolder, 'assets');
    // Warn for the ACTIVE skin only: a non-active skin with no mirror yet is
    // entirely normal (it has simply never been opened/saved) and warning for
    // every skin on every build would drown the signal.
    if (skinFolder === activeSkin) warnIfMissing(skinMirrorDir, `skins/${skinFolder}`);
    roots.push({
      directory: skinMirrorDir,
      to: `assets/skins/${skinFolder}`,
      label: `game/src/skins/${skinFolder}/assets -> assets/skins/${skinFolder}`,
    });
  }

  return roots;
}

/**
 * Globs that should NOT be copied into the dist bundle. These used to be
 * load-bearing back when the WHOLE authoring bucket ROOT was mounted at
 * `/assets` (which contained `*.flow`/`*.reef`/`main.orca`/sidecars/etc.).
 *
 * Now that `getOrcaProjectAssetRoots()` serves the GAME RUNTIME MIRROR
 * (`game/src/<bucket>/assets`) — which the editor's `sync-skin-assets` IPC
 * populates with the referenced runtime assets — this ignore list only
 * strips the handful of TRULY authoring-only files that can legitimately
 * land in the mirror, plus reserved authoring dirs/types as
 * defence-in-depth.
 *
 * IMPORTANT: the mirror is NOT binaries-only. The runtime FETCHES sprite
 * and animated-sprite descriptors at runtime from
 * `/assets/<name>.sprite.json` and `/assets/<name>.animsprite.json` (e.g.
 * the scene-manager's `fetchTextResource('/assets/nana.sprite.json')`), and
 * `sync-skin-assets` deliberately mirrors those descriptors because the
 * scanner counts them in the referenced set. They therefore MUST be copied
 * into `dist/assets/` for a packaged (prod) build to resolve them — so
 * `*.sprite.json` / `*.animsprite.json` are NOT in this ignore list. (Dev
 * is unaffected: `express.static` serves the mirror with no ignore
 * filtering.)
 *
 * What STAYS excluded, and why:
 *   - `*.meta`        — per-binary GUID sidecars; never served to the
 *                       runtime.
 *   - `*.timeremap.json` — Time Remap sidecars; authoring-only and BAKED
 *                       into the runtime scene JSON (`node.textures[]` +
 *                       `node.animationSpeed`), never fetched at runtime.
 *   - reserved authoring file types (`*.flow`/`*.reef`/`*.ocean`/`*.pod`/
 *     `*.wave`/`main.orca`) and dirs (`flowstate/`/`scenes/`/`.cache/`/
 *     `.orca-sources/`/ any dotfile) — should never reach the mirror, kept
 *     as belt-and-braces.
 *
 * NB: a BARE `.json` (e.g. a Spine skeleton) is a real runtime asset and
 * MUST stay served, so we never blanket-ignore every `.json`.
 */
const ORCA_ASSET_IGNORE_PATTERNS = [
  // Reserved authoring file types.
  '**/*.flow',
  '**/*.reef',
  '**/*.ocean',
  '**/*.pod',
  '**/*.wave',
  '**/main.orca',
  // Truly authoring-only sidecars (never fetched by the runtime). NOTE:
  // `*.sprite.json` / `*.animsprite.json` are deliberately NOT here — the
  // runtime fetches those descriptors, so they must be copied to prod.
  '**/*.meta',
  '**/*.timeremap.json',
  // Reserved authoring subdirectories.
  '**/flowstate/**',
  '**/scenes/**',
  '**/.cache/**',
  '**/.orca-sources/**',
  // Any other dotfile / dot-directory.
  '**/.*',
];

// The on-disk dir the editor's main-process sync drops a jackpot skin's
// assets into (preserving the package's `<operator>/...` layout), served at
// the `/static/shared-jackpots-assets/` publicPath the runtime fetches from.
const JACKPOTS_PUBLIC_PATH = '/static/shared-jackpots-assets';
const JACKPOTS_STATIC_DIR = path.resolve(__dirname, '..', 'static', 'shared-jackpots-assets');

/**
 * Build an Express-style dev-server middleware that serves
 * `/static/shared-jackpots-assets/<rest>` from the on-disk
 * `game/static/shared-jackpots-assets/<rest>` PER REQUEST.
 *
 * WHY a per-request middleware (not the boot-time CopyWebpackPlugin copy of
 * `game/static/`): the editor syncs a jackpot skin's assets into that folder
 * AFTER the dev server has booted (on skin activation / asset sync). A
 * compile-time copy won't pick up post-boot drops without a recompile, so
 * this middleware reads disk on every hit — exactly mirroring
 * `createOrcaAssetsDevMiddleware`.
 *
 * On a MISS it calls `next()` (NOT an honest 404) so the request still falls
 * through to webpack's in-memory `static/` copy and the normal 404 handling.
 * This middleware only ADDS the ability to serve editor-dropped files without
 * a restart; it never removes existing serving. For a non-jackpot skin the
 * folder is absent, so every request simply falls through.
 *
 * @returns {(req: any, res: any, next: Function) => void}
 */
function createJackpotsAssetsDevMiddleware() {
  return createStaticMirrorDevMiddleware([{ publicPath: JACKPOTS_PUBLIC_PATH, dir: JACKPOTS_STATIC_DIR }]);
}

/**
 * Shared per-request server for editor-managed `game/static/<mirror>/` trees.
 * GET/HEAD only; a miss, a non-matching path or a `..` escape falls through to
 * `next()` (webpack's in-memory `static/` copy + normal 404 handling).
 *
 * @param {Array<{ publicPath: string, dir: string }>} mirrors
 * @returns {(req: any, res: any, next: Function) => void}
 */
function createStaticMirrorDevMiddleware(mirrors) {
  return function staticMirrorDevMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // `req.path` is percent-encoded; decode the pathname only.
    let pathname;
    try {
      pathname = decodeURIComponent(req.path || (req.url || '').split('?')[0] || '');
    } catch (e) {
      pathname = req.path || '';
    }

    const mirror = mirrors.find((m) => pathname === m.publicPath || pathname.startsWith(m.publicPath + '/'));
    if (!mirror) return next();

    let rest = pathname.slice(mirror.publicPath.length);
    if (rest.startsWith('/')) rest = rest.slice(1);
    if (!rest) return next();

    const candidate = path.join(mirror.dir, rest);
    const relFromDir = path.relative(mirror.dir, candidate);
    if (!relFromDir || relFromDir.startsWith('..') || path.isAbsolute(relFromDir)) return next();

    try {
      if (fs.statSync(candidate).isFile()) {
        res.sendFile(candidate);
        return;
      }
    } catch (e) {
      // Not mirrored (yet) — fall through.
    }
    return next();
  };
}

// Mirrors the editor's codegen writes into `game/static/` at any time during a
// session: Game Rules images (`electron/codegen/game-rules-codegen.js`) and
// How-To-Play images (`electron/codegen/htp-codegen.js`).
const EDITOR_STATIC_MIRRORS = [
  { publicPath: '/static/game-rules', dir: path.join(PROJECT_ROOT, 'game', 'static', 'game-rules') },
  { publicPath: '/static/htp', dir: path.join(PROJECT_ROOT, 'game', 'static', 'htp') },
];

/**
 * Serve the editor-managed Game Rules + How-To-Play image mirrors PER REQUEST.
 *
 * The CopyWebpackPlugin copy of `game/static/` is an in-memory COMPILATION
 * asset: a file the editor drops after boot is served only once a later
 * compilation SUCCEEDS (`NoEmitOnErrorsPlugin` withholds every asset while the
 * game has any compile error). Reading disk per request removes that coupling.
 * Falls through on a miss, so it never removes existing serving.
 *
 * @returns {(req: any, res: any, next: Function) => void}
 */
function createEditorStaticMirrorsDevMiddleware() {
  return createStaticMirrorDevMiddleware(EDITOR_STATIC_MIRRORS);
}

module.exports = {
  getOrcaProjectAssetRoots,
  getOrcaProjectScopedAssetRoots,
  ORCA_ASSET_IGNORE_PATTERNS,
  readActiveSkin,
  readActiveSkinCached,
  getAllSkinFolders,
  effectiveSkinFolder,
  readGameSkinTable,
  getActiveSkinAssetDirsFresh,
  createOrcaAssetsDevMiddleware,
  createJackpotsAssetsDevMiddleware,
  createEditorStaticMirrorsDevMiddleware,
};
