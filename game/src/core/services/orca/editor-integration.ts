/**
 * FlowState Game Integration
 * 
 * This module handles the handshake between a game running in an iframe
 * and the FlowState Editor. It uses postMessage for cross-origin communication.
 * 
 * Handshake Flow:
 * 1. Game calls initFlowstateHandshake() and announces ready via postMessage
 * 2. Editor receives 'flowstate-ready' and responds with 'flowstate-request-data'
 * 3. Game receives request and sends back 'flowstate-data' with config
 * 4. Editor confirms connection with 'flowstate-successful-connection'
 */

import sceneManager from './scene-manager';

/**
 * Asset-invalidation hot reload.
 *
 * Editor calls this (via postMessage `orca-asset-invalidated` or the
 * matching same-origin CustomEvent) after a sprite asset has been
 * re-baked on disk. Pixi's URL-keyed `BaseTextureCache` would otherwise
 * keep serving the stale GPU upload because the URL itself hasn't
 * changed — so we walk the caches, destroy entries whose key contains
 * any of the supplied bucket-relative paths, then reload the current
 * scene so sprites pick up a fresh `BaseTexture.from(url)` upload.
 *
 * @param paths Bucket-relative paths of changed assets (e.g.
 *              `assets/sprites/foo.png`). Empty array means
 *              "invalidate all and reload current scene".
 */
function handleAssetInvalidation(
  paths: string[],
  log: (msg: string, ...args: unknown[]) => void
): void {
  log('Asset invalidation requested:', paths.length === 0 ? '(all)' : paths);

  // Delegate to SceneManager: it evicts matching PIXI cache entries
  // (BaseTextureCache + TextureCache + Loader.shared.resources +
  // sprite-descriptor cache + unavailable-path set), bumps an
  // `assetCacheBust` counter so re-fetched URLs carry `?v=N` and bypass
  // the browser HTTP cache, re-runs the scene-wide texture/spine
  // preloads, then rebuilds the current scene container. All async.
  const result = (sceneManager as any).invalidateAndReloadCurrentScene?.(paths);
  if (result && typeof result.then === 'function') {
    (result as Promise<{
      evictedBaseTextures: number;
      evictedTextures: number;
      evictedLoaderResources: number;
      evictedDescriptors: number;
    }>).then(
      (stats) => {
        log(
          `Invalidation complete — evicted ${stats.evictedBaseTextures} BaseTexture(s), ` +
          `${stats.evictedTextures} Texture(s), ${stats.evictedLoaderResources} loader resource(s), ` +
          `${stats.evictedDescriptors} sprite descriptor(s)`,
        );
      },
      (err) => {
        log('Asset invalidation pipeline failed:', err);
      },
    );
  } else {
    log('SceneManager.invalidateAndReloadCurrentScene is unavailable; asset hot-reload was a no-op.');
  }
}

export interface FlowstateConfig {
  /** Version of the flowstate integration */
  version: string;
  /** Display name for the game */
  gameName: string;
}

export interface FlowstateHandshakeOptions {
  /** Interval in ms to retry announcing ready (default: 1000) */
  announceInterval?: number;
  /** Max ready announcements before giving up (default: 30) */
  maxAnnounceAttempts?: number;
  /** Whether to log debug messages (default: true) */
  debug?: boolean;
  /** Callback when connection is established */
  onConnected?: () => void;
  /** Callback when data is requested */
  onDataRequested?: () => void;
}

// Global state for server response forwarding
let serverResponseForwardingEnabled = false;
let serverResponseForwardingCleanup: (() => void) | null = null;

// Cache the latest server response per RequestType so we can deliver
// early Resume responses that happen before forwarding is enabled.
const cachedServerResponsesByType: Record<string, unknown> = {};

/**
 * Initialize FlowState handshake for cross-origin iframe communication.
 * 
 * @param config - The flowstate configuration object to send to the editor
 * @param options - Optional configuration for the handshake behavior
 * @returns Cleanup function to remove listeners and stop announcements
 * 
 * @example
 * ```typescript
 * const cleanup = initFlowstateHandshake({
 *   version: '1.0.0',
 *   gameName: 'My Game',
 *   nodes: [],
 *   variables: [],
 *   events: [],
 *   actions: []
 * });
 * 
 * // Call cleanup() when shutting down
 * ```
 */
