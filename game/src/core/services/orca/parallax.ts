// PARITY CONTRACT: byte-identical twin of
//   templates/arcade-base-game-template/game/src/core/services/orca/parallax.ts
// `npm run check:parity` diffs the two (leading imports stripped). The editor
// canvas and the runtime must lay out and scroll a parallax background
// IDENTICALLY, so every change here lands in BOTH files in one commit.
//
// A PARALLAX BACKGROUND (`parallax` node): up to 20 layers, each ONE image
// repeated side by side across the node's width and scrolled sideways. A
// layer's DISTANCE sets its share of the node's speed — 0 moves at the full
// speed, 1 stays still — so far layers drift behind near ones. The first layer
// draws in front. The node's area is centred on its origin: a layer's offset Y
// puts its top edge below the top of the area and its offset X shifts the
// repeating pattern. Pure: no imports, no state; authored data is never written.

export const PARALLAX_MAX_LAYERS = 20;

/** How far short of its image a whole image is drawn — see {@link parallaxDrawnFrameHeight}. */
export const PARALLAX_TEXTURE_TRIM = 0.001;

export type ParallaxDirection = 'left' | 'right';

/** The fields of one authored layer (untrusted). */
export interface ParallaxLayerLike {
  texture?: unknown;
  distance?: unknown;
  offsetX?: unknown;
  offsetY?: unknown;
  scale?: unknown;
}

/** The fields of a `parallax` node its layers are built from (untrusted). */
export interface ParallaxLike {
  width?: unknown;
  height?: unknown;
  speed?: unknown;
  direction?: unknown;
  layers?: unknown;
}

export interface NormalizedParallaxLayer {
  /** Bucket-relative image path; '' when unset. */
  texture: string;
  /** 0 (nearest) … 1 (farthest). */
  distance: number;
  offsetX: number;
  offsetY: number;
  /** Always > 0. */
  scale: number;
}

export interface NormalizedParallax {
  width: number;
  height: number;
  /** Pixels per second at distance 0; never negative. */
  speed: number;
  direction: ParallaxDirection;
  /** Front first, at most {@link PARALLAX_MAX_LAYERS}. */
  layers: NormalizedParallaxLayer[];
}

/** Where one layer's strip goes, in the node's space. */
export interface ParallaxLayerPlacement {
  /** Top-left corner of the strip. */
  x: number;
  y: number;
  width: number;
  /** One image tall; 0 hides the strip. */
  height: number;
  /** The image's scale inside the strip. */
  tileScale: number;
  /** The pattern's sideways shift, wrapped into one image width. */
  tileX: number;
}

const DEFAULT_PARALLAX_WIDTH = 1920;
const DEFAULT_PARALLAX_HEIGHT = 1080;
const MIN_PARALLAX_SCALE = 0.01;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** One layer with every field defaulted and clamped. */
export function normalizeParallaxLayer(raw: unknown): NormalizedParallaxLayer {
  const layer = (raw && typeof raw === 'object' ? raw : {}) as ParallaxLayerLike;
  return {
    texture: typeof layer.texture === 'string' ? layer.texture.trim() : '',
    distance: clamp(finiteOr(layer.distance, 0), 0, 1),
    offsetX: finiteOr(layer.offsetX, 0),
    offsetY: finiteOr(layer.offsetY, 0),
    scale: Math.max(MIN_PARALLAX_SCALE, finiteOr(layer.scale, 1)),
  };
}

/** A whole node with every field defaulted and clamped; layers past the cap are dropped. */
export function normalizeParallax(raw: ParallaxLike | null | undefined): NormalizedParallax {
  const node = (raw && typeof raw === 'object' ? raw : {}) as ParallaxLike;
  const layers = Array.isArray(node.layers) ? node.layers.slice(0, PARALLAX_MAX_LAYERS) : [];
  return {
    width: Math.max(1, finiteOr(node.width, DEFAULT_PARALLAX_WIDTH)),
    height: Math.max(1, finiteOr(node.height, DEFAULT_PARALLAX_HEIGHT)),
    speed: Math.max(0, finiteOr(node.speed, 0)),
    direction: node.direction === 'right' ? 'right' : 'left',
    layers: layers.map(normalizeParallaxLayer),
  };
}

/** A layer's share of the node's speed: 1 at distance 0, 0 at distance 1. */
export function parallaxSpeedFactor(distance: number): number {
  return 1 - clamp(finiteOr(distance, 0), 0, 1);
}

/**
 * How far the scenery has travelled at full speed after another
 * `deltaSeconds`. Accumulated rather than derived from a clock, so a speed
 * change carries on from where the layers are.
 */
export function advanceParallaxTravel(travel: number, speed: number, deltaSeconds: number): number {
  const step = Math.max(0, finiteOr(speed, 0)) * Math.max(0, finiteOr(deltaSeconds, 0));
  return finiteOr(travel, 0) + step;
}

/** `value` wrapped into `[0, period)`; returned as it is when there is no period. */
export function wrapParallaxShift(value: number, period: number): number {
  const shift = finiteOr(value, 0);
  if (!(period > 0) || !Number.isFinite(period)) return shift;
  const wrapped = shift % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

/**
 * Place one layer after the scenery has travelled `travel` pixels at full
 * speed. `textureWidth` / `textureHeight` are the size of the image AS DRAWN
 * (0 while it is loading, which hides the strip).
 */
export function placeParallaxLayer(
  parallax: NormalizedParallax,
  layer: NormalizedParallaxLayer,
  textureWidth: number,
  textureHeight: number,
  travel: number,
): ParallaxLayerPlacement {
  const loaded = textureWidth > 0 && textureHeight > 0;
  const moved = finiteOr(travel, 0) * parallaxSpeedFactor(layer.distance);
  const shift = layer.offsetX + (parallax.direction === 'right' ? moved : -moved);
  return {
    x: -parallax.width / 2,
    y: -parallax.height / 2 + layer.offsetY,
    width: parallax.width,
    height: loaded ? textureHeight * layer.scale : 0,
    tileScale: layer.scale,
    tileX: wrapParallaxShift(shift, loaded ? textureWidth * layer.scale : 0),
  };
}

/**
 * The frame height to draw a layer's image with, or `null` to draw it as it is.
 *
 * Pixi tiles a WHOLE image with the GPU's repeat wrap, which blends the image's
 * bottom row into the top edge of a strip that is one image tall — a faint line
 * above every layer whenever the strip is scaled or sits between pixels. Drawn
 * {@link PARALLAX_TEXTURE_TRIM} px short, the image counts as a frame of itself
 * and Pixi tiles it through its clamped path, which never samples across the
 * wrap. A frame of a larger image (or a rotated one) is clamped already.
 */
export function parallaxDrawnFrameHeight(
  frameWidth: number,
  frameHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  rotated: boolean,
): number | null {
  if (rotated || !(frameWidth > 0) || !(frameHeight > PARALLAX_TEXTURE_TRIM)) return null;
  if (frameWidth !== sourceWidth || frameHeight !== sourceHeight) return null;
  return frameHeight - PARALLAX_TEXTURE_TRIM;
}
