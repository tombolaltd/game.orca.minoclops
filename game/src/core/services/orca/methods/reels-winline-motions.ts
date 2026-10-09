// PARITY CONTRACT: this file must be byte-identical content (modulo imports)
// to the matching file in the editor/template tree
// (`templates/arcade-base-game-template/game/src/core/services/orca/methods/reels-winline-motions.ts`).
// If you change one, change both.
//
// 11 winning-symbol motion presets ('none' + 10 looping appliers).
// Each preset declares how to apply gsap to a target container, given
// the full cycle duration in seconds, an intensity scalar (0..1) and a
// gsap ease string. ALL non-`none` presets loop indefinitely
// (`repeat: -1`) and return a cancellable
// `gsap.core.Tween | gsap.core.Timeline`.
//
// `durationSec` semantics:
//   - For yoyo loops, ONE full forward-and-back cycle == `durationSec`
//     (gsap's `duration` is therefore `durationSec / 2` for yoyo configs).
//   - For `spin`, ONE full revolution-set == `durationSec`.
//   - For `heartbeat`, ONE beat-pair + idle == `durationSec`.
//   - For `shake`, the sub-jitter period is `0.1 * durationSec`.
//
// `intensity` (0..1) scales the natural amplitude of each preset.
// `intensity = 0.5` reproduces the previous defaults.
//
// `ease` is a gsap ease string. Validation against `REELS_WINLINE_EASES`
// is the caller's responsibility (the normalizer); appliers pass it
// through unchanged.
import gsap from 'gsap';

export type ReelsWinningTweenStyle =
  | 'none'
  | 'pulse'
  | 'bounce'
  | 'pop'
  | 'shake'
  | 'spin'
  | 'wiggle'
  | 'sway'
  | 'flash'
  | 'expand'
  | 'heartbeat';

export const REELS_WINNING_TWEEN_STYLES: readonly ReelsWinningTweenStyle[] = [
  'none', 'pulse', 'bounce', 'pop', 'shake', 'spin', 'wiggle',
  'sway', 'flash', 'expand', 'heartbeat',
] as const;

export const REELS_WINNING_TWEEN_DURATION_SEC_DEFAULT = 1;
export const REELS_WINNING_TWEEN_DURATION_SEC_MIN = 0.1;
export const REELS_WINNING_TWEEN_DURATION_SEC_MAX = 10;

/** Whitelist of gsap ease strings the editor/runtime accept for the
 *  winning-symbol motion and winline path animation appliers. The
 *  normalizer falls back to `'sine.inOut'` when an unknown ease is
 *  encountered on a node. */
export const REELS_WINLINE_EASES = [
  'none',
  'power1.in', 'power1.out', 'power1.inOut',
  'power2.in', 'power2.out', 'power2.inOut',
  'power3.in', 'power3.out', 'power3.inOut',
  'sine.in', 'sine.out', 'sine.inOut',
  'expo.in', 'expo.out', 'expo.inOut',
  'back.in', 'back.out', 'back.inOut',
  'elastic.in', 'elastic.out', 'elastic.inOut',
  'bounce.in', 'bounce.out', 'bounce.inOut',
] as const;
export type ReelsWinlineEase = typeof REELS_WINLINE_EASES[number];

export interface ReelsMotionContainer {
  scale: { x: number; y: number };
  position: { x: number; y: number };
  rotation: number;
  alpha: number;
}

export type ReelsWinningMotionApplier = (
  target: ReelsMotionContainer,
  durationSec: number,
  intensity: number,
  ease: string,
) => gsap.core.Tween | gsap.core.Timeline | null;

const safeDuration = (durationSec: number): number => (
  Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : REELS_WINNING_TWEEN_DURATION_SEC_DEFAULT
);

const clamp01 = (n: number): number => (
  Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5
);

