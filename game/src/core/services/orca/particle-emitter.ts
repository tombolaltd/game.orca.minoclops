// PARITY CONTRACT: this file must be byte-identical content (modulo imports)
// to the matching file in the other tree
// (`src/services/pixi/particleEmitter.ts` in the editor,
// `templates/arcade-base-game-template/game/src/core/services/orca/particle-emitter.ts`
// in the bundled game template). If you change one, change both.
//
// Pixi 8 particle emitter for Orca `particles` scene nodes. It reads the
// `@pixi/particle-emitter` v5 config format that authored `.reef` data already
// uses (a `behaviors` array), plus the older pre-behaviour format via
// `upgradeParticleConfig`. That package never shipped a Pixi 8 build, so this
// is a self-contained reimplementation rendered through `ParticleContainer`.
//
// A Pixi 8 `ParticleContainer` draws every child from ONE texture source, so
// particles are grouped per `TextureSource`, one container each. Textures are
// resolved by the CALLER (`resolveTexture`) — the editor and the runtime load
// assets differently, and this module never performs I/O.
import {
  Container,
  extensions,
  GlParticleContainerPipe,
  GpuParticleContainerPipe,
  Particle,
  ParticleContainer,
  Rectangle,
  Texture,
} from 'pixi.js';
import type { BLEND_MODES, TextureSource } from 'pixi.js';

// Same registration as `pixi.js/particle-container`, which the game cannot import:
// its webpack aliases `pixi.js` to a directory, so package subpath exports never resolve.
extensions.add(GlParticleContainerPipe, GpuParticleContainerPipe);

export type ParticleTextureResolver = (ref: string) => Texture | null | undefined;

