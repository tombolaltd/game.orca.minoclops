import sceneManager from '../scene-manager';
import { ACTIVE_SKIN_NAME } from '../active-skin';
import { Flowstate } from '../flowstate';

/**
 * Scene Methods for FlowState
 *
 * Load/unload scenes at runtime. The scene manager handles tearing
 * down the previously-loaded scene while preserving any containers
 * marked dontDestroyOnLoad (DDOL).
 *
 * Inputs are tolerant of all three authoring shapes:
 *   - bare strings (legacy graphs):          "scenes/main"
 *   - structured SceneRefs:                  { scope, skin?, name }
 *   - per-skin wrapper (skinSceneReference): { kind: 'sceneRefBySkin', bySkin }
 *     keyed by the REAL authoring skin name — collapsed to the active
 *     skin's entry at runtime so a SHARED core graph (one exported JSON
 *     for every skin) can target a DIFFERENT scene per skin.
 */

type SceneRefIn =
    | string
    | { scope?: 'core' | 'skin'; skin?: string; name: string }
    | SceneRefBySkinIn
    | null
    | undefined;

/**
 * Per-skin scene reference (from the `skinSceneReference` provider). Carries
 * a distinct plain SceneRef for each skin, keyed by the REAL authoring skin
 * name (`main.orca.skins[i].name`, NOT the effective runtime folder). At
 * runtime the active skin's entry is selected via `ACTIVE_SKIN_NAME`; a skin
 * with no entry collapses to `null` (blank → the consumer node no-ops).
 * Mirrors `NodeRefBySkinValue` in node-ref.ts.
 */
interface SceneRefBySkinIn {
    kind: 'sceneRefBySkin';
    bySkin: Record<string, { scope?: 'core' | 'skin'; skin?: string; name: string }>;
}

interface NormalisedSceneRef {
    scope?: 'core' | 'skin';
    skin?: string;
    name: string;
}

/**
 * True when `arg` looks like a per-skin wrapper (kind === 'sceneRefBySkin'
 * carrying a `bySkin` map). Mirrors `isNodeRefBySkin` in node-ref.ts.
 */
function isSceneRefBySkin(arg: any): arg is SceneRefBySkinIn {
    return arg != null && typeof arg === 'object' && arg.kind === 'sceneRefBySkin'
        && arg.bySkin != null && typeof arg.bySkin === 'object';
}

class SceneMethods {
    /**
     * Load a scene by name. The previously-loaded scene is torn down,
     * but containers marked dontDestroyOnLoad survive across the load.
     */
    public loadScene(sceneNameOrRef: SceneRefIn): void {
        const ref = this.normaliseSceneArg(sceneNameOrRef);
        if (!ref) {
            console.warn('[FlowState] loadScene called without a valid scene');
            return;
        }

        const scene = sceneManager.findScene(ref.name, ref.scope);
        if (!scene) {
            const label = ref.scope ? `${ref.scope}:${ref.name}` : ref.name;
            console.warn(`[FlowState] loadScene: unknown scene "${label}"`);
            return;
        }

        // Sandbox: a skin-scoped ref must target the active skin. `ref.skin` is
        // the REAL authoring skin name, so compare against ACTIVE_SKIN_NAME (also
        // a real name) — NOT ACTIVE_SKIN, which is the EFFECTIVE runtime folder
        // and differs for any skin with a gameId/tileName override (rule 14).
        if (ref.scope === 'skin' && ref.skin && ref.skin !== ACTIVE_SKIN_NAME) {
            console.warn(
                `[FlowState] loadScene refused: ref targets skin "${ref.skin}" but active skin is "${ACTIVE_SKIN_NAME}"`,
            );
            return;
        }

        // Belt-and-braces: scope-less call into a per-skin scene — permit
        // but warn so legacy graphs keep working while new graphs surface
        // missing scope info.
        if (scene.origin === 'skin' && !ref.scope) {
            console.warn(
                `[FlowState] loadScene: scope-less call to skin-scope scene "${ref.name}"`,
            );
        }

        sceneManager.loadScene(ref.name, ref.scope);
        // New scene tree means new DisplayObjects — rebind pixi-event
        // starters so pointer listeners attach to the fresh tree.
        Flowstate.bindPixiStarters();
        // Re-bind custom-event starters too (keeps both bind sweeps in
        // lockstep; harmless since custom listeners don't need the tree).
        Flowstate.bindCustomEventStarters();
        Flowstate.bindGamePreferenceStarters();
    }

    /**
     * Unload a scene by name (or the currently-loaded scene if no
     * name is supplied). DDOL containers are preserved.
     */
    public unloadScene(sceneNameOrRef?: SceneRefIn): void {
        if (sceneNameOrRef === undefined) {
            sceneManager.unloadScene();
            Flowstate.bindPixiStarters();
            Flowstate.bindCustomEventStarters();
            Flowstate.bindGamePreferenceStarters();
            return;
        }

        const ref = this.normaliseSceneArg(sceneNameOrRef);
        if (!ref) {
            console.warn('[FlowState] unloadScene called without a valid scene');
            return;
        }

        // Same real-name↔real-name sandbox as loadScene above.
        if (ref.scope === 'skin' && ref.skin && ref.skin !== ACTIVE_SKIN_NAME) {
            console.warn(
                `[FlowState] unloadScene refused: ref targets skin "${ref.skin}" but active skin is "${ACTIVE_SKIN_NAME}"`,
            );
            return;
        }

        sceneManager.unloadScene(ref.name, ref.scope);
        Flowstate.bindPixiStarters();
        Flowstate.bindCustomEventStarters();
        Flowstate.bindGamePreferenceStarters();
    }

    private normaliseSceneArg(arg: SceneRefIn): NormalisedSceneRef | null {
        if (arg === null || arg === undefined) return null;

        // Per-skin wrapper collapses FIRST — select THIS skin's entry, keyed by
        // the REAL authoring skin name (ACTIVE_SKIN_NAME), exactly as the editor
        // bakes it. A skin with no entry → null, so loadScene/unloadScene no-op
        // with the existing "without a valid scene" warn (blank-until-set UX).
        // Because BOTH loadScene and unloadScene funnel through this single
        // collapse point, the per-skin handling covers both with no per-call-site
        // duplication.
        if (isSceneRefBySkin(arg)) {
            const entry = arg.bySkin[ACTIVE_SKIN_NAME];
            if (!entry || !entry.name) return null;
            // The selected entry is BY CONSTRUCTION already the active skin's ref,
            // so it is inherently active-skin-correct. Deliberately DROP the
            // per-entry `skin` — it is redundant here, and the downstream sandbox
            // only needs `scope`. `scope` is preserved so findScene/loadScene still
            // resolve the skin-scoped scene.
            return { scope: entry.scope, name: entry.name };
        }

        if (typeof arg === 'string') {
            return arg ? { name: arg } : null;
        }
        if (typeof arg === 'object' && typeof (arg as { name?: unknown }).name === 'string') {
            const a = arg as { scope?: 'core' | 'skin'; skin?: string; name: string };
            if (!a.name) return null;
            return { scope: a.scope, skin: a.skin, name: a.name };
        }
        return null;
    }
}

export const scene = new SceneMethods();
