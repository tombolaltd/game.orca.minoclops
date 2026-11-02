import type { CustomNodeDefinition } from './orca-custom-node';
import * as PIXI from 'pixi.js';
import { resolveNode } from '../methods/node-ref';
import type { NodeRefLike } from '../methods/node-ref';

/**
 * Play video to end
 *
 * Inputs below become `run`'s positional parameters, in order.
 * Outputs: none -> return void. One -> return the value.
 * Two or more -> return an object keyed by each output name.
 */
export const definition: CustomNodeDefinition = {
  name: 'playVideoToEnd',
  friendlyTitle: 'Play video to end',
  description: 'Plays a Video node from its start and waits until it has played to its end, however late it starts, so the next step runs when the video really finishes. Stops waiting when the video is stopped, or after Max Wait seconds if it cannot play.',
  icon: '🎬',
  color: '#2c3e50',
  nodeType: 'sequence',
  inputs: [
    { name: 'target', type: 'nodeRef', description: 'The Video scene node (not looping)' },
    { name: 'maxWait', type: 'float', default: 10, description: 'Seconds to wait at most, in case the video cannot load or play' }
  ],
  outputs: []
};

const POLL_MS = 50;
const RETRY_PLAY_MS = 250;

function videoOf(target: NodeRefLike): HTMLVideoElement | null {
  const sprite = resolveNode<PIXI.Sprite>(target, PIXI.Sprite);
  return (sprite as unknown as { __videoEl?: HTMLVideoElement } | null)?.__videoEl ?? null;
}

export function run(target: NodeRefLike, maxWait: number): Promise<void> {
  const limitMs = (Number.isFinite(maxWait) && maxWait > 0 ? maxWait : 10) * 1000;
  const startedAt = performance.now();
  let current: HTMLVideoElement | null = null;
  let playing = false;
  let lastPlayCall = -Infinity;

  return new Promise<void>(resolve => {
    const timer = setInterval(() => {
      const el = videoOf(target);
      const finish = (): void => { clearInterval(timer); resolve(); };
      if (!el) return finish();
      if (el !== current) {
        // First look, or the scene rebuilt the video: start it from the beginning.
        current = el;
        playing = false;
        try { el.currentTime = 0; } catch { /* not loaded yet: it starts at 0 anyway */ }
      }
      if (playing) {
        if (el.ended || el.paused) return finish();
      } else if (!el.paused && el.currentTime > 0) {
        playing = true;
      } else if (el.paused && performance.now() - lastPlayCall > RETRY_PLAY_MS) {
        // A play request can be cancelled while the video loads; ask again until it really runs.
        lastPlayCall = performance.now();
        el.play().catch(() => { /* asked again on a later tick */ });
      }
      if (performance.now() - startedAt > limitMs) finish();
    }, POLL_MS);
  });
}
