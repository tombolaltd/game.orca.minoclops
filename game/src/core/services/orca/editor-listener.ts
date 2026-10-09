/**
 * FlowState Editor Listener
 * 
 * This module handles the editor side of the handshake with a game running in an iframe.
 * It listens for 'flowstate-ready' messages from the game and responds accordingly.
 * 
 * This code should run in the editor/webview context that embeds the game iframe.
 */

export interface FlowstateEditorCallbacks {
  /** Called when the game announces it's ready */
  onGameReady?: () => void;
  /** Called when flowstate data is received from the game */
  onDataReceived?: (data: any) => void;
  /** Called when connection is established */
  onConnected?: () => void;
  /** Called on any error */
  onError?: (error: Error) => void;
}

export interface FlowstateEditorOptions {
  /** The iframe element containing the game */
  iframe?: HTMLIFrameElement;
  /** Whether to log debug messages (default: true) */
  debug?: boolean;
}

/**
 * Initialize the FlowState Editor listener to handle game handshakes.
 * 
 * @param callbacks - Callbacks for various handshake events
 * @param options - Configuration options
 * @returns Cleanup function to remove listeners
 */
export function initFlowstateEditorListener(
  callbacks: FlowstateEditorCallbacks = {},
  options: FlowstateEditorOptions = {}
): () => void {
  const { debug = true, iframe } = options;
  const { onGameReady, onDataReceived, onConnected, onError } = callbacks;

  let isConnected = false;
  let gameWindow: Window | null = null;

  const log = (message: string, ...args: unknown[]): void => {
    if (debug) {
      console.log(`[FlowState Editor] ${message}`, ...args);
    }
  };

  /**
   * Send a message to the game iframe
   */
  const sendToGame = (message: object): void => {
    const targetWindow = gameWindow || iframe?.contentWindow;
    
    if (!targetWindow) {
      log('No game window available to send message');
      return;
    }

    try {
      targetWindow.postMessage(message, '*');
      log('Sent message to game:', message);
    } catch (e) {
      log('Error sending message to game:', e);
      onError?.(e as Error);
    }
  };

  /**
   * Request flowstate data from the game
   */
  const requestData = (): void => {
    log('Requesting flowstate data from game...');
    sendToGame({ type: 'flowstate-request-data' });
  };

  /**
   * Confirm successful connection to the game
   */
  const confirmConnection = (): void => {
    log('Confirming connection to game...');
    sendToGame({ type: 'flowstate-successful-connection' });
    
    if (!isConnected) {
      isConnected = true;
      onConnected?.();
    }
  };

  /**
   * Handle incoming postMessage events from the game
   */
  const handleMessage = (event: MessageEvent): void => {
    // Validate message structure
    if (!event.data || typeof event.data !== 'object') return;

    // Store reference to game window for future communication
    if (event.source && event.source !== window) {
      gameWindow = event.source as Window;
    }

    switch (event.data.type) {
      case 'flowstate-ready':
        log('Game announced ready');
        onGameReady?.();
        // Respond by requesting data
        requestData();
        break;

      case 'flowstate-data':
        log('Received flowstate data from game:', event.data.flowstate);
        onDataReceived?.(event.data.flowstate);
        // Confirm successful connection
        confirmConnection();
        break;
    }
  };

  /**
   * Handle console messages for webview detection (VS Code webview scenario)
   */
  const handleConsoleMessage = (message: string): void => {
    if (message.startsWith('flowstate-data:')) {
      try {
        const jsonStr = message.substring('flowstate-data:'.length).trim();
        const data = JSON.parse(jsonStr);
        log('Received flowstate data via console:', data);
        onDataReceived?.(data);
        confirmConnection();
      } catch (e) {
        log('Error parsing console flowstate data:', e);
      }
    } else if (message === 'flowstate added to window') {
      log('Game ready signal detected via console');
      onGameReady?.();
      requestData();
    }
  };

  // Set up message listener
  window.addEventListener('message', handleMessage);

  log('Editor listener initialized, waiting for game...');

  // If iframe is provided and already loaded, try to initiate handshake
  if (iframe?.contentWindow) {
    log('Iframe detected, sending initial data request...');
    gameWindow = iframe.contentWindow;
    requestData();
  }

  // Return cleanup function and utility methods
  const cleanup = (): void => {
    window.removeEventListener('message', handleMessage);
    gameWindow = null;
    isConnected = false;
    log('Editor listener cleaned up');
  };

  // Expose utility methods on the cleanup function
  (cleanup as any).requestData = requestData;
  (cleanup as any).confirmConnection = confirmConnection;
  (cleanup as any).sendToGame = sendToGame;
  (cleanup as any).handleConsoleMessage = handleConsoleMessage;
  (cleanup as any).isConnected = () => isConnected;

  return cleanup;
}

/**
 * Helper type for the cleanup function with additional methods
 */
export type FlowstateEditorCleanup = (() => void) & {
  requestData: () => void;
  confirmConnection: () => void;
  sendToGame: (message: object) => void;
  handleConsoleMessage: (message: string) => void;
  isConnected: () => boolean;
};
