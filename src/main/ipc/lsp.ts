import { ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { normalizeLspPhpVersion } from "../phpVersions.js";
import { appDataDir, intelephenseStorageDirs } from "../paths.js";
import { CH } from "../../shared/ipcChannels.js";
import type { MainContext } from "./context.js";

/**
 * Intelephense bridge — renderer forwards JSON-RPC messages here; we
 * write them to Intelephense's stdin. Incoming messages fan out via
 * the `lsp:message` channel registered here at module load. Full
 * shape-check before forwarding — only well-formed JSON-RPC 2.0
 * envelopes (request / response / notification) reach stdin. A
 * malformed body hitting Intelephense could otherwise cause it to
 * hang or close the connection.
 */
function isValidJsonRpcEnvelope(msg: unknown): msg is { jsonrpc: "2.0" } {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;
    if (m.jsonrpc !== "2.0") return false;
    const hasId = "id" in m;
    const hasMethod = "method" in m;
    const hasResult = "result" in m;
    const hasError = "error" in m;
    if (hasMethod) {
        // Request (needs id) or notification (no id). Method must be a string.
        return typeof m.method === "string";
    }
    // Response requires an id and exactly one of result / error.
    if (hasId && (hasResult || hasError) && !(hasResult && hasError)) return true;
    return false;
}

export function registerLspIpc(ctx: MainContext): void {
    // True from spawn until the first `lsp:send` from the renderer. A pristine
    // server can be reused by the next client; a "used" one has to be
    // killed + respawned before the next `initialize` because LSP rejects a
    // second initialize on the same connection (and our renderer has no way
    // to recover the original session). Starts true because the boot
    // `lsp.start()` call (in main.ts) happens after this module runs but
    // before any client sends — so the wrapper is logically untouched.
    let pristine = true;
    let inflightEnsure: Promise<void> | null = null;

    // Forward every LSP message from Intelephense → renderer.
    ctx.lsp.on("message", (msg) => ctx.getMainWindow()?.webContents.send(CH.lspMessage, msg));
    ctx.lsp.on("exit", (code) => {
        console.warn("[lsp] exited with code", code);
        pristine = false;
        // Tell the renderer the Intelephense child is gone so it can
        // reject every in-flight request immediately instead of waiting
        // out per-method timeouts (5-30 s) for responses that will
        // never come. (Stale exits from a killed-and-respawned generation
        // are already filtered inside StdioJsonRpcServer.)
        ctx.getMainWindow()?.webContents.send(CH.lspDisconnected);
    });
    ctx.lsp.on("error", (err) => {
        console.error("[lsp] server error:", err);
        ctx.getMainWindow()?.webContents.send(CH.lspDisconnected);
    });

    // Awaited by the renderer before each new client's `initialize`. Ensures
    // the next initialize lands on a freshly-spawned process — necessary
    // because Intelephense (like all LSP servers) only accepts one initialize
    // per connection, and project switches need a clean slate.
    function ensureRunning(): Promise<void> {
        if (inflightEnsure) return inflightEnsure;
        if (ctx.lsp.isRunning() && pristine) return Promise.resolve();
        inflightEnsure = (async () => {
            if (ctx.lsp.isRunning()) {
                ctx.lsp.stop();
            }
            await ctx.lsp.start();
            pristine = true;
        })().finally(() => {
            inflightEnsure = null;
        });
        return inflightEnsure;
    }

    // LSP storage paths. Intelephense persists its workspace index to
    // disk when given a writable `storagePath`. Handing it one here —
    // under the user's app support dir — turns what would be a 10–30 s
    // cold-boot reindex of vendor/ into an essentially-instant warm
    // start on subsequent launches.
    ipcMain.handle(CH.lspPaths, (_e, phpVersion: unknown) => {
        // The version comes from the renderer and lands in a filesystem
        // path, so it must resolve through phpVersions.ts' fixed
        // allowlist rather than a shape check.
        const safe = normalizeLspPhpVersion(phpVersion);
        const { storagePath, globalStoragePath } = intelephenseStorageDirs(safe);
        fs.mkdirSync(storagePath, { recursive: true });
        fs.mkdirSync(globalStoragePath, { recursive: true });
        return { storagePath, globalStoragePath };
    });

    // Clear Intelephense cache — escape hatch for when the persistent
    // workspace index goes stale, usually because a previous session
    // terminated mid-scan, or the user just ran `ide-helper:generate`
    // and needs the stubs picked up. The renderer fires this from the
    // palette's "LSP: Rebuild workspace index" action, then tears down
    // its IntelephenseClient and initializes a fresh one via the
    // `lspReinitNonce` watcher.
    //
    // Critically, we ALSO restart the Intelephense subprocess here.
    // Just clearing the on-disk cache isn't enough — Intelephense
    // keeps its full symbol table in memory and never re-reads storage
    // after init, so the renderer's fresh `initialize` would be
    // received by a server whose in-memory state is identical to
    // before. No re-scan, no progress events, no visible indexing
    // indicator. Killing + respawning forces a true cold index against
    // the newly-empty cache dir.
    ipcMain.handle(CH.lspClearCache, async () => {
        const base = appDataDir();
        // Blow away ALL schema-keyed cache variants, not just the
        // current one, so the "Rebuild workspace index" action actually
        // means "start from nothing" even after we've bumped the
        // schema key.
        const dirs = fs
            .readdirSync(base, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^intelephense/.test(d.name))
            .map((d) => path.join(base, d.name));
        for (const dir of dirs) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch {
                /* best-effort */
            }
        }
        // Bounce the LSP process. `start()` is idempotent — it's a
        // no-op if `proc` is non-null, so we explicitly stop first.
        // Event listeners were registered on the `lsp` instance (not
        // per-process), so they stay attached across the restart
        // automatically.
        ctx.lsp.stop();
        await ctx.lsp.start();
        pristine = true;
    });

    ipcMain.handle(CH.lspEnsureRunning, () => ensureRunning());

    ipcMain.on(CH.lspSend, (_e, msg) => {
        if (!isValidJsonRpcEnvelope(msg)) return;
        // First message from a renderer client flips us out of pristine —
        // the next client switch will have to kill + respawn before its
        // `initialize` lands.
        pristine = false;
        ctx.lsp.send(msg);
    });
}
