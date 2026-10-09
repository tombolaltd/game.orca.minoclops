import * as PIXI from "pixi.js";
import type { NodeRefLike } from "../node-ref";
import { resolveNode } from "../node-ref";

/**
 * The host SDK handed to every node extension as its fixed FIRST argument.
 *
 * A node extension is a single self-contained function validated in the editor
 * (`electron/node-extension-{contract,ast,sandbox}.js`) and mirrored into
 * `methods/extensions/<methodKey>.ts`. Extension source carries NO imports by
 * contract, so the mirror PREPENDS the type alias below and the generated
 * barrel (`./index`) drops this object into the first parameter. This file is
 * the ONLY thing an extension can reach outside its own body.
 *
 * The barrel casts (`sdk as unknown as ...`) so a divergence here can never
 * break the user's build — which means the cast proves nothing. The annotation
 * on `sdk` at the bottom of this file IS the proof, and
 * `scripts/test-node-extension-sdk.cjs` asserts the alias block below is
 * BYTE-IDENTICAL to `EXTENSION_CONTEXT_ALIAS_SOURCE` in
 * `electron/node-extension-contract.js`. Change one, change the other — this
 * is a cross-process mirror in the sense of AGENTS.md rule 24, and
 * `npm run type-check` cannot see it.
 *
 * NOT a general scripting surface. Eight primitive properties, resolved
 * through the SHARED `resolveNode` so a reference behaves EXACTLY as it does
 * for every builtin method: `nodeRefBySkin` collapses to the active skin, and
 * a node whose scene is not loaded resolves to `null` rather than throwing.
 */

// ORCA-CONTRACT-ALIAS START — byte-identical mirror, do not reformat.
type OrcaNodeRef = { kind: "nodeRef"; nodeId: string };
type OrcaNodeProperty = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'alpha' | 'visible' | 'text';
type OrcaNodeValue = string | number | boolean;
interface OrcaNodeContext {
  readNode(ref: OrcaNodeRef, property: OrcaNodeProperty): OrcaNodeValue | null;
  writeNode(ref: OrcaNodeRef, property: OrcaNodeProperty, value: OrcaNodeValue): void;
}
// ORCA-CONTRACT-ALIAS END

export type { OrcaNodeRef, OrcaNodeProperty, OrcaNodeValue, OrcaNodeContext };

/**
 * The declared parameter is the MINIMAL `OrcaNodeRef`, but the value that
 * actually arrives is whatever the graph walker resolved a `nodeRef` pin to:
 * the full structured ref (`sceneScope` / `sceneSkin` / `sceneName`), or a
 * per-skin `nodeRefBySkin` when the author used a `skinNodeReference` provider.
 * Accepting the wider `NodeRefLike` and delegating to the SHARED `resolveNode`
 * is what makes both work — and a wider parameter is still assignable to the
 * narrower contract, so the annotation on `sdk` below still holds.
 *
 * The narrow DECLARED type is deliberate: extension source can only ever spell
 * `OrcaNodeRef`, so nothing is lost, and keeping the export exactly at the
 * contract is what would let the generated barrel drop its `as unknown as`
 * cast.
 */
function displayObjectFor(ref: NodeRefLike): PIXI.Container | null {
    return resolveNode<PIXI.Container>(ref, PIXI.Container);
}

function textFor(ref: NodeRefLike): PIXI.Text | null {
    return resolveNode<PIXI.Text>(ref, PIXI.Text);
}

/**
 * Read one primitive property off a referenced node.
 *
 * Returns `null` — never a fabricated default — when the reference does not
 * resolve, the node is the wrong kind for the property (`text` on a sprite),
 * or the property is not one of the eight. Callers get `OrcaNodeValue | null`
 * and the contract forces them to handle it.
 */
function readNode(ref: NodeRefLike, property: OrcaNodeProperty): OrcaNodeValue | null {
    if (property === 'text') {
        const t = textFor(ref);
        if (!t) return null;
        return typeof t.text === 'string' ? t.text : '';
    }

    const o = displayObjectFor(ref);
    if (!o) return null;

    // A switch, never `o[property]`: a dynamic index is how a prototype slot
    // or an unrelated engine field becomes readable from extension source.
    switch (property) {
        case 'x': return o.x;
        case 'y': return o.y;
        case 'scaleX': return o.scale.x;
        case 'scaleY': return o.scale.y;
        case 'rotation': return o.rotation;
        case 'alpha': return o.alpha;
        case 'visible': return o.visible;
        default: return null;
    }
}

/**
 * Write one primitive property onto a referenced node.
 *
 * The type gate runs BEFORE the node is resolved, so a bad input performs no
 * mutation at all rather than a partial one. Non-finite numbers are REJECTED,
 * not coerced. Nothing is clamped — including `alpha`: the declarative test
 * runner records the exact `writeNode` calls an extension makes, so silently
 * substituting a different value here would let a validated test assert
 * something the runtime does not do.
 */
function writeNode(ref: NodeRefLike, property: OrcaNodeProperty, value: OrcaNodeValue): void {
    if (property === 'text') {
        if (typeof value !== 'string') return;
        const t = textFor(ref);
        if (t) t.text = value;
        return;
    }

    if (property === 'visible') {
        if (typeof value !== 'boolean') return;
        const o = displayObjectFor(ref);
        if (o) o.visible = value;
        return;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) return;

    const o = displayObjectFor(ref);
    if (!o) return;

    switch (property) {
        case 'x': o.x = value; break;
        case 'y': o.y = value; break;
        case 'scaleX': o.scale.x = value; break;
        case 'scaleY': o.scale.y = value; break;
        case 'rotation': o.rotation = value; break;
        case 'alpha': o.alpha = value; break;
        default: break;
    }
}

/**
 * The annotation is the compile-time proof that this file still satisfies the
 * contract the editor validated every extension against. If the alias block
 * above is re-mirrored and this object no longer matches it, the user's game
 * fails to build HERE — which is the intended place for it to fail, rather
 * than silently at a graph node.
 */
export const sdk: OrcaNodeContext = { readNode, writeNode };
