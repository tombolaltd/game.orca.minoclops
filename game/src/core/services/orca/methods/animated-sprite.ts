import * as PIXI from "pixi.js";
import type { NodeRefLike } from "./node-ref";
import { resolveNode } from "./node-ref";

/**
 * AnimatedSprite (frame-array) controls. Targets a scene-graph node of
 * type 'animatedSprite' (PIXI.AnimatedSprite under the hood).
 */
class AnimatedSpriteMethods {
    private get(target: NodeRefLike): PIXI.AnimatedSprite | null {
        return resolveNode<PIXI.AnimatedSprite>(target, PIXI.AnimatedSprite);
    }

    public playAnimatedSprite(target: NodeRefLike): void {
        this.get(target)?.play();
    }
    public stopAnimatedSprite(target: NodeRefLike): void {
        this.get(target)?.stop();
    }
    public gotoAndPlayAnimatedSprite(target: NodeRefLike, frame: number): void {
        this.get(target)?.gotoAndPlay(frame | 0);
    }
    public gotoAndStopAnimatedSprite(target: NodeRefLike, frame: number): void {
        this.get(target)?.gotoAndStop(frame | 0);
    }
    public setAnimatedSpriteSpeed(target: NodeRefLike, animationSpeed: number): void {
        const a = this.get(target); if (a) a.animationSpeed = animationSpeed;
    }
    public setAnimatedSpriteLoop(target: NodeRefLike, loop: boolean): void {
        const a = this.get(target); if (a) a.loop = loop;
    }
}

export const animatedSprite = new AnimatedSpriteMethods();
