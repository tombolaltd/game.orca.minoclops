'use strict';
/**
 * Runtime asset mirror reconcile.
 *
 * Makes sure every asset file the game's bundled scene / graph / animation
 * data names is present — and current — in the RUNTIME MIRROR the game is
 * served and built from:
 *
 *   orca-project-files/core/<ref>          → game/src/core/assets/<ref>
 *   orca-project-files/skins/<name>/<ref>  → game/src/skins/<folder>/assets/<ref>
 *
 * (`<folder>` is the skin's effective runtime folder; see
 * `effectiveSkinFolder` in ./orca-project-assets.js.)
 *
 * WHY
 * ───
 * The mirror is a CACHE of the authoring buckets. The editor's
 * `sync-skin-assets` refreshes it when a scene or graph is SAVED, and the dev
 * server and the production build both serve ONLY the mirror. A project whose
 * mirror fell out of step — copied or checked out somewhere else, assets
 * added by a generator or an agent, a skin that was never re-saved, a partial
 * commit — used to build and run without a single error while every missing
 * texture drew as a white box (the scene manager's placeholder) and every
 * missing sound stayed silent.
 *
 * WHAT
 * ────
 * Run before the dev server starts (`npm run serve` → `preserve` →
 * ./copy-runtime-assets.js — how the editor starts the game) and before a
 * production build (./build.js). For core and EVERY skin in `main.orca`:
 *
 *   1. Collect every string in the bucket's runtime data
 *      (`scene-data/**`, `animation-data/**`, `flowstate-data/**`) that names
 *      an asset file, plus that file's on-disk companions — a spine
 *      skeleton's `.atlas` and its pages, an atlas's pages, the images of a
 *      `.sprite.json` / `.animsprite.json` / `.spritesheet.json` descriptor
 *      (the same expansion `sync-skin-assets` performs). Graph audio refs are
 *      scope-qualified (`core/<ref>`, `skins/<skin>/<ref>`) and are routed to
 *      that bucket.
 *   2. Copy each one from the authoring bucket into the mirror when the
 *      mirror copy is missing or its bytes differ — the authoring file is the
 *      source of truth (AGENTS.md rule 15a).
 *   3. Report every referenced file that exists in NEITHER place.
 *
 * It only ever ADDS or REFRESHES referenced files. It never deletes (pruning
 * unreferenced files stays the editor's job), never writes outside
 * `game/src/<bucket>/assets/`, never copies an authoring-only file (`.meta`,
 * `.timeremap.json`, `.reef`, anything under a dot-folder, …), and the
 * running game still never reads `orca-project-files/` — this is a BUILD
 * step.
 *
 * A build of `game/` ON ITS OWN (a CI checkout without `orca-project-files/`)
 * has no main.orca and no authoring files: the skins then come from the
 * generated `active-skin.ts` and the game's own asset folders are only
 * CHECKED. Either way `verifyOrcaBuildOutput` runs after the production build
 * (./build.js) and fails it when a referenced file the asset folders hold is
 * missing from the output — a copy step that copied nothing used to ship a
 * game of white boxes without a word.
 *
 * Deliberately GENERIC: it does not know which scene-node property holds an
 * asset. A string counts when it carries an asset file extension AND names a
 * real file, so a new node type or component property is covered without
 * touching this file. Free text (`name`, `text`, …), the editor's
 * authoring metadata (`customProperties`) and a jackpots restyle's source
 * pictures (`panelStyle.textures`) are skipped. Only scene / clip
 * refs and SCOPE-QUALIFIED graph refs can be reported missing; a bare graph
 * string that names no file is ignored, because graph literals are not all
 * asset paths.
 *
 * Plain Node, no dependencies; delivered to existing projects by
 * project-migrate step 106.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ORCA_PROJECT_FILES_DIR = path.join(PROJECT_ROOT, 'orca-project-files');
const GAME_SRC_DIR = path.resolve(__dirname, '..', 'src');

/** Runtime data folders of a bucket, and how their strings are owned. */
const DATA_DIRS = [
  { dir: 'scene-data', kind: 'scene' },
  { dir: 'animation-data', kind: 'clip' },
  { dir: 'flowstate-data', kind: 'graph' },
];

const ASSET_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif|ktx2?|basis|mp4|webm|mov|m4v|ogv|mp3|ogg|oga|wav|m4a|aac|flac|opus|ttf|otf|woff2?|json|atlas|skel|fnt)$/i;

/** Keys whose values are labels, free text or authoring metadata — never refs. */
const SKIPPED_KEYS = new Set(['customProperties', 'name', 'text', 'label', 'title', 'description', 'id']);

