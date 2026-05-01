import * as monaco from "monaco-editor";
import { IntelephenseClient, registerLspProviders, type LspDiagnostic, type LspTextChange } from "./lsp-client";
import { LaravelLsClient, registerLaravelLsProviders } from "./laravelLsClient";
import { useAppStore } from "../stores/app";
import { scratchFileUri } from "../../shared/uri";

/**
 * Renderer-side coordinators for the two LSP servers. Each manager
 * owns one persistent client per workspace root, plus the per-URI
 * provider registrations that decorate Monaco. Project / PHP-version
 * switches kill+respawn the underlying process via `ensureRunning()`
 * (handled in main); these classes just sequence the renderer-side
 * teardown + re-init.
 *
 * Module-level singletons (`intelephense`, `laravelLs`) preserve the
 * original consumer surface area while letting tests construct fresh
 * managers against stub clients.
 */

function disposeForUri(map: Map<string, monaco.IDisposable[]>, uri: string): void {
    const prev = map.get(uri);
    if (prev) {
        for (const d of prev) d.dispose();
        map.delete(uri);
    }
}

function disposeAllIn(map: Map<string, monaco.IDisposable[]>): void {
    for (const list of map.values()) {
        for (const d of list) d.dispose();
    }
    map.clear();
}

// Intelephense only accepts major.minor here; patch versions can fall back to older parser rules.
function pickIntelephensePhpVersion(
    versions: Array<{ path: string; version: string }>,
    defaultBinary: string | null,
): string {
    const fallback = versions[0]?.version ?? "8.3.0";
    const picked = (() => {
        if (defaultBinary) {
            const match = versions.find((v) => v.path === defaultBinary);
            if (match) return match.version;
        }
        return fallback;
    })();
    const [major, minor] = picked.split(".");
    return `${major}.${minor}`;
}

// ---------------------------------------------------------------------------
// Intelephense manager
// ---------------------------------------------------------------------------

class IntelephenseManager {
    private client: IntelephenseClient | null = null;
    private rootUri: string | null = null;
    private activePhpVersion: string | null = null;
    private cachedStoragePaths: { phpVersion: string; storagePath: string; globalStoragePath: string } | null = null;
    private disposablesByUri = new Map<string, monaco.IDisposable[]>();
    /** Serialise startup so concurrent tab/root watchers can't orphan extra IPC listeners. */
    private chain: Promise<IntelephenseClient | null> = Promise.resolve(null);

    getClient(): IntelephenseClient | null {
        return this.client;
    }

    currentRootUri(): string | null {
        return this.rootUri;
    }

    ensure(targetRootUri: string): Promise<IntelephenseClient> {
        const next = this.chain.catch(() => null).then(() => this.ensureInternal(targetRootUri));
        this.chain = next.catch(() => null);
        return next;
    }

    private async ensureInternal(targetRootUri: string): Promise<IntelephenseClient> {
        const phpVersion = await this.resolvePhpVersion();
        if (this.client && this.rootUri === targetRootUri && this.activePhpVersion === phpVersion) return this.client;

        disposeAllIn(this.disposablesByUri);
        const previous = this.client;
        this.client = null;
        await previous?.stop();
        const store = useAppStore();
        store.setIndexingTask("intelephense-index", null);
        store.setIndexingTask("intelephense-health", null);

        // Tell main to bring the Intelephense process to a pristine state so
        // our `initialize` lands on a server that hasn't already been
        // initialized for some previous root.
        await window.lspBridge.ensureRunning();

        const paths = await this.resolveStoragePaths(phpVersion);

        const next = new IntelephenseClient(targetRootUri, {
            storagePath: paths.storagePath,
            globalStoragePath: paths.globalStoragePath,
            phpVersion,
            onDiagnostics: applyDiagnostics,
            onProgress: (ev) => {
                const token = String(ev.token);
                if (ev.kind === "end") {
                    store.setIndexingTask(token, null);
                } else {
                    store.setIndexingTask(token, {
                        title: ev.title,
                        message: ev.message,
                        percentage: ev.percentage,
                    });
                }
            },
        });
        try {
            await next.start();
        } catch (err) {
            // start() subscribes to IPC before initialize completes; failed starts must unsubscribe.
            await next.stop().catch(() => {
                /* already torn down */
            });
            throw err;
        }
        next.setHealthListener((state) => {
            if (state === "unresponsive") {
                store.setIndexingTask("intelephense-health", {
                    title: "Intelephense unresponsive",
                    message: "Completions and diagnostics may be stale.",
                });
            } else {
                store.setIndexingTask("intelephense-health", null);
            }
        });

        this.client = next;
        this.rootUri = targetRootUri;
        this.activePhpVersion = phpVersion;
        return this.client;
    }

