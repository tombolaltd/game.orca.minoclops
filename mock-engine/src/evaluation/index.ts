// The win-evaluation block: canonical, dependency-free primitives a mechanic composes instead of
// re-deriving line/ways maths. Ported from the game-studio prototyping harness'
// `proto-design-system/src/evaluation/`.
//
// A mechanic under `src/games/<key>/` — bundled OR agent-generated — imports from here:
//
//     import { evaluateLines, evaluateWays, tieredMultiplier } from '../../evaluation';
//
// and an outside consumer gets the same names off the engine barrel (`mock-engine/src`).
//
// ── One implementation, deliberately ────────────────────────────────────────────────────────
// `lines-slot` and `ways-slot` run through these evaluators, so there is no second copy of the
// run-detection maths in the tree. The harness this was ported from shipped a simulator that
// re-implemented its own spin maths and the two drifted ~3.7 % apart on RTP before they were
// merged onto one path — the same reason `src/sim/` drives the real request pipeline. A mechanic
// that needs a rule these options cannot express should EXTEND them here, not fork the walk.
//
// ── Pixi-free, and staying that way ─────────────────────────────────────────────────────────
// The source barrel was deliberately importable by a server-side engine without dragging in the
// browser component graph (which loads PNG assets at module load). Nothing here may import a
// renderer, an asset, or anything outside this folder's own siblings.
//
// ⚠️ PROTOTYPING ONLY: not RNG-certified, not audited. Correct building blocks, not a certified
// maths model — measure a mechanic with `POST /sim` before believing its RTP.

export * from './types';
export * from './paytable';
export * from './evaluateLines';
export * from './evaluateWays';
