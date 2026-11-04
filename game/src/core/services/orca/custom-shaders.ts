// PARITY CONTRACT: this file must be byte-identical content (modulo imports)
// to its twin — editor `src/services/customShaders.ts` and runtime
// `templates/arcade-base-game-template/game/src/core/services/orca/custom-shaders.ts`
// (the bingo template ships the runtime copy byte for byte — a bingo shared
// runtime file). `npm run check:parity` diffs the editor and arcade copies
// (leading imports stripped); `npm run check:custom-shader-runtime` runs the
// same cases against both. The editor canvas and the game must build the SAME
// GLSL for a Custom Shader, so every change here lands in ALL copies at once.
//
// CUSTOM SHADERS (runtime half): user-authored fragment shaders from
// `orca-project-files/shaders/<Name>.glsl`, emitted by the main process into
// `generated-custom-shaders.ts` as plain data. This module turns one
// definition + one node's authored uniform values into a live Pixi 8 Filter
// (target '2d') or a three.js ShaderMaterial (target '3d').
//
// NO IMPORTS: the Pixi / THREE namespaces are passed in (the game compiles
// with TypeScript 4.9, which cannot type three). The only module state is a
// compile-test cache and a warn-once set. Authored data is never written.

/* ------------------------------------------------------------------ types */

export type OrcaCustomShaderUniformType = 'float' | 'int' | 'bool' | 'vec2' | 'vec3' | 'vec4' | 'color';

/** Structurally identical to the generated module's `OrcaCustomShaderUniform`. */
export interface OrcaCustomShaderUniform {
    name: string;
    type: OrcaCustomShaderUniformType;
    default: number | boolean | string | number[];
    min?: number;
    max?: number;
    step?: number;
    label?: string;
}

/** Structurally identical to the generated module's `OrcaCustomShaderDefinition`. */
export interface OrcaCustomShaderDefinition {
    name: string;
    title: string;
    description: string;
    target: '2d' | '3d';
    uniforms: OrcaCustomShaderUniform[];
    /** GLSL fragment body (after the header). The prelude is prepended here. */
    fragment: string;
}

/** One authored uniform value (untrusted). Colours are `#rrggbb[aa]`. */
export type OrcaCustomShaderInstanceValue = number | boolean | number[] | string;
export type OrcaCustomShaderInstanceValues = Record<string, OrcaCustomShaderInstanceValue>;

/**
 * A RESOLVED uniform value: float / int ⇒ number, bool ⇒ boolean, vecN ⇒
 * number[N], color ⇒ [r, g, b, a] in 0..1.
 */
export type OrcaCustomShaderResolvedValue = number | boolean | number[];
export type OrcaCustomShaderResolvedValues = Record<string, OrcaCustomShaderResolvedValue>;

/** One entry of a 2D node's `customShaders` stack (applied AFTER the authored `filters`). */
export interface OrcaCustomShaderInstance {
    id: string;
    /** `OrcaCustomShaderDefinition.name`. */
    shader: string;
    /** Absent ⇒ enabled. */
    enabled?: boolean;
    uniforms?: OrcaCustomShaderInstanceValues;
}

/** A 3D node's (`primitive3d` / `model3d`) single `customShader` slot. */
export interface OrcaCustomShaderSlot {
    shader: string;
    /** Absent ⇒ enabled. */
    enabled?: boolean;
    uniforms?: OrcaCustomShaderInstanceValues;
}

export interface CustomShaderCompileResult {
    ok: boolean;
    /** Compiler / linker info log ('' when ok). */
    log: string;
}

/** Full, standalone GLSL ES 3.00 sources — what the renderer will compile. */
export interface CustomShaderProgramSources {
    vertex: string;
    fragment: string;
}

type CustomShaderGl = WebGLRenderingContext | WebGL2RenderingContext;

export interface CustomShaderRuntimeOptions {
    /**
     * The live renderer. 2D: the Pixi renderer — a WebGPU renderer is refused
     * (one warning) and a WebGL one lends its context to the compile test.
     * 3D: a three `WebGLRenderer`, whose context is used for the test.
     */
    renderer?: unknown;
    /** Context for the compile test. Default: the renderer's, else a shared offscreen WebGL2 context. */
    gl?: CustomShaderGl | null;
    /** 3D only: 'double' renders both faces (planes). Default 'front'. */
    side?: 'front' | 'double';
}

