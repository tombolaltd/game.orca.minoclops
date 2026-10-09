import { flowstateMethods } from "./methods"
import { isLoopNode, loopIterationCount } from "./methods/loop"
import { resolveValuePath } from "./methods/object"
import { describeFlowError, emitFlowConsole, FlowNodeContext, isFlowErrorReported, markFlowErrorReported, withFlowNodeContext } from "./methods/flow-console"
import { IFlowstateData, IFlowstateEventTriggers, IFlowstateGraphVariable, IFlowstateNode, IFlowstateSubgraph } from "./types"
import { FlowstateApplicationEventTriggers } from "./event-triggers/application-events";
import { bindPixiStarters, detachAllPixiStarters } from "./event-triggers/pixi-events";
import { bindCustomEventStarters, detachAllCustomEventStarters } from "./event-triggers/custom-events";
import { bindGamePreferenceStarters, detachAllGamePreferenceStarters } from "./event-triggers/game-preferences";
import { initFlowstateHandshake } from "./editor-integration";
import { ACTIVE_SKIN, ACTIVE_SKIN_NAME } from "./active-skin";
import { SKIN_FLOWSTATE_GRAPHS } from "./generated-skin-flows";
import packageConfig from '@/package.json';

// ─────────────────────────────────────────────────────────────────────────────
// Multi-graph runtime loader
// ─────────────────────────────────────────────────────────────────────────────
//
// Editor exports land in two locations:
//   <project>/game/src/core/flowstate-data/<name>.json           (core graphs)
//   <project>/game/src/skins/<skin>/flowstate-data/<name>.json   (per-skin graphs)
//
// Each JSON file is registered as a distinct graph. Node IDs only need to be
// unique within their own graph. Starter-node entry points are aggregated
// across all graphs:
//   - by *title*  (`onApplicationInit`, `onSpinPressed`, …) for host-fired
//     starters that fan out across every loaded graph;
//   - by *node id* (`runFlowsByStarterId`) for pixi pointer-event starters
//     that bind to a single specific scene-graph DisplayObject.
//
// Branch nodes evaluate their `condition` property at execution time and
// follow the outgoing link whose `outIdx` matches truth value (0 = true,
// 1 = false).
//
// Loop nodes (rootType === 'loop') resolve their `items` array property at
// execution time and walk the body sub-sequence (outIdx 0) once per element
// to full completion, then follow the complete output (outIdx 1). A flow link
// arriving on a loop's BREAK input (`toInput: 'break'`) — from any walk,
// including the loop's own body — stops every live run of that loop at once;
// a broken loop follows its "on break" output (outIdx 2) instead of complete.
// Both branch and loop are special-cased in the walker — neither is a
// registered method.
// ─────────────────────────────────────────────────────────────────────────────

interface LoadedGraph {
    id: string;
    source: 'core' | 'skin';
    data: IFlowstateData;
}

interface OutgoingLink {
    to: string;
    outIdx: number;
    /** Named target input; only `'break'` (a loop's Break pin) is recognised. */
    toInput?: string;
}

/** One live execution of a loop node; `broken` is set by a Break arrival. */
interface LoopRun {
    broken: boolean;
    signal: Promise<void>;
    resolve: () => void;
}

type LoopOutcome = 'complete' | 'broken' | 'cancelled';

const LOOP_BREAK_INPUT = 'break';
const LOOP_BODY_OUT_IDX = 0;
const LOOP_COMPLETE_OUT_IDX = 1;
const LOOP_BREAK_OUT_IDX = 2;

const STOP_WALK: unique symbol = Symbol('stopWalk');

// Action nodes with a 'then' (outIdx 0) + 'on complete' (outIdx 1) pair — menu `flowOutputs`.
const COMPLETION_OUTPUT_TITLES = new Set(['httpPost']);
const COMPLETION_OUT_IDX = 1;

/**
 * Traversal context for the shared flow walker. Lets runFlowFrom (top-level
 * graph) and runSubgraph (state subgraphs) share one `walkFrom` implementation:
 * `nodeMap`/`outgoing` scope what is traversed, while `graph` is the
 * RegisteredGraph used for method execution + property/condition resolution.
 */
interface WalkContext {
    nodeMap: Map<string, IFlowstateNode>;
    outgoing: Map<string, OutgoingLink[]>;
    graph: RegisteredGraph;
    /**
     * Transient per-walk loop iteration state, keyed by loop node id. A loop
     * node's `index` / `item` value outputs have NO method — they are the
     * current iteration variables held here while `runLoop` is iterating.
     * One Map is created per top-level flow walk (runFlowFrom) and shared
     * verbatim with every nested runSubgraph ctx, so body nodes living in a
     * state subgraph can still read an enclosing loop's live state. Distinct
     * loops have distinct ids, so nested loops never collide; the key is
     * deleted when a loop finishes so stale values can't leak to later reads.
     */
    loopState: Map<string, { index: number; item: unknown }>;
    /**
     * Transient per-walk starter-event arguments. A STARTER node can expose
     * value-output pins (e.g. `onApplicationResize` → `width` / `height`)
     * that have NO registered method — their values are the runtime args the
     * host fired the starter with. Seeded on the WalkContext created by
     * runFlowFrom when the starter's flow is dispatched (keyed by the starter
     * node id == the walk's startNodeId) and shared verbatim with every
     * nested runSubgraph ctx, so body nodes can read them. Same per-walk,
     * reentrancy-safe discipline as `loopState` — never a static field.
     */
    starterArgs?: { nodeId: string; values: Record<string, unknown> };
    /**
     * Results of `COMPLETION_OUTPUT_TITLES` nodes, keyed by node id, seeded only
     * on the 'on complete' walk that follows each one.
     */
    completionResults?: Map<string, unknown>;
    /**
     * True once an enclosing loop has been broken. The walker stops before
     * the next node, so a broken body never runs past the node in flight.
     */
    cancelled?: () => boolean;
}