export function initFlowstateHandshake(
  config: FlowstateConfig,
  options: FlowstateHandshakeOptions = {}
): () => void {
  const {
    announceInterval = 1000,
    maxAnnounceAttempts = 30,
    debug = true,
    onConnected,
    onDataRequested
  } = options;

  let isConnected = false;
  let announceAttempts = 0;
  let announceIntervalId: ReturnType<typeof setInterval> | null = null;

  // The editor's game-<webview> preload exposes this bridge in every frame.
  // A deployed build has no editor to answer the handshake, so it must not
  // keep re-announcing.
  const hasEditorHost = typeof (window as any).electronAPI?.send === 'function';

  const log = (message: string, ...args: unknown[]): void => {
    if (debug) {
      console.log(`[FlowState] ${message}`, ...args);
    }
  };

  const stopAnnouncing = (): void => {
    if (announceIntervalId) {
      clearInterval(announceIntervalId);
      announceIntervalId = null;
    }
  };

  /**
   * Send flowstate data to the editor via all available methods.
   */
  const sendFlowstateData = (): void => {
    log('Sending flowstate data to editor...');
    onDataRequested?.();

    // Method 1: PostMessage to parent (editor webview)
    // This is the primary method for cross-origin iframe communication
    try {
      window.parent.postMessage({
        type: 'flowstate-data',
        flowstate: config
      }, '*');
      log('Sent flowstate-data via postMessage to parent');
    } catch (e) {
      log('Error sending postMessage to parent:', e);
    }

    // Method 2: Console log (for webview console detection)
    console.log('flowstate-data: ' + JSON.stringify(config));

    // Method 3: Electron IPC (if running in Electron context)
    if ((window as any).electronAPI?.send) {
      (window as any).electronAPI.send('flowstate-data', config);
      log('Sent flowstate-data via Electron IPC');
    }

    // Method 4: Set on window for same-origin polling
    (window as any).flowstateResponse = config;
  };

  /**
   * Handle data request from the editor.
   */
  const handleFlowstateRequest = (): void => {
    log('Editor requested flowstate data');
    sendFlowstateData();
  };

  /**
   * Handle successful connection confirmation from editor.
   */
  const handleSuccessfulConnection = (): void => {
    if (!isConnected) {
      isConnected = true;
      log('Connection established with editor!');
      
      // Stop announcing once connected
      stopAnnouncing();
      
      onConnected?.();
    }
  };

  /**
   * Handle incoming postMessage events.
   */
  const handleMessage = (event: MessageEvent): void => {
    if (!event.data || typeof event.data !== 'object') return;

    switch (event.data.type) {
      case 'flowstate-request-data':
        handleFlowstateRequest();
        break;
      case 'flowstate-successful-connection':
      case 'flowstate-connected':
        handleSuccessfulConnection();
        break;
      case 'flowstate-enable-server-response-forwarding':
        enableServerResponseForwarding(log);
        break;
      case 'flowstate-disable-server-response-forwarding':
        disableServerResponseForwarding(log);
        break;
      case 'orca-asset-invalidated':
      case 'flowstate-asset-invalidated': {
        const paths = Array.isArray((event.data as any).paths)
          ? ((event.data as any).paths as unknown[]).map((p) => String(p || '')).filter(Boolean)
          : [];
        handleAssetInvalidation(paths, log);
        break;
      }
    }
  };

  /**
   * Handle CustomEvent-based requests (for same-origin scenarios).
   */
  const handleCustomEvent = (): void => {
    handleFlowstateRequest();
  };

  /**
   * Same-origin CustomEvent path for asset invalidation. Mirrors the
   * postMessage switch case above.
   */
  const handleAssetInvalidatedEvent = (evt: Event): void => {
    const detail = (evt as CustomEvent).detail;
    const paths = detail && Array.isArray(detail.paths)
      ? (detail.paths as unknown[]).map((p) => String(p || '')).filter(Boolean)
      : [];
    handleAssetInvalidation(paths, log);
  };

  /**
   * Announce that the game is ready and waiting for editor connection.
   */
  const announceReady = (): void => {
    if (isConnected) return;

    announceAttempts++;
    log('Announcing ready to editor...');
    
    // PostMessage to parent (editor webview)
    try {
      window.parent.postMessage({ type: 'flowstate-ready' }, '*');
    } catch (e) {
      log('Error announcing via postMessage:', e);
    }
    
    // Also log for console detection
    console.log('flowstate added to window');

    if (announceAttempts >= maxAnnounceAttempts) {
      stopAnnouncing();
      log(`No editor connected after ${announceAttempts} announcement(s); giving up.`);
    }
  };

  // Set up listeners
  window.addEventListener('message', handleMessage);
  window.addEventListener('flowstate-request-data', handleCustomEvent);
  window.addEventListener('flowstate-successful-connection', handleSuccessfulConnection as EventListener);
  window.addEventListener('orca-asset-invalidated', handleAssetInvalidatedEvent as EventListener);

  // Announce ready immediately
  announceReady();

  // Continue announcing periodically until connected — but only when an
  // editor host is actually there to answer.
  if (hasEditorHost && !isConnected && announceAttempts < maxAnnounceAttempts) {
    announceIntervalId = setInterval(announceReady, announceInterval);
  }

  log('Game integration initialized, announcing to editor...');

  // Return cleanup function
  return (): void => {
    stopAnnouncing();
    window.removeEventListener('message', handleMessage);
    window.removeEventListener('flowstate-request-data', handleCustomEvent);
    window.removeEventListener('flowstate-successful-connection', handleSuccessfulConnection as EventListener);
    window.removeEventListener('orca-asset-invalidated', handleAssetInvalidatedEvent as EventListener);
    delete (window as any).flowstateResponse;
    disableServerResponseForwarding(log);
    log('Game integration cleaned up');
  };
}

