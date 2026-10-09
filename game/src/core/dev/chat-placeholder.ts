/**
 * Dev-only chat-iframe placeholder.
 *
 * arcade-base's app.vue mounts `<iframe class="iframe chat-panel">` and points
 * its `src` at a Tombola-internal chat URL via
 * `inversifyContainer.frameConnection.createChat(iframe, chatUrl)`. That URL
 * is unreachable from the Orca / Flowstate editor's embedded `<webview>` game
 * emulator (and from any local dev environment), so the iframe paints the
 * browser's opaque network-error / about:blank document over its own CSS
 * background — making the chat panel visually invisible to game authors.
 *
 * In non-production builds we observe the DOM for the chat iframe and replace
 * its `src` with a tiny inline `data:` HTML page that paints a recognisable
 * "Chat (dev preview)" panel. Production builds short-circuit immediately so
 * the real chat document loads unchanged.
 *
 * This module only mutates the iframe element after arcade-base has finished
 * wiring chat — it does NOT touch arcade-base's URL resolution or
 * `frameConnection` plumbing.
 */

const PLACEHOLDER_HTML =
    '<!doctype html><html><body style="margin:0;background:#141a2c;color:#e6efff;' +
    'font-family:sans-serif;display:flex;align-items:center;justify-content:center;' +
    'height:100vh;font-size:14px;letter-spacing:0.04em;">Chat (dev preview)</body></html>';

const PLACEHOLDER_SRC = 'data:text/html;charset=utf-8,' + encodeURIComponent(PLACEHOLDER_HTML);

const MARKER = '__orcaChatPlaceholderApplied';
const MAX_OBSERVE_MS = 30_000;

function applyPlaceholder(iframe: HTMLIFrameElement): void {
    if ((iframe as unknown as Record<string, unknown>)[MARKER]) return;
    (iframe as unknown as Record<string, unknown>)[MARKER] = true;
    try {
        iframe.src = PLACEHOLDER_SRC;
    } catch {
        // ignore — worst case the iframe shows the original (unreachable) src
    }
}

function findChatIframe(root: ParentNode): HTMLIFrameElement | null {
    const node = root.querySelector('iframe.chat-panel');
    return node instanceof HTMLIFrameElement ? node : null;
}

/**
 * Install the dev-mode chat-iframe placeholder. Safe to call multiple times.
 * No-ops in production builds and in non-DOM environments.
 */
export function installDevChatPlaceholder(): void {
    if (process.env.NODE_ENV === 'production') return;
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;

    const tryNow = (): boolean => {
        const existing = findChatIframe(document);
        if (existing) {
            applyPlaceholder(existing);
            return true;
        }
        return false;
    };

    if (tryNow()) return;

    const observer = new MutationObserver(() => {
        if (tryNow()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Safety net: stop watching after a while to avoid leaking the observer
    // if the chat panel never mounts (e.g. enableChat: false in features).
    window.setTimeout(() => observer.disconnect(), MAX_OBSERVE_MS);
}
