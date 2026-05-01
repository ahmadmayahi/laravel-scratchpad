/**
 * Renderer-side JSON-RPC plumbing shared by Intelephense and laravel-ls.
 * Both servers speak the same wire protocol over their own
 * `contextBridge`-exposed pair of channels; only the *initialization*
 * options and the set of acceptable server-side requests/notifications
 * differ. This base class owns the parts that are genuinely identical:
 *
 *   - request/response correlation (id counter + outstanding-promise map)
 *   - 45 s heartbeat that flips the renderer to "unresponsive" when the
 *     server has stopped sending traffic
 *   - bridge subscription lifecycle (onMessage / onDisconnected)
 *   - dispatch of incoming JSON-RPC envelopes
 *
 * Subclasses provide:
 *
 *   - `handleServerRequest(msg)` — `client/registerCapability`,
 *     `workspace/configuration`, etc. The default implementation
 *     responds with method-not-found; override to handle.
 *   - `handleServerNotification(msg)` — `textDocument/publishDiagnostics`,
 *     `$/progress`, etc.
 *   - `start()` — typically calls `super.startTransport()`, sends
 *     `initialize`, then `super.completeStart()` so queued opens flush.
 *
 * The `idPrefix` constructor arg keeps multi-client setups (e.g. one
 * Intelephense + one laravel-ls sharing the renderer) from colliding on
 * numeric ids if they ever ended up multiplexed onto a single bridge.
 */

interface LspBridgeApi {
    send(msg: unknown): void;
    onMessage(cb: (msg: unknown) => void): () => void;
    onDisconnected(cb: () => void): () => void;
}

export type JsonRpcMessage =
    | { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }
    | { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: { code: number; message: string } }
    | { jsonrpc: "2.0"; method: string; params?: unknown };

