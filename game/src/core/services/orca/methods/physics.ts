import {
    addForceForOneStep,
    bodyDimension,
    getLiveBody,
    getRapier,
    isTouching,
    physicsMode,
    pixelsPerMeter,
    setBodyEnabledById,
    setBodyType,
    setGravity,
    teleportBody,
} from "../physics-runtime";
import type { PhysicsBodyTypeName } from "../physics-runtime";
import { emitFlowConsole } from "./flow-console";
import { nodeRefId } from "./node-ref";
import type { NodeRefLike } from "./node-ref";
import { node3DRefId } from "./node3d-ref";
import type { Node3DRefLike } from "./node3d-ref";

/**
 * FlowState PHYSICS nodes (Rapier) — actions + getters.
 *
 * Method names are the IMMUTABLE runtime keys of the editor's menu entries
 * (src/menu/action/physics.json and the physics getters); positional
 * parameters follow each entry's property order (target first).
 *
 * Units:
 *   2D — vectors in scene-ROOT pixels, screen y-down (px, px/s, px·kg/s for
 *        impulses, px·kg/s² for forces), converted to metres with the project's
 *        pixelsPerMeter; angles in degrees (clockwise on screen, like Pixi).
 *        Gravity is m/s², y-down.
 *   3D — scene units are metres, world axes; angles in degrees per axis.
 *
 * A node no-ops (getters answer 0 / false) when physics is off or in the other
 * mode, Rapier has not loaded yet, or the target has no live body — warning
 * once per (method, node).
 */

type Dim = '2d' | '3d';

const warned = new Set<string>();

function warnOnce(method: string, nodeId: string, reason: string): void {
    const key = `${method}\u0000${nodeId}`;
    if (warned.has(key)) return;
    warned.add(key);
    emitFlowConsole('warn', `[FlowState] ${method}: ${reason}`, {
        code: 'physics-unavailable',
        ...(nodeId ? { sceneNodeId: nodeId } : {}),
    });
}

function num(value: unknown): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    return Number.isFinite(n) ? n : 0;
}

function bool(value: unknown): boolean {
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        return !(v === '' || v === '0' || v === 'false');
    }
    return value !== false && value !== 0 && value !== null && value !== undefined;
}

const DEG = Math.PI / 180;

/** True when the project runs physics in `dim` and Rapier has loaded; warns once otherwise. */
function worldReady(method: string, dim: Dim, nodeId: string): boolean {
    const mode = physicsMode();
    if (mode === 'off') {
        warnOnce(method, nodeId, 'physics is off for this project (Project Settings → Physics); the node does nothing.');
        return false;
    }
    if (mode !== dim) {
        warnOnce(method, nodeId, `this is a ${dim.toUpperCase()} physics node but the project's physics mode is '${mode}'; the node does nothing.`);
        return false;
    }
    if (!getRapier()) {
        warnOnce(method, nodeId, 'Rapier has not loaded (yet, or the package is not installed); the node does nothing.');
        return false;
    }
    return true;
}

/**
 * The live Rapier body behind `nodeId` in the `dim` world, or null (warned once).
 * An empty id is already reported by the walker's missing-input check.
 */
function bodyFor(method: string, dim: Dim, nodeId: string | null): { id: string; body: any } | null {
    const id = nodeId || '';
    if (!worldReady(method, dim, id)) return null;
    if (!id) return null;
    const body = getLiveBody(id);
    if (!body || bodyDimension(id) !== (dim === '2d' ? 2 : 3)) {
        warnOnce(method, id, 'the target has no physics body in the loaded scene (no Physics Body, disabled, or not built yet); the node does nothing.');
        return null;
    }
    return { id, body };
}

function body2D(method: string, target: NodeRefLike): { id: string; body: any } | null {
    return bodyFor(method, '2d', nodeRefId(target));
}

function body3D(method: string, target: Node3DRefLike): { id: string; body: any } | null {
    return bodyFor(method, '3d', node3DRefId(target));
}

function bodyTypeName(value: unknown): PhysicsBodyTypeName | null {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (v === 'static' || v === 'fixed') return 'static';
    if (v === 'dynamic') return 'dynamic';
    if (v === 'kinematic') return 'kinematic';
    return null;
}