interface RegisteredGraph {
    id: string;
    source: 'core' | 'skin';
    data: IFlowstateData;
    nodeMap: Map<string, IFlowstateNode>;
    /** sequence/control-flow links only (property links excluded). */
    linkMap: Map<string, OutgoingLink[]>;
    /** node ids of starter entry points. */
    starterIds: string[];
    /**
     * Per-graph local variables, seeded from `data.variables` at registration.
     * Read/written by walker-intrinsic `getVariable` / `setVariable` nodes.
     *
     * SCOPE: subgraphs share the enclosing graph's store (runSubgraph passes
     * `graph` verbatim). A CORE graph produces ONE runtime JSON serving every
     * skin, so its variables are shared across skins.
     * LIFETIME: lives on RegisteredGraph, which only `Flowstate.init()`
     * rebuilds — so values survive loadScene/unloadScene and reset only on a
     * full re-init.
     * CONCURRENCY: concurrent walks over one graph interleave at every await;
     * the store is last-write-wins (matches Blueprint semantics).
     */
    variables: Map<string, unknown>;
}

/**
 * Seed a graph's variable store: `defaultValue` when present, else the type
 * default. Arrays are built FRESH per graph so two graphs never share one
 * literal. Absent / malformed declarations yield an empty store, silently.
 */
function buildGraphVariables(declarations?: IFlowstateGraphVariable[]): Map<string, unknown> {
    const store = new Map<string, unknown>();
    if (!Array.isArray(declarations)) return store;

    for (const decl of declarations) {
        if (!decl || typeof decl.name !== 'string' || decl.name === '') continue;
        if (decl.defaultValue !== undefined) {
            store.set(decl.name, Array.isArray(decl.defaultValue) ? [...decl.defaultValue] : decl.defaultValue);
            continue;
        }
        switch (decl.type) {
            case 'int':
            case 'float':
                store.set(decl.name, 0);
                break;
            case 'string':
                store.set(decl.name, '');
                break;
            case 'bool':
                store.set(decl.name, false);
                break;
            case 'StringArray':
            case 'IntArray':
            case 'FloatArray':
            case 'BoolArray':
            case 'ObjectArray':
                store.set(decl.name, []);
                break;
            default:
                store.set(decl.name, undefined);
                break;
        }
    }
    return store;
}

type FlowstateDataModule = IFlowstateData | { default?: IFlowstateData };
type FlowstateDataContext = {
    keys(): string[];
    (key: string): FlowstateDataModule;
};

function unwrap(mod: FlowstateDataModule): IFlowstateData {
    return ((mod as { default?: IFlowstateData }).default ?? (mod as IFlowstateData));
}