export const REELS_WINNING_MOTION_APPLIERS: Record<ReelsWinningTweenStyle, ReelsWinningMotionApplier> = {
  none: () => null,

  pulse: (target, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const scaleMul = 1 + 0.30 * i;
    const originScaleX = target.scale.x;
    const originScaleY = target.scale.y;
    return gsap.to(target.scale, {
      x: originScaleX * scaleMul,
      y: originScaleY * scaleMul,
      duration: d / 2,
      yoyo: true,
      repeat: -1,
      ease,
      overwrite: 'auto',
    });
  },

  bounce: (target, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const offset = 20 * i;
    const originY = target.position.y;
    return gsap.to(target.position, {
      y: originY - offset,
      duration: d / 2,
      yoyo: true,
      repeat: -1,
      ease,
    });
  },

  pop: (target, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const scaleMul = 1 + 0.50 * i;
    const originScaleX = target.scale.x;
    const originScaleY = target.scale.y;
    const tl = gsap.timeline({ repeat: -1 });
    tl.to(target.scale, {
      x: originScaleX * scaleMul,
      y: originScaleY * scaleMul,
      duration: d * 0.4,
      ease,
    });
    tl.to(target.scale, {
      x: originScaleX,
      y: originScaleY,
      duration: d * 0.3,
      ease,
    });
    tl.to({}, { duration: d * 0.3 });
    return tl;
  },

  shake: (target, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const amplitude = 12 * i;
    const originX = target.position.x;
    return gsap.to(target.position, {
      x: originX + amplitude,
      duration: d * 0.1,
      yoyo: true,
      repeat: -1,
      ease,
    });
  },

  spin: (target, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const spins = 1 + Math.round(2 * i);
    const originRotation = target.rotation;
    return gsap.to(target, {
      rotation: originRotation + Math.PI * 2 * spins,
      duration: d,
      repeat: -1,
      ease,
    });
  },

  wiggle: (target, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const amplitude = 0.3 * i;
    const originRotation = target.rotation;
    return gsap.to(target, {
      rotation: originRotation + amplitude,
      duration: d / 2,
      yoyo: true,
      repeat: -1,
      ease,
    });
  },

  sway: (target, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const amplitudeRot = 0.16 * i;
    const amplitudeX = 8 * i;
    const originRotation = target.rotation;
    const originX = target.position.x;
    const tl = gsap.timeline({ repeat: -1, yoyo: true });
    tl.to(target, {
      rotation: originRotation + amplitudeRot,
      duration: d / 2,
      ease,
    }, 0);
    tl.to(target.position, {
      x: originX + amplitudeX,
      duration: d / 2,
      ease,
    }, 0);
    return tl;
  },

  flash: (target, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const low = Math.max(0, 1 - 0.8 * i);
    const originAlpha = target.alpha;
    return gsap.to(target, {
      alpha: originAlpha * low,
      duration: d / 2,
      yoyo: true,
      repeat: -1,
      ease,
    });
  },

  expand: (target, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const scaleMul = 1 + 0.8 * i;
    const originScaleX = target.scale.x;
    const originScaleY = target.scale.y;
    return gsap.to(target.scale, {
      x: originScaleX * scaleMul,
      y: originScaleY * scaleMul,
      duration: d / 2,
      yoyo: true,
      repeat: -1,
      ease,
      overwrite: 'auto',
    });
  },

  heartbeat: (target, durationSec, intensity, ease) => {
    const d = safeDuration(durationSec);
    const i = clamp01(intensity);
    const firstMul = 1 + 0.2 * i;
    const secondMul = 1 + 0.4 * i;
    const originScaleX = target.scale.x;
    const originScaleY = target.scale.y;
    const tl = gsap.timeline({ repeat: -1, overwrite: 'auto' });
    tl.to(target.scale, {
      x: originScaleX * firstMul,
      y: originScaleY * firstMul,
      duration: d * 0.12,
      ease,
    });
    tl.to(target.scale, {
      x: originScaleX,
      y: originScaleY,
      duration: d * 0.12,
      ease,
    });
    tl.to(target.scale, {
      x: originScaleX * secondMul,
      y: originScaleY * secondMul,
      duration: d * 0.12,
      ease,
    });
    tl.to(target.scale, {
      x: originScaleX,
      y: originScaleY,
      duration: d * 0.12,
      ease,
    });
    tl.to({}, { duration: d * 0.52 });
    return tl;
  },
};
