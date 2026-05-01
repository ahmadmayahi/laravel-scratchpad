import { ipcMain } from "electron";
import path from "node:path";
import { LaravelLsServer } from "../laravelLs.js";
import { CH } from "../../shared/ipcChannels.js";
import type { MainContext } from "./context.js";

/**
 * Reuses the shape check from the Intelephense bridge — only
 * well-formed JSON-RPC 2.0 envelopes reach the server's stdin.
 */
function isValidJsonRpcEnvelope(msg: unknown): msg is { jsonrpc: "2.0" } {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;
    if (m.jsonrpc !== "2.0") return false;
    const hasId = "id" in m;
    const hasMethod = "method" in m;
    const hasResult = "result" in m;
    const hasError = "error" in m;
    if (hasMethod) return typeof m.method === "string";
    if (hasId && (hasResult || hasError) && !(hasResult && hasError)) return true;
    return false;
}

export function registerLaravelLsIpc(ctx: MainContext): void {
    // Download progress events → renderer (drives the splash progress bar).
    // Rate-limited to ~30 Hz so a fast local mirror doesn't flood IPC.
    let lastProgressSentAt = 0;
    ctx.laravelLsManager.on("progress", (progress) => {
        const now = Date.now();
        // Always forward the final byte so the bar lands at 100% — the
        // rate limiter would otherwise swallow the terminal event on a
        // fast link.
        const isFinal = progress.total > 0 && progress.received >= progress.total;
        if (!isFinal && now - lastProgressSentAt < 33) return;
        lastProgressSentAt = now;
        ctx.getMainWindow()?.webContents.send(CH.laravelLsProgress, progress);
    });

    // Generation counter so events from a previous (now-superseded) server
    // wrapper can't mark a fresh client as disconnected. Bumped every time
    // we instantiate a new LaravelLsServer.
    let currentGeneration = 0;
    let inflightSpawn: Promise<void> | null = null;
    // True from spawn until the first `laravelLs:send` from the renderer.
    // A pristine server can be reused by the next client (no `initialize`
    // has been sent yet); a "used" server has to be killed + respawned
    // because LSP rejects a second `initialize` on the same connection.
    let pristine = false;

    function spawnLaravelLs(): Promise<void> {
        const myGeneration = ++currentGeneration;
        // Feed the user's custom PHP paths (from Settings) so exotic
        // installs still work — their parent dirs win over the hard-coded
        // PHP-manager list inside the server.
        const customDirs = ctx.settings
            .get()
            .php.customPaths.map((p) => path.dirname(p))
            .filter((d) => d.length > 0);
        const laravelLs = new LaravelLsServer(customDirs);
        laravelLs.on("message", (msg) => {
            if (myGeneration !== currentGeneration) return;
            ctx.getMainWindow()?.webContents.send(CH.laravelLsMessage, msg);
        });
        laravelLs.on("exit", (code) => {
            console.warn("[laravel-ls] exited with code", code);
            if (myGeneration !== currentGeneration) return;
            ctx.setLaravelLs(null);
            pristine = false;
            ctx.getMainWindow()?.webContents.send(CH.laravelLsDisconnected);
        });
        laravelLs.on("error", (err) => {
            console.error("[laravel-ls] server error:", err);
            if (myGeneration !== currentGeneration) return;
            ctx.setLaravelLs(null);
            pristine = false;
            ctx.getMainWindow()?.webContents.send(CH.laravelLsDisconnected);
        });
        ctx.setLaravelLs(laravelLs);
        pristine = true;
        return laravelLs.start();
    }

    // Awaited by the renderer before each new client's `initialize`. If we
    // have a server that no client has touched yet, reuse it; otherwise
    // kill the existing one (which has already been initialized for some
    // previous root) and spawn a fresh process. This is what makes
    // project switches actually work — without the kill+respawn, the
    // renderer's second `initialize` would land on an already-initialized
    // server and either hang or get rejected.
    function ensureSpawned(): Promise<void> {
        if (inflightSpawn) return inflightSpawn;
        if (ctx.laravelLsManager.getStatus().state !== "ready") return Promise.resolve();
        if (ctx.getLaravelLs() && pristine) return Promise.resolve();
        inflightSpawn = (async () => {
            const existing = ctx.getLaravelLs();
            if (existing) {
                // Synchronous kill — the wrapper's `proc` is nulled in the
                // same tick. The OLD wrapper's `exit` event will fire later
                // but it's tagged with a stale generation and gets filtered
                // out, so it can't fire a spurious disconnect at the new
                // client.
                existing.stop();
                ctx.setLaravelLs(null);
            }
            await spawnLaravelLs();
        })().finally(() => {
            inflightSpawn = null;
        });
        return inflightSpawn;
    }

    // Status transitions → renderer. The splash uses these for phase
    // labels (checking / downloading / verifying / ready / error /
    // unsupported / skipped); the renderer's prepare() promise also
    // resolves off this.
    ctx.laravelLsManager.on("status", (status) => {
        ctx.getMainWindow()?.webContents.send(CH.laravelLsStatus, status);

        // As soon as we reach `ready`, spin up the LSP synchronously
        // so the renderer sees a live server by the time EditorPane
        // mounts. Any async PATH discovery would have let the first
        // `initialize` land on a null `laravelLs` and time out; the
        // LaravelLsServer walks a hard-coded list of common
        // PHP-manager dirs synchronously in its constructor, so
        // there's no race window here.
        if (status.state === "ready" && !ctx.getLaravelLs() && !inflightSpawn) {
            void spawnLaravelLs().catch((err) => console.error("[laravel-ls] start failed", err));
        }
    });

    // prepare / status / retry / skip drive the splash state machine.
    ipcMain.handle(CH.laravelLsPrepare, () => ctx.laravelLsManager.prepare());
    ipcMain.handle(CH.laravelLsStatus, () => ctx.laravelLsManager.getStatus());
    ipcMain.handle(CH.laravelLsRetry, () => ctx.laravelLsManager.retry());
    ipcMain.handle(CH.laravelLsSkip, () => {
        ctx.laravelLsManager.skip();
    });
    ipcMain.handle(CH.laravelLsEnsureRunning, () => ensureSpawned());

    // send / message are the JSON-RPC transport — identical in spirit
    // to the Intelephense bridge.
    ipcMain.on(CH.laravelLsSend, (_e, msg) => {
        if (!isValidJsonRpcEnvelope(msg)) return;
        // Until the binary is downloaded+spawned, drop renderer
        // messages. The renderer should gate on status: "ready" before
        // sending, but dropping is safer than crashing if that guard
        // regresses.
        const ls = ctx.getLaravelLs();
        if (!ls) return;
        // First message from a client flips us out of pristine — the next
        // client switch will have to kill+respawn to get a fresh
        // `initialize`-ready connection.
        pristine = false;
        ls.send(msg);
    });
}