/**
 * Enable server response forwarding to the editor.
 * When enabled, calls to sendServerResponseToEditor() will forward data to the editor.
 */
function enableServerResponseForwarding(log: (msg: string, ...args: unknown[]) => void): void {
  serverResponseForwardingEnabled = true;
  log('Server response forwarding enabled');

  // Flush any cached responses (e.g. Resume on initial load)
  try {
    for (const [requestType, responseData] of Object.entries(cachedServerResponsesByType)) {
      if (!responseData) continue;
      forwardServerResponseToEditor(responseData, requestType);
    }
  } catch (e) {
    log('Error flushing cached server responses:', e);
  }
  
  // Listen for CustomEvent-based enable requests (same-origin fallback)
  const handleEnableEvent = () => {
    serverResponseForwardingEnabled = true;
    log('Server response forwarding enabled via CustomEvent');
  };
  
  window.addEventListener('flowstate-enable-server-response-forwarding', handleEnableEvent);
  
  serverResponseForwardingCleanup = () => {
    window.removeEventListener('flowstate-enable-server-response-forwarding', handleEnableEvent);
  };
}

/**
 * Disable server response forwarding to the editor.
 */
function disableServerResponseForwarding(log: (msg: string, ...args: unknown[]) => void): void {
  serverResponseForwardingEnabled = false;
  log('Server response forwarding disabled');
  
  if (serverResponseForwardingCleanup) {
    serverResponseForwardingCleanup();
    serverResponseForwardingCleanup = null;
  }
}

/**
 * Send a server response to the FlowState Editor.
 * This should be called from your game's setData method when server response forwarding is enabled.
 * 
 * @param responseData - The server response data to send to the editor
 * 
 * @example
 * ```typescript
 * // In your GameModel.setData() method:
 * import { sendServerResponseToEditor } from './services/orca/editor-integration';
 * 
 * public setData(responseData: IBaseServerResponse): void {
 *   // Forward to editor for auto-gathering
 *   sendServerResponseToEditor(responseData);
 *   
 *   // ... rest of your setData logic
 * }
 * ```
 */
export function sendServerResponseToEditor(responseData: unknown): void {
  // Extract RequestType from the response data
  const requestType = (responseData as any)?.RequestType || 'unknown';

  // Always cache the latest response by type, even if forwarding isn't enabled yet.
  // This is important for Resume responses which often happen during initial load.
  cachedServerResponsesByType[String(requestType)] = responseData;

  if (!serverResponseForwardingEnabled) {
    return;
  }
  
  forwardServerResponseToEditor(responseData, requestType);
}

