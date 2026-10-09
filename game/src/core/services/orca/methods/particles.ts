import * as PIXI from "pixi.js";
import type { NodeRefLike } from "./node-ref";
import { resolveNode } from "./node-ref";

/**
 * The slice of `OrcaParticleEmitter` (`../particle-emitter`) these methods
 * drive. Declared structurally so this file has no import on that module.
 */
interface ParticleEmitterHandle {
    emit: boolean;
    burst(count: number): void;
}

/**
 * Particles controls. Targets a scene-graph node of type 'particles'.
 * SceneManager attaches the live emitter to the node's container as
 * `__particleEmitter` at build time.
 */
class ParticlesMethods {
    private getEmitter(target: NodeRefLike): ParticleEmitterHandle | null {
        const c = resolveNode<PIXI.Container>(target, PIXI.Container);
        if (!c) return null;
        const e = (c as PIXI.Container & { __particleEmitter?: ParticleEmitterHandle }).__particleEmitter;
        if (!e) {
            console.warn('[FlowState] particles target has no live emitter (is it a particles node?)');
            return null;
        }
        return e;
    }

    public startParticles(target: NodeRefLike): void {
        const e = this.getEmitter(target); if (e) e.emit = true;
    }
    public stopParticles(target: NodeRefLike): void {
        const e = this.getEmitter(target); if (e) e.emit = false;
    }
    public emitParticleBurst(target: NodeRefLike, count: number): void {
        this.getEmitter(target)?.burst(Number.isFinite(count) ? count : 0);
    }
    public setParticlesEmitterEnabled(target: NodeRefLike, enabled: boolean): void {
        const e = this.getEmitter(target); if (e) e.emit = enabled !== false;
    }
}

export const particles = new ParticlesMethods();
