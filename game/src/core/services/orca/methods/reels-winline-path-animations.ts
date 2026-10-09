// PARITY CONTRACT: this file must be byte-identical content (modulo imports)
// to the matching file in the editor/template tree
// (`templates/arcade-base-game-template/game/src/core/services/orca/methods/reels-winline-path-animations.ts`).
// If you change one, change both.
//
// 6 winline path-animation presets. Each takes a display object (a
// Graphics or SimpleRope) whose `alpha` is tweenable, and the full cycle
// duration. ALL non-`none` presets loop indefinitely (`repeat: -1`).
//
// SIMPLIFICATIONS (vs. an ideal implementation):
//   - `glow`  : alpha-pulse only. A "true glow" would require redrawing
//               the underlying Graphics with a thicker lineStyle every
//               tick (or compositing an additive Sprite), which both
//               break parity with SimpleRope fill modes. Documented in
//               `agent-docs/scene-editor.md`.
//   - `travel`: asymmetric alpha-pulse approximating a moving spark
//               (sharper fade-in than fade-out). A true sliding
//               highlight would need either a dedicated SimpleRope
//               sub-segment or a uv-offset shader, both of which the
//               editor preview intentionally avoids.
//   - `dash`  : `steps(2)` alpha-blink, since pixi 6 Graphics has no
//               native dashes and uv-tile animation isn't worth the
//               machinery for an editor preview.
import gsap from 'gsap';

export type ReelsWinlinePathAnimation =
  | 'none'
  | 'fadeIn'
  | 'drawOnLeft'
  | 'drawOnRight'
  | 'pulse'
  | 'glow'
  | 'travel'
  | 'dash';

export const REELS_WINLINE_PATH_ANIMATIONS: readonly ReelsWinlinePathAnimation[] = [
  'none', 'fadeIn', 'drawOnLeft', 'drawOnRight', 'pulse', 'glow', 'travel', 'dash',
] as const;

export const REELS_WINLINE_PATH_ANIMATION_DURATION_SEC_DEFAULT = 1;
export const REELS_WINLINE_PATH_ANIMATION_DURATION_SEC_MIN = 0.1;
export const REELS_WINLINE_PATH_ANIMATION_DURATION_SEC_MAX = 10;

export interface ReelsWinlinePathTarget {
  display: { alpha: number };
  origin: { alpha: number };
  /**
   * Optional progressive-reveal hook. Drivers (`drawOnLeft` /
   * `drawOnRight`) call this with t ∈ [0, 1] every tick. The renderer
   * rebuilds the underlying display object so only the visible prefix
   * (left) or suffix (right) of the total polyline length renders.
   * Other appliers ignore this hook.
   */
  setRevealFraction?: (t: number, direction: 'left' | 'right') => void;
}

export type ReelsWinlinePathApplier = (
  target: ReelsWinlinePathTarget,
  durationSec: number,
  intensity: number,
  ease: string,
) => gsap.core.Tween | gsap.core.Timeline | null;

const safeDuration = (durationSec: number): number => (
  Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : REELS_WINLINE_PATH_ANIMATION_DURATION_SEC_DEFAULT
);

const clamp01 = (n: number): number => (
  Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5
);

export const REELS_WINLINE_PATH_APPLIERS: Record<ReelsWinlinePathAnimation, ReelsWinlinePathApplier> = {
  none: () => null,

  // Renamed from 'drawOn' — a pure alpha fade-in. Wave 2 will add the real
  // progressive-reveal appliers for 'drawOnLeft' / 'drawOnRight' (which
  // currently share this same implementation as stubs).
  fadeIn: ({ display, origin }, durationSec, _intensity, ease) => {
    const d = safeDuration(durationSec);
    display.alpha = 0;
    const tl = gsap.timeline({ repeat: -1 });
    tl.to(display, { alpha: origin.alpha, duration: d * 0.5, ease });
    tl.to({}, { duration: d * 0.3 });
    tl.to(display, { alpha: 0, duration: d * 0.2, ease });
    return tl;
  },

  // Progressive left-to-right reveal. Delegates the actual rope/graphics
  // rebuild to `target.setRevealFraction` (set up by Pixi8Adapter when
  // `winlinePathAnimation === 'drawOnLeft'`). Loops with a brief hold
  // at full reveal, then snaps back to 0 for the next cycle. `intensity`
  // compresses the duration (higher = faster reveal).
  drawOnLeft: ({ display, origin, setRevealFraction }, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const speed = 1 / Math.max(0.25, i || 0.5);
    display.alpha = origin.alpha;
    const tl = gsap.timeline({ repeat: -1 });
    const state = { t: 0 };
    tl.to(state, {
      t: 1,
      duration: d * 0.5 * speed,
      ease,
      onUpdate: () => {
        try { setRevealFraction?.(state.t, 'left'); } catch { /* ignore */ }
      },
    });
    tl.to({}, { duration: d * 0.3 * speed });
    tl.set(state, { t: 0, onComplete: () => { try { setRevealFraction?.(0, 'left'); } catch { /* ignore */ } } });
    tl.to({}, { duration: d * 0.2 * speed });
    return tl;
  },

  // Progressive right-to-left reveal. Symmetric counterpart to
  // `drawOnLeft`; the renderer's reveal callback receives `'right'` so
  // it preserves the suffix of the polyline.
  drawOnRight: ({ display, origin, setRevealFraction }, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const speed = 1 / Math.max(0.25, i || 0.5);
    display.alpha = origin.alpha;
    const tl = gsap.timeline({ repeat: -1 });
    const state = { t: 0 };
    tl.to(state, {
      t: 1,
      duration: d * 0.5 * speed,
      ease,
      onUpdate: () => {
        try { setRevealFraction?.(state.t, 'right'); } catch { /* ignore */ }
      },
    });
    tl.to({}, { duration: d * 0.3 * speed });
    tl.set(state, { t: 0, onComplete: () => { try { setRevealFraction?.(0, 'right'); } catch { /* ignore */ } } });
    tl.to({}, { duration: d * 0.2 * speed });
    return tl;
  },

  pulse: ({ display, origin }, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const low = Math.max(0, 1 - 0.6 * i);
    return gsap.to(display, {
      alpha: origin.alpha * low,
      duration: d / 2,
      yoyo: true,
      repeat: -1,
      ease,
    });
  },

  // NOTE: pixi 6 `Graphics`/`SimpleRope` cannot dynamically change stroke
  // thickness once drawn, so `glow` remains an alpha-pulse approximation
  // (see header SIMPLIFICATIONS). `intensity` scales the alpha pulse depth
  // in lieu of the literal thickness pulse described in the spec.
  glow: ({ display, origin }, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const low = Math.max(0, 1 - 0.5 * i);
    return gsap.to(display, {
      alpha: Math.min(1, origin.alpha) * low,
      duration: d / 2,
      yoyo: true,
      repeat: -1,
      ease,
    });
  },

  travel: ({ display, origin }, durationSec, _intensity, ease) => {
    const d = safeDuration(durationSec);
    const tl = gsap.timeline({ repeat: -1 });
    tl.to(display, { alpha: origin.alpha, duration: d * 0.3, ease });
    tl.to(display, { alpha: origin.alpha * 0.4, duration: d * 0.7, ease });
    return tl;
  },

  dash: ({ display, origin }, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const low = Math.max(0, 1 - 0.7 * i);
    return gsap.to(display, {
      alpha: origin.alpha * low,
      duration: d * 0.25,
      yoyo: true,
      repeat: -1,
      ease,
    });
  },
};