type Resolver = {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

/** Health window — flip to "unresponsive" once the server has been silent for this long with at least one in-flight request. */
const HEALTH_WINDOW_MS = 45_000;
const HEALTH_POLL_MS = 20_000;

export interface JsonRpcClientOptions {
    bridge: LspBridgeApi;
    /** Unique per-instance prefix for outgoing JSON-RPC ids (e.g. `"ip1-"`). */
    idPrefix: string;
    /** Display name used in error messages — `"LSP"`, `"laravel-ls"`, etc. */
    serverName: string;
    /** Per-method request timeout. */
    timeoutFor: (method: string) => number;
}

export abstract class JsonRpcClient {
    private nextId = 1;
    private pending = new Map<string, Resolver>();
    protected initialized = false;
    private disconnected = false;
    private unsubscribe: (() => void) | null = null;
    private unsubscribeDisconnect: (() => void) | null = null;
    /** Operations queued during `initialize` so they fire after the server is ready. */
    protected queuedOpens: Array<() => void> = [];
    private lastActivityAt = Date.now();
    private healthTimer: ReturnType<typeof setInterval> | null = null;
    private onHealthChange: ((state: "ok" | "unresponsive") => void) | null = null;
    private healthState: "ok" | "unresponsive" = "ok";

    protected readonly bridge: LspBridgeApi;
    protected readonly idPrefix: string;
    protected readonly serverName: string;
    private readonly timeoutFor: (method: string) => number;

    constructor(options: JsonRpcClientOptions) {
        this.bridge = options.bridge;
        this.idPrefix = options.idPrefix;
        this.serverName = options.serverName;
        this.timeoutFor = options.timeoutFor;
    }

    /**
     * Subscribe to the bridge so incoming responses + notifications start
     * landing. Subclasses should call this BEFORE sending `initialize`,
     * otherwise the response can race past the subscription and never
     * resolve.
     */
    protected startTransport(): void {
        this.unsubscribe = this.bridge.onMessage((msg) => this.dispatch(msg as JsonRpcMessage));
        this.unsubscribeDisconnect = this.bridge.onDisconnected(() => this.handleDisconnect());
    }

    /** Flush queued opens and start the health heartbeat. Call after a successful `initialize`. */
    protected completeStart(): void {
        this.initialized = true;
        for (const fn of this.queuedOpens) fn();
        this.queuedOpens = [];
        this.startHealthCheck();
    }

    /** Subscribe to health transitions (`"ok"` ↔ `"unresponsive"`). One subscriber at a time. */
    setHealthListener(cb: ((state: "ok" | "unresponsive") => void) | null): void {
        this.onHealthChange = cb;
        cb?.(this.healthState);
    }

    /**
     * Tear down local state. The main process owns the LSP child's
     * lifecycle and respawns it on the next `ensureRunning`, so we
     * deliberately don't send `shutdown`/`exit` here — that races with
     * the next client's `initialize` landing on the still-pointed-at
     * dying process.
     */
    async stop(): Promise<void> {
        this.initialized = false;
        this.stopHealthCheck();
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error(`${this.serverName} client stopped`));
        }
        this.pending.clear();
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.unsubscribeDisconnect?.();
        this.unsubscribeDisconnect = null;
    }

    private handleDisconnect(): void {
        if (this.disconnected) return;
        this.disconnected = true;
        this.initialized = false;
        this.stopHealthCheck();
        const err = new Error(`${this.serverName} disconnected`);
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
        this.transitionHealth("unresponsive");
    }

    private startHealthCheck(): void {
        this.stopHealthCheck();
        this.healthTimer = setInterval(() => {
            if (this.disconnected) return;
            const quietFor = Date.now() - this.lastActivityAt;
            const next: "ok" | "unresponsive" =
                quietFor > HEALTH_WINDOW_MS && this.pending.size > 0 ? "unresponsive" : "ok";
            this.transitionHealth(next);
        }, HEALTH_POLL_MS);
        (this.healthTimer as { unref?: () => void }).unref?.();
    }

    private stopHealthCheck(): void {
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
    }

    private transitionHealth(next: "ok" | "unresponsive"): void {
        if (this.healthState === next) return;
        this.healthState = next;
        this.onHealthChange?.(next);
    }

    protected notify(method: string, params: unknown): void {
        this.bridge.send({ jsonrpc: "2.0", method, params });
    }

    protected request(method: string, params: unknown, explicitTimeoutMs?: number): Promise<unknown> {
        if (this.disconnected) {
            return Promise.reject(new Error(`${this.serverName} disconnected`));
        }
        const id = `${this.idPrefix}${this.nextId++}`;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(
                () => {
                    const p = this.pending.get(id);
                    if (p) {
                        this.pending.delete(id);
                        p.reject(new Error(`${this.serverName} request timed out: ${method}`));
                    }
                },
                explicitTimeoutMs ?? this.timeoutFor(method),
            );
            this.pending.set(id, { resolve, reject, timer });
            this.bridge.send({ jsonrpc: "2.0", id, method, params });
        });
    }

    protected respond(id: number | string, result: unknown): void {
        this.bridge.send({ jsonrpc: "2.0", id, result });
    }

    protected respondError(id: number | string, code: number, message: string): void {
        this.bridge.send({ jsonrpc: "2.0", id, error: { code, message } });
    }

    private dispatch(msg: JsonRpcMessage): void {
        if (!msg || typeof msg !== "object") return;
        this.lastActivityAt = Date.now();
        // Any wire activity means the server is alive — clear a stale
        // "unresponsive" state so the status bar stops warning the user.
        if (this.healthState === "unresponsive") this.transitionHealth("ok");
        const hasId = "id" in msg;
        const hasMethod = "method" in msg;

        if (hasId && hasMethod) {
            this.handleServerRequest(msg as { id: number | string; method: string; params?: unknown });
            return;
        }
        if (!hasId && hasMethod) {
            this.handleServerNotification(msg as { method: string; params?: unknown });
            return;
        }
        if (hasId) {
            const id = (msg as { id: number | string }).id;
            // IDs the server echoes back may arrive as numbers even though
            // we sent strings — normalise to string for map lookup so we
            // tolerate either shape without silently dropping responses.
            const key = String(id);
            const pending = this.pending.get(key);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(key);
            // Dispatch on field *presence*, not truthiness — a valid response
            // with `result: null` (e.g. hover with no info) must resolve with
            // null, not fall through to the error branch.
            if ("error" in msg) {
                const err = (msg as { error?: { code?: number; message?: string } }).error;
                pending.reject(new Error(err?.message ?? `${this.serverName} error`));
            } else if ("result" in msg) {
                pending.resolve((msg as { result: unknown }).result);
            } else {
                pending.reject(new Error(`${this.serverName} response has neither result nor error`));
            }
        }
    }

    /** Default: reject every server→client request with `-32601 Method not found`. Override to handle specific methods. */
    protected handleServerRequest(msg: { id: number | string; method: string; params?: unknown }): void {
        this.respondError(msg.id, -32601, `Method not handled: ${msg.method}`);
    }

    /** Default: ignore everything. Override to handle e.g. `textDocument/publishDiagnostics`. */
    protected handleServerNotification(_msg: { method: string; params?: unknown }): void {
        /* default no-op */
    }
}