/**
 * Keys skipped only under one parent: data the editor keeps that the game never
 * loads. A jackpots panel restyle (`panelStyle`) keeps its source pictures in
 * `textures` so the editor can bake it again; the game loads only the baked
 * `pages`.
 */
const SKIPPED_CHILD_KEYS = { panelStyle: new Set(['textures']) };

/** Reserved authoring folders (any depth) — never part of the runtime mirror. */
const RESERVED_DIRS = new Set(['flowstate', 'scenes']);

/** Authoring-only file types that must never enter the runtime mirror. */
const AUTHORING_ONLY_RE = /\.(meta|timeremap\.json|audiosrc\.json|videosrc\.json|reef|flow|pod|wave|ocean|orca)$/i;

const SKIN_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Normalize a raw data string into a bucket-relative POSIX ref, exactly as the
 * runtime does before building `assets/<scope>/<ref>` (trim, `\` → `/`, drop
 * `?query` / `#hash`, a leading `./`, leading `/`). Returns '' for anything
 * that is not a plain relative asset path.
 */
function normalizeRef(raw) {
  if (typeof raw !== 'string') return '';
  let ref = raw.trim().replace(/\\/g, '/');
  if (!ref || ref.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(ref)) return '';
  ref = ref.split('?')[0].split('#')[0].replace(/^\.\//, '').replace(/^\/+/, '');
  if (!ref || !ASSET_EXT_RE.test(ref)) return '';
  if (ref.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return '';
  return ref;
}

function isAuthoringOnly(ref) {
  const segs = ref.split('/');
  if (segs.some((seg) => seg.startsWith('.'))) return true;
  if (segs.slice(0, -1).some((seg) => RESERVED_DIRS.has(seg))) return true;
  return AUTHORING_ONLY_RE.test(ref);
}

/** `root/ref` when it stays inside `root`, else null. */
function inside(root, ref) {
  const abs = path.join(root, ...ref.split('/'));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function isFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch (err) {
    return false;
  }
}

function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (!sb.isFile() || sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch (err) {
    return false;
  }
}

function listJsonFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFiles(abs));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) out.push(abs);
  }
  return out;
}

function walkStrings(value, visit, parentKey) {
  if (typeof value === 'string') {
    visit(value);
  } else if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit, parentKey);
  } else if (value && typeof value === 'object') {
    const skippedHere = Object.prototype.hasOwnProperty.call(SKIPPED_CHILD_KEYS, parentKey)
      ? SKIPPED_CHILD_KEYS[parentKey]
      : null;
    for (const key of Object.keys(value)) {
      if (SKIPPED_KEYS.has(key) || (skippedHere && skippedHere.has(key))) continue;
      walkStrings(value[key], visit, key);
    }
  }
}

/**
 * Page image names declared by a libgdx / spine `.atlas` text. Same rules as
 * `extractSpineAtlasPageFilenames` in the editor's
 * `electron/media/scene-asset-mirrors.js` (the build cannot import it): the
 * first non-empty line, any unindented line ending in an image extension, and
 * any unindented colon-free line followed by a `size:` line.
 */
const ATLAS_PAGE_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.ktx', '.basis'];
function atlasPageNames(atlasText) {
  const pages = [];
  if (typeof atlasText !== 'string' || !atlasText) return pages;
  const lines = atlasText.split(/\r?\n/);
  let first = true;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || /^[ \t]/.test(raw)) continue;
    if (first) {
      first = false;
      pages.push(line);
      continue;
    }
    const lower = line.toLowerCase();
    if (ATLAS_PAGE_IMAGE_EXTS.some((ext) => lower.endsWith(ext))) {
      pages.push(line);
      continue;
    }
    let next = i + 1;
    while (next < lines.length && !lines[next].trim()) next++;
    if (next < lines.length && /^\s*size\s*:/i.test(lines[next]) && !line.includes(':')) pages.push(line);
  }
  return [...new Set(pages)];
}

/**
 * A descriptor companion as a bucket-relative ref: prefixed paths are taken as
 * bucket-relative, bare / relative ones resolve against the descriptor's own
 * folder — the editor's `sync-skin-assets` and the runtime's
 * `resolveTexturePathRelativeToDescriptor` rules.
 */