    bindDocument(uri: string, code: string): void {
        if (!this.client) return;
        disposeForUri(this.disposablesByUri, uri);
        this.client.didClose(uri);
        this.client.didOpen(uri, "php", code);
        this.disposablesByUri.set(uri, registerLspProviders(this.client, uri));
    }

    closeDocument(uri: string): void {
        disposeForUri(this.disposablesByUri, uri);
        this.client?.didClose(uri);
    }

    async reset(): Promise<void> {
        const previous = this.client;
        this.client = null;
        this.rootUri = null;
        disposeAllIn(this.disposablesByUri);
        await previous?.stop();
        await window.lsp.lspClearCache();
        useAppStore().bumpLspReinitNonce();
    }

    private async resolveStoragePaths(phpVersion: string): Promise<{ storagePath: string; globalStoragePath: string }> {
        if (this.cachedStoragePaths && this.cachedStoragePaths.phpVersion === phpVersion) {
            return this.cachedStoragePaths;
        }
        const p = await window.lsp.lspPaths(phpVersion);
        this.cachedStoragePaths = { phpVersion, storagePath: p.storagePath, globalStoragePath: p.globalStoragePath };
        return this.cachedStoragePaths;
    }

    private async resolvePhpVersion(): Promise<string> {
        const store = useAppStore();
        let versions: Array<{ path: string; version: string }> = [];
        try {
            versions = await window.lsp.phpVersions();
        } catch {
            /* offline / first boot race — fall through to default */
        }
        return pickIntelephensePhpVersion(versions, store.settings?.php.defaultBinary ?? null);
    }
}

// ---------------------------------------------------------------------------
// laravel-ls manager
// ---------------------------------------------------------------------------

class LaravelLsClientManager {
    private client: LaravelLsClient | null = null;
    private rootUri: string | null = null;
    private disposablesByUri = new Map<string, monaco.IDisposable[]>();
    /** Buffers edits that land while laravel-ls waits for scratchWrite -> didOpen. */
    private pendingChanges = new Map<string, LspTextChange[]>();
    private chain: Promise<LaravelLsClient | null> = Promise.resolve(null);

    isActive(): boolean {
        return this.client !== null;
    }

    ensure(targetRootUri: string, eligible: boolean): Promise<LaravelLsClient | null> {
        const next = this.chain.catch(() => null).then(() => this.ensureInternal(targetRootUri, eligible));
        this.chain = next.catch(() => null);
        return next;
    }

    private async ensureInternal(targetRootUri: string, eligible: boolean): Promise<LaravelLsClient | null> {
        if (!eligible) {
            await this.teardown();
            return null;
        }

        if (this.client && this.rootUri === targetRootUri) return this.client;

        const status = await window.lsp.laravelLsStatus();
        if (status.state !== "ready") return null;

        await this.teardown();

        // Previous teardown sent shutdown+exit, killing the singleton server
        // process. Ask main to respawn before we initialize against it.
        await window.laravelLsBridge.ensureRunning();

        const store = useAppStore();
        const next = new LaravelLsClient(targetRootUri, {
            onDiagnostics: applyLaravelLsDiagnostics,
        });
        try {
            await next.start();
        } catch (err) {
            // laravel-ls is an optional companion to Intelephense — failures
            // here only mean Laravel-aware route/view/config completions are
            // missing. Log for diagnostics but don't bolt a permanent
            // "unavailable" spinner onto the status bar (indexingTasks is
            // for *in-progress* work, not terminal failures).
            console.warn("[laravel-ls] failed to initialize:", err);
            await next.stop().catch(() => {
                /* already torn down */
            });
            return null;
        }
        next.setHealthListener((state) => {
            if (state === "unresponsive") {
                store.setIndexingTask("laravel-ls-health", {
                    title: "laravel-ls unresponsive",
                    message: "Route/view/config completions may be stale.",
                });
            } else {
                store.setIndexingTask("laravel-ls-health", null);
            }
        });

        this.client = next;
        this.rootUri = targetRootUri;
        return this.client;
    }

    beginOpen(uri: string): void {
        if (!this.pendingChanges.has(uri)) {
            this.pendingChanges.set(uri, []);
        }
    }

    forwardChange(uri: string, changes: LspTextChange[]): void {
        const queue = this.pendingChanges.get(uri);
        if (queue) {
            queue.push(...changes);
            return;
        }
        this.client?.didChange(uri, changes);
    }