/**
 * An OPTIONAL reference input: null when unset (empty / no node picked) ⇒ "any";
 * false when set but unresolvable for this skin (a per-skin ref with no entry).
 */
function optionalRefId(value: unknown, resolve: (v: any) => string | null): string | null | false {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.trim() === '' ? null : value;
    if (typeof value === 'object' && 'nodeId' in (value as object)) {
        const id = (value as { nodeId?: unknown }).nodeId;
        if (typeof id !== 'string' || id === '') return null;
    }
    return resolve(value) || false;
}

function run(method: string, nodeId: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        warnOnce(method, nodeId, `failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

class PhysicsMethods {
    // ── 2D actions ──────────────────────────────────────────────────────────

    public physicsApplyImpulse2D(target: NodeRefLike, x: number, y: number): void {
        const m = 'physicsApplyImpulse2D';
        const b = body2D(m, target);
        if (!b) return;
        const ppm = pixelsPerMeter();
        run(m, b.id, () => b.body.applyImpulse({ x: num(x) / ppm, y: num(y) / ppm }, true));
    }

    public physicsApplyForce2D(target: NodeRefLike, x: number, y: number): void {
        const m = 'physicsApplyForce2D';
        const b = body2D(m, target);
        if (!b) return;
        const ppm = pixelsPerMeter();
        addForceForOneStep(b.id, { x: num(x) / ppm, y: num(y) / ppm });
    }

    public physicsSetVelocity2D(target: NodeRefLike, x: number, y: number): void {
        const m = 'physicsSetVelocity2D';
        const b = body2D(m, target);
        if (!b) return;
        const ppm = pixelsPerMeter();
        run(m, b.id, () => b.body.setLinvel({ x: num(x) / ppm, y: num(y) / ppm }, true));
    }

    public physicsSetAngularVelocity2D(target: NodeRefLike, degreesPerSecond: number): void {
        const m = 'physicsSetAngularVelocity2D';
        const b = body2D(m, target);
        if (!b) return;
        run(m, b.id, () => b.body.setAngvel(num(degreesPerSecond) * DEG, true));
    }

    public physicsSetPosition2D(target: NodeRefLike, x: number, y: number): void {
        const m = 'physicsSetPosition2D';
        const b = body2D(m, target);
        if (!b) return;
        const ppm = pixelsPerMeter();
        teleportBody(b.id, { x: num(x) / ppm, y: num(y) / ppm });
    }

    public physicsSetBodyType2D(target: NodeRefLike, bodyType: string): void {
        const m = 'physicsSetBodyType2D';
        const b = body2D(m, target);
        if (!b) return;
        const type = bodyTypeName(bodyType);
        if (!type) {
            warnOnce(m, b.id, `unknown body type '${String(bodyType)}' (static | dynamic | kinematic).`);
            return;
        }
        setBodyType(b.id, type);
    }

    public physicsSetBodyEnabled2D(target: NodeRefLike, enabled: boolean): void {
        const m = 'physicsSetBodyEnabled2D';
        const b = body2D(m, target);
        if (!b) return;
        setBodyEnabledById(b.id, bool(enabled));
    }

    public physicsSetGravity2D(x: number, y: number): void {
        const m = 'physicsSetGravity2D';
        const mode = physicsMode();
        if (mode !== '2d') {
            worldReady(m, '2d', '');
            return;
        }
        // Applies before Rapier loads too (the world is created with it).
        setGravity({ x: num(x), y: num(y) });
    }

    // ── 3D actions ──────────────────────────────────────────────────────────

    public physicsApplyImpulse3D(target: Node3DRefLike, x: number, y: number, z: number): void {
        const m = 'physicsApplyImpulse3D';
        const b = body3D(m, target);
        if (!b) return;
        run(m, b.id, () => b.body.applyImpulse({ x: num(x), y: num(y), z: num(z) }, true));
    }

    public physicsApplyForce3D(target: Node3DRefLike, x: number, y: number, z: number): void {
        const m = 'physicsApplyForce3D';
        const b = body3D(m, target);
        if (!b) return;
        addForceForOneStep(b.id, { x: num(x), y: num(y), z: num(z) });
    }

    public physicsSetVelocity3D(target: Node3DRefLike, x: number, y: number, z: number): void {
        const m = 'physicsSetVelocity3D';
        const b = body3D(m, target);
        if (!b) return;
        run(m, b.id, () => b.body.setLinvel({ x: num(x), y: num(y), z: num(z) }, true));
    }

    public physicsSetAngularVelocity3D(target: Node3DRefLike, x: number, y: number, z: number): void {
        const m = 'physicsSetAngularVelocity3D';
        const b = body3D(m, target);
        if (!b) return;
        run(m, b.id, () => b.body.setAngvel({ x: num(x) * DEG, y: num(y) * DEG, z: num(z) * DEG }, true));
    }

    public physicsSetPosition3D(target: Node3DRefLike, x: number, y: number, z: number): void {
        const m = 'physicsSetPosition3D';
        const b = body3D(m, target);
        if (!b) return;
        teleportBody(b.id, { x: num(x), y: num(y), z: num(z) });
    }

    public physicsSetBodyType3D(target: Node3DRefLike, bodyType: string): void {
        const m = 'physicsSetBodyType3D';
        const b = body3D(m, target);
        if (!b) return;
        const type = bodyTypeName(bodyType);
        if (!type) {
            warnOnce(m, b.id, `unknown body type '${String(bodyType)}' (static | dynamic | kinematic).`);
            return;
        }
        setBodyType(b.id, type);
    }

    public physicsSetBodyEnabled3D(target: Node3DRefLike, enabled: boolean): void {
        const m = 'physicsSetBodyEnabled3D';
        const b = body3D(m, target);
        if (!b) return;
        setBodyEnabledById(b.id, bool(enabled));
    }

    public physicsSetGravity3D(x: number, y: number, z: number): void {
        const m = 'physicsSetGravity3D';
        if (physicsMode() !== '3d') {
            worldReady(m, '3d', '');
            return;
        }
        setGravity({ x: num(x), y: num(y), z: num(z) });
    }

    // ── Getters ─────────────────────────────────────────────────────────────

    /** Outputs `x`, `y` — linear velocity in scene-root px/s (y-down). */
    public physicsGetVelocity2D(target: NodeRefLike): { x: number; y: number } {
        const m = 'physicsGetVelocity2D';
        const b = body2D(m, target);
        if (!b) return { x: 0, y: 0 };
        try {
            const v = b.body.linvel();
            const ppm = pixelsPerMeter();
            return { x: num(v.x) * ppm, y: num(v.y) * ppm };
        } catch {
            return { x: 0, y: 0 };
        }
    }

    /** Outputs `x`, `y`, `z` — linear velocity in m/s (world axes). */
    public physicsGetVelocity3D(target: Node3DRefLike): { x: number; y: number; z: number } {
        const m = 'physicsGetVelocity3D';
        const b = body3D(m, target);
        if (!b) return { x: 0, y: 0, z: 0 };
        try {
            const v = b.body.linvel();
            return { x: num(v.x), y: num(v.y), z: num(v.z) };
        } catch {
            return { x: 0, y: 0, z: 0 };
        }
    }

    /** Output `value` — touching `other` (solid or sensor), or ANY body when `other` is unset. */
    public physicsIsTouching2D(target: NodeRefLike, other?: NodeRefLike): boolean {
        const b = body2D('physicsIsTouching2D', target);
        if (!b) return false;
        const otherId = optionalRefId(other, nodeRefId);
        return otherId === false ? false : isTouching(b.id, otherId);
    }

    /** Output `value` — touching `other` (solid or sensor), or ANY body when `other` is unset. */
    public physicsIsTouching3D(target: Node3DRefLike, other?: Node3DRefLike): boolean {
        const b = body3D('physicsIsTouching3D', target);
        if (!b) return false;
        const otherId = optionalRefId(other, node3DRefId);
        return otherId === false ? false : isTouching(b.id, otherId);
    }
}

export const physics = new PhysicsMethods();