function forwardServerResponseToEditor(responseData: unknown, requestType: string): void {
  // Method 1: PostMessage to parent (editor webview)
  try {
    window.parent.postMessage(
      {
        type: 'flowstate-server-response',
        responseData: responseData,
        requestType: requestType
      },
      '*'
    );
  } catch (e) {
    console.error('[FlowState] Error sending server response via postMessage:', e);
  }

  // Method 2: Electron IPC (if running in Electron context)
  if ((window as any).electronAPI?.send) {
    (window as any).electronAPI.send('flowstate-server-response', { responseData, requestType });
  }

  // Method 3: Console log (for webview console detection)
  // In the shell-hosted runtime the game runs inside the shell's iframe, so
  // window.parent is the shell (not the editor host renderer) and electronAPI
  // is undefined in that frame — neither Method 1 nor 2 reaches the editor.
  // The editor listens on the webview `console-message` event, so this relay
  // is the reliable path back to the Data Browser's auto-gathering.
  try {
    console.log('flowstate-server-response: ' + JSON.stringify({ responseData, requestType }));
  } catch (e) {
    console.error('[FlowState] Error sending server response via console log:', e);
  }
}

/**
 * Check if server response forwarding is currently enabled.
 * 
 * @returns True if server response forwarding is enabled
 */
export function isServerResponseForwardingEnabled(): boolean {
  return serverResponseForwardingEnabled;
}

/**
 * Notify the FlowState Editor that a node has been activated.
 * This will cause the node to "light up" in the editor's visual display.
 * 
 * @param nodeId - The ID of the node that was activated
 * @param duration - Optional duration in ms to keep the node highlighted (default: editor decides)
 * 
 * @example
 * ```typescript
 * // When executing a node in game logic:
 * notifyNodeActivated('node_abc123');
 * 
 * // With custom duration:
 * notifyNodeActivated('node_abc123', 500);
 * ```
 */
export function notifyNodeActivated(nodeId: string, duration?: number): void {
  const message = {
    type: 'flowstate-node-activated',
    nodeId,
    duration,
    timestamp: Date.now()
  };

  // Method 1: PostMessage to parent (editor webview)
  try {
    window.parent.postMessage(message, '*');
  } catch (e) {
    // Silently ignore if parent not available
  }

  // Method 2: Electron IPC (if running in Electron context)
  if ((window as any).electronAPI?.send) {
    (window as any).electronAPI.send('flowstate-node-activated', { nodeId, duration });
  }

  // Method 3: Console log (for webview console detection)
  console.log('flowstate-node-activated: ' + JSON.stringify({ nodeId, duration }));
}

/**
 * Notify the FlowState Editor that a node has been deactivated.
 * This will remove the "lit up" state from the node in the editor.
 * 
 * @param nodeId - The ID of the node that was deactivated
 * 
 * @example
 * ```typescript
 * notifyNodeDeactivated('node_abc123');
 * ```
 */
export function notifyNodeDeactivated(nodeId: string): void {
  const message = {
    type: 'flowstate-node-deactivated',
    nodeId,
    timestamp: Date.now()
  };

  // Method 1: PostMessage to parent (editor webview)
  try {
    window.parent.postMessage(message, '*');
  } catch (e) {
    // Silently ignore if parent not available
  }

  // Method 2: Electron IPC (if running in Electron context)
  if ((window as any).electronAPI?.send) {
    (window as any).electronAPI.send('flowstate-node-deactivated', { nodeId });
  }

  // Method 3: Console log (for webview console detection)
  console.log('flowstate-node-deactivated: ' + JSON.stringify({ nodeId }));
}

/**
 * Notify the FlowState Editor that all nodes should be deactivated.
 * Useful for resetting the visual state when a flow completes.
 * 
 * @example
 * ```typescript
 * notifyAllNodesDeactivated();
 * ```
 */
export function notifyAllNodesDeactivated(): void {
  const message = {
    type: 'flowstate-all-nodes-deactivated',
    timestamp: Date.now()
  };

  // Method 1: PostMessage to parent (editor webview)
  try {
    window.parent.postMessage(message, '*');
  } catch (e) {
    // Silently ignore if parent not available
  }

  // Method 2: Electron IPC (if running in Electron context)
  if ((window as any).electronAPI?.send) {
    (window as any).electronAPI.send('flowstate-all-nodes-deactivated', {});
  }

  // Method 3: Console log (for webview console detection)
  console.log('flowstate-all-nodes-deactivated');
}