/** A live custom shader on a 2D node. */
export interface CustomShaderFilterHandle {
    /** The Pixi 8 `Filter`. Append it to `displayObject.filters`. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly filter: any;
    readonly definition: OrcaCustomShaderDefinition;
    /** The current resolved values (a copy). */
    getValues(): OrcaCustomShaderResolvedValues;
    /** Replace every value: missing / invalid ⇒ the uniform's default. */
    setValues(values: unknown): void;
    /** Set one uniform by its AUTHORED name; false for an unknown name. */
    setUniform(name: string, value: unknown): boolean;
    /** Advance `uTime` by `deltaSeconds`. */
    tick(deltaSeconds: number): void;
    /** Seconds accumulated by `tick`. */
    getTime(): number;
    destroy(): void;
}

/** A live custom shader on a 3D node. */
export interface CustomShaderMaterialHandle {
    /** The three `ShaderMaterial` (GLSL3). Assign it to the mesh(es). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly material: any;
    readonly definition: OrcaCustomShaderDefinition;
    getValues(): OrcaCustomShaderResolvedValues;
    setValues(values: unknown): void;
    setUniform(name: string, value: unknown): boolean;
    /** `#rrggbb` or [r, g, b] in 0..1; invalid ⇒ white. */
    setBaseColor(color: unknown): void;
    tick(deltaSeconds: number): void;
    getTime(): number;
    destroy(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CustomShaderNamespace = any;

/* -------------------------------------------------------------- constants */

export const CUSTOM_SHADER_UNIFORM_TYPES: readonly OrcaCustomShaderUniformType[] = ['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'color'];

/**
 * A `bool` uniform is DECLARED as `uniform int orca_bool_<name>;` plus
 * `#define <name> (orca_bool_<name> != 0)`, so GLSL still reads it as a bool
 * (`if (uOn)`) while every backend uploads a plain int (0 / 1): Pixi's
 * UniformGroup has no bool type and three would upload an int anyway. The
 * `orca` prefix is reserved by the parser, so this cannot collide.
 */
export const CUSTOM_SHADER_BOOL_PREFIX = 'orca_bool_';

/** Pixi 8 `defaultFilterVert` (8.14), used when the namespace does not export it. */
export const CUSTOM_SHADER_DEFAULT_FILTER_VERTEX = [
    'in vec2 aPosition;',
    'out vec2 vTextureCoord;',
    '',
    'uniform vec4 uInputSize;',
    'uniform vec4 uOutputFrame;',
    'uniform vec4 uOutputTexture;',
    '',
    'vec4 filterVertexPosition( void )',
    '{',
    '    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;',
    '    ',
    '    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;',
    '    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;',
    '',
    '    return vec4(position, 0.0, 1.0);',
    '}',
    '',
    'vec2 filterTextureCoord( void )',
    '{',
    '    return aPosition * (uOutputFrame.zw * uInputSize.zw);',
    '}',
    '',
    'void main(void)',
    '{',
    '    gl_Position = filterVertexPosition();',
    '    vTextureCoord = filterTextureCoord();',
    '}',
    '',
].join('\n');

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const VEC_SIZE: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4 };
const GLSL_TYPE: Record<string, string> = { float: 'float', int: 'int', bool: 'int', vec2: 'vec2', vec3: 'vec3', vec4: 'vec4', color: 'vec4' };
const PIXI_UNIFORM_TYPE: Record<string, string> = {
    float: 'f32', int: 'i32', bool: 'i32', vec2: 'vec2<f32>', vec3: 'vec3<f32>', vec4: 'vec4<f32>', color: 'vec4<f32>',
};
/** Pixi 8 `RendererType.WEBGL`. */
const PIXI_RENDERER_TYPE_WEBGL = 1;
const COMPILE_CACHE_LIMIT = 256;

/* ---------------------------------------------------------------- helpers */

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && isFinite(value);
}

function hasOwn(target: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(target, key);
}

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampToRange(value: number, uniform: OrcaCustomShaderUniform): number {
    let out = value;
    if (isFiniteNumber(uniform.min) && out < uniform.min) out = uniform.min;
    if (isFiniteNumber(uniform.max) && out > uniform.max) out = uniform.max;
    return out;
}

function zeroValueFor(type: string): OrcaCustomShaderResolvedValue {
    switch (type) {
        case 'bool': return false;
        case 'vec2': return [0, 0];
        case 'vec3': return [0, 0, 0];
        case 'vec4': return [0, 0, 0, 0];
        case 'color': return [1, 1, 1, 1];
        default: return 0;
    }
}

/** 32-bit FNV-1a of a string, as 8 hex digits. */
export function hashCustomShaderSource(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return ('0000000' + hash.toString(16)).slice(-8);
}

const warnedKeys: { [key: string]: true } = Object.create(null);

/** `console.warn` once per `key` for the lifetime of the page. */
export function warnCustomShaderOnce(key: string, message: string, detail?: unknown): void {
    if (warnedKeys[key]) return;
    warnedKeys[key] = true;
    if (detail === undefined) console.warn(message);
    else console.warn(message, detail);
}

/** Forget every warn-once key (editor: after the shader set changes). */
export function resetCustomShaderWarnings(): void {
    for (const key of Object.keys(warnedKeys)) delete warnedKeys[key];
}

/* ------------------------------------------------------- authored values */

/**
 * `#rrggbb` / `#rrggbbaa` ⇒ [r, g, b, a] in 0..1. Also accepts a 3- or
 * 4-number array (clamped to 0..1; alpha defaults to 1). Anything else ⇒ null.
 */
export function parseCustomShaderColor(raw: unknown): number[] | null {
    if (typeof raw === 'string') {
        const text = raw.trim();
        if (!HEX_COLOR_RE.test(text)) return null;
        const channel = (i: number): number => parseInt(text.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return [channel(0), channel(1), channel(2), text.length === 9 ? channel(3) : 1];
    }
    if (Array.isArray(raw) && (raw.length === 3 || raw.length === 4) && raw.every(isFiniteNumber)) {
        return [clamp01(raw[0]), clamp01(raw[1]), clamp01(raw[2]), raw.length === 4 ? clamp01(raw[3]) : 1];
    }
    return null;
}

function coerceStrict(uniform: OrcaCustomShaderUniform, raw: unknown): OrcaCustomShaderResolvedValue | null {
    switch (uniform.type) {
        case 'float':
            return isFiniteNumber(raw) ? clampToRange(raw, uniform) : null;
        case 'int': {
            if (!isFiniteNumber(raw)) return null;
            let value = Math.round(raw);
            if (isFiniteNumber(uniform.min) && value < uniform.min) value = Math.ceil(uniform.min);
            if (isFiniteNumber(uniform.max) && value > uniform.max) value = Math.floor(uniform.max);
            return value;
        }
        case 'bool':
            if (typeof raw === 'boolean') return raw;
            return isFiniteNumber(raw) ? raw !== 0 : null;
        case 'vec2':
        case 'vec3':
        case 'vec4': {
            const size = VEC_SIZE[uniform.type];
            if (!Array.isArray(raw) || raw.length !== size || !raw.every(isFiniteNumber)) return null;
            return raw.map((component: number) => clampToRange(component, uniform));
        }
        case 'color':
            return parseCustomShaderColor(raw);
        default:
            return null;
    }
}

/**
 * Resolve ONE authored value against its uniform declaration. Missing /
 * invalid ⇒ the declared default (itself re-checked) ⇒ the type's zero value
 * (colour: opaque white). float / int / vecN clamp to `min` / `max`; int
 * rounds; colour parses `#rrggbb[aa]` to [r, g, b, a] in 0..1.
 */
export function coerceUniformValue(uniform: OrcaCustomShaderUniform, raw: unknown): OrcaCustomShaderResolvedValue {
    const value = coerceStrict(uniform, raw);
    if (value !== null) return value;
    const fallback = coerceStrict(uniform, uniform.default);
    if (fallback !== null) return fallback;
    return zeroValueFor(uniform.type);
}

/**
 * The definition's usable uniforms: plain objects with an identifier name and
 * a known type, first occurrence of a name wins. Order is preserved.
 */
export function customShaderUniforms(def: OrcaCustomShaderDefinition): OrcaCustomShaderUniform[] {
    const out: OrcaCustomShaderUniform[] = [];
    const seen: { [name: string]: true } = Object.create(null);
    const list: unknown = def && def.uniforms;
    if (!Array.isArray(list)) return out;
    for (const entry of list) {
        if (!isPlainObject(entry)) continue;
        const name = entry.name;
        const type = entry.type;
        if (typeof name !== 'string' || !IDENTIFIER_RE.test(name) || seen[name]) continue;
        if (typeof type !== 'string' || CUSTOM_SHADER_UNIFORM_TYPES.indexOf(type as OrcaCustomShaderUniformType) < 0) continue;
        seen[name] = true;
        out.push(entry as unknown as OrcaCustomShaderUniform);
    }
    return out;
}

/**
 * Every declared uniform's resolved value. Keys of `values` that the shader
 * does not declare are IGNORED (never deleted from the authored data).
 */
export function resolveUniformValues(def: OrcaCustomShaderDefinition, values: unknown): OrcaCustomShaderResolvedValues {
    const source = isPlainObject(values) ? values : {};
    const out: OrcaCustomShaderResolvedValues = {};
    for (const uniform of customShaderUniforms(def)) {
        out[uniform.name] = coerceUniformValue(uniform, hasOwn(source, uniform.name) ? source[uniform.name] : undefined);
    }
    return out;
}

/** The name the GPU program uses for `uniform` (see `CUSTOM_SHADER_BOOL_PREFIX`). */
export function customShaderGpuUniformName(uniform: OrcaCustomShaderUniform): string {
    return uniform.type === 'bool' ? CUSTOM_SHADER_BOOL_PREFIX + uniform.name : uniform.name;
}

/** A resolved value as uploaded: bool ⇒ 0 / 1, vectors copied. */
export function customShaderGpuValue(uniform: OrcaCustomShaderUniform, value: OrcaCustomShaderResolvedValue): number | number[] {
    if (uniform.type === 'bool') return value === true ? 1 : 0;
    if (Array.isArray(value)) return value.slice();
    return typeof value === 'number' ? value : 0;
}

/** Normalise a 2D node's `customShaders` stack. Entries without a shader name are dropped. */
export function normalizeCustomShaderInstances(raw: unknown): OrcaCustomShaderInstance[] {
    if (!Array.isArray(raw)) return [];
    const out: OrcaCustomShaderInstance[] = [];
    raw.forEach((entry: unknown, index: number) => {
        if (!isPlainObject(entry)) return;
        const shader = typeof entry.shader === 'string' ? entry.shader.trim() : '';
        if (!shader) return;
        const instance: OrcaCustomShaderInstance = {
            id: typeof entry.id === 'string' && entry.id ? entry.id : `customShader-${index}`,
            shader,
        };
        if (typeof entry.enabled === 'boolean') instance.enabled = entry.enabled;
        if (isPlainObject(entry.uniforms)) instance.uniforms = entry.uniforms as OrcaCustomShaderInstanceValues;
        out.push(instance);
    });
    return out;
}

/** Normalise a 3D node's `customShader` slot; null when absent / unusable. */
export function normalizeCustomShaderSlot(raw: unknown): OrcaCustomShaderSlot | null {
    if (!isPlainObject(raw)) return null;
    const shader = typeof raw.shader === 'string' ? raw.shader.trim() : '';
    if (!shader) return null;
    const slot: OrcaCustomShaderSlot = { shader };
    if (typeof raw.enabled === 'boolean') slot.enabled = raw.enabled;
    if (isPlainObject(raw.uniforms)) slot.uniforms = raw.uniforms as OrcaCustomShaderInstanceValues;
    return slot;
}

/** Absent `enabled` counts as enabled. */
export function isCustomShaderEnabled(entry: { enabled?: unknown } | null | undefined): boolean {
    return !!entry && entry.enabled !== false;
}

/**
 * Look a shader up by name for a `target`. Unknown name, a malformed entry or
 * the wrong target ⇒ null with ONE warning per (name, problem).
 */
export function resolveCustomShaderDefinition(
    definitions: Record<string, OrcaCustomShaderDefinition> | null | undefined,
    name: string,
    target: '2d' | '3d',
): OrcaCustomShaderDefinition | null {
    const def = definitions && typeof name === 'string' && hasOwn(definitions, name) ? definitions[name] : undefined;
    if (!def) {
        warnCustomShaderOnce(`unknown:${name}`, `[CustomShaders] Unknown custom shader "${name}"; it is skipped.`);
        return null;
    }
    if (!isPlainObject(def) || typeof def.fragment !== 'string' || !def.fragment.trim()) {
        warnCustomShaderOnce(`invalid:${name}`, `[CustomShaders] Custom shader "${name}" is malformed; it is skipped.`);
        return null;
    }
    const defTarget = def.target === '3d' ? '3d' : '2d';
    if (defTarget !== target) {
        warnCustomShaderOnce(
            `target:${name}:${target}`,
            `[CustomShaders] Custom shader "${name}" targets ${defTarget} and cannot run on a ${target} node; it is skipped.`,
        );
        return null;
    }
    return def;
}

/* --------------------------------------------------------- GLSL sources */

function uniformDeclarations(def: OrcaCustomShaderDefinition): string[] {
    const lines: string[] = [];
    for (const uniform of customShaderUniforms(def)) {
        lines.push(`uniform ${GLSL_TYPE[uniform.type]} ${customShaderGpuUniformName(uniform)};`);
        if (uniform.type === 'bool') lines.push(`#define ${uniform.name} (${CUSTOM_SHADER_BOOL_PREFIX}${uniform.name} != 0)`);
    }
    return lines;
}

function fragmentBody(def: OrcaCustomShaderDefinition): string {
    const body = typeof def.fragment === 'string' ? def.fragment : '';
    return body.endsWith('\n') ? body : `${body}\n`;
}

/**
 * The 2D fragment for a Pixi 8 `GlProgram`. It starts with `#version 300 es`
 * ON PURPOSE: that marker is how Pixi 8 picks its ES 3.00 path (it strips the
 * line, adds `precision`, `#define SHADER_NAME` and re-inserts the version;
 * without it Pixi compiles GLSL ES 1.00 with `in` / `finalColor` macros).
 * No `precision` here — Pixi adds it. `#line 1` makes compiler line numbers
 * count from the first line of the user's BODY.
 */
export function buildFragmentSource2D(def: OrcaCustomShaderDefinition): string {
    return [
        '#version 300 es',
        'in vec2 vTextureCoord;',
        'out vec4 finalColor;',
        'uniform sampler2D uTexture;',
        'uniform float uTime;',
        'uniform vec4 uInputSize;',
        'uniform vec4 uOutputFrame;',
        ...uniformDeclarations(def),
        '#line 1',
    ].join('\n') + '\n' + fragmentBody(def);
}

/**
 * The 3D fragment for a three `ShaderMaterial` with `glslVersion: GLSL3`.
 * three prepends `#version 300 es` + precision itself and, in GLSL3 mode,
 * declares NO colour output, so `finalColor` is declared here as the
 * location-0 output. Colours are written as-is (no colour-space conversion),
 * matching 2D: `#ff8800` in a uniform comes out as `#ff8800`.
 */
export function buildFragmentSource3D(def: OrcaCustomShaderDefinition): string {
    return [
        'in vec2 vUv;',
        'in vec3 vNormal;',
        'in vec3 vWorldPosition;',
        'uniform float uTime;',
        'uniform vec3 uBaseColor;',
        ...uniformDeclarations(def),
        'layout(location = 0) out highp vec4 finalColor;',
        '#line 1',
    ].join('\n') + '\n' + fragmentBody(def);
}

/**
 * The 3D vertex shader. `vNormal` / `vWorldPosition` are WORLD space; `vUv`
 * is the mesh's first UV set. For three (`forThree`) it pulls in three's
 * skinning chunks, so a skinned glTF still animates (morph targets are not
 * applied); the standalone form is the same program without them, for the
 * compile test.
 */
export function buildVertexSource3D(forThree = true): string {
    const head = forThree
        ? ['#include <skinning_pars_vertex>', 'void main() {', '#include <beginnormal_vertex>', '#include <skinbase_vertex>',
            '#include <skinnormal_vertex>', '#include <begin_vertex>', '#include <skinning_vertex>']
        : ['void main() {', '    vec3 objectNormal = vec3(normal);', '    vec3 transformed = vec3(position);'];
    return [
        'out vec2 vUv;',
        'out vec3 vNormal;',
        'out vec3 vWorldPosition;',
        ...head,
        '    vUv = uv;',
        '    vNormal = normalize(mat3(modelMatrix) * objectNormal);',
        '    vec4 orcaWorldPosition = modelMatrix * vec4(transformed, 1.0);',
        '    vWorldPosition = orcaWorldPosition.xyz;',
        '    gl_Position = projectionMatrix * viewMatrix * orcaWorldPosition;',
        '}',
        '',
    ].join('\n');
}

/** What Pixi 8 compiles for a 2D custom shader (WebGL2), as standalone sources. */
export function customShaderProgramSources2D(def: OrcaCustomShaderDefinition): CustomShaderProgramSources {
    const head = '#version 300 es\nprecision highp float;\n';
    return {
        vertex: head + CUSTOM_SHADER_DEFAULT_FILTER_VERTEX,
        fragment: head + buildFragmentSource2D(def).replace(/^#version 300 es\n/, ''),
    };
}

/** What three compiles for a 3D custom shader (without skinning), as standalone sources. */
export function customShaderProgramSources3D(def: OrcaCustomShaderDefinition): CustomShaderProgramSources {
    const head = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
    return {
        vertex: head + [
            'uniform mat4 modelMatrix;', 'uniform mat4 modelViewMatrix;', 'uniform mat4 projectionMatrix;',
            'uniform mat4 viewMatrix;', 'uniform mat3 normalMatrix;', 'uniform vec3 cameraPosition;',
            'in vec3 position;', 'in vec3 normal;', 'in vec2 uv;', '',
        ].join('\n') + buildVertexSource3D(false),
        fragment: head + ['uniform mat4 viewMatrix;', 'uniform vec3 cameraPosition;', 'uniform bool isOrthographic;', ''].join('\n')
            + buildFragmentSource3D(def),
    };
}

/* ------------------------------------------------------------ compile test */

const compileCache: { [key: string]: CustomShaderCompileResult } = Object.create(null);
let compileCacheKeys: string[] = [];
let sharedTestContext: CustomShaderGl | null | undefined;

/** Forget every cached compile result. */
export function clearCustomShaderCompileCache(): void {
    for (const key of compileCacheKeys) delete compileCache[key];
    compileCacheKeys = [];
}

/** A lazily created offscreen WebGL2 context for compile tests; null without a DOM / WebGL2. */
export function getCustomShaderTestContext(): CustomShaderGl | null {
    if (sharedTestContext !== undefined) return sharedTestContext;
    sharedTestContext = null;
    try {
        if (typeof document !== 'undefined') {
            const context = document.createElement('canvas').getContext('webgl2');
            sharedTestContext = context || null;
        }
    } catch {
        sharedTestContext = null;
    }
    return sharedTestContext;
}

/**
 * Compile + link `vertexSrc` / `fragmentSrc` on `gl` (WebGL2 for ES 3.00).
 * Results are cached by `cacheKey` (e.g. the shader name) + a hash of both
 * sources, so a broken shader costs one compile per page. No context ⇒
 * `{ ok: true }` (untested, not cached); a lost context is not cached either.
 */
export function testCompileFragment(
    gl: CustomShaderGl | null | undefined,
    vertexSrc: string,
    fragmentSrc: string,
    cacheKey = '',
): CustomShaderCompileResult {
    if (!gl) return { ok: true, log: 'no WebGL context; compile test skipped' };
    const context: CustomShaderGl = gl;
    const key = `${cacheKey}#${hashCustomShaderSource(vertexSrc)}:${hashCustomShaderSource(fragmentSrc)}:${vertexSrc.length}:${fragmentSrc.length}`;
    if (hasOwn(compileCache, key)) return compileCache[key];
    let result: CustomShaderCompileResult;
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    try {
        if (typeof context.isContextLost === 'function' && context.isContextLost()) {
            return { ok: true, log: 'WebGL context lost; compile test skipped' };
        }
        const compile = (type: number, source: string, label: string): string | null => {
            const shader = context.createShader(type);
            if (!shader) return `${label}: could not create a shader`;
            shaders.push(shader);
            context.shaderSource(shader, source);
            context.compileShader(shader);
            if (context.getShaderParameter(shader, context.COMPILE_STATUS)) return null;
            return `${label}: ${context.getShaderInfoLog(shader) || 'compile failed'}`;
        };
        const error = compile(context.VERTEX_SHADER, vertexSrc, 'vertex') || compile(context.FRAGMENT_SHADER, fragmentSrc, 'fragment');
        if (error) {
            result = { ok: false, log: error.trim() };
        } else {
            program = context.createProgram();
            if (!program) {
                result = { ok: false, log: 'could not create a program' };
            } else {
                for (const shader of shaders) context.attachShader(program, shader);
                context.linkProgram(program);
                result = context.getProgramParameter(program, context.LINK_STATUS)
                    ? { ok: true, log: '' }
                    : { ok: false, log: `link: ${context.getProgramInfoLog(program) || 'link failed'}`.trim() };
            }
        }
    } catch (err) {
        result = { ok: false, log: `compile test threw: ${err && (err as Error).message ? (err as Error).message : String(err)}` };
    } finally {
        try {
            if (program) context.deleteProgram(program);
            for (const shader of shaders) context.deleteShader(shader);
        } catch {
            // Best effort.
        }
    }
    if (compileCacheKeys.length >= COMPILE_CACHE_LIMIT) clearCustomShaderCompileCache();
    compileCache[key] = result;
    compileCacheKeys.push(key);
    return result;
}

/** Compile-test a 2D definition (see `customShaderProgramSources2D`). */
export function testCompileCustomShader2D(gl: CustomShaderGl | null | undefined, def: OrcaCustomShaderDefinition): CustomShaderCompileResult {
    const sources = customShaderProgramSources2D(def);
    return testCompileFragment(gl, sources.vertex, sources.fragment, `2d:${def.name}`);
}

/** Compile-test a 3D definition (see `customShaderProgramSources3D`). */
export function testCompileCustomShader3D(gl: CustomShaderGl | null | undefined, def: OrcaCustomShaderDefinition): CustomShaderCompileResult {
    const sources = customShaderProgramSources3D(def);
    return testCompileFragment(gl, sources.vertex, sources.fragment, `3d:${def.name}`);
}

/* --------------------------------------------------------------- 2D: Pixi */

/**
 * False only for a renderer KNOWN not to be WebGL (Pixi 8 WebGPU). No
 * renderer ⇒ true (assume WebGL).
 */
export function isWebGLCustomShaderRenderer(renderer: unknown): boolean {
    if (!renderer || typeof renderer !== 'object') return true;
    const r = renderer as { type?: unknown; name?: unknown; gl?: unknown };
    if (r.gl) return true;
    if (r.type === PIXI_RENDERER_TYPE_WEBGL || r.name === 'webgl') return true;
    return r.type === undefined && r.name === undefined;
}

function rendererContext(renderer: unknown): CustomShaderGl | null {
    if (!renderer || typeof renderer !== 'object') return null;
    const r = renderer as { gl?: unknown; getContext?: unknown };
    if (r.gl && typeof r.gl === 'object') return r.gl as CustomShaderGl;
    if (typeof r.getContext === 'function') {
        try {
            const context = (r.getContext as () => unknown).call(renderer);
            if (context && typeof context === 'object') return context as CustomShaderGl;
        } catch {
            return null;
        }
    }
    return null;
}

function testContextFor(options: CustomShaderRuntimeOptions | undefined): CustomShaderGl | null {
    if (options && options.gl) return options.gl;
    return rendererContext(options && options.renderer) || getCustomShaderTestContext();
}

/**
 * A Pixi 8 `Filter` running `def` (target '2d') with `values`. Uniforms live
 * in ONE `UniformGroup` resource (`orcaCustomShader`): float ⇒ 'f32', int /
 * bool ⇒ 'i32', vecN ⇒ 'vecN<f32>', color ⇒ 'vec4<f32>' ([r, g, b, a] 0..1),
 * plus `uTime` ('f32', seconds). The vertex stage is Pixi's default filter
 * vertex. WebGL only: a WebGPU renderer, a wrong target or a shader that
 * fails the compile test ⇒ null with ONE warning.
 */
export function createCustomShaderFilter(
    PIXI: CustomShaderNamespace,
    def: OrcaCustomShaderDefinition,
    values?: unknown,
    options?: CustomShaderRuntimeOptions,
): CustomShaderFilterHandle | null {
    if (!def || typeof def.fragment !== 'string') return null;
    const name = String(def.name);
    if (def.target === '3d') {
        warnCustomShaderOnce(`target:${name}:2d`, `[CustomShaders] Custom shader "${name}" targets 3d and cannot run on a 2d node; it is skipped.`);
        return null;
    }
    if (!isWebGLCustomShaderRenderer(options && options.renderer)) {
        warnCustomShaderOnce('webgpu', '[CustomShaders] Custom shaders need the WebGL renderer; they are skipped on WebGPU.');
        return null;
    }
    if (!PIXI || typeof PIXI.Filter !== 'function' || typeof PIXI.UniformGroup !== 'function') {
        warnCustomShaderOnce('pixi', '[CustomShaders] The Pixi namespace has no Filter / UniformGroup; custom shaders are skipped.');
        return null;
    }
    const compiled = testCompileCustomShader2D(testContextFor(options), def);
    if (!compiled.ok) {
        warnCustomShaderOnce(`compile:2d:${name}:${hashCustomShaderSource(def.fragment)}`, `[CustomShaders] Custom shader "${name}" failed to compile; it is skipped.\n${compiled.log}`);
        return null;
    }

    const uniforms = customShaderUniforms(def);
    let resolved = resolveUniformValues(def, values);
    const groupSpec: Record<string, { value: number | number[]; type: string }> = { uTime: { value: 0, type: 'f32' } };
    for (const uniform of uniforms) {
        groupSpec[customShaderGpuUniformName(uniform)] = {
            value: customShaderGpuValue(uniform, resolved[uniform.name]),
            type: PIXI_UNIFORM_TYPE[uniform.type],
        };
    }
    let filter: CustomShaderNamespace;
    let group: CustomShaderNamespace;
    try {
        group = new PIXI.UniformGroup(groupSpec);
        const vertex = typeof PIXI.defaultFilterVert === 'string' ? PIXI.defaultFilterVert : CUSTOM_SHADER_DEFAULT_FILTER_VERTEX;
        const gl = { vertex, fragment: buildFragmentSource2D(def), name: `orca-custom-shader-${name}` };
        const resources = { orcaCustomShader: group };
        filter = typeof PIXI.Filter.from === 'function'
            ? PIXI.Filter.from({ gl, resources })
            : new PIXI.Filter({ glProgram: PIXI.GlProgram.from(gl), resources });
    } catch (err) {
        warnCustomShaderOnce(`create:2d:${name}`, `[CustomShaders] Custom shader "${name}" could not be created; it is skipped.`, err);
        return null;
    }

    let time = 0;
    let destroyed = false;
    const write = (uniform: OrcaCustomShaderUniform): void => {
        group.uniforms[customShaderGpuUniformName(uniform)] = customShaderGpuValue(uniform, resolved[uniform.name]);
    };
    return {
        filter,
        definition: def,
        getValues: () => resolveUniformValues(def, resolved),
        setValues(next: unknown): void {
            if (destroyed) return;
            resolved = resolveUniformValues(def, next);
            for (const uniform of uniforms) write(uniform);
        },
        setUniform(uniformName: string, value: unknown): boolean {
            if (destroyed) return false;
            for (const uniform of uniforms) {
                if (uniform.name !== uniformName) continue;
                resolved[uniform.name] = coerceUniformValue(uniform, value);
                write(uniform);
                return true;
            }
            return false;
        },
        tick(deltaSeconds: number): void {
            if (destroyed || !isFiniteNumber(deltaSeconds) || deltaSeconds <= 0) return;
            time += deltaSeconds;
            group.uniforms.uTime = time;
        },
        getTime: () => time,
        destroy(): void {
            if (destroyed) return;
            destroyed = true;
            try {
                filter.destroy();
            } catch {
                // Best effort.
            }
        },
    };
}

/* -------------------------------------------------------------- 3D: three */

function baseColorVector(color: unknown): number[] {
    const parsed = parseCustomShaderColor(color);
    return parsed ? parsed.slice(0, 3) : [1, 1, 1];
}

/**
 * A three `ShaderMaterial` (GLSL3, `transparent: true`) running `def`
 * (target '3d') with `values`. Varyings: `vUv`, `vNormal` (world),
 * `vWorldPosition`; uniforms `uTime` (seconds), `uBaseColor` (vec3 from
 * `baseColor`, `#rrggbb` or [r, g, b]; invalid ⇒ white) and the declared
 * ones — uploaded as plain numbers / arrays, so nothing is colour-managed.
 * Wrong target or a failed compile test ⇒ null with ONE warning.
 */
export function createCustomShaderMaterial(
    THREE: CustomShaderNamespace,
    def: OrcaCustomShaderDefinition,
    values?: unknown,
    baseColor?: unknown,
    options?: CustomShaderRuntimeOptions,
): CustomShaderMaterialHandle | null {
    if (!def || typeof def.fragment !== 'string') return null;
    const name = String(def.name);
    if (def.target !== '3d') {
        warnCustomShaderOnce(`target:${name}:3d`, `[CustomShaders] Custom shader "${name}" targets 2d and cannot run on a 3d node; it is skipped.`);
        return null;
    }
    if (!THREE || typeof THREE.ShaderMaterial !== 'function') {
        warnCustomShaderOnce('three', '[CustomShaders] The THREE namespace has no ShaderMaterial; 3D custom shaders are skipped.');
        return null;
    }
    const compiled = testCompileCustomShader3D(testContextFor(options), def);
    if (!compiled.ok) {
        warnCustomShaderOnce(`compile:3d:${name}:${hashCustomShaderSource(def.fragment)}`, `[CustomShaders] Custom shader "${name}" failed to compile; it is skipped.\n${compiled.log}`);
        return null;
    }

    const uniforms = customShaderUniforms(def);
    let resolved = resolveUniformValues(def, values);
    const threeUniforms: Record<string, { value: number | number[] }> = {
        uTime: { value: 0 },
        uBaseColor: { value: baseColorVector(baseColor) },
    };
    for (const uniform of uniforms) {
        threeUniforms[customShaderGpuUniformName(uniform)] = { value: customShaderGpuValue(uniform, resolved[uniform.name]) };
    }
    let material: CustomShaderNamespace;
    try {
        material = new THREE.ShaderMaterial({
            name: `OrcaCustomShader:${name}`,
            glslVersion: THREE.GLSL3,
            vertexShader: buildVertexSource3D(true),
            fragmentShader: buildFragmentSource3D(def),
            uniforms: threeUniforms,
            transparent: true,
            side: options && options.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
        });
    } catch (err) {
        warnCustomShaderOnce(`create:3d:${name}`, `[CustomShaders] Custom shader "${name}" could not be created; it is skipped.`, err);
        return null;
    }

    let time = 0;
    let destroyed = false;
    const write = (uniform: OrcaCustomShaderUniform): void => {
        threeUniforms[customShaderGpuUniformName(uniform)].value = customShaderGpuValue(uniform, resolved[uniform.name]);
    };
    return {
        material,
        definition: def,
        getValues: () => resolveUniformValues(def, resolved),
        setValues(next: unknown): void {
            if (destroyed) return;
            resolved = resolveUniformValues(def, next);
            for (const uniform of uniforms) write(uniform);
        },
        setUniform(uniformName: string, value: unknown): boolean {
            if (destroyed) return false;
            for (const uniform of uniforms) {
                if (uniform.name !== uniformName) continue;
                resolved[uniform.name] = coerceUniformValue(uniform, value);
                write(uniform);
                return true;
            }
            return false;
        },
        setBaseColor(color: unknown): void {
            if (!destroyed) threeUniforms.uBaseColor.value = baseColorVector(color);
        },
        tick(deltaSeconds: number): void {
            if (destroyed || !isFiniteNumber(deltaSeconds) || deltaSeconds <= 0) return;
            time += deltaSeconds;
            threeUniforms.uTime.value = time;
        },
        getTime: () => time,
        destroy(): void {
            if (destroyed) return;
            destroyed = true;
            try {
                material.dispose();
            } catch {
                // Best effort.
            }
        },
    };
}