function loadAllFlowstateData(): LoadedGraph[] {
    const out: LoadedGraph[] = [];

    try {
        const coreCtx = (require as any).context('../../flowstate-data', false, /\.json$/) as FlowstateDataContext;
        coreCtx.keys().forEach((k: string) => {
            const data = unwrap(coreCtx(k));
            const name = k.replace(/^\.\//, '').replace(/\.json$/, '');
            out.push({ id: `core/${name}`, source: 'core', data });
        });
    } catch (err) {
        console.warn('[FlowState] No core/flowstate-data folder found', err);
    }

    try {
        for (const [name, data] of Object.entries(SKIN_FLOWSTATE_GRAPHS)) {
            out.push({ id: `skin/${ACTIVE_SKIN}/${name}`, source: 'skin', data: data as IFlowstateData });
        }
    } catch (err) {
        console.warn('[FlowState] Failed to load skin flowstate graphs', err);
    }

    return out;
}

export abstract class Flowstate {
    private static graphs: RegisteredGraph[] = [];
    private static graphsById: Map<string, RegisteredGraph> = new Map();

    /** `${graphId}\u0000${loopNodeId}` -> live runs of that loop (for Break). */
    private static activeLoopRuns: Map<string, Set<LoopRun>> = new Map();

    /** title -> [(graphId, starterNodeId)]; populated only for non-pixi
     *  starters (pixi starters are dispatched per-id via bindPixiStarters). */
    private static starterNodeFlowsByTitle: Map<string, Array<{ graphId: string; starterNodeId: string }>> = new Map();

    public static eventTriggers: IFlowstateEventTriggers = {
        application: new FlowstateApplicationEventTriggers(),
        // Pixi events are auto-registered via bindPixiStarters(); the
        // legacy class is retained as an empty stub for compatibility
        // with any host code that still references it.
        pixi: {} as any
    };

    // ---------------------------------------------------------------
    // Init / registration
    // ---------------------------------------------------------------

    public static async init(): Promise<void> {
        this.graphs = [];
        this.graphsById.clear();
        this.starterNodeFlowsByTitle.clear();

        const loaded = loadAllFlowstateData();
        for (const lg of loaded) {
            const registered = this.registerGraph(lg);
            this.graphs.push(registered);
            this.graphsById.set(registered.id, registered);
        }

        this.flowstateEditorHandshake();

        // Pixi starters need live DisplayObjects; bind whatever already
        // exists (typically nothing at init time — scenes load later via
        // host or a flow-driven loadScene). bindPixiStarters is also
        // called from methods/scene.ts after every (un)loadScene.
        this.bindPixiStarters();
        // Custom-event starters don't depend on DisplayObjects, so they
        // bind successfully here; re-binds on (un)loadScene are harmless.
        this.bindCustomEventStarters();
        this.bindGamePreferenceStarters();
    }

    /**
     * Wire pointer-event listeners for every pixi starter whose `target`
     * NodeRef resolves to a live DisplayObject. Detaches previous bindings.
     * Idempotent — call after init() and after every loadScene/unloadScene.
     */
    public static bindPixiStarters(): void {
        bindPixiStarters(
            this.graphs.map(g => ({ id: g.id, starterNodes: g.starterIds.map(id => g.nodeMap.get(id)!).filter(Boolean) as any })),
            (graphId, nodeId) => { void this.runFlowsByStarterId(graphId, nodeId); }
        );
    }

    public static detachPixiStarters(): void {
        detachAllPixiStarters();
    }

    /**
     * Wire eventEmitter listeners for every `onCustomEvent` / `onEventFire`
     * starter whose `eventName` property is a non-empty string. Detaches
     * previous bindings. Idempotent — call after init() and after every
     * loadScene/unloadScene (mirrors bindPixiStarters).
     */
    public static bindCustomEventStarters(): void {
        bindCustomEventStarters(
            this.graphs.map(g => ({ id: g.id, starterNodes: g.starterIds.map(id => g.nodeMap.get(id)!).filter(Boolean) as any })),
            (graphId, nodeId, args) => { void this.runFlowsByStarterId(graphId, nodeId, args); }
        );
    }

    public static detachCustomEventStarters(): void {
        detachAllCustomEventStarters();
    }

    /**
     * Wire the single ORCA_GAME_PREFERENCE_CHANGED listener that dispatches
     * `onGamePreferenceChanged` starters. Idempotent (mirrors
     * bindCustomEventStarters).
     */
    public static bindGamePreferenceStarters(): void {
        bindGamePreferenceStarters(
            this.graphs.map(g => ({ id: g.id, starterNodes: g.starterIds.map(id => g.nodeMap.get(id)!).filter(Boolean) as any })),
            (graphId, nodeId, args) => { void this.runFlowsByStarterId(graphId, nodeId, args); }
        );
    }

    public static detachGamePreferenceStarters(): void {
        detachAllGamePreferenceStarters();
    }

    private static registerGraph(loaded: LoadedGraph): RegisteredGraph {
        const nodeMap = new Map<string, IFlowstateNode>();
        const addNodes = (nodes: IFlowstateNode[]) => {
            nodes.forEach(node => {
                nodeMap.set(node.id, node);
                if (node.subgraph) addNodes(node.subgraph.nodes);
            });
        };
        addNodes(loaded.data.nodes);

        // Multi-output sequence link map.
        const linkMap = new Map<string, OutgoingLink[]>();
        loaded.data.links.forEach(link => {
            if (link.propertyType) return; // property wiring, not flow
            const list = linkMap.get(link.from) ?? [];
            list.push({ to: link.to, outIdx: link.outIdx ?? 0, toInput: (link as { toInput?: string }).toInput });
            linkMap.set(link.from, list);
        });

        // Entry points = sequence-link sinks that have no incoming flow.
        const incoming = new Set(
            loaded.data.links.filter(l => !l.propertyType).map(l => l.to)
        );
        const starterIds = loaded.data.nodes
            .filter(n => !incoming.has(n.id))
            .map(n => n.id);

        // Index non-pixi starter entry points by title for fan-out dispatch.
        for (const id of starterIds) {
            const node = nodeMap.get(id);
            if (!node || !node.title) continue;
            // Pixi starters dispatch by node id, not title.
            if (PIXI_STARTER_TITLES.has(node.title)) continue;
            // Custom-event starters dispatch by their eventName property
            // (via eventEmitter.on), not by title fan-out.
            if (CUSTOM_EVENT_STARTER_TITLES.has(node.title)) continue;
            // Game-preference starters dispatch via event-triggers/game-preferences.ts.
            if (GAME_PREFERENCE_STARTER_TITLES.has(node.title)) continue;

            const list = this.starterNodeFlowsByTitle.get(node.title) ?? [];
            list.push({ graphId: loaded.id, starterNodeId: id });
            this.starterNodeFlowsByTitle.set(node.title, list);
        }

        return {
            id: loaded.id,
            source: loaded.source,
            data: loaded.data,
            nodeMap,
            linkMap,
            starterIds,
            variables: buildGraphVariables(loaded.data.variables),
        };
    }

    private static flowstateEditorHandshake(): void {
        const cleanup = initFlowstateHandshake({
            version: packageConfig.version,
            gameName: 'GAME_NAME_TITLE_CASE'
        });
        window.addEventListener('beforeunload', cleanup);
    }

    // ---------------------------------------------------------------
    // Public dispatch API
    // ---------------------------------------------------------------

    /**
     * Fan-out: run every starter (across every graph) whose title matches
     * `starterNodeType` (e.g. 'onApplicationInit'). Used by host code and
     * the application event trigger class.
     */
    public static async runFlowsByStarterType(starterNodeType: string, args?: Record<string, unknown>): Promise<void> {
        const entries = this.starterNodeFlowsByTitle.get(starterNodeType);
        if (!entries || entries.length === 0) return;
        await Promise.all(entries.map(({ graphId, starterNodeId }) => this.runFlowFrom(graphId, starterNodeId, args)));
    }

    /**
     * Run exactly one starter's flow by node id. Used by pixi pointer-event
     * binding so a click on object A only fires its own flow, not every
     * onPointerDown across the project.
     *
     * `args` are the starter's runtime value outputs (see
     * `WalkContext.starterArgs`). Custom-event starters pass the
     * `fireCustomEvent` pass-prop payload here, keyed by prop NAME; pixi
     * pointer starters have no payload and pass nothing.
     */
    public static async runFlowsByStarterId(graphId: string, starterNodeId: string, args?: Record<string, unknown>): Promise<void> {
        await this.runFlowFrom(graphId, starterNodeId, args);
    }

    /** @deprecated use runFlowsByStarterId */
    public static async runFlow(graphId: string, flowId: string): Promise<void> {
        await this.runFlowFrom(graphId, flowId);
    }

    public static async runAllFlows(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const graph of this.graphs) {
            for (const id of graph.starterIds) {
                promises.push(this.runFlowFrom(graph.id, id));
            }
        }
        await Promise.all(promises);
    }

    public static getFlowIds(): Array<{ graphId: string; flowId: string }> {
        const out: Array<{ graphId: string; flowId: string }> = [];
        for (const graph of this.graphs) {
            for (const id of graph.starterIds) {
                out.push({ graphId: graph.id, flowId: id });
            }
        }
        return out;
    }

    // ---------------------------------------------------------------
    // Flow walker (replaces the old pre-flattened rootFlows approach)
    // ---------------------------------------------------------------

    /**
     * Walk + execute a flow starting at `startNodeId`. Branch nodes are
     * evaluated at execution time so the runtime can pick the correct
     * True/False output based on the live `condition` value. Loop nodes
     * walk their body sub-sequence once per resolved `items` element.
     */
    private static async runFlowFrom(graphId: string, startNodeId: string, args?: Record<string, unknown>): Promise<void> {
        const graph = this.graphsById.get(graphId);
        if (!graph) return;

        const ctx: WalkContext = {
            nodeMap: graph.nodeMap,
            outgoing: graph.linkMap,
            graph,
            loopState: new Map<string, { index: number; item: unknown }>(),
            // Starter value-output pins (e.g. onApplicationResize width/height)
            // read these args; keyed by the starter node id == startNodeId.
            starterArgs: args ? { nodeId: startNodeId, values: args } : undefined,
        };
        await this.walkFrom(ctx, startNodeId, new Set<string>());
    }

    private static async runSubgraph(sub: IFlowstateSubgraph, parentCtx: WalkContext): Promise<void> {
        // Sub-graph nodes share the parent graph's node map by virtue of
        // registerGraph adding them; flow within the subgraph is walked
        // from its first non-incoming node.
        if (!sub.nodes || sub.nodes.length === 0) return;

        const parentGraph = parentCtx.graph;
        const subIncoming = new Set(sub.links.filter(l => !l.propertyType).map(l => l.to));
        const entry = sub.nodes.find(n => n.isEntry) ?? sub.nodes.find(n => !subIncoming.has(n.id));
        if (!entry) return;

        // Build a temporary linkMap + nodeMap for the subgraph and walk it
        // with the SAME shared walker as runFlowFrom — scoped to this
        // subgraph's nodes/links but executing methods + resolving
        // properties against the parent graph.
        const subLinks = new Map<string, OutgoingLink[]>();
        sub.links.forEach(link => {
            if (link.propertyType) return;
            const list = subLinks.get(link.from) ?? [];
            list.push({ to: link.to, outIdx: link.outIdx ?? 0, toInput: (link as { toInput?: string }).toInput });
            subLinks.set(link.from, list);
        });
        const subNodeMap = new Map<string, IFlowstateNode>();
        sub.nodes.forEach(n => subNodeMap.set(n.id, n));

        const ctx: WalkContext = {
            nodeMap: subNodeMap,
            outgoing: subLinks,
            graph: parentGraph,
            // Share the enclosing walk's loop state verbatim so body nodes
            // inside this subgraph can read an enclosing loop's index/item.
            loopState: parentCtx.loopState,
            // Share the enclosing walk's starter args verbatim so body nodes
            // inside this subgraph can read a starter's value-output pins.
            starterArgs: parentCtx.starterArgs,
            completionResults: parentCtx.completionResults,
            cancelled: parentCtx.cancelled,
        };
        await this.walkFrom(ctx, entry.id, new Set<string>());
    }

    /**
     * Shared per-node flow walker used by BOTH runFlowFrom (top-level
     * graph) and runSubgraph (state subgraphs). `ctx` carries the
     * node/link maps to traverse plus the RegisteredGraph used for method
     * execution + property/condition resolution. `visited` is the caller-
     * owned cycle guard for this walk; loop body iterations get their own
     * scoped set so re-walking the body doesn't trip the guard.
     */
    private static async walkFrom(ctx: WalkContext, startId: string, visited: Set<string>, startInput?: string): Promise<void> {
        const MAX_STEPS = 10000;
        let steps = 0;
        let currentId: string | undefined = startId;
        let currentInput: string | undefined = startInput;

        while (currentId && steps++ < MAX_STEPS) {
            if (ctx.cancelled?.()) return;

            const node = ctx.nodeMap.get(currentId);
            if (!node) return;

            // A Break arrival only signals the loop; it never (re-)runs it, so it
            // is checked before the cycle guard (a body breaking its own loop).
            if (currentInput === LOOP_BREAK_INPUT && isLoopNode(node)) {
                this.signalLoopBreak(ctx.graph.id, currentId);
                return;
            }

            if (visited.has(currentId)) {
                emitFlowConsole('warn', `[FlowState] Cycle detected at node ${currentId} in graph ${ctx.graph.id}`, {
                    context: flowNodeContext(node, ctx),
                    code: 'cycle',
                });
                return;
            }
            visited.add(currentId);

            if (node.isExit) return;

            // Control-flow nodes resolve inputs outside executeNode; a throw there
            // ends this walk, attributed, instead of rejecting it unattributed.
            let next: OutgoingLink | undefined | typeof STOP_WALK;
            try {
                next = await this.stepNode(ctx, node, currentId, visited);
            } catch (err) {
                if (!isFlowErrorReported(err)) {
                    emitFlowConsole('error', `[FlowState] ${node.title}: ${describeFlowError(err)}`, {
                        context: flowNodeContext(node, ctx),
                        code: 'node-error',
                    });
                }
                return;
            }
            if (next === STOP_WALK) return;

            currentId = next?.to;
            currentInput = next?.toInput;
        }
    }

    /** Run one node and pick the outgoing link to follow (`STOP_WALK` ends the walk). */
    private static async stepNode(
        ctx: WalkContext,
        node: IFlowstateNode,
        currentId: string,
        visited: Set<string>,
    ): Promise<OutgoingLink | undefined | typeof STOP_WALK> {
        if (node.subgraph) {
            await this.runSubgraph(node.subgraph, ctx);
            return this.firstOutgoingLink(ctx, currentId);
        }
        if (this.isBranchNode(node)) {
            const conditionTrue = await this.resolveBranchCondition(node, ctx);
            return this.outgoingLinkByIdx(ctx, currentId, conditionTrue ? 0 : 1);
        }
        if (this.isSwitchNode(node)) {
            const idx = await this.resolveSwitchCaseIndex(node, ctx);
            return this.outgoingLinkByIdx(ctx, currentId, idx);
        }
        if (isLoopNode(node)) {
            const outcome = await this.runLoop(ctx, node, currentId);
            if (outcome === 'cancelled') return STOP_WALK;
            return this.outgoingLinkByIdx(
                ctx,
                currentId,
                outcome === 'broken' ? LOOP_BREAK_OUT_IDX : LOOP_COMPLETE_OUT_IDX,
            );
        }
        if (node.title === SET_VARIABLE_TITLE) {
            // Walker-intrinsic write to the per-graph variable store, then
            // continue the normal exec-out traversal.
            await this.applySetVariable(node, ctx);
            return this.firstOutgoingLink(ctx, currentId);
        }
        if (COMPLETION_OUTPUT_TITLES.has(node.title)) {
            // outIdx 0 continues at once; outIdx 1 walks when the node's work settles.
            const pending = this.executeNode(node, ctx);
            const nodeId = currentId;
            const completeLink = this.outgoingLinkByIdx(ctx, nodeId, COMPLETION_OUT_IDX);
            if (completeLink) {
                const completeVisited = new Set(visited);
                void pending
                    .then(result => {
                        if (ctx.cancelled?.()) return;
                        const completionResults = new Map(ctx.completionResults ?? []);
                        completionResults.set(nodeId, result);
                        return this.walkFrom({ ...ctx, completionResults }, completeLink.to, completeVisited, completeLink.toInput);
                    })
                    .catch(err => {
                        if (isFlowErrorReported(err)) return;
                        emitFlowConsole('error', `[FlowState] ${node.title}: 'on complete' walk failed: ${describeFlowError(err)}`, {
                            context: flowNodeContext(node, ctx),
                            code: 'node-error',
                        });
                    });
            }
            return this.outgoingLinkByIdx(ctx, nodeId, 0);
        }
        if (node.isState || node.isEntry) {
            // Skip but continue.
            return this.firstOutgoingLink(ctx, currentId);
        }
        await this.executeNode(node, ctx);
        return this.firstOutgoingLink(ctx, currentId);
    }

    /**
     * Execute a loop node: resolve its `items` array property, then walk
     * the body sub-sequence (outIdx 0) to FULL COMPLETION once per element.
     * Each iteration awaits every body node exactly like the main walker,
     * so delay / tween / spine-onComplete nodes block the next iteration.
     *
     * Iteration count is strictly bounded by the resolved array length;
     * a non-array / empty / undefined `items` runs ZERO iterations.
     *
     * BREAK: while it runs, the loop is registered in `activeLoopRuns`. A
     * Break arrival resolves the in-flight body wait IMMEDIATELY and cancels
     * the body walk before its next node (the node already in flight — e.g. a
     * tween — finishes on its own), then reports `'broken'` so the walker
     * follows the "on break" output. `'cancelled'` = an ENCLOSING loop broke.
     */
    private static async runLoop(ctx: WalkContext, loopNode: IFlowstateNode, loopId: string): Promise<LoopOutcome> {
        const run = this.beginLoopRun(ctx.graph.id, loopId);
        const settle = (): LoopOutcome =>
            run.broken ? 'broken' : ctx.cancelled?.() ? 'cancelled' : 'complete';
        try {
            const items = await this.resolveLoopItems(loopNode, ctx);
            const isArray = Array.isArray(items);

            // Iteration count: array length when `items` resolves to a real array;
            // otherwise fall back to the loop node's `count` int property.
            let count = loopIterationCount(items);
            if (!isArray) {
                const countProp = (loopNode.properties ?? []).find(p => p.name === 'count');
                const c = countProp ? await this.resolvePropertyValue(countProp as any, ctx) : 0;
                const n = Number(c);
                count = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
            }
            if (count === 0) return settle();

            const bodyStart = this.outgoingLinkByIdx(ctx, loopId, LOOP_BODY_OUT_IDX);
            if (!bodyStart) return settle();

            const parentCancelled = ctx.cancelled;
            const bodyCtx: WalkContext = {
                ...ctx,
                cancelled: () => run.broken || !!parentCancelled?.(),
            };

            const arr = isArray ? (items as unknown[]) : undefined;
            for (let i = 0; i < count; i++) {
                if (run.broken || ctx.cancelled?.()) break;

                // Publish the current iteration variables so body nodes can read
                // this loop's `index` / `item` value outputs. When iterating by
                // `count` with no array, `item` falls back to the index `i` so
                // it stays a meaningful value rather than undefined.
                ctx.loopState.set(loopId, { index: i, item: arr ? arr[i] : i });

                // Per-iteration scoped visited set so re-walking the same body
                // node ids on iteration 2+ doesn't trip the cycle guard. Seed
                // it with the loop node id so a malformed body that links back
                // to the loop can't re-enter it (bounding the body walk to the
                // body sub-sequence only).
                const bodyVisited = new Set<string>([loopId]);
                await Promise.race([
                    this.walkFrom(bodyCtx, bodyStart.to, bodyVisited, bodyStart.toInput),
                    run.signal,
                ]);
            }
            return settle();
        } finally {
            this.endLoopRun(ctx.graph.id, loopId, run);
            // Drop the key once iteration completes so a stale index/item can't
            // leak to later reads (e.g. the "loop complete" sub-sequence).
            ctx.loopState.delete(loopId);
        }
    }

    private static loopRunKey(graphId: string, loopId: string): string {
        return `${graphId}\u0000${loopId}`;
    }

    private static beginLoopRun(graphId: string, loopId: string): LoopRun {
        let resolve: () => void = () => {};
        const signal = new Promise<void>(r => { resolve = r; });
        const run: LoopRun = { broken: false, signal, resolve };
        const key = this.loopRunKey(graphId, loopId);
        const runs = this.activeLoopRuns.get(key) ?? new Set<LoopRun>();
        runs.add(run);
        this.activeLoopRuns.set(key, runs);
        return run;
    }

    private static endLoopRun(graphId: string, loopId: string, run: LoopRun): void {
        const key = this.loopRunKey(graphId, loopId);
        const runs = this.activeLoopRuns.get(key);
        if (!runs) return;
        runs.delete(run);
        if (runs.size === 0) this.activeLoopRuns.delete(key);
    }

    /** Break every live run of a loop node. No-op when the loop isn't running. */
    private static signalLoopBreak(graphId: string, loopId: string): void {
        const runs = this.activeLoopRuns.get(this.loopRunKey(graphId, loopId));
        if (!runs) return;
        for (const run of runs) {
            if (run.broken) continue;
            run.broken = true;
            run.resolve();
        }
    }

    private static async resolveLoopItems(node: IFlowstateNode, ctx: WalkContext): Promise<unknown> {
        const prop = (node.properties ?? []).find(p => p.name === 'items');
        if (!prop) return undefined;
        return await this.resolvePropertyValue(prop as any, ctx);
    }

    private static firstOutgoingLink(ctx: WalkContext, fromId: string): OutgoingLink | undefined {
        const links = ctx.outgoing.get(fromId);
        if (!links || links.length === 0) return undefined;
        // Sequence nodes only ever have one outgoing flow link in well-
        // formed graphs; return the first deterministically (lowest outIdx).
        const sorted = [...links].sort((a, b) => a.outIdx - b.outIdx);
        return sorted[0];
    }

    private static outgoingLinkByIdx(ctx: WalkContext, fromId: string, outIdx: number): OutgoingLink | undefined {
        return ctx.outgoing.get(fromId)?.find(l => l.outIdx === outIdx);
    }

    private static isBranchNode(node: IFlowstateNode): boolean {
        // Best-effort: editor stamps `rootType: 'branch'` on branch nodes.
        return (node as any).rootType === 'branch';
    }

    private static isSwitchNode(node: IFlowstateNode): boolean {
        // Editor stamps `rootType: 'switch'` on switch nodes.
        return (node as any).rootType === 'switch';
    }

    /**
     * Resolve a switch node's `value` and `cases` array, returning the outIdx
     * of the first matching case (strict ===, falling back to stringified
     * equality). Returns -1 when no case matches OR `cases` is not an array,
     * which `outgoingByIdx` resolves to the default output link (outIdx -1).
     */
    private static async resolveSwitchCaseIndex(node: IFlowstateNode, ctx: WalkContext): Promise<number> {
        const valueProp = (node.properties ?? []).find(p => p.name === 'value');
        const casesProp = (node.properties ?? []).find(p => p.name === 'cases');
        const value = valueProp ? await this.resolvePropertyValue(valueProp as any, ctx) : undefined;
        const cases = casesProp ? await this.resolvePropertyValue(casesProp as any, ctx) : undefined;
        if (!Array.isArray(cases)) return -1;

        const strict = cases.findIndex(c => c === value);
        if (strict !== -1) return strict;
        const loose = cases.findIndex(c => String(c) === String(value));
        return loose; // -1 when no match → default pin
    }

    private static async resolveBranchCondition(node: IFlowstateNode, ctx: WalkContext): Promise<boolean> {
        const prop = (node.properties ?? []).find(p => p.name === 'condition');
        if (!prop) return false;
        const val = await this.resolvePropertyValue(prop as any, ctx);
        // Loose truth coercion — handle bool, int (0/non-0), string ('true'/'false'/'').
        if (typeof val === 'boolean') return val;
        if (typeof val === 'number') return val !== 0;
        if (typeof val === 'string') {
            if (val === '' || val === '0' || val.toLowerCase() === 'false') return false;
            return true;
        }
        return Boolean(val);
    }

    // ---------------------------------------------------------------
    // Node execution (single node)
    // ---------------------------------------------------------------

    private static async executeNode(node: IFlowstateNode, ctx: WalkContext): Promise<unknown> {
        if (node.isState || node.isEntry || node.isExit) return undefined;

        // Pixi starter entry nodes are dispatched per-id via
        // bindPixiStarters; skip method lookup so a bare 'onPointerDown'
        // doesn't attempt to call a method that doesn't exist.
        if (PIXI_STARTER_TITLES.has(node.title)) return undefined;

        // Variable nodes are walker-intrinsic — they need the per-graph store,
        // which method dispatch (no ctx, no graphId) cannot reach.
        if (VARIABLE_NODE_TITLES.has(node.title)) return undefined;

        const method = this.findMethod(flowstateMethods, node.title);
        if (!method) return undefined;

        const nodeCtx = flowNodeContext(node, ctx);
        try {
            const params: any[] = [];
            if (node.properties && node.properties.length > 0) {
                for (const prop of node.properties) {
                    const value = await this.resolvePropertyValue(prop, ctx);
                    params.push(value);
                }
            }
            reportMissingReferenceInputs(node, params, nodeCtx);
            // Context covers only the synchronous part; deferred callbacks capture it.
            return await withFlowNodeContext(nodeCtx, () => method(...params));
        } catch (err) {
            if (!isFlowErrorReported(err)) {
                emitFlowConsole('error', `[FlowState] ${node.title}: ${describeFlowError(err)}`, {
                    context: nodeCtx,
                    code: 'node-error',
                });
            }
            return undefined;
        }
    }

    private static async resolvePropertyValue(
        prop: { name: string; type: string; value?: any; sourceNodeId?: string; sourceOutputName?: string },
        ctx: WalkContext
    ): Promise<any> {
        if (prop.sourceNodeId) {
            // Starter value outputs (e.g. onApplicationResize `width`/`height`)
            // are transient per-walk args, not a registered method. When the
            // consumer pin sources from THIS walk's starter node, return the
            // runtime arg the host fired the starter with.
            if (ctx.starterArgs && prop.sourceNodeId === ctx.starterArgs.nodeId) {
                return ctx.starterArgs.values[prop.sourceOutputName!];
            }

            const sourceNode = ctx.graph.nodeMap.get(prop.sourceNodeId);
            if (sourceNode) {
                // Loop value outputs (`index` / `item`) are transient iteration
                // state, not a registered method. Read the live loopState for
                // the iterating loop; a missing entry (loop not currently
                // iterating) resolves to undefined gracefully.
                if ((sourceNode as any).rootType === 'loop') {
                    const entry = ctx.loopState.get(prop.sourceNodeId);
                    if (!entry) return undefined;
                    return prop.sourceOutputName === 'index' ? entry.index : entry.item;
                }

                // Per-graph local variable READ. Walker-intrinsic like loop
                // outputs — resolved here, BEFORE findMethod, so method lookup
                // can never match the title.
                if (sourceNode.title === GET_VARIABLE_TITLE) {
                    return await this.readGraphVariable(sourceNode, ctx);
                }

                // Never re-run a request to read its result; only its 'on complete' walk has one.
                if (COMPLETION_OUTPUT_TITLES.has(sourceNode.title)) {
                    return ctx.completionResults?.get(prop.sourceNodeId);
                }

                const method = this.findMethod(flowstateMethods, sourceNode.title);
                if (method) {
                    const sourceParams: any[] = [];
                    if (sourceNode.properties && sourceNode.properties.length > 0) {
                        for (const sourceProp of sourceNode.properties) {
                            const value = await this.resolvePropertyValue(sourceProp, ctx);
                            sourceParams.push(value);
                        }
                    }
                    const sourceCtx = flowNodeContext(sourceNode, ctx);
                    reportMissingReferenceInputs(sourceNode, sourceParams, sourceCtx);
                    let result: unknown;
                    try {
                        result = await withFlowNodeContext(sourceCtx, () => method(...sourceParams));
                    } catch (err) {
                        // Attribute to the getter; the consumer still aborts, without a second line.
                        if (!isFlowErrorReported(err)) {
                            emitFlowConsole('error', `[FlowState] ${sourceNode.title}: ${describeFlowError(err)}`, {
                                context: sourceCtx,
                                code: 'node-error',
                            });
                        }
                        throw markFlowErrorReported(err);
                    }
                    if (prop.sourceOutputName) {
                        // AUTHOR-DEFINED drill-down output: the source node
                        // exported an `outputs[]` entry for this pin carrying a
                        // `path`, so walk that path into the resolved value.
                        // Keyed purely on the presence of `path` — NOT on the
                        // source node's title — so any future node that exports
                        // `outputs[].path` gets drill-down for free.
                        const authoredPath = this.findAuthoredOutputPath(sourceNode, prop.sourceOutputName);
                        if (authoredPath !== undefined) {
                            // An empty `path` is a legitimate "whole value"
                            // output; resolveValuePath returns it unchanged.
                            return resolveValuePath(result, authoredPath);
                        }
                        // Fixed, menu-owned multi-output getters (e.g.
                        // getNodePosition -> x/y) export no `outputs[]` and keep
                        // their original plain-key read.
                        if (result !== null && typeof result === 'object') {
                            return (result as any)[prop.sourceOutputName];
                        }
                    }
                    return result;
                }

                if ((sourceNode as any).propertyValue !== undefined) {
                    return (sourceNode as any).propertyValue;
                }
            }
        }

        return prop.value;
    }

    /**
     * Read a `getVariable` node's value from the enclosing graph's store. The
     * `variableName` property is a plain baked string, but it is resolved
     * through the normal path so a wired string source still works.
     */
    private static async readGraphVariable(node: IFlowstateNode, ctx: WalkContext): Promise<unknown> {
        const name = await this.resolveVariableName(node, ctx);
        if (!name || !ctx.graph.variables.has(name)) {
            emitFlowConsole('warn', `[FlowState] Unknown graph variable '${name}' read by node ${node.id} in graph ${ctx.graph.id}`, {
                context: flowNodeContext(node, ctx),
                code: 'unknown-variable',
            });
            return undefined;
        }
        return ctx.graph.variables.get(name);
    }

    /**
     * Apply a `setVariable` node: properties[0] = name, properties[1] = value.
     * An unknown name warns and continues — the variable is NEVER created
     * implicitly and the flow is never halted.
     */
    private static async applySetVariable(node: IFlowstateNode, ctx: WalkContext): Promise<void> {
        const name = await this.resolveVariableName(node, ctx);
        if (!name || !ctx.graph.variables.has(name)) {
            emitFlowConsole('warn', `[FlowState] Unknown graph variable '${name}' written by node ${node.id} in graph ${ctx.graph.id}`, {
                context: flowNodeContext(node, ctx),
                code: 'unknown-variable',
            });
            return;
        }
        const props = node.properties ?? [];
        const valueProp = props.find(p => p.name === 'value') ?? props[1];
        const value = valueProp ? await this.resolvePropertyValue(valueProp as any, ctx) : undefined;
        ctx.graph.variables.set(name, value);
    }

    private static async resolveVariableName(node: IFlowstateNode, ctx: WalkContext): Promise<string> {
        const props = node.properties ?? [];
        const nameProp = props.find(p => p.name === 'variableName') ?? props[0];
        if (!nameProp) return '';
        const raw = await this.resolvePropertyValue(nameProp as any, ctx);
        return typeof raw === 'string' ? raw : (raw === undefined || raw === null ? '' : String(raw));
    }

    /**
     * Look up an AUTHOR-DEFINED value-OUTPUT pin's drill-down `path` on a
     * source node.
     *
     * The editor exports `outputs[]` ONLY for pins that declare a `path`
     * (see `IFlowstateNode.outputs`), so a hit here unambiguously means "this
     * pin is a drill-down output" — fixed menu-owned getter outputs and
     * starter value outputs are never exported and therefore never match.
     *
     * Returns the path string (possibly EMPTY, which means "the whole value")
     * when the named pin is an authored drill-down output, else `undefined`.
     * Purely a read of the exported node data — no walk state involved.
     */
    private static findAuthoredOutputPath(node: IFlowstateNode, outputName: string): string | undefined {
        const outputs = node.outputs;
        if (!Array.isArray(outputs)) return undefined;
        const entry = outputs.find(o => o && o.name === outputName && typeof o.path === 'string');
        return entry ? entry.path : undefined;
    }

    private static findMethod(obj: any, methodName: string): Function | null {
        if (obj === null || obj === undefined) return null;
        // Resolve a method that may live on the module's OWN properties OR on its
        // class prototype — every method module is a class INSTANCE
        // (`export const transform = new TransformMethods()`), so its methods are
        // prototype (non-own) properties. Still EXCLUDE inherited Object.prototype
        // built-ins by identity so a `toString`/`valueOf` node resolves to the
        // intended value-function (e.g. flowstateMethods.string.toString →
        // String(value)) rather than Object.prototype.toString ("[object Object]").
        const candidate = (obj as any)[methodName];
        if (typeof candidate === 'function' && candidate !== (Object.prototype as any)[methodName]) {
            return candidate.bind(obj);
        }
        for (const key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
            const child = (obj as any)[key];
            if (typeof child === 'object' && child !== null) {
                const found = this.findMethod(child, methodName);
                if (found) return found;
            }
        }
        return null;
    }
}

