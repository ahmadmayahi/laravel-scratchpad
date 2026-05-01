import { net } from "electron";

/**
 * Main-process proxy to a local Ollama daemon.
 *
 * Why not just `fetch()` from the renderer? Browser contexts enforce CORS,
 * and Ollama's default allow-list rejects the Electron renderer's origin
 * (`file://` in packaged builds, `http://127.0.0.1:5173` in dev, often both
 * `null`). Rather than ask users to set `OLLAMA_ORIGINS=*`, we do the HTTP
 * call here — Node's `net` module has no origin check and speaks the same
 * local HTTP as anything else.
 *
 * We also own the cancellation story: every request gets a UUID, the
 * renderer can call `abort(id)` when Monaco's CancellationToken fires, and
 * the stored AbortController tears the fetch down mid-stream.
 *
 * The endpoint is gated to loopback hosts. The README promises that AI
 * traffic never leaves the machine; enforcing that here means a typo or
 * stray config can't quietly ship prompt text to a remote server.
 */

function isLoopbackEndpoint(endpoint: string): boolean {
    try {
        const host = new URL(endpoint).hostname.toLowerCase();
        if (host === "localhost" || host.endsWith(".localhost")) return true;
        if (host === "127.0.0.1" || host.startsWith("127.")) return true;
        if (host === "::1" || host === "[::1]") return true;
        return false;
    } catch {
        return false;
    }
}

const inflight = new Map<string, AbortController>();

export interface GenerateBody {
    model: string;
    prompt: string;
    suffix?: string;
    stream?: false;
    options?: {
        temperature?: number;
        num_predict?: number;
        stop?: string[];
    };
}

interface GenerateResult {
    text: string | null;
    error?: string;
}

/** GET {endpoint}/api/tags — used by the Settings → AI "Test" button. */
export async function listModels(endpoint: string): Promise<{ models: string[]; error?: string }> {
    if (!isLoopbackEndpoint(endpoint)) {
        return {
            models: [],
            error: "Endpoint must resolve to localhost / 127.0.0.1 / ::1 — AI traffic is local-only by design.",
        };
    }
    try {
        const url = trimEnd(endpoint) + "/api/tags";
        const res = await netFetch(url);
        if (!res.ok) return { models: [], error: `HTTP ${res.status} from ${url}` };
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        return { models: (data.models ?? []).map((m) => m.name) };
    } catch (e) {
        return { models: [], error: (e as Error).message ?? String(e) };
    }
}

/** POST {endpoint}/api/generate — the FIM completion call. */
export async function generate(endpoint: string, requestId: string, body: GenerateBody): Promise<GenerateResult> {
    if (!isLoopbackEndpoint(endpoint)) {
        return { text: null, error: "AI endpoint must be loopback." };
    }
    const controller = new AbortController();
    inflight.set(requestId, controller);
    // Hard cap on request duration — if Ollama hangs, the renderer is
    // cancelling on keystroke but a stuck daemon could otherwise leak a
    // controller into `inflight` until GC. 30 s is well beyond any real
    // local inference latency.
    const timeoutTimer = setTimeout(() => controller.abort(), 30_000);
    timeoutTimer.unref();
    try {
        const url = trimEnd(endpoint) + "/api/generate";
        const res = await netFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, stream: false }),
            signal: controller.signal,
        });
        if (!res.ok) return { text: null, error: `HTTP ${res.status}` };
        const data = (await res.json()) as { response?: string };
        return { text: data.response ?? null };
    } catch (e) {
        const err = e as Error;
        // Aborted requests are a normal part of the cancellation flow —
        // the renderer already knows, so don't surface them as errors.
        if (err.name === "AbortError") return { text: null };
        return { text: null, error: err.message ?? String(e) };
    } finally {
        clearTimeout(timeoutTimer);
        inflight.delete(requestId);
    }
}

/** Tear down an in-flight generate call. No-op if the id is already gone. */
export function abort(requestId: string): void {
    const c = inflight.get(requestId);
    if (c) c.abort();
    inflight.delete(requestId);
}

/**
 * Electron's `net.fetch` uses Chromium's networking stack with the app's
 * session credentials — which among other things means it ignores the web
 * context's CORS policy. It speaks the standard `fetch` API so callers
 * don't need to branch on environment.
 */
function netFetch(url: string, init?: RequestInit): Promise<Response> {
    return net.fetch(url, init);
}

function trimEnd(u: string): string {
    return u.endsWith("/") ? u.slice(0, -1) : u;
}