    async openDocument(projectPath: string, tabId: string, content: string): Promise<string | null> {
        if (!this.client) {
            const predicted = scratchFileUri(projectPath, tabId);
            this.pendingChanges.delete(predicted);
            return null;
        }
        const uri = await window.lsp.scratchWrite(projectPath, tabId, content);
        disposeForUri(this.disposablesByUri, uri);
        this.client.didOpen(uri, content);
        this.disposablesByUri.set(uri, registerLaravelLsProviders(this.client, uri));
        const queued = this.pendingChanges.get(uri) ?? [];
        this.pendingChanges.delete(uri);
        if (queued.length > 0) {
            this.client.didChange(uri, queued);
        }
        return uri;
    }

    async closeDocument(projectPath: string, tabId: string, uri: string | null): Promise<void> {
        if (uri) {
            this.client?.didClose(uri);
            this.pendingChanges.delete(uri);
            disposeForUri(this.disposablesByUri, uri);
        }
        try {
            await window.lsp.scratchDelete(projectPath, tabId);
        } catch {
            /* best-effort */
        }
    }

    disposeScratch(uriStr: string): void {
        disposeForUri(this.disposablesByUri, uriStr);
    }

    private async teardown(): Promise<void> {
        disposeAllIn(this.disposablesByUri);
        this.pendingChanges.clear();
        const previous = this.client;
        this.client = null;
        this.rootUri = null;
        if (previous) {
            try {
                await previous.stop();
            } catch {
                /* best-effort */
            }
        }
    }
}

function applyDiagnostics(d: LspDiagnostic): void {
    applyDiagnosticsTo(d, "intelephense");
}

function applyLaravelLsDiagnostics(d: LspDiagnostic): void {
    applyDiagnosticsTo(d, "laravel-ls");
}

function applyDiagnosticsTo(d: LspDiagnostic, owner: string): void {
    try {
        const uri = monaco.Uri.parse(d.uri);
        let model = monaco.editor.getModel(uri);
        if (!model) {
            model = monaco.editor.getModels().find((m) => m.uri.toString() === d.uri) ?? null;
        }
        if (model) monaco.editor.setModelMarkers(model, owner, d.markers);
    } catch {
        // Malformed URI — skip silently.
    }
}

// ---------------------------------------------------------------------------
// URI helpers — pure, no manager state.
// ---------------------------------------------------------------------------

export function workspaceUriFor(projectPath: string | undefined): string {
    const raw = (projectPath ?? "/tmp").replace(/\\/g, "/");
    const encoded = raw.split("/").map(encodeURIComponent).join("/");
    const prefixed = encoded.startsWith("/") ? encoded : `/${encoded}`;
    return `file://${prefixed}`;
}

export function documentUriFor(projectPath: string | undefined, tabId: string): string {
    return scratchFileUri(projectPath ?? "/tmp", tabId);
}

export function predictLaravelLsUri(projectPath: string, tabId: string): string {
    return scratchFileUri(projectPath, tabId);
}

// ---------------------------------------------------------------------------
// Module singletons + thin function facades for backwards compatibility.
// ---------------------------------------------------------------------------

const intelephense = new IntelephenseManager();
const laravelLs = new LaravelLsClientManager();

export const getClient = (): IntelephenseClient | null => intelephense.getClient();
export const currentRootUri = (): string | null => intelephense.currentRootUri();
export const ensureClient = (root: string): Promise<IntelephenseClient> => intelephense.ensure(root);
export const bindDocument = (uri: string, code: string): void => intelephense.bindDocument(uri, code);
export const resetIntelephense = (): Promise<void> => intelephense.reset();

export const ensureLaravelLsClient = (root: string, eligible: boolean): Promise<LaravelLsClient | null> =>
    laravelLs.ensure(root, eligible);
export const isLaravelLsActive = (): boolean => laravelLs.isActive();
export const beginLaravelLsOpen = (uri: string): void => laravelLs.beginOpen(uri);
export const forwardLaravelLsChange = (uri: string, changes: LspTextChange[]): void =>
    laravelLs.forwardChange(uri, changes);
export const openLaravelLsDocument = (projectPath: string, tabId: string, content: string): Promise<string | null> =>
    laravelLs.openDocument(projectPath, tabId, content);
export const closeLaravelLsDocument = (projectPath: string, tabId: string, uri: string | null): Promise<void> =>
    laravelLs.closeDocument(projectPath, tabId, uri);

export function disposeScratchModel(projectPath: string | undefined, tabId: string): void {
    try {
        const uri = monaco.Uri.parse(documentUriFor(projectPath, tabId));
        const model = monaco.editor.getModel(uri);
        model?.dispose();
    } catch {
        // Malformed inputs — best-effort, don't crash the renderer on
        // a dispose path.
    }
    const uriStr = documentUriFor(projectPath, tabId);
    intelephense.closeDocument(uriStr);
    laravelLs.disposeScratch(uriStr);
}