// Pixi pointer-event starter titles — kept in sync with
// src/menu/starter/pixi-events.json on the editor side.
const PIXI_STARTER_TITLES = new Set([
    'onPointerDown', 'onPointerUp', 'onPointerUpOutside',
    'onPointerMove', 'onPointerOver', 'onPointerOut',
    'onPointerEnter', 'onPointerLeave', 'onPointerCancel',
    'onPointerTap', 'onGlobalPointerMove',
]);

// Event-name starter titles — kept in sync with the editor-side
// onCustomEvent / onEventFire starter nodes. Excluded from title
// fan-out; dispatched instead via eventEmitter.on keyed on each
// starter's `eventName` property (see event-triggers/custom-events.ts).
const CUSTOM_EVENT_STARTER_TITLES = new Set([
    'onCustomEvent',
    'onEventFire',
]);

// Literal (not the imported constant) so no imported binding is read at module-eval time.
const GAME_PREFERENCE_STARTER_TITLES = new Set([
    'onGamePreferenceChanged',
]);

// Per-graph local variable node titles (immutable runtime method keys). These
// are WALKER-INTRINSIC special cases, never entries in `flowstateMethods` —
// executeNode dispatches `method(...params)` with no ctx and no graphId, so a
// registered method could not reach the per-graph store. Same precedent as
// branch / switch / loop and the loop `index`/`item` outputs.
const GET_VARIABLE_TITLE = 'getVariable';
const SET_VARIABLE_TITLE = 'setVariable';
const VARIABLE_NODE_TITLES = new Set([GET_VARIABLE_TITLE, SET_VARIABLE_TITLE]);