function companionRef(descriptorRef, raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed || /^(?:https?:)?\/\//i.test(trimmed) || /^(?:file|data|blob):/i.test(trimmed)) return '';
  const bare = trimmed.replace(/^\/+/, '');
  let ref;
  let match;
  if ((match = bare.match(/^(?:game\/src\/skins\/[^/]+|game\/src\/core|orca-project-files\/skins\/[^/]+|orca-project-files\/core)\/(.+)$/i))) {
    ref = match[1];
  } else if (/^(assets|static|core|skins|orca-project-files|scenes|flowstate|\.orca-sources|\.cache)\//i.test(bare)) {
    ref = bare;
  } else {
    const slash = descriptorRef.lastIndexOf('/');
    ref = slash > 0 ? `${descriptorRef.slice(0, slash)}/${bare}` : bare;
  }
  const segs = ref.split('/').filter((seg) => seg && seg !== '.');
  if (!segs.length || segs.includes('..')) return '';
  return segs.join('/');
}

function descriptorCompanions(ref, text) {
  const lower = ref.toLowerCase();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return [];
  }
  const raws = [];
  if (lower.endsWith('.animsprite.json')) {
    if (Array.isArray(parsed && parsed.textures)) raws.push(...parsed.textures);
  } else if (lower.endsWith('.sprite.json')) {
    const proc = parsed && parsed.processing;
    raws.push(proc && proc.outputTexturePath, parsed && parsed.texture, proc && proc.sourceImagePath);
  } else if (lower.endsWith('.spritesheet.json')) {
    if (Array.isArray(parsed && parsed.pages)) raws.push(...parsed.pages.map((page) => page && page.image));
  }
  return raws.map((raw) => companionRef(ref, raw)).filter(Boolean);
}

function readMainOrca() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ORCA_PROJECT_FILES_DIR, 'main.orca'), 'utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * Core plus one entry per skin runtime folder. With main.orca, each skin's
 * authoring folders (two skins may share a runtime folder, never a name);
 * without it (a build of `game/` alone), the generated skin table and no
 * authoring folders — the game's own asset folders can only be checked.
 */
function listBuckets(main, assets) {
  const core = {
    key: 'core',
    runtimeDir: path.join(GAME_SRC_DIR, 'core'),
    authoringDirs: main ? [path.join(ORCA_PROJECT_FILES_DIR, 'core')] : [],
    names: [],
  };
  const buckets = [core];
  const byFolder = new Map();
  const rows = main
    ? (Array.isArray(main.skins) ? main.skins : []).map((skin) => {
      const name = skin && typeof skin.name === 'string' ? skin.name : '';
      return { name, folder: name ? assets.effectiveSkinFolder(skin) : '' };
    })
    : assets.readGameSkinTable().skins.map((skin) => ({ name: skin.realName, folder: skin.folder }));
  for (const { name, folder } of rows) {
    if (!SKIN_SEGMENT_RE.test(name) || !SKIN_SEGMENT_RE.test(folder) || /^\.+$/.test(name) || /^\.+$/.test(folder)) continue;
    let bucket = byFolder.get(folder);
    if (!bucket) {
      bucket = {
        key: `skins/${folder}`,
        runtimeDir: path.join(GAME_SRC_DIR, 'skins', folder),
        authoringDirs: [],
        names: [folder],
      };
      byFolder.set(folder, bucket);
      buckets.push(bucket);
    }
    if (main) bucket.authoringDirs.push(path.join(ORCA_PROJECT_FILES_DIR, 'skins', name));
    bucket.names.push(name);
  }
  return buckets;
}

const authoringFile = (bucket, ref) => {
  for (const dir of bucket.authoringDirs) {
    const abs = inside(dir, ref);
    if (abs && isFile(abs)) return abs;
  }
  return null;
};
const mirrorFile = (bucket, ref) => inside(path.join(bucket.runtimeDir, 'assets'), ref);
const existsAnywhere = (bucket, ref) => {
  if (authoringFile(bucket, ref)) return true;
  const mirrored = mirrorFile(bucket, ref);
  return !!mirrored && isFile(mirrored);
};

/**
 * Every asset file the bundled data names, by bucket, with its companions.
 *
 * @returns {{ skipped?: string, verifyOnly: boolean, buckets: object[],
 *   wanted: Map<string, { bucket: object, ref: string, source: string, soft: boolean }>,
 *   unknown: Array<{ bucket: string, ref: string, source: string }> }}
 */
