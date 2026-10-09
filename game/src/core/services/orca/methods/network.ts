/**
 * HTTP request methods for FlowState.
 *
 * `httpGet` is a value function (its result feeds a value pin); `httpPost` is
 * an action. Neither ever throws: a failure warns and the flow continues.
 */

const REQUEST_TIMEOUT_MS = 30000;

function readUrl(url: unknown, nodeName: string): string | null {
    const value = typeof url === 'string' ? url.trim() : '';
    if (!value) {
        console.warn(`[FlowState/network] ${nodeName}: no url given`);
        return null;
    }
    return value;
}

async function sendRequest(nodeName: string, url: string, init: RequestInit): Promise<Response | null> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
        const response = await fetch(url, { ...init, signal: controller?.signal });
        if (!response.ok) {
            console.warn(`[FlowState/network] ${nodeName} ${url} answered ${response.status} ${response.statusText}`);
            return null;
        }
        return response;
    } catch (err) {
        console.warn(`[FlowState/network] ${nodeName} ${url} failed:`, err);
        return null;
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

async function readJson(nodeName: string, url: string, response: Response): Promise<unknown> {
    try {
        const text = await response.text();
        if (!text.trim()) return undefined;
        return JSON.parse(text);
    } catch (err) {
        console.warn(`[FlowState/network] ${nodeName} ${url}: reply is not JSON`, err);
        return undefined;
    }
}

export const network = {
    /** GET `url` and return its parsed JSON body, or `undefined` on any failure. */
    async httpGet(url: unknown): Promise<unknown> {
        const target = readUrl(url, 'httpGet');
        if (!target) return undefined;
        const response = await sendRequest('httpGet', target, {
            method: 'GET',
            headers: { Accept: 'application/json' },
        });
        return response ? readJson('httpGet', target, response) : undefined;
    },
};

export const networkActions = {
    /**
     * POST `body` as JSON to `url`; resolves to the parsed JSON reply (`undefined`
     * on failure or an empty reply), read by the walker as the `response` output.
     */
    async httpPost(url: unknown, body: unknown): Promise<unknown> {
        const target = readUrl(url, 'httpPost');
        if (!target) return undefined;
        let payload: string;
        try {
            payload = JSON.stringify(body ?? {});
        } catch (err) {
            console.warn('[FlowState/network] httpPost: body cannot be sent as JSON', err);
            return undefined;
        }
        const response = await sendRequest('httpPost', target, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: payload,
        });
        return response ? readJson('httpPost', target, response) : undefined;
    },
};