function flowNodeContext(node: IFlowstateNode, ctx: WalkContext): FlowNodeContext {
    return { graphId: ctx.graph.id, nodeId: node.id, nodeTitle: node.title };
}

// Exported property types that name an authored thing; an empty value means the
// author never set the input. `variableRef` is walker-intrinsic and warns itself.
const REFERENCE_INPUT_TYPES = new Set([
    'nodeRef', 'node3dRef', 'sceneRef', 'animationRef', 'audioRef',
    'customEventRef', 'builtInEventRef', 'gamePreferenceRef', 'translationKeyRef',
]);

const reportedMissingInputs = new Set<string>();

function isMissingReference(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (typeof value === 'object') {
        const ref = value as { bySkin?: unknown; nodeId?: unknown };
        // A per-skin ref with no entry for the booting skin resolves to nothing.
        if (ref.bySkin && typeof ref.bySkin === 'object') {
            return !(ref.bySkin as Record<string, unknown>)[ACTIVE_SKIN_NAME];
        }
        if ('nodeId' in ref) return typeof ref.nodeId !== 'string' || ref.nodeId === '';
    }
    return false;
}

/**
 * Warn (once per node input per session) when a reference input resolved to
 * nothing. Never blocks: methods already no-op on an unresolvable reference,
 * and an optional slot (e.g. playRandomSound's sound2..5) is legitimately
 * empty — so several `audioRef` inputs on one node warn only when ALL are empty.
 */
function reportMissingReferenceInputs(node: IFlowstateNode, params: unknown[], nodeCtx: FlowNodeContext): void {
    const props = node.properties ?? [];
    const missing: string[] = [];
    let audioCount = 0;
    let audioMissing: string[] = [];
    props.forEach((prop, i) => {
        if (!prop || !REFERENCE_INPUT_TYPES.has(prop.type)) return;
        if (prop.type === 'audioRef') {
            audioCount++;
            if (isMissingReference(params[i])) audioMissing.push(prop.name);
            return;
        }
        if (isMissingReference(params[i])) missing.push(prop.name);
    });
    if (audioCount > 1 && audioMissing.length < audioCount) audioMissing = [];
    for (const name of missing.concat(audioMissing)) {
        const key = `${nodeCtx.graphId}\u0000${nodeCtx.nodeId}\u0000${name}`;
        if (reportedMissingInputs.has(key)) continue;
        reportedMissingInputs.add(key);
        emitFlowConsole('warn', `[FlowState] ${node.title}: missing input '${name}'`, {
            context: nodeCtx,
            code: 'missing-input',
        });
    }
}