function planReferences() {
  const plan = { verifyOnly: false, buckets: [], wanted: new Map(), unknown: [] };
  let assets;
  try {
    assets = require('./orca-project-assets');
  } catch (err) {
    assets = {};
  }
  const main = readMainOrca();
  if (main && typeof assets.effectiveSkinFolder !== 'function') {
    return { ...plan, skipped: 'game/build/orca-project-assets.js is out of date — open the project in Orca to update it' };
  }
  if (!main) {
    const table = typeof assets.readGameSkinTable === 'function' ? assets.readGameSkinTable() : null;
    if (!table) return { ...plan, skipped: 'no orca-project-files/main.orca and no generated active-skin.ts' };
    plan.verifyOnly = true;
  }

  const buckets = listBuckets(main, assets);
  plan.buckets = buckets;
  const core = buckets[0];
  const byName = new Map();
  for (const bucket of buckets) for (const name of bucket.names) if (!byName.has(name)) byName.set(name, bucket);

  const { wanted } = plan;
  const queue = [];
  const unknownScopes = new Set();
  const want = (bucket, ref, source, soft) => {
    if (!ref || isAuthoringOnly(ref)) return;
    const key = `${bucket.key}\n${ref}`;
    const existing = wanted.get(key);
    if (existing) {
      if (!soft) existing.soft = false;
      return;
    }
    const entry = { bucket, ref, source, soft: !!soft };
    wanted.set(key, entry);
    queue.push(entry);
  };

  for (const bucket of buckets) {
    for (const { dir, kind } of DATA_DIRS) {
      for (const file of listJsonFiles(path.join(bucket.runtimeDir, dir))) {
        let data;
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
          continue;
        }
        const source = path.relative(path.resolve(GAME_SRC_DIR, '..', '..'), file).split(path.sep).join('/');
        walkStrings(data, (raw) => {
          const ref = normalizeRef(raw);
          if (!ref) return;
          if (kind !== 'graph') {
            want(bucket, ref, source, false);
            return;
          }
          // Exported audio refs carry their bucket: `core/<ref>` or
          // `skins/<skin>/<ref>` (ExportService.scopeQualifyAudioPath).
          const coreScoped = ref.match(/^core\/(.+)$/);
          if (coreScoped) {
            want(core, coreScoped[1], source, false);
            return;
          }
          const skinScoped = ref.match(/^skins\/([^/]+)\/(.+)$/);
          if (skinScoped) {
            const target = byName.get(skinScoped[1]);
            if (target) want(target, skinScoped[2], source, false);
            else if (!existsAnywhere(bucket, ref)) {
              const key = `skins/${skinScoped[1]}\n${skinScoped[2]}`;
              if (!unknownScopes.has(key)) {
                unknownScopes.add(key);
                plan.unknown.push({ bucket: `skins/${skinScoped[1]}`, ref: skinScoped[2], source });
              }
            }
            return;
          }
          // A bare graph literal: only when it names a real file.
          if (existsAnywhere(bucket, ref)) want(bucket, ref, source, true);
          else if (bucket !== core && existsAnywhere(core, ref)) want(core, ref, source, true);
        });
      }
    }
  }

  // Companions: read from the authoring copy, else the mirror copy.
  while (queue.length) {
    const { bucket, ref } = queue.shift();
    const lower = ref.toLowerCase();
    const from = authoringFile(bucket, ref) || (() => {
      const mirrored = mirrorFile(bucket, ref);
      return mirrored && isFile(mirrored) ? mirrored : null;
    })();
    if (!from) continue;
    const isDescriptor = /\.(sprite|animsprite|spritesheet)\.json$/i.test(lower);
    if (isDescriptor) {
      let text = '';
      try { text = fs.readFileSync(from, 'utf8'); } catch (err) { /* unreadable descriptor */ }
      for (const companion of descriptorCompanions(ref, text)) want(bucket, companion, ref, false);
    } else if (lower.endsWith('.skel') || lower.endsWith('.json')) {
      const atlas = ref.replace(/\.(skel|json)$/i, '.atlas');
      if (existsAnywhere(bucket, atlas)) want(bucket, atlas, ref, false);
    } else if (lower.endsWith('.ogg')) {
      // The runtime falls back to this sibling where the device cannot play Ogg.
      const mp3 = ref.replace(/\.ogg$/i, '.mp3');
      if (existsAnywhere(bucket, mp3)) want(bucket, mp3, ref, false);
    } else if (lower.endsWith('.atlas')) {
      let text = '';
      try { text = fs.readFileSync(from, 'utf8'); } catch (err) { /* unreadable atlas */ }
      const slash = ref.lastIndexOf('/');
      const dir = slash > 0 ? ref.slice(0, slash) : '';
      for (const page of atlasPageNames(text)) {
        if (page.includes('/') || page.includes('\\')) continue;
        want(bucket, dir ? `${dir}/${page}` : page, ref, false);
      }
    }
  }
  return plan;
}