export interface ParticleEmitterOptions {
  /** Map an authored texture ref to a live texture. Called once per ref. */
  resolveTexture: ParticleTextureResolver;
  /** Diagnostics sink; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

export interface ParticleBehaviorConfig {
  type: string;
  config: Record<string, unknown>;
}

/** A normalized v5-style emitter config (behaviour textures still refs). */
export interface ParticleEmitterConfig {
  lifetime: { min: number; max: number };
  frequency: number;
  spawnChance: number;
  particlesPerWave: number;
  emitterLifetime: number;
  maxParticles: number;
  addAtBack: boolean;
  pos: { x: number; y: number };
  ease?: unknown;
  behaviors: ParticleBehaviorConfig[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Config parsing / normalization
// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse an inline config value (object or JSON string). Null when unusable. */
export function parseParticleConfigValue(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type LegacyRange = { start?: unknown; end?: unknown; list?: unknown; minimumSpeedMultiplier?: unknown; minimumScaleMultiplier?: unknown };

function legacyListOf(range: LegacyRange): { list: Array<{ time: number; value: unknown }> } | null {
  if (Array.isArray((range as { list?: unknown }).list)) return range as { list: Array<{ time: number; value: unknown }> };
  if ('start' in range) {
    return { list: [{ time: 0, value: range.start }, { time: 1, value: range.end ?? range.start }] };
  }
  return null;
}

function legacyFirstValue(range: LegacyRange): unknown {
  const list = legacyListOf(range);
  return list && list.list.length > 0 ? list.list[0].value : undefined;
}

function legacyIsConstant(range: LegacyRange): boolean {
  const list = legacyListOf(range);
  if (!list || list.list.length === 0) return true;
  return list.list.every((entry) => entry.value === list.list[0].value);
}

/**
 * Convert a pre-behaviour (`@pixi/particle-emitter` v3/v4) config to the
 * behaviour format. A config that already has `behaviors` is returned as-is.
 */
export function upgradeParticleConfig(config: Record<string, unknown>, art: unknown): Record<string, unknown> {
  if (Array.isArray(config.behaviors)) return config;
  const c = config as Record<string, any>;
  const behaviors: ParticleBehaviorConfig[] = [];
  const out: Record<string, unknown> = {
    lifetime: c.lifetime,
    ease: c.ease,
    particlesPerWave: c.particlesPerWave,
    frequency: c.frequency,
    spawnChance: c.spawnChance,
    emitterLifetime: c.emitterLifetime,
    maxParticles: c.maxParticles,
    addAtBack: c.addAtBack,
    pos: c.pos,
    behaviors,
  };

  if (isPlainObject(c.alpha)) {
    if (legacyIsConstant(c.alpha)) {
      const value = finiteOr(legacyFirstValue(c.alpha), 1);
      if (value !== 1) behaviors.push({ type: 'alphaStatic', config: { alpha: value } });
    } else {
      behaviors.push({ type: 'alpha', config: { alpha: legacyListOf(c.alpha) } });
    }
  }

  const speed: LegacyRange = isPlainObject(c.speed) ? c.speed : {};
  const speedMult = finiteOr(speed.minimumSpeedMultiplier, 1);
  const firstSpeed = finiteOr(legacyFirstValue(speed), 0);
  if (isPlainObject(c.acceleration) && (c.acceleration.x || c.acceleration.y)) {
    behaviors.push({
      type: 'moveAcceleration',
      config: {
        accel: c.acceleration,
        minStart: firstSpeed * speedMult,
        maxStart: firstSpeed,
        rotate: !c.noRotation,
        maxSpeed: c.maxSpeed,
      },
    });
  } else if (isPlainObject(c.extraData) && typeof c.extraData.path === 'string') {
    behaviors.push({ type: 'movePath', config: { path: c.extraData.path, speed: legacyListOf(speed), minMult: speedMult } });
  } else if (isPlainObject(c.speed)) {
    if (legacyIsConstant(speed)) {
      behaviors.push({ type: 'moveSpeedStatic', config: { min: firstSpeed * speedMult, max: firstSpeed } });
    } else {
      behaviors.push({ type: 'moveSpeed', config: { speed: legacyListOf(speed), minMult: speedMult } });
    }
  }

  if (isPlainObject(c.scale)) {
    const scaleMult = finiteOr((c.scale as LegacyRange).minimumScaleMultiplier, 1);
    if (legacyIsConstant(c.scale)) {
      const value = finiteOr(legacyFirstValue(c.scale), 1);
      behaviors.push({ type: 'scaleStatic', config: { min: value * scaleMult, max: value } });
    } else {
      behaviors.push({ type: 'scale', config: { scale: legacyListOf(c.scale), minMult: scaleMult } });
    }
  }

  if (isPlainObject(c.color)) {
    if (legacyIsConstant(c.color)) {
      const value = legacyFirstValue(c.color);
      if (typeof value === 'string' && value.replace('#', '').toLowerCase() !== 'ffffff') {
        behaviors.push({ type: 'colorStatic', config: { color: value } });
      }
    } else {
      behaviors.push({ type: 'color', config: { color: legacyListOf(c.color) } });
    }
  }

  const startRotation = isPlainObject(c.startRotation) ? c.startRotation : {};
  const rotationSpeed = isPlainObject(c.rotationSpeed) ? c.rotationSpeed : {};
  if (c.rotationAcceleration || rotationSpeed.min || rotationSpeed.max) {
    behaviors.push({
      type: 'rotation',
      config: {
        accel: finiteOr(c.rotationAcceleration, 0),
        minSpeed: finiteOr(rotationSpeed.min, 0),
        maxSpeed: finiteOr(rotationSpeed.max, 0),
        minStart: finiteOr(startRotation.min, 0),
        maxStart: finiteOr(startRotation.max, 0),
      },
    });
  } else if (startRotation.min || startRotation.max) {
    behaviors.push({ type: 'rotationStatic', config: { min: finiteOr(startRotation.min, 0), max: finiteOr(startRotation.max, 0) } });
  }
  if (c.noRotation) behaviors.push({ type: 'noRotation', config: { rotation: 0 } });

  if (typeof c.blendMode === 'string' && c.blendMode !== 'normal') {
    behaviors.push({ type: 'blendMode', config: { blendMode: c.blendMode } });
  }

  if (Array.isArray(art)) {
    behaviors.push({ type: c.orderedArt ? 'textureOrdered' : 'textureRandom', config: { textures: art } });
  } else {
    behaviors.push({ type: 'textureSingle', config: { texture: typeof art === 'string' ? art : '' } });
  }

  if (c.spawnType === 'burst') {
    behaviors.push({ type: 'spawnBurst', config: { start: finiteOr(c.angleStart, 0), spacing: finiteOr(c.particleSpacing, 0), distance: 0 } });
  } else if (c.spawnType === 'point' || !c.spawnType) {
    behaviors.push({ type: 'spawnPoint', config: {} });
  } else if (c.spawnType === 'rect' && isPlainObject(c.spawnRect)) {
    behaviors.push({ type: 'spawnShape', config: { type: 'rect', data: c.spawnRect } });
  } else if ((c.spawnType === 'circle' || c.spawnType === 'ring') && isPlainObject(c.spawnCircle)) {
    behaviors.push({
      type: 'spawnShape',
      config: {
        type: 'torus',
        data: {
          x: c.spawnCircle.x,
          y: c.spawnCircle.y,
          radius: c.spawnCircle.r,
          innerRadius: c.spawnType === 'ring' ? c.spawnCircle.minR : 0,
          affectRotation: c.spawnType === 'ring',
        },
      },
    });
  } else if (c.spawnType === 'polygonalChain' && Array.isArray(c.spawnPolygon)) {
    behaviors.push({ type: 'spawnShape', config: { type: 'polygonalChain', data: c.spawnPolygon } });
  }

  return out;
}

/**
 * Normalize an authored particle config (object or JSON string) into a
 * complete v5-style config. Never throws: an unusable value yields a default
 * emitter with no behaviours. Behaviours the author did not declare are NOT
 * invented — a missing behaviour means "static default", exactly as the
 * original package treated it.
 */
export function normalizeParticleConfig(raw: unknown): ParticleEmitterConfig {
  const parsed = parseParticleConfigValue(raw) ?? {};
  let upgraded: Record<string, unknown>;
  try {
    const legacyArt = typeof parsed.texture === 'string'
      ? parsed.texture.trim()
      : Array.isArray(parsed.textures) ? parsed.textures : '';
    upgraded = upgradeParticleConfig(parsed, legacyArt);
  } catch {
    upgraded = { behaviors: [] };
  }

  const lifetime = isPlainObject(upgraded.lifetime) ? upgraded.lifetime : {};
  const lifeMin = Math.max(0.001, finiteOr(lifetime.min, 0.5));
  const lifeMax = Math.max(lifeMin, finiteOr(lifetime.max, lifeMin));
  const pos = isPlainObject(upgraded.pos) ? upgraded.pos : {};
  const frequency = finiteOr(upgraded.frequency, 0.008);
  const emitterLifetime = finiteOr(upgraded.emitterLifetime, -1);

  const behaviors: ParticleBehaviorConfig[] = [];
  if (Array.isArray(upgraded.behaviors)) {
    for (const entry of upgraded.behaviors) {
      if (!isPlainObject(entry) || typeof entry.type !== 'string') continue;
      behaviors.push({ type: entry.type, config: isPlainObject(entry.config) ? entry.config : {} });
    }
  }

  return {
    lifetime: { min: lifeMin, max: lifeMax },
    frequency: frequency > 0 ? frequency : 0.008,
    spawnChance: Math.max(0, Math.min(1, finiteOr(upgraded.spawnChance, 1))),
    particlesPerWave: Math.max(1, Math.floor(finiteOr(upgraded.particlesPerWave, 1))),
    emitterLifetime: emitterLifetime === 0 ? -1 : emitterLifetime,
    maxParticles: Math.max(0, Math.floor(finiteOr(upgraded.maxParticles, 1000))),
    addAtBack: upgraded.addAtBack === true,
    pos: { x: finiteOr(pos.x, 0), y: finiteOr(pos.y, 0) },
    ease: upgraded.ease,
    behaviors,
  };
}

const TEXTURE_BEHAVIOR_TYPES = new Set(['textureSingle', 'textureRandom', 'textureOrdered', 'animatedSingle', 'animatedRandom']);

function collectAnimTextureRefs(anim: unknown, out: string[]): void {
  if (!isPlainObject(anim) || !Array.isArray(anim.textures)) return;
  for (const frame of anim.textures) {
    if (typeof frame === 'string') out.push(frame);
    else if (isPlainObject(frame) && typeof frame.texture === 'string') out.push(frame.texture);
  }
}

/** Every texture ref a normalized config needs, de-duplicated, in order. */
export function collectParticleTextureRefs(config: ParticleEmitterConfig): string[] {
  const refs: string[] = [];
  for (const behavior of config.behaviors) {
    if (!TEXTURE_BEHAVIOR_TYPES.has(behavior.type)) continue;
    const c = behavior.config;
    if (typeof c.texture === 'string') refs.push(c.texture);
    if (Array.isArray(c.textures)) {
      for (const t of c.textures) if (typeof t === 'string') refs.push(t);
    }
    collectAnimTextureRefs(c.anim, refs);
    if (Array.isArray(c.anims)) for (const anim of c.anims) collectAnimTextureRefs(anim, refs);
  }
  const seen = new Set<string>();
  return refs.map((r) => r.trim()).filter((r) => r && !seen.has(r) && (seen.add(r), true));
}

// ─────────────────────────────────────────────────────────────────────────────
// Value lists, easing, path expressions
// ─────────────────────────────────────────────────────────────────────────────

type EaseFn = (t: number) => number;

/** `@pixi/particle-emitter` custom ease: quadratic segments `{ s, cp, e }`. */
function buildEase(raw: unknown): EaseFn | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const segments = raw
    .filter(isPlainObject)
    .map((s) => ({ s: finiteOr(s.s, 0), cp: finiteOr(s.cp, 0), e: finiteOr(s.e, 1) }));
  if (segments.length === 0) return null;
  const qty = segments.length;
  const oneOverQty = 1 / qty;
  return (time: number) => {
    const i = (qty * time) | 0;
    const t = (time - i * oneOverQty) * qty;
    const s = segments[i] || segments[qty - 1];
    return s.s + t * (2 * (1 - t) * (s.cp - s.s) + t * (s.e - s.s));
  };
}

interface ListStep {
  time: number;
  value: number[];
}

/** A time-keyed value list, interpolated component-wise (1 for numbers, 3 for colours). */
class ValueList {
  private readonly steps: ListStep[];
  private readonly stepped: boolean;
  private readonly ease: EaseFn | null;
  readonly first: number[];

  constructor(raw: unknown, parse: (value: unknown) => number[] | null, fallback: number[]) {
    const container = isPlainObject(raw) ? raw : { list: [{ time: 0, value: raw }] };
    const entries = Array.isArray(container.list) ? container.list : [];
    const steps: ListStep[] = [];
    entries.forEach((entry, index) => {
      if (!isPlainObject(entry)) return;
      const value = parse(entry.value);
      if (!value) return;
      const time = Math.max(0, Math.min(1, finiteOr(entry.time, index === 0 ? 0 : 1)));
      steps.push({ time, value });
    });
    steps.sort((a, b) => a.time - b.time);
    if (steps.length === 0) steps.push({ time: 0, value: fallback });
    this.steps = steps;
    this.stepped = container.isStepped === true;
    this.ease = buildEase(container.ease);
    this.first = steps[0].value;
  }

  at(lerp: number, out: number[]): number[] {
    const steps = this.steps;
    let t = lerp < 0 ? 0 : lerp > 1 ? 1 : lerp;
    if (this.ease) t = this.ease(t);
    if (steps.length === 1 || t <= steps[0].time) return copyInto(out, steps[0].value);
    const last = steps[steps.length - 1];
    if (t >= last.time) return copyInto(out, last.value);
    let i = 0;
    while (i < steps.length - 2 && t >= steps[i + 1].time) i++;
    const a = steps[i];
    if (this.stepped) return copyInto(out, a.value);
    const b = steps[i + 1];
    const span = b.time - a.time;
    const k = span > 0 ? (t - a.time) / span : 1;
    for (let c = 0; c < a.value.length; c++) out[c] = a.value[c] + (b.value[c] - a.value[c]) * k;
    return out;
  }
}

function copyInto(out: number[], src: number[]): number[] {
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

function parseNumber(value: unknown): number[] | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? [n] : null;
}

/** `'ff8800'` / `'#f80'` / `0xff8800` → `[r, g, b]` (0–255). */
function parseColor(value: unknown): number[] | null {
  let hex: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    hex = Math.max(0, Math.min(0xffffff, Math.floor(value)));
  } else if (typeof value === 'string') {
    let s = value.trim().replace(/^#/, '').replace(/^0x/i, '');
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((ch) => ch + ch).join('');
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    hex = parseInt(s, 16);
  } else {
    return null;
  }
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

const PATH_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sqrt: Math.sqrt,
  cos: Math.cos, sin: Math.sin, tan: Math.tan, acos: Math.acos, asin: Math.asin,
  atan: Math.atan, atan2: Math.atan2, log: Math.log, exp: Math.exp,
  max: Math.max, min: Math.min, pow: Math.pow, random: Math.random,
};

const PATH_CONSTANTS: Record<string, number> = {
  E: Math.E, LN2: Math.LN2, LN10: Math.LN10, LOG2E: Math.LOG2E, LOG10E: Math.LOG10E,
  PI: Math.PI, SQRT1_2: Math.SQRT1_2, SQRT2: Math.SQRT2,
};

type PathNode = (x: number) => number;

/**
 * Compile a `movePath` expression such as `sin(x / 20) * 30` into y = f(x).
 * A small recursive-descent parser — authored data is never handed to
 * `eval` / `new Function`. `Math.` prefixes are accepted and ignored.
 */
export function compileParticlePath(source: string): PathNode | null {
  const tokens = source.replace(/Math\./g, '').match(/\d*\.?\d+(?:e[+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|\*\*|[-+*/%^(),]/gi);
  if (!tokens || tokens.join('') !== source.replace(/Math\./g, '').replace(/\s+/g, '')) return null;
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const take = (expected?: string): string => {
    const tok = tokens[i++];
    if (tok === undefined || (expected !== undefined && tok !== expected)) throw new Error('bad path');
    return tok;
  };

  const primary = (): PathNode => {
    const tok = take();
    if (tok === '(') {
      const inner = additive();
      take(')');
      return inner;
    }
    if (tok === '-') {
      const operand = power();
      return (x) => -operand(x);
    }
    if (tok === '+') return power();
    if (/^\d|^\./.test(tok)) {
      const n = Number(tok);
      return () => n;
    }
    if (tok === 'x') return (x) => x;
    if (tok in PATH_CONSTANTS) {
      const n = PATH_CONSTANTS[tok];
      return () => n;
    }
    const fn = PATH_FUNCTIONS[tok];
    if (!fn) throw new Error('bad path');
    take('(');
    const args: PathNode[] = [];
    if (peek() !== ')') {
      args.push(additive());
      while (peek() === ',') {
        take(',');
        args.push(additive());
      }
    }
    take(')');
    return (x) => fn(...args.map((a) => a(x)));
  };

  const power = (): PathNode => {
    const base = primary();
    if (peek() === '^' || peek() === '**') {
      take();
      const exponent = power();
      return (x) => Math.pow(base(x), exponent(x));
    }
    return base;
  };

  const multiplicative = (): PathNode => {
    let left = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = take();
      const l = left;
      const r = power();
      left = op === '*' ? (x) => l(x) * r(x) : op === '/' ? (x) => l(x) / r(x) : (x) => l(x) % r(x);
    }
    return left;
  };

  const additive = (): PathNode => {
    let left = multiplicative();
    while (peek() === '+' || peek() === '-') {
      const op = take();
      const l = left;
      const r = multiplicative();
      left = op === '+' ? (x) => l(x) + r(x) : (x) => l(x) - r(x);
    }
    return left;
  };

  try {
    const compiled = additive();
    if (i !== tokens.length) return null;
    return (x) => {
      const y = compiled(x);
      return Number.isFinite(y) ? y : 0;
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Behaviours
// ─────────────────────────────────────────────────────────────────────────────

const DEG_TO_RAD = Math.PI / 180;

interface LiveParticle {
  sprite: Particle;
  group: ParticleContainer | null;
  /** The source `group` is keyed by; a texture whose source swaps (lazy load) is regrouped. */
  groupSource: TextureSource | null;
  age: number;
  maxLife: number;
  oneOverLife: number;
  vx: number;
  vy: number;
  speedMult: number;
  scaleMult: number;
  rotationSpeed: number;
  alpha: number;
  rgb: number[];
  pathX: number;
  pathY: number;
  pathRotation: number;
  pathDistance: number;
  anim: AnimSpec | null;
  animElapsed: number;
}

interface AnimSpec {
  textures: Texture[];
  framerate: number;
  loop: boolean;
}

interface Behavior {
  /** 0 spawn → 1 normal → 2 movement → 3 post-movement; stable within a tier. */
  order: number;
  init?(p: LiveParticle, indexInWave: number): void;
  update?(p: LiveParticle, lerp: number, delta: number): void;
}

function randomBetween(min: number, max: number): number {
  return min === max ? min : Math.random() * (max - min) + min;
}

function rotateInto(angle: number, x: number, y: number): [number, number] {
  if (!angle) return [x, y];
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return [x * c - y * s, x * s + y * c];
}

interface BehaviorContext {
  texture: (ref: unknown) => Texture;
  warn: (message: string) => void;
  setBlendMode: (mode: BLEND_MODES) => void;
}

function resolveAnim(raw: unknown, ctx: BehaviorContext): AnimSpec | null {
  if (!isPlainObject(raw) || !Array.isArray(raw.textures)) return null;
  const textures: Texture[] = [];
  for (const frame of raw.textures) {
    if (isPlainObject(frame)) {
      const tex = ctx.texture(frame.texture);
      const count = Math.max(1, Math.floor(finiteOr(frame.count, 1)));
      for (let i = 0; i < count; i++) textures.push(tex);
    } else {
      textures.push(ctx.texture(frame));
    }
  }
  if (textures.length === 0) return null;
  const framerate = raw.framerate === 'matchLife' ? -1 : finiteOr(raw.framerate, 60);
  return { textures, framerate, loop: raw.loop === true };
}

const BLEND_MODE_BY_NUMBER: BLEND_MODES[] = ['normal', 'add', 'multiply', 'screen'];

function toBlendMode(value: unknown): BLEND_MODES {
  if (typeof value === 'number') return BLEND_MODE_BY_NUMBER[value] ?? 'normal';
  if (typeof value !== 'string') return 'normal';
  const key = value.trim().toLowerCase().replace(/_/g, '-');
  return (key === 'add' || key === 'multiply' || key === 'screen' || key === 'normal') ? key : 'normal';
}

function createBehavior(entry: ParticleBehaviorConfig, ctx: BehaviorContext): Behavior | null {
  const c = entry.config;
  switch (entry.type) {
    case 'alpha': {
      const list = new ValueList(c.alpha, parseNumber, [1]);
      const out = [0];
      return {
        order: 1,
        init: (p) => { p.alpha = list.first[0]; },
        update: (p, lerp) => { p.alpha = list.at(lerp, out)[0]; },
      };
    }
    case 'alphaStatic': {
      const value = finiteOr(c.alpha, 1);
      return { order: 1, init: (p) => { p.alpha = value; } };
    }
    case 'scale': {
      const list = new ValueList(c.scale, parseNumber, [1]);
      const minMult = Math.max(0, finiteOr(c.minMult, 1));
      const out = [0];
      return {
        order: 1,
        init: (p) => {
          p.scaleMult = randomBetween(minMult, 1);
          const s = list.first[0] * p.scaleMult;
          p.sprite.scaleX = s;
          p.sprite.scaleY = s;
        },
        update: (p, lerp) => {
          const s = list.at(lerp, out)[0] * p.scaleMult;
          p.sprite.scaleX = s;
          p.sprite.scaleY = s;
        },
      };
    }
    case 'scaleStatic': {
      const min = finiteOr(c.min, 1);
      const max = finiteOr(c.max, min);
      return {
        order: 1,
        init: (p) => {
          const s = randomBetween(min, max);
          p.sprite.scaleX = s;
          p.sprite.scaleY = s;
        },
      };
    }
    case 'color': {
      const list = new ValueList(c.color, parseColor, [255, 255, 255]);
      const out = [0, 0, 0];
      return {
        order: 1,
        init: (p) => { copyInto(p.rgb, list.first); },
        update: (p, lerp) => { copyInto(p.rgb, list.at(lerp, out)); },
      };
    }
    case 'colorStatic': {
      const rgb = parseColor(c.color) ?? [255, 255, 255];
      return { order: 1, init: (p) => { copyInto(p.rgb, rgb); } };
    }
    case 'rotation': {
      const minStart = finiteOr(c.minStart, 0) * DEG_TO_RAD;
      const maxStart = finiteOr(c.maxStart, 0) * DEG_TO_RAD;
      const minSpeed = finiteOr(c.minSpeed, 0) * DEG_TO_RAD;
      const maxSpeed = finiteOr(c.maxSpeed, 0) * DEG_TO_RAD;
      const accel = finiteOr(c.accel, 0) * DEG_TO_RAD;
      return {
        order: 1,
        init: (p) => {
          p.sprite.rotation += randomBetween(minStart, maxStart);
          p.rotationSpeed = randomBetween(minSpeed, maxSpeed);
        },
        update: (p, _lerp, delta) => {
          if (accel) {
            const old = p.rotationSpeed;
            p.rotationSpeed += accel * delta;
            p.sprite.rotation += (p.rotationSpeed + old) / 2 * delta;
          } else {
            p.sprite.rotation += p.rotationSpeed * delta;
          }
        },
      };
    }
    case 'rotationStatic': {
      const min = finiteOr(c.min, 0) * DEG_TO_RAD;
      const max = finiteOr(c.max, 0) * DEG_TO_RAD;
      return { order: 1, init: (p) => { p.sprite.rotation += randomBetween(min, max); } };
    }
    case 'noRotation': {
      const rotation = finiteOr(c.rotation, 0) * DEG_TO_RAD;
      return { order: 3, init: (p) => { p.sprite.rotation = rotation; } };
    }
    case 'moveSpeed': {
      const list = new ValueList(c.speed, parseNumber, [0]);
      const minMult = Math.max(0, finiteOr(c.minMult, 1));
      const out = [0];
      return {
        order: 2,
        init: (p) => {
          p.speedMult = randomBetween(minMult, 1);
          [p.vx, p.vy] = rotateInto(p.sprite.rotation, list.first[0] * p.speedMult, 0);
        },
        update: (p, lerp, delta) => {
          const speed = list.at(lerp, out)[0] * p.speedMult;
          const len = Math.hypot(p.vx, p.vy);
          if (len > 0) {
            p.vx = (p.vx / len) * speed;
            p.vy = (p.vy / len) * speed;
          }
          p.sprite.x += p.vx * delta;
          p.sprite.y += p.vy * delta;
        },
      };
    }
    case 'moveSpeedStatic': {
      const min = finiteOr(c.min, 0);
      const max = finiteOr(c.max, min);
      return {
        order: 2,
        init: (p) => { [p.vx, p.vy] = rotateInto(p.sprite.rotation, randomBetween(min, max), 0); },
        update: (p, _lerp, delta) => {
          p.sprite.x += p.vx * delta;
          p.sprite.y += p.vy * delta;
        },
      };
    }
    case 'moveAcceleration': {
      const accel = isPlainObject(c.accel) ? c.accel : {};
      const ax = finiteOr(accel.x, 0);
      const ay = finiteOr(accel.y, 0);
      const minStart = finiteOr(c.minStart, 0);
      const maxStart = finiteOr(c.maxStart, minStart);
      const maxSpeed = Math.max(0, finiteOr(c.maxSpeed, 0));
      const rotate = c.rotate === true;
      return {
        order: 2,
        init: (p) => { [p.vx, p.vy] = rotateInto(p.sprite.rotation, randomBetween(minStart, maxStart), 0); },
        update: (p, _lerp, delta) => {
          const oldVx = p.vx;
          const oldVy = p.vy;
          p.vx += ax * delta;
          p.vy += ay * delta;
          if (maxSpeed) {
            const speed = Math.hypot(p.vx, p.vy);
            if (speed > maxSpeed) {
              p.vx *= maxSpeed / speed;
              p.vy *= maxSpeed / speed;
            }
          }
          p.sprite.x += (oldVx + p.vx) / 2 * delta;
          p.sprite.y += (oldVy + p.vy) / 2 * delta;
          if (rotate) p.sprite.rotation = Math.atan2(p.vy, p.vx);
        },
      };
    }
    case 'movePath': {
      const path = typeof c.path === 'string' ? compileParticlePath(c.path) : null;
      if (!path) {
        ctx.warn(`[particles] movePath expression "${String(c.path)}" could not be parsed; particles will not move.`);
        return null;
      }
      const list = new ValueList(c.speed, parseNumber, [0]);
      const minMult = Math.max(0, finiteOr(c.minMult, 1));
      const out = [0];
      return {
        order: 2,
        init: (p) => {
          p.speedMult = randomBetween(minMult, 1);
          p.pathX = p.sprite.x;
          p.pathY = p.sprite.y;
          p.pathRotation = p.sprite.rotation;
          p.pathDistance = 0;
        },
        update: (p, lerp, delta) => {
          p.pathDistance += list.at(lerp, out)[0] * p.speedMult * delta;
          const [dx, dy] = rotateInto(p.pathRotation, p.pathDistance, path(p.pathDistance));
          p.sprite.x = p.pathX + dx;
          p.sprite.y = p.pathY + dy;
        },
      };
    }
    case 'spawnPoint':
      return { order: 0 };
    case 'spawnShape': {
      const data = c.data;
      if (c.type === 'rect' && isPlainObject(data)) {
        const x = finiteOr(data.x, 0);
        const y = finiteOr(data.y, 0);
        const w = finiteOr(data.w, 0);
        const h = finiteOr(data.h, 0);
        return {
          order: 0,
          init: (p) => {
            p.sprite.x = Math.random() * w + x;
            p.sprite.y = Math.random() * h + y;
          },
        };
      }
      if (c.type === 'torus' && isPlainObject(data)) {
        const x = finiteOr(data.x, 0);
        const y = finiteOr(data.y, 0);
        const radius = Math.max(0, finiteOr(data.radius, 0));
        const inner = Math.max(0, Math.min(radius, finiteOr(data.innerRadius, 0)));
        const affectRotation = data.affectRotation === true;
        return {
          order: 0,
          init: (p) => {
            const r = inner !== radius ? Math.random() * (radius - inner) + inner : radius;
            const angle = Math.random() * Math.PI * 2;
            if (affectRotation) p.sprite.rotation += angle;
            p.sprite.x = x + Math.cos(angle) * r;
            p.sprite.y = y + Math.sin(angle) * r;
          },
        };
      }
      if (c.type === 'polygonalChain' && Array.isArray(data)) {
        const chains: Array<Array<{ x: number; y: number }>> = (Array.isArray(data[0]) ? data : [data]) as never;
        const segments: Array<{ x: number; y: number; dx: number; dy: number; len: number }> = [];
        let total = 0;
        for (const chain of chains) {
          if (!Array.isArray(chain)) continue;
          for (let i = 1; i < chain.length; i++) {
            const a = chain[i - 1];
            const b = chain[i];
            if (!isPlainObject(a) || !isPlainObject(b)) continue;
            const ax = finiteOr(a.x, 0);
            const ay = finiteOr(a.y, 0);
            const dx = finiteOr(b.x, 0) - ax;
            const dy = finiteOr(b.y, 0) - ay;
            const len = Math.hypot(dx, dy);
            segments.push({ x: ax, y: ay, dx, dy, len });
            total += len;
          }
        }
        if (segments.length === 0) return { order: 0 };
        return {
          order: 0,
          init: (p) => {
            let d = Math.random() * total;
            let seg = segments[segments.length - 1];
            for (const s of segments) {
              if (d <= s.len) { seg = s; break; }
              d -= s.len;
            }
            const k = seg.len > 0 ? d / seg.len : 0;
            p.sprite.x = seg.x + seg.dx * k;
            p.sprite.y = seg.y + seg.dy * k;
          },
        };
      }
      ctx.warn(`[particles] spawnShape type "${String(c.type)}" is not supported; spawning at the emitter origin.`);
      return { order: 0 };
    }
    case 'spawnBurst': {
      const spacing = finiteOr(c.spacing, 0);
      const start = finiteOr(c.start, 0);
      const distance = finiteOr(c.distance, 0);
      return {
        order: 0,
        init: (p, index) => {
          const angleDeg = spacing ? start + spacing * index : Math.random() * 360;
          const angle = angleDeg * DEG_TO_RAD;
          p.sprite.rotation += angle;
          if (distance) {
            p.sprite.x = Math.cos(angle) * distance;
            p.sprite.y = Math.sin(angle) * distance;
          }
        },
      };
    }
    case 'textureSingle': {
      const texture = ctx.texture(c.texture);
      return { order: 1, init: (p) => { p.sprite.texture = texture; } };
    }
    case 'textureRandom':
    case 'textureOrdered': {
      const raw = Array.isArray(c.textures) ? c.textures : [];
      const textures = raw.length > 0 ? raw.map((t) => ctx.texture(t)) : [Texture.WHITE];
      if (entry.type === 'textureRandom') {
        return { order: 1, init: (p) => { p.sprite.texture = textures[(Math.random() * textures.length) | 0]; } };
      }
      let next = 0;
      return {
        order: 1,
        init: (p) => {
          p.sprite.texture = textures[next];
          next = (next + 1) % textures.length;
        },
      };
    }
    case 'animatedSingle':
    case 'animatedRandom': {
      const anims = (entry.type === 'animatedSingle' ? [c.anim] : Array.isArray(c.anims) ? c.anims : [])
        .map((a) => resolveAnim(a, ctx))
        .filter((a): a is AnimSpec => !!a);
      if (anims.length === 0) return { order: 1, init: (p) => { p.sprite.texture = Texture.WHITE; } };
      return {
        order: 1,
        init: (p) => {
          p.anim = anims[(Math.random() * anims.length) | 0];
          p.animElapsed = 0;
          p.sprite.texture = p.anim.textures[0];
        },
        update: (p, lerp, delta) => {
          const anim = p.anim;
          if (!anim) return;
          p.animElapsed += delta;
          const count = anim.textures.length;
          let frame: number;
          if (anim.framerate < 0) {
            frame = Math.floor(lerp * count);
          } else {
            frame = Math.floor(p.animElapsed * anim.framerate);
            frame = anim.loop ? frame % count : frame;
          }
          p.sprite.texture = anim.textures[Math.max(0, Math.min(count - 1, frame))];
        },
      };
    }
    case 'blendMode':
      ctx.setBlendMode(toBlendMode(c.blendMode));
      return null;
    default:
      ctx.warn(`[particles] behavior "${entry.type}" is not supported; ignoring it.`);
      return null;
  }
}

/** Local rect covering every spawn position — the emitter's selectable area. */
function estimateSpawnBounds(config: ParticleEmitterConfig): Rectangle {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  const include = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const behavior of config.behaviors) {
    const c = behavior.config;
    const data = c.data;
    if (behavior.type === 'spawnShape' && c.type === 'rect' && isPlainObject(data)) {
      const x = finiteOr(data.x, 0);
      const y = finiteOr(data.y, 0);
      include(x, y);
      include(x + finiteOr(data.w, 0), y + finiteOr(data.h, 0));
    } else if (behavior.type === 'spawnShape' && c.type === 'torus' && isPlainObject(data)) {
      const r = Math.abs(finiteOr(data.radius, 0));
      include(finiteOr(data.x, 0) - r, finiteOr(data.y, 0) - r);
      include(finiteOr(data.x, 0) + r, finiteOr(data.y, 0) + r);
    } else if (behavior.type === 'spawnShape' && c.type === 'polygonalChain' && Array.isArray(data)) {
      const points = Array.isArray(data[0]) ? ([] as unknown[]).concat(...(data as unknown[][])) : (data as unknown[]);
      for (const pt of points) if (isPlainObject(pt)) include(finiteOr(pt.x, 0), finiteOr(pt.y, 0));
    } else if (behavior.type === 'spawnBurst') {
      const d = Math.abs(finiteOr(c.distance, 0));
      include(-d, -d);
      include(d, d);
    }
  }
  const pad = 24;
  return new Rectangle(
    config.pos.x + minX - pad,
    config.pos.y + minY - pad,
    maxX - minX + pad * 2,
    maxY - minY + pad * 2,
  );
}

/** A frame longer than this is clamped, so a backgrounded tab cannot flood the pool. */
const MAX_UPDATE_SECONDS = 0.25;

// ─────────────────────────────────────────────────────────────────────────────
// Emitter
// ─────────────────────────────────────────────────────────────────────────────

export class OrcaParticleEmitter {
  /** Holds one `ParticleContainer` per texture source; declares the emitter's bounds. */
  readonly layer: Container;
  readonly config: ParticleEmitterConfig;
  private readonly behaviors: Behavior[];
  private readonly updaters: Behavior[];
  private readonly groups = new Map<TextureSource, ParticleContainer>();
  private readonly live: LiveParticle[] = [];
  private readonly pool: LiveParticle[] = [];
  private readonly ease: EaseFn | null;
  private blendMode: BLEND_MODES = 'normal';
  private spawnTimer = 0;
  private emitterLife = -1;
  private emitting = false;
  private destroyedFlag = false;
  private spawnOffsetX = 0;
  private spawnOffsetY = 0;

  constructor(parent: Container, rawConfig: unknown, options: ParticleEmitterOptions) {
    const warn = options.warn ?? ((message: string) => console.warn(message));
    this.config = normalizeParticleConfig(rawConfig);
    this.ease = buildEase(this.config.ease);

    const textureCache = new Map<string, Texture>();
    const ctx: BehaviorContext = {
      warn,
      setBlendMode: (mode) => { this.blendMode = mode; },
      texture: (ref) => {
        const key = typeof ref === 'string' ? ref.trim() : '';
        if (!key) return Texture.WHITE;
        let texture = textureCache.get(key);
        if (!texture) {
          let resolved: Texture | null | undefined = null;
          try {
            resolved = options.resolveTexture(key);
          } catch (err) {
            warn(`[particles] texture "${key}" failed to resolve: ${(err as Error)?.message ?? err}`);
          }
          texture = resolved && !resolved.destroyed ? resolved : Texture.WHITE;
          textureCache.set(key, texture);
        }
        return texture;
      },
    };

    const built: Behavior[] = [];
    for (const entry of this.config.behaviors) {
      const behavior = createBehavior(entry, ctx);
      if (behavior) built.push(behavior);
    }
    this.behaviors = built
      .map((b, index) => ({ b, index }))
      .sort((l, r) => l.b.order - r.b.order || l.index - r.index)
      .map(({ b }) => b);
    this.updaters = this.behaviors.filter((b) => !!b.update);

    this.layer = new Container({ label: 'ParticleEmitterLayer' });
    this.layer.boundsArea = estimateSpawnBounds(this.config);
    parent.addChildAt(this.layer, 0);
  }

  get emit(): boolean {
    return this.emitting;
  }

  /** Starting emission restarts `emitterLifetime`, matching `@pixi/particle-emitter`. */
  set emit(value: boolean) {
    this.emitting = !!value && !this.destroyedFlag;
    this.emitterLife = this.config.emitterLifetime;
  }

  /**
   * Move where NEW particles spawn, in `layer`-local units on top of `config.pos`.
   * Live particles stay put, so a moving offset leaves a trail.
   */
  setSpawnOffset(x: number, y: number): void {
    if (this.destroyedFlag) return;
    const nx = Number.isFinite(x) ? x : 0;
    const ny = Number.isFinite(y) ? y : 0;
    const bounds = this.layer.boundsArea;
    // Shared by every group, so moving it in place keeps them all in step.
    if (bounds) {
      bounds.x += nx - this.spawnOffsetX;
      bounds.y += ny - this.spawnOffsetY;
    }
    this.spawnOffsetX = nx;
    this.spawnOffsetY = ny;
  }

  get particleCount(): number {
    return this.live.length;
  }

  get destroyed(): boolean {
    return this.destroyedFlag;
  }

  /** Advance every particle and spawn new waves. `deltaSeconds` is in SECONDS. */
  update(deltaSeconds: number): void {
    if (this.destroyedFlag || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const delta = Math.min(deltaSeconds, MAX_UPDATE_SECONDS);

    let removed = false;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += delta;
      if (p.age >= p.maxLife) {
        this.recycle(i);
        removed = true;
        continue;
      }
      this.step(p, delta);
    }
    if (removed) this.compactGroups();

    if (!this.emitting) return;
    const { frequency, maxParticles } = this.config;
    this.spawnTimer -= delta;
    while (this.spawnTimer <= 0) {
      if (this.emitterLife >= 0) {
        this.emitterLife -= frequency;
        if (this.emitterLife <= 0) {
          this.spawnTimer = 0;
          this.emitterLife = 0;
          this.emitting = false;
          break;
        }
      }
      if (this.live.length < maxParticles) this.spawnWave(-this.spawnTimer, false);
      this.spawnTimer += frequency;
    }
  }

  /** Spawn `count` particles immediately, ignoring `spawnChance` and the emit flag. */
  burst(count: number): void {
    if (this.destroyedFlag) return;
    let remaining = Math.max(0, Math.floor(count));
    const perWave = this.config.particlesPerWave;
    while (remaining > 0 && this.live.length < this.config.maxParticles) {
      const wave = Math.min(perWave, remaining);
      this.spawnWave(0, true, wave);
      remaining -= wave;
    }
  }

  /** Remove every live particle; emission state is untouched. */
  cleanup(): void {
    for (let i = this.live.length - 1; i >= 0; i--) this.recycle(i);
    this.compactGroups();
  }

  /** Back to a fresh emitter: no particles, spawn timer and lifetime restarted. */
  reset(): void {
    this.cleanup();
    this.spawnTimer = 0;
    this.emitterLife = this.config.emitterLifetime;
  }

  destroy(): void {
    if (this.destroyedFlag) return;
    this.destroyedFlag = true;
    this.emitting = false;
    this.live.length = 0;
    this.pool.length = 0;
    this.groups.clear();
    if (!this.layer.destroyed) {
      this.layer.parent?.removeChild(this.layer);
      this.layer.destroy({ children: true });
    }
  }

  private spawnWave(catchUp: number, force: boolean, size = this.config.particlesPerWave): void {
    const { spawnChance, lifetime, maxParticles, pos } = this.config;
    const offsetX = pos.x + this.spawnOffsetX;
    const offsetY = pos.y + this.spawnOffsetY;
    let index = 0;
    for (let n = 0; n < size && this.live.length < maxParticles; n++) {
      if (!force && spawnChance < 1 && Math.random() >= spawnChance) continue;
      const p = this.obtain();
      p.maxLife = randomBetween(lifetime.min, lifetime.max);
      p.oneOverLife = 1 / p.maxLife;
      for (const behavior of this.behaviors) behavior.init?.(p, index);
      p.sprite.x += offsetX;
      p.sprite.y += offsetY;
      p.pathX += offsetX;
      p.pathY += offsetY;
      this.live.push(p);
      this.attach(p);
      index++;
      if (catchUp > 0 && catchUp < p.maxLife) {
        p.age = catchUp;
        this.step(p, catchUp);
      } else {
        this.writeColor(p);
      }
    }
  }

  private step(p: LiveParticle, delta: number): void {
    let lerp = p.age * p.oneOverLife;
    if (this.ease) lerp = this.ease(lerp);
    for (const behavior of this.updaters) behavior.update!(p, lerp, delta);
    this.writeColor(p);
    if (p.groupSource !== p.sprite.texture.source) {
      this.detach(p);
      this.attach(p);
    }
  }

  private writeColor(p: LiveParticle): void {
    const a = p.alpha < 0 ? 0 : p.alpha > 1 ? 1 : p.alpha;
    const bgr = ((p.rgb[2] & 0xff) << 16) | ((p.rgb[1] & 0xff) << 8) | (p.rgb[0] & 0xff);
    p.sprite.color = bgr + (((a * 255) | 0) << 24);
  }

  private obtain(): LiveParticle {
    const p = this.pool.pop() ?? {
      sprite: new Particle({ texture: Texture.WHITE, anchorX: 0.5, anchorY: 0.5 }),
      group: null,
      groupSource: null,
      age: 0,
      maxLife: 1,
      oneOverLife: 1,
      vx: 0,
      vy: 0,
      speedMult: 1,
      scaleMult: 1,
      rotationSpeed: 0,
      alpha: 1,
      rgb: [255, 255, 255],
      pathX: 0,
      pathY: 0,
      pathRotation: 0,
      pathDistance: 0,
      anim: null,
      animElapsed: 0,
    };
    const s = p.sprite;
    s.x = 0;
    s.y = 0;
    s.rotation = 0;
    s.scaleX = 1;
    s.scaleY = 1;
    s.texture = Texture.WHITE;
    p.age = 0;
    p.vx = 0;
    p.vy = 0;
    p.speedMult = 1;
    p.scaleMult = 1;
    p.rotationSpeed = 0;
    p.alpha = 1;
    p.rgb[0] = 255;
    p.rgb[1] = 255;
    p.rgb[2] = 255;
    p.pathX = 0;
    p.pathY = 0;
    p.pathRotation = 0;
    p.pathDistance = 0;
    p.anim = null;
    p.animElapsed = 0;
    return p;
  }

  private recycle(index: number): void {
    const p = this.live[index];
    const last = this.live.length - 1;
    if (index !== last) this.live[index] = this.live[last];
    this.live.length = last;
    p.group = null;
    p.groupSource = null;
    this.pool.push(p);
  }

  /** Drop recycled particles from their containers in one pass per group. */
  private compactGroups(): void {
    const alive = new Set<Particle>();
    for (const p of this.live) alive.add(p.sprite);
    for (const group of this.groups.values()) {
      const children = group.particleChildren;
      let write = 0;
      for (let read = 0; read < children.length; read++) {
        if (alive.has(children[read] as Particle)) children[write++] = children[read];
      }
      if (write !== children.length) {
        children.length = write;
        group.update();
      }
      // The render pipe LATCHES its first child's texture; an emptied group must re-latch.
      if (write === 0) group.texture = null as unknown as Texture;
    }
  }

  private groupFor(source: TextureSource): ParticleContainer {
    let group = this.groups.get(source);
    if (!group) {
      group = new ParticleContainer({
        dynamicProperties: { vertex: true, position: true, rotation: true, uvs: true, color: true },
      });
      group.blendMode = this.blendMode;
      group.boundsArea = this.layer.boundsArea;
      this.groups.set(source, group);
      this.layer.addChild(group);
    }
    return group;
  }

  private attach(p: LiveParticle): void {
    const source = p.sprite.texture.source;
    const group = this.groupFor(source);
    if (group.particleChildren.length === 0) group.texture = null as unknown as Texture;
    p.group = group;
    p.groupSource = source;
    if (this.config.addAtBack) group.addParticleAt(p.sprite, 0);
    else group.addParticle(p.sprite);
  }

  private detach(p: LiveParticle): void {
    const group = p.group;
    if (group) {
      group.removeParticle(p.sprite);
      if (group.particleChildren.length === 0) group.texture = null as unknown as Texture;
    }
    p.group = null;
    p.groupSource = null;
  }
}