/**
 * Reconcile the project this `game/build` folder belongs to.
 *
 * @returns {{
 *   skipped?: string,
 *   verifyOnly: boolean,
 *   buckets: number,
 *   referenced: number,
 *   copied: Array<{ bucket: string, ref: string }>,
 *   missing: Array<{ bucket: string, ref: string, source: string }>,
 *   failed: Array<{ bucket: string, ref: string, error: string }>,
 * }}
 */
function reconcileOrcaAssetMirrors() {
  const plan = planReferences();
  const result = { verifyOnly: plan.verifyOnly, buckets: plan.buckets.length, referenced: plan.wanted.size, copied: [], missing: [...plan.unknown], failed: [] };
  if (plan.skipped) return { ...result, skipped: plan.skipped };
  for (const { bucket, ref, source, soft } of plan.wanted.values()) {
    const src = authoringFile(bucket, ref);
    const dest = mirrorFile(bucket, ref);
    if (!dest) continue;
    if (!src) {
      if (!soft && !isFile(dest)) result.missing.push({ bucket: bucket.key, ref, source });
      continue;
    }
    if (sameBytes(src, dest)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      result.copied.push({ bucket: bucket.key, ref });
    } catch (err) {
      result.failed.push({ bucket: bucket.key, ref, error: err && err.message ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * After a production build: every referenced file the game's asset folders
 * hold must be in the build output at `<assetsDir>/<core|skins/<folder>>/<ref>`.
 * One that is not means the build's copy step left it out — the game would
 * draw a white box for it — so the build must fail.
 *
 * @param {string} assetsDir the build output's `assets` folder
 * @returns {{ skipped?: string, checked: number, lost: Array<{ bucket: string, ref: string }> }}
 */
function verifyOrcaBuildOutput(assetsDir) {
  const plan = planReferences();
  if (plan.skipped) return { skipped: plan.skipped, checked: 0, lost: [] };
  const lost = [];
  let checked = 0;
  for (const { bucket, ref } of plan.wanted.values()) {
    const mirrored = mirrorFile(bucket, ref);
    if (!mirrored || !isFile(mirrored)) continue;
    checked += 1;
    const built = inside(path.join(assetsDir, ...bucket.key.split('/')), ref);
    if (!built || !isFile(built)) lost.push({ bucket: bucket.key, ref });
  }
  return { checked, lost };
}

/** Print a reconcile result for a build / dev-server log. */
function logOrcaAssetMirrorReport(result, log = console) {
  const tag = '[orca-assets]';
  if (!result) return;
  if (result.skipped) {
    log.log(`${tag} Runtime asset check skipped: ${result.skipped}.`);
    return;
  }
  if (result.verifyOnly) {
    log.log(`${tag} No orca-project-files/main.orca (a build of game/ on its own): checking the game's own asset folders.`);
  }
  const list = (rows, max, format) => {
    const lines = rows.slice(0, max).map((row) => `    ${format(row)}`);
    if (rows.length > max) lines.push(`    …and ${rows.length - max} more`);
    return lines.join('\n');
  };
  if (result.copied.length) {
    log.log(
      `${tag} Copied ${result.copied.length} asset file(s) from orca-project-files into the game's runtime asset folders ` +
      '(they were missing or out of date):\n' +
      list(result.copied, 25, (row) => `${row.bucket}: ${row.ref}`)
    );
  }
  if (result.failed.length) {
    log.warn(
      `${tag} Could not copy ${result.failed.length} asset file(s):\n` +
      list(result.failed, 25, (row) => `${row.bucket}: ${row.ref} (${row.error})`)
    );
  }
  if (result.missing.length) {
    log.warn(
      `${tag} ${result.missing.length} referenced asset file(s) exist neither in orca-project-files nor in the game's ` +
      'runtime asset folders. They will draw as white boxes or stay silent in this game:\n' +
      list(result.missing, 60, (row) => `${row.bucket}: ${row.ref}  (named by ${row.source})`)
    );
  }
  if (!result.copied.length && !result.failed.length && !result.missing.length) {
    log.log(`${tag} All ${result.referenced} referenced asset file(s) are in place.`);
  }
}

module.exports = {
  reconcileOrcaAssetMirrors,
  verifyOrcaBuildOutput,
  logOrcaAssetMirrorReport,
  // Exposed for the editor's offline check (scripts/test-orca-asset-mirror.cjs).
  normalizeRef,
  atlasPageNames,
  companionRef,
};
